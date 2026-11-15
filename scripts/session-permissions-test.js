const assert = require('assert/strict');
const { applySessionPermissions } = require('../src/services/sessionPermissions');
const pageUrl = 'file:///synthetic-only/index.html';
const contents = { getURL: () => pageUrl, mainFrame: { url: pageUrl } };
const window = { isDestroyed: () => false, webContents: contents };
function capture(options) {
  let check, request;
  applySessionPermissions({ setPermissionCheckHandler(fn) { check = fn; }, setPermissionRequestHandler(fn) { request = fn; } }, options);
  return (wc, permission, details) => {
    const result = check(wc, permission, 'file://', details);
    let requested; request(wc, permission, value => { requested = value; }, details);
    assert.equal(requested, result); return result;
  };
}
const check = capture({ getMainWindow: () => window, pageUrl });
const details = { isMainFrame: true, requestingUrl: pageUrl };
assert.equal(check(contents, 'clipboard-sanitized-write', details), true);
for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'geolocation', 'notifications', 'usb', 'serial', 'hid', 'fileSystem', 'unknown']) {
  assert.equal(check(contents, permission, details), false);
}
assert.equal(check(null, 'clipboard-sanitized-write', details), false);
assert.equal(check({ ...contents }, 'clipboard-sanitized-write', details), false);
assert.equal(check(contents, 'clipboard-sanitized-write', { ...details, isMainFrame: false }), false);
assert.equal(check(contents, 'clipboard-sanitized-write', { ...details, requestingUrl: 'https://example.test' }), false);
assert.equal(check(contents, 'clipboard-sanitized-write', undefined), false);
contents.mainFrame.url = 'https://example.test';
assert.equal(check(contents, 'clipboard-sanitized-write', details), false);
contents.mainFrame.url = pageUrl; window.isDestroyed = () => true;
assert.equal(check(contents, 'clipboard-sanitized-write', details), false);
assert.equal(capture()(contents, 'clipboard-sanitized-write', details), false);
console.log('PASS permission checks and requests deny devices, reads, subframes, other windows and navigated documents; only exact main-page clipboard writes allowed');
