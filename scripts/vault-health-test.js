const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { weakReasons, buildVaultHealth } = require("../src/services/vaultHealth");
const { createVaultStore } = require("../src/services/vaultStore");
const { testTempRoot } = require("./testTemp");

async function main() {
  for (const password of ["", "abc", "Password1230!", "p@ssw0rd2026!", "aaaaaaaaaaaaaaaa", "abcdabcdabcdabcd", "12345678901234567890"]) {
    assert.ok(weakReasons(password).length, "obvious examples flagged");
  }
  for (const password of ["hiking lantern meadow cobalt", "7%bZx!2nQ9rL", "十二个字符以上的独特口令测试"]) assert.deepEqual(weakReasons(password), []);
  const row = (id, password) => ({ id, password, website_name: `Site ${id}`, username: "dummy", group_name: "" });
  const report = buildVaultHealth([row(1, "short"), row(2, "short"), row(3, "DistinctLongValue"), row(4, "distinctlongvalue"), row(5, ""), row(6, "")]);
  assert.equal(report.total, 6); assert.equal(report.weak, 4); assert.equal(report.reused, 2); assert.equal(report.affected, 4);
  assert.equal(report.entries[0].reusedWith, 1);
  assert.equal(JSON.stringify(report).includes('"password"'), false);
  assert.equal(JSON.stringify(report).includes("short"), false);
  assert.equal(buildVaultHealth([]).affected, 0);
  console.log("PASS basic weakness checks, exact case-sensitive reuse, empty-password handling and overlapping counts");

  const root = await fs.mkdtemp(path.join(testTempRoot(), "vault-health-"));
  const store = createVaultStore(root);
  await assert.rejects(store.checkVaultHealth(), /locked|unlock/i);
  const masterPassword = "vault health test master password";
  await store.createVault({ masterPassword, confirmPassword: masterPassword });
  assert.equal((await store.checkVaultHealth()).total, 0);
  const password = "Shared-secret-B7!x";
  const data = { websiteName: "Visible entry", username: "test-user", groupName: "One", password };
  const one = await store.createCredential(data);
  await store.createCredential({ ...data, websiteName: "Hidden entry", groupName: "Two" });
  const dbPath = path.join(root, "vault/vault-data.slv");
  await store.setCurrentActiveGroup("One");
  const before = await fs.readFile(dbPath, "utf8");
  let result = await store.checkVaultHealth();
  assert.equal(result.activeGroup, "One"); assert.equal(result.total, 1); assert.equal(result.reused, 0);
  assert.equal(JSON.stringify(result).includes("Hidden entry"), false);
  assert.equal(await fs.readFile(dbPath, "utf8"), before, "health checks do not write the vault");
  await store.setCurrentActiveGroup("");
  result = await store.checkVaultHealth(); assert.equal(result.reused, 2); assert.equal(result.affected, 2);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.deepEqual(Object.keys(result.entries[0]).sort(), ["id", "websiteName", "username", "groupName", "weak", "reused", "reasons", "reusedWith"].sort());
  await store.editCredential(one.id, { ...data, password: "Different-secret-T9$x" });
  assert.equal((await store.getPasswordHistory(one.id))[0].password, password);
  assert.equal((await store.checkVaultHealth()).reused, 0, "old passwords in history are excluded");
  await store.editCredential(one.id, { ...data, password: "abc" });
  assert.equal((await store.checkVaultHealth()).weak, 1);
  await store.removeCredential(one.id);
  assert.equal((await store.checkVaultHealth()).affected, 0);
  store.lockVault(); await assert.rejects(store.checkVaultHealth(), /locked|unlock/i);
  await store.unlockVault({ masterPassword }); assert.equal((await store.checkVaultHealth()).total, 1);
  store.lockVault();
  console.log("PASS encrypted-vault integration, active-group isolation, no password values in report, read-only scans, current-password scope and lock guards");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
