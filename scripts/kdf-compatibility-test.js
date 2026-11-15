const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { testTempRoot } = require('./testTemp');
const { assertPrivateTree } = require('./slv-test-environment');
const { syntheticLegacyVault } = require('./syntheticLegacyVault');
const { createVaultStore } = require('../src/services/vaultStore');
const { createBackupVerification } = require('../src/services/backupVerification');
const password = 'Synthetic legacy migration password';
async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), 'kdf-compatibility-'));
  const stores = [];
  const store = directory => { const s = createVaultStore(directory); stores.push(s); return s; };
  try {
    for (const [name, options] of [['direct', {}], ['recovery', { recovery: true }], ['early', { omitOptions: true }]]) {
      const directory = path.join(root, name), fixture = await syntheticLegacyVault(directory, password, options);
      const authBefore = await fs.readFile(fixture.authPath), dbBefore = await fs.readFile(fixture.dbPath);
      const legacyBackup = path.join(root, name + '.slvbackup');
      await fs.writeFile(legacyBackup, JSON.stringify({ format: 'secure-login-vault-backup', version: 1, createdAt: fixture.auth.createdAt, auth: fixture.auth, database: JSON.parse(dbBefore) }));
      const originalBackup = await fs.readFile(legacyBackup);
      const s = store(directory);
      await assert.rejects(s.unlockVault({ masterPassword: 'incorrect synthetic password' }), /incorrect/);
      assert.deepEqual(await fs.readFile(fixture.authPath), authBefore);
      await s.unlockVault({ masterPassword: password });
      const upgraded = JSON.parse(await fs.readFile(fixture.authPath));
      assert.equal(upgraded.version, 2); assert.equal(upgraded.keyDerivation.options.N, 131072);
      assert.equal(upgraded.passwordHash, undefined); assert.equal(upgraded.passwordHashing, undefined);
      assert.equal(upgraded.hint, fixture.auth.hint);
      assert.deepEqual(upgraded.keyWrap.recovery, fixture.auth.keyWrap?.recovery);
      assert.deepEqual(await fs.readFile(fixture.dbPath), dbBefore, 'migration does not rewrite encrypted credentials');
      assert.equal((await s.getAllCredentials())[0].username, 'dummy-legacy');
      s.lockVault(); const reopened = store(directory);
      await reopened.unlockVault({ masterPassword: password });
      assert.deepEqual(JSON.parse(await fs.readFile(fixture.authPath)), upgraded, 'second unlock does not migrate again');
      const newerBackup = path.join(root, name + '-new.slvbackup');
      await reopened.createEncryptedBackup(newerBackup);
      const verification = createBackupVerification({ directory: path.join(root, name + '-checks') });
      await verification.prepare();
      assert.equal((await verification.verify(legacyBackup, password)).counts.credentials, 1);
      assert.equal((await verification.verify(newerBackup, password)).counts.credentials, 1);
      assert.deepEqual(await fs.readFile(legacyBackup), originalBackup, 'backup verification never modifies source');
      const restored = store(path.join(root, name + '-restored'));
      await restored.restoreEncryptedBackup(legacyBackup, password);
      await restored.unlockVault({ masterPassword: password });
      assert.equal((await restored.getAllCredentials()).length, 1);
      const replacement = 'Synthetic new replacement password';
      if (options.recovery) {
        reopened.lockVault();
        await reopened.resetWithRecoveryKey({ recoveryKey: fixture.recoveryKey, newPassword: replacement, confirmPassword: replacement });
        await reopened.unlockVault({ masterPassword: replacement });
      } else {
        await reopened.changeMasterPassword({ currentPassword: password, newPassword: replacement, confirmPassword: replacement });
        reopened.lockVault(); await reopened.unlockVault({ masterPassword: replacement });
      }
      assert.equal((await reopened.getAllCredentials())[0].username, 'dummy-legacy');
      assert.deepEqual(await fs.readFile(fixture.dbPath), dbBefore, 'wrapped data key survives password/recovery changes');
      console.log('PASS independently generated legacy ' + name + ': unlock, metadata-only migration, restart, old/new backup verification and recovery/password change');
    }
    const failedRoot = path.join(root, 'failed-upgrade');
    const fixture = await syntheticLegacyVault(failedRoot, password);
    const beforeAuth = await fs.readFile(fixture.authPath), beforeDb = await fs.readFile(fixture.dbPath);
    const failedStore = store(failedRoot), rename = fs.rename;
    fs.rename = async (from, to) => { if (to === fixture.authPath) throw Error('Synthetic auth commit failure'); return rename(from, to); };
    try { await assert.rejects(failedStore.unlockVault({ masterPassword: password }), /Synthetic auth commit failure/); }
    finally { fs.rename = rename; }
    assert.equal(failedStore.isUnlocked(), false);
    assert.deepEqual(await fs.readFile(fixture.authPath), beforeAuth); assert.deepEqual(await fs.readFile(fixture.dbPath), beforeDb);
    await failedStore.unlockVault({ masterPassword: password });
    assert.equal((await failedStore.getAllCredentials()).length, 1);
    failedStore.lockVault();
    const childCode = `const assert=require('assert/strict');const {createVaultStore}=require(${JSON.stringify(path.resolve(__dirname, '../src/services/vaultStore'))});(async()=>{const s=createVaultStore(${JSON.stringify(failedRoot)});await s.unlockVault({masterPassword:${JSON.stringify(password)}});assert.equal((await s.getAllCredentials())[0].username,'dummy-legacy');s.lockVault();})().catch(()=>process.exitCode=1);`;
    execFileSync(process.execPath, ['-e', childCode], { stdio: 'pipe' });
    const cancelRoot = path.join(root, 'canceled-upgrade'), cancelFixture = await syntheticLegacyVault(cancelRoot, password);
    const cancelStore = store(cancelRoot), cancelDb = await fs.readFile(cancelFixture.dbPath);
    fs.rename = async (from, to) => { const result = await rename(from, to); if (to === cancelFixture.authPath) cancelStore.lockVault(); return result; };
    try { await assert.rejects(cancelStore.unlockVault({ masterPassword: password }), /locked|session changed/); }
    finally { fs.rename = rename; }
    assert.equal(cancelStore.isUnlocked(), false);
    assert.equal(JSON.parse(await fs.readFile(cancelFixture.authPath)).version, 2);
    assert.deepEqual(await fs.readFile(cancelFixture.dbPath), cancelDb);
    await cancelStore.unlockVault({ masterPassword: password });
    assert.equal((await cancelStore.getAllCredentials()).length, 1);
    const damagedRoot = path.join(root, 'damaged-database'), damagedFixture = await syntheticLegacyVault(damagedRoot, password);
    const damagedAuth = await fs.readFile(damagedFixture.authPath);
    const damagedDb = JSON.parse(await fs.readFile(damagedFixture.dbPath)); damagedDb.encryption.tag = Buffer.alloc(16).toString('base64');
    await fs.writeFile(damagedFixture.dbPath, JSON.stringify(damagedDb));
    await assert.rejects(store(damagedRoot).unlockVault({ masterPassword: password }));
    assert.deepEqual(await fs.readFile(damagedFixture.authPath), damagedAuth, 'database verification precedes migration');
    const freshRoot = path.join(root, 'fresh'), fresh = store(freshRoot);
    await fresh.createVault({ masterPassword: password, confirmPassword: password }); fresh.lockVault();
    const freshAuthPath = path.join(freshRoot, 'vault/vault-auth.json');
    const freshAuth = JSON.parse(await fs.readFile(freshAuthPath));
    assert.equal(freshAuth.version, 2); assert.equal(freshAuth.passwordHash, undefined);
    assert.equal(freshAuth.keyDerivation.options.N, 131072);
    const kdfKey = crypto.scryptSync(password, Buffer.from(freshAuth.keyDerivation.salt, 'base64'), 32, freshAuth.keyDerivation.options);
    const decipher = crypto.createDecipheriv('aes-256-gcm', kdfKey, Buffer.from(freshAuth.encryption.vaultCheck.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(freshAuth.encryption.vaultCheck.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(freshAuth.encryption.vaultCheck.ciphertext, 'base64')), decipher.final()]);
    assert.equal(JSON.parse(plaintext).type, 'secure-login-vault-auth-check'); plaintext.fill(0); kdfKey.fill(0);
    for (const changed of [{ N: 2 ** 30 }, { N: 16384 }, { N: '131072' }, { r: 999999 }, { p: 1000 }, { maxmem: 2 ** 40 }, { cost: 2 ** 30 }]) {
      const bad = JSON.parse(JSON.stringify(freshAuth)); Object.assign(bad.keyDerivation.options, changed);
      await fs.writeFile(freshAuthPath, JSON.stringify(bad));
      await assert.rejects(fresh.unlockVault({ masterPassword: password }), /authentication data is invalid/);
    }
    for (const mutate of [record => { delete record.keyDerivation.options; }, record => { record.keyDerivation.keyLength = 64; }, record => { record.keyDerivation.salt = 'AAAA'; }, record => { record.passwordHash = fixture.auth.passwordHash; }]) {
      const bad = JSON.parse(JSON.stringify(freshAuth)); mutate(bad);
      await fs.writeFile(freshAuthPath, JSON.stringify(bad));
      await assert.rejects(fresh.unlockVault({ masterPassword: password }), /authentication data is invalid/);
    }
    await fs.writeFile(freshAuthPath, JSON.stringify(freshAuth));
    await fresh.unlockVault({ masterPassword: password });
    console.log('PASS stronger new vault, independent key check, bounded metadata validation, upgrade failure rollback/retry, process restart, cancellation and corrupt-database refusal');
  } finally {
    for (const s of stores) s.lockVault();
    assertPrivateTree(root); assert.equal(path.dirname(root), path.resolve(testTempRoot()));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
