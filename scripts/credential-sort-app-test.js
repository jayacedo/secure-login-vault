const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const {app,BrowserWindow} = require("electron");
const {testTempRoot} = require("./testTemp");
const root = fs.mkdtempSync(path.join(testTempRoot(),"credential-sort-app-"));
app.setPath("userData",root); process.env.SLV_PIPE_USER = `credential-sort-${process.pid}`;
require(path.join(process.env.SLV_TEST_CODE_ROOT || path.join(__dirname,".."),"src/main"));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn) { for(let i=0;i<150;i++){if(await fn())return;await sleep(50);} throw Error("Sorting UI timed out"); }
async function main() {
  await app.whenReady(); await until(()=>BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);win.show();win.focus();
  if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once("did-finish-load",resolve));
  const run=code=>win.webContents.executeJavaScript(code),api=code=>run(`window.secureLoginVault.${code}`);
  const click=selector=>run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const ids=()=>run("[...document.querySelectorAll('#credential-list-body .credential-row-item')].map(row=>Number(row.dataset.id))");
  const sort=value=>run(`document.querySelector('#credential-sort').value=${JSON.stringify(value)};document.querySelector('#credential-sort').dispatchEvent(new Event('change'))`);
  const pw="Synthetic sorting master password";
  assert.equal((await api(`auth.createVault(${JSON.stringify({masterPassword:pw,confirmPassword:pw})})`)).ok,true);
  const samples=[{websiteName:"Zulu",username:""},{websiteName:"Site 10",username:"beta"},{websiteName:"Site 2",username:"alpha"},
    {websiteName:"Alpha",username:"ALPHA",favorite:true},{websiteName:"Beta",email:"email@example.test"},{websiteName:"Alpha",username:"ALPHA"}];
  const created=[];
  for(const sample of samples) {
    created.push((await api(`credentials.add(${JSON.stringify({password:"Dummy password",websiteUrl:"https://example.test",...sample})})`)).result.id);
    await sleep(10);
  }
  const [z,ten,two,alpha,beta,duplicate]=created;
  const original=(await api(`credentials.getOne(${z})`)).result;
  await api(`credentials.update(${z},${JSON.stringify({...original,notes:"Synthetic later update"})})`);
  await run("initAuth()"); await until(()=>run("document.querySelectorAll('[data-select-credential]').length===6")); await run("refreshCredentials()");
  const before=JSON.stringify((await api("credentials.getAllForExport()")).result);
  assert.deepEqual(await ids(),[z,duplicate,beta,alpha,two,ten]);
  await sort("created-desc"); assert.deepEqual(await ids(),[...created].reverse());
  await click('[data-credential-sort="website"]');assert.deepEqual(await ids(),[alpha,duplicate,beta,two,ten,z]);
  assert.equal(await run("document.querySelector('[data-credential-sort=website]').parentElement.getAttribute('aria-sort')"),"ascending");
  await click('[data-credential-sort="website"]');assert.deepEqual(await ids(),[z,ten,two,beta,alpha,duplicate]);
  assert.equal(await run("document.querySelector('#credential-sort').value"),"website-desc");
  await click('[data-credential-sort="username"]');assert.deepEqual(await ids(),[alpha,duplicate,two,ten,beta,z]);
  await click('[data-credential-sort="username"]');assert.deepEqual(await ids(),[beta,ten,alpha,duplicate,two,z]);
  // Existing nodes (including checked and hidden rows) must survive sorting.
  await click("#bulk-select-toggle");await click(`[data-select-credential="${z}"]`);
  await run(`window.sortTestNode=document.querySelector('[data-id="${z}"]');document.querySelector('#bulk-selection-search').value='Alpha';document.querySelector('#bulk-selection-search').dispatchEvent(new Event('input'))`);
  await click("#bulk-select-all");
  const selection=await run("document.querySelector('#bulk-selection-count').textContent");
  await sort("website-asc");
  assert.equal(await run("document.querySelector('#bulk-selection-count').textContent"),selection);
  assert.equal(await run(`document.querySelector('[data-id="${z}"]')===window.sortTestNode && window.sortTestNode.hidden`),true);
  assert.equal(await run("document.querySelector('#bulk-selection-search').value"),"Alpha");
  await click("#bulk-selection-cancel");
  await run("searchState.query='Alpha';runSearch()");assert.deepEqual(await ids(),[alpha,duplicate,two]);
  await sort("updated-desc");assert.deepEqual(await ids(),[duplicate,alpha,two]);
  await run("searchState.query='';searchState.onlyFavorites=true;runSearch()");assert.deepEqual(await ids(),[alpha]);
  await run("searchState.onlyFavorites=false;refreshCredentials()");await sort("username-desc");
  assert.equal(JSON.stringify((await api("credentials.getAllForExport()")).result),before,"sorting never writes credential data or timestamps");
  await run("handleLockVault()");await api(`auth.unlockVault({masterPassword:${JSON.stringify(pw)}})`);await run("initAuth()");
  await until(()=>run("document.querySelectorAll('[data-select-credential]').length===6"));await run("refreshCredentials()");
  assert.equal(await run("document.querySelector('#credential-sort').value"),"username-desc");
  const reload=async()=>{const loaded=new Promise(resolve=>win.webContents.once("did-finish-load",resolve));win.reload();await loaded;await until(()=>run("document.querySelectorAll('[data-select-credential]').length===6"));await run("refreshCredentials()");};
  await reload();assert.deepEqual(await ids(),[beta,ten,alpha,duplicate,two,z]);
  win.setSize(1100,780);await run("document.documentElement.setAttribute('data-theme','dark');document.documentElement.setAttribute('data-palette','coffee')");await sleep(200);
  fs.writeFileSync(path.join(root,"sorting-coffee.png"),(await win.webContents.capturePage()).toPNG());
  await run("localStorage.setItem('slv_credential_sort','invalid-value')");await reload();
  assert.equal(await run("document.querySelector('#credential-sort').value"),"updated-desc");
  assert.deepEqual(await ids(),[z,duplicate,beta,alpha,two,ten]);
  console.log(`PASS synthetic sorting: all six orders, natural numeric/tie/blank/email handling, filters, selection/search retention, unchanged vault, lock/reload persistence and invalid preference fallback\nScreenshots: ${root}`);
  app.exit(0);
}
setTimeout(()=>{console.error("Sort UI timeout");app.exit(1);},60000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
