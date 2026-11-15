// Disposable minimal app only. Never starts SLV or discovers an installed profile.
const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { build, Platform, Arch } = require('electron-builder');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const { checkElectronFuses } = require('./check-electron-fuses');
const { testTempRoot } = require('./testTemp');
const { assertPrivateTree } = require('./slv-test-environment');

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), 'fuse-probe-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const resultPath = path.join(root, 'result.json');
  const injectedPath = path.join(root, 'injected.txt');
  const poison = path.join(root, 'poison.js');
  const options = require('../package.json');
  await fs.writeFile(poison, `require('fs').writeFileSync(${JSON.stringify(injectedPath)}, 'injected');`);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: 'slv-synthetic-fuse-probe', version: '1.0.0', main: 'main.js',
    description: 'Generated synthetic fuse probe', author: 'SLV test', license: 'UNLICENSED'
  }));
  const mainCode = `const { app } = require('electron');
    const fs = require('fs'), path = require('path');
    for (const name of ['userData','sessionData','temp','logs']) {
      const dir = path.join(${JSON.stringify(root)}, name); fs.mkdirSync(dir,{recursive:true}); app.setPath(name,dir);
    }
    app.whenReady().then(() => {
      fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({marker:'synthetic-fuse-probe', inspector:require('inspector').url() || null}));
      app.quit();
    });`;
  await fs.writeFile(path.join(source, 'main.js'), mainCode);
  await build({ projectDir: source, targets: Platform.WINDOWS.createTarget('dir', Arch.x64), publish: 'never', config: {
    appId: 'test.slv.fuse-probe', productName: 'SLV Synthetic Fuse Probe',
    electronVersion: options.devDependencies.electron,
    electronDist: path.resolve(__dirname, '../node_modules/electron/dist'),
    directories: { output: path.join(root, 'build') },
    files: ['main.js', 'package.json'], asar: true, npmRebuild: false,
    electronFuses: options.build.electronFuses,
    win: { icon: path.resolve(__dirname, '../assets/icon.ico') }
  } });
  const appDir = path.join(root, 'build/win-unpacked');
  const executable = path.join(appDir, 'SLV Synthetic Fuse Probe.exe');
  await checkElectronFuses(executable);
  // Confirm the reader gate actually rejects a weakened executable.
  const weakened = path.join(root, 'weakened.exe');
  await fs.copyFile(executable, weakened);
  await flipFuses(weakened, { version: FuseVersion.V1, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true });
  await assert.rejects(checkElectronFuses(weakened), /EnableNodeOptions/);
  await fs.unlink(weakened);
  const env = { ...process.env, APPDATA: root, LOCALAPPDATA: root, TEMP: root, TMP: root,
    NODE_OPTIONS: `--require "${poison}"`, NODE_EXTRA_CA_CERTS: path.join(root, 'absent-cert.pem') };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = (args = [], overrides = {}) => execFile(executable, [...(overrides.ELECTRON_RUN_AS_NODE ? [] : ['--noerrdialogs']), ...args], {
    env: { ...env, ...overrides }, cwd: root, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024
  });
  await run(['--inspect=0']);
  assert.deepEqual(JSON.parse(await fs.readFile(resultPath)), { marker: 'synthetic-fuse-probe', inspector: null });
  await assert.rejects(fs.access(injectedPath), { code: 'ENOENT' });
  await fs.unlink(resultPath);
  // Test the actual launcher: desktop fuses alone do not cover Node mode.
  const helperProbe = path.join(root, 'helper-probe.js');
  await fs.writeFile(helperProbe, `process.stdout.write(JSON.stringify({node:true,inspector:require('inspector').url() || null}));`);
  const launcher = path.join(root, 'helper-probe.bat');
  await fs.writeFile(launcher, require('../src/native-host/registration').buildLauncher({ runtimePath: executable, hostScriptPath: helperProbe }));
  // Caller arguments follow the fixed script path, so --inspect is not a runtime flag.
  const helper = await execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" --inspect=0"`], {
    env, cwd: root, windowsHide: true, windowsVerbatimArguments: true, timeout: 20000
  });
  assert.deepEqual(JSON.parse(helper.stdout), { node: true, inspector: null });
  await assert.rejects(fs.access(injectedPath), { code: 'ENOENT' });
  // Modify just a byte of the synthetic main file, leaving the ASAR header hash intact.
  const archive = path.join(appDir, 'resources/app.asar');
  const original = await fs.readFile(archive);
  const tampered = Buffer.from(original);
  const mainOffset = original.indexOf(Buffer.from(mainCode));
  assert.ok(mainOffset > 0, 'synthetic main source exists in archive body');
  const offset = tampered.indexOf(Buffer.from('synthetic-fuse-probe', 'utf8'), mainOffset);
  assert.ok(offset > 0); tampered[offset] = 'X'.charCodeAt(0);
  await fs.writeFile(archive, tampered);
  let rejected = false;
  try { await run(); } catch (error) { assert.equal(Boolean(error.killed), false, 'tamper check must exit, not time out'); rejected = true; }
  assert.ok(rejected, 'modified ASAR must be rejected');
  await assert.rejects(fs.access(resultPath), { code: 'ENOENT' });
  await fs.writeFile(archive, original);
  // An unpacked resources/app directory must not take priority over app.asar.
  const fallback = path.join(appDir, 'resources/app');
  await fs.mkdir(fallback);
  await fs.writeFile(path.join(fallback, 'package.json'), JSON.stringify({main:'main.js'}));
  await fs.writeFile(path.join(fallback, 'main.js'), `require('fs').writeFileSync(${JSON.stringify(injectedPath)},'fallback');require('electron').app.quit();`);
  await run();
  await assert.rejects(fs.access(injectedPath), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(resultPath)).marker, 'synthetic-fuse-probe');
  console.log('PASS fuse readback, weakened-binary rejection, desktop NODE_OPTIONS/inspector blocking, scrubbed helper launcher, ASAR tamper rejection and unpacked fallback exclusion');
  // Only remove this generated test tree, after checking its location and links.
  assert.equal(path.dirname(root), path.resolve(testTempRoot())); assertPrivateTree(root);
  await fs.rm(root, { recursive: true, force: true });
}
main().catch(error => { console.error(error); process.exit(1); });
