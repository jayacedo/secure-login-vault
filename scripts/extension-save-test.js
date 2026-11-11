// save-login: the one request that changes the vault. Over a real named pipe, with the real
// pairing, handlers and bridge, and a stand-in vault that records every write.
//   npm run test:save
const assert = require("assert");
const { createPairing } = require("../src/services/extensionPairing");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { createExtensionHandlers, SAVE_LIMITS } = require("../src/services/extensionHandlers");
const { getPipeName } = require("../src/native-host/pipeName");
const { connect, pair, authenticate } = require("./pairingTestClient");

setTimeout(() => {
  console.error("extension save-login test timed out");
  process.exit(1);
}, 90000).unref();

const cred = (id, websiteUrl, extra = {}) => ({ id, websiteName: `Site ${id}`, websiteUrl, username: `user${id}`, email: "", password: `pw-${id}`, ...extra });
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
      for (const conn of openConnections) conn.close();
      openConnections.clear();
    }
  };

  const state = {
    t: 1_000_000,
    locked: false,
    writeFails: false,
    credentials: [],
    writes: [],
    prompts: [],
    answer: true,
    during: null // runs while the person "decides"
  };
  const reset = () => {
    state.locked = false;
    state.writeFails = false;
    state.credentials = [cred(1, "example.com", { username: "alice", password: "old-pw" }), cred(2, "https://www.example.com", { username: "bob" }), cred(3, "other.test", { username: "alice" }), cred(4, "localhost:3000", { username: "dev" })];
    state.writes = [];
    state.prompts = [];
    state.answer = true;
    state.during = null;
  };
  reset();

  const pairing = createPairing({ storage: memoryStorage() });
  const makeHandlers = (extra = {}) =>
    createExtensionHandlers({
      getAppVersion: () => "1.0.0",
      pairing,
      now: () => state.t,
      vault: {
        getCredentials: async () => {
          if (state.locked) throw Object.assign(new Error("Vault is locked."), { isPublic: true });
          return state.credentials;
        },
        addCredential: async (data) => {
          if (state.locked) throw Object.assign(new Error("Vault is locked."), { isPublic: true });
          if (state.writeFails) throw new Error(`disk exploded while saving ${data.password}`);
          state.writes.push({ kind: "add", data });
          return { id: 99 };
        },
        updatePassword: async (id, password) => {
          if (state.locked) throw Object.assign(new Error("Vault is locked."), { isPublic: true });
          if (state.writeFails) throw new Error(`disk exploded while saving ${password}`);
          state.writes.push({ kind: "update", id, password });
        }
      },
      approveSave: async (what) => {
        state.prompts.push(what);
        if (state.during) await state.during();
        return state.answer;
      },
      ...extra
    });

  const pipeName = getPipeName(`save-test-${process.pid}`);
  let bridge = createExtensionBridge({ pipeName, handlers: makeHandlers() });
  await bridge.start();

  const pairConn = await connect(pipeName);
  const paired = await pair(pairConn, pairing.startPairing().code);
  assert.equal(paired.finish.ok, true);
  pairConn.close();
  const secret = paired.secret;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const session = async () => {
    state.t += 10 * 60 * 1000; // each test starts with a fresh minute
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
  const save = (conn, fields) => conn.request({ type: "save-login", url: "https://example.com", username: "carol", password: "new-pw", ...fields });
  const brief = (reply) => ({ ok: reply.ok, error: reply.error });

  try {
    await check("refused until the connection has proven itself", async () => {
      reset();
      const conn = await connect(pipeName);
      const reply = await save(conn, {});
      assert.deepEqual(brief(reply), { ok: false, error: "not-authenticated" });
      assert.equal(state.prompts.length + state.writes.length, 0);
      conn.close();
    });

    await check("a new login is added for the exact origin, after the person agrees; the reply holds no password", async () => {
      reset();
      const conn = await session();
      const reply = await save(conn, { url: "https://example.com", username: " carol ", password: "new-pw" });
      assert.deepEqual({ ok: reply.ok, host: reply.host, mode: reply.mode }, { ok: true, host: "example.com", mode: "add" });
      assert.equal(JSON.stringify(reply).includes("new-pw"), false);
      assert.deepEqual(state.prompts, [{ host: "example.com", username: "carol", name: "example.com", mode: "add" }]);
      assert.equal(state.writes.length, 1);
      assert.deepEqual(state.writes[0], { kind: "add", data: { websiteName: "example.com", websiteUrl: "https://example.com", username: "carol", password: "new-pw" } });
      conn.close();
    });

    await check("a different password for a saved login (same origin and username) updates only the password", async () => {
      reset();
      const conn = await session();
      const reply = await save(conn, { username: "alice", password: "changed-pw" });
      assert.deepEqual({ ok: reply.ok, mode: reply.mode }, { ok: true, mode: "update" });
      assert.deepEqual(state.prompts, [{ host: "example.com", username: "alice", name: "Site 1", mode: "update" }]);
      assert.deepEqual(state.writes, [{ kind: "update", id: 1, password: "changed-pw" }]);
      conn.close();
    });

    await check("the same password again: nothing to save, no prompt", async () => {
      reset();
      const conn = await session();
      const reply = await save(conn, { username: "alice", password: "old-pw" });
      assert.deepEqual(brief(reply), { ok: false, error: "unchanged" });
      assert.equal(state.prompts.length + state.writes.length, 0);
      conn.close();
    });

    await check("only the exact origin and username count as 'the same login'", async () => {
      reset();
      const conn = await session();
      // alice exists on other.test and bob on www.example.com, but not here
      for (const [url, username] of [["https://example.com", "bob"], ["https://www.example.com", "alice"], ["https://example.com:8443", "alice"], ["https://other.test", "carol"]]) {
        state.writes = [];
        state.t += 61 * 1000;
        const reply = await save(conn, { url, username, password: "x-pw" });
        assert.equal(reply.mode, "add", `${username} on ${url} is a new login`);
        assert.equal(state.writes[0].kind, "add");
      }
      // a username that only differs in case is a different login (exact match)
      state.writes = [];
      state.t += 61 * 1000;
      assert.equal((await save(conn, { username: "ALICE", password: "x-pw" })).mode, "add");
      // and the saved login on the right site is updated, not copied
      state.writes = [];
      state.t += 61 * 1000;
      assert.equal((await save(conn, { url: "https://other.test", username: "alice", password: "x-pw" })).mode, "update");
      assert.equal(state.writes[0].id, 3);
      conn.close();
    });

    await check("declined or unclear answers write nothing", async () => {
      for (const answer of [false, undefined, null, "yes", 1, "true", {}, []]) {
        reset();
        state.answer = answer;
        const conn = await session();
        const reply = await save(conn, {});
        assert.deepEqual(brief(reply), { ok: false, error: "declined" }, `answer ${JSON.stringify(answer)}`);
        assert.equal(state.writes.length, 0);
        conn.close();
      }
    });

    await check("with no way to ask the person, nothing is ever saved", async () => {
      reset();
      await bridge.stop();
      bridge = createExtensionBridge({ pipeName, handlers: makeHandlers({ approveSave: undefined }) });
      await bridge.start();
      const conn = await session();
      assert.deepEqual(brief(await save(conn, {})), { ok: false, error: "declined" });
      assert.equal(state.writes.length, 0);
      conn.close();
      await bridge.stop();
      bridge = createExtensionBridge({ pipeName, handlers: makeHandlers() });
      await bridge.start();
    });

    await check("pages and values that are not accepted: nothing is asked or written", async () => {
      reset();
      const conn = await session();
      const bad = [
        [{ url: "http://insecure.test" }, "insecure-page"],
        [{ url: "http://example.com" }, "insecure-page"],
        [{ url: "ftp://example.com" }, "unsupported-page"],
        [{ url: "chrome://settings" }, "unsupported-page"],
        [{ url: "https://user:pw@example.com" }, "unsupported-page"],
        [{ url: "not a url" }, "bad-url"],
        [{ url: "" }, "bad-url"],
        [{ url: "https://example.com/" + "a".repeat(2100) }, "bad-url"],
        [{ url: 5 }, "bad-message"],
        [{ username: "" }, "bad-message"],
        [{ username: "   " }, "bad-message"],
        [{ username: 5 }, "bad-message"],
        [{ username: "u".repeat(257) }, "bad-message"],
        [{ password: "" }, "bad-message"],
        [{ password: 5 }, "bad-message"],
        [{ password: "p".repeat(1025) }, "bad-message"]
      ];
      for (const [fields, error] of bad) {
        state.t += 61 * 1000; // keep the rate limit out of this test
        const reply = await save(conn, fields);
        assert.deepEqual(brief(reply), { ok: false, error }, JSON.stringify(fields).slice(0, 80));
      }
      assert.equal(state.prompts.length + state.writes.length, 0);
      // loopback over plain http is allowed, like the rest of the extension
      state.t += 61 * 1000;
      assert.equal((await save(conn, { url: "http://localhost:3000", username: "dev", password: "local-new" })).mode, "update");
      conn.close();
    });

    await check("a locked vault: nothing asked, nothing written", async () => {
      reset();
      state.locked = true;
      const conn = await session();
      assert.deepEqual(brief(await save(conn, {})), { ok: false, error: "locked" });
      assert.equal(state.prompts.length + state.writes.length, 0);
      conn.close();
    });

    await check("what changed while the person decided is taken into account", async () => {
      const conn = await session();

      // locked meanwhile: they said yes, but nothing is written
      reset();
      state.during = async () => { state.locked = true; };
      assert.deepEqual(brief(await save(conn, {})), { ok: false, error: "locked" });
      assert.equal(state.writes.length, 0);

      // the same login was added meanwhile: what they agreed to (a new login) no longer holds
      reset();
      state.t += 61 * 1000;
      state.during = async () => { state.credentials = [...state.credentials, cred(10, "example.com", { username: "carol" })]; };
      assert.deepEqual(brief(await save(conn, {})), { ok: false, error: "changed" });
      assert.equal(state.writes.length, 0);

      // the login to update was deleted meanwhile
      reset();
      state.t += 61 * 1000;
      state.during = async () => { state.credentials = state.credentials.filter((c) => c.id !== 1); };
      assert.deepEqual(brief(await save(conn, { username: "alice", password: "changed-pw" })), { ok: false, error: "changed" });
      assert.equal(state.writes.length, 0);

      // the login to update was replaced by another entry with the same origin and username
      reset();
      state.t += 61 * 1000;
      state.during = async () => { state.credentials = [cred(11, "example.com", { username: "alice", password: "x" })]; };
      assert.deepEqual(brief(await save(conn, { username: "alice", password: "changed-pw" })), { ok: false, error: "changed" });
      assert.equal(state.writes.length, 0);
      conn.close();
    });

    await check("a newer password saved during approval is not overwritten", async () => {
      reset();
      const conn = await session();
      state.during = async () => { state.credentials[0].password = "newer-password"; };
      assert.deepEqual(brief(await save(conn, { username: "alice" })), { ok: false, error: "changed" });
      assert.equal(state.writes.length, 0);
      conn.close();
    });

    await check("disconnecting while approval is pending cancels the write", async () => {
      reset();
      const conn = await session();
      let release;
      let asked;
      const promptStarted = new Promise((resolve) => { asked = resolve; });
      state.during = () => new Promise((resolve) => { release = resolve; asked(); });
      const pending = save(conn, {});
      await promptStarted;
      conn.close();
      await conn.whenClosed();
      await sleep(30); // allow the server to observe the disconnect
      release();
      await pending;
      await sleep(30);
      assert.equal(state.writes.length, 0);
    });

    await check("a failing write gives a generic error that does not contain the password", async () => {
      reset();
      state.writeFails = true;
      const conn = await session();
      const reply = await save(conn, { password: "SECRET-in-message" });
      assert.equal(reply.ok, false);
      assert.equal(JSON.stringify(reply).includes("SECRET"), false);
      assert.equal(state.writes.length, 0);
      conn.close();
    });

    await check("saving is rate limited per connection and overall, and recovers", async () => {
      reset();
      const conn = await session();
      for (let i = 0; i < SAVE_LIMITS.perConnection; i += 1) {
        assert.equal((await save(conn, { username: `u${i}`, password: "pw" })).ok, true, `save ${i + 1}`);
      }
      state.writes = [];
      state.prompts = [];
      assert.deepEqual(brief(await save(conn, { username: "late", password: "pw" })), { ok: false, error: "rate-limited" });
      assert.equal(state.prompts.length + state.writes.length, 0, "a limited request is not even asked");
      state.t += 61 * 1000;
      assert.equal((await save(conn, { username: "later", password: "pw" })).ok, true);

      // many connections cannot get around it: the overall limit holds
      state.t += 61 * 1000;
      const conns = [await session(), await session(), await session()];
      state.t -= 20 * 60 * 1000; // all three share the same minute
      state.writes = [];
      let allowed = 0;
      for (let round = 0; round < SAVE_LIMITS.perConnection; round += 1) {
        for (const conn2 of conns) {
          if ((await save(conn2, { username: `v${allowed}-${round}-${Math.random()}`, password: "pw" })).ok) allowed += 1;
        }
      }
      assert.equal(allowed, SAVE_LIMITS.overall);
      conn.close();
      conns.forEach((c) => c.close());
    });
  } finally {
    await bridge.stop();
  }

  console.log(results.join("\n"));
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  console.log(failed ? `\n${failed} FAILED` : `\nAll ${results.length} save-login checks passed.`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
