// get-login: the one request that returns a password. Over a real named pipe, with the
// real pairing, handlers and bridge, and a stand-in vault.
//   npm run test:getlogin
const assert = require("assert");
const { createPairing } = require("../src/services/extensionPairing");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { createExtensionHandlers, FILL_LIMITS } = require("../src/services/extensionHandlers");
const { createRateLimiter } = require("../src/services/rateLimit");
const { getPipeName } = require("../src/native-host/pipeName");
const { connect, pair, authenticate } = require("./pairingTestClient");

setTimeout(() => {
  console.error("extension get-login test timed out");
  process.exit(1);
}, 90000).unref();

const cred = (id, websiteUrl, extra = {}) => ({ id, websiteName: `Site ${id}`, websiteUrl, username: `user${id}`, email: "", password: `pw-${id}`, notes: `note-${id}`, ...extra });
const memoryStorage = () => {
  const box = { value: null };
  return { load: () => box.value, save: (v) => (box.value = v), clear: () => (box.value = null) };
};

async function main() {
  const results = [];
  const openConnections = new Set();
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS  ${name}`);
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${error.stack || error.message}`);
      process.exitCode = 1;
    } finally {
      // a failing test must not leave connections that starve the next one
      for (const conn of openConnections) conn.close();
      openConnections.clear();
    }
  };

  // ── The rate limiter itself ─────────────────────────────────────────────────
  await check("rate limiter: at most max in any window, and it recovers", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
    const at = (time) => { t = time; return limiter.take(); };
    assert.deepEqual([at(0), at(100), at(200), at(300)], [true, true, true, false]);
    assert.equal(at(999), false);
    assert.equal(at(1000), true, "the first slot (taken at 0) has aged out");
    assert.equal(at(1000), false, "the ones at 100 and 200 are still counted");
    assert.equal(at(1100), true);
    assert.deepEqual([at(5000), at(5000), at(5000), at(5000)], [true, true, true, false]);
    assert.throws(() => createRateLimiter({ max: 0, windowMs: 1 }));
    assert.throws(() => createRateLimiter({ max: 1, windowMs: 0 }));
    assert.throws(() => createRateLimiter({ max: 1.5, windowMs: 1 }));
  });

  // ── Over the pipe ───────────────────────────────────────────────────────────
  const state = {
    t: 1_000_000,
    locked: false,
    boom: false,
    credentials: [
      cred(1, "example.com"),
      cred(2, "https://example.com/admin", { username: "", email: "root@example.com", password: "pw-2" }),
      cred(3, "other.test"),
      cred(4, "https://www.example.com"),
      cred(5, "localhost:3000"),
      cred(6, "empty.test", { username: "", email: "", password: "" }),
      cred(7, "passonly.test", { username: "", email: "", password: "only-pw" }),
      cred(8, "http://insecure.test")
    ],
    approvals: [],
    approve: undefined
  };

  const pairing = createPairing({ storage: memoryStorage() });
  const makeHandlers = (extra = {}) =>
    createExtensionHandlers({
      getAppVersion: () => "1.0.0",
      pairing,
      now: () => state.t,
      vault: {
        getCredentials: async () => {
          if (state.locked) throw Object.assign(new Error("Vault is locked."), { isPublic: true });
          if (state.boom) throw new Error("disk exploded with pw-1 in the message");
          return state.credentials;
        }
      },
      ...extra
    });

  const pipeName = getPipeName(`getlogin-test-${process.pid}`);
  let bridge = createExtensionBridge({ pipeName, handlers: makeHandlers() });
  await bridge.start();

  const pairConn = await connect(pipeName);
  const paired = await pair(pairConn, pairing.startPairing().code);
  assert.equal(paired.finish.ok, true);
  pairConn.close();
  const secret = paired.secret;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const session = async () => {
    // each test starts with a fresh minute, and the bridge allows 4 connections at once
    state.t += 10 * 60 * 1000;
    const started = Date.now();
    while (bridge.connectionCount() >= 4) {
      if (Date.now() - started > 3000) throw new Error("no free connection slot");
      await sleep(20);
    }
    const conn = await connect(pipeName);
    openConnections.add(conn);
    assert.equal((await authenticate(conn, secret)).finish.ok, true);
    return conn;
  };
  const getLogin = (conn, loginId, url) => conn.request({ type: "get-login", loginId, url });

  try {
    await check("refused until the connection has proven itself", async () => {
      const conn = await connect(pipeName);
      const reply = await getLogin(conn, 1, "https://example.com");
      assert.deepEqual({ ok: reply.ok, error: reply.error, password: reply.password }, { ok: false, error: "not-authenticated", password: undefined });
      conn.close();
    });

    await check("the right login on the right site returns username and password, nothing else", async () => {
      const conn = await session();
      const reply = await getLogin(conn, 1, "https://example.com");
      assert.equal(reply.ok, true);
      assert.deepEqual({ host: reply.host, username: reply.username, password: reply.password }, { host: "example.com", username: "user1", password: "pw-1" });
      assert.deepEqual(Object.keys(reply).sort(), ["host", "id", "ok", "password", "username"], "no notes or other fields");
      assert.equal(JSON.stringify(reply).includes("note-1"), false);

      const byEmail = await getLogin(conn, 2, "https://example.com");
      assert.deepEqual({ username: byEmail.username, password: byEmail.password }, { username: "root@example.com", password: "pw-2" }, "email stands in for an empty username");
      const passOnly = await getLogin(conn, 7, "https://passonly.test");
      assert.deepEqual({ username: passOnly.username, password: passOnly.password }, { username: "", password: "only-pw" });
      const local = await getLogin(conn, 5, "http://localhost:3000");
      assert.equal(local.password, "pw-5");
      conn.close();
    });

    await check("a login id works only on the site it was saved for", async () => {
      const conn = await session();
      const wrongSites = [
        [3, "https://example.com"], // another site's login, on a site that has logins of its own
        [1, "https://www.example.com"], [4, "https://example.com"], [1, "https://example.com.evil.test"], [1, "https://evil-example.com"],
        [1, "https://example.com:8443"], [1, "https://example.com./"], [5, "http://127.0.0.1:3000"], [5, "http://localhost:3001"], [3, "https://nothing.example"]
      ];
      for (const [loginId, url] of wrongSites) {
        const reply = await getLogin(conn, loginId, url);
        assert.equal(reply.ok, false, `${loginId} on ${url}`);
        assert.equal(reply.error, "no-match", `${loginId} on ${url}`);
        assert.equal(reply.password, undefined);
        assert.equal(JSON.stringify(reply).includes("pw-"), false);
      }
      conn.close();
    });

    await check("plain http pages, odd pages and unknown ids are refused", async () => {
      const conn = await session();
      assert.equal((await getLogin(conn, 1, "http://example.com")).error, "insecure-page");
      assert.equal((await getLogin(conn, 8, "http://insecure.test")).error, "insecure-page");
      assert.equal((await getLogin(conn, 1, "chrome://extensions")).error, "unsupported-page");
      assert.equal((await getLogin(conn, 1, "javascript:alert(1)")).error, "unsupported-page");
      assert.equal((await getLogin(conn, 1, "https://user:pw@example.com")).error, "unsupported-page");
      assert.equal((await getLogin(conn, 1, "nonsense")).error, "bad-url");
      assert.equal((await getLogin(conn, 999, "https://example.com")).error, "no-match");
      assert.equal((await getLogin(conn, 0, "https://example.com")).error, "no-match");
      assert.equal((await getLogin(conn, -1, "https://example.com")).error, "no-match");
      conn.close();
    });

    await check("the id must be a real number and the url a string", async () => {
      state.t += 10 * 60 * 1000;
      const conn = await session();
      for (const bad of ["1", "1.0", 1.5, NaN, Infinity, null, undefined, {}, [], [1], true, 2 ** 60]) {
        const reply = await conn.request({ type: "get-login", loginId: bad, url: "https://example.com" });
        assert.equal(reply.error, "bad-message", String(bad));
      }
      for (const bad of [undefined, null, 5, {}, ["https://example.com"]]) {
        assert.equal((await conn.request({ type: "get-login", loginId: 1, url: bad })).error, "bad-message");
      }
      assert.equal((await conn.request({ type: "get-login" })).error, "bad-message");
      conn.close();
    });

    await check("a login with nothing to fill says so; a locked vault is locked; other failures leak nothing", async () => {
      state.t += 10 * 60 * 1000;
      const conn = await session();
      assert.equal((await getLogin(conn, 6, "https://empty.test")).error, "no-credentials");

      state.locked = true;
      const locked = await getLogin(conn, 1, "https://example.com");
      assert.deepEqual({ ok: locked.ok, error: locked.error, password: locked.password }, { ok: false, error: "locked", password: undefined });
      state.locked = false;

      state.boom = true;
      const failed = await getLogin(conn, 1, "https://example.com");
      assert.equal(failed.error, "internal-error");
      assert.equal(JSON.stringify(failed).includes("pw-1"), false, "the error text never reaches the caller");
      state.boom = false;
      assert.equal((await getLogin(conn, 1, "https://example.com")).ok, true);
      conn.close();
    });

    await check("only get-login ever returns a password", async () => {
      state.t += 10 * 60 * 1000;
      const conn = await session();
      const replies = [
        await conn.request({ type: "find-logins", url: "https://example.com" }),
        await conn.request({ type: "ping" }),
        await getLogin(conn, 3, "https://example.com"),
        await getLogin(conn, 1, "http://example.com")
      ];
      for (const reply of replies) assert.equal(JSON.stringify(reply).includes("pw-"), false);
      conn.close();
    });

    await check("rate limit per connection: 10 a minute, counted even when refused, and it recovers", async () => {
      state.t += 10 * 60 * 1000;
      const conn = await session();
      for (let i = 0; i < FILL_LIMITS.perConnection; i += 1) {
        assert.equal((await getLogin(conn, 1, i % 2 ? "https://example.com" : "https://wrong.example")).error !== "rate-limited", true, `request ${i + 1}`);
      }
      const limited = await getLogin(conn, 1, "https://example.com");
      assert.deepEqual({ ok: limited.ok, error: limited.error, password: limited.password }, { ok: false, error: "rate-limited", password: undefined });

      // a fresh connection has its own allowance...
      const other = await session();
      assert.equal((await getLogin(other, 1, "https://example.com")).ok, true);
      other.close();

      // ...and after a minute this one works again
      state.t += FILL_LIMITS.windowMs + 1;
      assert.equal((await getLogin(conn, 1, "https://example.com")).ok, true);
      conn.close();
    });

    await check("overall limit: many connections together cannot exceed 20 a minute", async () => {
      state.t += 10 * 60 * 1000;
      let released = 0;
      const conns = [];
      for (let c = 0; c < 4; c += 1) conns.push(await session());
      for (let round = 0; round < 8; round += 1) {
        for (const conn of conns) {
          const reply = await getLogin(conn, 1, "https://example.com");
          if (reply.ok) released += 1;
        }
      }
      assert.equal(released, FILL_LIMITS.overall, "20 passwords in the minute, no more");
      for (const conn of conns) conn.close();
    });

    // ── The optional approval in the app ──────────────────────────────────────
    await check("approval: asked only for a valid request, shown only site and name, and a refusal releases nothing", async () => {
      await bridge.stop();
      state.approvals = [];
      let answer = false;
      bridge = createExtensionBridge({
        pipeName,
        handlers: makeHandlers({ approve: async (details) => { state.approvals.push(details); return answer; } })
      });
      await bridge.start();
      state.t += 10 * 60 * 1000;
      const conn = await session();

      // not asked about a request that would be refused anyway
      assert.equal((await getLogin(conn, 3, "https://example.com")).error, "no-match");
      assert.equal((await getLogin(conn, 1, "http://example.com")).error, "insecure-page");
      assert.equal(state.approvals.length, 0, "no prompt for requests that fail the checks");

      answer = false;
      const declined = await getLogin(conn, 1, "https://example.com");
      assert.deepEqual({ ok: declined.ok, error: declined.error, password: declined.password }, { ok: false, error: "declined", password: undefined });
      assert.deepEqual(state.approvals, [{ host: "example.com", name: "Site 1" }], "no username or password in the prompt");

      answer = true;
      assert.equal((await getLogin(conn, 1, "https://example.com")).password, "pw-1");

      for (const odd of [undefined, null, "yes", 1, {}, "true"]) {
        answer = odd;
        state.t += 61 * 1000;
        assert.equal((await getLogin(conn, 1, "https://example.com")).error, "declined", `approve returned ${JSON.stringify(odd)}`);
      }
      conn.close();
    });

    await check("approval: a failing prompt releases nothing and leaks nothing", async () => {
      await bridge.stop();
      bridge = createExtensionBridge({ pipeName, handlers: makeHandlers({ approve: async () => { throw new Error("dialog crashed near pw-1"); } }) });
      await bridge.start();
      state.t += 10 * 60 * 1000;
      const conn = await session();
      const reply = await getLogin(conn, 1, "https://example.com");
      assert.equal(reply.ok, false);
      assert.equal(reply.error, "internal-error");
      assert.equal(JSON.stringify(reply).includes("pw-1"), false);
      conn.close();
    });

    await check("approval: what changed while the person decided is taken into account", async () => {
      await bridge.stop();
      const saved = state.credentials;
      const decide = { run: async () => true };
      bridge = createExtensionBridge({ pipeName, handlers: makeHandlers({ approve: () => decide.run() }) });
      await bridge.start();
      const conn = await session();

      // locked while the prompt was open: nothing is released even though they said Fill
      decide.run = async () => { state.locked = true; return true; };
      let reply = await getLogin(conn, 1, "https://example.com");
      assert.deepEqual({ ok: reply.ok, error: reply.error, password: reply.password }, { ok: false, error: "locked", password: undefined });
      state.locked = false;

      // the entry was moved to another site meanwhile
      state.t += 61 * 1000;
      decide.run = async () => { state.credentials = [cred(1, "moved.test"), ...saved.slice(1)]; return true; };
      reply = await getLogin(conn, 1, "https://example.com");
      assert.deepEqual({ ok: reply.ok, error: reply.error, password: reply.password }, { ok: false, error: "no-match", password: undefined });
      state.credentials = saved;

      // the password was changed meanwhile: what is released is what is saved now
      state.t += 61 * 1000;
      decide.run = async () => { state.credentials = [cred(1, "example.com", { password: "pw-CHANGED" }), ...saved.slice(1)]; return true; };
      reply = await getLogin(conn, 1, "https://example.com");
      assert.equal(reply.password, "pw-CHANGED");
      state.credentials = saved;

      // the entry was deleted meanwhile
      state.t += 61 * 1000;
      decide.run = async () => { state.credentials = saved.slice(1); return true; };
      reply = await getLogin(conn, 1, "https://example.com");
      assert.equal(reply.error, "no-match");
      state.credentials = saved;
      conn.close();
    });

    // ── Someone who stole the pairing secret ──────────────────────────────────
    await check("a stolen secret gets at most one password a few seconds, and only for exact sites", async () => {
      await bridge.stop();
      let asked = 0;
      bridge = createExtensionBridge({ pipeName, handlers: makeHandlers({ approve: async () => { asked += 1; return false; } }) });
      await bridge.start();
      state.t += 10 * 60 * 1000;

      // with the approval switched on, a thief with the secret still gets nothing without a click
      const thief = await session();
      let released = 0;
      for (let id = 1; id <= 8; id += 1) {
        for (const url of ["https://example.com", "https://other.test", "https://localhost"]) {
          if ((await getLogin(thief, id, url)).password) released += 1;
        }
      }
      assert.equal(released, 0);
      assert.ok(asked >= 1 && asked <= FILL_LIMITS.perConnection, "the person was asked, and the number of prompts is limited too");
      thief.close();
    });
  } finally {
    await bridge.stop();
  }

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nextension get-login tests FAILED" : "\nextension get-login tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
