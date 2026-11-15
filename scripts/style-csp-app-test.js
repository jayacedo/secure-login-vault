// Real Electron renderer, new synthetic vault only. Never use an installed profile.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { testTempRoot } = require('./testTemp');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'style-csp-'));
for (const name of ['userData', 'sessionData', 'temp', 'logs']) {
  const dir = path.join(root, name); fs.mkdirSync(dir); app.setPath(name, dir);
}
app.setPath('appData', root);
process.env.LOCALAPPDATA = root; process.env.APPDATA = root;
process.env.SLV_PIPE_USER = 'style-csp-' + process.pid;
clipboard.readText = clipboard.writeText = clipboard.clear = () => { throw Error('Real clipboard forbidden'); };
const backup = path.join(root, 'synthetic.slvbackup');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backup] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: backup });
require('../src/services/browserSetup').createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
require('../src/main');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let n=0;n<150;n++) { const value=await fn(); if(value)return value;await sleep(50); } throw Error('Style CSP test timeout'); }
async function main() {
  const code = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  assert.doesNotMatch(code, /\bstyle\s*=|\.cssText\s*=|setAttribute\(["']style["']/);
  await app.whenReady(); const win = await until(() => BrowserWindow.getAllWindows()[0]);
  win.webContents.setBackgroundThrottling(false);
  if(win.webContents.isLoading())await new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
  const run = code => win.webContents.executeJavaScript(code);
  const api = code => run('window.secureLoginVault.' + code);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const visible = selector => run(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  await run(`window.__styleViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__styleViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));`);
  assert.equal(await run(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("'unsafe-inline'")`),false);
  const password='Synthetic style CSP master password';
  assert.equal((await api(`auth.createVault(${JSON.stringify({masterPassword:password,confirmPassword:password})})`)).ok,true);
  await api('credentials.add({websiteName:"Synthetic style entry",websiteUrl:"https://example.test",username:"dummy",password:"Synthetic entry password"})');
  await api('groups.add("Synthetic group")'); await run('initAuth()');
  await until(()=>run(`document.querySelectorAll('.credential-row-item').length===1`));
  await run('setActiveGroupBanner("Synthetic group",{forceShow:true})');
  assert.equal(await visible('#active-group-banner'),true);
  await run('setActiveGroupBanner("")');assert.equal(await visible('#active-group-banner'),false);
  await run('openSettingsModal()');
  for(const theme of ['light','dark','coffee','system']) {
    await click(`.seg-btn[data-theme="${theme}"]`);
    assert.equal(await run('document.documentElement.dataset.theme'),theme==='system' ? (await run('matchMedia("(prefers-color-scheme: dark)").matches')?'dark':'light') : theme==='coffee'?'dark':theme);
  }
  await click('.seg-btn[data-theme="coffee"]');
  const accent = await run(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  await run(`document.querySelector('#brand-accent-input').value='#336699';document.querySelector('#brand-accent-input').dispatchEvent(new Event('input'))`);
  assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`),'#336699');
  assert.equal(await visible('#settings-status'),true);
  await run(`setSettingsStatus('')`);assert.equal(await visible('#settings-status'),false);
  assert.equal(await run(`getComputedStyle(document.querySelector('#brand-name-input')).maxWidth`),'220px');
  const tabs=await run(`Array.from(document.querySelectorAll('.settings-modal-container [role="tab"]')).map(el=>({id:el.id,panel:el.getAttribute('aria-controls')}))`);
  assert.equal(tabs.length,6);
  for(const tab of tabs) {
    await click('#'+tab.id);
    assert.equal(await visible('#'+tab.panel),true);
    assert.equal(await run(`document.querySelectorAll('.settings-modal-container [role="tabpanel"]:not([hidden])').length`),1);
  }
  await click('#settings-tab-general');
  for(const size of ['small','default','large']) {
    await run(`document.querySelector('#text-size-select').value='${size}';document.querySelector('#text-size-select').dispatchEvent(new Event('change'))`);
    assert.equal(await run('document.documentElement.dataset.textSize'),size);
  }
  await sleep(400);
  fs.writeFileSync(path.join(root,'settings.png'),(await win.webContents.capturePage()).toPNG());
  await run('closeSettingsModal()');
  assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`),accent,'closing restores unsaved accent');
  await run('openCredentialModal()');
  assert.equal(await visible('#modal-error'),false);
  await run('submitCredentialModal()');
  await until(()=>visible('#modal-error'));
  await until(()=>run(`parseFloat(getComputedStyle(document.querySelector('#gen-strength-bar')).width)>0`));
  await sleep(400);
  fs.writeFileSync(path.join(root,'credential.png'),(await win.webContents.capturePage()).toPNG());
  await run('closeCredentialModal();openHelpModal()');
  await run(`document.querySelector('#faq-search-input').value='zzzz-no-match-123';document.querySelector('#faq-search-input').dispatchEvent(new Event('input'))`);
  assert.equal(await visible('#faq-empty-state'),true);
  await run(`document.querySelector('#faq-search-input').value='';document.querySelector('#faq-search-input').dispatchEvent(new Event('input'))`);
  assert.equal(await visible('#faq-empty-state'),false);await run('closeHelpModal()');
  for(const [open,status,selector,close] of [
    ['openManageCategoriesModal()','setCategoriesStatus','#categories-status','closeManageCategoriesModal()'],
    ['openManageGroupsModal()','setGroupsStatus','#groups-status','closeManageGroupsModal()']
  ]) {
    await run(open);assert.equal(await visible(selector),false);
    await run(`${status}('Synthetic message',true)`);assert.equal(await visible(selector),true);
    await run(`${status}('')`);assert.equal(await visible(selector),false);await run(close);
  }
  await run('void showRestorePasswordModal()');assert.equal(await visible('#restore-pw-error'),false);
  await click('#restore-pw-confirm-btn');assert.equal(await visible('#restore-pw-error'),true);
  assert.equal(await run(`getComputedStyle(document.querySelector('.restore-password-wrap')).marginBottom`),'10px');
  await click('#restore-pw-cancel-btn');
  // Create one synthetic backup for the actual verification modal, never restore the current vault.
  await api('importExport.pickExportPath({defaultName:"synthetic.slvbackup",format:"backup"})');
  assert.equal((await api(`importExport.createBackup({filePath:${JSON.stringify(backup)}})`)).ok,true);
  await run('openSettingsModal()');
  await run('runBackupCheck()');
  assert.equal(await run(`getComputedStyle(document.querySelector('#backup-check-file')).overflowWrap`),'anywhere');
  assert.equal(await run(`getComputedStyle(document.querySelector('#backup-check-status')).whiteSpace`),'pre-line');
  await run('closeBackupCheck();closeSettingsModal()');
  assert.deepEqual(await run('window.__styleViolations'),[],'normal workflows must not violate CSP');
  // Deliberately inject styles: neither a style attribute nor a style element may apply.
  await run(`(()=>{const p=document.createElement('div');p.id='csp-probe';p.textContent='Synthetic CSP probe';document.body.appendChild(p);p.setAttribute('style','position:fixed;width:123px');const s=document.createElement('style');s.id='csp-injected';s.textContent='#csp-probe { position: fixed; width:456px; }';document.head.appendChild(s);})()`);
  await until(()=>run('window.__styleViolations.length>=2'));
  assert.notEqual(await run(`getComputedStyle(document.querySelector('#csp-probe')).position`),'fixed');
  const violations=await run('window.__styleViolations.map(e=>e.directive)');
  assert.ok(violations.includes('style-src-attr'));assert.ok(violations.includes('style-src-elem'));
  await run(`document.querySelector('#csp-probe').remove();document.querySelector('#csp-injected').remove()`);
  assert.equal((await api('credentials.getAll()')).result.length,1);
  console.log('PASS strict style CSP: theme/accent preview, text size, hidden banners/status, credential validation/strength, help filter, management/restore/backup dialogs; injected styles blocked. Synthetic screenshots: '+root);
  app.exit(0);
}
setTimeout(()=>{console.error('Style CSP test timeout');app.exit(1);},90000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
