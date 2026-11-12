const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const initSql = require("sql.js");
const { createVaultStore } = require("../src/services/vaultStore");
const { testTempRoot } = require("./testTemp");

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "password-history-"));
  const store = createVaultStore(root);
  const master = "history test master password";
  const dbPath = path.join(root, "vault/vault-data.slv");
  await store.createVault({ masterPassword: master, confirmPassword: master });
  // Inspect only this test's dummy database, never a user's vault.
  async function inspect(sql) {
    const auth = JSON.parse(await fs.readFile(path.join(root, "vault/vault-auth.json"), "utf8"));
    const key = crypto.scryptSync(master, Buffer.from(auth.keyDerivation.salt, "base64"), 32, auth.keyDerivation.options);
    const payload = JSON.parse(await fs.readFile(dbPath, "utf8"));
    const dec = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.encryption.iv, "base64"));
    dec.setAuthTag(Buffer.from(payload.encryption.tag, "base64"));
    const bytes = Buffer.concat([dec.update(Buffer.from(payload.encryption.ciphertext, "base64")), dec.final()]);
    const SQL = await initSql(); const db = new SQL.Database(bytes);
    try { return db.exec(sql); } finally { db.close(); bytes.fill(0); key.fill(0); }
  }
  assert.deepEqual(await inspect("SELECT name FROM sqlite_master WHERE name='credential_password_history'"), [], "legacy schema has no history table yet");
  const data = { websiteName: "History dummy", websiteUrl: "https://history.test", username: "dummy", password: "history-secret-0", groupName: "One" };
  const { id } = await store.createCredential(data);
  assert.deepEqual(await store.getPasswordHistory(id), []);
  await store.editCredential(id, { ...data, notes: "metadata only" });
  assert.deepEqual(await store.getPasswordHistory(id), []);
  await store.editCredential(id, { ...data, password: "history-secret-1" });
  let history = await store.getPasswordHistory(id);
  assert.equal(history[0].password, data.password);
  assert.ok(Number.isFinite(Date.parse(history[0].replacedAt)));
  assert.equal(Object.hasOwn((await store.getAllCredentialsForExport())[0], "history"), false);
  assert.equal((await fs.readFile(dbPath, "utf8")).includes("history-secret"), false);
  console.log("PASS migration, metadata-only edits, encrypted storage and history stays out of ordinary exports");

  const before = await fs.readFile(dbPath, "utf8");
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === dbPath) throw Error("simulated write failure"); return rename(from, to); };
  try { await assert.rejects(store.editCredential(id, { ...data, password: "failed-secret" }), /simulated/); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(dbPath, "utf8"), before);
  assert.equal((await store.getPasswordHistory(id)).length, 1);
  await Promise.all([2, 3, 4].map(n => store.editCredential(id, { ...data, password: `history-secret-${n}` })));
  assert.deepEqual((await store.getPasswordHistory(id)).map(x => x.password), [3, 2, 1, 0].map(n => `history-secret-${n}`));
  for (let n = 5; n <= 13; n++) await store.editCredential(id, { ...data, password: `history-secret-${n}` });
  history = await store.getPasswordHistory(id);
  assert.deepEqual(history.map(x => x.password), Array.from({ length: 10 }, (_, n) => `history-secret-${12 - n}`));
  await store.editCredential(id, { ...data, password: history[1].password });
  assert.equal((await store.getPasswordHistory(id))[0].password, "history-secret-13", "using history preserves the password it replaces");
  console.log("PASS failed writes are atomic, concurrent edits keep all transitions and retention keeps the latest ten");

  await store.createGroup("Two"); await store.setCurrentActiveGroup("Two");
  await assert.rejects(store.getPasswordHistory(id), /not found/);
  await store.setCurrentActiveGroup("");
  store.lockVault(); await assert.rejects(store.getPasswordHistory(id), /locked|unlock/i);
  await store.unlockVault({ masterPassword: master });
  assert.equal((await store.getPasswordHistory(id)).length, 10);
  const backup = path.join(root, "history.slvbackup"); await store.createEncryptedBackup(backup);
  const restored = createVaultStore(path.join(root, "restored"));
  await restored.restoreEncryptedBackup(backup, master); await restored.unlockVault({ masterPassword: master });
  assert.deepEqual(await restored.getPasswordHistory(id), await store.getPasswordHistory(id));
  const nextMaster = "another history master password";
  await restored.changeMasterPassword({ currentPassword: master, newPassword: nextMaster, confirmPassword: nextMaster });
  restored.lockVault(); await restored.unlockVault({ masterPassword: nextMaster });
  assert.equal((await restored.getPasswordHistory(id)).length, 10); restored.lockVault();
  await store.removeCredential(id);
  assert.equal((await inspect("SELECT COUNT(*) FROM credential_password_history"))[0].values[0][0], 0);
  const second = await store.createCredential(data);
  await store.editCredential(second.id, { ...data, password: "replacement" });
  await store.removeCredentialsByGroups(["One"]);
  assert.equal((await inspect("SELECT COUNT(*) FROM credential_password_history"))[0].values[0][0], 0);
  store.lockVault();
  console.log("PASS locked/group guards, restart, backup restore, master-password change, delete and replace-import cleanup");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
