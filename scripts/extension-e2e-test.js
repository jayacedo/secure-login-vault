// End-to-end test of the browser extension, with everything real except Chrome itself:
//
//   extension popup.js -> extension background.js (+ link.js, pairing.js) ->
//   real launcher (.bat) -> real helper (host.js in Electron's Node mode) ->
//   real named pipe -> the real app (src/main.js) with its Settings
//
// Chrome is replaced by a small stand-in that does what Chrome's native messaging does:
// connectNative starts the registered launcher with the calling extension's origin and
// connects its stdin/stdout, framed, to a port. It also provides chrome.storage.local.
//   npm run test:e2e
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const { JSDOM } = require("jsdom");
const { testTempRoot } = require("./testTemp");
const { app, BrowserWindow, dialog } = require("electron");

const userData = fs.mkdtempSync(path.join(testTempRoot(), "slv-e2e-"));
app.setPath("userData", userData);
// Own pipe for the app AND the helper, so a real running app is never touched.
process.env.SLV_PIPE_USER = `e2e-${process.pid}`;
// This transport test substitutes confirmations; browser-save-app-test drives
// the actual isolated dropdown dialog and verifies persistence and cancellation.
require("../src/services/browserSavePrompt").showSaveLoginPrompt = async (options) => {
  const result = await dialog.showMessageBox(options.parent, {
    message: `Add a new login for "${options.username}" on ${options.host}?`,
    buttons: ["Don't add", "Add"], defaultId: 0, cancelId: 0, signal: options.signal
  });
  return !options.signal.aborted && result?.response === 1
    ? { approved: true, groupName: options.activeGroup, category: options.categories.includes("Other") ? "Other" : options.categories[0], activeGroup: options.activeGroup }
    : false;
};
require("../src/main.js");

const registration = require("../src/native-host/registration");
const { ALLOWED_EXTENSION_IDS } = require("../src/native-host/config");
const { encodeMessage, createMessageReader } = require("../src/native-host/framing");

const EXTENSION_DIR = path.join(__dirname, "..", "extension");
const readExtensionFile = (name) => fs.readFileSync(path.join(EXTENSION_DIR, name), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MASTER = "e2e master password for the test";

async function waitFor(predicate, timeoutMs, what) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

// Counts running helper processes, to prove the test leaves none behind.
function countHelpers() {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'native-host[\\\\/]host\\.js' } | Measure-Object).Count"],
      { windowsHide: true }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", () => resolve(Number.parseInt(out.trim(), 10) || 0));
  });
}

