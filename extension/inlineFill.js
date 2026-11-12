(function (root) {
  const HOSTS = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];
  const PREF = "slvInlineFill";
  const SCRIPT = "slv-inline-fill";
  const TTL = 60000;
  function createInlineFill({ chrome, link, ready, run, fill, now = Date.now, randomId = () => crypto.randomUUID() }) {
    let enabled = false;
    let generation = 0;
    let settingsQueue = Promise.resolve();
    const tickets = new Map();
    const recent = new Map();
    function clear() { generation++; tickets.clear(); recent.clear(); }
    function originOf(address) {
      try { const u = new URL(address); return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) ? u.origin : ""; }
      catch { return ""; }
    }
    async function sync() {
      const allowed = await chrome.permissions.contains({ origins: HOSTS });
      const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT] });
      if (enabled && allowed) {
        if (!scripts.length) await chrome.scripting.registerContentScripts([{
          id: SCRIPT, matches: HOSTS, js: ["browserApi.js", "inlineContent.js"],
          allFrames: false, runAt: "document_idle", world: "ISOLATED", persistAcrossSessions: true
        }]);
      } else {
        if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT] });
        if (!allowed) enabled = false;
        clear();
      }
    }
    const initialized = ready.then(async () => { enabled = (await chrome.storage.local.get(PREF))[PREF] === true; await sync(); });
    initialized.catch(() => {});
    async function source(sender) {
      if (!enabled || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isSafeInteger(sender.tab?.id) ||
          (!chrome.isFirefox && !sender.documentId) || sender.documentLifecycle === "prerender") return null;
      const origin = originOf(sender.url);
      if (!origin) return null;
      try {
        const [tab, active, allowed] = await Promise.all([
          chrome.tabs.get(sender.tab.id), chrome.tabs.query({ active: true, currentWindow: true }),
          chrome.permissions.contains({ origins: HOSTS })
        ]);
        if (!enabled || !allowed || tab.url !== sender.url || active[0]?.id !== tab.id) return null;
        return { tabId: tab.id, url: tab.url, origin, documentId: sender.documentId || "" };
      } catch { return null; }
    }
    const expired = () => ({ ok: false, message: "This chooser expired or the page changed. Open SLV beside the field again." });
    async function page(message, sender) {
      await initialized;
      const src = await source(sender);
      if (!src) return { enabled: false, ...expired() };
      if (message.type === "inline-ready") return { enabled: true };
      if (message.type === "inline-dismiss") { if (tickets.get(src.tabId)?.token === message.token) tickets.delete(src.tabId); return {}; }
      if (message.type === "inline-list") {
        // Bounded, memory-only choices. Never fetch a password just to show a list.
        for (const [id, value] of recent) if (now() - value > TTL) recent.delete(id);
        for (const [id, value] of tickets) if (value.expires <= now()) tickets.delete(id);
        if (recent.size >= 100 || (recent.has(src.tabId) && now() - recent.get(src.tabId) < 1000)) return { ok: false, message: "Please wait a moment, then try again." };
        recent.set(src.tabId, now()); tickets.delete(src.tabId);
        const result = await run(async () => (await source(sender)) ? link.check({ url: src.origin }) : {});
        if (!(await source(sender))) return expired();
        if (!result.connected || result.site?.state !== "ok") return { ok: false,
          message: result.site?.state === "locked" ? "SLV is locked. Unlock the desktop app, then try again." : String(result.detail || "Open SLV and check pairing in the extension.") };
        const logins = (result.site.logins || []).filter(x => Number.isSafeInteger(x.id)).slice(0, 20)
          .map(x => ({ id: x.id, name: String(x.name || "Login").slice(0, 200), username: String(x.username || "").slice(0, 256) }));
        const ticket = { ...src, generation, token: randomId(), ids: logins.map(x => x.id), expires: now() + TTL };
        tickets.set(src.tabId, ticket);
        return { ok: true, logins, token: ticket.token, expires: ticket.expires, origin: src.origin };
      }
      if (message.type === "inline-fill") {
        const ticket = tickets.get(src.tabId);
        if (!ticket || ticket.token !== message.token || ticket.url !== src.url || ticket.documentId !== src.documentId ||
            ticket.expires <= now() || !ticket.ids.includes(message.loginId)) return expired();
        tickets.delete(src.tabId); // one use, including declines or failures
        return run(async () => {
          if (ticket.expires <= now() || !(await source(sender))) return expired();
          return fill(message.loginId, ticket, async () => ticket.generation === generation && Boolean(await source(sender)));
        });
      }
      return {};
    }
    async function popup(message) {
      await initialized;
      if (message.type === "inline-set") {
        const next = settingsQueue.then(async () => {
          if (message.enabled === true && !(await chrome.permissions.contains({ origins: HOSTS }))) throw Error("Website access required");
          enabled = message.enabled === true; clear(); await sync();
          await chrome.storage.local.set({ [PREF]: enabled });
          const tabs = await chrome.tabs.query({});
          await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: "slv-inline-refresh" }, { frameId: 0 }).catch(() => {})));
        });
        settingsQueue = next.catch(() => {}); await next;
      }
      return { enabled };
    }
    chrome.tabs.onRemoved.addListener(id => { tickets.delete(id); recent.delete(id); });
    chrome.tabs.onUpdated.addListener((id, change) => { if (change.url || change.status === "loading") tickets.delete(id); });
    chrome.permissions.onRemoved.addListener(() => {
      chrome.permissions.contains({ origins: HOSTS }).then(allowed => {
        if (!allowed) return popup({ type: "inline-set", enabled: false });
      }).catch(() => { enabled = false; clear(); sync().catch(() => {}); });
    });
    return { page, popup, clear, initialized };
  }
  root.SLVInlineFill = { createInlineFill, HOSTS };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SLVInlineFill;
})(typeof self !== "undefined" ? self : globalThis);
