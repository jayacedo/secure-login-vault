const assert = require("assert/strict"), fs = require("fs"), path = require("path"), QR = require("qrcode");
const {app, BrowserWindow} = require("electron");
const {testTempRoot} = require("./testTemp");
const root = fs.mkdtempSync(path.join(testTempRoot(), "credential-filters-app-"));
app.setPath("userData", root); process.env.SLV_PIPE_USER = `filters-${process.pid}`;
require(path.join(process.env.SLV_TEST_CODE_ROOT || path.join(__dirname, ".."), "src/main"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0; i<150; i++) { if (await fn()) return; await sleep(50); } throw Error("Filter UI timed out"); }
async function main() {
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show(); win.focus();
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  const run = code => win.webContents.executeJavaScript(code), api = code => run(`window.secureLoginVault.${code}`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const filter = value => run(`document.querySelector('#credential-quick-filter').value=${JSON.stringify(value)};document.querySelector('#credential-quick-filter').dispatchEvent(new Event('change'))`);
  const visible = () => run("[...document.querySelectorAll('.credential-row-item:not([hidden])')].map(row=>Number(row.dataset.id))");
  const count = () => run("document.querySelector('#credential-count-label').textContent");
  const password = "Synthetic quick filter master password";
  assert.equal((await api(`auth.createVault(${JSON.stringify({masterPassword:password,confirmPassword:password})})`)).ok, true);
  await api('groups.add("Source")'); await api('groups.add("Outside")');
  const qr = await QR.toDataURL("otpauth://totp/Synthetic:test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  const entries = [
    {websiteName:"Alpha QR", category:"Other", qrCode:qr, favorite:true},
    {websiteName:"Beta missing URL", websiteUrl:"", category:"Other"},
    {websiteName:"Gamma QR", category:"API", qrCode:qr},
    {websiteName:"Delta assigned", category:"API", favorite:true},
    {websiteName:"Outside QR", category:"Other", qrCode:qr, groupName:"Outside"}
  ];
  const ids = [];
  for (const sample of entries) {
    const result = await api(`credentials.add(${JSON.stringify({websiteUrl:"https://example.test/login",username:"synthetic",password:"Dummy filter password",groupName:"Source",...sample})})`);
    assert.equal(result.ok, true); ids.push(result.result.id);
  }
  const [a,b,g,d] = ids;
  const before = JSON.stringify((await api("credentials.getAllForExport()")).result);
  await api('groups.setActive("Source")'); await run("initAuth()");
  await until(() => run("document.querySelectorAll('.credential-row-item').length===4")); await run("refreshCredentials()");
  await run("document.querySelector('#credential-sort').value='website-asc';document.querySelector('#credential-sort').dispatchEvent(new Event('change'))");
  assert.deepEqual(await visible(), [a,b,d,g]);
  await filter("has-2fa"); assert.deepEqual(await visible(), [a,g]); assert.equal(await count(), "2 of 4 matching");
  await run("document.querySelector('#credential-sort').value='website-desc';document.querySelector('#credential-sort').dispatchEvent(new Event('change'))");
  assert.deepEqual(await visible(), [g,a]);
  await filter("no-url"); assert.deepEqual(await visible(), [b]);
  await filter("uncategorized"); assert.deepEqual(await visible(), [b,a]);
  // Filter changes clear selection; selecting all can only select matching rows.
  await click("#bulk-select-toggle"); await click("#bulk-select-all");
  assert.equal(await run("bulkSelectedIds.size"), 2);
  await filter("has-2fa"); assert.equal(await run("bulkSelectedIds.size"), 0);
  await click("#bulk-select-toggle"); await click(`[data-select-credential="${g}"]`);
  await run("document.querySelector('#bulk-selection-search').value='Alpha';document.querySelector('#bulk-selection-search').dispatchEvent(new Event('input'))");
  assert.deepEqual(await visible(), [a]); assert.equal(await count(), "1 of 4 matching");
  assert.equal(await run("document.querySelector('#bulk-selection-count').textContent"), "1 selected (1 hidden)");
  await click("#bulk-select-all"); assert.equal(await run("bulkSelectedIds.size"), 2);
  await click("#bulk-selection-cancel"); assert.deepEqual(await visible(), [g,a]);
  // Dashboard search, Favorites and category intersect with the quick filter.
  await run("searchState.query='QR';searchState.onlyFavorites=true;runSearch()");
  assert.deepEqual(await visible(), [a]); assert.equal(await count(), "1 of 1 matching");
  await filter("no-url"); assert.deepEqual(await visible(), []);
  assert.equal(await run("document.querySelector('#credential-filter-empty').hidden"), false);
  await click("#credential-clear-filter"); assert.deepEqual(await visible(), [a]);
  assert.equal(await run("searchState.query==='QR' && searchState.onlyFavorites"), true);
  assert.equal(await run("document.activeElement.id"), "credential-quick-filter");
  await run("searchState.query='';searchState.onlyFavorites=false;searchState.category='API';runSearch()");
  await filter("has-2fa"); assert.deepEqual(await visible(), [g]);
  await run("searchState.query='no synthetic match';runSearch()");
  assert.equal(await count(), "0 of 0 matching");
  assert.equal(await run("document.querySelector('.empty-state').hidden"), true);
  await click("#credential-clear-filter"); assert.equal(await run("document.querySelector('.empty-state').hidden"), false);
  await run("searchState.query='';searchState.category=null;refreshCredentials()"); await filter("has-2fa");
  await run("refreshCredentials()"); assert.deepEqual(await visible(), [g,a]);
  await click(`.credential-name-button[data-id="${a}"]`); await until(() => run("document.querySelector('#detail-content')?.hidden===false"));
  await click("#detail-close"); assert.deepEqual(await visible(), [g,a]);
  await api('groups.setActive("Outside")'); await run("refreshCredentials()"); assert.deepEqual(await visible(), [ids[4]]);
  await api('groups.setActive("Source")'); await run("refreshCredentials()");
  assert.equal(JSON.stringify((await api("credentials.getAllForExport()")).result), before, "filtering never changes entries");
  win.setSize(1100,780);
  await run("document.documentElement.setAttribute('data-theme','dark');document.documentElement.setAttribute('data-palette','coffee')");
  await sleep(150); fs.writeFileSync(path.join(root,"filters-coffee.png"),(await win.webContents.capturePage()).toPNG());
  await run("handleLockVault()"); await api(`auth.unlockVault({masterPassword:${JSON.stringify(password)}})`); await run("initAuth()");
  await until(() => run("document.querySelectorAll('.credential-row-item').length===4")); await run("refreshCredentials()");
  assert.equal(await run("document.querySelector('#credential-quick-filter').value"), "all"); assert.equal((await visible()).length, 4);
  console.log(`PASS synthetic quick filters: all choices, search/Favorites/category/group intersections, sort, counts/empty states, bulk selection, refresh/details, lock reset and unchanged entries\nScreenshot: ${root}`);
  app.exit(0);
}
setTimeout(() => {console.error("Filter test timeout");app.exit(1);},60000).unref();
main().catch(error => {console.error(error);app.exit(1);});
