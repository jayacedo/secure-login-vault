// Shared entry points use promises, with callbacks retained for the popup.
// Firefox's browser namespace is promise-based; chrome remains unchanged.
(function (root) {
  if (typeof browser === "undefined" || !browser.runtime.getURL("").startsWith("moz-extension:")) {
    root.SLVApi = chrome;
    return;
  }
  let callbackError;
  function hybrid(owner, method) {
    return (...args) => {
      const callback = typeof args.at(-1) === "function" ? args.pop() : null;
      const pending = owner[method](...args);
      if (!callback) return pending;
      pending.then(value => callback(value), error => {
        callbackError = { message: String(error?.message || "Browser request failed") };
        try { callback(); } finally { callbackError = undefined; }
      });
    };
  }
  root.SLVApi = {
    isFirefox: true,
    runtime: {
      id: browser.runtime.id,
      get lastError() { return callbackError; },
      getURL: path => browser.runtime.getURL(path),
      connectNative: name => browser.runtime.connectNative(name),
      onMessage: browser.runtime.onMessage,
      sendMessage: hybrid(browser.runtime, "sendMessage")
    },
    tabs: {
      query: hybrid(browser.tabs, "query"),
      get: id => browser.tabs.get(id),
      sendMessage: (...args) => browser.tabs.sendMessage(...args),
      onUpdated: browser.tabs?.onUpdated,
      onRemoved: browser.tabs?.onRemoved
    },
    storage: browser.storage,
    permissions: browser.permissions,
    scripting: browser.scripting
  };
})(globalThis);