// What Chrome does for chrome.runtime.connectNative(host): start the registered
// launcher with the calling extension's origin and wire its stdio to a port.
function makeConnectNative({ launcherPath, origin, hostName, chrome }) {
  return function connectNative(host) {
    assert.equal(host, hostName, "the extension asks for the registered helper");

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(`"${launcherPath}" "${origin}"`, { shell: true, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    const messageListeners = [];
    const disconnectListeners = [];
    let ended = false;

    const end = (message) => {
      if (ended) return;
      ended = true;
      if (message !== null) {
        chrome.runtime.lastError = { message };
        disconnectListeners.forEach((fn) => fn());
        chrome.runtime.lastError = undefined;
      }
      try { child.stdin.end(); } catch { /* already closed */ }
      setTimeout(() => child.kill(), 2000).unref();
    };

    const reader = createMessageReader({
      onMessage: (value) => setImmediate(() => messageListeners.forEach((fn) => fn(value))),
      onError: () => end("Error when communicating with the native messaging host.")
    });
    child.stdout.on("data", (chunk) => reader.push(chunk));
    child.on("exit", () => setTimeout(() => end("Native host has exited."), 50));

    return {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
      postMessage(message) {
        if (ended) throw new Error("Attempt to postMessage on disconnected port");
        child.stdin.write(encodeMessage(message));
      },
      disconnect: () => end(null) // the caller closing the port does not notify itself
    };
  };
}

// A fake `chrome` for the extension, wired to the stand-in above.
function makeChrome({ connectNativeFor, store }) {
  const listeners = [];
  const chrome = {
    runtime: {
      id: "e2e-extension-id",
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      connectNative: (host) => { chrome.connects += 1; return connectNativeFor(chrome)(host); },
      // Used by the popup: delivered to the background worker's listener.
      sendMessage(message, callback) {
        const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") };
        chrome.messages.push(message);
        const keptOpen = listeners[0](message, sender, (response) => {
          chrome.responses.push(response);
          callback(response);
        });
        assert.equal(keptOpen, true, "the background worker answers asynchronously");
      }
    },
    connects: 0, // how many times the extension opened the helper
    messages: [],
    responses: [],
    // chrome.scripting.executeScript, with the page being a jsdom window: the function's text
    // is run inside it, as Chrome runs an injected function in the page's isolated world.
    injections: [],
    pageUrl: undefined, // where the page really is (defaults to the tab's address)
    pageHtml: "",
    page: undefined,
    scripting: {
      async executeScript(injection) {
        chrome.injections.push(injection);
        if (!injection.args[2]?.verifyToken || !chrome.page) {
          chrome.page?.window.close();
          chrome.page = new JSDOM(`<!doctype html><title>t</title>${chrome.pageHtml}`, { url: chrome.pageUrl || chrome.activeTabUrl, runScripts: "outside-only" });
        // jsdom has no layout engine: give elements the non-zero size a real browser would report
        for (const property of ["offsetWidth", "offsetHeight"]) {
          Object.defineProperty(chrome.page.window.HTMLElement.prototype, property, { get: () => 100 });
        }
        }
        const run = chrome.page.window.eval(`(${injection.func.toString()})`);
        return [{ frameId: 0, result: run(...injection.args) }];
      }
    },
    // The tab the popup was opened on (set by the test); only its URL is visible, as with activeTab.
    activeTabUrl: undefined,
    tabs: {
      query(options, callback) {
        assert.deepEqual(options, { active: true, currentWindow: true });
        callback(chrome.activeTabUrl ? [{ id: 42, url: chrome.activeTabUrl }] : []);
      }
    },
    storage: {
      local: {
        async get(key) { return key in store ? { [key]: store[key] } : {}; },
        async set(values) { Object.assign(store, values); },
        async remove(key) { delete store[key]; }
      }
    }
  };
  chrome.offerState = require("./offerTestUtils").addOfferApis(chrome);
  chrome.fromPage = message => new Promise(resolve => {
    const sender = { id: chrome.runtime.id, url: chrome.activeTabUrl, tab: { id: 42 }, frameId: 0, documentId: "test-document" };
    const kept = listeners[0](message, sender, resolve);
    if (!kept) resolve({ ignored: true });
  });
  return chrome;
}

function startBackground(chrome) {
  const sandbox = {
    chrome,
    crypto: { randomUUID: () => crypto.randomUUID(), subtle: crypto.webcrypto.subtle, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) },
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder, URL, Uint8Array, String, Promise, Object, Array, JSON, Error, parseInt
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => files.forEach((file) => vm.runInContext(readExtensionFile(file), context, { filename: file }));
  vm.runInContext(readExtensionFile("background.js"), context, { filename: "background.js" });
}

function openPopup(chrome) {
  const html = readExtensionFile("popup.html").replace(/<script[^>]*><\/script>/g, "").replace(/<link[^>]*>/, "");
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  dom.window.chrome = chrome;
  dom.window.eval(readExtensionFile("popup.js"));
  const $ = (id) => dom.window.document.getElementById(id);
  return {
    state: () => $("status").dataset.state,
    title: () => $("status-title").textContent,
    detail: () => $("status-detail").textContent,
    button: $("recheck"),
    pairingVisible: () => !$("pairing").hidden,
    forgetVisible: () => !$("forget").hidden,
    siteTitle: () => $("site-title").textContent,
    siteNote: () => $("site-note").textContent,
    siteVisible: () => !$("site").hidden,
    logins: () => Array.from(dom.window.document.querySelectorAll("#logins li")).map((li) => Array.from(li.querySelectorAll(".login-name, .login-user")).map((c) => c.textContent)),
    fillButtons: () => Array.from(dom.window.document.querySelectorAll("#logins button")),
    fillNote: () => dom.window.document.getElementById("fill-note").textContent,
    saveVisible: () => !$("save").hidden,
    saveNote: () => $("save-note").textContent,
    saveButton: $("save-button"),
    pageText: () => dom.window.document.body.textContent,
    typeCode: (code) => { $("code").value = code; },
    codeValue: () => $("code").value,
    pair: () => $("pair").click(),
    forget: () => $("forget").click(),
    settled: () => $("status").dataset.state !== "checking" && !$("recheck").disabled
  };
}

async function main() {
  await app.whenReady();
  const results = [];
  const check = async (name, fn) => {
    console.log(`...   ${name}`);
    try {
      await fn();
      results.push(`PASS  ${name}`);
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${error.message}`);
      process.exitCode = 1;
    }
  };

  // The app's window gives us the same Settings API the real UI uses.
  await waitFor(() => BrowserWindow.getAllWindows().length > 0, 15000, "the app window");
  const win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  const inApp = (code) => win.webContents.executeJavaScript(`window.secureLoginVault.${code}`);
  const setBridge = (enabled) => inApp(`settings.setExtensionBridge({ enabled: ${enabled} })`);

  assert.equal((await inApp(`auth.createVault(${JSON.stringify({ masterPassword: MASTER, confirmPassword: MASTER })})`)).ok, true, "vault creation");

  // "Install" the helper (launcher + manifest in a temp folder; no real registry changes).
  const installDir = path.join(userData, "native host");
  const registered = await registration.register({
    installDir,
    runtimePath: process.execPath,
    hostScriptPath: path.resolve(__dirname, "..", "src", "native-host", "host.js"),
    allowedExtensionIds: ALLOWED_EXTENSION_IDS,
    runReg: async () => ({ ok: true, stdout: "", stderr: "" })
  });

  const ownOrigin = `chrome-extension://${ALLOWED_EXTENSION_IDS[0]}/`;
  const ownStore = {};
  const connectFor = (origin) => (chrome) => makeConnectNative({ launcherPath: registered.launcherPath, origin, hostName: registration.HOST_NAME, chrome });
  const ownChrome = makeChrome({ connectNativeFor: connectFor(ownOrigin), store: ownStore });
  startBackground(ownChrome);

  const helpersBefore = await countHelpers();

  // Opens the popup and waits until it has an answer.
  const popupWithAnswer = async (chrome = ownChrome) => {
    const popup = openPopup(chrome);
    await waitFor(() => popup.settled(), 30000, "the popup to show an answer");
    return popup;
  };
  const settle = (popup, what) => waitFor(() => popup.settled(), 30000, what);

  await check("the app's browser connection is off: the popup says so", async () => {
    const popup = await popupWithAnswer();
    assert.equal(popup.state(), "problem");
    assert.equal(popup.title(), "Not connected");
    assert.match(popup.detail(), /Browser Extension/);
    assert.equal(popup.pairingVisible(), false);
  });

  await check("switched on in the app: the popup says Not paired and offers the code field", async () => {
    assert.equal((await setBridge(true)).ok, true);
    const popup = await popupWithAnswer();
    assert.equal(popup.state(), "problem", "reachable but unverified is not green");
    assert.equal(popup.title(), "Not paired");
    assert.equal(popup.pairingVisible(), true);
    assert.equal(popup.forgetVisible(), false);
  });

  let popup;
  await check("a wrong code is refused and nothing is stored", async () => {
    assert.equal((await inApp("settings.startExtensionPairing()")).ok, true);
    popup = await popupWithAnswer();
    popup.typeCode("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA"); // well formed, but not the app's code
    popup.pair();
    assert.equal(popup.codeValue(), "");
    await settle(popup, "the refusal");
    assert.equal(popup.title(), "Code not accepted");
    assert.equal(Object.keys(ownStore).length, 0);
    assert.equal((await inApp("settings.getExtensionPairing()")).result.paired, false);
  });

  let code;
  await check("pasting the code from the app pairs; the popup shows Connected and verified", async () => {
    const started = await inApp("settings.startExtensionPairing()");
    assert.equal(started.ok, true);
    code = started.result.code;
    popup.typeCode(code);
    popup.pair();
    await settle(popup, "pairing");
    assert.equal(popup.state(), "connected", `${popup.title()}: ${popup.detail()}`);
    assert.equal(popup.title(), "Connected");
    assert.equal(popup.detail(), `Secure Login Vault ${app.getVersion()} (verified)`);
    assert.equal(popup.pairingVisible(), false);
    assert.equal(popup.forgetVisible(), true);
    assert.match(ownStore.slvPairingSecret, /^[0-9a-f]{64}$/);
    assert.equal((await inApp("settings.getExtensionPairing()")).result.paired, true);
  });

  await check("the popup lists the saved logins for the page it is opened on (and only those)", async () => {
    const add = (data) => inApp(`credentials.add(${JSON.stringify(data)})`);
    assert.equal((await add({ websiteName: "Example", websiteUrl: "https://example.com/login", username: "alice", password: "pw-SECRET-1", category: "Other", notes: "NOTE-SECRET" })).ok, true);
    assert.equal((await add({ websiteName: "Example admin", websiteUrl: "example.com", username: "root", password: "pw-SECRET-2", category: "Other" })).ok, true);
    assert.equal((await add({ websiteName: "WWW", websiteUrl: "https://www.example.com", username: "bob", password: "pw-SECRET-3", category: "Other" })).ok, true);

    ownChrome.activeTabUrl = "https://example.com/account?token=SECRET-TOKEN";
    const view = await popupWithAnswer();
    assert.equal(view.state(), "connected");
    assert.equal(view.siteTitle(), "Saved logins for example.com");
    assert.deepEqual(view.logins().map((l) => l.join(" / ")).sort(), ["Example / alice", "Example admin / root"]);

    ownChrome.activeTabUrl = "https://www.example.com/";
    assert.deepEqual((await popupWithAnswer()).logins(), [["WWW", "bob"]]);

    ownChrome.activeTabUrl = "https://evil-example.com/";
    const lookalike = await popupWithAnswer();
    assert.deepEqual(lookalike.logins(), []);
    assert.equal(lookalike.siteNote(), "No saved logins for this site.");

    ownChrome.activeTabUrl = "http://example.com/";
    assert.equal((await popupWithAnswer()).siteNote(), "This page is not secure (http), so no logins are offered.");

    ownChrome.activeTabUrl = "chrome://extensions/";
    assert.equal((await popupWithAnswer()).siteNote(), "Saved logins are not offered on this kind of page.");

    // locked vault: still connected and verified, but no list
    ownChrome.activeTabUrl = "https://example.com/";
    assert.equal((await inApp("auth.lockVault()")).ok !== false, true);
    const locked = await popupWithAnswer();
    assert.equal(locked.state(), "connected");
    assert.equal(locked.siteNote(), "Secure Login Vault is locked. Unlock it to see your logins here.");
    assert.deepEqual(locked.logins(), []);
    assert.equal((await inApp(`auth.unlockVault(${JSON.stringify({ masterPassword: MASTER })})`)).ok, true);
    assert.equal((await popupWithAnswer()).logins().length, 2);

    ownChrome.activeTabUrl = undefined;
  });

  await check("Fill: a saved login goes into the page, only for its exact site, and the password never reaches the popup", async () => {
    const LOGIN_PAGE = '<form id="f"><input type="text" name="log" autocomplete="username"><input type="password" name="pwd" autocomplete="current-password"><input type="submit" value="Log In"></form>';
    const typed = (chrome) => ({ user: chrome.page.window.document.querySelector("[name=log]").value, pass: chrome.page.window.document.querySelector("[name=pwd]").value });
    const fillAlice = async (view) => {
      const index = view.logins().findIndex((l) => l[1] === "alice");
      assert.ok(index >= 0, "alice is listed");
      view.fillButtons()[index].click();
      await waitFor(() => view.fillNote() !== "Filling...", 30000, "the fill to finish");
    };
    ownChrome.activeTabUrl = "https://example.com/login";
    ownChrome.pageHtml = LOGIN_PAGE;

    // the real thing
    let view = await popupWithAnswer();
    ownChrome.injections.length = 0;
    ownChrome.messages.length = 0;
    ownChrome.responses.length = 0;
    await fillAlice(view);
    assert.equal(view.fillNote(), "Filled. Press the site's own Sign in button.");
    assert.deepEqual(typed(ownChrome), { user: "alice", pass: "pw-SECRET-1" });
    assert.equal(ownChrome.injections.length, 1);
    const injection = ownChrome.injections[0];
    assert.deepEqual(injection.target, { tabId: injection.target.tabId, frameIds: [0] }, "the main page only");
    assert.equal(injection.world, "ISOLATED");
    assert.equal(injection.args[0], "https://example.com", "the origin the password was requested for");
    assert.deepEqual(injection.args[2], { submit: false, layout: true, skipUsernameOnly: false });
    assert.equal(ownChrome.page.window.document.getElementById("f").dataset.submitted, undefined);

    // the popup never saw the password
    const popupTraffic = JSON.stringify([ownChrome.messages, ownChrome.responses]);
    assert.equal(popupTraffic.includes("pw-SECRET"), false, "not in a message to or from the popup");
    assert.equal(view.pageText().includes("pw-SECRET"), false, "not anywhere in the popup");
    assert.deepEqual(ownChrome.messages.filter((m) => m.type === "fill").map((m) => Object.keys(m).sort()), [["loginId", "type"]], "the popup sends only the id");

    // the address comes from the tab: a popup that claims another site changes nothing
    ownChrome.injections.length = 0;
    const lied = await new Promise((resolve) => ownChrome.runtime.sendMessage({ type: "fill", loginId: 1, url: "https://evil.test" }, resolve));
    assert.equal(ownChrome.injections.length <= 1, true);
    if (ownChrome.injections.length === 1) assert.equal(ownChrome.injections[0].args[0], "https://example.com", "a claimed address is ignored");
    assert.equal(JSON.stringify(lied).includes("pw-SECRET"), false);

    // another site's tab: nothing is released or filled
    ownChrome.activeTabUrl = "https://evil-example.com/login";
    view = await popupWithAnswer();
    ownChrome.injections.length = 0;
    const evilResult = await new Promise((resolve) => ownChrome.runtime.sendMessage({ type: "fill", loginId: 1 }, resolve));
    assert.deepEqual(evilResult, { ok: false, status: "error", message: "That login does not belong to this page." });
    assert.equal(ownChrome.injections.length, 0, "nothing reached the page");

    // the page moved to another site after the password was fetched: the page itself refuses
    ownChrome.activeTabUrl = "https://example.com/login";
    ownChrome.pageUrl = "https://evil.test/login";
    view = await popupWithAnswer();
    await fillAlice(view);
    assert.equal(view.fillNote(), "The page changed, so nothing was filled.");
    assert.deepEqual(typed(ownChrome), { user: "", pass: "" }, "the other site got nothing");
    ownChrome.pageUrl = undefined;

    // a page without a login form
    ownChrome.pageHtml = '<form><input type="search" name="q"></form>';
    view = await popupWithAnswer();
    await fillAlice(view);
    assert.equal(view.fillNote(), "No login form was found on this page.");

    // a locked vault releases nothing
    ownChrome.pageHtml = LOGIN_PAGE;
    view = await popupWithAnswer();
    assert.equal((await inApp("auth.lockVault()")).ok !== false, true);
    ownChrome.injections.length = 0;
    const lockedResult = await new Promise((resolve) => ownChrome.runtime.sendMessage({ type: "fill", loginId: 1 }, resolve));
    assert.equal(lockedResult.message, "Secure Login Vault is locked. Unlock it, then try again.");
    assert.equal(ownChrome.injections.length, 0);
    assert.equal((await inApp(`auth.unlockVault(${JSON.stringify({ masterPassword: MASTER })})`)).ok, true);

    ownChrome.activeTabUrl = undefined;
  });

  await check("Save: the page is read after the person asks, they confirm in the app, and the vault changes only then", async () => {
    // Render the real desktop dashboard so its external-change subscription is exercised.
    await win.webContents.executeJavaScript("initAuth()");
    await waitFor(() => win.webContents.executeJavaScript("Boolean(document.querySelector('#credential-list-body'))"), 5000, "desktop dashboard");
    // stand-in for the app's native question box (a real one needs a person to click it)
    const prompts = [];
    let answer = 1;
    let answerDelay = 11000; // longer than the old 8s link / 10s helper deadlines
    dialog.showMessageBox = async (window, options) => {
      prompts.push(options);
      await sleep(answerDelay);
      answerDelay = 30;
      return { response: answer };
    };
    const credentials = async () => (await inApp("credentials.getAll()")).result;
    const form = (user, pass) => `<form id="f"><input type="text" name="log" value="${user}"><input type="password" name="pwd" value="${pass}"></form>`;
    const saveNow = async (view) => {
      view.saveButton.click();
      await waitFor(() => !view.saveNote().startsWith("Saving"), 30000, "the save to finish");
      await settle(view, "the popup after saving");
    };
    ownChrome.activeTabUrl = "https://example.com/login?token=SECRET-TOKEN";

    // a new login
    ownChrome.pageHtml = form("carol", "carol-PW-1");
    let view = await popupWithAnswer();
    assert.equal(view.saveVisible(), true, "offered on a page it can work on");
    const before = (await credentials()).length;
    ownChrome.messages.length = 0;
    ownChrome.responses.length = 0;
    ownChrome.injections.length = 0;
    await saveNow(view);
    assert.equal(view.saveNote(), "Saved to Secure Login Vault.");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].message, /carol/);
    assert.match(prompts[0].message, /example\.com/);
    assert.deepEqual(prompts[0].buttons, ["Don't add", "Add"]);
    assert.equal(prompts[0].defaultId, 0, "Enter means no");
    assert.equal(prompts[0].cancelId, 0, "closing means no");
    assert.equal(JSON.stringify(prompts[0]).includes("carol-PW"), false, "the question never shows the password");
    const saved = (await credentials()).find((c) => c.username === "carol");
    assert.ok(saved, "the login is in the vault");
    assert.deepEqual({ name: saved.websiteName, url: saved.websiteUrl, password: saved.password }, { name: "example.com", url: "https://example.com", password: "carol-PW-1" }, "only the origin is kept, never the path or token");
    assert.equal((await credentials()).length, before + 1);
    await waitFor(() => win.webContents.executeJavaScript("document.querySelector('#credential-list-body').textContent.includes('carol')"), 5000, "desktop list to refresh after saving");

    // what the popup did and saw
    assert.deepEqual(ownChrome.messages.filter((m) => m.type === "save-login").map((m) => Object.keys(m)), [["type"]], "the popup sends nothing but the request");
    const injection = ownChrome.injections[0];
    assert.deepEqual(injection.target, { tabId: injection.target.tabId, frameIds: [0] }, "the main page only");
    assert.equal(injection.world, "ISOLATED");
    assert.equal(injection.args[0], "https://example.com");
    assert.equal(JSON.stringify([ownChrome.messages, ownChrome.responses]).includes("carol-PW"), false, "the password never reaches the popup");
    assert.equal(view.pageText().includes("carol-PW"), false);
    assert.ok(view.logins().some((l) => l[1] === "carol"), "the list now shows it");

    // the same login again: nothing to do, nobody is asked
    prompts.length = 0;
    view = await popupWithAnswer();
    await saveNow(view);
    assert.equal(view.saveNote(), "This login is already saved with this password.");
    assert.equal(prompts.length, 0);

    // a changed password updates only the password
    ownChrome.pageHtml = form("alice", "alice-NEW-PW");
    view = await popupWithAnswer();
    const aliceBefore = (await credentials()).find((c) => c.username === "alice" && c.websiteUrl === "https://example.com/login");
    await saveNow(view);
    assert.equal(view.saveNote(), "Password updated in Secure Login Vault.");
    assert.match(prompts[0].message, /Update/);
    assert.deepEqual(prompts[0].buttons, ["Don't update", "Update"]);
    const aliceAfter = (await credentials()).find((c) => c.id === aliceBefore.id);
    assert.equal(aliceAfter.password, "alice-NEW-PW");
    assert.deepEqual({ ...aliceAfter, password: "", updatedAt: "" }, { ...aliceBefore, password: "", updatedAt: "" }, "nothing else about the login changed");
    assert.equal((await credentials()).length, before + 1, "updated in place, not copied");

    // not approved: nothing changes
    prompts.length = 0;
    answer = 0;
    ownChrome.pageHtml = form("dave", "dave-PW");
    view = await popupWithAnswer();
    await saveNow(view);
    assert.equal(view.saveNote(), "It was not approved in Secure Login Vault, so nothing was saved.");
    assert.equal(prompts.length, 1);
    assert.equal((await credentials()).some((c) => c.username === "dave"), false);
    answer = 1;

    // what the person typed is not enough yet, or not clear
    const problems = [
      ['<form><input type="text" name="q" value="x"></form>', "No login form was found on this page. Type your login on the page first."],
      [form("erin", ""), "Type your password on the page first, then press Save."],
      [form("", "some-pw"), "Confirm your username or email below, then save. The password stays on the page until you continue."],
      ['<form><input type="text" value="frank"><input type="password" value="old-pw"><input type="password" value="new-pw"></form>', "This page has several different passwords typed in (a change-password form?). Nothing was saved."]
    ];
    prompts.length = 0;
    for (const [html, message] of problems) {
      ownChrome.pageHtml = html;
      view = await popupWithAnswer();
      await saveNow(view);
      assert.equal(view.saveNote(), message);
    }
    assert.equal(prompts.length, 0, "nobody was asked about an incomplete form");

    ownChrome.pageHtml = '<form><input type="password" value="two-step-synthetic-password"></form>';
    const missing = await new Promise(resolve => ownChrome.runtime.sendMessage({ type: "save-login" }, resolve));
    assert.equal(missing.needsUsername, true);
    const completed = await new Promise(resolve => ownChrome.runtime.sendMessage({ type: "save-login-username", token: missing.token, username: "two-step-dummy" }, resolve));
    assert.equal(completed.ok, true);
    assert.equal((await credentials()).find(c => c.username === "two-step-dummy").password, "two-step-synthetic-password");
    assert.equal(JSON.stringify(ownChrome.responses).includes("two-step-synthetic-password"), false);

    // the page moved to another site after the tab was read: the page itself refuses
    ownChrome.pageHtml = form("gina", "gina-PW");
    ownChrome.pageUrl = "https://evil.test/login";
    view = await popupWithAnswer();
    await saveNow(view);
    assert.equal(view.saveNote(), "The page changed, so nothing was saved.");
    ownChrome.pageUrl = undefined;

    // the address and values come from the page, never from the popup
    ownChrome.pageHtml = form("hank", "hank-PW");
    prompts.length = 0;
    const lied = await new Promise((resolve) => ownChrome.runtime.sendMessage({ type: "save-login", url: "https://evil.test", username: "mallory", password: "mallory-PW" }, resolve));
    assert.equal(lied.ok, true);
    const all = await credentials();
    assert.equal(all.some((c) => c.username === "mallory" || c.websiteUrl.includes("evil")), false, "a claimed login or address is ignored");
    assert.ok(all.find((c) => c.username === "hank" && c.websiteUrl === "https://example.com"));

    // plain http pages are not offered, and not saved even if asked directly
    ownChrome.activeTabUrl = "http://example.com/login";
    view = await popupWithAnswer();
    assert.equal(view.saveVisible(), false);
    prompts.length = 0;
    const connectsBefore = ownChrome.connects;
    ownChrome.injections.length = 0;
    const insecure = await new Promise((resolve) => ownChrome.runtime.sendMessage({ type: "save-login" }, resolve));
    assert.deepEqual(insecure, { ok: false, message: "Logins are only saved from secure (https) pages." });
    assert.equal(ownChrome.connects, connectsBefore, "the extension did not even contact the app");
    assert.equal(ownChrome.injections.length, 0, "and did not read the page");
    ownChrome.activeTabUrl = "chrome://extensions/";
    view = await popupWithAnswer();
    assert.equal(view.saveVisible(), false);

    // a locked vault: nobody is asked and nothing is written
    ownChrome.activeTabUrl = "https://example.com/login";
    ownChrome.pageHtml = form("ivy", "ivy-PW");
    assert.equal((await inApp("auth.lockVault()")).ok !== false, true);
    prompts.length = 0;
    const lockedResult = await new Promise((resolve) => ownChrome.runtime.sendMessage({ type: "save-login" }, resolve));
    assert.equal(lockedResult.message, "Secure Login Vault is locked. Unlock it, then try again.");
    assert.equal(prompts.length, 0);
    assert.equal((await inApp(`auth.unlockVault(${JSON.stringify({ masterPassword: MASTER })})`)).ok, true);
    assert.equal((await credentials()).some((c) => c.username === "ivy"), false);
    assert.equal((await credentials()).find((c) => c.username === "carol").password, "carol-PW-1", "saved login survives lock and unlock");

    // Switching off the connection while a question is open aborts the native dialog.
    let pendingPrompt;
    let releasePrompt;
    dialog.showMessageBox = (window, options) => {
      pendingPrompt = options;
      return new Promise((resolve) => { releasePrompt = () => resolve({ response: 1 }); });
    };
    ownChrome.pageHtml = form("cancelled-user", "cancelled-PW");
    const pendingSave = new Promise((resolve) => ownChrome.runtime.sendMessage({ type: "save-login" }, resolve));
    await waitFor(() => Boolean(pendingPrompt), 5000, "pending save confirmation");
    assert.equal((await setBridge(false)).ok, true);
    await waitFor(() => pendingPrompt.signal.aborted, 5000, "confirmation cancellation on disconnect");
    releasePrompt();
    assert.equal((await pendingSave).ok, false);
    assert.equal((await credentials()).some((c) => c.username === "cancelled-user"), false);
    assert.equal((await setBridge(true)).ok, true);

    ownChrome.activeTabUrl = undefined;
  });

  await check("automatic offers use the real native connection: inspect, confirm add/update, suppress duplicates, and never leak passwords", async () => {
    const ask = message => new Promise(resolve => ownChrome.runtime.sendMessage(message, resolve));
    const prompts = [];
    dialog.showMessageBox = async (_window, options) => { prompts.push(options); return { response: 1 }; };
    ownChrome.activeTabUrl = "https://offers.example/login";
    ownChrome.offerState.tab = { id: 42, url: ownChrome.activeTabUrl };
    ownChrome.offerState.allowed = true;
    await ask({ type: "offers-set", enabled: true });
    const capture = password => ownChrome.fromPage({ type: "offer-capture", username: "offer-dummy", password });
    const first = await capture("offer-dummy-one");
    assert.equal(first.offer.mode, "add");
    assert.equal(prompts.length, 0, "inspection doesn't open a desktop prompt");
    assert.equal((await ownChrome.fromPage({ type: "offer-save", token: first.offer.token })).ok, true);
    assert.equal(prompts.length, 1);
    const unchanged = await capture("offer-dummy-one");
    assert.equal(unchanged.offer, undefined);
    const changed = await capture("offer-dummy-two");
    assert.equal(changed.offer.mode, "update");
    assert.equal((await ownChrome.fromPage({ type: "offer-save", token: changed.offer.token })).ok, true);
    assert.equal(prompts.length, 2);
    const matches = (await inApp("credentials.getAll()")).result.filter(c => c.username === "offer-dummy");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].password, "offer-dummy-two");
    assert.equal(JSON.stringify([first, changed, ownChrome.offerState.notices, prompts]).includes("offer-dummy-two"), false);
    await ask({ type: "offers-set", enabled: false });
    ownChrome.activeTabUrl = undefined;
  });

  await check("the same code cannot be used twice", async () => {
    popup.typeCode(code);
    popup.pair();
    await settle(popup, "the second attempt");
    assert.equal(popup.title(), "No code is active");
  });

  await check("a fresh popup is verified on its own (the pairing is remembered)", async () => {
    const fresh = await popupWithAnswer();
    assert.equal(fresh.state(), "connected");
  });

  await check("Check again follows the app being switched off and on", async () => {
    const view = await popupWithAnswer();
    assert.equal(view.state(), "connected");

    assert.equal((await setBridge(false)).ok, true);
    view.button.click();
    await settle(view, "the popup after switching off");
    assert.equal(view.title(), "Not connected");
    assert.equal(view.forgetVisible(), true, "forgetting stays possible while the app is off");

    assert.equal((await setBridge(true)).ok, true);
    view.button.click();
    await settle(view, "the popup after switching on");
    assert.equal(view.title(), "Connected");
  });

  await check("a different extension is refused by the helper", async () => {
    const strangerOrigin = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/";
    const strangerChrome = makeChrome({ connectNativeFor: connectFor(strangerOrigin), store: {} });
    startBackground(strangerChrome);
    const view = await popupWithAnswer(strangerChrome);
    assert.equal(view.state(), "problem");
    assert.equal(view.title(), "Helper does not allow this extension");
  });

  await check("helper not registered: the popup explains", async () => {
    const missingChrome = makeChrome({
      connectNativeFor: (chrome) => () => {
        const disconnectListeners = [];
        setTimeout(() => {
          chrome.runtime.lastError = { message: "Specified native messaging host not found." };
          disconnectListeners.forEach((fn) => fn());
          chrome.runtime.lastError = undefined;
        }, 5);
        return { onMessage: { addListener() {} }, onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) }, postMessage() {}, disconnect() {} };
      },
      store: {}
    });
    startBackground(missingChrome);
    const view = await popupWithAnswer(missingChrome);
    assert.equal(view.title(), "Helper not installed");
  });

  // The stranger/missing checks started other background workers; use our own again.
  startBackground(ownChrome);

  await check("unpairing in the app: the popup notices and offers to pair again", async () => {
    assert.equal((await inApp("settings.unpairExtension()")).ok, true);
    const view = await popupWithAnswer();
    assert.equal(view.state(), "problem");
    assert.equal(view.title(), "Pairing no longer valid");
    assert.equal(view.pairingVisible(), true);
    assert.equal(view.forgetVisible(), true);
  });

  await check("pairing again with a new code works", async () => {
    const view = await popupWithAnswer();
    const started = await inApp("settings.startExtensionPairing()");
    view.typeCode(started.result.code.toLowerCase());
    view.pair();
    await settle(view, "pairing again");
    assert.equal(view.state(), "connected", `${view.title()}: ${view.detail()}`);
  });

  await check("session-only pairing removes the disk entry and still authenticates through the real helper", async () => {
    const request = message => new Promise(resolve => ownChrome.runtime.sendMessage(message, resolve));
    assert.equal((await request({ type: "pairing-storage-set", sessionOnly: true })).sessionOnly, true);
    assert.equal(ownStore.slvPairingSecret, undefined);
    assert.equal((await request({ type: "get-status" })).state, "verified");
    assert.equal((await request({ type: "pairing-storage-set", sessionOnly: false })).sessionOnly, false);
    assert.equal(typeof ownStore.slvPairingSecret, "string");
    assert.equal((await request({ type: "get-status" })).state, "verified");
  });

  await check("Forget in the popup removes this browser's copy of the secret", async () => {
    const view = await popupWithAnswer();
    view.forget();
    await settle(view, "forgetting");
    assert.equal(ownStore.slvPairingSecret, undefined);
    assert.equal(view.title(), "Not paired");
    assert.equal((await inApp("settings.getExtensionPairing()")).result.paired, true, "the app still holds its copy until you unpair there");
    // ...but without the extension's secret nothing connects, and a new code fixes it
    const started = await inApp("settings.startExtensionPairing()");
    view.typeCode(started.result.code);
    view.pair();
    await settle(view, "re-pairing");
    assert.equal(view.state(), "connected");
  });

  await check("the browser connection can be switched off again, ending the link", async () => {
    assert.equal((await setBridge(false)).ok, true);
    const view = await popupWithAnswer();
    assert.equal(view.title(), "Not connected");
  });

  await check("no helper processes are left running", async () => {
    await waitFor(async () => (await countHelpers()) <= helpersBefore, 15000, "helper processes to exit");
  });

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nextension e2e tests FAILED" : "\nextension e2e tests passed");
  try {
    // The app still has files open here, so this is best-effort (it lives in the project's git-ignored .tmp folder).
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    // left for the next cleanup
  }
  app.exit(process.exitCode || 0);
}

app.on("window-all-closed", () => {});

setTimeout(() => {
  console.error("extension e2e test timed out");
  app.exit(1);
}, 300000);

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
