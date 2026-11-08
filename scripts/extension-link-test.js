// The extension's side of pairing (extension/pairing.js and extension/link.js) against
// the real app code: the app's pairing core and bridge on a real named pipe, reached
// through the real helper relay (src/native-host/hostRelay.js). Only the browser is
// replaced, by a small stand-in for chrome.runtime.connectNative.
//   npm run test:link
const assert = require("assert");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const { createPairing, protocol, parseCode: appParseCode, encodeCode, formatCode } = require("../src/services/extensionPairing");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { createExtensionHandlers } = require("../src/services/extensionHandlers");
const { runHost } = require("../src/native-host/hostRelay");
const { encodeMessage, createMessageReader } = require("../src/native-host/framing");
const { getPipeName } = require("../src/native-host/pipeName");
const { ALLOWED_EXTENSION_IDS } = require("../src/native-host/config");

const SLVPairing = require("../extension/pairing.js");
const SLVStatus = require("../extension/status.js");
const { createLink } = require("../extension/link.js");

setTimeout(() => {
  console.error("extension link test timed out");
  process.exit(1);
}, 120000).unref();

const OWN_ORIGIN = `chrome-extension://${ALLOWED_EXTENSION_IDS[0]}/`;
const STRANGER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/";
const hex = (buffer) => Buffer.from(buffer).toString("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function memoryStorage(initial = null) {
  const box = { value: initial };
  return { box, load: () => box.value, save: (v) => (box.value = v), clear: () => (box.value = null) };
}

// What Chrome gives an extension: connectNative(host) -> a port wired to a helper.
// The helper is the real relay code, run in this process.
function makeBrowser({ pipeName, origin = OWN_ORIGIN }) {
  const stats = { opened: 0, open: 0 };
  const lastError = { message: "" };
  let secretHex = null;

  const connectNative = () => {
    stats.opened += 1;
    stats.open += 1;
    const toHelper = new PassThrough();
    const fromHelper = new PassThrough();
    const messageListeners = [];
    const disconnectListeners = [];
    let ended = false;

    const end = (byBrowser) => {
      if (ended) return;
      ended = true;
      stats.open -= 1;
      if (!byBrowser) disconnectListeners.forEach((fn) => fn()); // Chrome tells the caller only when the helper ends
    };

    const reader = createMessageReader({
      // like a real browser, never deliver before the caller has had a chance to listen
      onMessage: (value) => setImmediate(() => messageListeners.forEach((fn) => fn(value))),
      onError() {}
    });
    fromHelper.on("data", (chunk) => reader.push(chunk));

    runHost({
      stdin: toHelper,
      stdout: fromHelper,
      argv: [origin],
      pipeName,
      allowedExtensionIds: ALLOWED_EXTENSION_IDS,
      exit: () => setTimeout(() => end(false), 20) // the helper's last message arrives before the end
    });

    return {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
      postMessage(message) {
        if (ended) throw new Error("Attempt to postMessage on disconnected port");
        toHelper.write(encodeMessage(message));
      },
      disconnect() {
        end(true);
        toHelper.end(); // the helper sees its input close and shuts down
      }
    };
  };

  const link = createLink({
    hostName: SLVStatus.HOST_NAME,
    pairing: SLVPairing,
    status: SLVStatus,
    randomId: () => crypto.randomUUID(),
    connectNative: (host) => {
      assert.equal(host, "com.securelogin.vault");
      return browser.connectNative(host);
    },
    getLastError: () => lastError.message,
    requestTimeoutMs: 1500,
    storage: {
      get: async () => secretHex,
      set: async (value) => {
        secretHex = value;
      },
      clear: async () => {
        secretHex = null;
      }
    }
  });

  const browser = { connectNative, stats, lastError, link, secret: () => secretHex, setSecret: (v) => (secretHex = v) };
  return browser;
}

