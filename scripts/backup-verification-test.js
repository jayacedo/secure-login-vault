const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { testTempRoot } = require("./testTemp");
const { createVaultStore } = require("../src/services/vaultStore");
const { createBackupVerification } = require("../src/services/backupVerification");
const initSqlJs = require("sql.js");

// Alter only a freshly generated synthetic backup to exercise valid encryption
// around a database that should still fail the structural recovery checks.
async function alterSyntheticDatabase(snapshot, password, sql) {
  const bundle = JSON.parse(snapshot);
  const key = crypto.scryptSync(password, Buffer.from(bundle.auth.keyDerivation.salt, "base64"), 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const encrypted = bundle.database.encryption;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const bytes = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]);
  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes);
  try {
    db.exec(sql);
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const changed = db.export();
    const ciphertext = Buffer.concat([cipher.update(changed), cipher.final()]);
    changed.fill(0);
    bundle.database.encryption = { algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    return JSON.stringify(bundle);
  } finally { db.close(); bytes.fill(0); key.fill(0); }
}

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "backup-verify-"));
  const store = createVaultStore(path.join(root, "synthetic-vault"));
  const password = "dummy backup check passphrase only";
  const directory = path.join(root, "checks");
  const check = createBackupVerification({ directory });
  try {
    await check.prepare();
    assert.equal(check.status().lastCheck, null);
    await store.createVault({ masterPassword: password, confirmPassword: password });
    await store.createCredential({ websiteName: "Synthetic example", websiteUrl: "https://example.test/login", username: "dummy-user", password: "dummy-secret" });
    const backup = path.join(root, "synthetic.slvbackup");
    await store.createEncryptedBackup(backup);
    await store.createCredential({ websiteName: "Only in current dummy vault", password: "dummy-current" });
    const snapshot = await fs.readFile(backup);
    const dbPath = path.join(root, "synthetic-vault/vault/vault-data.slv");
    const authPath = path.join(root, "synthetic-vault/vault/vault-auth.json");
    const before = await fs.readFile(dbPath), authBefore = await fs.readFile(authPath);
    const result = await check.verify(backup, password);
    assert.equal(result.verified, true);
    assert.equal(result.integrity, "ok");
    assert.equal(result.counts.credentials, 1);
    const saved = JSON.parse(await fs.readFile(`${directory}.json`, "utf8"));
    assert.deepEqual(Object.keys(saved.lastCheck).sort(), ["backupCreatedAt", "checkedAt", "fileName", "outcome"]);
    assert.equal(saved.lastCheck.fileName, "synthetic.slvbackup");
    assert.equal(saved.lastCheck.outcome, "passed");
    const restarted = createBackupVerification({ directory });
    await restarted.prepare();
    assert.deepEqual(restarted.status().lastCheck, saved.lastCheck, "summary survives a new service instance");
    const createdAt = Date.parse(result.backupCreatedAt);
    assert.equal(restarted.status({ createdAt: createdAt - 1 }).newerAutomaticBackup, false);
    assert.equal(restarted.status({ createdAt }).newerAutomaticBackup, false);
    assert.equal(restarted.status({ createdAt: createdAt + 1 }).newerAutomaticBackup, true);
    assert.equal(restarted.status().newerAutomaticBackup, null);
    assert.equal(result.fingerprint, crypto.createHash("sha256").update(snapshot).digest("hex"));
    assert(!JSON.stringify(result).includes("dummy-secret"));
    assert.deepEqual(await fs.readdir(directory), [], "success removes the rehearsal vault");
    assert.deepEqual(await fs.readFile(backup), snapshot, "source backup stays byte-for-byte unchanged");
    assert.deepEqual(await fs.readFile(dbPath), before, "current synthetic vault stays unchanged");
    assert.deepEqual(await fs.readFile(authPath), authBefore);
    assert.equal(store.isUnlocked(), true);
    await assert.rejects(check.verify(backup, "wrong dummy password"), /password|incorrect/i);
    assert.equal(check.status().lastCheck.outcome, "failed");
    assert.equal(check.status().lastCheck.backupCreatedAt, null);
    assert.deepEqual(await fs.readdir(directory), []);
    // The password from backup creation still works after the current vault changes.
    const newPassword = "new dummy master passphrase only";
    await store.changeMasterPassword({ currentPassword: password, newPassword, confirmPassword: newPassword });
    assert.equal((await check.verify(backup, password)).verified, true);
    const corrupt = JSON.parse(snapshot);
    corrupt.database.encryption.ciphertext = "AAAA";
    const broken = path.join(root, "broken.slvbackup");
    await fs.writeFile(broken, JSON.stringify(corrupt));
    await assert.rejects(check.verify(broken, password));
    await fs.writeFile(broken, "not a backup");
    await assert.rejects(check.verify(broken, password));
    await fs.writeFile(broken, await alterSyntheticDatabase(snapshot, password, "ALTER TABLE clients DROP COLUMN admin_password;"));
    await assert.rejects(check.verify(broken, password), /failed|incompatible/i);
    await fs.writeFile(broken, await alterSyntheticDatabase(snapshot, password, "PRAGMA foreign_keys=OFF; CREATE TABLE check_parent(id INTEGER PRIMARY KEY); CREATE TABLE check_child(parent_id INTEGER REFERENCES check_parent(id)); INSERT INTO check_child VALUES(999);"));
    await assert.rejects(check.verify(broken, password), /broken database references/i);
    const oversized = await fs.open(broken, "w");
    await oversized.truncate(256 * 1024 * 1024 + 1); await oversized.close();
    await assert.rejects(check.verify(broken, password), /256 MB/);
    await store.createRecoveryKey({ currentPassword: newPassword });
    await store.createEncryptedBackup(broken);
    assert.equal((await check.verify(broken, newPassword)).counts.credentials, 2, "recovery-enabled vault backups also restore");
    assert.deepEqual(await fs.readdir(directory), []);
    const beforeCancel = await fs.readFile(`${directory}.json`, "utf8");
    const pending = check.verify(backup, password);
    await assert.rejects(check.verify(backup, password), /already running/);
    check.cancel();
    await assert.rejects(pending, /cancelled/);
    assert.equal(await fs.readFile(`${directory}.json`, "utf8"), beforeCancel, "cancellation preserves previous check");
    assert.deepEqual(await fs.readdir(directory), [], "cancel removes temporary files");
    const short = createBackupVerification({ directory, timeoutMs: 1 });
    await assert.rejects(short.verify(backup, password), /too long/);
    assert.deepEqual(await fs.readdir(directory), [], "timeout removes temporary files");
    await fs.mkdir(path.join(directory, "check-ABC123"));
    await fs.writeFile(path.join(directory, "check-ABC123/encrypted-leftover"), snapshot);
    await fs.writeFile(path.join(directory, "unrelated.txt"), "leave me");
    await check.prepare();
    assert.deepEqual(await fs.readdir(directory), ["unrelated.txt"], "startup removes only known rehearsal folders");
    await fs.writeFile(`${directory}.json`, "invalid summary");
    await restarted.prepare();
    assert.equal(restarted.status().lastCheck, null);
    assert.match(restarted.status().warning, /could not be loaded/);
    const unavailable = createBackupVerification({ directory, statusPath: path.join(root, "missing-folder/status.json") });
    assert.equal((await unavailable.verify(backup, password)).verified, true, "metadata write failure does not misreport backup failure");
    assert.match(unavailable.status().warning, /could not be saved/);
    console.log("PASS backup recovery, original-file isolation, old password, corruption, cancellation, concurrency, timeout and startup cleanup (synthetic data only)");
  } finally {
    check.cancel(); store.lockVault();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
