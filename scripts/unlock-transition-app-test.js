// Only a newly generated synthetic vault/profile is opened by this test.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog, powerMonitor } = require('electron');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'unlock-transition-app-'));
for (const name of ['userData', 'sessionData', 'temp', 'logs']) {
  const directory = path.join(root, name); fs.mkdirSync(directory); app.setPath(name, directory);
}
app.setPath('appData', root);
for (const name of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) process.env[name] = root;
process.env.SLV_PIPE_USER = `unlock-transition-${process.pid}`;
clipboard.readText = clipboard.writeText = clipboard.clear = () => { throw Error('Real clipboard forbidden'); };
dialog.showOpenDialog = dialog.showSaveDialog = async () => ({ canceled: true });
powerMonitor.getSystemIdleState = () => 'active';
require('../src/services/browserSetup').createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
let trayAvailable = true;
let desktop;
require('../src/services/desktopIntegration').createDesktopIntegration = options => {
  desktop = options;
  return {
    load: async () => {}, refresh() {}, hasTray: () => trayAvailable,
    shouldStartHidden: () => false, status: () => ({}), handleClose() {}, dispose() {}, beginQuit() {},
    hideLocked() { options.lockVault('cancel'); options.getWindow().hide(); return true; }
  };
};
let dataGate = null, failData = false, dataEntered = false;
const storeModule = require('../src/services/vaultStore');
const createStore = storeModule.createVaultStore;
storeModule.createVaultStore = (base, ...rest) => {
  assert.equal(base, path.join(root, 'userData'));
  const store = createStore(base, ...rest);
  const read = store.getDashboardData;
  store.getDashboardData = async (...args) => {
    dataEntered = true;
    if (dataGate) await dataGate;
    if (failData) throw Error('Synthetic read failure');
    return read(...args);
  };
  return store;
};
require('../src/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label = 'condition') {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(40); }
  throw Error('Timed out: ' + label);
}
async function main() {
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  const run = code => win.webContents.executeJavaScript(code);
  const api = code => run('window.secureLoginVault.' + code);
  const password = 'Synthetic transition test password!';
  assert.equal((await api('auth.createVault(' + JSON.stringify({ masterPassword: password, confirmPassword: password }) + ')')).ok, true);
  for (let i = 0; i < 12; i++) {
    assert.equal((await api('credentials.add(' + JSON.stringify({ websiteName: `Demo ${i}`, websiteUrl: 'https://example.test/login', username: 'dummy-user', password: 'Dummy-only-42!', category: 'Other' }) + ')')).ok, true);
  }
  await run('initAuth()');
  await run('setPref(PREF_BACKGROUND_LOCK,"off");startAutoLockWatcher();');
  await until(() => run('document.querySelectorAll("#credential-list-body .credential-row").length===12'));
  win.setSize(1180, 760); win.show(); win.focus();
  const submit = (value = password) => run('document.querySelector("#master-password").value=' + JSON.stringify(value) + ';document.querySelector("#unlock-vault-form").requestSubmit()');
  const locked = async () => {
    await run('handleLockVault()');
    await until(() => run('!!document.querySelector("#unlock-vault-form")'));
  };
  const ready = () => until(() => run('document.body.classList.contains("is-dashboard") && !document.body.classList.contains("unlock-presenting") && document.body.classList.contains("app-ready")'), 'visible dashboard');
  const record = () => run(`window.transitionFrames=[];window.recordTransition=true;
    function transitionFrame(){if(!window.recordTransition)return;
      const visible=getComputedStyle(document.querySelector('#app-shell')).visibility==='visible';
      window.transitionFrames.push({visible,width:innerWidth,unlock:!!document.querySelector('#unlock-vault-form'),dashboard:document.body.classList.contains('is-dashboard'),rows:document.querySelectorAll('#credential-list-body .credential-row').length,total:document.querySelector('#summary-total')?.textContent});
      requestAnimationFrame(transitionFrame);}requestAnimationFrame(transitionFrame);`);
  const checkFrames = async compact => {
    await sleep(70);
    const frames = await run('window.recordTransition=false;window.transitionFrames');
    assert.ok(frames.some(frame => frame.visible && frame.dashboard), 'dashboard must become visible');
    assert.ok(!frames.some(frame => frame.visible && frame.dashboard && (frame.rows !== 12 || frame.total !== '12')), 'no empty/zero-count dashboard frame');
    if (compact) assert.ok(!frames.some(frame => frame.visible && frame.unlock && frame.width > 600), 'no stretched unlock form frame');
  };
  await locked();
  await submit('Definitely wrong synthetic password');
  await until(() => run('!document.querySelector("#unlock-vault-form button[type=submit]").disabled'));
  assert.equal((await api('auth.getState()')).isUnlocked, false);
  assert.ok(win.getBounds().width < 600);
  assert.equal((await api('auth.presentDashboard({token:"bad",backgroundColor:"#12161e"})')).ok, false);
  for (const theme of ['dark', 'light', 'forest']) {
    await run('applyTheme(' + JSON.stringify(theme) + ')');
    await record(); await submit(); await ready(); await checkFrames(true);
    assert.equal(win.getBounds().width, 1180);
    assert.equal(win.getBackgroundColor().toLowerCase(), await run('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toLowerCase()'));
    assert.equal((await api('auth.presentDashboard({token:"replay",backgroundColor:"#12161e"})')).ok, false);
    await locked();
  }
  let release;
  dataEntered = false; dataGate = new Promise(resolve => { release = resolve; });
  await record(); await submit(); await until(() => dataEntered, 'delayed data read');
  await sleep(120);
  assert.ok(win.getBounds().width < 600, 'stay compact until data is ready');
  assert.equal(await run('document.querySelector("#master-password").value'), '');
  assert.equal(await run('document.querySelector("#unlock-vault-form button[type=submit]").textContent'), 'Opening vault…');
  const pending = await api('auth.getState()');
  assert.equal((await api('auth.presentDashboard(' + JSON.stringify({ token: pending.unlockPresentationToken, backgroundColor: 'invalid' }) + ')')).ok, false);
  release(); dataGate = null; await ready(); await checkFrames(true);
  // Cancel during the delayed read; a late completion cannot reopen the dashboard.
  await locked(); dataEntered = false; dataGate = new Promise(resolve => { release = resolve; });
  await submit(); await until(() => dataEntered);
  await run('document.querySelector("#unlock-cancel-btn").click()');
  await until(() => !win.isVisible());
  release(); dataGate = null;
  await until(() => !win.webContents.isLoading());
  await until(() => run('document.body.classList.contains("app-ready") && !!document.querySelector("#unlock-vault-form")'));
  assert.equal((await api('auth.getState()')).isUnlocked, false);
  assert.equal(await run('document.body.classList.contains("is-dashboard")'), false);
  assert.equal((await api('auth.presentDashboard(' + JSON.stringify({ token: pending.unlockPresentationToken, backgroundColor: '#12161e' }) + ')')).ok, false);
  win.show(); win.focus();
  await run('setPref(PREF_BACKGROUND_LOCK,"off");startAutoLockWatcher();');
  // A failed initial read returns to a usable locked form.
  failData = true; await submit();
  await until(() => run('document.querySelector("#form-message")?.textContent.includes("dashboard could not")'));
  assert.equal((await api('auth.getState()')).isUnlocked, false);
  assert.equal(await run('document.body.classList.contains("unlock-presenting")'), false);
  failData = false;
  // Lock after staging, before reveal (during the renderer's animation-frame wait).
  await run(`window.lockDuringStage=true;const observer=new MutationObserver(()=>{
    if(window.lockDuringStage && document.body.classList.contains('is-dashboard') && document.body.classList.contains('unlock-presenting')){
      window.lockDuringStage=false;observer.disconnect();handleLockVault();}
  });observer.observe(document.body,{attributes:true,attributeFilter:['class']});`);
  await submit();
  await until(() => run('window.lockDuringStage===false && !!document.querySelector("#unlock-vault-form")'));
  assert.equal((await api('auth.getState()')).isUnlocked, false);
  assert.equal(await run('document.body.classList.contains("unlock-presenting")'), false);
  // Non-tray/full-size unlock and maximized restoration.
  trayAvailable = false; await api('auth.getState()');
  await record(); await submit(); await ready(); await checkFrames(false);
  trayAvailable = true; win.maximize(); await until(() => win.isMaximized());
  await locked(); await record(); await submit(); await ready(); await checkFrames(true);
  await until(() => win.isMaximized());
  await locked();
  console.log('PASS unlock transition: themed ready frames, slow/failed loads, wrong password, cancel/lock races, stale tokens, normal/maximized bounds. Synthetic profile: ' + root);
  app.exit(0);
}
setTimeout(() => { console.error('Unlock transition test timeout'); app.exit(1); }, 90000).unref();
main().catch(error => { console.error(error); app.exit(1); });
