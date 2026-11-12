const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { createSaveOffers, HOSTS } = require("../extension/saveOffers");
const { addOfferApis } = require("./offerTestUtils");
const read = file => fs.readFileSync(path.join(__dirname, "../extension", file), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sender = { id: "test", tab: { id: 7 }, url: "https://example.com/login", frameId: 0, documentId: "one", documentLifecycle: "active" };

async function fixture({ enabled = true, allowed = true, inspect } = {}) {
  let time = 1000;
  let serial = 0;
  const store = { slvSaveOffers: { enabled, blocked: [] } };
  const calls = [];
  const chrome = {
    runtime: { id: "test" }, tabs: { query: (_q, cb) => cb([state.tab]) }, scripting: {},
    storage: { local: { get: async key => ({ [key]: store[key] }), set: async values => Object.assign(store, JSON.parse(JSON.stringify(values))) } }
  };
  const state = addOfferApis(chrome, { allowed });
  const link = {
    inspectLogin: async request => { calls.push(["inspect", { ...request }]); return inspect ? inspect(request) : { ok: true, mode: "add" }; },
    saveLogin: async request => { calls.push(["save", { ...request }]); return { ok: true, mode: "add" }; }
  };
  const api = createSaveOffers({ chrome, link, ready: Promise.resolve(), run: fn => fn(), now: () => time, randomId: () => "token-" + ++serial });
  await api.initialized;
  return { api, chrome, state, store, calls, link, advance: ms => { time += ms; }, capture: (extra = {}, from = sender) => api.page({ type: "offer-capture", username: "alice", password: "dummy-secret", ...extra }, from) };
}

async function workerTests() {
  let f = await fixture({ enabled: false });
  try {
    assert.equal(f.state.registered.length, 0);
    assert.deepEqual(await f.capture(), { enabled: false });
    assert.equal(f.calls.length, 0);
    f.state.allowed = false;
    await assert.rejects(f.api.popup({ type: "offers-set", enabled: true }, f.state.tab));
    f.state.allowed = true;
    assert.equal((await f.api.popup({ type: "offers-set", enabled: true }, f.state.tab)).enabled, true);
    assert.deepEqual(f.state.registered[0].matches, HOSTS);
    assert.equal(f.state.registered[0].allFrames, false);
    assert.equal(f.state.registered[0].world, "ISOLATED");
  } finally { f.api.clear(); }

  f = await fixture();
  try {
    for (const bad of [{ ...sender, id: "stranger" }, { ...sender, frameId: 1 }, { ...sender, documentId: "" },
      { ...sender, documentLifecycle: "prerender" }, { ...sender, url: "http://example.com" },
      { ...sender, url: "https://other.com" }, { ...sender, tab: { id: 99 } }]) {
      assert.deepEqual(await f.capture({}, bad), { enabled: false });
    }
    for (const bad of [{ username: "" }, { username: "x".repeat(257) }, { password: "" }, { password: "x".repeat(1025) }]) await f.capture(bad);
    assert.equal(f.calls.length, 0);
    const first = await f.capture({ url: "https://evil.test", origin: "https://evil.test" });
    assert.equal(first.offer.origin, "https://example.com", "only browser sender metadata sets the origin");
    assert.deepEqual(f.calls[0][1], { url: "https://example.com", username: "alice", password: "dummy-secret" });
    assert.equal(JSON.stringify([first, f.store, f.state.notices]).includes("dummy-secret"), false, "no password in offers, preferences or tab messages");
    assert.equal(JSON.stringify(first).includes("alice"), false, "no username leaked from the vault to a page");
    await f.capture();
    assert.equal(f.calls.length, 1, "rapid submits are coalesced");
    // Same-origin navigation can recover the candidate, but cannot choose another tab's token.
    f.state.tab.url = "https://example.com/dashboard";
    const redirected = { ...sender, url: f.state.tab.url, documentId: "two" };
    assert.equal((await f.api.page({ type: "offer-ready" }, redirected)).offer.token, first.offer.token);
    await f.api.page({ type: "offer-save", token: "guessed" }, redirected);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.api.page({ type: "offer-save", token: first.offer.token, password: "tampered" }, redirected)).ok, true);
    assert.equal(f.calls[1][1].password, "dummy-secret", "save uses retained candidate, not page-provided fields");
    await f.api.page({ type: "offer-save", token: first.offer.token }, redirected);
    assert.equal(f.calls.length, 2, "one-shot save token");
    assert.equal((await f.api.page({ type: "offer-ready" }, redirected)).offer, null);

    const dismissed = await f.capture({}, redirected);
    await f.api.page({ type: "offer-dismiss", token: dismissed.offer.token }, redirected);
    assert.equal((await f.api.page({ type: "offer-ready" }, redirected)).offer, null);
    const expired = await f.capture({}, redirected);
    f.advance(120001);
    assert.equal((await f.api.page({ type: "offer-save", token: expired.offer.token }, redirected)).ok, false);
    assert.equal(f.calls.filter(c => c[0] === "save").length, 1);

    const never = await f.capture({}, redirected);
    await f.api.page({ type: "offer-never", token: never.offer.token }, redirected);
    assert.deepEqual(f.store.slvSaveOffers.blocked, ["https://example.com"]);
    assert.deepEqual(await f.capture({}, redirected), { enabled: false });
    assert.equal((await f.api.popup({ type: "offers-get" }, f.state.tab)).blocked, true);
    await f.api.popup({ type: "offers-allow-site" }, f.state.tab);
    await f.capture({}, redirected);
    await f.api.popup({ type: "offers-set", enabled: false }, f.state.tab);
    assert.equal(f.state.registered.length, 0);
    await f.api.popup({ type: "offers-set", enabled: true }, f.state.tab);
    assert.equal((await f.api.page({ type: "offer-ready" }, redirected)).offer, null, "disable discards candidates");
    await f.capture({}, redirected);
    f.chrome.tabs.onUpdated.emit(7, { url: "https://elsewhere.test" });
    assert.equal((await f.api.page({ type: "offer-ready" }, redirected)).offer, null);
    await f.capture({}, redirected);
    f.chrome.tabs.onRemoved.emit(7);
    assert.equal((await f.api.page({ type: "offer-ready" }, redirected)).offer, null);
    f.state.allowed = false;
    f.chrome.permissions.onRemoved.emit({ origins: HOSTS });
    await tick();
    assert.equal((await f.api.popup({ type: "offers-get" }, f.state.tab)).enabled, false);
  } finally { f.api.clear(); }

  for (const result of [{ ok: true, mode: "unchanged" }, { ok: false }, { ok: true, mode: "update" }, { ok: false, locked: true }]) {
    f = await fixture({ inspect: () => result });
    try {
      const reply = await f.capture();
      assert.equal(Boolean(reply.offer), result.mode === "update" || result.locked === true);
      if (reply.offer) assert.equal(reply.offer.mode, result.locked ? "locked" : "update");
      assert.equal(f.calls.filter(c => c[0] === "save").length, 0);
    } finally { f.api.clear(); }
  }
  // A late classification must not resurrect an expired/dismissed/navigated candidate.
  let finish;
  f = await fixture({ inspect: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const capturing = f.capture();
    await tick();
    f.chrome.tabs.onUpdated.emit(7, { url: "https://other.com" });
    finish({ ok: true, mode: "add" });
    assert.deepEqual(await capturing, {});
    assert.equal(f.state.notices.length, 0);
  } finally { f.api.clear(); }
}

