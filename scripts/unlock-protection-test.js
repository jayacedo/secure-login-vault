// Generated vaults only. Never discover or open an installed profile.
const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const originalScrypt = crypto.scrypt;
let beforeScrypt = async () => {};
crypto.scrypt = (...args) => {
  Promise.resolve().then(() => beforeScrypt()).then(() => originalScrypt(...args), error => args.at(-1)(error));
};
const { createVaultStore } = require('../src/services/vaultStore');
const { testTempRoot } = require('./testTemp');
const { assertPrivateTree } = require('./slv-test-environment');
const password = 'Synthetic throttle master password';

async function main() {
  if (process.argv[2] === 'restart') {
    const root = path.resolve(process.argv[3]);
    assert.equal(path.dirname(root), path.resolve(testTempRoot()));
    assert.ok(path.basename(root).startsWith('unlock-protection-'));
    assertPrivateTree(root);
    const store = createVaultStore(root, { now: () => Number(process.argv[4]) });
    await assert.rejects(store.unlockVault({ masterPassword: password }), /Too many password attempts/);
    console.log('Restart preserved cooldown');
    return;
  }
  const root = await fs.mkdtemp(path.join(testTempRoot(), 'unlock-protection-'));
  let time = 1800000000000, comparisons = 0;
  const store = createVaultStore(root, { now: () => time });
  const protection = path.join(root, 'vault/unlock-attempts.json');
  const state = async () => JSON.parse(await fs.readFile(protection, 'utf8'));
  try {
    await store.createVault({ masterPassword: password, confirmPassword: password });
    await store.createCredential({ websiteName: 'Synthetic only', username: 'dummy', password: 'dummy-entry-password' });
    store.lockVault();
    beforeScrypt = async () => { comparisons++; assert.ok((await state()).failures > 0, 'attempt persisted before password verification'); };
    const authPath = path.join(root, 'vault/vault-auth.json');
    const dbPath = path.join(root, 'vault/vault-data.slv');
    const authBefore = await fs.readFile(authPath), dbBefore = await fs.readFile(dbPath);
    await assert.rejects(store.unlockVault({ masterPassword: '' }), /Enter the master password/);
    assert.equal(comparisons, 0);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await assert.rejects(store.unlockVault({ masterPassword: 'wrong synthetic password' }), /Master password is incorrect/);
    }
    assert.equal((await state()).retryAt - time, 1000);
    await assert.rejects(store.unlockVault({ masterPassword: password }), /Try again in 1 second/);
    assert.equal(comparisons, 3, 'cooldown rejects before expensive verification');
    execFileSync(process.execPath, [__filename, 'restart', root, String(time)], { stdio: 'pipe' });
    for (let attempt = 4; attempt <= 13; attempt++) {
      time = (await state()).retryAt;
      await assert.rejects(store.unlockVault({ masterPassword: 'wrong synthetic password' }), /incorrect/);
      assert.equal((await state()).retryAt - time, Math.min(300000, 1000 * 2 ** (attempt - 3)));
    }
    time -= 3600000;
    await assert.rejects(store.unlockVault({ masterPassword: password }), /300 seconds/);
    assert.equal((await state()).retryAt - time, 300000, 'backwards clock is bounded');
    time = (await state()).retryAt;
    await store.unlockVault({ masterPassword: password });
    assert.deepEqual(await state(), { version: 1, failures: 0, retryAt: 0 });
    assert.equal((await store.getAllCredentials()).length, 1);
    store.lockVault(); comparisons = 0;
    const queued = await Promise.allSettled(Array.from({ length: 12 }, () => store.unlockVault({ masterPassword: 'wrong synthetic password' })));
    assert.ok(queued.every(result => result.status === 'rejected'));
    assert.equal(comparisons, 3, 'queued calls cannot bypass the main-process cooldown');
    assert.equal((await state()).failures, 3);
    assert.deepEqual(await fs.readFile(authPath), authBefore, 'throttling does not rewrite auth format');
    assert.deepEqual(await fs.readFile(dbPath), dbBefore, 'throttling does not rewrite credentials');
    assert.ok(!(await fs.readFile(protection, 'utf8')).includes(password));
    await fs.writeFile(protection, '{broken'); comparisons = 0;
    await assert.rejects(store.unlockVault({ masterPassword: password }), /protection could not be read/);
    assert.equal(comparisons, 0);
    await fs.unlink(protection); await fs.mkdir(protection);
    await assert.rejects(store.unlockVault({ masterPassword: password }), /protection could not be read/);
    assert.equal(comparisons, 0);
    await fs.rmdir(protection);
    const write = fs.writeFile;
    fs.writeFile = async (file, ...args) => {
      if (String(file).startsWith(protection + '.')) throw Object.assign(Error('Synthetic disk failure'), { code: 'EACCES' });
      return write(file, ...args);
    };
    try { await assert.rejects(store.unlockVault({ masterPassword: password }), /Could not save unlock protection/); }
    finally { fs.writeFile = write; }
    assert.equal(comparisons, 0);
    assert.equal(store.isUnlocked(), false);
    let reached, release;
    const started = new Promise(resolve => { reached = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    beforeScrypt = async () => { reached(); await gate; };
    const pending = store.unlockVault({ masterPassword: password });
    await started; store.lockVault(); release();
    await assert.rejects(pending, /session changed|locked/i);
    assert.equal(store.isUnlocked(), false, 'canceled verification never unlocks');
    console.log('PASS cooldown growth/cap, real process restart, successful reset, queued requests, clock rollback, invalid/read-only state and unchanged synthetic vault files');
  } finally {
    crypto.scrypt = originalScrypt; store.lockVault();
    assertPrivateTree(root); assert.equal(path.dirname(root), path.resolve(testTempRoot()));
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
