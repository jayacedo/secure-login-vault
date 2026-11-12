const assert = require("assert");
const net = require("net");
const { PassThrough } = require("stream");
const { encodeMessage, createMessageReader } = require("../src/native-host/framing");
const { getPipeName } = require("../src/native-host/pipeName");
const { runHost } = require("../src/native-host/hostRelay");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { createExtensionHandlers, PROTOCOL_VERSION } = require("../src/services/extensionHandlers");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A hang (e.g. a connection that should have been dropped but wasn't) is a failure.
setTimeout(() => {
  console.error("extension-bridge test timed out");
  process.exit(1);
}, 30000).unref();

let counter = 0;
const freshPipeName = () => getPipeName(`bridge-test-${process.pid}-${Date.now()}-${(counter += 1)}`);

function makeBridge(overrides = {}) {
  const pipeName = overrides.pipeName || freshPipeName();
  const handlers = overrides.handlers || createExtensionHandlers({ getAppVersion: () => "9.9.9" });
  const bridge = createExtensionBridge({ pipeName, handlers, limits: overrides.limits });
  return { bridge, pipeName };
}

// A minimal client: connects to the pipe and speaks the framed protocol.
function connect(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    const frames = [];
    const waiting = [];
    let closed = false;
    const reader = createMessageReader({
      onMessage(value) {
        if (waiting.length) waiting.shift()(value);
        else frames.push(value);
      },
      onError() {}
    });
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      closed = true;
      while (waiting.length) waiting.shift()(undefined);
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve({
        socket,
        send: (message) => socket.write(encodeMessage(message)),
        sendRaw: (buffer) => socket.write(buffer),
        // Next message, or undefined if the connection closes first.
        next: (timeoutMs = 2000) =>
          frames.length
            ? Promise.resolve(frames.shift())
            : closed
              ? Promise.resolve(undefined)
              : new Promise((res, rej) => {
                  const timer = setTimeout(() => rej(new Error("no reply")), timeoutMs);
                  waiting.push((value) => { clearTimeout(timer); res(value); });
                }),
        isClosed: () => closed,
        repliesReceived: () => frames.length,
        closed: () => new Promise((res) => (closed ? res() : socket.once("close", res)))
      });
    });
  });
}

