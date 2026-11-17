const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'unlock-layout-app-'));
for (const name of ['userData', 'sessionData', 'temp', 'logs']) {
 const directory = path.join(root, name); fs.mkdirSync(directory); app.setPath(name, directory);
}
app.setPath('appData', root); process.env.APPDATA = root; process.env.LOCALAPPDATA = root;
process.env.SLV_PIPE_USER = `unlock-layout-${process.pid}`;
clipboard.readText = clipboard.writeText = clipboard.clear = () => { throw Error('Real clipboard forbidden'); };
let selectedSyntheticFile = null;
dialog.showOpenDialog = async () => selectedSyntheticFile ? { canceled: false, filePaths: [selectedSyntheticFile] } : { canceled: true };
dialog.showSaveDialog = async () => ({ canceled: true });
require('../src/services/browserSetup').createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
require('../src/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for(let i=0;i<100;i++){if(await fn())return;await sleep(80);}throw Error('CSV UI timeout'); }

async function main() {
 await app.whenReady(); await until(()=>BrowserWindow.getAllWindows().length);
 const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);
 if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
 const run=code=>win.webContents.executeJavaScript(code), api=code=>run('window.secureLoginVault.'+code);
 const password='Synthetic layout test password';
 assert.equal((await api('auth.createVault('+JSON.stringify({masterPassword:password,confirmPassword:password,hint:'Synthetic hint only'})+')')).ok,true);
 await run('initAuth()');
 await run('setPref(PREF_BRAND_NAME,"Demo Vault");setPref(PREF_BACKGROUND_LOCK,"off");applyBranding();startAutoLockWatcher();');
 assert.equal(await run('getUnlockLayout()'),'floating');
 await run('applyTheme("forest");openSettingsModal()');
 win.setMinimumSize(980,640);win.setSize(1180,820);win.show();win.focus();
 await run('document.querySelector(".unlock-layout-settings").scrollIntoView({block:"center"})');await sleep(200);
 fs.writeFileSync(path.join(root,'settings.png'),(await win.webContents.capturePage()).toPNG());
 assert.equal(await run('document.querySelectorAll("[data-unlock-layout]").length'),3);
 for(const layout of ['minimal','floating','compact']) {
  await run('document.querySelector("[data-unlock-layout='+layout+']").click()');
  assert.equal(await run('getUnlockLayout()'),layout);
  assert.equal(await run('document.querySelectorAll("[data-unlock-layout][aria-pressed=true]").length'),1);
  await run('document.querySelector("#unlock-layout-preview-btn").focus();document.querySelector("#unlock-layout-preview-btn").click()');
  assert.equal(await run('!!document.querySelector("#unlock-layout-preview .unlock-layout-'+layout+'")'),true);
  assert.equal(await run('document.querySelector("#unlock-layout-preview input").disabled'),true);
  if(layout==='floating'){await sleep(200);fs.writeFileSync(path.join(root,'preview.png'),(await win.webContents.capturePage()).toPNG());}
  assert.equal(await run('document.querySelector("#unlock-layout-preview").textContent.includes("Synthetic hint only")'),false);
  assert.equal((await api('auth.getState()')).isUnlocked,true);
  assert.equal(await run('document.querySelector("#unlock-layout-preview .unlock-brand-name strong").textContent'),'Demo Vault');
  await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal(await run('document.querySelector("#unlock-layout-preview")===null'),true);
  assert.equal(await run('document.activeElement.id'),'unlock-layout-preview-btn');
 }
 await run('closeSettingsModal()');
 await run('setPref(UNLOCK_LAYOUT_KEY,"unknown");');
 assert.equal(await run('getUnlockLayout()'),'floating');
 await run('setPref(UNLOCK_LAYOUT_KEY,"floating");');
 // Reload only this isolated renderer and confirm persistence.
 await win.webContents.reload();await until(()=>!win.webContents.isLoading());await until(()=>run('document.body.classList.contains("app-ready")'));
 assert.equal(await run('getUnlockLayout()'),'floating');
 await run('handleLockVault()');
 assert.equal((await api('auth.getState()')).isUnlocked,false);
 win.setMinimumSize(320,400);win.setSize(460,640);win.show();win.focus();
 for(const layout of ['minimal','floating','compact']) {
  await run('setPref(UNLOCK_LAYOUT_KEY,"'+layout+'");renderFromState({hasVault:true,isUnlocked:false,compactUnlock:true,passwordHint:"Synthetic hint only",hasRecoveryKey:true});');
  assert.equal(await run('!!document.querySelector("#unlock-vault-form")'),true);
  await run('document.querySelector("#show-hint-btn").click()');
  assert.equal(await run('document.querySelector("#hint-text").hidden'),false);
  await run('document.querySelector("#show-hint-btn").click()');
  await run('document.querySelector(".password-toggle").click()');
  assert.equal(await run('document.querySelector("#master-password").type'),'text');
  await run('document.querySelector(".password-toggle").click()');
  for(const theme of ['light','dark','coffee','breeze','forest']) {
   await run('applyTheme("'+theme+'");applyTextSize("large")');
   win.setSize(360,620);await sleep(30);
   assert.equal(await run('document.documentElement.scrollWidth<=window.innerWidth+1'),true,layout+' '+theme+' must fit horizontally');
  }
  win.setSize(460,640);await run('applyTheme("forest");applyTextSize("default")');await sleep(80);
  fs.writeFileSync(path.join(root,layout+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 // Exercise the real submit handler with a synthetic vault, not just a mock form.
 await run('document.querySelector("#master-password").value='+JSON.stringify(password)+';document.querySelector("#unlock-vault-form").requestSubmit()');
 await until(async()=> (await api('auth.getState()')).isUnlocked);
 await until(()=>run('document.body.classList.contains("is-dashboard")'));
 await run('openSettingsModal();');await run('openUnlockLayoutPreview()');
 await run('handleLockVault()');
 assert.equal(await run('document.querySelector("#unlock-layout-preview")===null'),true);
 console.log('PASS unlock layouts: preference persistence, themes, narrow/large text, inert preview, focus return, hint/reveal, real synthetic unlock and lock cleanup. Screenshots: '+root);
 app.exit(0);
}
setTimeout(()=>{console.error('Unlock layout test timeout');app.exit(1)},60000).unref();
main().catch(error=>{console.error(error);app.exit(1)});
