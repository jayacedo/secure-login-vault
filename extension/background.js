// Background service worker. It is the only part that talks to the browser helper,
// and it only answers requests from this extension's own pages (the popup).
importScripts("status.js");

const HOST_NAME = self.SLVStatus.HOST_NAME;
const describeStatus = self.SLVStatus.describeStatus;
const ANSWER_TIMEOUT_MS = 12000; // the helper gives up after 10 s on its own

// Asks the desktop app "are you there?" through the helper and returns a status
// object (never rejects, never throws).
function checkConnection() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(status);
    };
    const timer = setTimeout(() => finish(describeStatus({ ok: false, error: "timeout" }, "")), ANSWER_TIMEOUT_MS);

    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, { id: crypto.randomUUID(), type: "ping" }, (reply) => {
        const runtimeError = chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
        finish(describeStatus(reply, runtimeError));
      });
    } catch (error) {
      // The call itself failed (not the helper): show the generic "no answer" state.
      finish(describeStatus(undefined, ""));
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // ignore anything not from this extension
  if (!message || message.type !== "get-status") return false;

  checkConnection().then(sendResponse);
  return true; // the answer is sent asynchronously
});
