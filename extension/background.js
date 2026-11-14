// Background worker (Chromium) or event page (Firefox). Only this context talks to the helper
// (and so the desktop app). The popup has privileged routes; optional content scripts
// have only the scoped save-offer and inline-fill protocols. The pairing secret is in trusted storage.
if (typeof importScripts === "function") importScripts("browserApi.js", "privateStorage.js", "status.js", "pairing.js", "secureChannel.js", "secretStorage.js", "link.js", "fillInPage.js", "readFormInPage.js", "saveOffers.js", "inlineFill.js");

const extensionApi = self.SLVApi || chrome;

// Content scripts must never be able to read the pairing secret or its storage mode.
// Fail closed if the browser cannot establish this boundary.
const secretStorage = self.SLVSecretStorage.createSecretStorage(extensionApi);
const trustedStorage = secretStorage.ready;
trustedStorage.catch(() => {});

const HOST_NAME = self.SLVStatus.HOST_NAME;
// Covers four verification requests (8s each), then a confirmation request (35s).
const OPERATION_DEADLINE_MS = 75000;

const link = self.SLVLink.createLink({
  hostName: HOST_NAME,
  browserName: extensionApi.isFirefox ? "Firefox" : (/Edg\//.test(globalThis.navigator?.userAgent || "") ? "Microsoft Edge" : "Google Chrome"),
  pairing: self.SLVPairing,
  status: self.SLVStatus,
  randomId: () => crypto.randomUUID(),
  connectNative: (host) => extensionApi.runtime.connectNative(host),
  getLastError: () => (extensionApi.runtime.lastError ? extensionApi.runtime.lastError.message : ""),
  storage: secretStorage
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
      extensionApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(!extensionApi.runtime.lastError && Array.isArray(tabs) && tabs[0] ? tabs[0] : null);
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
    const results = await extensionApi.scripting.executeScript({
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

// ── Saving a login ───────────────────────────────────────────────────────────
// Manual save starts when the person presses "Save this login" in the popup. The page is read once,
// now, in its main frame, and what was read goes to the app only, which always asks the person.
// A missing username may be entered in the trusted popup. Passwords are always
// freshly read from the same document; they are never returned to the popup.
const saveRetries = new Map();
function dropSaveRetry(id) {
  clearTimeout(saveRetries.get(id)?.timer);
  saveRetries.delete(id);
}
extensionApi.tabs.onRemoved.addListener(dropSaveRetry);
extensionApi.tabs.onUpdated.addListener((id, change) => {
  if (change.url || change.status === "loading") dropSaveRetry(id);
});
function describeSave(result) {
  if (result.ok) {
    return { ok: true, message: result.mode === "update" ? "Password updated in Secure Login Vault." : "Saved to Secure Login Vault." };
  }
  return { ok: false, message: result.message };
}

const READ_PROBLEMS = {
  blocked: "The page changed, so nothing was saved.",
  "no-form": "No login form was found on this page. Type your login on the page first.",
  empty: "Type your password on the page first, then press Save.",
  ambiguous: "This page has several different passwords typed in (a change-password form?). Nothing was saved.",
  "no-username": "Type your username or email on the page first, then press Save.",
  "too-long": "The username or password is too long to save."
};

// Secure pages only (plain http only for this computer). The app checks again.
function canSaveFrom(address) {
  try {
    const url = new URL(address);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch (error) {
    return false;
  }
}

async function saveActiveTab(message = {}) {
  await offers.initialized;
  const tab = await activeTab();
  const origin = tab && typeof tab.url === "string" ? originOf(tab.url) : "";
  if (!tab || !Number.isSafeInteger(tab.id) || !origin) {
    return { ok: false, message: "Open the login page in this tab first." };
  }
  if (!canSaveFrom(origin)) {
    return { ok: false, message: "Logins are only saved from secure (https) pages." };
  }
  const retry = saveRetries.get(tab.id);
  const supplied = message.type === "save-login-username";
  if (supplied && (!retry || retry.token !== message.token || retry.url !== tab.url || retry.expires <= Date.now() ||
      typeof message.username !== "string" || !message.username.trim() || message.username.trim().length > 256)) {
    dropSaveRetry(tab.id);
    return { ok: false, message: "The page changed or the request expired. Press Save this login again." };
  }
  dropSaveRetry(tab.id);
  const token = crypto.randomUUID();

  let read;
  try {
    const results = await extensionApi.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] }, // the main page only, never an embedded frame
      world: "ISOLATED",
      func: slvReadFormInPage,
      args: [origin, null, supplied ? { username: message.username, verifyToken: retry.token } : { contextToken: token, readUsernameStep: true }]
    });
    read = Array.isArray(results) && results[0] ? results[0].result : null;
  } catch (error) {
    return { ok: false, message: "Could not read this page. Open it again and retry." };
  }
  if (!read || typeof read !== "object") return { ok: false, message: "Could not read this page. Open it again and retry." };
  // Recheck after injection: do not save a result from a tab that navigated.
  const currentTab = await activeTab();
  if (currentTab?.id !== tab.id || currentTab?.url !== tab.url) return { ok: false, message: READ_PROBLEMS.blocked };
  if (read.status === "username-only") {
    offers.rememberUsername(tab.id, origin, read.username);
    return { ok: false, message: "Username remembered for two minutes in this tab. Continue to the password step, then press Save this login." };
  }
  if (read.status === "no-username") {
    saveRetries.set(tab.id, { token, url: tab.url, expires: Date.now() + 120000, timer: setTimeout(() => dropSaveRetry(tab.id), 120000) });
    return { ok: false, needsUsername: true, token, username: offers.getUsername(tab.id, origin), message: "Confirm your username or email below, then save. The password stays on the page until you continue." };
  }
  if (read.status !== "read") return { ok: false, message: READ_PROBLEMS[read.status] || "Could not read this page." };

  let request = { url: origin, username: read.username, password: read.password };
  read.password = "";
  offers.forgetUsername(tab.id);
  try {
    return describeSave(await link.saveLogin(request));
  } finally {
    request = null;
  }
}

// One operation at a time, so two popups cannot interleave pairing and checking.
let queue = Promise.resolve();
function runOperation(operation) {
  const run = queue.then(() => trustedStorage).then(() => withDeadline(operation()));
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

const offers = self.SLVSaveOffers.createSaveOffers({ chrome: extensionApi, link, ready: trustedStorage, run: runOperation });
const inline = self.SLVInlineFill.createInlineFill({ chrome: extensionApi, link, ready: trustedStorage, run: runOperation,
  fill: async (loginId, ticket, stillCurrent) => {
    const fetched = await link.fetchLogin({ loginId, url: ticket.origin });
    if (!fetched.ok) return { ok: false, message: fetched.message };
    let credentials = { username: fetched.username, password: fetched.password };
    fetched.password = "";
    try {
      if (!(await stillCurrent())) return describeFill("blocked");
      const target = extensionApi.isFirefox ? { tabId: ticket.tabId, frameIds: [0] } : { tabId: ticket.tabId, documentIds: [ticket.documentId] };
      const results = await extensionApi.scripting.executeScript({ target, world: "ISOLATED", func: slvFillInPage,
        args: [ticket.origin, credentials, { ...FILL_OPTIONS, inlineToken: ticket.token }] });
      return describeFill(results?.[0]?.result?.status);
    } catch { return describeFill("blocked"); }
    finally { credentials = null; }
  }
});

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== extensionApi.runtime.id) return false; // ignore anything not from this extension
  if (!message || typeof message !== "object") return false;

  // Content scripts get only the scoped offer/inline protocols, never popup
  // privileges. Inline choices contain metadata; passwords never return in messages.
  // Browser-supplied extension URL identifies our packaged popup, including
  // when opened as a tab. Website content scripts cannot claim this URL.
  if (sender.url !== extensionApi.runtime.getURL("popup.html")) {
    if (!sender.tab) return false;
    if (["inline-ready", "inline-list", "inline-fill", "inline-dismiss"].includes(message.type)) {
      inline.page(message, sender).then(sendResponse, () => sendResponse({ ok: false, message: "Could not reach SLV. Open the extension to check pairing." }));
      return true;
    }
    if (!["offer-ready", "offer-username", "offer-capture", "offer-save", "offer-dismiss", "offer-never"].includes(message.type)) return false;
    offers.page(message, sender).then(sendResponse, () => sendResponse({ enabled: false }));
    return true;
  }
  if (["pairing-storage-get", "pairing-storage-set"].includes(message.type)) {
    runOperation(async () => {
      if (message.type === "pairing-storage-set") await secretStorage.setSessionOnly(message.sessionOnly);
      return { sessionOnly: await secretStorage.sessionOnly() };
    }).then(sendResponse, () => sendResponse({ error: true }));
    return true;
  }
  if (["offers-get", "offers-set", "offers-allow-site"].includes(message.type)) {
    activeTab().then(tab => offers.popup(message, tab)).then(sendResponse, () => sendResponse({ error: true }));
    return true;
  }
  if (["inline-get", "inline-set"].includes(message.type)) {
    inline.popup(message).then(sendResponse, () => sendResponse({ error: true }));
    return true;
  }

  // An optional page address (the popup sends only its origin) asks for matching logins too.
  const url = typeof message.url === "string" ? message.url : "";

  if (message.type === "get-status") {
    runOperation(() => link.check({ url })).then(sendResponse);
  } else if (message.type === "pair" && typeof message.code === "string") {
    runOperation(() => link.pair(message.code, { url })).then(sendResponse);
  } else if (message.type === "forget") {
    for (const id of saveRetries.keys()) dropSaveRetry(id);
    offers.clear();
    inline.clear();
    runOperation(() => link.forget()).then(sendResponse);
  } else if (message.type === "fill" && Number.isSafeInteger(message.loginId)) {
    // Only the login's id is taken from the popup; the page and its address are read here.
    runOperation(() => fillActiveTab(message.loginId)).then(sendResponse);
  } else if (message.type === "save-login" || message.type === "save-login-username") {
    runOperation(() => saveActiveTab(message)).then(sendResponse);
  } else if (message.type === "save-login-cancel") {
    for (const [id, entry] of saveRetries) if (entry.token === message.token) { dropSaveRetry(id); offers.forgetUsername(id); }
    sendResponse({ ok: true });
  } else {
    return false;
  }
  return true; // the answer is sent asynchronously
});
