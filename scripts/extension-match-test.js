// Matching a page to saved logins (src/services/siteMatch.js) and the find-logins
// request (src/services/extensionHandlers.js), the second one over a real named pipe.
//   npm run test:match
const assert = require("assert");
const { matchLogins, MAX_RESULTS } = require("../src/services/siteMatch");
const { createPairing } = require("../src/services/extensionPairing");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { createExtensionHandlers } = require("../src/services/extensionHandlers");
const { getPipeName } = require("../src/native-host/pipeName");
const { connect, pair, authenticate } = require("./pairingTestClient");

setTimeout(() => {
  console.error("extension match test timed out");
  process.exit(1);
}, 60000).unref();

const cred = (id, websiteUrl, extra = {}) => ({ id, websiteName: `Site ${id}`, websiteUrl, username: `user${id}`, email: "", password: `secret-pw-${id}`, notes: `secret-note-${id}`, ...extra });
const idsFor = (url, credentials) => {
  const result = matchLogins(url, credentials);
  assert.equal(result.ok, true, `${url}: ${JSON.stringify(result)}`);
  return result.logins.map((l) => l.id);
};

function memoryStorage() {
  const box = { value: null };
  return { load: () => box.value, save: (v) => (box.value = v), clear: () => (box.value = null) };
}

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

  await check("the same site matches, whatever page of it you are on", () => {
    const all = [cred(1, "example.com"), cred(2, "https://example.com/wp-login.php"), cred(3, "https://other.example/")];
    assert.deepEqual(idsFor("https://example.com/", all), [1, 2]);
    assert.deepEqual(idsFor("https://example.com/account/settings?x=1#top", all), [1, 2]);
    assert.deepEqual(idsFor("https://other.example/login", all), [3]);
  });

  await check("case, default ports and encodings do not matter", () => {
    const all = [cred(1, "EXAMPLE.com"), cred(2, "https://example.com:443/x"), cred(3, "https://bücher.example"), cred(4, "https://xn--bcher-kva.example/")];
    assert.deepEqual(idsFor("https://Example.COM/", all), [1, 2]);
    assert.deepEqual(idsFor("https://example.com:443/", all), [1, 2]);
    assert.deepEqual(idsFor("https://xn--bcher-kva.example/", all), [3, 4]);
    assert.deepEqual(idsFor("https://bücher.example/", all), [3, 4]);
  });

  await check("subdomains, parents and look-alikes never match", () => {
    const all = [cred(1, "example.com"), cred(2, "www.example.com"), cred(3, "https://login.example.com")];
    assert.deepEqual(idsFor("https://example.com/", all), [1]);
    assert.deepEqual(idsFor("https://www.example.com/", all), [2]);
    assert.deepEqual(idsFor("https://login.example.com/", all), [3]);
    assert.deepEqual(idsFor("https://deep.login.example.com/", all), []);
    for (const lookalike of [
      "https://example.com.evil.test/", "https://evil-example.com/", "https://exampleXcom/", "https://example.co/", "https://example.com.au/",
      "https://examp1e.com/", "https://example.com:8443/", "https://example.com./", "https://xn--exmple-cua.com/"
    ]) {
      assert.deepEqual(idsFor(lookalike, [cred(1, "example.com")]), [], lookalike);
    }
  });

  await check("the userinfo trick lands on the real host and matches nothing of the fake", () => {
    const all = [cred(1, "example.com"), cred(2, "evil.test")];
    assert.equal(matchLogins("https://example.com@evil.test/", all).ok, false, "user info is refused outright");
    assert.equal(matchLogins("https://user:pw@example.com/", all).ok, false);
    // a saved entry written the same way is not usable either
    assert.deepEqual(idsFor("https://evil.test/", [cred(1, "https://example.com@evil.test/")]), []);
  });

  await check("scheme and port must agree; plain http is never matched except locally", () => {
    assert.deepEqual(idsFor("https://example.com/", [cred(1, "http://example.com")]), [], "saved plain http is never filled");
    assert.equal(matchLogins("http://example.com/", [cred(1, "example.com")]).reason, "insecure-page");
    assert.equal(matchLogins("http://example.com:8080/", [cred(1, "example.com")]).reason, "insecure-page");
    assert.deepEqual(idsFor("http://localhost:3000/login", [cred(1, "localhost:3000"), cred(2, "http://localhost:3001"), cred(3, "localhost")]), [1]);
    assert.deepEqual(idsFor("http://127.0.0.1:3000/", [cred(1, "localhost:3000"), cred(2, "http://127.0.0.1:3000")]), [2], "localhost and 127.0.0.1 are different hosts");
    assert.deepEqual(idsFor("https://example.com:8443/", [cred(1, "example.com"), cred(2, "example.com:8443")]), [2]);
  });

  await check("pages that are not websites are refused with a reason", () => {
    const all = [cred(1, "example.com")];
    const cases = {
      "chrome://extensions/": "unsupported-page",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html": "unsupported-page",
      "about:blank": "unsupported-page",
      "file:///C:/secret.html": "unsupported-page",
      "javascript:alert(1)": "unsupported-page",
      "data:text/html,<p>x</p>": "unsupported-page",
      "ftp://example.com/": "unsupported-page",
      "blob:https://example.com/1234": "unsupported-page",
      "view-source:https://example.com/": "unsupported-page",
      "not a url": "bad-url",
      "": "bad-url",
      "https://": "bad-url",
      [`https://example.com/${"a".repeat(3000)}`]: "bad-url"
    };
    for (const [url, reason] of Object.entries(cases)) {
      const result = matchLogins(url, all);
      assert.equal(result.ok, false, url.slice(0, 60));
      assert.equal(result.reason, reason, url.slice(0, 60));
    }
    for (const bad of [undefined, null, 5, {}, [], true]) assert.equal(matchLogins(bad, all).reason, "bad-url");
  });

  await check("only an id, a name and a username are ever returned", () => {
    const result = matchLogins("https://example.com/", [cred(1, "example.com", { email: "me@example.com", username: "" })]);
    assert.deepEqual(result.logins, [{ id: 1, name: "Site 1", username: "me@example.com" }], "falls back to the email");
    const text = JSON.stringify(result);
    assert.equal(text.includes("secret-pw"), false);
    assert.equal(text.includes("secret-note"), false);
    for (const login of result.logins) assert.deepEqual(Object.keys(login), ["id", "name", "username"]);
    assert.equal(result.host, "example.com");
    assert.equal(matchLogins("https://example.com:8443/", [cred(1, "example.com:8443")]).host, "example.com:8443");
  });

  await check("junk in the saved data is skipped, never thrown", () => {
    const all = [
      null, undefined, 5, "x", [], {}, cred("abc", "example.com"), cred(1.5, "example.com"), cred(NaN, "example.com"),
      cred(2, ""), cred(3, null), cred(4, 5), cred(5, "javascript:alert(1)"), cred(6, "C:\\secret"), cred(7, "example.com", { websiteName: "" }),
      cred(8, "example.com", { websiteName: "x".repeat(500), username: "y".repeat(500) })
    ];
    const result = matchLogins("https://example.com/", all);
    assert.deepEqual(result.logins.map((l) => l.id), [7, 8]);
    assert.equal(result.logins[0].name, "example.com", "an empty name falls back to the host");
    assert.equal(result.logins[1].name.length, 100);
    assert.equal(result.logins[1].username.length, 100);
    assert.deepEqual(matchLogins("https://example.com/", undefined).logins, []);
    assert.deepEqual(matchLogins("https://example.com/", "nope").logins, []);
  });

  await check("the answer is capped and keeps the order it was given", () => {
    const many = Array.from({ length: 100 }, (_, i) => cred(i + 1, "example.com"));
    const ids = idsFor("https://example.com/", many);
    assert.equal(ids.length, MAX_RESULTS);
    assert.deepEqual(ids, many.slice(0, MAX_RESULTS).map((c) => c.id));
    assert.equal(matchLogins("https://example.com/", many, { limit: 3 }).logins.length, 3);
    assert.equal(matchLogins("https://example.com/", many, { limit: 1000 }).logins.length, MAX_RESULTS, "the cap cannot be raised by the caller");
  });

  // ── The request, over a real pipe ───────────────────────────────────────────
  const pipeName = getPipeName(`match-test-${process.pid}`);
  const pairing = createPairing({ storage: memoryStorage() });
  const vault = { locked: false, boom: false, credentials: [cred(1, "example.com"), cred(2, "https://example.com/admin", { username: "admin" }), cred(3, "other.test")] };
  const handlers = createExtensionHandlers({
    getAppVersion: () => "1.0.0",
    pairing,
    vault: {
      getCredentials: async () => {
        if (vault.locked) throw Object.assign(new Error("Vault is locked."), { isPublic: true });
        if (vault.boom) throw new Error("disk exploded");
        return vault.credentials;
      }
    }
  });
  const bridge = createExtensionBridge({ pipeName, handlers });
  await bridge.start();

  try {
    const pairingConn = await connect(pipeName);
    const paired = await pair(pairingConn, pairing.startPairing().code);
    assert.equal(paired.finish.ok, true);
    pairingConn.close();
    const secret = paired.secret;

    await check("find-logins is refused until the connection has proven itself", async () => {
      const conn = await connect(pipeName);
      const reply = await conn.request({ type: "find-logins", url: "https://example.com/" });
      assert.deepEqual({ ok: reply.ok, error: reply.error, logins: reply.logins }, { ok: false, error: "not-authenticated", logins: undefined });
      conn.close();
    });

    await check("a proven connection gets names and usernames, nothing else", async () => {
      const conn = await connect(pipeName);
      assert.equal((await authenticate(conn, secret)).finish.ok, true);
      const reply = await conn.request({ type: "find-logins", url: "https://example.com/login" });
      assert.equal(reply.ok, true);
      assert.deepEqual(reply.logins, [{ id: 1, name: "Site 1", username: "user1" }, { id: 2, name: "Site 2", username: "admin" }]);
      assert.equal(reply.host, "example.com");
      assert.equal(JSON.stringify(reply).includes("secret-pw"), false);
      assert.equal(JSON.stringify(reply).includes("secret-note"), false);

      const none = await conn.request({ type: "find-logins", url: "https://nothing.example/" });
      assert.deepEqual({ ok: none.ok, logins: none.logins }, { ok: true, logins: [] });
      conn.close();
    });

    await check("errors: locked vault, bad requests, unsupported and insecure pages", async () => {
      const conn = await connect(pipeName);
      assert.equal((await authenticate(conn, secret)).finish.ok, true);
      const ask = (fields) => conn.request({ type: "find-logins", ...fields });

      vault.locked = true;
      assert.equal((await ask({ url: "https://example.com/" })).error, "locked");
      vault.locked = false;

      vault.boom = true;
      assert.equal((await ask({ url: "https://example.com/" })).error, "internal-error", "other failures are not called 'locked'");
      vault.boom = false;

      for (const bad of [{}, { url: 5 }, { url: null }, { url: ["https://example.com/"] }, { url: { href: "https://example.com/" } }]) {
        assert.equal((await ask(bad)).error, "bad-message", JSON.stringify(bad));
      }
      assert.equal((await ask({ url: "chrome://settings" })).error, "unsupported-page");
      assert.equal((await ask({ url: "http://example.com/" })).error, "insecure-page");
      assert.equal((await ask({ url: "nonsense" })).error, "bad-url");
      assert.equal((await ask({ url: "https://example.com/" })).ok, true, "and it still works afterwards");
      conn.close();
    });

    await check("without a vault the request does not exist", async () => {
      const bare = createExtensionHandlers({ getAppVersion: () => "1", pairing });
      assert.equal("find-logins" in bare, false);
    });
  } finally {
    await bridge.stop();
  }

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nextension match tests FAILED" : "\nextension match tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
