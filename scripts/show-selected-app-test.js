const assert = require("assert/strict"), fs = require("fs"), path = require("path");
const {app, BrowserWindow} = require("electron");
const {testTempRoot} = require("./testTemp");
const root = fs.mkdtempSync(path.join(testTempRoot(), "show-selected-app-"));
app.setPath("userData", root); process.env.SLV_PIPE_USER = `show-selected-${process.pid}`;
require(path.join(process.env.SLV_TEST_CODE_ROOT || path.join(__dirname, ".."), "src/main"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0;i<150;i++) { if(await fn()) return; await sleep(50); } throw Error("Show selected UI timed out"); }
async function main() {
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show(); win.focus();
  if(win.webContents.isLoading()) await new Promise(resolve => win.webContents.once("did-finish-load",resolve));
  const run = code => win.webContents.executeJavaScript(code), api = code => run(`window.secureLoginVault.${code}`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const find = value => run(`document.querySelector('#bulk-selection-search').value=${JSON.stringify(value)};document.querySelector('#bulk-selection-search').dispatchEvent(new Event('input'))`);
  const visible = () => run("[...document.querySelectorAll('.credential-row-item:not([hidden])')].map(row=>Number(row.dataset.id))");
  const password = "Synthetic selected view master password";
  assert.equal((await api(`auth.createVault(${JSON.stringify({masterPassword:password,confirmPassword:password})})`)).ok,true);
  await api('groups.add("Source")'); await api('groups.add("Destination")');
  const ids=[];
  for(const name of ["Alpha","Beta","Gamma"]) {
    const result=await api(`credentials.add(${JSON.stringify({websiteName:name,websiteUrl:"https://example.test/login",username:"dummy",password:"Synthetic dummy password",groupName:"Source",category:"Other"})})`);
    assert.equal(result.ok,true); ids.push(result.result.id);
  }
  const [a,b,g]=ids;
  const before=JSON.stringify((await api("credentials.getAllForExport()")).result);
  await api('groups.setActive("Source")'); await run("initAuth()");
  await until(()=>run("document.querySelectorAll('.credential-row-item').length===3")); await run("refreshCredentials()");
  await run("document.querySelector('#credential-sort').value='website-asc';document.querySelector('#credential-sort').dispatchEvent(new Event('change'))");
  await click("#bulk-select-toggle"); await find("Alpha"); await click("#bulk-select-all");
  await find("Beta"); await click("#bulk-select-all");
  assert.deepEqual(await visible(),[b]);
  await click("#bulk-show-selected"); assert.deepEqual(await visible(),[a,b]);
  assert.equal(await run("document.querySelector('#bulk-show-selected').getAttribute('aria-pressed')"),"true");
  assert.equal(await run("document.querySelector('#bulk-selection-search').disabled"),true);
  assert.equal(await run("document.querySelector('#bulk-selection-search').value"),"Beta");
  assert.equal(await run("document.querySelector('#bulk-selection-count').textContent"),"2 selected");
  assert.equal(await run("document.querySelector('#credential-count-label').textContent"),"2 selected shown");
  // Sorting keeps the selected view and pending selection intact.
  await click('[data-credential-sort="website"]'); assert.deepEqual(await visible(),[b,a]);
  await click("#bulk-show-selected"); assert.deepEqual(await visible(),[b]);
  assert.equal(await run("document.querySelector('#bulk-selection-search').disabled"),false);
  await click("#bulk-show-selected");
  // Keyboard focus follows an unchecked row, then returns to the toggle at zero.
  await run(`document.querySelector('[data-select-credential="${b}"]').focus()`);
  await click(`[data-select-credential="${b}"]`); assert.deepEqual(await visible(),[a]);
  assert.equal(await run("document.activeElement.dataset.selectCredential"),String(a));
  await click(`[data-select-credential="${a}"]`); assert.deepEqual(await visible(),[]);
  assert.equal(await run("document.activeElement.id"),"bulk-show-selected");
  assert.equal(await run("document.querySelector('#bulk-move-btn').disabled && document.querySelector('#bulk-category-btn').disabled && document.querySelector('#bulk-select-all').disabled"),true);
  assert.equal(await run("document.querySelector('#credential-filter-empty').textContent"),"No entries selected. Turn off Show selected to choose logins.");
  await click("#bulk-show-selected"); assert.deepEqual(await visible(),[b]);
  await find(""); await click("#bulk-select-all"); await click("#bulk-show-selected");
  await click("#bulk-select-all"); assert.deepEqual(await visible(),[]);
  assert.equal(await run("document.activeElement.id"),"bulk-show-selected");
  // A selected-only review includes exactly the choices left after unchecking.
  await click("#bulk-show-selected"); await click(`[data-select-credential="${a}"]`); await click(`[data-select-credential="${g}"]`);
  await find("no matches"); await click("#bulk-show-selected"); assert.deepEqual(await visible(),[g,a]);
  for(const kind of ["move","category"]) {
    await click(kind==="move"?"#bulk-move-btn":"#bulk-category-btn");
    await until(()=>run("document.querySelector('#bulk-move-target')?.disabled===false"));
    const target=kind==="move"?"Destination":"API";
    await run(`document.querySelector('#bulk-move-target').value=${JSON.stringify(target)};document.querySelector('#bulk-move-target').dispatchEvent(new Event('change'))`);
    await click("#bulk-move-confirm");
    await until(()=>run("document.querySelectorAll('#bulk-move-review li').length===2"));
    const review=await run("document.querySelector('#bulk-move-review').textContent");
    assert(review.includes("Alpha") && review.includes("Gamma") && !review.includes("Beta"));
    await click("#bulk-move-cancel"); assert.deepEqual(await visible(),[g,a]);
  }
  win.setSize(1100,780); await run("document.documentElement.setAttribute('data-theme','dark');document.documentElement.setAttribute('data-palette','coffee')");
  await sleep(150); fs.writeFileSync(path.join(root,"show-selected-coffee.png"),(await win.webContents.capturePage()).toPNG());
  await click("#bulk-selection-cancel");
  assert.equal(await run("bulkShowSelected || bulkSelectedIds.size || document.querySelector('#bulk-selection-search').disabled"),false);
  // A quick-filter change and a refresh both clear the selected-only view.
  await click("#bulk-select-toggle"); await click("#bulk-select-all"); await click("#bulk-show-selected");
  await run("document.querySelector('#credential-quick-filter').value='uncategorized';document.querySelector('#credential-quick-filter').dispatchEvent(new Event('change'))");
  assert.equal(await run("bulkShowSelected || bulkSelectionEnabled || bulkSelectedIds.size"),0);
  await click("#bulk-select-toggle"); await click("#bulk-select-all"); await click("#bulk-show-selected");
  await run("refreshCredentials()"); assert.equal(await run("bulkShowSelected"),false);
  await click("#bulk-select-toggle"); await click("#bulk-select-all"); await click("#bulk-show-selected");
  await run("handleLockVault()"); await api(`auth.unlockVault({masterPassword:${JSON.stringify(password)}})`); await run("initAuth()");
  await until(()=>run("document.querySelectorAll('.credential-row-item').length===3")); await run("refreshCredentials()");
  assert.equal(await run("bulkShowSelected || bulkSelectionEnabled || bulkSelectedIds.size"),0);
  assert.equal(JSON.stringify((await api("credentials.getAllForExport()")).result),before,"selection and cancelled reviews do not write entries");
  console.log(`PASS synthetic Show selected: gathers hidden selections, pauses/restores Find, sorting, uncheck/focus, zero state, select-all, group/category review, cancel/filter/refresh/lock reset and unchanged entries\nScreenshot: ${root}`);
  app.exit(0);
}
setTimeout(()=>{console.error("Show selected test timeout");app.exit(1);},60000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
