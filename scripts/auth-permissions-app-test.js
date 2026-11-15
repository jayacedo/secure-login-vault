// Automated synthetic-only checks. No installed vault, browser profile or OS clipboard access.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog, session } = require('electron');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'auth-permissions-'));
for (const name of ['userData', 'sessionData', 'temp', 'logs']) {
  const target = path.join(root, name); fs.mkdirSync(target); app.setPath(name, target);
}
app.setPath('appData', root);
process.env.LOCALAPPDATA = root; process.env.APPDATA = root;
process.env.SLV_PIPE_USER = 'auth-permissions-' + process.pid;
clipboard.readText = async () => { throw Error('OS clipboard reads forbidden in this test'); };
clipboard.writeText = async () => { throw Error('OS clipboard writes forbidden in this test'); };
clipboard.clear = () => { throw Error('OS clipboard clearing forbidden in this test'); };
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
dialog.showSaveDialog = async () => ({ canceled: true });
require('../src/services/browserSetup').createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
let time = 1800000000000;
const storeModule = require('../src/services/vaultStore'), create = storeModule.createVaultStore;
storeModule.createVaultStore = target => { assert.equal(target, path.join(root, 'userData')); return create(target, { now: () => time }); };
const permissions = require('../src/services/sessionPermissions'), apply = permissions.applySessionPermissions;
const policies = new Map();
permissions.applySessionPermissions = (ses, options) => {
  const policy = {}; policies.set(ses, policy);
  apply({
    setPermissionCheckHandler(fn) { policy.check = fn; ses.setPermissionCheckHandler(fn); },
    setPermissionRequestHandler(fn) { policy.request = fn; ses.setPermissionRequestHandler(fn); }
  }, options);
};
require('../src/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n = 0; n < 150; n++) { const result = await fn(); if (result) return result; await sleep(50); } throw Error('Synthetic app timed out'); }
function denied(policy, contents, url) {
  for (const permission of ['clipboard-read', 'media', 'geolocation', 'notifications', 'usb']) {
    const details = { isMainFrame: true, requestingUrl: url };
    assert.equal(policy.check(contents, permission, 'file://', details), false);
    let result; policy.request(contents, permission, value => { result = value; }, details);
    assert.equal(result, false);
  }
}
async function main() {
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0]);
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  const run = code => win.webContents.executeJavaScript(code), api = code => run('window.secureLoginVault.' + code);
  assert.equal((await api('auth.getState()')).hasVault, false);
  const mainPolicy = policies.get(session.defaultSession);
  denied(mainPolicy, win.webContents, win.webContents.getURL());
  assert.equal(mainPolicy.check(win.webContents, 'clipboard-sanitized-write', 'file://', { isMainFrame: true, requestingUrl: win.webContents.getURL() }), true);
  for (const name of ['geolocation', 'clipboard-read']) {
    assert.equal(await run(`navigator.permissions.query({name:${JSON.stringify(name)}}).then(p=>p.state)`), 'denied');
  }
  assert.equal(await run("navigator.permissions.query({name:'clipboard-write'}).then(p=>p.state)"), 'granted');
  const password = 'Synthetic permissions master password';
  assert.equal((await api(`auth.createVault(${JSON.stringify({ masterPassword: password, confirmPassword: password })})`)).ok, true);
  await api('auth.lockVault()');
  for (let n = 0; n < 3; n++) assert.equal((await api("auth.unlockVault({masterPassword:'wrong synthetic password'})")).ok, false);
  const blocked = await api(`auth.unlockVault({masterPassword:${JSON.stringify(password)}})`);
  assert.equal(blocked.ok, false); assert.match(blocked.message, /Try again in 1 second/);
  assert.equal((await api('auth.getState()')).isUnlocked, false);
  time += 1000;
  assert.equal((await api(`auth.unlockVault({masterPassword:${JSON.stringify(password)}})`)).ok, true);
  const save = require('../src/services/browserSavePrompt').showSaveLoginPrompt({ parent: win, host: 'example.test', username: 'dummy', groups: [], categories: ['Other'], activeGroup: '', timeoutMs: 5000 });
  const prompt = await until(() => BrowserWindow.getAllWindows().find(w => w !== win && policies.has(w.webContents.session) && w.webContents.session !== session.defaultSession));
  denied(policies.get(prompt.webContents.session), prompt.webContents, prompt.webContents.getURL());
  assert.equal(policies.get(prompt.webContents.session).check(prompt.webContents, 'clipboard-sanitized-write', '', { isMainFrame: true, requestingUrl: prompt.webContents.getURL() }), false);
  prompt.destroy(); await save;
  console.log('PASS real desktop IPC cooldown/reset, browser permission query results, allowed main-page Copy permission and denied save-dialog permissions; no OS clipboard used');
  app.quit();
}
setTimeout(() => app.exit(1), 30000).unref();
main().catch(error => { console.error(error); app.exit(1); });
