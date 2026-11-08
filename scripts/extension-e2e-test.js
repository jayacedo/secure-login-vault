// End-to-end test of the browser extension, with everything real except Chrome itself:
//
//   extension popup.js -> extension background.js -> real launcher (.bat) ->
//   real helper (host.js in Electron's Node mode) -> real named pipe ->
//   the real app (src/main.js) with its Settings switch
//
// Chrome is replaced by a small stand-in that does what Chrome's native messaging does:
// starts the registered launcher with the calling extension's origin, sends one framed
// message, and hands back the first framed reply.
//   npm run test:e2e
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");
const { JSDOM } = require("jsdom");
const { app, BrowserWindow } = require("electron");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "slv-e2e-"));
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

// What Chrome does for chrome.runtime.sendNativeMessage(host, message, callback).
function makeChromeNativeMessaging({ launcherPath, origin }) {
  return function sendNativeMessage(host, message, callback) {
    assert.equal(host, registration.HOST_NAME, "the extension asks for the registered helper");

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(`"${launcherPath}" "${origin}"`, { shell: true, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    let done = false;
    const finish = (reply, errorMessage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* already closed */ }
      setTimeout(() => child.kill(), 2000).unref();
      callback(reply, errorMessage);
    };
    const timer = setTimeout(() => finish(undefined, "Native host has exited."), 20000);

    const reader = createMessageReader({
      onMessage: (value) => finish(value),
      onError: () => finish(undefined, "Error when communicating with the native messaging host.")
    });
    child.stdout.on("data", (chunk) => reader.push(chunk));
    child.on("exit", () => finish(undefined, "Native host has exited."));
    child.stdin.write(encodeMessage(message));
  };
}

// A fake `chrome` for the extension, wired to the stand-in above.
function makeChrome(sendNative) {
  const listeners = [];
  const chrome = {
    runtime: {
      id: "e2e-extension-id",
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendNativeMessage(host, message, callback) {
        sendNative(host, message, (reply, errorMessage) => {
          chrome.runtime.lastError = errorMessage ? { message: errorMessage } : undefined;
          try { callback(reply); } finally { chrome.runtime.lastError = undefined; }
        });
      },
      // Used by the popup: delivered to the background worker's listener.
      sendMessage(message, callback) {
        const sender = { id: chrome.runtime.id };
        const keptOpen = listeners[0](message, sender, (response) => callback(response));
        assert.equal(keptOpen, true, "the background worker answers asynchronously");
      }
    }
  };
  return chrome;
}

function startBackground(chrome) {
  const sandbox = { chrome, crypto: { randomUUID: () => require("crypto").randomUUID() }, console, setTimeout, clearTimeout, String, Promise, Object };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (file) => vm.runInContext(readExtensionFile(file), context, { filename: file });
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
  const setBridge = (enabled) =>
    win.webContents.executeJavaScript(`window.secureLoginVault.settings.setExtensionBridge({ enabled: ${enabled} })`);

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
  const ownChrome = makeChrome(makeChromeNativeMessaging({ launcherPath: registered.launcherPath, origin: ownOrigin }));
  startBackground(ownChrome);

  const helpersBefore = await countHelpers();

  // Opens the popup and waits until it has an answer.
  const popupWithAnswer = async (chrome = ownChrome) => {
    const popup = openPopup(chrome);
    await waitFor(() => popup.settled(), 30000, "the popup to show an answer");
    return popup;
  };

  await check("the app's browser connection is off: the popup says so", async () => {
    const popup = await popupWithAnswer();
    assert.equal(popup.state(), "problem");
    assert.equal(popup.title(), "Not connected");
    assert.match(popup.detail(), /Browser Extension/);
  });

  await check("switched on in the app: the popup shows Connected and the app version", async () => {
    assert.equal((await setBridge(true)).ok, true);
    const popup = await popupWithAnswer();
    assert.equal(popup.state(), "connected");
    assert.equal(popup.title(), "Connected");
    assert.equal(popup.detail(), `Secure Login Vault ${app.getVersion()}`);
  });

  await check("Check again follows the app being switched off and on", async () => {
    const popup = await popupWithAnswer();
    assert.equal(popup.state(), "connected");

    assert.equal((await setBridge(false)).ok, true);
    popup.button.click();
    await waitFor(() => popup.settled(), 30000, "the popup after switching off");
    assert.equal(popup.title(), "Not connected");

    assert.equal((await setBridge(true)).ok, true);
    popup.button.click();
    await waitFor(() => popup.settled(), 30000, "the popup after switching on");
    assert.equal(popup.title(), "Connected");
  });

  await check("a different extension is refused by the helper", async () => {
    const strangerOrigin = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/";
    const strangerChrome = makeChrome(makeChromeNativeMessaging({ launcherPath: registered.launcherPath, origin: strangerOrigin }));
    startBackground(strangerChrome);
    const popup = await popupWithAnswer(strangerChrome);
    assert.equal(popup.state(), "problem");
    assert.equal(popup.title(), "Helper does not allow this extension");
  });

  await check("helper not registered: the popup explains", async () => {
    const missingChrome = makeChrome((host, message, callback) => callback(undefined, "Specified native messaging host not found."));
    startBackground(missingChrome);
    const popup = await popupWithAnswer(missingChrome);
    assert.equal(popup.state(), "problem");
    assert.equal(popup.title(), "Helper not installed");
  });

  await check("the browser connection can be switched off again, ending the link", async () => {
    assert.equal((await setBridge(false)).ok, true);
    const popup = await popupWithAnswer();
    assert.equal(popup.title(), "Not connected");
  });

  await check("no helper processes are left running", async () => {
    await waitFor(async () => (await countHelpers()) <= helpersBefore, 15000, "helper processes to exit");
  });

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nextension e2e tests FAILED" : "\nextension e2e tests passed");
  try {
    // The app still has files open here, so this is best-effort (it lives in the OS temp folder).
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    // left for the OS temp cleanup
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
