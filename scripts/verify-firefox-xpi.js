// Only the explicitly supplied extension artifact and generated public source.
// No extraction, browser profile, installed app or vault access.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { execFileSync } = require('child_process');

const filename = 'secure-login-vault-firefox.xpi';
const sha256 = '3f6df50323213cf7f337ddbc7d3b5ac1f1f454e02981ab100584c1af1b7ccb4a';
const signatures = ['META-INF/cose.manifest', 'META-INF/cose.sig', 'META-INF/manifest.mf', 'META-INF/mozilla.sf', 'META-INF/mozilla.rsa'];
function assertPinnedXpi(file) {
  const { assertNoLinkedParents } = require('./package-content-policy');
  assertNoLinkedParents(file);
  const stat = fs.statSync(file);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size < 2 * 1024 * 1024, 'Invalid Firefox XPI size');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sha256, 'Firefox XPI differs from the reviewed artifact');
}

function verifyFirefoxXpi(file, source) {
  assertPinnedXpi(file);
  const data = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'inspect-firefox-xpi.ps1'), '-XpiPath', file], { encoding: 'utf8', windowsHide: true }));
  const expected = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  assert.deepEqual(data.manifest, expected, 'Signed Firefox manifest must match the current generated manifest');
  const { policy } = require('./package-content-policy');
  assert.deepEqual(data.entries.map(e => e.name).sort(), [...policy.extension, ...signatures].sort(), 'Unexpected or missing XPI entries');
  for (const entry of data.entries) {
    if (entry.name === 'manifest.json' || signatures.includes(entry.name)) continue;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, entry.name))).digest('hex');
    assert.equal(entry.sha256.toLowerCase(), hash, 'Signed Firefox payload is stale: ' + entry.name);
  }
  // Mozilla's cryptographic signature is checked by Firefox during installation.
  return { version: expected.version, sha256, payloadFiles: policy.extension.length };
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  console.log('PASS pinned Firefox XPI and current source: ' + JSON.stringify(verifyFirefoxXpi(path.join(root, 'browser-addons', filename), path.join(root, 'dist/firefox'))));
}
module.exports = { filename, sha256, assertPinnedXpi, verifyFirefoxXpi };
