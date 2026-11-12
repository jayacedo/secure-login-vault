const assert = require("assert/strict");
const { createInlineFill } = require("../extension/inlineFill");
const { addOfferApis } = require("./offerTestUtils");
const sender = { id: "test", tab: { id: 7 }, url: "https://example.com/login", frameId: 0, documentId: "doc-one" };
async function fixture(enabled = true) {
  let clock = 1000, serial = 0;
  const store = { slvInlineFill: enabled };
  const calls = [];
  const chrome = { runtime: { id: "test" }, tabs: { query: (_q, cb) => cb([state.tab]) }, scripting: {},
    storage: { local: { get: async key => ({ [key]: store[key] }), set: async value => Object.assign(store, value) } } };
  const state = addOfferApis(chrome, { allowed: true });
  const link = { check: async input => { calls.push(input); return { connected: true, site: { state: "ok", logins: [{ id: 4, name: "Site", username: "dummy", password: "must-not-leak" }] } }; } };
  const fills = [];
  const api = createInlineFill({ chrome, link, ready: Promise.resolve(), run: fn => fn(), now: () => clock, randomId: () => `ticket-${++serial}`,
    fill: async (id, ticket, valid) => { fills.push({ id, ticket, valid }); return { ok: await valid(), message: "Filled" }; } });
  await api.initialized;
  return { api, state, store, chrome, calls, fills, link, advance: () => { clock += 61000; }, list: from => api.page({ type: "inline-list" }, from || sender) };
}
async function main() {
  let f = await fixture(false);
  assert.equal((await f.api.page({ type: "inline-ready" }, sender)).enabled, false);
  assert.equal(f.calls.length, 0); assert.equal(f.state.registered.length, 0);
  f.state.allowed = false; await assert.rejects(f.api.popup({ type: "inline-set", enabled: true }));
  f.state.allowed = true; await f.api.popup({ type: "inline-set", enabled: true });
  assert.equal(f.state.registered[0].allFrames, false);
  assert.equal((await f.api.page({ type: "inline-ready" }, sender)).enabled, true);
  assert.equal(f.calls.length, 0, "page load does not query the vault");
  for (const bad of [{ ...sender, id: "other" }, { ...sender, frameId: 1 }, { ...sender, documentId: "" }, { ...sender, url: "https://evil.test" }, { ...sender, documentLifecycle: "prerender" }]) {
    assert.equal((await f.list(bad)).ok, false);
  }
  assert.equal(f.calls.length, 0);
  let result = await f.list();
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.deepEqual(result.logins, [{ id: 4, name: "Site", username: "dummy" }]);
  assert.deepEqual(f.calls, [{ url: "https://example.com" }]);
  assert.equal((await f.list()).ok, false, "rate limited");
  const request = { type: "inline-fill", token: result.token, loginId: 4 };
  for (const bad of [{ ...request, token: "forged" }, { ...request, loginId: 99 }]) assert.equal((await f.api.page(bad, sender)).ok, false);
  assert.equal((await f.api.page(request, { ...sender, documentId: "doc-two" })).ok, false);
  assert.equal((await f.api.page(request, sender)).ok, true);
  assert.equal((await f.api.page(request, sender)).ok, false, "ticket is one use");
  assert.equal(f.fills.length, 1);
  f.api.clear(); assert.equal(await f.fills[0].valid(), false, "forget/disable invalidates pending operations");
  console.log("PASS opt-in, no lookup on load, sender/frame/origin guards, sanitized list, rate limits and one-use choices");
  f = await fixture(); result = await f.list(); f.advance();
  assert.equal((await f.api.page({ ...request, token: result.token }, sender)).ok, false);
  f = await fixture(); result = await f.list();
  f.chrome.tabs.query = async () => [{ id: 8, url: sender.url }];
  assert.equal((await f.api.page({ ...request, token: result.token }, sender)).ok, false, "inactive tab");
  f = await fixture(); result = await f.list();
  f.state.tab.url = "https://example.com/another-page";
  assert.equal((await f.api.page({ ...request, token: result.token }, sender)).ok, false, "same-origin navigation");
  f = await fixture(); result = await f.list(); f.state.allowed = false;
  assert.equal((await f.api.page({ ...request, token: result.token }, sender)).ok, false);
  await f.api.popup({ type: "inline-set", enabled: false });
  assert.equal(f.state.registered.length, 0); assert.equal(f.store.slvInlineFill, false);
  assert.ok(f.state.notices.some(x => x.message.type === "slv-inline-refresh"));
  f = await fixture(); f.state.allowed = false;
  f.chrome.permissions.onRemoved.emit({ origins: ["https://*/*"] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.slvInlineFill, false, "permission revocation persists the disabled state");
  assert.equal(f.state.registered.length, 0);
  assert.ok(f.state.notices.some(x => x.message.type === "slv-inline-refresh"), "revocation removes existing controls");
  f = await fixture(); f.link.check = async () => ({ connected: true, site: { state: "locked" } });
  assert.match((await f.list()).message, /locked/);
  f.advance(); f.link.check = async () => ({ connected: false, detail: "Pair the browser first" });
  assert.equal((await f.list()).ok, false);
  f = await fixture(); f.chrome.isFirefox = true;
  assert.equal((await f.list({ ...sender, documentId: undefined })).ok, true, "Firefox uses the isolated document token instead");
  console.log("PASS expiration, active-tab check, navigation, permission removal, disabled cleanup, locked/unpaired status and Firefox sender shape");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
