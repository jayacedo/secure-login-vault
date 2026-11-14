const assert=require("assert/strict"),fs=require("fs"),path=require("path");
const {app,BrowserWindow}=require("electron");
const {testTempRoot}=require("./testTemp");
const root=fs.mkdtempSync(path.join(testTempRoot(),"stability-app-"));
app.setPath("userData",root);process.env.SLV_PIPE_USER=`stability-${process.pid}`;
require(path.join(process.env.SLV_TEST_CODE_ROOT || path.join(__dirname,".."),"src/main"));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await sleep(50);}throw Error("Stability UI timed out");}
async function main(){
  await app.whenReady();await until(()=>BrowserWindow.getAllWindows().length);
  const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);win.show();win.focus();
  if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once("did-finish-load",resolve));
  const run=code=>win.webContents.executeJavaScript(code),api=code=>run(`window.secureLoginVault.${code}`),click=selector=>run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key=(value,ctrl=false,shift=false)=>run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(value)},ctrlKey:${ctrl},shiftKey:${shift},bubbles:true,cancelable:true}))`);
  const pw="Synthetic stability master password";
  await api(`auth.createVault(${JSON.stringify({masterPassword:pw,confirmPassword:pw})})`);
  for(let i=0;i<32;i++)assert.equal((await api(`credentials.add(${JSON.stringify({websiteName:`Synthetic ${String(i).padStart(2,"0")}`,websiteUrl:i%2?"":"https://example.test/login",username:"dummy",password:"Synthetic password",category:"Other",favorite:i%2===0})})`)).ok,true);
  await run("initAuth()");await until(()=>run("document.querySelectorAll('.credential-row-item').length===32"));await run("refreshCredentials()");
  const before=(await api("credentials.getAllForExport()")).result;
  win.setSize(1100,780);win.focus();await until(()=>run("document.hasFocus()"));
  await run("document.querySelector('.credential-table').focus()");await key("f",true);assert.equal(await run("document.activeElement.id"),"credential-search");
  await run("document.querySelector('#credential-search').value='Synthetic 00';document.querySelector('#credential-search').dispatchEvent(new Event('input'))");await until(()=>run("document.querySelectorAll('.credential-row-item').length===1"));
  await key("Escape");await until(()=>run("document.querySelectorAll('.credential-row-item').length===32"));
  await run("document.querySelector('#open-help-btn').focus()");await click("#open-help-btn");assert.equal(await run("document.activeElement.id"),"faq-search-input","Help starts at search");
  await run("document.querySelector('#faq-search-input').value='Actions >';document.querySelector('#faq-search-input').dispatchEvent(new Event('input'))");
  assert(await run("[...document.querySelectorAll('.faq-item')].some(item=>item.style.display!=='none' && item.textContent.includes('Actions > Move to group'))"));
  await run("document.querySelector('#help-done-btn').focus()");await key("Tab");assert.equal(await run("document.activeElement.id"),"help-close-btn");await key("Tab",false,true);assert.equal(await run("document.activeElement.id"),"help-done-btn");
  await key("Escape");assert.equal(await run("document.activeElement.id"),"open-help-btn");
  await key(",",true);await until(()=>run("document.querySelector('#settings-modal-overlay')?.classList.contains('is-open')"));
  await click("#settings-tab-about");await run("document.querySelector('#settings-open-help-btn').focus()");await click("#settings-open-help-btn");await key("Escape");
  assert.equal(await run("document.activeElement.id"),"settings-open-help-btn");assert.equal(await run("document.querySelector('#settings-modal-overlay').classList.contains('is-open')"),true);
  await run("closeSettingsModal();document.querySelector('.credential-table').focus()");await key("n",true);await until(()=>run("document.querySelector('#credential-modal-overlay')?.classList.contains('is-open')"));await key("Escape");
  // One sequence combines filters, sorting, hidden selections and Favorites Undo.
  await run("document.querySelector('#credential-quick-filter').value='uncategorized';document.querySelector('#credential-quick-filter').dispatchEvent(new Event('change'));document.querySelector('#credential-sort').value='website-asc';document.querySelector('#credential-sort').dispatchEvent(new Event('change'))");
  await click("#bulk-select-toggle");await run("document.querySelector('#bulk-selection-search').value='00';document.querySelector('#bulk-selection-search').dispatchEvent(new Event('input'))");await click("#bulk-select-all");
  await run("document.querySelector('#bulk-selection-search').value='01';document.querySelector('#bulk-selection-search').dispatchEvent(new Event('input'))");await click("#bulk-select-all");await click("#bulk-show-selected");assert.equal(await run("document.querySelectorAll('.credential-row-item:not([hidden])').length"),2);
  await click("#bulk-actions-toggle");await click("#bulk-favorite-add");await until(()=>run("document.querySelectorAll('#bulk-move-review li').length===2 && !document.querySelector('#bulk-move-confirm').disabled"));await click("#bulk-move-confirm");await until(()=>run("!!document.querySelector('#bulk-undo-btn') && !document.querySelector('#bulk-move-overlay')"));await click("#bulk-undo-btn");await until(()=>run("!document.querySelector('#bulk-undo-btn')"));
  const after=(await api("credentials.getAllForExport()")).result;
  const fields=entries=>entries.map(({updatedAt,...entry})=>entry).sort((a,b)=>a.id-b.id);assert.deepEqual(fields(after),fields(before),"combined flow and Undo preserve original account fields");
  await run("document.querySelector('.credential-table').scrollTop=1000");await until(()=>run("!document.querySelector('#back-to-top').hidden"));
  await run("renderClientVault(_lastAuthState)");await sleep(100);assert.equal(await run("document.querySelector('#back-to-top').hidden"),true,"Back to top resets on a fresh workspace");
  await run("renderDashboard(_lastAuthState)");await until(()=>run("document.querySelectorAll('.credential-row-item').length===32"));await run("document.querySelector('.credential-table').focus()");await key("l",true);await until(()=>run("!!document.querySelector('#unlock-vault-form')"));
  assert.equal((await api("credentials.getAll()")).ok,false);assert.equal(await run("bulkSelectedIds.size"),0);
  await api(`auth.unlockVault({masterPassword:${JSON.stringify(pw)}})`);await run("initAuth()");await until(()=>run("document.querySelectorAll('.credential-row-item').length===32"));assert.equal(await run("document.querySelector('#credential-quick-filter').value"),"all");
  console.log("PASS synthetic stability sequence: shortcuts, Help search/focus/Tab/Escape, Settings return, filter/sort/selection/Favorites Undo, workspace scroll reset and lock/unlock");app.exit(0);
}
setTimeout(()=>{console.error("Stability UI timeout");app.exit(1);},90000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