async function main() {
  // ── Start, stop, and the pipe being taken ──────────────────────────────────
  {
    const { bridge, pipeName } = makeBridge();
    assert.equal(bridge.isRunning(), false);
    await bridge.start();
    await bridge.start(); // starting twice is harmless
    assert.equal(bridge.isRunning(), true);

    const second = createExtensionBridge({ pipeName, handlers: {} });
    await assert.rejects(() => second.start(), (error) => error.code === "EADDRINUSE", "a second listener is refused");
    assert.equal(second.isRunning(), false);

    await bridge.stop();
    await bridge.stop(); // stopping twice is harmless
    assert.equal(bridge.isRunning(), false);
    await assert.rejects(() => connect(pipeName), "nothing listens after stop");

    await bridge.start(); // and it can be started again
    const client = await connect(pipeName);
    client.send({ id: 1, type: "ping" });
    assert.equal((await client.next()).ok, true);
    await bridge.stop();
  }

  // ── Ping ───────────────────────────────────────────────────────────────────
  {
    const { bridge, pipeName } = makeBridge();
    await bridge.start();
    const client = await connect(pipeName);

    client.send({ id: 1, type: "ping" });
    assert.deepEqual(await client.next(), { type: "pong", appVersion: "9.9.9", protocol: PROTOCOL_VERSION, id: 1, ok: true });

    client.send({ id: "abc", type: "ping", extra: "ignored" });
    assert.equal((await client.next()).id, "abc");

    client.send({ type: "ping" });
    const noId = await client.next();
    assert.equal(noId.ok, true);
    assert.equal("id" in noId, false, "no id in, none out");

    // Nothing about the vault is revealed
    assert.deepEqual(Object.keys(await (async () => { client.send({ id: 2, type: "ping" }); return client.next(); })()).sort(), [
      "appVersion", "id", "ok", "protocol", "type"
    ]);

    await bridge.stop();
  }

  // ── Unknown and malformed requests ─────────────────────────────────────────
  {
    const { bridge, pipeName } = makeBridge();
    await bridge.start();
    const client = await connect(pipeName);

    for (const type of ["get-passwords", "", "constructor", "__proto__", "toString", "hasOwnProperty", 5, null, ["ping"]]) {
      client.send({ id: 1, type });
      assert.deepEqual(await client.next(), { id: 1, ok: false, error: "unknown-type" }, `type ${JSON.stringify(type)}`);
    }
    client.send({ id: 2 });
    assert.deepEqual(await client.next(), { id: 2, ok: false, error: "unknown-type" });

    for (const bad of [[1], null, "x", 3, { id: {}, type: "ping" }, { id: true, type: "ping" }]) {
      client.send(bad);
      assert.deepEqual(await client.next(), { ok: false, error: "bad-message" }, JSON.stringify(bad));
    }

    client.send({ id: 3, type: "ping" });
    assert.equal((await client.next()).ok, true, "the connection survives bad messages");
    await bridge.stop();
  }

  // ── A failing handler reveals nothing ──────────────────────────────────────
  {
    const handlers = {
      boom() { throw new Error("secret detail: C:\\Users\\me\\vault.slv"); },
      async rejects() { throw new Error("another secret detail"); },
      ping: () => ({ type: "pong" })
    };
    const { bridge, pipeName } = makeBridge({ handlers });
    await bridge.start();
    const client = await connect(pipeName);
    for (const type of ["boom", "rejects"]) {
      client.send({ id: 1, type });
      const reply = await client.next();
      assert.deepEqual(reply, { id: 1, ok: false, error: "internal-error" });
      assert.equal(JSON.stringify(reply).includes("secret"), false);
    }
    client.send({ id: 2, type: "ping" });
    assert.equal((await client.next()).ok, true, "still serving afterwards");
    await bridge.stop();
  }

  // A handler's result cannot override the id or ok flag
  {
    const handlers = { sneaky: () => ({ id: "forged", ok: false, value: 1 }) };
    const { bridge, pipeName } = makeBridge({ handlers });
    await bridge.start();
    const client = await connect(pipeName);
    client.send({ id: 5, type: "sneaky" });
    assert.deepEqual(await client.next(), { id: 5, ok: true, value: 1 });
    await bridge.stop();
  }

  // ── Bad framing closes only that connection ────────────────────────────────
  {
    const { bridge, pipeName } = makeBridge();
    await bridge.start();
    const healthy = await connect(pipeName);

    for (const [name, raw] of [
      ["over the 64 KiB request limit", (() => { const b = Buffer.alloc(4); b.writeUInt32LE(64 * 1024 + 1, 0); return b; })()],
      ["zero length", Buffer.alloc(4)],
      ["not json", Buffer.concat([(() => { const b = Buffer.alloc(4); b.writeUInt32LE(3, 0); return b; })(), Buffer.from("{{{")])]
    ]) {
      const bad = await connect(pipeName);
      bad.sendRaw(raw);
      await bad.closed();
      assert.equal(bad.isClosed(), true, name);
    }

    healthy.send({ id: 1, type: "ping" });
    assert.equal((await healthy.next()).ok, true, "other connections are unaffected");
    await bridge.stop();
  }

  // ── Connection cap ─────────────────────────────────────────────────────────
  {
    const { bridge, pipeName } = makeBridge({ limits: { maxConnections: 2 } });
    await bridge.start();
    const a = await connect(pipeName);
    const b = await connect(pipeName);
    a.send({ id: 1, type: "ping" });
    b.send({ id: 1, type: "ping" });
    await a.next();
    await b.next();
    assert.equal(bridge.connectionCount(), 2);

    const c = await connect(pipeName);
    c.send({ id: 1, type: "ping" });
    assert.equal(await c.next(), undefined, "the third connection is refused");

    a.socket.destroy();
    await sleep(100);
    const d = await connect(pipeName);
    d.send({ id: 1, type: "ping" });
    assert.equal((await d.next()).ok, true, "a slot frees up when a connection closes");
    await bridge.stop();
  }

  // ── Flooding ───────────────────────────────────────────────────────────────
  {
    const { bridge, pipeName } = makeBridge({ limits: { maxMessagesPerSecond: 10 } });
    await bridge.start();
    const client = await connect(pipeName);
    for (let i = 0; i < 100; i += 1) client.send({ id: i, type: "ping" });
    await client.closed();
    assert.equal(client.isClosed(), true, "the flooding connection is dropped");

    const polite = await connect(pipeName);
    polite.send({ id: 1, type: "ping" });
    assert.equal((await polite.next()).ok, true, "a well-behaved client still works");
    await bridge.stop();
  }

  // ── Silent and idle connections are dropped ────────────────────────────────
  {
    const { bridge, pipeName } = makeBridge({ limits: { firstMessageTimeoutMs: 150, idleTimeoutMs: 300 } });
    await bridge.start();

    const silent = await connect(pipeName); // never says anything
    await silent.closed();
    assert.equal(silent.isClosed(), true, "occupying a slot without speaking does not work");
    await sleep(50); // the server's own close handling runs just after the client sees it
    assert.equal(bridge.connectionCount(), 0);

    const idle = await connect(pipeName);
    idle.send({ id: 1, type: "ping" });
    await idle.next();
    await sleep(100);
    assert.equal(idle.isClosed(), false, "a recent message keeps the connection open");
    await idle.closed();
    assert.equal(idle.isClosed(), true, "an idle connection is eventually closed");
    await bridge.stop();
  }

  // Pings cannot keep an unauthenticated slot occupied beyond the auth deadline.
  {
    const { bridge, pipeName } = makeBridge({ limits: { authTimeoutMs: 250, idleTimeoutMs: 1000 } });
    await bridge.start();
    const client = await connect(pipeName);
    const timer = setInterval(() => { if (!client.isClosed()) client.send({ id: 1, type: "ping" }); }, 50);
    try { await client.closed(); assert.equal(client.isClosed(), true); }
    finally { clearInterval(timer); await bridge.stop(); }
  }

  // ── stop() closes open connections ─────────────────────────────────────────
  {
    const { bridge, pipeName } = makeBridge();
    await bridge.start();
    const client = await connect(pipeName);
    client.send({ id: 1, type: "ping" });
    await client.next();
    await bridge.stop();
    await client.closed();
    assert.equal(client.isClosed(), true);
    assert.equal(bridge.connectionCount(), 0);
  }

  // ── The whole chain: browser side -> real helper relay -> real bridge ──────
  {
    const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
    const { bridge, pipeName } = makeBridge();

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames = [];
    const waiting = [];
    const reader = createMessageReader({
      onMessage: (value) => (waiting.length ? waiting.shift()(value) : frames.push(value)),
      onError() {}
    });
    stdout.on("data", (chunk) => reader.push(chunk));
    const nextFrame = () =>
      frames.length ? Promise.resolve(frames.shift()) : new Promise((resolve) => waiting.push(resolve));

    const host = runHost({
      stdin,
      stdout,
      argv: [`chrome-extension://${EXTENSION_ID}/`],
      pipeName,
      allowedExtensionIds: [EXTENSION_ID],
      exit() {}
    });
    const ask = (message) => stdin.write(encodeMessage(message));

    // The app is not listening yet (browser integration off)
    ask({ id: 1, type: "ping" });
    assert.deepEqual(await nextFrame(), { id: 1, ok: false, error: "app-not-running" });

    // Turn it on: the same helper reaches the app on the next message
    await bridge.start();
    ask({ id: 2, type: "ping" });
    assert.deepEqual(await nextFrame(), { type: "pong", appVersion: "9.9.9", protocol: PROTOCOL_VERSION, id: 2, ok: true });

    // Turn it off again: the open link is closed from the app's side
    await bridge.stop();
    ask({ id: 3, type: "ping" });
    assert.equal((await nextFrame()).ok, false, "after the switch is turned off nothing is answered");

    // And on again
    await bridge.start();
    ask({ id: 4, type: "ping" });
    assert.equal((await nextFrame()).ok, true);

    host.close();
    await bridge.stop();
  }

  console.log("extension-bridge tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
