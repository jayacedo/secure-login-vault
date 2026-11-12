const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { createVaultStore } = require("../src/services/vaultStore");
const { testTempRoot } = require("./testTemp");
const pw = "Local hardening original master", next = "Local hardening replacement master";
const settle = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

function pauseIO(method, predicate, after = false) {
  const original = fs[method]; let entered, resume, used = false;
  const reached = new Promise(resolve => { entered = resolve; });
  const release = new Promise(resolve => { resume = resolve; });
  fs[method] = async (...args) => {
    if (used || !predicate(...args)) return original(...args);
    used = true;
    let result;
    if (after) result = await original(...args);
    entered(); await release;
    return after ? result : original(...args);
  };
  return { reached, release: resume, restore() { resume(); fs[method] = original; } };
}

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "local-hardening-"));
  const store = createVaultStore(root), db = path.join(root, "vault/vault-data.slv"), auth = path.join(root, "vault/vault-auth.json");
  await store.createVault({ masterPassword: pw, confirmPassword: pw });
  const data = { websiteName: "Dummy login", websiteUrl: "https://hardening.test", username: "dummy", password: "Dummy-secret-original" };
  const id = (await store.createCredential(data)).id;

  // A real legacy re-key pauses after its backup. Save, backup and cleanup must
  // wait, then operate with the new key rather than a captured old one.
  let gate = pauseIO("copyFile", (_from, to) => to === db + ".rekey.bak");
  const change = settle(store.changeMasterPassword({ currentPassword: pw, newPassword: next, confirmPassword: next }));
  await gate.reached;
  const save = settle(store.editCredential(id, { ...data, password: "Dummy-secret-after-rekey" }));
  const backupPath = path.join(root, "concurrent.slvbackup");
  const backup = settle(store.createEncryptedBackup(backupPath));
  const purge = settle(store.purgeDeletedCredentials());
  gate.restore();
  assert.ok((await change).ok); assert.ok((await save).ok); assert.ok((await backup).ok); assert.ok((await purge).ok);
  store.lockVault(); await store.unlockVault({ masterPassword: next });
  assert.equal((await store.getCredential(id)).password, "Dummy-secret-after-rekey");
  const restored = createVaultStore(path.join(root, "restored"));
  await restored.restoreEncryptedBackup(backupPath, next); await restored.unlockVault({ masterPassword: next });
  assert.equal((await restored.getCredential(id)).password, "Dummy-secret-after-rekey"); restored.lockVault();
  console.log("PASS password changes serialize with save, backup and Trash cleanup; the resulting backup restores correctly");

  gate = pauseIO("readFile", file => file === db, true);
  const reading = settle(store.getCredential(id)); await gate.reached;
  const queued = settle(store.createCredential({ ...data, websiteName: "Must not be saved" }));
  store.lockVault(); assert.equal(store.isUnlocked(), false);
  gate.restore(); assert.equal((await reading).ok, false); assert.equal((await queued).ok, false);
  await store.unlockVault({ masterPassword: next }); assert.equal((await store.getAllCredentials()).length, 1);
  const before = await fs.readFile(db, "utf8");
  gate = pauseIO("writeFile", file => String(file).startsWith(db + ".") && String(file).endsWith(".tmp"), true);
  const writing = settle(store.editCredential(id, { ...data, password: "Must-not-commit" }));
  await gate.reached; store.lockVault(); gate.restore();
  assert.equal((await writing).ok, false); assert.equal(await fs.readFile(db, "utf8"), before);
  assert.equal((await fs.readdir(path.dirname(db))).some(name => name.endsWith(".tmp")), false);
  await store.unlockVault({ masterPassword: next });
  console.log("PASS locking suppresses late secrets, cancels queued writes and removes uncommitted temporary files");

  // Once the DB replacement committed, finish the matching auth replacement;
  // do not zero the operation key mid-encryption or accidentally unlock again.
  gate = pauseIO("rename", (_from, to) => to === db, true);
  const interruptedChange = settle(store.changeMasterPassword({ currentPassword: next, newPassword: pw, confirmPassword: pw }));
  await gate.reached; store.lockVault(); gate.restore();
  assert.equal((await interruptedChange).ok, false); assert.equal(store.isUnlocked(), false);
  await store.unlockVault({ masterPassword: pw });
  assert.equal((await store.getCredential(id)).password, "Dummy-secret-after-rekey");
  store.lockVault();
  gate = pauseIO("readFile", file => file === auth, true);
  const unlocking = settle(store.unlockVault({ masterPassword: pw }));
  await gate.reached; store.lockVault(); gate.restore();
  assert.equal((await unlocking).ok, false); assert.equal(store.isUnlocked(), false);
  await store.unlockVault({ masterPassword: pw });
  console.log("PASS locking during commit preserves the auth/database pair and never reopens the session; late unlock is cancelled");

  const currentDb = await fs.readFile(db, "utf8"), currentAuth = await fs.readFile(auth, "utf8");
  const damagedPath = path.join(root, "damaged.slvbackup");
  const damaged = JSON.parse(await fs.readFile(backupPath, "utf8"));
  const encrypted = Buffer.from(damaged.database.encryption.ciphertext, "base64"); encrypted[0] ^= 1;
  damaged.database.encryption.ciphertext = encrypted.toString("base64");
  await fs.writeFile(damagedPath, JSON.stringify(damaged));
  await assert.rejects(store.restoreEncryptedBackup(damagedPath, next));
  assert.equal(await fs.readFile(db, "utf8"), currentDb); assert.equal(await fs.readFile(auth, "utf8"), currentAuth);
  const emptyRoot = path.join(root, "failed-first-restore"), empty = createVaultStore(emptyRoot);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === path.join(emptyRoot, "vault/vault-auth.json")) throw Error("simulated auth write failure"); return rename(from, to); };
  try { await assert.rejects(empty.restoreEncryptedBackup(backupPath, next), /simulated/); }
  finally { fs.rename = rename; }
  assert.equal((await empty.getState()).hasVault, false); assert.equal((await empty.getState()).databaseReady, false);

  // Simulate a crash during restore: new DB, old auth, verified old pair backups.
  await fs.copyFile(auth, auth + ".pre-restore.bak"); await fs.copyFile(db, db + ".pre-restore.bak");
  await fs.writeFile(db, JSON.stringify(JSON.parse(await fs.readFile(backupPath, "utf8")).database));
  store.lockVault(); await store.unlockVault({ masterPassword: pw });
  assert.equal((await store.getCredential(id)).password, "Dummy-secret-after-rekey");
  store.lockVault();
  console.log("PASS damaged backup rejection before overwrite, failed first-restore rollback and interrupted restore recovery");
}
const timeout = setTimeout(() => { console.error("Local hardening test timed out"); process.exit(1); }, 60000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
