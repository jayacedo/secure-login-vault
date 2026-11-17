const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'export-protection-app-'));
for (const name of ['userData', 'sessionData', 'temp', 'logs']) {
  const directory = path.join(root, name); fs.mkdirSync(directory); app.setPath(name, directory);
}
app.setPath('appData', root); process.env.APPDATA = root; process.env.LOCALAPPDATA = root;
process.env.SLV_PIPE_USER = `export-protection-${process.pid}`;
clipboard.readText = clipboard.writeText = clipboard.clear = () => { throw Error('Real clipboard forbidden'); };
dialog.showOpenDialog = async () => ({ canceled: true });
let selected = null, calls = 0;
dialog.showSaveDialog = async () => { calls++; return selected ? { canceled: false, filePath: selected } : { canceled: true }; };
require('../src/services/browserSetup').createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
const crypto = require('crypto'), originalScrypt = crypto.scrypt;
let hashHook = callback => callback();
crypto.scrypt = (...args) => hashHook(() => originalScrypt(...args));
// Deterministic OS state for this isolated synthetic profile only.
require('electron').powerMonitor.getSystemIdleState = () => 'active';
require('../src/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0;i<150;i++) { if(await fn()) return; await sleep(60); } throw Error('Export UI timeout'); }

async function main() {
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false);
  if(win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  const run = code => win.webContents.executeJavaScript(code);
  const api = code => run('window.secureLoginVault.' + code);
  let pw = 'Synthetic export UI password';
  const created = await api('auth.createVault('+JSON.stringify({masterPassword:pw,confirmPassword:pw})+')'); assert.equal(created.ok, true, created.message);
  await run('initAuth();setPref(PREF_BACKGROUND_LOCK,"off");startAutoLockWatcher();applyTheme("coffee");');
  const row = {websiteName:'Synthetic, export',websiteUrl:'https://example.test/login',username:'dummy',password:'dummy,"value\nonly',notes:'Synthetic notes',category:'Other'};
  assert.equal((await api('credentials.add('+JSON.stringify(row)+')')).ok, true);
  const call = (method, data) => api('importExport.'+method+'('+JSON.stringify(data)+')');
  const authorize = async (format = 'csv') => {
    const res = await call('authorizeExport',{masterPassword:pw,format}); assert.equal(res.ok,true,res.message); return res.result.token;
  };
  const pick = (token,format='csv') => call('pickExportPath',{token,format,defaultName:'synthetic.'+format});
  const write = (token,format='csv',filePath=selected) => call('writeExportFile',{token,format,filePath,content:'renderer must not control export contents'});
  selected = path.join(root,'synthetic.csv');
  assert.equal((await pick()).ok,false); assert.equal(calls,0);
  assert.equal((await write()).ok,false); assert.equal(fs.existsSync(selected),false);
  assert.equal((await call('authorizeExport',{masterPassword:'wrong synthetic',format:'csv'})).ok,false);
  let token = await authorize(); assert.equal((await pick(token,'json')).ok,false);
  assert.equal((await pick(token)).ok,true);
  assert.equal((await write(token,'csv',selected+'other')).ok,false);
  assert.equal((await write(token)).ok,false, 'failed consume cannot be reused');
  token = await authorize(); await pick(token);
  const saved = await write(token); assert.equal(saved.ok,true,saved.message); assert.equal(saved.result.count,1);
  assert.match(fs.readFileSync(selected,'utf8'), /"dummy,""value\nonly"/);
  assert.ok(!fs.readFileSync(selected,'utf8').includes('renderer must not'));
  assert.equal((await write(token)).ok,false);
  selected = path.join(root,'synthetic.json'); token = await authorize('json'); await pick(token,'json');
  assert.equal((await write(token,'json')).ok,true);
  assert.equal(JSON.parse(fs.readFileSync(selected,'utf8')).credentials[0].password,row.password);

  selected = path.join(root,'synthetic.slvbackup');
  assert.equal((await call('pickExportPath',{format:'backup',defaultName:'synthetic.slvbackup'})).ok,true);
  assert.equal((await write(undefined)).ok,false,'backup grant cannot write plaintext');
  assert.equal((await call('createBackup',{filePath:selected})).ok,true,'encrypted backup needs no fresh password');
  assert.ok(!fs.readFileSync(selected).includes(Buffer.from(row.password)));
  token = await authorize(); selected = null; await pick(token);
  assert.equal((await write(token,'csv',path.join(root,'cancelled.csv'))).ok,false);

  // Hold successful password verification; cancellation must prevent late approval.
  let releaseHash;
  hashHook = callback => { releaseHash = callback; };
  const pending = call('authorizeExport',{masterPassword:pw,format:'csv'});
  await until(()=>releaseHash); await call('cancelExport'); releaseHash(); hashHook = callback => callback();
  assert.equal((await pending).ok,false);

  releaseHash = null; hashHook = callback => { releaseHash = callback; };
  const lockedHash = call('authorizeExport',{masterPassword:pw,format:'csv'});
  await until(()=>releaseHash); await api('auth.lockVault()'); releaseHash(); hashHook = callback => callback();
  assert.equal((await lockedHash).ok,false);
  assert.equal((await api('auth.unlockVault('+JSON.stringify({masterPassword:pw})+')')).ok,true);

  // Lock after staging a plaintext file: no final output or leftover staging file.
  selected = path.join(root,'locked.csv'); token = await authorize(); await pick(token);
  const originalWrite = fsp.writeFile; let releaseWrite;
  fsp.writeFile = async (...args) => {
    const result = await originalWrite(...args);
    if(String(args[0]).startsWith(selected+'.')) await new Promise(resolve=>{releaseWrite=resolve;});
    return result;
  };
  const exporting = write(token); await until(()=>releaseWrite);
  await api('auth.lockVault()'); releaseWrite(); fsp.writeFile = originalWrite;
  assert.equal((await exporting).ok,false); assert.equal(fs.existsSync(selected),false);
  assert.equal(fs.readdirSync(root).some(name=>name.startsWith('locked.csv.')),false);
  assert.equal((await api('auth.unlockVault('+JSON.stringify({masterPassword:pw})+')')).ok,true);
  await run('initAuth()');

  selected = path.join(root,'stale.csv'); token = await authorize(); await pick(token);
  win.webContents.reload();
  await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  assert.equal((await write(token)).ok,false,'reload invalidates approval');
  token = await authorize(); await pick(token);
  const nextPassword = 'Synthetic export updated master password';
  const changed = await api('settings.changeMasterPassword('+JSON.stringify({currentPassword:pw,newPassword:nextPassword,confirmPassword:nextPassword})+')');
  assert.equal(changed.ok,true,changed.message); pw=nextPassword;
  assert.equal((await write(token)).ok,false,'password change invalidates approval');

  // Modal clears secrets and warns before invoking the native save dialog.
  await run('openSettingsModal();runExportFlow("csv",document.querySelector("[data-export=csv]"))');
  assert.match(await run('document.querySelector("#plaintext-export-overlay").textContent'),/unencrypted passwords/);
  win.show(); win.setSize(1100,780); await sleep(150);
  fs.writeFileSync(path.join(root,'export-confirmation.png'),(await win.webContents.capturePage()).toPNG());
  await run('document.querySelector("#plaintext-export-password").value="wrong synthetic";document.querySelector("#plaintext-export-confirm").click()');
  await until(()=>run('document.querySelector("#plaintext-export-status").textContent.includes("incorrect")'));
  assert.equal(await run('document.querySelector("#plaintext-export-password").value'), '');
  selected = path.join(root,'ui.csv');
  await run('document.querySelector("#plaintext-export-password").value='+JSON.stringify(pw)+';document.querySelector("#plaintext-export-confirm").click()');
  await until(()=>run('!document.querySelector("#plaintext-export-overlay")'));
  assert.equal(fs.existsSync(selected),true);
  await run('runExportFlow("json");document.querySelector("#plaintext-export-password").value="dummy";document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal(await run('!!document.querySelector("#plaintext-export-overlay")'),false);
  await run('runExportFlow("json");handleLockVault()');
  assert.equal(await run('!!document.querySelector("#plaintext-export-overlay")'),false);
  console.log('PASS synthetic export IPC/UI: password, binding, replay, format fidelity, backup separation, cancellation during hashing, lock during write, warning and password cleanup. Fixture: '+root);
  app.exit(0);
}
setTimeout(()=>{console.error('Export integration timeout');app.exit(1);},90000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