async function contentTests() {
  const dom = new JSDOM('<form id="login"><input autocomplete="username" value="alice"><input type="password" value="dummy-pw"><button>Log in</button></form><form><input type="password" value="other-password"></form>', { url: "https://example.com/login", runScripts: "outside-only" });
  const w = dom.window;
  const calls = [];
  const handlers = {};
  const shadows = [];
  let receive;
  const original = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, fn, options) => { handlers[type] = fn; original(type, fn, options); };
  const attach = w.HTMLElement.prototype.attachShadow;
  w.HTMLElement.prototype.attachShadow = function (options) { const shadow = attach.call(this, options); shadows.push(shadow); return shadow; };
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { get: () => 100 });
  w.chrome = { runtime: { id: "test", onMessage: { addListener: fn => { receive = fn; } }, sendMessage: async message => { calls.push({ ...message }); return message.type === "offer-ready" ? { enabled: true } : { ok: true, message: "Saved" }; } } };
  w.eval(read("readFormInPage.js"));
  w.eval(read("offerContent.js"));
  try {
    await tick();
    const form = w.document.getElementById("login");
    handlers.click({ isTrusted: false, target: form.querySelector("button") });
    handlers.submit({ isTrusted: true, target: form });
    handlers.click({ isTrusted: true, target: form.querySelector("button") });
    handlers.submit({ isTrusted: false, target: form });
    assert.equal(calls.filter(c => c.type === "offer-capture").length, 0, "synthetic submissions and gestures cannot capture");
    handlers.submit({ isTrusted: true, target: form });
    assert.deepEqual(calls.find(c => c.type === "offer-capture"), { type: "offer-capture", username: "alice", password: "dummy-pw" }, "only the submitted form is read");
    form.action = "https://other.test/login";
    handlers.click({ isTrusted: true, target: form.querySelector("button") });
    handlers.submit({ isTrusted: true, target: form, submitter: form.querySelector("button") });
    assert.equal(calls.filter(c => c.type === "offer-capture").length, 1, "cross-origin actions excluded");
    const base = w.document.createElement("base"); base.href = "https://other.test/"; w.document.head.append(base);
    form.setAttribute("action", "/submit");
    handlers.click({ isTrusted: true, target: form.querySelector("button") });
    handlers.submit({ isTrusted: true, target: form, submitter: form.querySelector("button") });
    assert.equal(calls.filter(c => c.type === "offer-capture").length, 1, "cross-origin base URLs excluded");
    const offer = { token: "one", origin: "https://example.com", mode: "update", expires: Date.now() + 120000 };
    receive({ type: "slv-offer", offer }, { id: "stranger" });
    assert.equal(shadows.length, 0);
    receive({ type: "slv-offer", offer: { ...offer, origin: "https://other.test" } }, { id: "test" });
    assert.equal(shadows.length, 0);
    receive({ type: "slv-offer", offer }, { id: "test" });
    assert.match(shadows[0].textContent, /Update this password/);
    assert.equal(shadows[0].textContent.includes("dummy-pw"), false);
    shadows[0].querySelector("button").click();
    assert.equal(calls.filter(c => c.type === "offer-save").length, 0, "synthetic page clicks cannot trigger desktop prompts");
  } finally { w.close(); }
}

