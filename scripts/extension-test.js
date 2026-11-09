// Tests for the browser extension in extension/: what it is allowed to do, that its
// ID matches what the helper allows, its status messages, and its background and
// popup scripts (run against a fake `chrome` object).
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");
const { extensionIdFromPublicKey } = require("./extension-key");
const { ALLOWED_EXTENSION_IDS } = require("../src/native-host/config");
const { isAllowedOrigin } = require("../src/native-host/hostRelay");

const dir = path.join(__dirname, "..", "extension");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The manifest: a small, fixed set of permissions ──────────────────────────

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, "Secure Login Vault");
assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);

// This extension may talk to the desktop helper and nothing else. Any new capability
// (website access, scripts in pages, being contacted by sites) must be a deliberate
// change to this test.
// "activeTab" gives temporary access to the one tab the person is using, only after they act
// in the popup; "scripting" lets the extension run its fill code there. Neither reads any
// website on its own, and there are no host permissions.
assert.deepEqual(manifest.permissions, ["nativeMessaging", "storage", "activeTab", "scripting"]);
for (const forbidden of [
  "host_permissions",
  "optional_permissions",
  "optional_host_permissions",
  "content_scripts",
  "externally_connectable",
  "web_accessible_resources",
  "content_security_policy",
  "declarative_net_request",
  "devtools_page",
  "chrome_url_overrides",
  "update_url"
]) {
  assert.equal(forbidden in manifest, false, `the manifest must not declare ${forbidden}`);
}
assert.deepEqual(Object.keys(manifest.background), ["service_worker"], "plain service worker, no module tricks");
assert.equal(manifest.background.service_worker, "background.js");
assert.equal(manifest.action.default_popup, "popup.html");

// ── Every file the manifest points at exists; icons are real PNGs of the right size ──

for (const file of [manifest.background.service_worker, manifest.action.default_popup]) {
  assert.ok(fs.existsSync(path.join(dir, file)), `${file} exists`);
}
for (const [size, file] of Object.entries(manifest.icons)) {
  const png = fs.readFileSync(path.join(dir, file));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} is a PNG`);
  assert.equal(png.readUInt32BE(16), Number(size), `${file} width`);
  assert.equal(png.readUInt32BE(20), Number(size), `${file} height`);
}
for (const file of Object.values(manifest.action.default_icon)) {
  assert.ok(fs.existsSync(path.join(dir, file)), `${file} exists`);
}

// ── The fixed ID ─────────────────────────────────────────────────────────────

{
  const der = Buffer.from(manifest.key, "base64");
  const publicKey = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  assert.equal(publicKey.asymmetricKeyType, "rsa");
  assert.ok(publicKey.asymmetricKeyDetails.modulusLength >= 2048, "key is at least 2048 bits");
  assert.equal(manifest.key.includes("PRIVATE"), false);

  const id = extensionIdFromPublicKey(manifest.key);
  assert.match(id, /^[a-p]{32}$/);
  assert.deepEqual(ALLOWED_EXTENSION_IDS, [id], "the helper allows exactly this extension");
  assert.equal(isAllowedOrigin(`chrome-extension://${id}/`, ALLOWED_EXTENSION_IDS), true);

  // The ID algorithm itself (Chrome's): changing one bit of the key changes the ID.
  const other = Buffer.from(der);
  other[other.length - 8] ^= 1;
  assert.notEqual(extensionIdFromPublicKey(other.toString("base64")), id);
}

// ── Source hygiene: no markup injection, no remote code, no eval ─────────────

for (const file of ["background.js", "popup.js", "status.js", "pairing.js", "link.js", "fillInPage.js", "popup.html", "popup.css"]) {
  const text = read(file);
  for (const pattern of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /https?:\/\//]) {
    assert.equal(pattern.test(text), false, `${file} must not contain ${pattern}`);
  }
}
{
  const html = read("popup.html");
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, "no inline scripts");
  assert.equal(/\son\w+\s*=/i.test(html), false, "no inline event handlers");
  assert.equal(/style\s*=/i.test(html), false, "no inline styles");
}

// ── Status messages ──────────────────────────────────────────────────────────

const { describeStatus, HOST_NAME, EXPECTED_PROTOCOL } = require("../extension/status.js");

