// Fresh synthetic files only. Never open an installed vault or real export.
const assert = require('assert/strict'), fs = require('fs/promises'), path = require('path');
const { testTempRoot } = require('./testTemp');
const { readBoundedFile, readBoundedText, MAX_IMPORT_BYTES, MAX_BACKUP_BYTES } = require('../src/services/fsUtils');
const policy = require('../src/shared/importPolicy');
const csv = require('../src/renderer/csvImport');
const { createVaultStore } = require('../src/services/vaultStore');

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), 'import-hardening-'));
  console.log(`Synthetic workspace: ${root}`);
  const file = path.join(root, 'input.txt');
  await fs.writeFile(file, '12345678');
  assert.equal(await readBoundedText(file, 8, 'a test file'), '12345678');
  await assert.rejects(readBoundedFile(file, 7, 'a test file'), /up to/);
  await fs.writeFile(file, ''); assert.equal(await readBoundedText(file, 8, 'a test file'), '');
  await assert.rejects(readBoundedFile(root, 8, 'a test file'));
  // Grow/shrink/rewrite the already-open file after its first read. This tests
  // the handle-based bound, rather than only trusting the first size check.
  const originalOpen = fs.open;
  for (const kind of ['grow', 'shrink', 'rewrite', 'cancel']) {
    await fs.writeFile(file, 'x'.repeat(70000));
    let changed = false, cancelled = false, closed = false, allocation;
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] !== file) return handle;
      const read = handle.read.bind(handle), close = handle.close.bind(handle);
      handle.read = async (...params) => {
        allocation = params[0];
        const result = await read(...params);
        if (!changed) {
          changed = true;
          if (kind === 'grow') await fs.appendFile(file, 'more');
          if (kind === 'shrink') await fs.truncate(file, 1);
          if (kind === 'rewrite') await fs.utimes(file, new Date(0), new Date(0));
          if (kind === 'cancel') cancelled = true;
        }
        return result;
      };
      handle.close = async () => { closed = true; await close(); };
      return handle;
    };
    try {
      await assert.rejects(readBoundedFile(file, 70000, 'a test file', () => { if (cancelled) throw Error('Cancelled'); }), /changed|Cancelled/);
      assert.equal(closed, true);
      assert.equal(allocation.every(byte => byte === 0), true, 'failed reads wipe their buffers');
    } finally { fs.open = originalOpen; }
  }
  for (const limit of [MAX_IMPORT_BYTES, MAX_BACKUP_BYTES]) {
    const handle = await fs.open(file, 'w'); await handle.truncate(limit + 1); await handle.close();
    await assert.rejects(readBoundedText(file, limit, 'a test file'), /up to/);
  }
  const valid = { websiteName: 'Synthetic', password: '  dummy,secret\nonly  ', groupName: 'Test group' };
  policy.rows([valid]);
  assert.throws(() => policy.rows(Array.from({ length: 5001 }, () => valid)), /5,000/);
  for (const invalid of [{ ...valid, password: 'x'.repeat(4097) }, { ...valid, notes: {} }, { ...valid, extra: {} }]) assert.throws(() => policy.rows([invalid]));
  assert.throws(() => csv.read('Website,Password\n' + 'A,p\n'.repeat(5001)), /5,000/);
  assert.throws(() => csv.parseRows('x,'.repeat(32) + 'x'), /32 columns/);
  assert.throws(() => csv.parseRows('"' + 'x'.repeat(100001) + '"'), /100,000/);
  assert.throws(() => csv.parseRows('Website,Password\nA,"unfinished'), /unclosed/);
  assert.throws(() => policy.text('\u20ac'.repeat(Math.floor(MAX_IMPORT_BYTES / 3) + 1)), /16 MB/);

  const store = createVaultStore(path.join(root, 'synthetic-profile'));
  const password = 'Synthetic import and restore password';
  await store.createVault({ masterPassword: password, confirmPassword: password });
  await store.createCredential({ ...valid, websiteName: 'Original' });
  await store.createCredential({ ...valid, websiteName: 'Other group', groupName: 'Untouched' });
  const database = path.join(root, 'synthetic-profile/vault/vault-data.slv');
  const auth = path.join(root, 'synthetic-profile/vault/vault-auth.json');
  const snapshot = await fs.readFile(database), authSnapshot = await fs.readFile(auth);
  async function unchanged() {
    assert.deepEqual(await fs.readFile(database), snapshot);
    assert.deepEqual(await fs.readFile(auth), authSnapshot);
  }
  await assert.rejects(store.importCredentials({ rows: [valid, { ...valid, password: '' }], replace: true })); await unchanged();
  await assert.rejects(store.importCredentials({ rows: [valid], replace: false, expectedActiveGroup: 'Changed group' })); await unchanged();
  // A failed final write or lock during staging must not publish any batch,
  // including Replace's trash changes. Only this test vault is intercepted.
  const originalWrite = fs.writeFile;
  for (const mode of ['disk-error', 'lock']) {
    fs.writeFile = async (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith(database + '.') && args[0].endsWith('.tmp')) {
        if (mode === 'disk-error') throw Error('Synthetic disk failure');
        await originalWrite(...args); store.lockVault(); return;
      }
      return originalWrite(...args);
    };
    try { await assert.rejects(store.importCredentials({ rows: [valid, { ...valid, websiteName: 'Second' }], replace: true })); }
    finally { fs.writeFile = originalWrite; }
    await unchanged();
    if (!store.isUnlocked()) await store.unlockVault({ masterPassword: password });
  }
  // Invalid/oversized restore inputs must be rejected before replacing files.
  const backup = path.join(root, 'synthetic.slvbackup');
  await store.createEncryptedBackup(backup);
  for (const content of ['{', 'null', '{"format":"wrong"}']) {
    await fs.writeFile(file, content); await assert.rejects(store.restoreEncryptedBackup(file, password)); await unchanged();
  }
  const oversized = await fs.open(file, 'w'); await oversized.truncate(MAX_BACKUP_BYTES + 1); await oversized.close();
  await assert.rejects(store.restoreEncryptedBackup(file, password), /256 MB/); await unchanged();
  await assert.rejects(store.restoreEncryptedBackup(backup, 'wrong synthetic password')); await unchanged();
  let interrupted = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === backup) {
      const read = handle.read.bind(handle);
      handle.read = async (...params) => { const result = await read(...params); if (!interrupted) { interrupted = true; store.lockVault(); } return result; };
    }
    return handle;
  };
  try { await assert.rejects(store.restoreEncryptedBackup(backup, password), /session|locked/); }
  finally { fs.open = originalOpen; }
  await unchanged(); await store.unlockVault({ masterPassword: password });
  const imported = await store.importCredentials({ rows: [valid, { ...valid, websiteName: 'Second' }], replace: true });
  assert.equal(imported.imported, 2); assert.equal(imported.deleted, 1);
  const rows = await store.getAllCredentialsForExport();
  assert.equal(rows.length, 3); assert(rows.some(row => row.websiteName === 'Other group'));
  assert.equal(rows.find(row => row.websiteName === 'Synthetic').password, valid.password);
  assert.equal((await store.getDeletedCredentials()).entries.length, 1);
  await store.restoreEncryptedBackup(backup, password);
  await store.unlockVault({ masterPassword: password });
  assert.equal((await store.getAllCredentialsForExport()).length, 2);
  store.lockVault();
  console.log('PASS bounded reads, growth/shrink/cancel, import limits, atomic Replace, failure preservation and backup compatibility');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
