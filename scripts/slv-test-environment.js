// Developer-only environment. No installed-app or real browser profile discovery.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPipeName } = require('../src/native-host/pipeName');
const { assertExtensionSource, policy, assertNoLinkedParents } = require('./package-content-policy');
const PROJECT = path.resolve(__dirname, '..');
const PURPOSE = 'SLV isolated synthetic testing v1';

function assertPrivateTree(root) {
  assertNoLinkedParents(root);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
        throw Error('Test environment contains a linked or unsupported path. Stopping.');
      }
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root);
}

function openEnvironment(project = PROJECT) {
  project = path.resolve(project);
  assertNoLinkedParents(project);
  const root = path.join(project, '.slv-test');
  const marker = path.join(root, 'environment.json');
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root); // No recursive creation and no reuse of an unmarked directory.
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }
    });
    fs.writeFileSync(marker, JSON.stringify({ purpose: PURPOSE, root,
      id: crypto.randomBytes(16).toString('hex'), publicKey: publicKey.toString('base64') }), { flag: 'wx' });
  }
  assertPrivateTree(root);
  const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (saved.purpose !== PURPOSE || saved.root !== root || !/^[a-f0-9]{32}$/.test(saved.id) || typeof saved.publicKey !== 'string') {
    throw Error('Invalid test environment marker. Refusing to use any other profile.');
  }
  crypto.createPublicKey({ key: Buffer.from(saved.publicKey, 'base64'), type: 'spki', format: 'der' });
  const digest = crypto.createHash('sha256').update(Buffer.from(saved.publicKey, 'base64')).digest('hex').slice(0, 32);
  const extensionId = digest.replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  const pipeUser = 'slv-test-' + saved.id;
  if (getPipeName(pipeUser) === getPipeName()) throw Error('Test connection collision. Stopping.');
  const paths = {};
  for (const name of ['app', 'session', 'logs', 'temp', 'browser', 'extension', 'native-host']) {
    paths[name] = path.join(root, name); fs.mkdirSync(paths[name], { recursive: true });
  }
  return { root, paths, pipeUser, pipeName: getPipeName(pipeUser), extensionId,
    publicKey: saved.publicKey, hostName: 'com.securelogin.vault.test_' + saved.id };
}

function prepareBrowserBundle(environment, runtimePath) {
  assertPrivateTree(environment.root);
  assertExtensionSource(PROJECT);
  for (const name of policy.extension) {
    const target = path.join(environment.paths.extension, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(PROJECT, 'extension', name), target);
  }
  const manifestPath = path.join(environment.paths.extension, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.name = 'SLV TEST — Dummy logins only'; manifest.key = environment.publicKey;
  manifest.action.default_title = 'SLV TEST';
  manifest.description = 'Isolated test helper. Never connects to the regular SLV vault.';
  manifest.optional_host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // Keep permission requests and dynamic content-script registration local too.
  const productionHosts = '["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]';
  for (const name of ['offerSettings.js', 'inlineSettings.js', 'saveOffers.js', 'inlineFill.js']) {
    const target = path.join(environment.paths.extension, name);
    const source = fs.readFileSync(target, 'utf8');
    if (!source.includes(productionHosts)) throw Error('Test permission template changed. Stopping.');
    fs.writeFileSync(target, source.replaceAll(productionHosts, '["http://127.0.0.1/*"]'));
  }
  const statusPath = path.join(environment.paths.extension, 'status.js');
  const status = fs.readFileSync(statusPath, 'utf8');
  if (!status.includes('"com.securelogin.vault"')) throw Error('Test helper template changed. Stopping.');
  fs.writeFileSync(statusPath, status.replace('"com.securelogin.vault"', JSON.stringify(environment.hostName)));
  const popupPath = path.join(environment.paths.extension, 'popup.html');
  fs.writeFileSync(popupPath, fs.readFileSync(popupPath, 'utf8').replaceAll('Secure Login Vault', 'SLV TEST'));
  const hostScriptPath = path.join(environment.paths['native-host'], 'test-host.js');
  // Fixed pipe and test extension ID, independent of inherited environment variables.
  fs.writeFileSync(hostScriptPath, `const {runHost}=require(${JSON.stringify(path.join(PROJECT, 'src/native-host/hostRelay'))});
runHost({stdin:process.stdin,stdout:process.stdout,argv:process.argv.slice(2),
pipeName:${JSON.stringify(environment.pipeName)},allowedExtensionIds:[${JSON.stringify(environment.extensionId)}],allowedFirefoxIds:[],
exit(code){process.exitCode=code;process.stdin.destroy();setTimeout(()=>process.exit(code),1000).unref();}});
`);
  const registration = require('../src/native-host/registration');
  return { installDir: environment.paths['native-host'], runtimePath, hostScriptPath,
    hostName: environment.hostName, allowedExtensionIds: [environment.extensionId],
    browsers: registration.BROWSERS.filter(browser => browser.id !== 'firefox') };
}

module.exports = { PROJECT, PURPOSE, openEnvironment, assertPrivateTree, prepareBrowserBundle };
