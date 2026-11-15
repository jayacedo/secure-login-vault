// This entry point establishes isolation BEFORE loading the desktop main process.
const fs = require('fs');
const path = require('path');
const { app, dialog, clipboard, ipcMain, shell } = require('electron');
const { PROJECT, openEnvironment, prepareBrowserBundle, assertPrivateTree } = require('./slv-test-environment');

function start(environment = openEnvironment()) {
  if (app.isReady()) throw Error('Test isolation must be configured before Electron is ready.');
  app.setPath('appData', environment.root);
  app.setPath('userData', environment.paths.app);
  app.setPath('sessionData', environment.paths.session);
  app.setPath('temp', environment.paths.temp);
  app.setAppLogsPath(environment.paths.logs);
  process.env.SLV_PIPE_USER = environment.pipeUser;
  process.env.LOCALAPPDATA = environment.root;
  process.env.APPDATA = environment.root;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  const vaultModule = require('../src/services/vaultStore');
  const createVault = vaultModule.createVaultStore;
  vaultModule.createVaultStore = directory => {
    if (path.resolve(directory) !== environment.paths.app) throw Error('SLV TEST refused a non-test vault path.');
    return createVault(directory);
  };
  const setAppId = app.setAppUserModelId.bind(app);
  app.setAppUserModelId = () => setAppId('com.securelogin.vault.test');
  app.getLoginItemSettings = () => ({ openAtLogin: false, executableWillLaunchAtLogin: false });
  app.setLoginItemSettings = () => { throw Error('Windows startup changes are disabled in SLV TEST.'); };
  // Manual desktop testing never reads or overwrites the real OS clipboard.
  let testClipboard = '';
  clipboard.readText = async () => testClipboard;
  clipboard.writeText = async value => { testClipboard = value; };
  clipboard.clear = () => { testClipboard = ''; };
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showSaveDialog = async () => ({ canceled: true });
  const blocked = new Set(['vault:pick-import-file', 'vault:pick-restore-file', 'vault:restore-backup',
    'vault:backup-verify', 'vault:auto-backup-folder', 'app:pick-folder', 'vault:open-login-window']);
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, blocked.has(channel)
    ? async () => ({ ok: false, message: 'Disabled in SLV TEST to keep real files and accounts separate.' }) : listener);
  shell.openExternal = async () => { throw Error('External sites are disabled in SLV TEST. Use the isolated test browser.'); };
  const openPath = shell.openPath.bind(shell);
  shell.openPath = async target => {
    if (path.resolve(target) !== environment.paths.extension) return 'Only the test extension folder can be opened.';
    assertPrivateTree(environment.root); return openPath(target);
  };
  const options = prepareBrowserBundle(environment, process.execPath);
  const registration = require('../src/native-host/registration');
  require('../src/services/browserSetup').createBrowserSetup = () => ({
    async status() {
      assertPrivateTree(environment.root);
      const result = await registration.status(options);
      return { supported: true, ready: result.browsers.every(b => b.ok), browsers: result.browsers,
        extensionPath: environment.paths.extension, firefoxExtensionPath: '', message: 'SLV TEST: use a separate Chromium test profile.' };
    },
    async setup() { assertPrivateTree(environment.root); await registration.register(options); return this.status(); },
    async openFolder() { await shell.openPath(environment.paths.extension); return { extensionPath: environment.paths.extension }; }
  });
  app.on('browser-window-created', (_event, window) => {
    const setTitle = window.setTitle.bind(window);
    window.setTitle = title => setTitle('SLV TEST — ' + String(title).replace(/^SLV TEST — /, ''));
    window.setTitle('Synthetic data only');
    window.webContents.on('page-title-updated', event => { event.preventDefault(); });
    window.webContents.on('did-finish-load', () => {
      window.webContents.executeJavaScript(`(() => {
        const banner=document.createElement('div');banner.id='slv-test-banner';banner.textContent='SLV TEST • Dummy data only • Files and clipboard isolated';
        banner.style.cssText='position:fixed;top:0;left:0;right:0;height:26px;line-height:26px;text-align:center;background:#ffd166;color:#211b10;font:600 12px/26px sans-serif;z-index:2147483647;pointer-events:none';
        document.body.prepend(banner);document.body.style.paddingTop='30px';
        let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copied=value;},readText:async()=>copied}});
        document.addEventListener('click',event=>{if(event.target.matches('input[type=file]')){event.preventDefault();event.stopImmediatePropagation();}},true);
        document.addEventListener('drop',event=>{event.preventDefault();event.stopImmediatePropagation();},true);
      })()`).catch(() => {});
    });
  });
  require('../src/main');
  // A local dummy form: no remote resources and no account data.
  const fixture = fs.readFileSync(path.join(PROJECT, 'docs/review-fixtures/login.html'));
  const server = require('http').createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method) || request.url !== '/') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-SLV-Test-ID': environment.pipeUser });
    response.end(request.method === 'HEAD' ? undefined : fixture);
  });
  app.whenReady().then(() => {
    server.listen(0, '127.0.0.1', () => {
      fs.writeFileSync(path.join(environment.root, 'runtime.json'), JSON.stringify({ port: server.address().port }));
    });
  });
  app.on('will-quit', () => { server.close(); testClipboard = ''; });
  return environment;
}
module.exports = { start };
// Electron's default-app loader can own require.main when passed a JS entry.
if (path.resolve(process.argv[1] || '') === __filename) {
  try { start(); }
  catch (error) { dialog.showErrorBox('SLV TEST did not start', 'Isolation could not be established. The regular vault was not opened.\n' + error.message); app.exit(1); }
}
