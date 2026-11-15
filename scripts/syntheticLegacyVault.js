// Reproduce the old on-disk format independently of the current vaultStore.
// Writes only newly generated fixtures under the project's .tmp directory.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const { testTempRoot } = require('./testTemp');
const { assertNoLinkedParents } = require('./package-content-policy');
const sqlite = require('../src/services/sqliteVault');
function encrypt(bytes, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  return { iv: iv.toString('base64'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
async function syntheticLegacyVault(root, password, { recovery = false, omitOptions = false } = {}) {
  root = path.resolve(root);
  assert.ok(root.startsWith(path.resolve(testTempRoot()) + path.sep));
  await fs.mkdir(root, { recursive: true }); assertNoLinkedParents(root);
  const directory = path.join(root, 'vault'); await fs.mkdir(directory); // Refuse an existing vault.
  const authPath = path.join(directory, 'vault-auth.json'), dbPath = path.join(directory, 'vault-data.slv');
  const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const salt = crypto.randomBytes(32), key = crypto.scryptSync(password, salt, 32, options);
  const dataKey = recovery ? crypto.randomBytes(32) : key;
  const auth = { version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    passwordHash: await bcrypt.hash(password, 12), passwordHashing: { algorithm: 'bcrypt', rounds: 12 },
    keyDerivation: { algorithm: 'scrypt', salt: salt.toString('base64'), keyLength: 32, options },
    encryption: { algorithm: 'aes-256-gcm', vaultCheck: encrypt(Buffer.from(JSON.stringify({ type: 'secure-login-vault-auth-check', check: 'synthetic-format-check' })), key) },
    storage: { type: 'encrypted-sqlite', fileName: 'vault-data.slv' }, hint: 'Synthetic hint only' };
  if (omitOptions) delete auth.keyDerivation.options;
  let recoveryKey;
  if (recovery) {
    const bytes = crypto.randomBytes(20), recoverySalt = crypto.randomBytes(32);
    const bits = Array.from(bytes, value => value.toString(2).padStart(8, '0')).join('');
    recoveryKey = bits.match(/.{5}/g).map(chunk => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(chunk, 2)]).join('').match(/.{4}/g).join('-');
    const wrapping = Buffer.from(crypto.hkdfSync('sha256', bytes, recoverySalt, 'secure-login-vault-recovery-v1', 32));
    auth.keyWrap = { dek: encrypt(dataKey, key), recovery: { salt: recoverySalt.toString('base64'), dek: encrypt(dataKey, wrapping) } };
    bytes.fill(0); wrapping.fill(0);
  }
  try {
    await sqlite.createEncryptedVaultFile(dbPath, dataKey, auth.createdAt);
    await sqlite.addCredential(dbPath, dataKey, { websiteName: 'Legacy synthetic site', websiteUrl: 'https://example.test/login', username: 'dummy-legacy', password: 'Dummy-entry-only-123!' });
    await fs.writeFile(authPath, JSON.stringify(auth), { flag: 'wx' });
    return { authPath, dbPath, recoveryKey, auth };
  } finally { key.fill(0); dataKey.fill(0); }
}
module.exports = { syntheticLegacyVault };
