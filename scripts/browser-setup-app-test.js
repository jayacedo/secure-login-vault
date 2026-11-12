const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, shell } = require("electron");
const { testTempRoot } = require("./testTemp");
const { fakeRegistry } = require("./browserSetupTestUtils");
const root = fs.mkdtempSync(path.join(testTempRoot(), "browser-setup-app-"));
app.setPath("userData", root);
process.env.LOCALAPPDATA = root;
process.env.SLV_PIPE_USER = `browser-setup-${process.pid}`;
const registration = require("../src/native-host/registration");
const registry = fakeRegistry();
const register = registration.register;
const status = registration.status;
registration.register = (options) => register({ ...options, runReg: registry.runReg });
registration.status = (options) => status({ ...options, runReg: registry.runReg });
let opened;
shell.openPath = async (folder) => { opened = folder; return ""; };
require("../src/main");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 100; i += 1) { if (await predicate()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().length, "window");
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  win.webContents.on("console-message", (_event, details) => { if (details?.level === "error") console.error(details.message); });
  const run = (code) => win.webContents.executeJavaScript(code).catch((error) => { throw new Error(`Renderer check failed: ${code}`, { cause: error }); });
  const api = (code) => run(`window.secureLoginVault.${code}`);
  const initial = await api("settings.getBrowserSetup()");
  assert.equal(initial.result.supported, true, JSON.stringify(initial));
  assert.equal(initial.result.ready, false);
  assert.match((await api("settings.setupBrowserExtension()")).message, /Unlock/);
  assert.match((await api("settings.openExtensionFolder()")).message, /Unlock/);
  assert.equal(registry.values.size, 0);
  const master = "browser setup test password";
  assert.equal((await api(`auth.createVault(${JSON.stringify({ masterPassword: master, confirmPassword: master })})`)).ok, true);
  await run("initAuth()");
  await until(() => run("Boolean(document.querySelector('#open-settings-btn'))"), "dashboard");
  await run("document.querySelector('#open-settings-btn').click()");
  await until(() => run("Boolean(document.querySelector('#extension-setup-btn')) && !document.querySelector('#extension-setup-btn').disabled"), "setup available");
  assert.equal(await run("document.querySelectorAll('.settings-panel:not([hidden])').length"), 1);
  assert.equal(await run("document.querySelector('.settings-panel:not([hidden])').id"), "settings-panel-general");
  await run("document.querySelector('#brand-name-input').value = 'Settings layout test'; document.querySelector('#brand-name-save-btn').click()");
  assert.match(await run("document.querySelector('#settings-status').textContent"), /saved/);
  assert.equal(await run("document.querySelector('#settings-status').getClientRects().length > 0"), true, "save feedback visible in General");
  await run("document.querySelector('#settings-tab-security').click(); document.querySelector('#hint-input').value = 'unsaved hint'; document.querySelector('#settings-tab-general').click(); document.querySelector('#settings-tab-security').click()");
  assert.equal(await run("document.querySelector('#hint-input').value"), "unsaved hint", "navigation preserves in-progress form edits");
  await run("document.querySelector('#settings-tab-security').focus()");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await until(() => run("document.activeElement.id === 'settings-tab-browsers'"), "keyboard section navigation");
  assert.equal(await run("document.querySelector('#settings-panel-browsers').hidden"), false);
  assert.equal(await run("document.querySelector('#extension-installation').open"), false, "setup guide collapsed initially");
  await run("document.querySelector('#extension-installation').open = true");
  await run("document.querySelector('#extension-setup-btn').click()");
  await until(() => run("!document.querySelector('#extension-setup-btn').disabled"), "setup complete");
  assert.match(await run("document.querySelector('#extension-setup-hint').textContent"), /Setup complete/);
  assert.equal(registry.values.size, 3);
  assert.equal(opened, path.join(__dirname, "../extension"));
  await run("document.querySelector('#extension-firefox-folder-btn').click()");
  await until(() => opened === path.join(__dirname, "../dist/firefox"), "Firefox folder");
  assert.match(await run("document.querySelector('#extension-firefox-folder-path').value"), /firefox$/);
  assert.match((await api('settings.openExtensionFolder("../")')).message, /Choose/);
  assert.equal((await api("settings.getExtensionBridge()")).result.enabled, true);
  assert.equal((await api("settings.getBrowserSetup()")).result.ready, true);
  assert.equal((await api("settings.startExtensionPairing()")).ok, true);
  await api("settings.cancelExtensionPairing()");
  // Capture the actual renderer for layout review.
  await run("document.querySelector('#extension-installation').open = false; document.querySelector('.settings-modal-body').scrollTop = 0");
  await sleep(100);
  fs.writeFileSync(path.join(root, "browser-setup.png"), (await win.webContents.capturePage()).toPNG());
  for (const theme of ['light', 'dark']) {
    await run(`document.querySelector('[data-theme="${theme}"]').click()`);
    for (const section of ['general','security','browsers','organization','data','about']) {
      await run(`document.querySelector('#settings-tab-${section}').click()`);
      assert.equal(await run("document.querySelectorAll('.settings-panel:not([hidden])').length"), 1);
      const overflow = await run("(() => { const e = document.querySelector('.settings-modal-body'); return e.scrollWidth > e.clientWidth + 1; })()");
      assert.equal(overflow, false, `${section} ${theme}: no horizontal overflow`);
      if (['general','browsers','data'].includes(section)) {
        await sleep(100);
        fs.writeFileSync(path.join(root, `settings-${section}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  win.setMinimumSize(320, 480);
  win.setSize(520, 720);
  for (const section of ['general','security','browsers','organization','data','about']) {
    await run(`document.querySelector('#settings-tab-${section}').click()`);
    assert.equal(await run("(() => { const e = document.querySelector('.settings-modal-body'); return e.scrollWidth > e.clientWidth + 1; })()"), false, `${section}: narrow layout fits`);
  }
  await run("document.querySelector('#settings-tab-browsers').click()");
  await sleep(100);
  fs.writeFileSync(path.join(root, "settings-narrow.png"), (await win.webContents.capturePage()).toPNG());
  await run("closeSettingsModal(); openSettingsModal()");
  await until(() => run("document.querySelector('#settings-tab-browsers').getAttribute('aria-selected') === 'true'"), "last section remembered");
  console.log(`PASS Settings setup, locked guards, helper preflight, connection enablement, pairing, fixed folder\nScreenshot: ${path.join(root, "browser-setup.png")}`);
  await api("auth.lockVault()");
  assert.match((await api("settings.setupBrowserExtension()")).message, /Unlock/);
  app.exit(0);
}
setTimeout(() => { console.error("Browser setup app test timed out"); app.exit(1); }, 90000).unref();
main().catch((error) => { console.error(error); app.exit(1); });