assert.equal(HOST_NAME, "com.securelogin.vault");
assert.equal(EXPECTED_PROTOCOL, 1);

{
  const ok = describeStatus({ ok: true, type: "pong", appVersion: "1.2.3", protocol: 1, id: "x" }, "");
  assert.deepEqual(ok, { state: "connected", connected: true, title: "Connected", detail: "Secure Login Vault 1.2.3", appVersion: "1.2.3" });
  assert.equal(describeStatus({ ok: true, type: "pong", protocol: 1 }, "").detail, "Secure Login Vault");
  assert.equal(describeStatus({ ok: true, type: "pong", appVersion: "9".repeat(100), protocol: 1 }, "").appVersion.length, 32);
  assert.equal(describeStatus({ ok: true, type: "pong", appVersion: { evil: 1 }, protocol: 1 }, "").appVersion, "");
}

const cases = [
  [[{ ok: true, type: "pong", protocol: 2 }, ""], "version-mismatch"],
  [[{ ok: true, type: "pong" }, ""], "version-mismatch"],
  [[{ ok: false, error: "app-not-running" }, ""], "app-not-running"],
  [[{ ok: false, error: "origin-not-allowed" }, ""], "helper-forbidden"],
  [[{ ok: false, error: "timeout" }, ""], "no-answer"],
  [[{ ok: false, error: "app-disconnected" }, ""], "error"],
  [[{ ok: false, error: "something-new" }, ""], "error"],
  [[{ ok: true, type: "other" }, ""], "error"],
  [[undefined, ""], "error"],
  [[null, ""], "error"],
  [["text", ""], "error"],
  [[undefined, "Specified native messaging host not found."], "helper-missing"],
  [[undefined, "Access to the specified native messaging host is forbidden."], "helper-forbidden"],
  [[undefined, "Native host has exited."], "helper-error"],
  [[{ ok: true, type: "pong", protocol: 1 }, "Native host has exited."], "helper-error"] // a browser error wins
];
for (const [args, state] of cases) {
  const status = describeStatus(...args);
  assert.equal(status.state, state, JSON.stringify(args));
  assert.equal(status.connected, state === "connected");
  assert.ok(status.title.length > 0 && status.detail.length > 0);
}
// Only a genuine "connected" is ever reported as connected
assert.deepEqual(cases.filter(([, state]) => state === "connected"), []);


// ── background.js, run against a fake chrome ─────────────────────────────────
//
// The fake browser hands out ports; `respond(message)` plays the helper and the app
// (return a reply, or undefined to say nothing).

function loadBackground({ respond = () => undefined, connectThrows = false, disconnectWith = null, runtimeId = "ext-id", tab = { id: 7, url: "https://example.com/login" } } = {}) {
  const listeners = [];
  const sent = [];
  const storageCalls = [];
  const store = {};
  const stats = { open: 0, maxOpen: 0, opened: 0 };
  const chrome = {
    runtime: {
      id: runtimeId,
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      connectNative(host) {
        if (connectThrows) throw new Error("boom");
        stats.opened += 1;
        stats.open += 1;
        stats.maxOpen = Math.max(stats.maxOpen, stats.open);
        const messageListeners = [];
        const disconnectListeners = [];
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          stats.open -= 1;
        };
        if (disconnectWith) {
          setTimeout(() => {
            chrome.runtime.lastError = { message: disconnectWith };
            close();
            disconnectListeners.forEach((fn) => fn());
            chrome.runtime.lastError = undefined;
          }, 5);
        }
        return {
          onMessage: { addListener: (fn) => messageListeners.push(fn) },
          onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
          postMessage(message) {
            sent.push({ host, message });
            const reply = respond(message);
            if (reply !== undefined) setTimeout(() => messageListeners.forEach((fn) => fn({ id: message.id, ...reply })), 1);
          },
          disconnect: close
        };
      }
    },
    tabs: {
      query(options, callback) {
        assert.deepEqual(options, { active: true, currentWindow: true });
        callback(tab ? [tab] : []);
      }
    },
    scripting: {
      async executeScript() {
        throw new Error("a fill that reached the page without a verified app");
      }
    },
    storage: {
      local: {
        async get(key) {
          storageCalls.push(["get", key]);
          return key in store ? { [key]: store[key] } : {};
        },
        async set(values) {
          storageCalls.push(["set", Object.keys(values)]);
          Object.assign(store, values);
        },
        async remove(key) {
          storageCalls.push(["remove", key]);
          delete store[key];
        }
      }
    }
  };
  const sandbox = {
    chrome,
    crypto: crypto.webcrypto,
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    URL,
    Uint8Array,
    String,
    Promise,
    Object,
    Array,
    JSON,
    Error,
    parseInt
  };
  sandbox.self = sandbox;
  sandbox.importScripts = (...files) => files.forEach((file) => vm.runInContext(read(file), context, { filename: file }));
  const context = vm.createContext(sandbox);
  vm.runInContext(read("background.js"), context, { filename: "background.js" });
  assert.equal(listeners.length, 1, "one message listener");
  return {
    sent,
    stats,
    store,
    storageCalls,
    ask: (message, sender = { id: runtimeId }) =>
      new Promise((resolve) => {
        const keptOpen = listeners[0](message, sender, resolve);
        if (keptOpen !== true) resolve({ __ignored: true });
      })
  };
}

