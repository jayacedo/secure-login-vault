// Tests for pairing and two-way authentication between the app and the extension
// (src/services/extensionPairing.js), alone and over a real named pipe.
//   npm run test:pairing
const assert = require("assert");
const crypto = require("crypto");
const net = require("net");
const { createPairing, parseCode, encodeCode, formatCode, CODE_LENGTH } = require("../src/services/extensionPairing");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { createExtensionHandlers, requireAuth } = require("../src/services/extensionHandlers");
const { encodeMessage, createMessageReader } = require("../src/native-host/framing");
const { getPipeName } = require("../src/native-host/pipeName");

setTimeout(() => {
  console.error("pairing test timed out");
  process.exit(1);
}, 60000).unref();

// ── An independent implementation of the extension's side ─────────────────────
// (deliberately not using the module under test, so the two cannot just agree with
// each other by sharing a mistake)
const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 32));
const mac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
const nonce = () => crypto.randomBytes(16).toString("hex");

const client = {
  pairKey: (codeBytes) => hkdf(codeBytes, "slv-pair-v1", "auth"),
  pairSecret: (codeBytes, ne, na) => hkdf(codeBytes, Buffer.from(ne + na), "secret"),
  appProof: (key, label, ne, na) => mac(key, `${label}-app|${ne}|${na}`),
  extProof: (key, label, ne, na) => mac(key, `${label}-ext|${ne}|${na}`)
};

function memoryStorage(initial = null) {
  const box = { value: initial, failSave: false };
  return {
    box,
    load: () => box.value,
    save(value) {
      if (box.failSave) throw new Error("disk full");
      box.value = value;
    },
    clear() {
      box.value = null;
    }
  };
}

function fakeClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, advance: (ms) => (clock.t += ms) };
  return clock;
}

// Runs the extension's half of pairing against a pairing object, directly.
function pairDirectly(pairing, code, context = {}, { tamperProof = false } = {}) {
  const codeBytes = parseCode(code);
  const ne = nonce();
  const begin = pairing.pairBegin({ nonceE: ne }, context);
  if (begin.error) return { begin };
  const key = client.pairKey(codeBytes);
  const appOk = begin.appProof === client.appProof(key, "pair", ne, begin.nonceA);
  let proof = client.extProof(key, "pair", ne, begin.nonceA);
  if (tamperProof) proof = proof.replace(/^./, proof[0] === "0" ? "1" : "0");
  const finish = pairing.pairFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: proof }, context);
  return { begin, finish, appOk, ne, secret: client.pairSecret(codeBytes, ne, begin.nonceA) };
}

// ── A client over the real pipe ───────────────────────────────────────────────
function connect(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    const waiting = new Map();
    let closed = false;
    const reader = createMessageReader({
      onMessage(value) {
        const resolver = waiting.get(value.id);
        if (resolver) {
          waiting.delete(value.id);
          resolver(value);
        }
      },
      onError() {}
    });
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      closed = true;
      for (const resolver of waiting.values()) resolver(null);
      waiting.clear();
    });
    socket.once("connect", () =>
      resolve({
        isClosed: () => closed,
        close: () => socket.destroy(),
        request(message, timeoutMs = 5000) {
          return new Promise((res) => {
            const id = message.id || nonce();
            const timer = setTimeout(() => {
              waiting.delete(id);
              res(undefined);
            }, timeoutMs);
            waiting.set(id, (value) => {
              clearTimeout(timer);
              res(value);
            });
            socket.write(encodeMessage({ ...message, id }));
          });
        },
        whenClosed: () => new Promise((res) => (closed ? res() : socket.once("close", res)))
      })
    );
    socket.once("error", reject);
  });
}

// The extension's side of the per-connection proof, over the wire. Returns what the
// app answered and whether the app's proof checked out.
async function authenticate(conn, secret) {
  return require("./pairingTestClient").authenticate(conn, secret);
}

