const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard } = require('electron');
const { openEnvironment } = require('./slv-test-environment');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'test-launcher-app-'));
// A fake prior profile, not the real Windows user's profile.
const prior = path.join(root, 'synthetic-other-profile'); fs.mkdirSync(prior);
app.setPath('userData', prior);
const environment = openEnvironment(root);
let wrongReads = 0;
const readFile = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (String(file).startsWith(prior)) { wrongReads++; throw Error('Wrong synthetic profile accessed'); }
  return readFile.call(this, file, ...args);
};
const promises = require('fs/promises'), asyncRead = promises.readFile;
promises.readFile = async function(file, ...args) {
  if (String(file).startsWith(prior)) { wrongReads++; throw Error('Wrong synthetic profile accessed'); }
  return asyncRead.call(this, file, ...args);
};
require('./slv-test-app').start(environment);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { const value = await fn(); if (value) return value; await sleep(50); } throw Error('Test launcher UI timeout'); }
async function main() {
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0]);
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  const run = code => win.webContents.executeJavaScript(code), api = code => run('window.secureLoginVault.' + code);
  await until(() => run('!!document.querySelector("#slv-test-banner")'));
  await until(() => fs.existsSync(path.join(environment.root, 'runtime.json')));
  const runtime = JSON.parse(fs.readFileSync(path.join(environment.root, 'runtime.json'), 'utf8'));
  await require('./slv-test-browser').verifyRuntime(environment, runtime.port);
  assert.match(win.getTitle(), /SLV TEST/);
  assert.equal(app.getPath('userData'), environment.paths.app);
  assert.equal(app.getPath('sessionData'), environment.paths.session);
  assert.equal(process.env.SLV_PIPE_USER, environment.pipeUser);
  assert.equal((await api('auth.getState()')).hasVault, false);
  const password = 'Synthetic manual testing password';
  assert.equal((await api(`auth.createVault(${JSON.stringify({masterPassword:password,confirmPassword:password})})`)).ok, true);
  assert.equal((await api(`credentials.add(${JSON.stringify({websiteName:'Dummy only',websiteUrl:'https://example.test',username:'synthetic',password:'Dummy-only-password'})})`)).ok, true);
  assert.equal((await api('importExport.pickImportFile()')).ok, false);
  assert.equal((await api('settings.getDesktopIntegration()')).result.startupSupported, false);
  await clipboard.writeText('dummy clipboard'); assert.equal(await clipboard.readText(), 'dummy clipboard');
  await api('auth.lockVault()');
  assert.equal((await api(`auth.unlockVault({masterPassword:${JSON.stringify(password)}})`)).ok, true);
  assert.equal((await api('credentials.getAll()')).result.length, 1);
  assert.equal(wrongReads, 0); assert.deepEqual(fs.readdirSync(prior), []);
  console.log('PASS empty isolated launch, persistent TEST banner, dummy create/lock/unlock, blocked imports/startup, fake clipboard and zero reads/writes to synthetic other profile');
  app.quit();
}
setTimeout(() => { console.error('Test launcher timeout'); app.exit(1); }, 30000).unref();
main().catch(error => { console.error(error); app.exit(1); });