const PONG = { ok: true, type: "pong", appVersion: "1.0.0", protocol: 1 };

(async () => {
  // Running but not paired: reported as such, and not as connected
  {
    const bg = loadBackground({ respond: (m) => (m.type === "ping" ? PONG : undefined) });
    const status = await bg.ask({ type: "get-status" });
    assert.equal(status.state, "unpaired");
    assert.equal(status.connected, false, "unverified is never connected");
    assert.equal(status.canPair, true);
    assert.equal(bg.sent.length, 1);
    assert.equal(bg.sent[0].host, "com.securelogin.vault");
    assert.deepEqual(Object.keys(bg.sent[0].message).sort(), ["id", "type"], "only an id and a ping are sent");
    assert.equal(bg.sent[0].message.type, "ping");
    assert.equal(bg.stats.open, 0, "the connection is closed again");
  }

  // The browser reports an error (helper not registered)
  {
    const bg = loadBackground({ disconnectWith: "Specified native messaging host not found." });
    assert.equal((await bg.ask({ type: "get-status" })).state, "helper-missing");
    assert.equal(bg.stats.open, 0);
  }

  // The app is off
  {
    const bg = loadBackground({ respond: () => ({ ok: false, error: "app-not-running" }) });
    const status = await bg.ask({ type: "get-status" });
    assert.equal(status.state, "app-not-running");
    assert.equal(status.canPair, false);
  }

  // connectNative throws
  {
    const bg = loadBackground({ connectThrows: true });
    assert.equal((await bg.ask({ type: "get-status" })).state, "error");
  }

  // The stored secret is kept under one key, and Forget removes only that
  {
    const secret = "ab".repeat(32);
    const bg = loadBackground({ respond: (m) => (m.type === "ping" ? PONG : { ok: false, error: "not-paired" }) });
    bg.store.slvPairingSecret = secret;
    const status = await bg.ask({ type: "get-status" });
    assert.equal(status.state, "pairing-lost");
    assert.equal(status.canForget, true);
    assert.deepEqual(bg.sent.map((s) => s.message.type), ["ping", "auth-begin"]);

    const forgotten = await bg.ask({ type: "forget" });
    assert.deepEqual(bg.store, {});
    assert.equal(forgotten.state, "unpaired");
    assert.equal(forgotten.canForget, false);
    for (const [, what] of bg.storageCalls) assert.ok(what === "slvPairingSecret" || (Array.isArray(what) && what.every((k) => k === "slvPairingSecret")), JSON.stringify(what));
  }

  // Two popups at once: one operation at a time, never two connections together
  {
    const bg = loadBackground({ respond: (m) => (m.type === "ping" ? PONG : undefined) });
    const results = await Promise.all([bg.ask({ type: "get-status" }), bg.ask({ type: "get-status" }), bg.ask({ type: "get-status" })]);
    assert.deepEqual(results.map((r) => r.state), ["unpaired", "unpaired", "unpaired"]);
    assert.equal(bg.stats.opened, 3);
    assert.equal(bg.stats.maxOpen, 1);
  }

  // A pairing request is passed on; a malformed one is ignored
  {
    const bg = loadBackground({ respond: (m) => (m.type === "ping" ? PONG : undefined) });
    const status = await bg.ask({ type: "pair", code: "not a code" });
    assert.equal(status.title, "Code not recognised");
    assert.equal(bg.sent.length, 0, "a bad code never reaches the app");
    for (const bad of [{ type: "pair" }, { type: "pair", code: 5 }, { type: "pair", code: null }, { type: "pair", code: { a: 1 } }]) {
      assert.deepEqual(await bg.ask(bad), { __ignored: true }, JSON.stringify(bad));
    }
  }

  // Fill: refuses before contacting the app when there is no usable page; bad ids are ignored
  for (const tab of [null, {}, { id: 7 }, { id: 7, url: "chrome://extensions/" }, { id: 7, url: "about:blank" }, { id: 7, url: "file:///C:/x.html" }, { url: "https://example.com/" }, { id: "7", url: "https://example.com/" }]) {
    const bg = loadBackground({ tab, respond: () => PONG });
    const result = await bg.ask({ type: "fill", loginId: 1 });
    assert.deepEqual(result, { ok: false, status: "error", message: "Open the login page in this tab first." }, JSON.stringify(tab));
    assert.equal(bg.sent.length, 0, "the app was never contacted");
  }
  {
    const bg = loadBackground({ respond: () => PONG });
    for (const bad of [{ type: "fill" }, { type: "fill", loginId: "1" }, { type: "fill", loginId: 1.5 }, { type: "fill", loginId: null }, { type: "fill", loginId: {} }, { type: "fill", loginId: [1] }, { type: "fill", loginId: NaN }, { type: "fill", loginId: 2 ** 60 }]) {
      assert.deepEqual(await bg.ask(bad), { __ignored: true }, JSON.stringify(bad));
    }
    assert.deepEqual(await bg.ask({ type: "fill", loginId: 1 }, { id: "some-other-extension" }), { __ignored: true });
    assert.equal(bg.sent.length, 0);
    // not paired: no password request is ever made, and the person is told why
    const unpaired = await bg.ask({ type: "fill", loginId: 1 });
    assert.equal(unpaired.ok, false);
    assert.match(unpaired.message, /Not paired/);
    assert.deepEqual(bg.sent.map((s) => s.message.type), ["ping"]);
  }

  // Requests from anyone but this extension, and unknown requests, are ignored
  {
    const bg = loadBackground({ respond: () => PONG });
    for (const message of [{ type: "get-status" }, { type: "pair", code: "x" }, { type: "forget" }, { type: "fill", loginId: 1 }]) {
      assert.deepEqual(await bg.ask(message, { id: "some-other-extension" }), { __ignored: true });
      assert.deepEqual(await bg.ask(message, {}), { __ignored: true });
    }
    assert.deepEqual(await bg.ask({ type: "get-passwords" }), { __ignored: true });
    assert.deepEqual(await bg.ask(null), { __ignored: true });
    assert.deepEqual(await bg.ask("get-status"), { __ignored: true });
    assert.deepEqual(await bg.ask(["get-status"]), { __ignored: true });
    assert.equal(bg.sent.length, 0, "nothing reached the helper");
    assert.deepEqual(bg.storageCalls, [], "nothing touched storage");
  }

  // ── popup.js, run in a real DOM against a fake chrome ───────────────────────
  function openPopup(respond, { tabUrl, tabsThrow = false, tabsError = false } = {}) {
    const html = read("popup.html").replace(/<script[^>]*><\/script>/, "").replace(/<link[^>]*>/, "");
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    const calls = [];
    let insideTabsCallback = false;
    dom.window.chrome = {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          calls.push(message);
          // Like Chrome: lastError only exists during the one callback it belongs to.
          if (insideTabsCallback) dom.window.chrome.runtime.lastError = undefined;
          respond({ message, callback, chrome: dom.window.chrome, calls });
        }
      }
    };
    if (tabUrl !== undefined || tabsThrow) {
      dom.window.chrome.tabs = {
        query(options, callback) {
          if (tabsThrow) throw new Error("no tabs permission");
          assert.deepEqual(options, { active: true, currentWindow: true }, "only the active tab is asked for");
          if (tabsError) dom.window.chrome.runtime.lastError = { message: "x" };
          insideTabsCallback = true;
          callback(tabUrl === null ? [] : [{ url: tabUrl }]);
          insideTabsCallback = false;
          dom.window.chrome.runtime.lastError = undefined;
        }
      };
    }
    dom.window.eval(read("popup.js"));
    const $ = (id) => dom.window.document.getElementById(id);
    return {
      calls,
      siteVisible: () => !$("site").hidden,
      siteTitle: () => $("site-title").textContent,
      siteNote: () => $("site-note").textContent,
      logins: () => Array.from(dom.window.document.querySelectorAll("#logins li")).map((li) => Array.from(li.querySelectorAll(".login-name, .login-user")).map((c) => c.textContent)),
      fillButtons: () => Array.from(dom.window.document.querySelectorAll("#logins button")),
      fillNote: () => dom.window.document.getElementById("fill-note").textContent,
      fillNoteOk: () => dom.window.document.getElementById("fill-note").dataset.ok,
      state: () => $("status").dataset.state,
      title: () => $("status-title").textContent,
      detail: () => $("status-detail").textContent,
      button: $("recheck"),
      pairingVisible: () => !$("pairing").hidden,
      forgetVisible: () => !$("forget").hidden,
      codeInput: $("code"),
      pairButton: $("pair"),
      forgetButton: $("forget"),
      key: (key) => $("code").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key })),
      count: (selector) => dom.window.document.querySelectorAll(selector).length,
      pwned: () => dom.window.pwned
    };
  }

  {
    const popup = openPopup(({ callback }) => callback({ state: "verified", connected: true, title: "Connected", detail: "Secure Login Vault 1.0.0 (verified)", canForget: true, canPair: false }));
    assert.deepEqual(popup.calls, [{ type: "get-status" }], "asks for the status when opened");
    assert.equal(popup.state(), "connected");
    assert.equal(popup.title(), "Connected");
    assert.equal(popup.button.disabled, false);
    assert.equal(popup.pairingVisible(), false);
    assert.equal(popup.forgetVisible(), true);
  }

  {
    const popup = openPopup(({ callback }) => callback({ state: "app-not-running", connected: false, title: "Not connected", detail: "Open the app." }));
    assert.equal(popup.state(), "problem");
    assert.equal(popup.title(), "Not connected");
    assert.equal(popup.pairingVisible(), false);
    assert.equal(popup.forgetVisible(), false);
  }

  // The danger look is for an unverified app only, and is not "connected"
  {
    const popup = openPopup(({ callback }) => callback({ connected: false, danger: true, title: "Could not verify the app", detail: "x", canPair: true, canForget: true }));
    assert.equal(popup.state(), "danger");
    assert.equal(popup.pairingVisible(), true);
    const both = openPopup(({ callback }) => callback({ connected: true, danger: true, title: "t", detail: "d" }));
    assert.equal(both.state(), "connected", "connected wins only when it is exactly true");
  }

  // Hostile status text is shown as text, never as markup
  {
    const evil = `<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>`;
    const popup = openPopup(({ callback }) => callback({ connected: false, title: evil, detail: evil }));
    assert.equal(popup.title(), evil);
    assert.equal(popup.detail(), evil);
    assert.equal(popup.count("img"), 1, "only the popup's own logo, nothing created from the text");
    assert.equal(popup.count("script"), 0);
    assert.equal(popup.pwned(), undefined);
  }

  // A broken answer or a browser error falls back to a clear message
  for (const respond of [
    ({ callback }) => callback(undefined),
    ({ callback }) => callback("nope"),
    ({ callback, chrome }) => { chrome.runtime.lastError = { message: "x" }; callback({ connected: true, title: "Connected", detail: "" }); }
  ]) {
    const popup = openPopup(respond);
    assert.equal(popup.state(), "problem");
    assert.equal(popup.title(), "No answer");
    assert.equal(popup.pairingVisible(), false);
  }

  // The controls need exactly true, and "connected" must be exactly true
  for (const value of ["true", 1, "yes", {}]) {
    const popup = openPopup(({ callback }) => callback({ connected: value, canPair: value, canForget: value, title: "x", detail: "" }));
    assert.equal(popup.state(), "problem", `connected: ${JSON.stringify(value)}`);
    assert.equal(popup.pairingVisible(), false);
    assert.equal(popup.forgetVisible(), false);
  }

  // The button checks again, and is disabled while checking
  {
    let respondLater = null;
    let count = 0;
    const popup = openPopup(({ callback }) => {
      count += 1;
      if (count === 1) return callback({ connected: false, title: "Not connected", detail: "" });
      respondLater = callback;
    });
    assert.equal(popup.state(), "problem");
    popup.button.click();
    assert.equal(popup.state(), "checking");
    assert.equal(popup.button.disabled, true, "disabled while checking");
    respondLater({ connected: true, title: "Connected", detail: "" });
    assert.equal(popup.state(), "connected");
    assert.equal(popup.button.disabled, false);
    assert.equal(popup.calls.length, 2);
  }

  // Pairing from the popup
  {
    let pending = null;
    const popup = openPopup(({ message, callback }) => {
      if (message.type === "get-status") return callback({ state: "unpaired", connected: false, title: "Not paired", detail: "Paste a code.", canPair: true });
      pending = callback; // the pair request waits
    });
    assert.equal(popup.pairingVisible(), true);

    // nothing typed: nothing is sent
    popup.pairButton.click();
    assert.equal(popup.calls.length, 1);
    assert.equal(popup.title(), "Paste the code first");

    // a code: sent as typed, wiped from the field at once, controls locked while waiting
    popup.codeInput.value = "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-34";
    popup.pairButton.click();
    assert.deepEqual(popup.calls[1], { type: "pair", code: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-34" });
    assert.equal(popup.codeInput.value, "", "the code does not stay in the popup");
    assert.equal(popup.state(), "checking");
    assert.equal(popup.pairButton.disabled, true);
    assert.equal(popup.codeInput.disabled, true);
    assert.equal(popup.button.disabled, true);

    pending({ state: "verified", connected: true, title: "Connected", detail: "ok", canForget: true, canPair: false });
    assert.equal(popup.state(), "connected");
    assert.equal(popup.pairButton.disabled, false);
    assert.equal(popup.pairingVisible(), false, "the form goes away once paired");
    assert.equal(popup.forgetVisible(), true);
  }

  // Enter pairs too; a refused code keeps the form and clears the field
  {
    const popup = openPopup(({ message, callback }) => {
      if (message.type === "get-status") return callback({ connected: false, title: "Not paired", detail: "", canPair: true });
      callback({ connected: false, title: "Code not accepted", detail: "Try again.", canPair: true });
    });
    popup.codeInput.value = "x";
    popup.key("Enter");
    assert.deepEqual(popup.calls[1], { type: "pair", code: "x" });
    assert.equal(popup.title(), "Code not accepted");
    assert.equal(popup.pairingVisible(), true);
    assert.equal(popup.codeInput.value, "");
    popup.key("a");
    assert.equal(popup.calls.length, 2, "other keys do nothing");
  }

  // Forget
  {
    const popup = openPopup(({ message, callback }) => {
      if (message.type === "get-status") return callback({ connected: false, title: "Pairing no longer valid", detail: "", canPair: true, canForget: true });
      callback({ connected: false, title: "Not paired", detail: "", canPair: true, canForget: false });
    });
    assert.equal(popup.forgetVisible(), true);
    popup.forgetButton.click();
    assert.deepEqual(popup.calls[1], { type: "forget" });
    assert.equal(popup.forgetVisible(), false);
  }

  // ── Saved logins for the page, in the popup ─────────────────────────────────
  const verified = (site) => ({ state: "verified", connected: true, title: "Connected", detail: "ok", canForget: true, site });

  // Only the origin of the tab leaves the popup, and only for http(s) pages
  {
    const popup = openPopup(({ callback }) => callback(verified({ state: "ok", host: "example.com", logins: [] })), { tabUrl: "https://example.com/a/b?token=SECRET#frag" });
    assert.deepEqual(popup.calls[0], { type: "get-status", url: "https://example.com" });
    assert.equal(JSON.stringify(popup.calls).includes("SECRET"), false);
    const port = openPopup(({ callback }) => callback(verified({ state: "ok", host: "example.com:8443", logins: [] })), { tabUrl: "https://user:pw@Example.com:8443/x" });
    assert.deepEqual(port.calls[0], { type: "get-status", url: "https://example.com:8443" }, "no user info, lower-cased, port kept");
    const local = openPopup(({ callback }) => callback(verified({ state: "ok", host: "localhost:3000", logins: [] })), { tabUrl: "http://localhost:3000/" });
    assert.deepEqual(local.calls[0], { type: "get-status", url: "http://localhost:3000" });
  }
  for (const [label, options] of [
    ["chrome page", { tabUrl: "chrome://extensions/" }], ["blank", { tabUrl: "about:blank" }], ["file", { tabUrl: "file:///C:/x.html" }],
    ["data", { tabUrl: "data:text/html,hi" }], ["garbage", { tabUrl: "not a url" }], ["no tab", { tabUrl: null }],
    ["tabs throws", { tabsThrow: true }], ["lastError", { tabUrl: "https://example.com/", tabsError: true }]
  ]) {
    const popup = openPopup(({ callback }) => callback(verified(undefined)), options);
    assert.deepEqual(popup.calls[0], { type: "get-status" }, label + ": nothing about the tab is sent");
    assert.equal(popup.siteVisible(), true, label);
    assert.equal(popup.siteNote(), "Saved logins are not offered on this kind of page.", label);
    assert.deepEqual(popup.logins(), []);
  }

  {
    const popup = openPopup(
      ({ callback }) => callback(verified({ state: "ok", host: "example.com", logins: [{ id: 1, name: "Example", username: "alice" }, { id: 2, name: "Admin", username: "" }, { id: 3, name: "Third", username: "carol@example.com" }] })),
      { tabUrl: "https://example.com/login" }
    );
    assert.equal(popup.siteVisible(), true);
    assert.equal(popup.siteTitle(), "Saved logins for example.com");
    assert.deepEqual(popup.logins(), [["Example", "alice"], ["Admin"], ["Third", "carol@example.com"]]);
    assert.equal(popup.siteNote(), "");
  }

  for (const [state, note] of [
    ["locked", "Secure Login Vault is locked. Unlock it to see your logins here."],
    ["insecure", "This page is not secure (http), so no logins are offered."],
    ["unsupported", "Saved logins are not offered on this kind of page."],
    ["error", "Could not look up saved logins. Check again."],
    ["something-new", "Could not look up saved logins. Check again."]
  ]) {
    const popup = openPopup(({ callback }) => callback(verified({ state })), { tabUrl: "https://example.com/" });
    assert.equal(popup.siteNote(), note, state);
    assert.deepEqual(popup.logins(), []);
  }
  {
    const popup = openPopup(({ callback }) => callback(verified({ state: "ok", host: "example.com", logins: [] })), { tabUrl: "https://example.com/" });
    assert.equal(popup.siteNote(), "No saved logins for this site.");
  }

  // Logins are only ever shown on a verified link, whatever the answer contains
  for (const status of [
    { connected: false, state: "unpaired", title: "Not paired", detail: "", canPair: true, site: { state: "ok", host: "example.com", logins: [{ id: 1, name: "Leak", username: "x" }] } },
    { connected: "true", title: "x", detail: "", site: { state: "ok", host: "example.com", logins: [{ id: 1, name: "Leak", username: "x" }] } },
    { connected: false, danger: true, title: "Could not verify the app", detail: "", site: { state: "ok", host: "evil", logins: [{ id: 1, name: "Leak", username: "x" }] } }
  ]) {
    const popup = openPopup(({ callback }) => callback(status), { tabUrl: "https://example.com/" });
    assert.equal(popup.siteVisible(), false);
    assert.deepEqual(popup.logins(), []);
  }

  // Hostile names are text, never markup; junk entries are skipped; the list is capped
  {
    const evil = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: "N" + (i + 1), username: "u" }));
    const popup = openPopup(
      ({ callback }) => callback(verified({ state: "ok", host: evil, logins: [{ id: 1, name: evil, username: evil }, null, 5, "x", [], { id: 2 }, ...many] })),
      { tabUrl: "https://example.com/" }
    );
    assert.equal(popup.siteTitle(), "Saved logins for " + evil);
    assert.deepEqual(popup.logins()[0], [evil, evil]);
    assert.equal(popup.count("#logins img"), 0);
    assert.equal(popup.count("script"), 0);
    assert.equal(popup.pwned(), undefined);
    assert.equal(popup.logins().length <= 20, true, "capped");
  }

  // Fill buttons
  {
    let pendingFill = null;
    const popup = openPopup(({ message, callback }) => {
      if (message.type === "get-status") {
        return callback(verified({ state: "ok", host: "example.com", logins: [{ id: 11, name: "Example", username: "alice" }, { id: 12, name: "Admin", username: "root" }, { id: "13", name: "Text id" }, { id: 1.5, name: "Float id" }, { name: "No id" }] }));
      }
      pendingFill = callback;
    }, { tabUrl: "https://example.com/login" });
    assert.equal(popup.fillButtons().length, 2, "only entries with a whole-number id get a Fill button");
    assert.equal(popup.logins().length, 5);
    assert.deepEqual(popup.fillButtons().map((b) => b.textContent), ["Fill", "Fill"]);
    assert.deepEqual(popup.fillButtons().map((b) => b.getAttribute("aria-label")), ["Fill Example", "Fill Admin"]);
    assert.deepEqual(popup.fillButtons().map((b) => b.type), ["button", "button"]);

    popup.fillButtons()[1].click();
    assert.deepEqual(popup.calls[1], { type: "fill", loginId: 12 }, "only the id is sent: no address, no password");
    assert.equal(popup.fillNote(), "Filling...");
    assert.equal(popup.fillButtons().every((b) => b.disabled), true, "locked while filling");
    assert.equal(popup.button.disabled, true);

    pendingFill({ ok: true, status: "filled", message: "Filled. Press the site's own Sign in button." });
    assert.equal(popup.fillNote(), "Filled. Press the site's own Sign in button.");
    assert.equal(popup.fillNoteOk(), "true");
    assert.equal(popup.fillButtons().every((b) => !b.disabled), true);

    popup.fillButtons()[0].click();
    pendingFill({ ok: false, status: "error", message: "Secure Login Vault is locked. Unlock it, then try again." });
    assert.equal(popup.fillNoteOk(), "false");
    assert.equal(popup.fillNote(), "Secure Login Vault is locked. Unlock it, then try again.");
    assert.equal(popup.calls[2].loginId, 11);

    // a broken or missing answer is a clear message, never silence
    for (const bad of [undefined, "nope", null]) {
      popup.fillButtons()[0].click();
      pendingFill(bad);
      assert.equal(popup.fillNote(), "Could not fill. Reload the extension and try again.");
    }

    // hostile text from the answer is text
    popup.fillButtons()[0].click();
    pendingFill({ ok: false, message: '<img src=x onerror="window.pwned=1">' });
    assert.equal(popup.fillNote(), '<img src=x onerror="window.pwned=1">');
    assert.equal(popup.pwned(), undefined);

    // a new check clears the old fill message
    popup.button.click();
    assert.equal(popup.fillNote(), "");
  }

  // Pairing from the popup carries the page origin too, so the list shows right away
  {
    const popup = openPopup(({ message, callback }) => {
      if (message.type === "get-status") return callback({ connected: false, title: "Not paired", detail: "", canPair: true });
      callback(verified({ state: "ok", host: "example.com", logins: [{ id: 1, name: "Example", username: "alice" }] }));
    }, { tabUrl: "https://example.com/x?y=1" });
    popup.codeInput.value = "x";
    popup.pairButton.click();
    assert.deepEqual(popup.calls[1], { type: "pair", code: "x", url: "https://example.com" });
    assert.deepEqual(popup.logins(), [["Example", "alice"]]);
  }

  // The input is not a place for the browser to remember or check things
  {
    const popup = openPopup(({ callback }) => callback({ connected: false, title: "x", detail: "", canPair: true }));
    assert.equal(popup.codeInput.getAttribute("autocomplete"), "off");
    assert.equal(popup.codeInput.getAttribute("spellcheck"), "false");
    assert.equal(popup.codeInput.type, "text");
  }

  await sleep(0);
  console.log("extension tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
