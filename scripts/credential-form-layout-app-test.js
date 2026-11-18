const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {app,BrowserWindow,clipboard,dialog,powerMonitor} = require('electron');
const {testTempRoot} = require('./testTemp');
const root=fs.mkdtempSync(path.join(testTempRoot(),'credential-form-layout-'));
for(const name of ['userData','sessionData','temp','logs']){const dir=path.join(root,name);fs.mkdirSync(dir);app.setPath(name,dir);}
app.setPath('appData',root);
for(const name of ['APPDATA','LOCALAPPDATA','TEMP','TMP'])process.env[name]=root;
process.env.SLV_PIPE_USER='credential-form-layout-'+process.pid;
clipboard.readText=clipboard.writeText=clipboard.clear=()=>{throw Error('Real clipboard forbidden');};
dialog.showOpenDialog=dialog.showSaveDialog=async()=>({canceled:true});
powerMonitor.getSystemIdleState=()=> 'active';
require('../src/services/browserSetup').createBrowserSetup=()=>({status:async()=>({supported:false,ready:false})});
require('../src/main');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await sleep(40);}throw Error('Credential form test timeout');}
async function main(){
 await app.whenReady();await until(()=>BrowserWindow.getAllWindows().length);
 const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);
 if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
 const run=code=>win.webContents.executeJavaScript(code),api=code=>run('window.secureLoginVault.'+code);
 const password='Synthetic layout master password!';
 assert.equal((await api('auth.createVault('+JSON.stringify({masterPassword:password,confirmPassword:password})+')')).ok,true);
 await run('initAuth();setPref(PREF_BACKGROUND_LOCK,"off");startAutoLockWatcher();applyTheme("dark")');
 await run('openCredentialModal(null)');
 assert.equal(await run('document.querySelector("#gen-panel").hidden'),true);
 assert.equal(await run('document.querySelector("#gen-preview").textContent'),'Click Generate');
 assert.equal(await run('document.querySelector("#credential-2fa-section").open'),false);
 assert.equal(await run('document.querySelector("#credential-notes-section").open'),false);
 assert.equal(await run('document.querySelector("#m-group").parentElement.parentElement===document.querySelector("#m-category").parentElement.parentElement'),true);
 await run('document.querySelector("#gen-toggle-btn").click()');
 const generated=await run('document.querySelector("#gen-preview").textContent');
 assert.equal(generated.length,20);
 await run('document.querySelector("#gen-toggle-btn").click();document.querySelector("#gen-toggle-btn").click()');
 assert.equal(await run('document.querySelector("#gen-preview").textContent'),generated,'collapse preserves generated draft');
 await run('document.querySelector("#gen-use-btn").click()');
 assert.equal(await run('document.querySelector("#m-password").value'),generated);
 assert.equal(await run('document.querySelector("#m-password").type'),'password');
 assert.equal(await run('document.querySelector("#gen-panel").hidden'),true);
 await run('document.querySelector("#m-website-name").value="Synthetic form demo";document.querySelector("#m-website-url").value="https://example.test/login";document.querySelector("#m-username").value="dummy-user";document.querySelector("#m-email").value="dummy@example.test";document.querySelector("#m-category").value="Other";document.querySelector("#m-favorite").checked=true;document.querySelector("#credential-notes-section").open=true;document.querySelector("#m-notes").value="Synthetic note";document.querySelector("#m-tags").value="synthetic, demo";document.querySelector("#credential-notes-section").open=false;');
 win.show();win.setSize(1180,820);await sleep(100);
 fs.writeFileSync(path.join(root,'add-dark.png'),(await win.webContents.capturePage()).toPNG());
 await run('submitCredentialModal(null)');
 await until(()=>run('!document.querySelector("#credential-modal-overlay.is-open")'));
 const all=(await api('credentials.getAll()')).result;assert.equal(all.length,1);
 const id=all[0].id;
 let saved=(await api('credentials.getOne('+id+')')).result;
 assert.equal(saved.password,generated);assert.equal(saved.notes,'Synthetic note');assert.equal(saved.tags,'synthetic,demo');assert.equal(saved.favorite,true);
 await run('openCredentialModal('+id+')');
 assert.equal(await run('document.querySelector("#credential-notes-section").open'),true);
 assert.equal(await run('document.querySelector("#credential-2fa-section").open'),false);
 assert.equal(await run('!!document.querySelector("#password-history")'),true);
 // A hidden, pending setup must block Save and reopen the section.
 await run('document.querySelector("#credential-2fa-section").open=true;document.querySelector("#m-qr-manual-toggle").click();document.querySelector("#m-qr-secret").value="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";document.querySelector("#m-qr-secret").dispatchEvent(new Event("input"));document.querySelector("#credential-2fa-section").open=false;submitCredentialModal('+id+')');
 assert.equal(await run('document.querySelector("#credential-2fa-section").open'),true);
 assert.equal((await api('credentials.getOne('+id+')')).result.qrCode,'');
 await run('document.querySelector("#m-qr-manual-use").click()');
 await until(()=>run('!!document.querySelector("#m-qr").value'));
 await run('document.querySelector("#credential-2fa-section").open=false;submitCredentialModal('+id+')');
 await until(()=>run('!document.querySelector("#credential-modal-overlay.is-open")'));
 await run('openCredentialModal('+id+')');
 assert.equal(await run('document.querySelector("#credential-2fa-section").open'),true);
 assert.equal(await run('document.querySelector("#credential-notes-section").open'),true);
 await run('document.querySelector("#credential-2fa-section").open=false;document.querySelector("#credential-notes-section").open=false;document.querySelector("#m-notes").value="Cancelled draft";closeCredentialModal()');
 assert.equal((await api('credentials.getOne('+id+')')).result.notes,'Synthetic note');
 await run('openCredentialModal(null)');
 for(const theme of ['light','dark','coffee','breeze','forest']){
  await run('applyTheme('+JSON.stringify(theme)+');applyTextSize("large")');
  win.setSize(980,640);await sleep(40);
  assert.equal(await run('(()=>{const m=document.querySelector("#credential-modal-overlay .modal-container");const f=m.querySelector(".modal-footer").getBoundingClientRect();return m.scrollWidth<=m.clientWidth+1 && f.bottom<=innerHeight && f.top>=0;})()'),true,'form and footer fit '+theme);
 }
 await run('applyTextSize("default");applyTheme("forest")');win.setSize(1180,820);await sleep(80);
 fs.writeFileSync(path.join(root,'add-forest.png'),(await win.webContents.capturePage()).toPNG());
 await run('closeCredentialModal();renderClientVault(_lastAuthState)');
 await run('openClientModal(null)');
 assert.equal(await run('document.querySelectorAll(".client-optional[open]").length'),0);
 assert.equal(await run('document.querySelector("#cm-quick-links-preview").hidden'),true);
 await run('applyTheme("dark")');await sleep(3100); // Let transitions and the earlier guard toast finish before capture.
 fs.writeFileSync(path.join(root,'add-client.png'),(await win.webContents.capturePage()).toPNG());
 const clientFields={name:['cm-name','Synthetic Client'],domain:['cm-domain','example.test'],category:['cm-category','Synthetic category'],
  adminUrl:['cm-admin-url','https://example.test/wp-admin'],adminUsername:['cm-admin-username','dummy-admin'],adminPassword:['cm-admin-password','  Dummy admin only!  '],
  hostingProvider:['cm-hosting-provider','Synthetic host'],hostingUrl:['cm-hosting-url','https://host.example.test'],hostingUsername:['cm-hosting-username','dummy-host'],hostingPassword:['cm-hosting-password','Dummy host only!'],
  ftpHost:['cm-ftp-host','ftp.example.test'],ftpPort:['cm-ftp-port','22'],ftpUsername:['cm-ftp-username','dummy-ftp'],ftpPassword:['cm-ftp-password','Dummy ftp only!'],
  dbHost:['cm-db-host','db.example.test'],dbName:['cm-db-name','synthetic_db'],dbUsername:['cm-db-username','dummy-db'],dbPassword:['cm-db-password','Dummy db only!'],phpMyAdminUrl:['cm-pma-url','https://db.example.test'],
  registrar:['cm-registrar','Synthetic registrar'],domainExpiry:['cm-domain-expiry','2030-06-15'],sslExpiry:['cm-ssl-expiry','2030-01-10'],notes:['cm-notes','Synthetic client notes'],qrCode:['cm-qr',(await api('credentials.getOne('+id+')')).result.qrCode]};
 await run('for(const [id,value] of '+JSON.stringify(Object.values(clientFields))+'){document.getElementById(id).value=value;}document.querySelector("#cm-favorite").checked=true;updateQuickLinksPreview();');
 assert.equal(await run('document.querySelector("#cm-quick-links-preview").hidden'),false);
 // All sections stay collapsed during Save: hidden fields must still round-trip.
 await run('submitClientModal(null)');
 const clients=(await api('clients.getAll()')).result;assert.equal(clients.length,1);
 const clientId=clients[0].id;
 const checkClient=async()=>{const entry=(await api('clients.getOne('+clientId+')')).result;for(const [key,[,value]] of Object.entries(clientFields))assert.equal(entry[key],value,'client preserves '+key);assert.equal(entry.favorite,true);};
 await checkClient();await run('openClientModal('+clientId+')');
 assert.equal(await run('document.querySelectorAll(".client-optional[open]").length'),7);
 await run('document.querySelectorAll(".client-optional").forEach(s=>s.open=false);submitClientModal('+clientId+')');
 await checkClient();await run('openClientModal('+clientId+')');
 await run('document.querySelector("#cm-qr-manual-toggle").click();document.querySelector("#cm-qr-secret").value="GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";document.querySelector("#cm-qr-secret").dispatchEvent(new Event("input"));document.querySelector("#client-2fa-section").open=false;submitClientModal('+clientId+')');
 assert.equal(await run('document.querySelector("#client-2fa-section").open'),true,'pending client 2FA is visible');
 await run('document.querySelector("#cm-notes").value="Cancelled client draft";closeClientModal()');await checkClient();
 await run('openClientModal(null)');
 for(const theme of ['light','dark','coffee','breeze','forest']){
  await run('applyTheme('+JSON.stringify(theme)+');applyTextSize("large")');win.setSize(980,640);await sleep(40);
  for(const expanded of [false,true]){
   await run('document.querySelectorAll(".client-optional").forEach(s=>s.open='+expanded+')');
   assert.equal(await run('(()=>{const m=document.querySelector("#client-modal-overlay .modal-container");const f=m.querySelector(".modal-footer").getBoundingClientRect();return m.scrollWidth<=m.clientWidth+1 && f.bottom<=innerHeight && f.top>=0;})()'),true,'client form and fixed footer fit '+theme);
  }
 }
 await run('handleLockVault()');
 assert.equal(await run('!!document.querySelector("#m-password")'),false,'lock removes draft fields');
 assert.equal(await run('!!document.querySelector("#cm-admin-password")'),false,'lock removes client draft fields');
 console.log('PASS login/client forms: collapsed defaults, generator use/preservation, complete synthetic save/edit round trips, edit expansion, 2FA pending guards, cancel/lock cleanup and themed size checks. Synthetic fixture: '+root);
 app.exit(0);
}
setTimeout(()=>{console.error('Credential form test timeout');app.exit(1);},60000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
