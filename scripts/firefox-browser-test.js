// Real Firefox, isolated profile, dummy vault, and a throwaway native host key.
// Never loads the user's browser profile, vault, or production registration.
const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const http = require("http");
const { testTempRoot } = require("./testTemp");
const { launchFirefox } = require("./firefoxTestClient");
const { buildFirefox } = require("./build-firefox");
const registration = require("../src/native-host/registration");
const { FIREFOX_EXTENSION_ID, ALLOWED_EXTENSION_IDS } = require("../src/native-host/config");
const { createPairing } = require("../src/services/extensionPairing");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { createExtensionHandlers } = require("../src/services/extensionHandlers");
const { createVaultStore } = require("../src/services/vaultStore");
const { getPipeName } = require("../src/native-host/pipeName");
const { connect, pair, authenticate } = require("./pairingTestClient");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const extensionExpr = `ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs").ExtensionParent.GlobalManager.getExtension(${JSON.stringify(FIREFOX_EXTENSION_ID)})`;

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "firefox-browser-"));
  const extensionDir = path.join(root, "extension");
  await buildFirefox({ archive: false });
  await fs.cp(path.resolve("dist/firefox"), extensionDir, { recursive: true });
  const hostName = `com.securelogin.firefoxtest.p${process.pid}`;
  const browsers = registration.BROWSERS.filter(browser => browser.id === "firefox");
  const installDir = path.join(root, "native-host");
  const statusFile = path.join(extensionDir, "status.js");
  await fs.writeFile(statusFile, (await fs.readFile(statusFile, "utf8")).replace("com.securelogin.vault", hostName));
  // A test-only entry point in the real popup keeps the production sender guard.
  await fs.appendFile(path.join(extensionDir, "popup.js"), `\nwindow.slvTest = async (message, tabId) => {
    if (tabId) await browser.tabs.update(tabId, {active:true});
    if (message.type === "test-storage") return {local:await browser.storage.local.get(null), session:await browser.storage.session.get(null)};
    if (message.type === "test-content-storage") return browser.scripting.executeScript({target:{tabId,frameIds:[0]},func:async()=>{
      const local=await browser.storage.local.get(null);
      let sessionAccess=false;
      try { await browser.storage.session.get(null); sessionAccess=true; } catch {}
      const privateDatabase=await new Promise((resolve,reject)=>{const r=indexedDB.open("slv-private-pairing");r.onsuccess=()=>{const exists=r.result.objectStoreNames.contains("pairing");r.result.close();resolve(exists)};r.onerror=reject;});
      return {localSecret:typeof local.slvPairingSecret === "string",sessionAccess,privateDatabase};
    }});
    return browser.runtime.sendMessage(message);
  };`);
  const vault = createVaultStore(path.join(root, "vault"));
  const master = "Firefox dummy vault master password";
  await vault.createVault({ masterPassword: master, confirmPassword: master });
  let stored;
  const pairing = createPairing({ storage: { load: () => stored, save: value => { stored = value; }, clear: () => { stored = null; } } });
  let approvals = 0;
  const pipeUser = `firefox-test-${process.pid}`;
  const bridge = createExtensionBridge({ pipeName: getPipeName(pipeUser), handlers: createExtensionHandlers({
    getAppVersion: () => "firefox-test", pairing,
    vault: { getCredentials: () => vault.getAllCredentials(), addCredential: data => vault.createCredential(data),
      updatePassword: async (id, password) => vault.editCredential(id, { ...await vault.getCredential(id), password }) },
    approveSave: async () => { approvals++; return true; }
  }) });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<!doctype html><title>SLV Firefox dummy test</title><form action="/" method="get"><input name="username" autocomplete="username"><input type="password" autocomplete="current-password"><button type="submit">Log in</button></form>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let client;
  try {
    await bridge.start();
    const registered = await registration.register({ installDir, runtimePath: require("electron"), hostScriptPath: path.resolve("src/native-host/host.js"), allowedExtensionIds: ALLOWED_EXTENSION_IDS, hostName, browsers });
    const launcher = await fs.readFile(registered.launcherPath, "utf8");
    await fs.writeFile(registered.launcherPath, launcher.replace("@echo off", `@echo off\r\nset SLV_PIPE_USER=${pipeUser}`));
    client = await launchFirefox(path.join(root, "profile"));
    await client.command("Addon:Install", { path: extensionDir, temporary: true });
    await client.command("Marionette:SetContext", { value: "chrome" });
    const base = await client.script(`return ${extensionExpr}.baseURI.spec;`);
    await client.command("Marionette:SetContext", { value: "content" });
    await client.command("WebDriver:Navigate", { url: base + "popup.html" });
    const popupHandle = (await client.command("WebDriver:GetWindowHandle")).value;
    async function popup(message, tabId) {
      await client.command("WebDriver:SwitchToWindow", { handle: popupHandle });
      if (tabId) {
        await client.command("Marionette:SetContext", { value: "chrome" });
        await client.script(`${extensionExpr}.tabManager.addActiveTabPermission(window.slvFixtureTab);`);
        await client.command("Marionette:SetContext", { value: "content" });
      }
      return client.script(`const done=arguments[arguments.length-1]; window.wrappedJSObject.slvTest(arguments[0],arguments[1]).then(r=>done(r == null ? null : JSON.parse(JSON.stringify(r))),e=>done({testError:String(e)}));`, [message, tabId || null], true);
    }
    let result = await popup({ type: "pair", code: pairing.startPairing().code });
    assert.equal(result.connected, true, JSON.stringify(result));
    assert.equal((await popup({ type: "get-status" })).connected, true);
    assert.equal((await popup({ type: "test-storage" })).local.slvPairingSecret, undefined);
    console.log("PASS Firefox loads the real event page, pairs through its Windows native host, and verifies encrypted transport");
    const chromeClient = await connect(getPipeName(pipeUser));
    try {
      const chromePair = await pair(chromeClient, pairing.startPairing().code, { browserName: "Google Chrome" });
      assert.equal(chromePair.finish.paired, true);
      assert.equal((await authenticate(chromeClient, chromePair.secret)).finish.ok, true);
      assert.equal((await popup({ type: "get-status" })).connected, true, "pairing Chrome keeps Firefox connected");
      assert.equal((await popup({ type: "pair", code: pairing.startPairing().code })).connected, true, "Firefox can rotate its own secret");
      assert.equal(pairing.list().length, 2, "re-pairing Firefox creates no duplicate");
      assert.equal((await chromeClient.request({ type: "channel-check" })).ok, true, "Chrome session survives Firefox rotation");
      const chromeId = pairing.list().find(value => value.name === "Google Chrome").id;
      pairing.unpair(chromeId); bridge.closeConnections(chromeId);
      await chromeClient.whenClosed();
      assert.equal((await popup({ type: "get-status" })).connected, true, "Firefox survives Chrome unpair");
    } finally { chromeClient.close(); }
    console.log("PASS real Firefox coexists with a second browser, rotates independently, and survives selective unpairing");

    await client.command("Marionette:SetContext", { value: "chrome" });
    const tabId = await client.script(`const tab=gBrowser.addTab(arguments[0],{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});gBrowser.selectedTab=tab;window.slvFixtureTab=tab;const e=${extensionExpr};return e.tabManager.getWrapper(tab).id;`, [origin]);
    await client.command("Marionette:SetContext", { value: "content" });
    const handles = await client.command("WebDriver:GetWindowHandles");
    const fixtureHandle = handles.find(handle => handle !== popupHandle);
    async function form(password) {
      await client.command("WebDriver:SwitchToWindow", { handle: fixtureHandle });
      await client.script('document.querySelector("input[name=username]").value="firefox-test-user";document.querySelector("input[type=password]").value=arguments[0];', [password]);
    }
    await delay(500);
    await form("Firefox-Dummy-1!");
    result = await popup({ type: "save-login" }, tabId);
    assert.equal(result.ok, true, JSON.stringify(result));
    let rows = await vault.getAllCredentials();
    assert.equal(rows.length, 1); assert.equal(rows[0].password, "Firefox-Dummy-1!");
    await form("");
    result = await popup({ type: "fill", loginId: rows[0].id }, tabId);
    assert.equal(result.ok, true, JSON.stringify(result));
    await client.command("WebDriver:SwitchToWindow", { handle: fixtureHandle });
    assert.equal(await client.script('return document.querySelector("input[type=password]").value;'), "Firefox-Dummy-1!");
    await form("Firefox-Dummy-2!");
    assert.equal((await popup({ type: "save-login" }, tabId)).ok, true);
    rows = await vault.getAllCredentials();
    assert.equal(rows.length, 1); assert.equal(rows[0].password, "Firefox-Dummy-2!");
    assert.equal(approvals, 2);
    console.log("PASS Firefox manual save, native confirmation hook, real DOM fill and password update without duplicates");

    // Simulate consent in this disposable profile, then exercise the real
    // dynamic content scripts and trusted WebDriver submit/button events.
    await client.command("Marionette:SetContext", { value: "chrome" });
    const granted = await client.script(`const done=arguments[arguments.length-1];ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs").ExtensionPermissions.add(${JSON.stringify(FIREFOX_EXTENSION_ID)}, {permissions:[],origins:["https://*/*","http://localhost/*","http://127.0.0.1/*"]},${extensionExpr}).then(()=>done(true),e=>done(String(e)));`, [], true);
    assert.equal(granted, true);
    await client.command("Marionette:SetContext", { value: "content" });
    assert.equal((await popup({ type: "offers-set", enabled: true }, tabId)).enabled, true);
    await client.command("WebDriver:SwitchToWindow", { handle: fixtureHandle });
    await client.command("WebDriver:Navigate", { url: origin });
    await delay(500);
    await form("Firefox-Dummy-3!");
    const button = await client.command("WebDriver:FindElement", { using: "css selector", value: "form button" });
    const elementId = element => element["element-6066-11e4-a52e-4f735466cecf"];
    await client.command("WebDriver:ElementClick", { id: elementId(button.value) });
    let host;
    for (let i = 0; i < 50 && !host; i++) {
      host = await client.command("WebDriver:FindElement", { using: "css selector", value: "body > div" }).then(r => r.value, () => null);
      if (!host) await delay(100);
    }
    assert.ok(host, "submitted login shows the automatic offer");
    const shadow = await client.command("WebDriver:GetShadowRoot", { id: elementId(host) });
    const shadowId = shadow.value["shadow-6066-11e4-a52e-4f735466cecf"];
    const updateButton = await client.command("WebDriver:FindElementFromShadowRoot", { shadowRoot: shadowId, using: "css selector", value: "button" });
    await client.command("WebDriver:ElementClick", { id: elementId(updateButton.value) });
    for (let i = 0; i < 50 && approvals < 3; i++) await delay(100);
    assert.equal(approvals, 3);
    for (let i = 0; i < 50 && (await vault.getAllCredentials())[0].password !== "Firefox-Dummy-3!"; i++) await delay(100);
    assert.equal((await vault.getAllCredentials())[0].password, "Firefox-Dummy-3!");
    console.log("PASS Firefox optional permissions, dynamic content scripts, trusted submit, closed-shadow offer and confirmed update");

    assert.equal((await popup({ type: "inline-set", enabled: true }, tabId)).enabled, true);
    await client.command("WebDriver:SwitchToWindow", { handle: fixtureHandle });
    await client.command("WebDriver:Navigate", { url: origin });
    await delay(500);
    async function inlineButton(selector) {
      const host = await client.command("WebDriver:FindElement", { using: "css selector", value: "html > div" });
      const root = await client.command("WebDriver:GetShadowRoot", { id: elementId(host.value) });
      return client.command("WebDriver:FindElementFromShadowRoot", { shadowRoot: root.value["shadow-6066-11e4-a52e-4f735466cecf"], using: "css selector", value: selector });
    }
    async function openInline() {
      const field = await client.command("WebDriver:FindElement", { using: "css selector", value: "input[type=password]" });
      await client.command("WebDriver:ElementClick", { id: elementId(field.value) });
      const button = await inlineButton(".slv-button");
      await client.command("WebDriver:ElementClick", { id: elementId(button.value) });
    }
    await openInline();
    let account;
    for (let i = 0; i < 50 && !account; i++) {
      account = await inlineButton(".account").catch(() => null);
      if (!account) await delay(100);
    }
    assert.ok(account, "real Firefox inline chooser lists the matching account");
    await client.command("WebDriver:ElementClick", { id: elementId(account.value) });
    let filled = "";
    for (let i = 0; i < 50 && !filled; i++) {
      filled = await client.script('return document.querySelector("input[type=password]").value;');
      if (!filled) await delay(100);
    }
    assert.equal(filled, "Firefox-Dummy-3!");
    assert.equal(await client.script("return location.href;"), origin + "/", "inline fill does not submit");
    assert.equal((await popup({ type: "inline-set", enabled: false }, tabId)).enabled, false);
    await client.command("WebDriver:SwitchToWindow", { handle: fixtureHandle });
    await delay(200);
    assert.equal(await client.script('return !!document.querySelector("html > div");'), false, "disabling removes existing inline UI");
    console.log("PASS real Firefox inline chooser, encrypted native retrieval, trusted account fill, no submission and immediate disable");

    assert.equal((await popup({ type: "pairing-storage-set", sessionOnly: true })).sessionOnly, true);
    let storage = await popup({ type: "test-storage" });
    assert.equal(storage.local.slvPairingSecret, undefined);
    assert.equal(typeof storage.session.slvPairingSecret, "string");
    const contentStorage = await popup({ type: "test-content-storage" }, tabId);
    assert.deepEqual(contentStorage[0].result, { localSecret: false, sessionAccess: false, privateDatabase: false });
    assert.equal((await popup({ type: "pairing-storage-set", sessionOnly: false })).sessionOnly, false);
    storage = await popup({ type: "test-storage" });
    assert.equal(storage.local.slvPairingSecret, undefined); assert.equal(storage.session.slvPairingSecret, undefined);
    await client.command("Marionette:SetContext", { value: "chrome" });
    assert.equal(await client.script(`const done=arguments[arguments.length-1];${extensionExpr}.terminateBackground().then(()=>done(true),e=>done(String(e)));`, [], true), true);
    await client.command("Marionette:SetContext", { value: "content" });
    assert.equal((await popup({ type: "get-status" })).connected, true);
    vault.lockVault();
    assert.equal((await popup({ type: "fill", loginId: rows[0].id }, tabId)).ok, false);
    await form("Firefox-Dummy-locked!");
    assert.equal((await popup({ type: "save-login" }, tabId)).ok, false);
    console.log("PASS Firefox private pairing persistence, session-only mode, and locked-vault fill/save refusal");
  } catch (error) {
    if (client) {
      console.error("Popup status:", await client.script('return document.querySelector("#status")?.textContent;').catch(() => "unavailable"));
      await client.command("Marionette:SetContext", { value: "chrome" }).catch(() => {});
      console.error("Extension errors:", await client.script('return Services.console.getMessageArray().filter(m=>m.sourceName?.startsWith("moz-extension:")).map(m=>({message:m.errorMessage,file:m.sourceName,line:m.lineNumber}));').catch(() => []));
    }
    throw error;
  } finally {
    if (client) await client.close();
    await bridge.stop();
    await new Promise(resolve => server.close(resolve));
    await registration.unregister({ installDir, hostName, browsers });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
