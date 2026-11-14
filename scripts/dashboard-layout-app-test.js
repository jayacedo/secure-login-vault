const assert=require("assert/strict"),fs=require("fs"),path=require("path");
const {app,BrowserWindow}=require("electron");
const {testTempRoot}=require("./testTemp");
const root=fs.mkdtempSync(path.join(testTempRoot(),"dashboard-layout-app-"));
app.setPath("userData",root);process.env.SLV_PIPE_USER=`layout-${process.pid}`;
require(path.join(process.env.SLV_TEST_CODE_ROOT || path.join(__dirname,".."),"src/main"));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await sleep(50);}throw Error("Layout timed out");}
async function main(){
  await app.whenReady();await until(()=>BrowserWindow.getAllWindows().length);
  const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);win.show();win.focus();
  if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once("did-finish-load",resolve));
  const run=code=>win.webContents.executeJavaScript(code),api=code=>run(`window.secureLoginVault.${code}`);
  const click=selector=>run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pw="Synthetic layout master password";
  await api(`auth.createVault(${JSON.stringify({masterPassword:pw,confirmPassword:pw})})`);await api('groups.add("Synthetic group")');
  for(let i=0;i<60;i++)assert.equal((await api(`credentials.add(${JSON.stringify({websiteName:`Synthetic site ${String(i).padStart(2,"0")}`,websiteUrl:"https://example.test/login",username:"synthetic-user",password:"Dummy layout password",groupName:"Synthetic group",favorite:i%2===0})})`)).ok,true);
  await api('groups.setActive("Synthetic group")');await run("initAuth()");await until(()=>run("document.querySelectorAll('.credential-row-item').length===60"));await run("refreshCredentials()");
  const before=JSON.stringify((await api("credentials.getAllForExport()")).result);
  const rect=selector=>run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})()`);
  const metrics=()=>run("(()=>{const t=document.querySelector('.credential-table');return {height:t.clientHeight,scroll:t.scrollHeight,viewport:innerHeight,page:document.documentElement.scrollHeight,width:innerWidth,pageWidth:document.documentElement.scrollWidth}})()");
  for(const [width,height,textSize] of [[1400,900,"default"],[1100,780,"default"],[980,640,"large"]]){
    win.setSize(width,height);await run(`document.documentElement.setAttribute('data-text-size',${JSON.stringify(textSize)});document.documentElement.setAttribute('data-theme','dark');document.documentElement.setAttribute('data-palette','coffee');document.querySelector('.credential-table').scrollTop=0`);await sleep(120);
    const m=await metrics();assert(m.height>=100,JSON.stringify(m));assert(m.scroll>m.height);assert(m.page<=m.viewport+1,JSON.stringify(m));assert(m.pageWidth<=m.width+1,JSON.stringify(m));
    const search=await rect('.dashboard-toolbar'),controls=await rect('.panel-header'),head=await rect('.credential-row-head');
    await run("document.querySelector('.credential-table').scrollTop=1200");await sleep(100);
    for(const [selector,original] of [['.dashboard-toolbar',search],['.panel-header',controls],['.credential-row-head',head]])assert(Math.abs((await rect(selector)).top-original.top)<1,`${selector} stays visible`);
    assert.equal(await run("document.querySelector('#back-to-top').hidden"),false);
    await click("#back-to-top");await until(()=>run("document.querySelector('.credential-table').scrollTop<1"));assert.equal(await run("document.activeElement.id"),"credential-search");
    await click("#bulk-select-toggle");await click("#bulk-select-all");await click("#bulk-actions-toggle");await sleep(100);
    const selected=await metrics();assert(selected.height>=80,JSON.stringify({width,height,textSize,...selected}));assert(selected.page<=selected.viewport+1,JSON.stringify(selected));
    assert.equal(await run("(()=>{const b=document.querySelector('#bulk-favorite-add'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()"),true,"Actions menu is above the scrolling list");
    fs.writeFileSync(path.join(root,`layout-${width}.png`),(await win.webContents.capturePage()).toPNG());
    await run("closeBulkActions()");await click("#bulk-selection-cancel");
  }
  await run("document.documentElement.setAttribute('data-text-size','default');document.documentElement.setAttribute('data-theme','light');document.documentElement.removeAttribute('data-palette')");
  win.setSize(1100,780);await sleep(100);await run("document.querySelector('.credential-table').scrollTop=800");await sleep(100);
  fs.writeFileSync(path.join(root,"layout-light-scrolled.png"),(await win.webContents.capturePage()).toPNG());
  assert.equal(await run("getComputedStyle(document.querySelector('.credential-row-head')).backgroundColor"),"rgb(255, 255, 255)");
  await run("document.querySelector('#credential-sort').value='website-asc';document.querySelector('#credential-sort').dispatchEvent(new Event('change'));searchState.query='site 05';runSearch()");assert.equal(await run("document.querySelectorAll('.credential-row-item').length"),1);
  await click(".credential-name-button");await until(()=>run("document.querySelector('#detail-content')?.hidden===false"));await click("#detail-close");
  await run("searchState.query='';refreshCredentials()");assert.equal(JSON.stringify((await api("credentials.getAllForExport()")).result),before);
  await run("renderClientVault(_lastAuthState)");assert.equal(await run("document.body.classList.contains('has-credential-list')"),false);
  await run("renderDashboard(_lastAuthState)");await until(()=>run("document.querySelectorAll('.credential-row-item').length===60"));
  await run("handleLockVault()");assert.equal(await run("document.body.classList.contains('has-credential-list')"),false);
  console.log(`PASS synthetic dashboard layouts: wide/compact/minimum window, large text, fixed controls/sticky headings, scroll/back-to-top, menu layering, search/sort/details, client/lock reset, unchanged entries\nScreenshots: ${root}`);app.exit(0);
}
setTimeout(()=>{console.error("Layout test timeout");app.exit(1);},90000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
