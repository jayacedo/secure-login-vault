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
assert.deepEqual(manifest.permissions, ["nativeMessaging"]);
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

for (const file of ["background.js", "popup.js", "status.js", "popup.html", "popup.css"]) {
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

function loadBackground({ onSendNative, runtimeId = "ext-id" }) {
  const listeners = [];
  const sent = [];
  const chrome = {
    runtime: {
      id: runtimeId,
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendNativeMessage(host, message, callback) {
        sent.push({ host, message });
        onSendNative({ host, message, callback, chrome });
      }
    }
  };
  const sandbox = {
    chrome,
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555" },
    console,
    setTimeout,
    clearTimeout,
    String,
    Promise,
    Object
  };
  sandbox.self = sandbox;
  sandbox.importScripts = (file) => vm.runInContext(read(file), context, { filename: file });
  const context = vm.createContext(sandbox);
  vm.runInContext(read("background.js"), context, { filename: "background.js" });
  assert.equal(listeners.length, 1, "one message listener");
  return {
    sent,
    ask: (message, sender = { id: runtimeId }) =>
      new Promise((resolve) => {
        const keptOpen = listeners[0](message, sender, resolve);
        if (keptOpen !== true) resolve({ __ignored: true });
      })
  };
}

(async () => {
  // Connected
  {
    const bg = loadBackground({
      onSendNative: ({ callback }) => callback({ id: "x", ok: true, type: "pong", appVersion: "1.0.0", protocol: 1 })
    });
    const status = await bg.ask({ type: "get-status" });
    assert.equal(status.state, "connected");
    assert.equal(bg.sent.length, 1);
    assert.equal(bg.sent[0].host, "com.securelogin.vault");
    assert.deepEqual(Object.keys(bg.sent[0].message).sort(), ["id", "type"], "only an id and a ping are ever sent");
    assert.equal(bg.sent[0].message.type, "ping");
    assert.equal(bg.sent[0].message.id, "11111111-2222-3333-4444-555555555555");
  }

  // The browser reports an error (helper not registered)
  {
    const bg = loadBackground({
      onSendNative: ({ callback, chrome }) => {
        chrome.runtime.lastError = { message: "Specified native messaging host not found." };
        callback(undefined);
      }
    });
    assert.equal((await bg.ask({ type: "get-status" })).state, "helper-missing");
  }

  // The app is off
  {
    const bg = loadBackground({
      onSendNative: ({ callback }) => callback({ id: "x", ok: false, error: "app-not-running" })
    });
    assert.equal((await bg.ask({ type: "get-status" })).state, "app-not-running");
  }

  // sendNativeMessage throws
  {
    const bg = loadBackground({
      onSendNative: () => {
        throw new Error("boom");
      }
    });
    assert.equal((await bg.ask({ type: "get-status" })).state, "error");
  }

  // Requests from anyone but this extension, and unknown requests, are ignored
  {
    const bg = loadBackground({ onSendNative: ({ callback }) => callback({ ok: true, type: "pong", protocol: 1 }) });
    assert.deepEqual(await bg.ask({ type: "get-status" }, { id: "some-other-extension" }), { __ignored: true });
    assert.deepEqual(await bg.ask({ type: "get-status" }, {}), { __ignored: true });
    assert.deepEqual(await bg.ask({ type: "get-passwords" }), { __ignored: true });
    assert.deepEqual(await bg.ask(null), { __ignored: true });
    assert.deepEqual(await bg.ask("get-status"), { __ignored: true });
    assert.equal(bg.sent.length, 0, "nothing reached the helper");
  }

  // ── popup.js, run in a real DOM against a fake chrome ───────────────────────
  function openPopup(respond) {
    const html = read("popup.html").replace(/<script[^>]*><\/script>/, "").replace(/<link[^>]*>/, "");
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    const calls = [];
    dom.window.chrome = {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          calls.push(message);
          respond({ message, callback, chrome: dom.window.chrome });
        }
      }
    };
    dom.window.eval(read("popup.js"));
    const $ = (id) => dom.window.document.getElementById(id);
    return {
      calls,
      state: () => $("status").dataset.state,
      title: () => $("status-title").textContent,
      detail: () => $("status-detail").textContent,
      button: $("recheck"),
      count: (selector) => dom.window.document.querySelectorAll(selector).length,
      pwned: () => dom.window.pwned
    };
  }

  {
    const popup = openPopup(({ callback }) => callback({ state: "connected", connected: true, title: "Connected", detail: "Secure Login Vault 1.0.0" }));
    assert.deepEqual(popup.calls, [{ type: "get-status" }], "asks for the status when opened");
    assert.equal(popup.state(), "connected");
    assert.equal(popup.title(), "Connected");
    assert.equal(popup.detail(), "Secure Login Vault 1.0.0");
    assert.equal(popup.button.disabled, false);
  }

  {
    const popup = openPopup(({ callback }) => callback({ state: "app-not-running", connected: false, title: "Not connected", detail: "Open the app." }));
    assert.equal(popup.state(), "problem");
    assert.equal(popup.title(), "Not connected");
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
  }

  // "connected" must be exactly true to look connected
  for (const connected of ["true", 1, "yes"]) {
    const popup = openPopup(({ callback }) => callback({ connected, title: "Connected", detail: "" }));
    assert.equal(popup.state(), "problem", `connected: ${JSON.stringify(connected)}`);
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

  await sleep(0);
  console.log("extension tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
