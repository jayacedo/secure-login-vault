// Background service worker. It is the only part that talks to the browser helper
// (and so the desktop app), and it only answers requests from this extension's own
// pages (the popup). The pairing secret lives only here, in extension storage that
// page scripts cannot read.
importScripts("status.js", "pairing.js", "link.js");

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

  if (message.type === "get-status") {
    runOperation(() => link.check()).then(sendResponse);
  } else if (message.type === "pair" && typeof message.code === "string") {
    runOperation(() => link.pair(message.code)).then(sendResponse);
  } else if (message.type === "forget") {
    runOperation(() => link.forget()).then(sendResponse);
  } else {
    return false;
  }
  return true; // the answer is sent asynchronously
});