async function pairOverPipe(conn, code) {
  const codeBytes = parseCode(code);
  const ne = nonce();
  const begin = await conn.request({ type: "pair-begin", nonceE: ne });
  if (!begin || begin.ok !== true) return { begin };
  const key = client.pairKey(codeBytes);
  const appOk = begin.appProof === client.appProof(key, "pair", ne, begin.nonceA);
  const finish = await conn.request({ type: "pair-finish", nonceE: ne, nonceA: begin.nonceA, extProof: client.extProof(key, "pair", ne, begin.nonceA) });
  return { begin, finish, appOk, secret: client.pairSecret(codeBytes, ne, begin.nonceA) };
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

  // ── The code ────────────────────────────────────────────────────────────────
  await check("a code round-trips and is shown in groups of four", async () => {
    for (let i = 0; i < 50; i += 1) {
      const bytes = crypto.randomBytes(16);
      const raw = encodeCode(bytes);
      assert.equal(raw.length, CODE_LENGTH);
      assert.ok(parseCode(raw).equals(bytes));
      const shown = formatCode(raw);
      assert.match(shown, /^([A-Z2-9]{4}-){6}[A-Z2-9]{2}$/);
      assert.ok(parseCode(shown).equals(bytes));
      assert.ok(parseCode(shown.toLowerCase().replace(/-/g, "  ")).equals(bytes), "case, spaces and dashes are forgiven");
    }
  });

  await check("malformed codes are rejected", async () => {
    const good = formatCode(encodeCode(crypto.randomBytes(16)));
    const raw = good.replace(/-/g, "");
    assert.equal(parseCode(raw.slice(1)), null, "too short");
    assert.equal(parseCode(`${raw}A`), null, "too long");
    assert.equal(parseCode(`${raw.slice(0, -1)}0`), null, "0 is not in the alphabet");
    assert.equal(parseCode(`${raw.slice(0, -1)}O`), null, "O is not in the alphabet");
    assert.equal(parseCode(`${raw.slice(0, -1)}!`), null);
    assert.equal(parseCode("A".repeat(10000)), null, "huge input");
    for (const bad of [undefined, null, 5, {}, [], "", "   "]) assert.equal(parseCode(bad), null);
    // the last character carries 3 unused bits that must be zero
    assert.equal(parseCode(`${raw.slice(0, -1)}9`), null, "non-zero padding bits");
  });

  await check("codes are random and each start replaces the last", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    const a = pairing.startPairing().code;
    const b = pairing.startPairing().code;
    assert.notEqual(a, b);
    assert.equal(pairDirectly(pairing, a).finish.error, "bad-proof", "the old code no longer works");
    assert.equal(pairDirectly(pairing, b).finish.paired, true);
  });

  // ── Pairing ─────────────────────────────────────────────────────────────────
  await check("pairing succeeds with the right code; both sides derive the same secret", async () => {
    const storage = memoryStorage();
    const pairing = createPairing({ storage });
    assert.equal(pairing.isPaired(), false);
    const { code } = pairing.startPairing();
    assert.equal(pairing.isPairingActive(), true);
    const run = pairDirectly(pairing, code);
    assert.equal(run.appOk, true, "the extension can verify the app's proof");
    assert.deepEqual(run.finish, { paired: true });
    assert.equal(pairing.isPaired(), true);
    assert.equal(pairing.isPairingActive(), false, "the code is used up");
    assert.equal(storage.box.value.pairings[0].secret, run.secret.toString("hex"), "app stored what the extension derived");
  });

  await check("a code works only once", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    const { code } = pairing.startPairing();
    assert.equal(pairDirectly(pairing, code).finish.paired, true);
    assert.equal(pairDirectly(pairing, code).begin.error, "no-pairing");
  });

  await check("no code shown: pairing is refused", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    assert.equal(pairing.pairBegin({ nonceE: nonce() }, {}).error, "no-pairing");
    pairing.startPairing();
    pairing.cancelPairing();
    assert.equal(pairing.pairBegin({ nonceE: nonce() }, {}).error, "no-pairing");
  });

  await check("a code expires", async () => {
    const clock = fakeClock();
    const pairing = createPairing({ storage: memoryStorage(), now: clock.now });
    const { code } = pairing.startPairing();
    clock.advance(2 * 60 * 1000 - 1);
    assert.equal(pairing.isPairingActive(), true);
    clock.advance(2);
    assert.equal(pairing.isPairingActive(), false);
    assert.equal(pairDirectly(pairing, code).begin.error, "no-pairing");
  });

  await check("a code that expires between the two messages is refused", async () => {
    const clock = fakeClock();
    const pairing = createPairing({ storage: memoryStorage(), now: clock.now });
    const { code } = pairing.startPairing();
    const codeBytes = parseCode(code);
    const ne = nonce();
    const ctx = {};
    const begin = pairing.pairBegin({ nonceE: ne }, ctx);
    clock.advance(3 * 60 * 1000);
    const finish = pairing.pairFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: client.extProof(client.pairKey(codeBytes), "pair", ne, begin.nonceA) }, ctx);
    assert.equal(finish.error, "no-pairing");
    assert.equal(pairing.isPaired(), false);
  });

  await check("an impostor extension without the code is refused and nothing is stored", async () => {
    const storage = memoryStorage();
    const pairing = createPairing({ storage });
    const { code } = pairing.startPairing();
    const wrong = formatCode(encodeCode(crypto.randomBytes(16)));
    assert.notEqual(wrong, code);
    const run = pairDirectly(pairing, wrong);
    assert.equal(run.appOk, false, "the app's proof does not match what the impostor expects");
    assert.equal(run.finish.error, "bad-proof");
    assert.equal(pairing.isPaired(), false);
    assert.equal(storage.box.value, null);
    assert.equal(pairing.isPairingActive(), true, "one bad attempt does not kill the code");
  });

  await check("a tampered proof is refused", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    const { code } = pairing.startPairing();
    assert.equal(pairDirectly(pairing, code, {}, { tamperProof: true }).finish.error, "bad-proof");
    assert.equal(pairing.isPaired(), false);
  });

  await check("too many bad attempts burn the code, even for the real extension", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    const { code } = pairing.startPairing();
    for (let i = 0; i < 10; i += 1) pairDirectly(pairing, code, {}, { tamperProof: true });
    assert.equal(pairing.isPairingActive(), false);
    assert.equal(pairDirectly(pairing, code).begin.error, "no-pairing");
  });

  await check("the finish step is bound to its own connection, nonces and kind", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    const { code } = pairing.startPairing();
    const key = client.pairKey(parseCode(code));
    const ne = nonce();
    const mine = {};
    const begin = pairing.pairBegin({ nonceE: ne }, mine);
    const proof = client.extProof(key, "pair", ne, begin.nonceA);

    // another connection cannot complete my handshake (pending entry is consumed too)
    assert.equal(pairing.pairFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: proof }, {}).error, "bad-proof");
    // ...and the entry is gone, so I cannot either: a fresh handshake is needed
    assert.equal(pairing.pairFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: proof }, mine).error, "bad-proof");
    assert.equal(pairing.isPaired(), false);

    // a different nonceE than the one that began
    const ne2 = nonce();
    const begin2 = pairing.pairBegin({ nonceE: ne }, mine);
    assert.equal(pairing.pairFinish({ nonceE: ne2, nonceA: begin2.nonceA, extProof: client.extProof(key, "pair", ne2, begin2.nonceA) }, mine).error, "bad-proof");

    // an unknown nonceA
    assert.equal(pairing.pairFinish({ nonceE: ne, nonceA: nonce(), extProof: proof }, mine).error, "bad-proof");

    // and the honest path still works afterwards
    assert.equal(pairDirectly(pairing, code, {}).finish.paired, true);
  });

  await check("a handshake that is not finished in time goes stale", async () => {
    const clock = fakeClock();
    const pairing = createPairing({ storage: memoryStorage(), now: clock.now });
    const { code } = pairing.startPairing();
    const key = client.pairKey(parseCode(code));
    const ne = nonce();
    const ctx = {};
    const begin = pairing.pairBegin({ nonceE: ne }, ctx);
    clock.advance(31 * 1000);
    assert.equal(pairing.pairFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: client.extProof(key, "pair", ne, begin.nonceA) }, ctx).error, "bad-proof");
  });

  await check("malformed fields are rejected, never thrown", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    pairing.startPairing();
    const ctx = {};
    for (const bad of [undefined, null, 5, "", "zz", "A".repeat(32), "a".repeat(31), "a".repeat(33), {}, []]) {
      assert.equal(pairing.pairBegin({ nonceE: bad }, ctx).error, "bad-message");
      assert.equal(pairing.authBegin({ nonceE: bad }, ctx).error, "bad-message");
      assert.equal(pairing.pairFinish({ nonceE: nonce(), nonceA: bad, extProof: "a".repeat(64) }, ctx).error, "bad-message");
      assert.equal(pairing.pairFinish({ nonceE: nonce(), nonceA: nonce(), extProof: bad }, ctx).error, "bad-message");
      assert.equal((await pairing.authFinish({ nonceE: nonce(), nonceA: nonce(), extProof: bad }, ctx)).error, "bad-message");
    }
  });

  await check("too many open handshakes: the app says busy instead of growing", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    pairing.startPairing();
    let busy = 0;
    for (let i = 0; i < 20; i += 1) if (pairing.pairBegin({ nonceE: nonce() }, {}).error === "busy") busy += 1;
    assert.equal(busy, 12, "8 slots, the rest are refused");
  });

  await check("a storage failure means not paired", async () => {
    const storage = memoryStorage();
    storage.box.failSave = true;
    const pairing = createPairing({ storage });
    const { code } = pairing.startPairing();
    assert.equal(pairDirectly(pairing, code).finish.error, "storage-failed");
    assert.equal(pairing.isPaired(), false);
  });

  // ── Per-connection proof ────────────────────────────────────────────────────
  await check("auth before pairing says not-paired", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    assert.equal(pairing.authBegin({ nonceE: nonce() }, {}).error, "not-paired");
    assert.equal((await pairing.authFinish({ nonceE: nonce(), nonceA: nonce(), extProof: "a".repeat(64) }, {})).error, "not-paired");
  });

  await check("auth: right secret authenticates the connection, both ways", async () => {
    const storage = memoryStorage();
    const pairing = createPairing({ storage });
    const run = pairDirectly(pairing, pairing.startPairing().code);
    const ctx = { authenticated: false };
    const ne = nonce();
    const begin = pairing.authBegin({ nonceE: ne }, ctx);
    assert.equal(begin.appProof, client.appProof(run.secret, "auth-v2", ne, begin.nonceA), "the app proves it holds the secret");
    assert.deepEqual(await pairing.authFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: client.extProof(run.secret, "auth-v2", ne, begin.nonceA) }, ctx), { authenticated: true });
    assert.equal(ctx.authenticated, true);
  });

  await check("auth: a wrong secret never authenticates", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    pairDirectly(pairing, pairing.startPairing().code);
    const ctx = { authenticated: false };
    const ne = nonce();
    const begin = pairing.authBegin({ nonceE: ne }, ctx);
    const fake = crypto.randomBytes(32);
    assert.notEqual(begin.appProof, client.appProof(fake, "auth-v2", ne, begin.nonceA));
    assert.equal((await pairing.authFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: client.extProof(fake, "auth-v2", ne, begin.nonceA) }, ctx)).error, "bad-proof");
    assert.equal(ctx.authenticated, false);
  });

  await check("auth: a recorded handshake cannot be replayed on another connection", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    const run = pairDirectly(pairing, pairing.startPairing().code);
    // a full honest handshake on connection 1, recorded by an eavesdropper
    const first = { authenticated: false };
    const ne = nonce();
    const begin = pairing.authBegin({ nonceE: ne }, first);
    const proof = client.extProof(run.secret, "auth-v2", ne, begin.nonceA);
    assert.equal((await pairing.authFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: proof }, first)).authenticated, true);

    // replayed verbatim on a new connection
    const second = { authenticated: false };
    assert.equal((await pairing.authFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: proof }, second)).error, "bad-proof");
    // replaying the old begin gets a new app nonce, so the old proof no longer fits
    const begin2 = pairing.authBegin({ nonceE: ne }, second);
    assert.notEqual(begin2.nonceA, begin.nonceA);
    assert.equal((await pairing.authFinish({ nonceE: ne, nonceA: begin2.nonceA, extProof: proof }, second)).error, "bad-proof");
    assert.equal(second.authenticated, false);
  });

  await check("a pairing handshake cannot be used as an auth handshake (or the reverse)", async () => {
    const pairing = createPairing({ storage: memoryStorage() });
    const run = pairDirectly(pairing, pairing.startPairing().code);
    const { code } = pairing.startPairing();
    const codeBytes = parseCode(code);
    const ctx = { authenticated: false };
    const ne = nonce();
    const begin = pairing.pairBegin({ nonceE: ne }, ctx);
    // answer a pair-begin with an auth-finish using the real secret
    assert.equal((await pairing.authFinish({ nonceE: ne, nonceA: begin.nonceA, extProof: client.extProof(run.secret, "auth-v2", ne, begin.nonceA) }, ctx)).error, "bad-proof");
    assert.equal(ctx.authenticated, false);
    // answer an auth-begin with a pair-finish
    const ne2 = nonce();
    const begin2 = pairing.authBegin({ nonceE: ne2 }, ctx);
    assert.equal(pairing.pairFinish({ nonceE: ne2, nonceA: begin2.nonceA, extProof: client.extProof(client.pairKey(codeBytes), "pair", ne2, begin2.nonceA) }, ctx).error, "bad-proof");
  });

  // ── Remembering and forgetting ──────────────────────────────────────────────
  await check("the pairing survives a restart; unpair forgets it", async () => {
    const storage = memoryStorage();
    const first = createPairing({ storage });
    pairDirectly(first, first.startPairing().code);
    assert.equal(createPairing({ storage }).isPaired(), true, "a new instance loads the secret");

    assert.equal(first.unpair(), true);
    assert.equal(first.isPaired(), false);
    assert.equal(createPairing({ storage }).isPaired(), false);
    assert.equal(first.unpair(), false, "nothing left to forget");
    assert.equal(first.authBegin({ nonceE: nonce() }, {}).error, "not-paired");
  });

  await check("unreadable or malformed stored data means not paired", async () => {
    for (const value of [{ secret: "nothex" }, { secret: "ab" }, { secret: 5 }, {}, "x", []]) {
      assert.equal(createPairing({ storage: memoryStorage(value) }).isPaired(), false, JSON.stringify(value));
    }
    const throwing = { load: () => { throw new Error("cannot decrypt"); }, save() {}, clear() {} };
    assert.equal(createPairing({ storage: throwing }).isPaired(), false);
  });

  await check("a storage object is required", async () => {
    assert.throws(() => createPairing({}), /storage/);
    assert.throws(() => createPairing({ storage: { load() {} } }), /storage/);
  });

  // ── Over a real named pipe ──────────────────────────────────────────────────
  const pipeName = getPipeName(`pairing-test-${process.pid}`);
  const storage = memoryStorage();
  const pairing = createPairing({ storage });
  const handlers = createExtensionHandlers({ getAppVersion: () => "9.9.9", pairing });
  handlers["channel-check"] = requireAuth(() => ({ value: "only for authenticated connections" }));
  const bridge = createExtensionBridge({ pipeName, handlers });
  await bridge.start();

  try {
    await check("pipe: protected requests are refused before authentication", async () => {
      const conn = await connect(pipeName);
      const refused = await conn.request({ type: "channel-check" });
      assert.deepEqual({ ok: refused.ok, error: refused.error }, { ok: false, error: "not-authenticated" });
      assert.equal((await conn.request({ type: "ping" })).ok, true, "ping stays open");
      conn.close();
    });

    let secret;
    await check("pipe: the full pairing over the wire", async () => {
      const conn = await connect(pipeName);
      assert.equal((await conn.request({ type: "pair-begin", nonceE: nonce() })).error, "no-pairing");
      const { code } = pairing.startPairing();
      const run = await pairOverPipe(conn, code);
      assert.equal(run.appOk, true);
      assert.equal(run.finish.ok, true);
      assert.equal(run.finish.paired, true);
      secret = run.secret;
      conn.close();
    });

    await check("pipe: a paired extension authenticates and reaches protected requests", async () => {
      const conn = await connect(pipeName);
      const run = await authenticate(conn, secret);
      assert.equal(run.appOk, true, "the extension verified the app");
      assert.equal(run.finish.ok, true);
      const reply = await conn.request({ type: "channel-check" });
      assert.equal(reply.ok, true);
      assert.equal(reply.value, "only for authenticated connections");
      conn.close();
    });

    await check("pipe: authentication belongs to one connection only", async () => {
      const authed = await connect(pipeName);
      await authenticate(authed, secret);
      const other = await connect(pipeName);
      assert.equal((await other.request({ type: "channel-check" })).error, "not-authenticated");
      authed.close();
      other.close();
    });

    await check("pipe: an impostor extension with a made-up secret is refused", async () => {
      const conn = await connect(pipeName);
      const run = await authenticate(conn, crypto.randomBytes(32));
      assert.equal(run.appOk, false);
      assert.equal(run.finish.ok, false);
      assert.equal((await conn.request({ type: "channel-check" })).error, "not-authenticated");
      conn.close();
    });

    await check("pipe: an impostor app (no secret) cannot make the extension's check pass", async () => {
      // What a fake app would have to produce: a valid proof for the extension's nonce.
      const fakeApp = createPairing({ storage: memoryStorage({ secret: crypto.randomBytes(32).toString("hex") }) });
      const ne = nonce();
      const begin = fakeApp.authBegin({ nonceE: ne }, {});
      assert.notEqual(begin.appProof, client.appProof(secret, "auth-v2", ne, begin.nonceA));
    });

    await check("pipe: a second pairing preserves the first secret", async () => {
      const conn = await connect(pipeName);
      const run = await pairOverPipe(conn, pairing.startPairing().code);
      assert.equal(run.finish.paired, true);
      assert.notDeepEqual(run.secret, secret);
      assert.equal((await authenticate(conn, secret)).finish.ok, true, "the first browser stays paired");
      const second = await connect(pipeName);
      assert.equal((await authenticate(second, run.secret)).finish.ok, true);
      second.close();
      secret = run.secret;
      conn.close();
    });

    await check("pipe: unpairing ends the access and drops open connections", async () => {
      const conn = await connect(pipeName);
      assert.equal((await authenticate(conn, secret)).finish.ok, true);
      assert.equal((await conn.request({ type: "channel-check" })).ok, true);

      pairing.unpair();
      bridge.closeConnections();
      await Promise.race([conn.whenClosed(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      assert.equal(conn.isClosed(), true, "the open connection was dropped");

      const again = await connect(pipeName);
      const run = await authenticate(again, secret);
      assert.equal(run.begin.error, "not-paired");
      assert.equal((await again.request({ type: "channel-check" })).error, "not-authenticated");
      again.close();
    });

    await check("pipe: handler errors are plain failure replies and ping is unchanged", async () => {
      const conn = await connect(pipeName);
      const reply = await conn.request({ type: "auth-begin", nonceE: "bad" });
      assert.deepEqual({ ok: reply.ok, error: reply.error, extra: Object.keys(reply).sort().join() }, { ok: false, error: "bad-message", extra: "error,id,ok" });
      const pong = await conn.request({ type: "ping" });
      assert.deepEqual({ ok: pong.ok, type: pong.type, version: pong.appVersion }, { ok: true, type: "pong", version: "9.9.9" });
      conn.close();
    });
  } finally {
    await bridge.stop();
  }

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nextension pairing tests FAILED" : "\nextension pairing tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
