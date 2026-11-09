// Background service worker. It is the only part that talks to the browser helper
// (and so the desktop app), and it only answers requests from this extension's own
// pages (the popup). The pairing secret lives only here, in extension storage that
// page scripts cannot read.
importScripts("status.js", "pairing.js", "link.js", "fillInPage.js");

const HOST_NAME = self.SLVStatus.HOST_NAME;
const SECRET_KEY = "slvPairingSecret";
const OPERATION_DEADLINE_MS = 30000; // a hard stop; every request inside has its own, shorter, timeout

const link = self.SLVLink.createLink({
  hostName: HOST_NAME,
  pairing: self.SLVPairing,
  status: self.SLVStatus,
  randomId: () => crypto.randomUUID(),
  connectNative: (host) => chrome.runtime.connectNative(host),
  getLastError: () => (chrome.runtime.lastError ? chrome.runtime.lastError.message : ""),
  storage: {
    get: async () => {
      const stored = await chrome.storage.local.get(SECRET_KEY);
      return stored && typeof stored[SECRET_KEY] === "string" ? stored[SECRET_KEY] : null;
    },
    set: (secretHex) => chrome.storage.local.set({ [SECRET_KEY]: secretHex }),
    clear: () => chrome.storage.local.remove(SECRET_KEY)
  }
});

// ── Filling a login ──────────────────────────────────────────────────────────
// Only ever started by the person pressing Fill in the popup. The tab and its address are
// read here (never taken from the message), the app is asked for that one login for that
// exact origin, and the fill runs in the tab's main page only. The password exists only in
// this function; the answer to the popup never contains it. Nothing is submitted.
const FILL_OPTIONS = { submit: false, layout: true, skipUsernameOnly: false };

function activeTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(!chrome.runtime.lastError && Array.isArray(tabs) && tabs[0] ? tabs[0] : null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

function originOf(address) {
  try {
    const url = new URL(address);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : "";
  } catch (error) {
    return "";
  }
}

function describeFill(status) {
  switch (status) {
    case "filled":
      return { ok: true, status, message: "Filled. Press the site's own Sign in button." };
    case "username-only":
      return { ok: true, status, message: "Filled the username. Continue on the page, then press Fill again for the password." };
    case "no-form":
      return { ok: false, status, message: "No login form was found on this page." };
    case "blocked":
      return { ok: false, status, message: "The page changed, so nothing was filled." };
    default:
      return { ok: false, status: "error", message: "Could not fill this page." };
  }
}

async function fillActiveTab(loginId) {
  const tab = await activeTab();
  const origin = tab && typeof tab.url === "string" ? originOf(tab.url) : "";
  if (!tab || !Number.isSafeInteger(tab.id) || !origin) {
    return { ok: false, status: "error", message: "Open the login page in this tab first." };
  }

  const fetched = await link.fetchLogin({ loginId, url: origin });
  if (!fetched.ok) return { ok: false, status: "error", message: fetched.message };

  let credentials = { username: fetched.username, password: fetched.password };
  fetched.password = "";
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] }, // the main page only, never an embedded frame
      world: "ISOLATED",
      func: slvFillInPage,
      args: [origin, credentials, FILL_OPTIONS]
    });
    const result = Array.isArray(results) && results[0] ? results[0].result : null;
    return describeFill(result && typeof result === "object" ? result.status : "");
  } catch (error) {
    return { ok: false, status: "error", message: "Could not fill this page. Open it again and retry." };
  } finally {
    credentials = null;
  }
}

// One operation at a time, so two popups cannot interleave pairing and checking.
let queue = Promise.resolve();
function runOperation(operation) {
  const run = queue.then(() => withDeadline(operation()));
  queue = run.catch(() => {});
  return run;
}

function withDeadline(promise) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(self.SLVStatus.describeStatus({ ok: false, error: "timeout" }, "")), OPERATION_DEADLINE_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(self.SLVStatus.describeStatus(undefined, ""));
      }
    );
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // ignore anything not from this extension
  if (!message || typeof message !== "object") return false;

  // An optional page address (the popup sends only its origin) asks for matching logins too.
  const url = typeof message.url === "string" ? message.url : "";

  if (message.type === "get-status") {
    runOperation(() => link.check({ url })).then(sendResponse);
  } else if (message.type === "pair" && typeof message.code === "string") {
    runOperation(() => link.pair(message.code, { url })).then(sendResponse);
  } else if (message.type === "forget") {
    runOperation(() => link.forget()).then(sendResponse);
  } else if (message.type === "fill" && Number.isSafeInteger(message.loginId)) {
    // Only the login's id is taken from the popup; the page and its address are read here.
    runOperation(() => fillActiveTab(message.loginId)).then(sendResponse);
  } else {
    return false;
  }
  return true; // the answer is sent asynchronously
});
