const assert = require("assert");
const { isSafeExternalUrl, createPathGrants, isTrustedAppSender } = require("../src/services/ipcGuards");

const expectedUrl = "file:///test/index.html";
const mainFrame = { url: expectedUrl }, webContents = { mainFrame };
const window = { isDestroyed: () => false, webContents };
const event = { sender: webContents, senderFrame: mainFrame };
assert.equal(isTrustedAppSender(event, window, expectedUrl), true);
assert.equal(isTrustedAppSender({ ...event, senderFrame: { url: expectedUrl } }, window, expectedUrl), false, "same URL in another frame is not trusted");
assert.equal(isTrustedAppSender(event, window, "about:blank"), false, "navigated document is not trusted");
assert.equal(isTrustedAppSender(event, { ...window, isDestroyed: () => true }, expectedUrl), false);
assert.equal(isTrustedAppSender(event, null, expectedUrl), false);

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

grants.grant("export", "C:\\out\\a.csv");
grants.grant("restore", "C:\\out\\b.slvbackup");
grants.clear();
assert.equal(grants.has("export", "C:\\out\\a.csv"), false);
assert.equal(grants.has("restore", "C:\\out\\b.slvbackup"), false);
