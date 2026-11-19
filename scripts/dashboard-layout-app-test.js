const assert=require("assert/strict"),fs=require("fs"),path=require("path");
const {app,BrowserWindow,clipboard,dialog,powerMonitor}=require("electron");
const {testTempRoot}=require("./testTemp");
const root=fs.mkdtempSync(path.join(testTempRoot(),"dashboard-layout-app-"));
console.log(`Synthetic layout profile: ${root}`);
for(const name of ['userData','sessionData','temp','logs']){const dir=path.join(root,name);fs.mkdirSync(dir);app.setPath(name,dir);}
app.setPath('appData',root);process.env.APPDATA=root;process.env.LOCALAPPDATA=root;
process.env.TEMP=root;process.env.TMP=root;powerMonitor.getSystemIdleState=()=> 'active';
process.env.SLV_PIPE_USER=`layout-${process.pid}`;
clipboard.readText=clipboard.writeText=clipboard.clear=()=>{throw Error('Real clipboard forbidden');};
dialog.showOpenDialog=dialog.showSaveDialog=async()=>({canceled:true});
require('../src/services/browserSetup').createBrowserSetup=()=>({status:async()=>({supported:false,ready:false})});
require(path.join(process.env.SLV_TEST_CODE_ROOT || path.join(__dirname,".."),"src/main"));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await sleep(50);}throw Error("Layout timed out");}
async function main(){
  await app.whenReady();await until(()=>BrowserWindow.getAllWindows().length);
  const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);win.show();win.focus();
  if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once("did-finish-load",resolve));
  const run=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error(`Synthetic renderer step failed: ${code.slice(0,100)}; ${error.message}`);}},api=code=>run(`window.secureLoginVault.${code}`);
  const click=selector=>run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pw="Synthetic layout master password";
  await api(`auth.createVault(${JSON.stringify({masterPassword:pw,confirmPassword:pw})})`);await api('groups.add("Synthetic group")');
  for(let i=0;i<60;i++)assert.equal((await api(`credentials.add(${JSON.stringify({websiteName:`Synthetic site ${String(i).padStart(2,"0")}`,websiteUrl:i<4?"":"https://example.test/login",username:"synthetic-user",password:"Dummy layout password",groupName:"Synthetic group",favorite:i%2===0})})`)).ok,true);
  await api('groups.setActive("Synthetic group")');await run("initAuth()");await until(()=>run("document.querySelectorAll('.credential-row-item').length===60"));await run("refreshCredentials()");
  // Keep this synthetic inspection unlocked if the user focuses another app.
  await run("setPref(PREF_BACKGROUND_LOCK,'off');startAutoLockWatcher()");
  const before=JSON.stringify((await api("credentials.getAllForExport()")).result);
  const rect=selector=>run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}})()`);
  const metrics=()=>run("(()=>{const t=document.querySelector('.credential-table');return {height:t.clientHeight,scroll:t.scrollHeight,viewport:innerHeight,page:document.documentElement.scrollHeight,width:innerWidth,pageWidth:document.documentElement.scrollWidth}})()");
  for(const [width,height,textSize] of [[1400,900,"default"],[1100,780,"default"],[1000,780,"default"],[980,640,"large"]]){
    win.setSize(width,height);await run(`document.documentElement.setAttribute('data-text-size',${JSON.stringify(textSize)});document.documentElement.setAttribute('data-theme','dark');document.documentElement.setAttribute('data-palette','coffee');document.querySelector('.credential-table').scrollTop=0`);await sleep(120);
    const m=await metrics();assert(m.height>=100,JSON.stringify(m));assert(m.scroll>m.height);assert(m.page<=m.viewport+1,JSON.stringify(m));assert(m.pageWidth<=m.width+1,JSON.stringify(m));
    for(const filter of ['all','no-url']){
      await run(`document.querySelector('#credential-quick-filter').value=${JSON.stringify(filter)};document.querySelector('#credential-quick-filter').dispatchEvent(new Event('change'))`);await sleep(50);
      const title=await rect('#credential-list-title'),count=await rect('#credential-count-label'),tools=await rect('.health-dashboard-actions');
      assert(Math.abs((title.top+title.bottom)/2-(count.top+count.bottom)/2)<2,'Title and count share a line');
      assert(count.left>=title.right && count.left-title.right<=14,'Count stays beside title');
      assert(tools.left>=count.right || tools.top>=Math.max(title.bottom,count.bottom),'Controls do not overlap heading');
      const sort=await rect('#credential-sort'),icons=await rect('.credential-tool-buttons');
      if(tools.top>=title.bottom){
        assert(Math.abs(sort.left-title.left)<2,'Wrapped filters align with the heading at the left edge');
      }
      assert(Math.abs(icons.right-tools.right)<2,'Action icons stay at the right edge');
      if(filter==='no-url'){
        assert.equal(await run("document.querySelector('#credential-count-label').textContent"),'4 of 60 matching');
        if(width<=980)assert(tools.top>=title.bottom,JSON.stringify({message:'Compact filtered controls wrap below heading',width,title,count,tools}));
        await run("document.documentElement.setAttribute('data-palette','forest')");
        await sleep(100);
        fs.writeFileSync(path.join(root,`header-filtered-${width}.png`),(await win.webContents.capturePage()).toPNG());
      }
    }
    await click('#credential-clear-filter');await sleep(50);
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
  // Exercise dropdown selections while resizing both directions, across the
  // sidebar breakpoint and minimum window size. This profile is synthetic only.
  async function sweep(name, selectors=[]){
    for(const [index,width] of [1600,1190,1170,1000,980,1400].entries()){
      win.setSize(width,780);
      for(const selector of selectors){
        await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el || el.disabled || !el.getClientRects().length)return;el.selectedIndex=${index}%2 ? el.options.length-1 : 0;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      }
      await sleep(80);
      const problems=await run(`(()=>{
        const issues=[];
        if(document.documentElement.scrollWidth>innerWidth+1)issues.push('page horizontal overflow');
        const overlay=document.querySelector('.modal-overlay.is-open');
        const scope=overlay||document.querySelector('.dashboard-main');
        if(!scope)return ['screen unavailable during resize'];
        for(const el of scope.querySelectorAll('.primary-button,.secondary-button,.danger-button')){
          if(!el.getClientRects().length || el.classList.contains('dashboard-icon-button'))continue;
          const css=getComputedStyle(el);
          if(parseFloat(css.paddingLeft)<8 || parseFloat(css.paddingRight)<8)issues.push((el.id||el.textContent.trim())+' cramped text padding');
        }
        for(const el of scope.querySelectorAll('select')){
          if(!el.getClientRects().length)continue;
          const r=el.getBoundingClientRect();
          const owner=el.closest('.modal-container')||scope;
          const box=owner.getBoundingClientRect();
          if(r.left<Math.max(0,box.left)-1||r.right>Math.min(innerWidth,box.right)+1)issues.push(el.id+' outside screen/container');
        }
        for(const el of scope.querySelectorAll('.modal-body,.settings-modal-body,.settings-panel:not([hidden])')){
          if(el.clientWidth && el.scrollWidth>el.clientWidth+1)issues.push(el.className+' horizontal overflow');
        }
        return issues;
      })()`);
      assert.deepEqual(problems,[],`${name} at ${width}px`);
      if(width===980||width===1400)fs.writeFileSync(path.join(root,`resize-${name}-${width}.png`),(await win.webContents.capturePage()).toPNG());
    }
  }
  await run("applyTheme('forest')");
  await sweep('dashboard',['#credential-sort','#credential-quick-filter']);
  await run("document.querySelector('#credential-quick-filter').value='all';document.querySelector('#credential-quick-filter').dispatchEvent(new Event('change'))");
  await run("openCredentialModal(null)");await sweep('add-credential',['#m-category','#m-group']);await run("closeCredentialModal()");
  await run("openActivityHistory()");await sweep('activity',['#activity-action','#activity-source']);await run("closeActivityHistory()");
  await run("openSettingsModal()");
  for(const [tab,selectors] of [['general',['#text-size-select']],['security',['#auto-lock-select','#clipboard-clear-select']],['browsers',[]],['organization',['#settings-active-group-select']],['data',['#auto-backup-keep']],['about',[]]]){
    await click(`[data-settings-tab="${tab}"]`);await sweep(`settings-${tab}`,selectors);
  }
  await run("closeSettingsModal()");
  await run("renderClientVault(_lastAuthState)");assert.equal(await run("document.body.classList.contains('has-credential-list')"),false);
  await sweep('client-vault');await run("openClientModal(null)");await sweep('add-client');await run("closeClientModal()");
  await run("renderDashboard(_lastAuthState)");await until(()=>run("document.querySelectorAll('.credential-row-item').length===60"));
  await run("handleLockVault()");assert.equal(await run("document.body.classList.contains('has-credential-list')"),false);
  console.log(`PASS synthetic dashboard layouts: wide/compact/minimum window, large text, fixed controls/sticky headings, scroll/back-to-top, menu layering, search/sort/details, client/lock reset, unchanged entries\nScreenshots: ${root}`);app.exit(0);
}
setTimeout(()=>{console.error("Layout test timeout");app.exit(1);},180000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
