const assert = require("assert");
const { isSafeExternalUrl, createPathGrants } = require("../src/services/ipcGuards");

// External URLs
for (const ok of ["https://example.com/a?b=1", "http://localhost:8080", "mailto:a@b.com"]) {
  assert.equal(isSafeExternalUrl(ok), true, ok);
}
for (const bad of [
  "file:///C:/Windows/System32/calc.exe",
  "javascript:alert(1)",
  "ms-msdt:/id PCWDiagnostic",
  "ftp://example.com",
  "data:text/html,hi",
  "example.com",
  "",
  null,
  undefined,
  42,
  "https://" + "a".repeat(5000)
]) {
  assert.equal(isSafeExternalUrl(bad), false, String(bad));
}

// Path grants
let t = 1000;
const grants = createPathGrants(() => t);
assert.equal(grants.has("export", "C:\\out\\a.csv"), false);
grants.grant("export", "C:\\out\\a.csv");
assert.equal(grants.has("export", "C:\\out\\a.csv"), true);
assert.equal(grants.has("restore", "C:\\out\\a.csv"), false, "kinds are separate");
assert.equal(grants.has("export", "C:\\out\\b.csv"), false, "other paths are not granted");
assert.equal(grants.has("export", undefined), false);
grants.revoke("export", "C:\\out\\a.csv");
assert.equal(grants.has("export", "C:\\out\\a.csv"), false, "revoked");
grants.grant("export", "C:\\out\\a.csv");
t += 11 * 60 * 1000;
assert.equal(grants.has("export", "C:\\out\\a.csv"), false, "expired");

console.log("ipc-guards tests passed");
