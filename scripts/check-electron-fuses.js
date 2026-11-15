const assert = require('assert/strict');
const path = require('path');
const { getCurrentFuseWire, FuseVersion, FuseV1Options } = require('@electron/fuses');

// Independent expectations: a weakened build config must not weaken this gate.
async function checkElectronFuses(executable) {
  const wire = await getCurrentFuseWire(executable);
  assert.equal(wire.version, FuseVersion.V1, 'Unsupported Electron fuse version');
  const expected = {
    RunAsNode: true, // Browser native helper currently requires plain Node mode.
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true
  };
  for (const [name, enabled] of Object.entries(expected)) {
    assert.equal(wire[FuseV1Options[name]], enabled ? 49 : 48, `Unexpected Electron fuse: ${name}`);
  }
  return expected;
}
if (require.main === module) {
  checkElectronFuses(path.resolve(__dirname, '../release/win-unpacked/Secure Login Vault.exe'))
    .then(result => console.log('PASS packaged Electron fuses: ' + JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { checkElectronFuses };
