const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'csv-import-app-'));
app.setPath('userData', root); process.env.SLV_PIPE_USER = `csv-import-${process.pid}`;
require('../src/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for(let i=0;i<100;i++){if(await fn())return;await sleep(80);}throw Error('CSV UI timeout'); }
async function main() {
 await app.whenReady(); await until(()=>BrowserWindow.getAllWindows().length);
 const win=BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false);
 if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
 const run=code=>win.webContents.executeJavaScript(code), api=code=>run(`window.secureLoginVault.${code}`);
 const masterPassword='CSV import dummy vault password';
 assert.equal((await api(`auth.createVault(${JSON.stringify({masterPassword,confirmPassword:masterPassword})})`)).ok,true);
 await run('initAuth()');
 const existing={websiteName:'Example',websiteUrl:'https://example.com/login',username:'demo',password:'Old dummy password',groupName:'Team A',category:'WordPress'};
 await api(`credentials.add(${JSON.stringify(existing)})`);
 const secret='  Dummy,"exact" password  ';
 const source='Website,Login URL,Username,Password,Group,Category\r\n'+[
 'Example,https://example.com/login,demo,Changed dummy password,Team A,WordPress',
 `New website,https://new.example/login,user,"${secret.replace(/"/g,'""')}",Team B,WordPress`,
 '<img src=x onerror=alert(1)>,https://third.example/login,other,another dummy password,,',
 'Missing password,https://fourth.example/login,user,,,',
 'Bad link,javascript:alert(1),user,dummy,,'].join('\r\n');
 await run(`openCsvImportReview(${JSON.stringify(source)})`);
 assert.equal((await api('credentials.getAllForExport()')).result.length,1,'preview writes nothing');
 assert.equal(await run('document.querySelectorAll("#csv-preview-rows tr").length'),5);
 assert.equal(await run('document.querySelectorAll("#csv-import-overlay img").length'),0);
 assert.equal(await run(`document.querySelector('#csv-import-overlay').innerHTML.includes(${JSON.stringify(secret)})`),false);
 assert.match(await run('document.querySelector("#csv-import-summary").textContent'),/2 to import/);
 await run('document.querySelector("#csv-import-cancel").click()');
 assert.equal((await api('credentials.getAllForExport()')).result.length,1);
 await run(`openCsvImportReview(${JSON.stringify(source)})`);
 await run('document.querySelector("#csv-default-group").value="Default team";document.querySelector("#csv-default-category").value="Hosting";document.querySelector("#csv-default-group").dispatchEvent(new Event("input"))');
 assert.match(await run('document.querySelector("#csv-preview-rows").textContent'),/Default team/);
 for(const [width,theme] of [[1164,'dark'],[520,'light']]) {
  win.setMinimumSize(400,500);win.setSize(width,800);win.show();win.focus();win.webContents.focus();
  await run(`document.documentElement.setAttribute('data-theme','${theme}')`);await sleep(250);
  assert.equal(await run('document.querySelector("#csv-import-overlay .modal-body").scrollWidth<=document.querySelector("#csv-import-overlay .modal-body").clientWidth+1'),true);
  assert.ok(await run('document.querySelector(".csv-preview-scroll").getBoundingClientRect().height')>150,'preview table must not collapse on narrow windows');
  fs.writeFileSync(path.join(root,`preview-${theme}.png`),(await win.webContents.capturePage()).toPNG());
 }
 await run('document.querySelector("#csv-import-confirm").click()');
 await until(()=>run('csvReviewState===null'));
 const saved=(await api('credentials.getAllForExport()')).result;
 assert.equal(saved.length,3);
 assert.equal(saved.find(c=>c.websiteName==='Example').password,existing.password);
 const added=saved.find(c=>c.websiteName==='New website');
 assert.equal(added.password,secret);assert.equal(added.websiteUrl,'https://new.example/login');assert.equal(added.groupName,'Team B');assert.equal(added.category,'WordPress');
 const fallback=saved.find(c=>c.websiteUrl==='https://third.example/login');
 assert.equal(fallback.groupName,'Default team');assert.equal(fallback.category,'Hosting');
 const exported=await run(`buildCsvExport(${JSON.stringify(saved)})`);
 assert.match(exported.split('\r\n')[0],/Website Name,Login URL/);
 const roundtrip=require('../src/renderer/csvImport').read(exported);
 assert.equal(roundtrip.entries.find(row=>row.data.websiteName==='New website').data.password,secret);
 assert.equal(await run(`parseImportFile('keepass',${JSON.stringify('Title,URL,User Name,Password\nLegacy,https://legacy.example,user,  legacy secret  ')},'legacy.csv')[0].password`),'  legacy secret  ');
 await run(`openCsvImportReview(${JSON.stringify(source)})`);
 await run('document.querySelector("#csv-default-group").value="Default team";document.querySelector("#csv-default-group").dispatchEvent(new Event("input"))');
 assert.equal(await run('document.querySelector("#csv-import-confirm").disabled'),true,'reimport defaults skip existing');
 await run('closeCsvImportReview()');
 const many='Website,Password\n'+Array.from({length:26},(_,i)=>`Site ${i},dummy`).join('\n');
 await run(`openCsvImportReview(${JSON.stringify(many)})`);
 await run('document.querySelector("#csv-next").click()');
 assert.equal(await run('document.querySelectorAll("#csv-preview-rows tr").length'),1);
 await run('handleLockVault()');
 assert.equal(await run('csvReviewState===null && document.querySelector("#csv-import-overlay").childElementCount===0'),true);
 assert.equal((await api('auth.unlockVault({masterPassword:'+JSON.stringify(masterPassword)+'})')).ok,true);
 await run('initAuth()');
 await api('groups.setActive("Team A")');
 await run(`openCsvImportReview(${JSON.stringify('Website,Login URL,Password\nActive group,https://active.example/login,dummy')})`);
 assert.equal(await run('document.querySelector("#csv-default-group").value'),'Team A');
 await api('groups.setActive("Team B")');
 await run('document.querySelector("#csv-import-confirm").click()');
 await until(()=>run('document.querySelector("#csv-import-error").textContent.includes("active group changed")'));
 assert.equal((await api('credentials.getAllForExport()')).result.length,3);
 await run('closeCsvImportReview()');
 await run('openCredentialModal()');
 assert.equal(await run('document.querySelector("label[for=m-website-url] .modal-label-text").textContent'),'Login URL');
 assert.equal(await run('document.querySelector("#m-website-url").placeholder'),'https://example.com/login');
 console.log(`PASS CSV preview, organization defaults, duplicates, exact passwords, safe DOM, cancel/lock/group-change guards, pagination and responsive layouts. Screenshots: ${root}`);
 app.exit(0);
}
setTimeout(()=>{console.error('CSV app timeout');app.exit(1);},60000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
