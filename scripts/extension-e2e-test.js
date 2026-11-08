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
const { app, BrowserWindow } = require("electron");

const userData = fs.mkdtempSync(path.join(testTempRoot(), "slv-e2e-"));
app.setPath("userData", userData);
// Own pipe for the app AND the helper, so a real running app is never touched.
process.env.SLV_PIPE_USER = `e2e-${process.pid}`;
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
      connectNative: (host) => connectNativeFor(chrome)(host),
      // Used by the popup: delivered to the background worker's listener.
      sendMessage(message, callback) {
        const sender = { id: chrome.runtime.id };
        const keptOpen = listeners[0](message, sender, (response) => callback(response));
        assert.equal(keptOpen, true, "the background worker answers asynchronously");
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
  return chrome;
}

function startBackground(chrome) {
  const sandbox = {
    chrome,
    crypto: { randomUUID: () => crypto.randomUUID(), subtle: crypto.webcrypto.subtle, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) },
    console, setTimeout, clearTimeout, TextEncoder, Uint8Array, String, Promise, Object, Array, JSON, Error, parseInt
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => files.forEach((file) => vm.runInContext(readExtensionFile(file), context, { filename: file }));
  vm.runInContext(readExtensionFile("background.js"), context, { filename: "background.js" });
}

function openPopup(chrome) {
  const html = readExtensionFile("popup.html").replace(/<script[^>]*><\/script>/, "").replace(/<link[^>]*>/, "");
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
