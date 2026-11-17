const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'group-delete-app-'));
for (const name of ['userData', 'sessionData', 'temp', 'logs']) {
 const directory = path.join(root, name); fs.mkdirSync(directory); app.setPath(name, directory);
}
app.setPath('appData', root); process.env.APPDATA = root; process.env.LOCALAPPDATA = root;
process.env.SLV_PIPE_USER = `group-delete-${process.pid}`;
clipboard.readText = clipboard.writeText = clipboard.clear = () => { throw Error('Real clipboard forbidden'); };
let selectedSyntheticFile = null;
dialog.showOpenDialog = async () => selectedSyntheticFile ? { canceled: false, filePaths: [selectedSyntheticFile] } : { canceled: true };
dialog.showSaveDialog = async () => ({ canceled: true });
require('../src/services/browserSetup').createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
require('../src/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for(let i=0;i<100;i++){if(await fn())return;await sleep(80);}throw Error('CSV UI timeout'); }

async function main(){
 await app.whenReady();await until(()=>BrowserWindow.getAllWindows().length);
 const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);
 if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
 const run=code=>win.webContents.executeJavaScript(code).catch(error=>{console.error('Synthetic test step failed:',code);throw error;}),api=code=>run('window.secureLoginVault.'+code);
 const pw='Synthetic group UI password';
 assert.equal((await api('auth.createVault('+JSON.stringify({masterPassword:pw,confirmPassword:pw})+')')).ok,true);
 await run('initAuth();setPref(PREF_BACKGROUND_LOCK,"off");startAutoLockWatcher();applyTheme("coffee");');
 for(const name of ['Source','Destination','Unassigned'])await api('groups.add('+JSON.stringify(name)+')');
 const row={websiteName:'Synthetic login',password:'dummy-secret',groupName:'Source',category:'Other'};
 await api('credentials.add('+JSON.stringify(row)+')');
 await api('groups.setActive("Source")');
 const open=async()=>{await run('openManageGroupsModal()');await run('document.querySelector("[data-action=delete-group][data-name=Source]").click()');};
 await open();
 assert.equal(await run('document.querySelector("#delete-group-confirm-btn").disabled'),true);
 assert.equal(await run('Array.from(document.querySelector("#delete-group-reassign-select").options).filter(o=>o.value==="group:Source").length'),0);
 assert.equal(await run('Array.from(document.querySelector("#delete-group-reassign-select").options).filter(o=>o.value==="group:Unassigned").length'),1,'actual group named Unassigned remains distinct');
 await run('document.querySelector("#delete-group-cancel-btn").click()');
 assert.equal((await api('groups.getAll()')).result.includes('Source'),true);
 await open();
 await run('document.querySelector("#delete-group-reassign-select").value="group:Destination";document.querySelector("#delete-group-reassign-select").dispatchEvent(new Event("change"))');
 assert.equal(await run('document.querySelector("#delete-group-confirm-btn").disabled'),false);
 assert.match(await run('document.querySelector("#delete-group-destination-note").textContent'),/become active/);
 win.show();win.setSize(1100,780);await sleep(180);
 fs.writeFileSync(path.join(root,'move-and-delete.png'),(await win.webContents.capturePage()).toPNG());
 await run('document.querySelector("#delete-group-confirm-btn").click()');
 await until(()=>run('!document.querySelector("#group-delete-modal-overlay").classList.contains("is-open")'));
 assert.equal((await api('groups.getActive()')).result,'Destination');
 assert.equal((await api('credentials.getAllForExport()')).result[0].groupName,'Destination');
 await until(()=>run('!!document.querySelector("[data-action=delete-group][data-name=Destination]")'));
 await run('document.querySelector("[data-action=delete-group][data-name=Destination]").click()');
 await run('document.querySelector("#delete-group-reassign-select").value="unassigned";document.querySelector("#delete-group-reassign-select").dispatchEvent(new Event("change"))');
 await run('document.querySelector("#delete-group-confirm-btn").click()');
 await until(()=>run('!document.querySelector("#group-delete-modal-overlay").classList.contains("is-open")'));
 assert.equal((await api('groups.getActive()')).result,'');
 assert.equal((await api('credentials.getAllForExport()')).result[0].groupName,'');
 await api('groups.add("Source")');await api('credentials.add('+JSON.stringify(row)+')');
 await open();
 await api('credentials.add('+JSON.stringify({...row,websiteName:'Late synthetic'})+')');
 await run('document.querySelector("#delete-group-reassign-select").value="unassigned";document.querySelector("#delete-group-reassign-select").dispatchEvent(new Event("change"));document.querySelector("#delete-group-confirm-btn").click()');
 await until(()=>run('document.querySelector("#delete-group-status").textContent.includes("count changed")'));
 assert.equal((await api('groups.getAll()')).result.includes('Source'),true);
 await run('handleLockVault()');
 assert.equal(await run('document.querySelector("#group-delete-modal-overlay")===null && document.querySelector("#groups-modal-overlay")===null'),true);
 console.log('PASS group deletion UI: explicit selection, cancel, move, Unassigned, active filter, stale count rejection and lock cleanup. Screenshot: '+root);
 app.exit(0);
}
setTimeout(()=>{console.error('Group UI timeout');app.exit(1)},60000).unref();
main().catch(error=>{console.error(error);app.exit(1)});
