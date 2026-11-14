// Synthetic documents and browser APIs only; no browser profile, vault or network.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");
const { addOfferApis } = require("./offerTestUtils");
const read = name => fs.readFileSync(path.join(__dirname, "../extension", name), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function fixture(firefox = false) {
  let listener, time = Date.now(), serial = 0, dom;
  const store = { slvSaveOffers: { enabled: true, blocked: [] } }, saves = [], responses = [];
  const FakeDate = class extends Date { static now() { return time; } };
  const chrome = {
    isFirefox: firefox,
    runtime: { id: "synthetic", onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { query(_query, cb) { cb([state.tab]); } },
    scripting: { async executeScript({ func, args, target, world }) {
      assert.equal(world, "ISOLATED"); assert.deepEqual(plain(target.frameIds), [0]);
      return [{ result: dom.window.eval(`(${func.toString()})`)(...args) }];
    } },
    storage: { local: { get: async key => ({ [key]: store[key] }), set: async values => Object.assign(store, values) } }
  };
  const state = addOfferApis(chrome, { allowed: true });
  const link = {
    check: async () => ({ connected: true, site: { state: "ok", logins: [] } }),
    saveLogin: async request => { saves.push({ ...request }); return { ok: true, mode: "add" }; },
    inspectLogin: async () => ({ ok: true, mode: "add" }), forget: async () => ({ ok: true })
  };
  const sandbox = { chrome, URL, Date: FakeDate, console, clearTimeout,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    crypto: { randomUUID: () => `synthetic-token-${++serial}` },
    SLVSecretStorage: { createSecretStorage: () => ({ ready: Promise.resolve() }) },
    SLVStatus: { HOST_NAME: "synthetic", describeStatus: () => ({ ok: false }) },
    SLVLink: { createLink: () => link },
    SLVInlineFill: { createInlineFill: () => ({ clear() {} }) }
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...names) => names.filter(name => ["readFormInPage.js", "saveOffers.js"].includes(name))
    .forEach(name => vm.runInContext(read(name), context));
  vm.runInContext(read("background.js"), context);
  function page(html, url = "https://example.com/password", tabId = 7) {
    dom?.window.close();
    dom = new JSDOM(html, { url, runScripts: "outside-only" });
    dom.window.Date = FakeDate;
    Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { get() { return this.hidden ? 0 : 100; } });
    state.tab = { id: tabId, url };
  }
  function ask(message, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") }) {
    return new Promise(resolve => {
      const kept = listener(message, sender, result => { responses.push(plain(result)); resolve(plain(result)); });
      if (!kept) resolve({ ignored: true });
    });
  }
  chrome.runtime.sendMessage = (message, cb) => ask(message).then(cb);
  page('<form><input type="password" value="synthetic-password"></form>');
  await tick();
  return { chrome, state, store, saves, responses, page, ask, advance(ms) { time += ms; },
    get dom() { return dom; }, async close() { await ask({ type: "forget" }); dom.window.close(); } };
}

async function run() {
  for (const firefox of [false, true]) {
    const f = await fixture(firefox);
    try {
      let result = await f.ask({ type: "save-login" });
      assert.equal(result.needsUsername, true); assert.equal(f.saves.length, 0);
      assert(!JSON.stringify(result).includes("synthetic-password"));
      assert.equal((await f.ask({ type: "save-login-username", token: result.token, username: "dummy@example.test", password: "forged", url: "https://evil.test" })).ok, true);
      assert.deepEqual(f.saves[0], { url: "https://example.com", username: "dummy@example.test", password: "synthetic-password" });
      assert.equal((await f.ask({ type: "save-login-username", token: result.token, username: "replay" })).ok, false);
      const baseline = f.saves.length;
      for (const scenario of ["expire", "reload", "same-origin-navigation", "other-origin", "other-tab", "cancel", "forged-token", "oversize"]) {
        f.page('<input type="password" value="synthetic-password">');
        result = await f.ask({ type: "save-login" });
        if (scenario === "expire") f.advance(120001);
        if (scenario === "reload") f.page('<input type="password" value="synthetic-password">');
        if (scenario === "same-origin-navigation") f.page('<input type="password" value="synthetic-password">', "https://example.com/other");
        if (scenario === "other-origin") f.page('<input type="password" value="synthetic-password">', "https://other.test/password");
        if (scenario === "other-tab") f.state.tab.id = 8;
        if (scenario === "cancel") await f.ask({ type: "save-login-cancel", token: result.token });
        const reply = await f.ask({ type: "save-login-username", token: scenario === "forged-token" ? "wrong" : result.token, username: scenario === "oversize" ? "u".repeat(257) : "dummy" });
        assert.equal(reply.ok, false, scenario); assert.equal(f.saves.length, baseline, scenario);
      }
      f.page('<div id="profileIdentifier">selected@example.test</div><form><input type="password" value="synthetic-password"></form>', "https://accounts.google.com/v3/signin/challenge/pwd");
      assert.equal((await f.ask({ type: "save-login" })).ok, true);
      assert.equal(f.saves.at(-1).username, "selected@example.test");
      f.page('<input type="email" value="step@example.test">', "https://example.com/email");
      assert.match((await f.ask({ type: "save-login" })).message, /remembered/);
      f.page('<input type="password" value="synthetic-password">');
      result = await f.ask({ type: "save-login" }); assert.equal(result.username, "step@example.test");
      await f.ask({ type: "save-login-cancel", token: result.token });
      assert.equal((await f.ask({ type: "save-login" })).username, "");
      const sender = { id: f.chrome.runtime.id, frameId: 0, documentId: "synthetic", tab: { id: 7 }, url: f.state.tab.url };
      for (const type of ["save-login", "save-login-username", "save-login-cancel"]) assert.equal((await f.ask({ type, username: "evil" }, sender)).ignored, true);
      await f.ask({ type: "offer-username", username: "step@example.test" }, sender);
      assert.equal((await f.ask({ type: "save-login" })).username, "step@example.test");
      await f.ask({ type: "offer-capture", password: "synthetic-offer-password" }, sender);
      const offer = (await f.ask({ type: "offer-ready" }, sender)).offer;
      assert(offer); await f.ask({ type: "offer-save", token: offer.token }, sender);
      assert.equal(f.saves.at(-1).username, "step@example.test");
      for (const scenario of ["expire", "navigate", "close", "disable", "forget"]) {
        await f.ask({ type: "offers-set", enabled: true });
        await f.ask({ type: "offer-username", username: "temporary@example.test" }, sender);
        if (scenario === "expire") f.advance(120001);
        if (scenario === "navigate") f.chrome.tabs.onUpdated.emit(7, { url: "https://other.test/" });
        if (scenario === "close") f.chrome.tabs.onRemoved.emit(7);
        if (scenario === "disable") await f.ask({ type: "offers-set", enabled: false });
        if (scenario === "forget") await f.ask({ type: "forget" });
        assert.equal((await f.ask({ type: "save-login" })).username, "", scenario);
      }
      assert(!JSON.stringify(f.store).includes("example.test"), "no username persisted");
      assert(!JSON.stringify(f.responses).includes("synthetic-password"), "no password returned to popup");

      // Drive the real popup through missing-username entry and cancellation.
      const popup = new JSDOM(read("popup.html"), { runScripts: "outside-only" });
      popup.window.chrome = f.chrome; popup.window.eval(read("popup.js")); await tick(); await tick();
      const $ = id => popup.window.document.getElementById(id);
      $("save-button").click(); await tick(); await tick();
      assert.equal($("save-username-form").hidden, false);
      assert.equal(popup.window.document.activeElement.id, "save-username");
      $("save-username").value = "popup@example.test";
      $("save-username-form").dispatchEvent(new popup.window.Event("submit", { bubbles: true, cancelable: true }));
      await tick(); await tick();
      assert.equal(f.saves.at(-1).username, "popup@example.test");
      assert.equal($("save-username").value, ""); assert.equal($("save-username-form").hidden, true);
      $("save-button").click(); await tick(); await tick(); $("save-username-cancel").click();
      assert.equal($("save-username-form").hidden, true); popup.window.close();
      console.log(`PASS ${firefox ? "Firefox" : "Chromium"} two-step save: Google label, popup fallback, fresh read, tokens, navigation, expiry, sender isolation and memory-only username steps`);
    } finally { await f.close(); }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
