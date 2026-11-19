// Fresh synthetic profile only; never open the installed app, clipboard or browser.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog, powerMonitor } = require('electron');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'onboarding-app-'));
console.log('Synthetic onboarding profile: '+root);
for (const name of ['userData','sessionData','temp','logs']) {
  const dir=path.join(root,name); fs.mkdirSync(dir); app.setPath(name,dir);
}
app.setPath('appData',root);
for(const name of ['APPDATA','LOCALAPPDATA','TEMP','TMP']) process.env[name]=root;
process.env.SLV_PIPE_USER='onboarding-'+process.pid;
powerMonitor.getSystemIdleState=()=> 'active';
clipboard.readText=clipboard.writeText=clipboard.clear=()=>{throw Error('Real clipboard forbidden');};
dialog.showOpenDialog=dialog.showSaveDialog=async()=>{throw Error('Guide must not open a file picker');};
let setups=0;
require('../src/services/browserSetup').createBrowserSetup=()=>({
  status:async()=>({supported:false,ready:false,message:'Synthetic test helper'}),
  setup:async()=>{setups++;throw Error('Guide must not register a helper');}
});
require('../src/main');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn) {for(let i=0;i<160;i++){if(await fn())return;await sleep(80);}throw Error('Onboarding UI timeout');}
async function main() {
  await app.whenReady(); await until(()=>BrowserWindow.getAllWindows().length);
  const win=BrowserWindow.getAllWindows()[0];
  if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  const run=code=>win.webContents.executeJavaScript(code);
  const api=code=>run('window.secureLoginVault.'+code);
  win.webContents.setBackgroundThrottling(false);
  const pass='Synthetic guide password 42!';
  await run('setPref(PREF_BACKGROUND_LOCK,"off");setPref(PREF_AUTO_LOCK,"0");window.guideCspFailures=[];document.addEventListener("securitypolicyviolation",e=>guideCspFailures.push(e.violatedDirective));');
  await until(()=>run('!!document.querySelector("#create-vault-form")'));
  await run(`document.querySelector('#master-password').value=${JSON.stringify(pass)};document.querySelector('#confirm-password').value=${JSON.stringify(pass)};document.querySelector('#master-password').dispatchEvent(new Event('input'));document.querySelector('#confirm-password').dispatchEvent(new Event('input'));document.querySelector('#create-vault-form').requestSubmit();`);
  await until(()=>run('!!document.querySelector("#recovery-key-screen")'));
  assert.equal(await run('!!document.querySelector("#getting-started-overlay")'),false,'guide must wait for recovery-key acknowledgement');
  await run('document.querySelector("#recovery-saved-check").click();document.querySelector("#recovery-done-btn").click()');
  await until(()=>run('!!document.querySelector("#getting-started-overlay")'));
  win.setMinimumSize(980,640);win.setSize(1180,820);win.show();win.focus();
  const click=id=>run(`document.querySelector('#${id}').click()`);
  async function step(index) {await until(()=>run(`gettingStartedGuide?.index===${index} && !gettingStartedGuide.busy`));await sleep(100);}
  await step(0);
  assert.equal(await run('appShell.inert'),true);
  await click('getting-started-next');await step(1);
  assert.equal(await run('gettingStartedGuide.target.id'),'add-credential-btn');
  await run('applyTheme("forest")');await sleep(100);
  fs.writeFileSync(path.join(root,'add-login.png'),(await win.webContents.capturePage()).toPNG());
  await click('getting-started-next');await step(2);
  assert.equal(await run('document.querySelector("#settings-panel-browsers").hidden'),false);
  assert.equal(await run('document.querySelector("#extension-installation").open'),true);
  assert.equal(await run('document.querySelector("#settings-modal-overlay").inert'),true);
  fs.writeFileSync(path.join(root,'browser.png'),(await win.webContents.capturePage()).toPNG());
  await click('getting-started-next');await step(3);
  assert.equal(await run('document.querySelector("#settings-panel-data").hidden'),false);
  assert.equal(await run('gettingStartedGuide.target.id'),'auto-backup-choose');
  for(const theme of ['light','dark','coffee','breeze','forest']) {
    await run(`applyTheme('${theme}');applyTextSize('large')`);
    for(const size of [[980,640],[1400,900]]) {
      win.setSize(...size);await sleep(120);
      assert.equal(await run(`(()=>{const r=document.querySelector('.getting-started-balloon').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;})()`),true,theme+' coach fits resize');
    }
  }
  await click('getting-started-back');await step(2);
  await click('getting-started-next');await step(3);
  await click('getting-started-next');await step(4);
  await run('document.querySelector("#getting-started-next").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}))');
  assert.equal(await run('document.activeElement.id'),'getting-started-skip');
  await click('getting-started-next');
  assert.equal(await run('!!gettingStartedGuide'),false);
  assert.equal(await run('appShell.inert'),false);
  assert.equal(await run('getPref(GETTING_STARTED_KEY)'),'done');
  await run('openHelpModal()');await click('help-restart-guide');await step(0);
  await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');
  assert.equal(await run('getPref(GETTING_STARTED_KEY)'),'off');
  await run('activeSettingsSection="general";openSettingsModal()');
  await until(()=>run('!!document.querySelector("#getting-started-enabled")'));
  assert.equal(await run('document.querySelector("#getting-started-enabled").checked'),false);
  await click('getting-started-enabled');await step(0);
  await click('getting-started-next');await step(1);
  // Lock while the asynchronous Settings step is opening; it must not reappear.
  await click('getting-started-next');
  await run('handleLockVault()');await sleep(350);
  assert.equal(await run('!!document.querySelector("#getting-started-overlay")'),false);
  assert.equal(await run('document.querySelector("#settings-modal-overlay").classList.contains("is-open")'),false);
  assert.equal(await run('appShell.inert'),false);
  assert.equal((await api('auth.getState()')).isUnlocked,false);
  assert.equal((await api('auth.unlockVault('+JSON.stringify({masterPassword:pass})+')')).ok,true);
  await run('initAuth()');await step(0);
  await click('getting-started-skip');
  assert.deepEqual(await run('window.guideCspFailures'),[], 'guide must preserve the strict style CSP');
  // Existing installations without the new preference never start automatically.
  await run('localStorage.removeItem(GETTING_STARTED_KEY);initAuth()');await sleep(200);
  assert.equal(await run('!!gettingStartedGuide'),false);
  await run('setPref(GETTING_STARTED_KEY,"off")');
  await win.webContents.reload();await until(()=>!win.webContents.isLoading());
  await until(()=>run('document.body.classList.contains("is-dashboard")'));
  assert.equal(await run('!!gettingStartedGuide'),false);
  assert.equal(await run('getPref(GETTING_STARTED_KEY)'),'off');
  assert.equal((await api('vault.getDashboardData()')).result.summary.totalCredentials,0);
  await run('setPref(GETTING_STARTED_KEY,"pending");activeSettingsSection="general";openSettingsModal()');
  await until(()=>run('document.querySelector("#getting-started-enabled")?.checked'));
  await click('getting-started-enabled');
  assert.equal(await run('getPref(GETTING_STARTED_KEY)'),'off');
  assert.equal(await run('!!gettingStartedGuide'),false);
  await run('applyTextSize("default");applyTheme("dark")');win.setSize(1180,820);await sleep(120);
  fs.writeFileSync(path.join(root,'guide-settings.png'),(await win.webContents.capturePage()).toPNG());
  await click('getting-started-restart');await step(0);
  await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"l",ctrlKey:true,bubbles:true,cancelable:true}))');
  await until(async()=>!(await api('auth.getState()')).isUnlocked);
  assert.equal(await run('!!gettingStartedGuide'),false,'Ctrl+L must still lock during the guide');
  assert.equal(setups,0);
  console.log('PASS onboarding: recovery ordering, steps, focus, skip/finish/restart, settings, persistence, existing-user opt-in, lock race, themes and resizing. Synthetic output: '+root);
  app.exit(0);
}
setTimeout(()=>{console.error('Onboarding timeout');app.exit(1)},90000).unref();
main().catch(error=>{console.error(error);app.exit(1)});
