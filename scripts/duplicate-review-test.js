const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { createVaultStore } = require("../src/services/vaultStore");
const { collectDuplicateGroups } = require("../src/services/duplicateReview");
const { testTempRoot } = require("./testTemp");
async function main() {
  const match = (url, username = "User", email = "") => ({ website_url: url, username, email });
  const sample = [match("https://EXAMPLE.com:443/a", " User "), match("example.com/b"),
    match("https://example.com", "user"), match("http://example.com"), match("https://www.example.com"), match("https://example.com:8443"),
    match("https://example.com", "", "User"), match("https://example.com", ""), match("https://example.com", ""),
    match("https://example.com@evil.test"), match("javascript:alert(1)"), match("")].map((row, id) => ({ ...row, id: id + 1 }));
  const groups = collectDuplicateGroups(sample);
  assert.equal(groups.length, 1); assert.deepEqual(groups[0].rows.map(x => x.id), [1, 2, 7]);
  console.log("PASS exact origin, default-port normalization, paths, case-sensitive identity, email fallback and invalid/blank exclusions");
  const root = await fs.mkdtemp(path.join(testTempRoot(), "duplicate-review-"));
  const store = createVaultStore(root), master = "Duplicate review dummy master password";
  await store.createVault({ masterPassword: master, confirmPassword: master });
  assert.equal((await store.getDuplicateReview()).groups.length, 0);
  const data = { websiteName: "Original", websiteUrl: "https://example.test/a", username: "dummy", password: "Original-dummy-secret", groupName: "One", notes: "Private test note" };
  const first = (await store.createCredential(data)).id;
  const second = (await store.createCredential({ ...data, websiteName: "Copy", websiteUrl: "https://example.test/b", groupName: "Two", qrCode: "data:image/png;base64,private-dummy" })).id;
  const third = (await store.createCredential({ ...data, websiteName: "Another copy" })).id;
  await store.editCredential(second, { ...await store.getCredential(second), password: "Updated-dummy-secret" });
  let report = await store.getDuplicateReview(); let group = report.groups[0];
  assert.equal(group.passwordsDiffer, true); assert.equal(group.multipleGroups, true);
  for (const secret of [data.password, data.notes, "Updated-dummy-secret", "data:image/png;base64,private-dummy"]) assert.equal(JSON.stringify(report).includes(secret), false);
  const original = await store.getCredential(first), history = await store.getPasswordHistory(second);
  const choice = () => ({ keepId: first, revision: group.revision, confirmed: true });
  for (const bad of [null, {}, { ...choice(), confirmed: false }, { ...choice(), keepId: "1" }, { ...choice(), keepId: -1 }, { ...choice(), revision: "forged" }]) await assert.rejects(store.resolveDuplicateReview(bad));
  assert.equal((await store.getAllCredentials()).length, 3);
  await store.setCurrentActiveGroup("One");
  assert.equal((await store.getDuplicateReview()).groups[0].entries.length, 2);
  await assert.rejects(store.resolveDuplicateReview(choice()), /changed/);
  await store.setCurrentActiveGroup("");
  await store.editCredential(third, { ...await store.getCredential(third), notes: "Changed private note" });
  await assert.rejects(store.resolveDuplicateReview(choice()), /changed/);
  group = (await store.getDuplicateReview()).groups[0];
  const extra = await store.createCredential(data);
  await assert.rejects(store.resolveDuplicateReview(choice()), /changed/);
  await store.removeCredential(extra.id);
  group = (await store.getDuplicateReview()).groups[0];
  console.log("PASS metadata-only review, confirmation validation, active scope, changed metadata and newly added copies invalidate cleanup");
  const file = path.join(root, "vault/vault-data.slv"), before = await fs.readFile(file, "utf8"), rename = fs.rename;
  fs.rename = async (from, to) => { if (to === file) throw Error("simulated write failure"); return rename(from, to); };
  try { await assert.rejects(store.resolveDuplicateReview(choice()), /simulated/); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(file, "utf8"), before);
  const attempts = await Promise.allSettled([store.resolveDuplicateReview(choice()), store.resolveDuplicateReview(choice())]);
  assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
  assert.deepEqual(await store.getCredential(first), original, "the kept entry is untouched");
  assert.equal((await store.getAllCredentials()).length, 1);
  assert.equal((await store.getDuplicateReview()).groups.length, 0);
  const trashed = (await store.getDeletedCredentials()).entries.find(x => x.websiteName === "Copy");
  await store.restoreDeletedCredential(trashed.id);
  assert.deepEqual((await store.getPasswordHistory(second)).map(({ id, ...rest }) => rest), history.map(({ id, ...rest }) => rest));
  assert.equal((await store.getDuplicateReview()).groups.length, 1);
  store.lockVault();
  await assert.rejects(store.getDuplicateReview(), /locked/); await assert.rejects(store.resolveDuplicateReview(choice()), /locked/);
  console.log("PASS atomic failure, concurrent/replayed cleanup, unchanged kept entry, recoverable copies/history and lock guards");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
