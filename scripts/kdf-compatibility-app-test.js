// Actual Electron/IPC migration, restricted to an independently generated fixture.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { testTempRoot } = require('./testTemp');
const { syntheticLegacyVault } = require('./syntheticLegacyVault');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'kdf-app-'));
for (const name of ['userData', 'sessionData', 'temp', 'logs']) {
  const target = path.join(root, name); fs.mkdirSync(target); app.setPath(name, target);
}
app.setPath('appData', root);
process.env.LOCALAPPDATA = root; process.env.APPDATA = root; process.env.SLV_PIPE_USER = 'kdf-app-' + process.pid;
clipboard.readText = async () => { throw Error('Real clipboard forbidden'); };
clipboard.writeText = async () => { throw Error('Real clipboard forbidden'); };
clipboard.clear = () => { throw Error('Real clipboard forbidden'); };
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true });
require('../src/services/browserSetup').createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { const result = await fn(); if (result) return result; await sleep(50); } throw Error('Synthetic migration UI timeout'); }
async function main() {
  const password = 'Synthetic Electron migration password';
  const fixture = await syntheticLegacyVault(path.join(root, 'userData'), password, { recovery: true });
  const before = fs.readFileSync(fixture.dbPath);
  require('../src/main');
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0]);
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  const api = code => win.webContents.executeJavaScript('window.secureLoginVault.' + code);
  assert.equal((await api('auth.getState()')).isUnlocked, false);
  assert.equal((await api(`auth.unlockVault({masterPassword:${JSON.stringify(password)}})`)).ok, true);
  const auth = JSON.parse(fs.readFileSync(fixture.authPath));
  assert.equal(auth.version, 2); assert.equal(auth.keyDerivation.options.N, 131072);
  assert.equal(auth.passwordHash, undefined); assert.deepEqual(auth.keyWrap.recovery, fixture.auth.keyWrap.recovery);
  assert.deepEqual(fs.readFileSync(fixture.dbPath), before);
  assert.equal((await api('credentials.getAll()')).result[0].username, 'dummy-legacy');
  await api('auth.lockVault()');
  assert.equal((await api(`auth.unlockVault({masterPassword:${JSON.stringify(password)}})`)).ok, true);
  assert.equal((await api('credentials.getAll()')).result.length, 1);
  console.log('PASS Electron legacy unlock/migration, unchanged synthetic database/recovery key, and new-format unlock through desktop IPC');
  app.quit();
}
setTimeout(() => app.exit(1), 30000).unref();
main().catch(error => { console.error(error); app.exit(1); });