async function settingsTests() {
  const dom = new JSDOM(read("popup.html"), { runScripts: "outside-only" });
  const w = dom.window;
  const calls = [];
  let allowed = false;
  w.chrome = { permissions: { request: async request => { calls.push(["permission", request]); return allowed; } }, runtime: { sendMessage: async message => { calls.push(["message", message]); return { enabled: message.enabled === true, blocked: false }; } } };
  w.eval(read("offerSettings.js"));
  try {
    await tick();
    const toggle = w.document.getElementById("offers-enabled");
    toggle.checked = true; toggle.dispatchEvent(new w.Event("change")); await tick();
    assert.equal(toggle.checked, false);
    assert.equal(calls.some(c => c[1].type === "offers-set"), false, "permission refusal doesn't enable offers");
    allowed = true;
    toggle.checked = true; toggle.dispatchEvent(new w.Event("change")); await tick();
    assert.equal(toggle.checked, true);
    assert.deepEqual(calls.slice(-2).map(c => c[0]), ["permission", "message"]);
    assert.match(w.document.getElementById("offers-note").textContent, /Reload/);
  } finally { w.close(); }
}

(async () => {
  await workerTests(); await contentTests(); await settingsTests();
  console.log("save offer tests passed: permissions, sender isolation, origins, navigation, expiry, dismissal, duplicate suppression, lock, DOM and settings");
})().catch(error => { console.error(error); process.exit(1); });
