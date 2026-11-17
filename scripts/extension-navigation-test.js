// Synthetic DOMs and browser/native-link mocks only. No profile, vault or network.
const assert = require("assert/strict"), fs = require("fs"), vm = require("vm"), path = require("path");
const { JSDOM } = require("jsdom");
const { addOfferApis } = require("./offerTestUtils");
const read = name => fs.readFileSync(path.join(__dirname, "../extension", name), "utf8");
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; };
async function fixture(firefox) {
  let listener, dom, serial = 0, docId = 0, intercept = null, onFetch = async () => {}, fetches = 0, deadline;
  const chrome = { isFirefox: firefox, runtime: { id: "synthetic", onMessage: { addListener: fn => { listener = fn; } } },
    tabs: { query: (_q, cb) => cb([{ ...state.tab }]) }, scripting: {}, storage: { local: { get: async () => ({}), set: async () => {} } } };
  const state = addOfferApis(chrome); chrome.tabs.onActivated = event();
  chrome.scripting.executeScript = async ({ func, args, target, world }) => {
    assert.equal(world, "ISOLATED");
    if (target.documentIds && !target.documentIds.includes(String(docId))) throw Error("Document changed");
    if (intercept && func.name === "slvFillInPage") { const fn = intercept; intercept = null; fn(); }
    return [{ frameId: 0, documentId: String(docId), result: dom.window.eval(`(${func.toString()})`)(...args) }];
  };
  const link = { fetchLogin: async () => { fetches++; await onFetch(); return { ok: true, username: "synthetic-user", password: "synthetic-secret" }; },
    check: async () => ({ connected: true }), forget: async () => ({ ok: true }), cancelPending() {} };
  const sandbox = { chrome, URL, console, AbortController, clearTimeout,
    setTimeout: (fn, ms) => { if (ms === 75000) deadline = fn; const t = setTimeout(fn, ms); t.unref(); return t; },
    crypto: { randomUUID: () => `test-${++serial}` }, SLVSecretStorage: { createSecretStorage: () => ({ ready: Promise.resolve() }) },
    SLVStatus: { describeStatus: () => ({ ok: false }) }, SLVLink: { createLink: () => link },
    SLVSaveOffers: { createSaveOffers: () => ({ initialized: Promise.resolve(), clear() {} }) },
    SLVInlineFill: { createInlineFill: () => ({ clear() {} }) } };
  sandbox.self = sandbox; const ctx = vm.createContext(sandbox);
  if (firefox) {
    chrome.runtime.getURL = file => `moz-extension://synthetic/${file}`;
    sandbox.browser = { ...chrome, tabs: { ...chrome.tabs, query: async () => [{ ...state.tab }] } };
  }
  // Exercise the real Firefox promise/callback adapter and event forwarding.
  vm.runInContext(read("browserApi.js"), ctx);
  sandbox.importScripts = (...names) => { for (const name of names) if (name === "fillInPage.js") vm.runInContext(read(name), ctx); };
  vm.runInContext(read("background.js"), ctx);
  function page(url = "https://example.test/login") {
    dom?.window.close(); docId++;
    dom = new JSDOM('<form><input name="username" autocomplete="username"><input type="password" name="password"></form>', { url, runScripts: "outside-only" });
    Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get: () => 100 });
    state.tab = { id: 7, url };
  }
  function ask(message, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") }) {
    return new Promise(resolve => { if (!listener(message, sender, resolve)) resolve({ ignored: true }); });
  }
  page();
  return { page, ask, state, chrome, set fetch(fn) { onFetch = fn; }, set beforeFill(fn) { intercept = fn; },
    expire: () => deadline(), invalidate: () => { dom.window.slvPopupFillContext = null; },
    get fetches() { return fetches; }, get password() { return dom.window.document.querySelector('[type="password"]').value; },
    close: () => dom.window.close() };
}
async function main() {
  for (const firefox of [false, true]) {
    for (const scenario of ["normal", "same-origin", "reload", "other-origin", "switch-tab", "forget", "late-reload", "loading", "activate", "timeout", "token"]) {
      const f = await fixture(firefox); let forgotten;
      try {
        f.fetch = async () => {
          if (scenario === "same-origin") f.page("https://example.test/other");
          if (scenario === "reload") f.page();
          if (scenario === "other-origin") f.page("https://other.test/login");
          if (scenario === "switch-tab") f.state.tab = { id: 8, url: "https://example.test/login" };
          if (scenario === "forget") forgotten = f.ask({ type: "forget" });
          if (scenario === "loading") f.chrome.tabs.onUpdated.emit(7, { status: "loading" });
          if (scenario === "activate") f.chrome.tabs.onActivated.emit({ tabId: 8 });
          if (scenario === "timeout") f.expire();
        };
        if (scenario === "late-reload") f.beforeFill = () => f.page();
        if (scenario === "token") f.beforeFill = () => f.invalidate();
        const result = await f.ask({ type: "fill", loginId: 1 });
        if (scenario === "normal") { assert.equal(result.ok, true); assert.equal(f.password, "synthetic-secret"); }
        else { assert.equal(result.ok, false, `${firefox ? "Firefox" : "Chromium"}: ${scenario} must cancel`); assert.equal(f.password, "", scenario); }
        if (forgotten) await forgotten;
      } finally { f.close(); }
    }
    const queued = await fixture(firefox);
    let start, finish;
    const began = new Promise(resolve => { start = resolve; });
    const gate = new Promise(resolve => { finish = resolve; });
    queued.fetch = async () => { start(); await gate; };
    const first = queued.ask({ type: "fill", loginId: 1 }); await began;
    const second = queued.ask({ type: "fill", loginId: 1 });
    queued.state.tab = { id: 8, url: "https://example.test/login" }; finish();
    assert.equal((await first).ok, false); assert.equal((await second).ok, false);
    assert.equal(queued.fetches, 1, "queued click cannot silently retarget another tab"); queued.close();
    console.log(`PASS ${firefox ? "Firefox" : "Chromium"} document-bound popup fill, navigation/tab changes and forget cancellation`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
