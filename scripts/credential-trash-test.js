const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { createVaultStore } = require("../src/services/vaultStore");
const { RETENTION_MS } = require("../src/services/credentialTrash");
const { testTempRoot } = require("./testTemp");

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "credential-trash-"));
  const store = createVaultStore(root), master = "Recently deleted dummy master password";
  await store.createVault({ masterPassword: master, confirmPassword: master });
  assert.deepEqual((await store.getDeletedCredentials()).entries, []);
  const data = { websiteName: "Deleted dummy", websiteUrl: "https://trash.test", username: "dummy-user", password: "Old-dummy-password!", email: "dummy@trash.test", notes: "private dummy notes", tags: "one,two", favorite: true, groupName: "Client A", category: "WordPress", qrCode: "data:image/png;base64,dummy" };
  const { id } = await store.createCredential(data);
  await store.editCredential(id, { ...data, password: "Current-dummy-password!" });
  const before = await store.getCredential(id), history = await store.getPasswordHistory(id);
  await store.removeCredential(id);
  const report = await store.getDeletedCredentials(), entry = report.entries[0];
  assert.equal(report.entries.length, 1);
  assert.equal(Date.parse(entry.expiresAt) - Date.parse(entry.deletedAt), RETENTION_MS);
  for (const secret of [data.password, "Current-dummy-password!", data.notes, data.qrCode]) assert.equal(JSON.stringify(report).includes(secret), false);
  for (const field of ["password", "history", "credential_json", "history_json"]) assert.equal(Object.hasOwn(entry, field), false);
  assert.deepEqual(await store.getAllCredentials(), [], "browser list sees no trashed credentials");
  assert.deepEqual(await store.getAllCredentialsForExport(), []);
  await assert.rejects(store.getCredential(id), /not found/);
  await assert.rejects(store.getPasswordHistory(id), /not found/);
  assert.equal((await store.checkVaultHealth()).total, 0);
  assert.equal((await store.getDashboardData()).summary.totalCredentials, 0);
  assert.equal((await fs.readFile(path.join(root, "vault/vault-data.slv"), "utf8")).includes(data.password), false);
  console.log("PASS encrypted retention, metadata-only list, history isolation, browser/export/health/dashboard exclusion");

  await store.createGroup("Client B"); await store.setCurrentActiveGroup("Client B");
  assert.equal((await store.getDeletedCredentials()).entries.length, 0);
  await assert.rejects(store.restoreDeletedCredential(entry.id), /not found/);
  await assert.rejects(store.permanentlyDeleteCredential(entry.id, true), /not found/);
  await store.setCurrentActiveGroup("");
  for (const bad of [undefined, null, "1", {}, -1, 0, 1.1]) await assert.rejects(store.restoreDeletedCredential(bad), /not found/);
  await assert.rejects(store.permanentlyDeleteCredential(entry.id, false), /Confirm/);
  store.lockVault();
  for (const operation of [() => store.getDeletedCredentials(), () => store.restoreDeletedCredential(entry.id), () => store.permanentlyDeleteCredential(entry.id, true), () => store.purgeDeletedCredentials()]) await assert.rejects(operation(), /locked/);
  await store.unlockVault({ masterPassword: master });
  const backup = path.join(root, "trash.slvbackup"); await store.createEncryptedBackup(backup);
  const restoredStore = createVaultStore(path.join(root, "backup-restored"));
  await restoredStore.restoreEncryptedBackup(backup, master); await restoredStore.unlockVault({ masterPassword: master });
  assert.equal((await restoredStore.getDeletedCredentials()).entries.length, 1);
  await restoredStore.restoreDeletedCredential(entry.id);
  assert.deepEqual(await restoredStore.getCredential(id), before);
  assert.deepEqual((await restoredStore.getPasswordHistory(id)).map(({ id, ...x }) => x), history.map(({ id, ...x }) => x));
  restoredStore.lockVault();
  console.log("PASS group/lock/ID/confirmation guards and encrypted backup restore with complete login/history");

  const dbPath = path.join(root, "vault/vault-data.slv"), raw = await fs.readFile(dbPath, "utf8");
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to === dbPath) throw Error("simulated write failure"); return rename(from, to); };
  try { await assert.rejects(store.restoreDeletedCredential(entry.id), /simulated/); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(dbPath, "utf8"), raw, "failed restoration cannot partially move data");
  const attempts = await Promise.allSettled([store.restoreDeletedCredential(entry.id), store.restoreDeletedCredential(entry.id)]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  assert.deepEqual(await store.getCredential(id), before);
  assert.deepEqual((await store.getPasswordHistory(id)).map(({ id, ...x }) => x), history.map(({ id, ...x }) => x));
  assert.equal((await store.getDeletedCredentials()).entries.length, 0);
  await store.removeCredentialsByGroups(["Client A"]);
  const replacementTrash = (await store.getDeletedCredentials()).entries[0];
  assert.ok(replacementTrash, "replace-import retains displaced entries");
  await store.permanentlyDeleteCredential(replacementTrash.id, true);
  assert.equal((await store.getDeletedCredentials()).entries.length, 0);
  await assert.rejects(store.restoreDeletedCredential(replacementTrash.id), /not found/);
  console.log("PASS atomic failure, concurrent restore, complete metadata/history restoration and confirmed permanent deletion");

  const deleted = await store.createCredential(data); await store.removeCredential(deleted.id);
  const expiring = (await store.getDeletedCredentials()).entries[0];
  const realNow = Date.now;
  Date.now = () => Date.parse(expiring.expiresAt);
  try {
    await assert.rejects(store.restoreDeletedCredential(expiring.id), /expired|not found/);
    await store.purgeDeletedCredentials();
    assert.equal((await store.getDeletedCredentials()).entries.length, 0);
  } finally { Date.now = realNow; }
  assert.equal((await store.getDeletedCredentials()).entries.length, 0, "expiry is persisted, not just hidden");
  await store.createCategory("Temporary category");
  const organized = await store.createCredential({ ...data, category: "Temporary category", groupName: "Temporary group" });
  await store.removeCredential(organized.id);
  const organizedTrash = (await store.getDeletedCredentials()).entries[0];
  await store.removeGroup("Temporary group"); await store.removeCategory("Temporary category", "Other");
  await store.restoreDeletedCredential(organizedTrash.id);
  assert.equal((await store.getCredential(organized.id)).groupName, "Temporary group");
  assert.equal((await store.getCredential(organized.id)).category, "Temporary category");
  assert.ok((await store.getAllGroups()).includes("Temporary group"));
  assert.ok((await store.getAllCategories()).includes("Temporary category"));
  const fresh = await store.createCredential(data); await store.removeCredential(fresh.id);
  const freshTrash = (await store.getDeletedCredentials()).entries[0];
  const nextMaster = "Changed recently deleted dummy password";
  await store.changeMasterPassword({ currentPassword: master, newPassword: nextMaster, confirmPassword: nextMaster });
  store.lockVault(); await store.unlockVault({ masterPassword: nextMaster });
  await store.restoreDeletedCredential(freshTrash.id);
  assert.equal((await store.getCredential(fresh.id)).password, data.password);
  store.lockVault();
  console.log("PASS exact 30-day expiry, permanent cleanup and master-password change");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
