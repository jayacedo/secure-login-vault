const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const initSqlJs = require("sql.js");
const { createVaultStore } = require("../src/services/vaultStore");
const { RETENTION_MS } = require("../src/services/activityHistory");
const { testTempRoot } = require("./testTemp");
async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "activity-"));
  const store = createVaultStore(root), master = "Activity history dummy master password";
  await store.createVault({ masterPassword: master, confirmPassword: master });
  assert.equal((await store.getActivityHistory()).total, 0);
  const data = { websiteName: "Client <b>site</b>", websiteUrl: "https://activity.test/?secret=private-url", username: "Private-user", password: "Private-password", notes: "Private-note", qrCode: "Private-qr", groupName: "Client A", category: "Other" };
  const { id } = await store.createCredential({ ...data, source: "browser" });
  await store.editCredential(id, data);
  assert.equal((await store.getActivityHistory()).total, 1, "no-op edit does not invent a change");
  await store.editCredential(id, { ...data, password: "Changed-password" });
  await store.toggleCredentialFavorite(id);
  const browser = await store.createBrowserCredential({ ...data, websiteName: "Browser login" }, { groupName: "Client A", category: "Other", activeGroup: "" });
  await store.updateBrowserPassword(browser.id, "Browser-password");
  assert.equal((await store.getCredential(browser.id)).notes, data.notes, "browser password-only update preserves other fields");
  await store.removeCredential(id);
  const removed = (await store.getDeletedCredentials()).entries[0];
  await store.restoreDeletedCredential(removed.id);
  await store.removeCredential(id);
  await store.permanentlyDeleteCredential((await store.getDeletedCredentials()).entries[0].id, true);
  const report = await store.getActivityHistory();
  assert.deepEqual(report.entries.filter(x => x.credentialId === id).map(x => x.event), ["permanently_deleted", "deleted", "restored", "deleted", "updated", "password_updated", "added"]);
  assert.equal(report.entries.find(x => x.credentialId === id && x.event === "added").source, "desktop", "renderer payload cannot forge source");
  assert.deepEqual(report.entries.filter(x => x.source === "browser").map(x => x.event), ["password_updated", "added"]);
  for (const secret of [data.password, "Changed-password", "Browser-password", data.username, data.websiteUrl, data.notes, data.qrCode, master]) assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal((await fs.readFile(path.join(root, "vault/vault-data.slv"), "utf8")).includes(data.websiteName), false);
  assert.equal((await store.getActivityHistory({ query: "browser", source: "browser", event: "added" })).total, 1);
  assert.equal((await store.getActivityHistory({ query: "%' OR 1=1 --" })).total, 0);
  for (const options of [null, [], { offset: -1 }, { offset: 1.5 }, { event: "made-up" }, { source: "firefox" }, { query: "x".repeat(201) }]) await assert.rejects(store.getActivityHistory(options), /filters/);
  await store.createGroup("Client B"); await store.setCurrentActiveGroup("Client B");
  assert.equal((await store.getActivityHistory()).total, 0);
  await store.setCurrentActiveGroup("");
  console.log("PASS event types, desktop/browser attribution, no-op suppression, encrypted metadata-only history, search, filters and group scope");

  const before = (await store.getActivityHistory()).total, write = fs.writeFile;
  fs.writeFile = async (file, ...args) => { if (String(file).includes("vault-data.slv.") && String(file).endsWith(".tmp")) throw Error("simulated disk failure"); return write(file, ...args); };
  try { await assert.rejects(store.createCredential({ ...data, websiteName: "Must not save" }), /simulated/); }
  finally { fs.writeFile = write; }
  assert.equal((await store.getActivityHistory()).total, before, "failed change has no activity event");
  await Promise.all(Array.from({ length: 53 }, (_, i) => store.createCredential({ ...data, websiteName: `Paged ${i}` })));
  const page1 = await store.getActivityHistory({ query: "Paged" }), page2 = await store.getActivityHistory({ query: "Paged", offset: 50 });
  assert.equal(page1.entries.length, 50); assert.equal(page2.entries.length, 3);
  assert.equal(new Set([...page1.entries, ...page2.entries].map(x => x.id)).size, 53);
  await store.removeCredentialsByGroups(["Client A"]);
  assert.equal((await store.getActivityHistory({ event: "deleted" })).total, 56, "Replace import displacement records each deletion");
  const backup = path.join(root, "activity.slvbackup"); await store.createEncryptedBackup(backup);
  const beforeBackup = await store.getActivityHistory();
  const restored = createVaultStore(path.join(root, "restore"));
  await restored.restoreEncryptedBackup(backup, master); await restored.unlockVault({ masterPassword: master });
  assert.deepEqual(await restored.getActivityHistory(), beforeBackup, "backup preserves activity without inventing restore-of-login events");
  const next = "Changed activity master password";
  await store.changeMasterPassword({ currentPassword: master, newPassword: next, confirmPassword: next });
  store.lockVault(); await assert.rejects(store.getActivityHistory(), /locked/); await assert.rejects(store.purgeActivityHistory(), /locked/);
  await store.unlockVault({ masterPassword: next }); assert.deepEqual(await store.getActivityHistory(), beforeBackup);
  console.log("PASS atomic failure, concurrent changes, pagination, replace-import tracking, encrypted backup and password-change compatibility");

  const newest = Date.parse(beforeBackup.entries[0].occurredAt), realNow = Date.now;
  Date.now = () => newest + RETENTION_MS;
  try { assert.equal((await store.getActivityHistory()).total, 0); await store.purgeActivityHistory(); }
  finally { Date.now = realNow; }
  assert.equal((await store.getActivityHistory()).total, 0, "expired events are physically removed from the saved database");
  assert.ok((await restored.getActivityHistory()).total > 0, "older backup keeps its independent snapshot");
  store.lockVault(); restored.lockVault();
  console.log("PASS exact 90-day exclusion and persisted cleanup; backups retain their snapshots");

  // Model a pre-feature vault by dropping only the new table from a dummy
  // encrypted snapshot. Opening History must not invent events for old rows.
  const legacyRoot = path.join(root, "legacy"), legacy = createVaultStore(legacyRoot);
  await legacy.createVault({ masterPassword: master, confirmPassword: master });
  const old = await legacy.createCredential(data); legacy.lockVault();
  const auth = JSON.parse(await fs.readFile(path.join(legacyRoot, "vault/vault-auth.json"), "utf8"));
  const file = path.join(legacyRoot, "vault/vault-data.slv"), payload = JSON.parse(await fs.readFile(file, "utf8"));
  const key = crypto.scryptSync(master, Buffer.from(auth.keyDerivation.salt, "base64"), 32, auth.keyDerivation.options);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.encryption.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.encryption.tag, "base64"));
  const bytes = Buffer.concat([decipher.update(Buffer.from(payload.encryption.ciphertext, "base64")), decipher.final()]);
  const SQL = await initSqlJs(), db = new SQL.Database(bytes); db.run("DROP TABLE credential_activity");
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(db.export())), cipher.final()]); db.close(); bytes.fill(0); key.fill(0);
  payload.encryption = { algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  await fs.writeFile(file, JSON.stringify(payload));
  await legacy.unlockVault({ masterPassword: master });
  assert.equal((await legacy.getActivityHistory()).total, 0);
  assert.equal((await legacy.getCredential(old.id)).password, data.password);
  await legacy.toggleCredentialFavorite(old.id);
  assert.equal((await legacy.getActivityHistory()).total, 1);
  legacy.lockVault();
  console.log("PASS old vault migration preserves credentials and records only new changes");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