// The real app side: pairing core + handlers + bridge on a pipe. Every request the app
// receives is recorded.
async function startApp(pipeName, { pairing = createPairing({ storage: memoryStorage() }), extraHandlers = {}, vault } = {}) {
  const received = [];
  const real = createExtensionHandlers({ getAppVersion: () => "9.9.9", pairing, vault });
  const handlers = {};
  for (const [type, fn] of Object.entries({ ...real, ...extraHandlers })) {
    handlers[type] = (request, context) => {
      received.push(request);
      return fn(request, context);
    };
  }
  const bridge = createExtensionBridge({ pipeName, handlers });
  await bridge.start();
  return { pairing, bridge, received, stop: () => bridge.stop() };
}

const types = (app) => app.received.map((r) => r.type);

async function main() {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS  ${name}`);
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${error.stack || error.message}`);
      process.exitCode = 1;
    }
  };

  // ── The extension's crypto agrees with the app's ────────────────────────────
  await check("known-answer vector: both sides produce the same bytes", async () => {
    const code = Buffer.from([...Array(16).keys()]);
    const ne = "00112233445566778899aabbccddeeff";
    const na = "ffeeddccbbaa99887766554433221100";
    assert.equal(formatCode(encodeCode(code)), "AAAS-EA2E-AWDA-QCAK-BJFS-2DJQ-B6");
    assert.equal(hex(SLVPairing.parseCode("AAAS-EA2E-AWDA-QCAK-BJFS-2DJQ-B6")), hex(code));

    const authKey = await SLVPairing.pairingAuthKey(new Uint8Array(code));
    assert.equal(hex(authKey), "63bab3894992d7ff0d3fdea975b8cc27bc921b89e6386b712808629f646589cf");
    const secret = await SLVPairing.pairingSecret(new Uint8Array(code), ne, na);
    assert.equal(hex(secret), "a7253bf7591d7ad320b159285be4d2fd3fe0971fd493c4c3ee5550e3b53d3bf2");
    assert.equal(await SLVPairing.appProof(authKey, "pair", ne, na), "f9744b1d7f94e52b2b972f74ae5f27449b6445cb61573ae23cd724de66532790");
    assert.equal(await SLVPairing.extProof(authKey, "pair", ne, na), "ea43fb1906bf5f32a18bc505391ce3a7413b53dd7c304a37587432b4e57b94cf");
    assert.equal(await SLVPairing.appProof(secret, "auth", ne, na), "9123dcd4763aa63265d22a44d8bbc9e468148c920b67848ac70c47544ea6382d");
    assert.equal(await SLVPairing.extProof(secret, "auth", ne, na), "4cfea2b9dc429f3cf5ce4f1fb706d43fc122c318936aafff535b4ffa6682b66c");
  });

  await check("random inputs: the two implementations never disagree", async () => {
    for (let i = 0; i < 30; i += 1) {
      const code = crypto.randomBytes(16);
      const ne = crypto.randomBytes(16).toString("hex");
      const na = crypto.randomBytes(16).toString("hex");
      assert.equal(hex(await SLVPairing.pairingAuthKey(new Uint8Array(code))), hex(protocol.pairingAuthKey(code)));
      assert.equal(hex(await SLVPairing.pairingSecret(new Uint8Array(code), ne, na)), hex(protocol.pairingSecret(code, ne, na)));
      const key = protocol.pairingAuthKey(code);
      assert.equal(await SLVPairing.appProof(new Uint8Array(key), "auth", ne, na), protocol.appProof(key, "auth", ne, na));
      assert.equal(await SLVPairing.extProof(new Uint8Array(key), "pair", ne, na), protocol.extProof(key, "pair", ne, na));
    }
  });

  await check("code parsing agrees with the app, including everything it rejects", () => {
    const raw = encodeCode(crypto.randomBytes(16));
    const samples = [
      formatCode(raw), raw.toLowerCase(), ` ${raw} `, raw.slice(1), `${raw}A`, `${raw.slice(0, -1)}0`, `${raw.slice(0, -1)}9`,
      `${raw.slice(0, -1)}!`, "A".repeat(26), "A".repeat(10000), "", "   ", undefined, null, 5, {}, []
    ];
    for (const sample of samples) {
      const fromApp = appParseCode(sample);
      const fromExt = SLVPairing.parseCode(sample);
      assert.equal(fromExt === null, fromApp === null, JSON.stringify(sample));
      if (fromApp) assert.equal(hex(fromExt), hex(fromApp));
    }
  });

  await check("equalHex compares exactly", () => {
    const a = "ab".repeat(32);
    assert.equal(SLVPairing.equalHex(a, a), true);
    assert.equal(SLVPairing.equalHex(a, `${a.slice(0, -1)}c`), false);
    assert.equal(SLVPairing.equalHex(a, a.slice(1)), false);
    assert.equal(SLVPairing.equalHex(a, undefined), false);
    assert.equal(SLVPairing.equalHex(5, 5), false);
  });

  // ── The whole flow against the real app ─────────────────────────────────────
  const pipeName = getPipeName(`link-test-${process.pid}`);
  const browser = makeBrowser({ pipeName });
  const link = browser.link;

  await check("app not running: the status says so and no pairing is offered", async () => {
    const status = await link.check();
    assert.equal(status.state, "app-not-running");
    assert.equal(status.connected, false);
    assert.equal(status.canPair, false);
    assert.equal(status.paired, false);
    assert.equal(browser.stats.open, 0, "no connection left open");
  });

  let app = await startApp(pipeName);
  let storedByApp = () => app.pairing.isPaired();

  await check("running but not paired: it says Not paired and offers pairing", async () => {
    const status = await link.check();
    assert.equal(status.state, "unpaired");
    assert.equal(status.connected, false, "not verified means not connected");
    assert.equal(status.canPair, true);
    assert.equal(status.canForget, false);
    assert.equal(status.appVersion, "9.9.9");
    assert.deepEqual(types(app), ["ping"], "only a ping went to the app");
  });

  await check("a malformed code is refused without contacting the app", async () => {
    const before = browser.stats.opened;
    for (const bad of ["", "hello", "ABCD-EFGH", "0".repeat(26), 5, null]) {
      const status = await link.pair(bad);
      assert.equal(status.state, "pair-failed", String(bad));
      assert.equal(status.title, "Code not recognised");
    }
    assert.equal(browser.stats.opened, before, "no connection was even opened");
  });

  await check("no code showing in the app: it explains what to do", async () => {
    const real = formatCode(encodeCode(crypto.randomBytes(16)));
    const status = await link.pair(real);
    assert.equal(status.state, "pair-failed");
    assert.equal(status.title, "No code is active");
    assert.equal(browser.secret(), null);
  });

  await check("a wrong code is refused, the extension sends no proof, and the real code still works", async () => {
    const { code } = app.pairing.startPairing();
    app.received.length = 0;
    const wrong = formatCode(encodeCode(crypto.randomBytes(16)));
    const status = await link.pair(wrong);
    assert.equal(status.state, "pair-failed");
    assert.equal(status.title, "Code not accepted");
    assert.deepEqual(types(app), ["pair-begin"], "stopped before sending its own proof");
    assert.equal(browser.secret(), null);
    assert.equal(app.pairing.isPairingActive(), true, "the real code is untouched");
    assert.equal(app.pairing.isPaired(), false);

    const good = await link.pair(code);
    assert.equal(good.state, "verified", JSON.stringify(good));
    assert.equal(good.connected, true);
  });

  let firstSecret;
  await check("pairing: both sides hold the same secret, and the status is verified", async () => {
    firstSecret = browser.secret();
    assert.match(firstSecret, /^[0-9a-f]{64}$/);
    assert.equal(storedByApp(), true);
    const status = await link.check();
    assert.deepEqual({ state: status.state, connected: status.connected, paired: status.paired, canForget: status.canForget, canPair: status.canPair }, { state: "verified", connected: true, paired: true, canForget: true, canPair: false });
    assert.match(status.detail, /9\.9\.9/);
    assert.equal(browser.stats.open, 0, "every connection was closed again");
  });

  await check("the code is never sent, and only known message types are used", async () => {
    app.received.length = 0;
    const { code } = app.pairing.startPairing();
    assert.equal((await link.pair(code)).state, "verified");
    const all = JSON.stringify(app.received);
    assert.equal(all.includes(code), false);
    assert.equal(all.includes(code.replace(/-/g, "")), false);
    assert.equal(all.includes(hex(parseCode(code))), false);
    assert.equal(all.includes(browser.secret()), false, "nor the secret");
    const allowedFields = {
      ping: ["id", "type"],
      "pair-begin": ["id", "nonceE", "type"],
      "pair-finish": ["extProof", "id", "nonceA", "nonceE", "type"],
      "auth-begin": ["id", "nonceE", "type"],
      "auth-finish": ["extProof", "id", "nonceA", "nonceE", "type"]
    };
    for (const request of app.received) {
      assert.ok(request.type in allowedFields, request.type);
      assert.deepEqual(Object.keys(request).sort(), allowedFields[request.type], `fields of ${request.type}`);
    }
    function parseCode(text) { return appParseCode(text); }
  });

  await check("pairing again replaces the secret", async () => {
    assert.notEqual(browser.secret(), firstSecret);
    assert.equal((await link.check()).state, "verified");
  });

  await check("saved logins for the page: only when verified, sanitised, and only what is asked for", async () => {
    const credentials = [
      { id: 1, websiteName: "Example", websiteUrl: "example.com", username: "alice", password: "pw-LEAK", notes: "note-LEAK" },
      { id: 2, websiteName: "Admin", websiteUrl: "https://example.com/admin", username: "root", password: "pw-LEAK-2" }
    ];
    const vault = { locked: false, getCredentials: async () => {
      if (vault.locked) throw Object.assign(new Error("Vault is locked."), { isPublic: true });
      return credentials;
    } };
    await app.stop();
    app = await startApp(pipeName, { vault });
    assert.equal((await link.pair(app.pairing.startPairing().code)).state, "verified");

    // nothing asked, nothing sent
    app.received.length = 0;
    for (const options of [undefined, {}, { url: "" }, { url: 5 }, { url: { href: "https://example.com" } }, { url: "x".repeat(3000) }]) {
      const status = await link.check(options);
      assert.equal(status.state, "verified");
      assert.equal(status.site, undefined, JSON.stringify(options));
    }
    assert.equal(types(app).includes("find-logins"), false, "no page address, no lookup");

    // asked: the request carries only the address, and the answer is names + usernames
    app.received.length = 0;
    const found = await link.check({ url: "https://example.com" });
    assert.equal(found.state, "verified");
    assert.deepEqual(found.site, { state: "ok", host: "example.com", logins: [{ id: 1, name: "Example", username: "alice" }, { id: 2, name: "Admin", username: "root" }] });
    assert.equal(JSON.stringify(found).includes("LEAK"), false);
    const lookup = app.received.find((r) => r.type === "find-logins");
    assert.deepEqual(Object.keys(lookup).sort(), ["id", "type", "url"]);
    assert.equal(lookup.url, "https://example.com");

    assert.deepEqual((await link.check({ url: "https://nothing.example" })).site, { state: "ok", host: "nothing.example", logins: [] });
    assert.deepEqual((await link.check({ url: "http://example.com" })).site, { state: "insecure" });
    assert.deepEqual((await link.check({ url: "chrome://extensions" })).site, { state: "unsupported" });
    vault.locked = true;
    assert.deepEqual((await link.check({ url: "https://example.com" })).site, { state: "locked" });
    assert.equal((await link.check({ url: "https://example.com" })).state, "verified", "locked vault, still a verified link");
    vault.locked = false;

    // pairing hands over the list straight away
    const again = await link.pair(app.pairing.startPairing().code, { url: "https://example.com" });
    assert.equal(again.state, "verified");
    assert.equal(again.site.state, "ok");
    assert.equal(again.site.logins.length, 2);
    assert.equal(browser.stats.open, 0);
  });

  await check("an app that sends odd lists cannot push anything unexpected into the popup", async () => {
    await app.stop();
    const odd = [
      { id: 1, name: "n".repeat(500), username: 5, password: "LEAK", extra: { a: 1 } }, null, 5, "x", [], { id: "2", name: "string id" }, { id: 1.5, name: "float id" },
      ...Array.from({ length: 60 }, (_, i) => ({ id: i + 10, name: "N" + i, username: "u" }))
    ];
    app = await startApp(pipeName, { extraHandlers: { "find-logins": () => ({ host: "h".repeat(500), logins: odd }) } });
    assert.equal((await link.pair(app.pairing.startPairing().code)).state, "verified");
    const { site } = await link.check({ url: "https://example.com" });
    assert.equal(site.state, "ok");
    assert.equal(site.host.length, 100);
    assert.equal(site.logins.length <= 20, true);
    assert.deepEqual(Object.keys(site.logins[0]).sort(), ["id", "name", "username"]);
    assert.equal(site.logins[0].name.length, 100);
    assert.equal(site.logins[0].username, "", "a non-text username becomes empty");
    assert.equal(JSON.stringify(site).includes("LEAK"), false);
    assert.equal(site.logins.every((l) => Number.isSafeInteger(l.id)), true);

    for (const reply of [() => ({ logins: "nope" }), () => ({ logins: null }), () => ({}), () => ({ error: "internal-error" }), () => ({ error: "surprise" })]) {
      await app.stop();
      app = await startApp(pipeName, { extraHandlers: { "find-logins": reply } });
      assert.equal((await link.pair(app.pairing.startPairing().code)).state, "verified");
      assert.equal((await link.check({ url: "https://example.com" })).site.state, "error");
    }
  });

  await check("a used code cannot be used again", async () => {
    const { code } = app.pairing.startPairing();
    assert.equal((await link.pair(code)).state, "verified");
    const status = await link.pair(code);
    assert.equal(status.title, "No code is active");
  });

  await check("an expired code is refused", async () => {
    let t = 1_000_000;
    const clock = { now: () => t };
    await app.stop();
    app = await startApp(pipeName, { pairing: createPairing({ storage: memoryStorage(), now: clock.now }) });
    const { code } = app.pairing.startPairing();
    t += 3 * 60 * 1000;
    assert.equal((await link.pair(code)).title, "No code is active");
  });

  await check("the app is unpaired: the extension notices and offers to pair again", async () => {
    await app.stop();
    app = await startApp(pipeName);
    assert.ok(browser.secret(), "the extension still holds a secret");
    const status = await link.check({ url: "https://example.com" });
    // a fresh app that was never paired answers "not-paired"
    assert.equal(status.state, "pairing-lost");
    assert.equal(status.connected, false);
    assert.equal(status.canPair, true);
    assert.equal(status.canForget, true);
    assert.deepEqual(types(app), ["ping", "auth-begin"], "no proof was sent to an app that does not know us, and no page address");
  });

  await check("an app holding a DIFFERENT secret is flagged, and gets no proof from us", async () => {
    await app.stop();
    const other = createPairing({ storage: memoryStorage({ secret: crypto.randomBytes(32).toString("hex") }) });
    app = await startApp(pipeName, { pairing: other });
    const status = await link.check({ url: "https://example.com" });
    assert.equal(status.state, "app-unverified");
    assert.equal(status.connected, false);
    assert.equal(status.danger, true);
    assert.deepEqual(types(app), ["ping", "auth-begin"], "stopped before sending its own proof, and never sent the page address");
    assert.match(status.detail, /something else may be answering/);
    assert.equal(status.site, undefined);
  });

  await check("a fake app that makes up proofs is flagged as well (garbage proofs too)", async () => {
    await app.stop();
    for (const answer of [
      () => ({ nonceA: crypto.randomBytes(16).toString("hex"), appProof: crypto.randomBytes(32).toString("hex") }),
      () => ({ nonceA: "short", appProof: "nothex" }),
      () => ({ nonceA: 5, appProof: {} }),
      () => ({})
    ]) {
      app = await startApp(pipeName, { extraHandlers: { "auth-begin": answer } });
      const status = await link.check();
      assert.equal(status.connected, false);
      assert.ok(["app-unverified", "error"].includes(status.state), status.state);
      assert.equal(types(app).includes("auth-finish"), false);
      await app.stop();
    }
    app = await startApp(pipeName);
  });

  await check("a fake app cannot trick pairing: no proof is sent to it", async () => {
    await app.stop();
    app = await startApp(pipeName, {
      extraHandlers: {
        "pair-begin": () => ({ nonceA: crypto.randomBytes(16).toString("hex"), appProof: crypto.randomBytes(32).toString("hex") })
      }
    });
    const code = formatCode(encodeCode(crypto.randomBytes(16)));
    const status = await link.pair(code);
    assert.equal(status.title, "Code not accepted");
    assert.deepEqual(types(app), ["pair-begin"], "the extension never revealed a proof");
    assert.equal(browser.secret() !== null, true, "the old secret is untouched");
    await app.stop();
    app = await startApp(pipeName);
  });

  await check("Forget removes the secret and reports the new state", async () => {
    const status = await link.forget();
    assert.equal(browser.secret(), null);
    assert.equal(status.state, "unpaired");
    assert.equal(status.paired, false);
    assert.equal(status.canForget, false);
  });

  await check("forgetting works even when the app is off, and says so", async () => {
    browser.setSecret("ab".repeat(32));
    await app.stop();
    const status = await link.forget();
    assert.equal(browser.secret(), null);
    assert.equal(status.state, "app-not-running");
    assert.equal(status.paired, false);
    app = await startApp(pipeName);
  });

  await check("a damaged stored secret is treated as not paired", async () => {
    for (const junk of ["nothex", "ab", 5, {}]) {
      browser.setSecret(junk);
      const status = await link.check();
      assert.equal(status.state, "unpaired", String(junk));
      assert.equal(status.canForget, false);
    }
    browser.setSecret(null);
  });

  await check("an app that never answers gives No answer, and the connection is closed", async () => {
    await app.stop();
    app = await startApp(pipeName, { extraHandlers: { ping: () => new Promise(() => {}) } });
    const started = Date.now();
    const status = await link.check();
    assert.equal(status.state, "no-answer");
    assert.ok(Date.now() - started < 5000);
    assert.equal(browser.stats.open, 0);
    await app.stop();
    app = await startApp(pipeName);
  });

  await check("the browser's own errors are explained", async () => {
    const failing = (message, throws) => {
      const l = createLink({
        hostName: SLVStatus.HOST_NAME,
        pairing: SLVPairing,
        status: SLVStatus,
        randomId: () => "id",
        storage: { get: async () => null, set: async () => {}, clear: async () => {} },
        getLastError: () => message,
        connectNative: () => {
          if (throws) throw new Error("boom");
          const listeners = [];
          return {
            onMessage: { addListener() {} },
            onDisconnect: { addListener: (fn) => listeners.push(fn) },
            postMessage() { setTimeout(() => listeners.forEach((fn) => fn()), 5); },
            disconnect() {}
          };
        }
      });
      return l.check();
    };
    assert.equal((await failing("Specified native messaging host not found.")).state, "helper-missing");
    assert.equal((await failing("Native host has exited.")).state, "helper-error");
    assert.equal((await failing("", true)).state, "error");
  });

  await check("a different extension is refused by the helper", async () => {
    const stranger = makeBrowser({ pipeName, origin: STRANGER_ORIGIN });
    const status = await stranger.link.check();
    assert.equal(status.state, "helper-forbidden");
    assert.equal(status.connected, false);
    assert.equal(stranger.stats.open, 0);
  });

  await check("nothing is ever left connected", () => {
    assert.equal(browser.stats.open, 0);
    assert.ok(browser.stats.opened > 10);
  });

  await app.stop();
  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nextension link tests FAILED" : "\nextension link tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
