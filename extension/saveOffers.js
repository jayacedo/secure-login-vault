// Optional form-submit offers. Password candidates exist ONLY in this worker's memory:
// never local/sync/session storage. Worker shutdown discards them (offers may expire early).
// Page senders have a separate, narrow protocol and never get vault credentials.
(function (root) {
  const HOSTS = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];
  const PREF = "slvSaveOffers";
  const SCRIPT = "slv-save-offers";
  const TTL = 120000;

  function createSaveOffers({ chrome, link, ready, run, now = Date.now, randomId = () => crypto.randomUUID() }) {
    const pending = new Map();
    let prefs = { enabled: false, blocked: [] };
    let settingsQueue = Promise.resolve();

    function originOf(url) {
      try {
        const u = new URL(url);
        return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) ? u.origin : "";
      } catch { return ""; }
    }
    function permitted(origin) { return prefs.enabled && origin && !prefs.blocked.includes(origin); }
    function drop(tabId) {
      const entry = pending.get(tabId);
      if (entry) { clearTimeout(entry.timer); entry.password = ""; pending.delete(tabId); }
    }
    function clear() { for (const id of pending.keys()) drop(id); }
    function notify(tabId, message) {
      return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {});
    }
    async function broadcast() {
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.map(tab => notify(tab.id, { type: "slv-offers-refresh" })));
    }
    async function syncScripts() {
      const allowed = await chrome.permissions.contains({ origins: HOSTS });
      const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT] });
      if (prefs.enabled && allowed) {
        if (!registered.length) await chrome.scripting.registerContentScripts([{
          id: SCRIPT, matches: HOSTS, js: ["browserApi.js", "readFormInPage.js", "offerContent.js"],
          runAt: "document_start", allFrames: false, world: "ISOLATED", persistAcrossSessions: true
        }]);
      } else {
        if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT] });
        if (!allowed) prefs.enabled = false;
        clear();
      }
    }
    const initialized = ready.then(async () => {
      const stored = (await chrome.storage.local.get(PREF))[PREF];
      prefs = { enabled: stored?.enabled === true, blocked: Array.isArray(stored?.blocked) ? stored.blocked.filter(x => typeof x === "string" && originOf(x) === x).slice(0, 500) : [] };
      await syncScripts();
    });
    // A failed startup fails closed; messages below also await initialized.
    initialized.catch(() => {});

    async function source(sender) {
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id) ||
          (!chrome.isFirefox && (typeof sender.documentId !== "string" || !sender.documentId)) || sender.documentLifecycle === "prerender") return null;
      const origin = originOf(sender.url);
      if (!permitted(origin)) return null;
      try {
        const tab = await chrome.tabs.get(sender.tab.id);
        if (!permitted(origin) || originOf(tab.url) !== origin) return null;
        return { tabId: tab.id, origin };
      } catch { return null; }
    }
    function view(entry) {
      return entry && entry.mode ? { token: entry.token, origin: entry.origin, mode: entry.mode, expires: entry.expires } : null;
    }
    function current(src, token) {
      const entry = pending.get(src.tabId);
      if (entry && (entry.expires <= now() || entry.origin !== src.origin)) { drop(src.tabId); return null; }
      return entry && (!token || entry.token === token) ? entry : null;
    }

    async function page(message, sender) {
      await initialized;
      const src = await source(sender);
      if (!src) return { enabled: false };
      if (message.type === "offer-ready") return { enabled: true, offer: view(current(src)) };
      if (message.type === "offer-capture") {
        const username = typeof message.username === "string" ? message.username.trim() : "";
        if (!username || username.length > 256 || typeof message.password !== "string" || !message.password || message.password.length > 1024) return {};
        const previous = current(src);
        if (previous && now() - previous.created < 1500) return {}; // one candidate per tab, no submit floods
        if (pending.size >= 20 && !previous) return {};
        drop(src.tabId);
        const entry = { origin: src.origin, username, password: message.password, token: randomId(), created: now(), expires: now() + TTL };
        message.password = "";
        entry.timer = setTimeout(() => { if (pending.get(src.tabId) === entry) drop(src.tabId); }, TTL);
        pending.set(src.tabId, entry);
        const result = await run(() => {
          if (current(src) !== entry || !permitted(src.origin)) return { ok: false };
          return link.inspectLogin({ url: entry.origin, username: entry.username, password: entry.password });
        });
        if (current(src) !== entry) return {};
        if (!(await source(sender)) || (!result.ok && !result.locked) || result.mode === "unchanged") { drop(src.tabId); return {}; }
        entry.mode = result.locked ? "locked" : result.mode;
        await notify(src.tabId, { type: "slv-offer", offer: view(entry) });
        return { enabled: true, offer: view(entry) };
      }
      const entry = current(src, message.token);
      if (!entry || typeof message.token !== "string" || entry.busy) return { ok: false, message: "This offer expired. Use Save this login in the extension." };
      if (message.type === "offer-dismiss" || message.type === "offer-never") {
        drop(src.tabId);
        if (message.type === "offer-never") {
          await settings(() => {
            if (!prefs.blocked.includes(src.origin)) prefs.blocked = [...prefs.blocked, src.origin].slice(-500);
            for (const [id, item] of pending) if (item.origin === src.origin) drop(id);
          });
        }
        return { ok: true };
      }
      if (message.type === "offer-save") {
        entry.busy = true;
        const result = await run(async () => {
          if (current(src) !== entry || !(await source(sender))) return { ok: false, message: "The page changed or the offer expired. Nothing was saved." };
          // save-login rechecks the vault, always asks in the desktop app, then checks again.
          return link.saveLogin({ url: entry.origin, username: entry.username, password: entry.password });
        });
        if (pending.get(src.tabId) === entry) drop(src.tabId);
        return { ok: result.ok === true, message: result.ok ? (result.mode === "update" ? "Password updated in SLV." : "Login saved to SLV.") : String(result.message || "Could not save. Unlock SLV and use Save this login in the extension.") };
      }
      return {};
    }

    function settings(change) {
      const next = settingsQueue.then(async () => {
        await initialized;
        await change();
        await syncScripts();
        await chrome.storage.local.set({ [PREF]: prefs });
        await broadcast();
      });
      settingsQueue = next.catch(() => {});
      return next;
    }
    async function popup(message, tab) {
      await initialized;
      const origin = originOf(tab?.url);
      if (message.type === "offers-set") {
        await settings(async () => {
          if (message.enabled === true && !(await chrome.permissions.contains({ origins: HOSTS }))) throw new Error("Permission required");
          prefs.enabled = message.enabled === true;
        });
      } else if (message.type === "offers-allow-site" && origin) {
        await settings(() => { prefs.blocked = prefs.blocked.filter(x => x !== origin); });
      }
      return { enabled: prefs.enabled, blocked: Boolean(origin && prefs.blocked.includes(origin)), host: origin ? new URL(origin).host : "" };
    }
    chrome.tabs.onRemoved.addListener(drop);
    chrome.tabs.onUpdated.addListener((id, change) => {
      if (change.url && pending.has(id) && originOf(change.url) !== pending.get(id).origin) drop(id);
    });
    chrome.permissions.onRemoved.addListener(() => { settings(() => {}).catch(() => {}); });
    return { page, popup, clear, initialized };
  }
  root.SLVSaveOffers = { createSaveOffers, HOSTS };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SLVSaveOffers;
})(typeof self !== "undefined" ? self : globalThis);
