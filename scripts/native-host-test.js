const assert = require("assert");
const net = require("net");
const path = require("path");
const { PassThrough } = require("stream");
const { spawn } = require("child_process");
const { MAX_MESSAGE_BYTES, encodeMessage, createMessageReader } = require("../src/native-host/framing");
const { getPipeName } = require("../src/native-host/pipeName");
const { runHost, isAllowedOrigin, findOrigin } = require("../src/native-host/hostRelay");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Framing ──────────────────────────────────────────────────────────────────

function collect() {
  const messages = [];
  const errors = [];
  const reader = createMessageReader({
    onMessage: (value) => messages.push(value),
    onError: (error) => errors.push(error)
  });
  return { reader, messages, errors };
}

{
  const encoded = encodeMessage({ hello: "wörld 😀" });
  assert.equal(encoded.readUInt32LE(0), encoded.length - 4, "little-endian length prefix");
  assert.deepEqual(JSON.parse(encoded.subarray(4).toString("utf8")), { hello: "wörld 😀" });

  // Any chunking, including one byte at a time
  const { reader, messages, errors } = collect();
  for (const byte of encoded) reader.push(Buffer.from([byte]));
  assert.deepEqual(messages, [{ hello: "wörld 😀" }]);
  assert.deepEqual(errors, []);
}

{
  // Several messages in one chunk, plus the start of another
  const { reader, messages } = collect();
  const third = encodeMessage({ n: 3 });
  reader.push(Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 }), third.subarray(0, 5)]));
  assert.deepEqual(messages, [{ n: 1 }, { n: 2 }]);
  reader.push(third.subarray(5));
  assert.deepEqual(messages, [{ n: 1 }, { n: 2 }, { n: 3 }]);
}

{
  // Messages of any JSON type are passed through; callers validate them
  const { reader, messages } = collect();
  reader.push(Buffer.concat([encodeMessage([1, 2]), encodeMessage(null), encodeMessage("text"), encodeMessage(7)]));
  assert.deepEqual(messages, [[1, 2], null, "text", 7]);
}

{
  // Largest allowed message works; one byte more cannot be encoded
  const big = { pad: "x".repeat(MAX_MESSAGE_BYTES - 20) };
  const encoded = encodeMessage(big);
  assert.ok(encoded.length - 4 <= MAX_MESSAGE_BYTES);
  assert.throws(() => encodeMessage({ pad: "x".repeat(MAX_MESSAGE_BYTES) }), RangeError);
  const { reader, messages } = collect();
  reader.push(encoded);
  assert.equal(messages.length, 1);
}

for (const [name, header, expected] of [
  ["oversized length", (() => { const b = Buffer.alloc(4); b.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0); return b; })(), /too large/],
  ["huge length", Buffer.from([0xff, 0xff, 0xff, 0xff]), /too large/],
  ["zero length", Buffer.alloc(4), /Empty/]
]) {
  const { reader, messages, errors } = collect();
  reader.push(Buffer.concat([header, Buffer.from("ignored")]));
  assert.equal(errors.length, 1, name);
  assert.match(errors[0].message, expected, name);
  reader.push(encodeMessage({ later: true }));
  assert.deepEqual(messages, [], `${name}: nothing is parsed after a failure`);
  assert.equal(errors.length, 1, `${name}: only one error`);
  assert.equal(reader.failed, true);
}

{
  // Invalid JSON stops the stream too, even if good messages follow
  const body = Buffer.from("{not json");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const { reader, messages, errors } = collect();
  reader.push(Buffer.concat([header, body, encodeMessage({ ok: true })]));
  assert.equal(errors.length, 1);
  assert.deepEqual(messages, []);
}

{
  // A lying length prefix must not make the reader buffer without limit
  const { reader, errors } = collect();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_MESSAGE_BYTES + 5000, 0);
  reader.push(header);
  assert.equal(errors.length, 1, "refused before waiting for the body");
}

// ── Pipe names ───────────────────────────────────────────────────────────────

assert.equal(getPipeName("jane", "win32"), "\\\\.\\pipe\\secure-login-vault-jane");
assert.equal(getPipeName("Jane Doe\\x/..", "win32"), "\\\\.\\pipe\\secure-login-vault-Jane_Doe_x_..");
assert.equal(getPipeName("", "win32"), "\\\\.\\pipe\\secure-login-vault-user");
assert.ok(getPipeName("a".repeat(200), "win32").length < 120, "name length is capped");
assert.match(getPipeName("jane", "linux"), /secure-login-vault-jane\.sock$/);
assert.notEqual(getPipeName("jane", "win32"), getPipeName("joe", "win32"), "one channel per user");

// ── Origin check ─────────────────────────────────────────────────────────────

const GOOD_ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";
assert.equal(isAllowedOrigin(`chrome-extension://${GOOD_ID}/`, [GOOD_ID]), true);
assert.equal(isAllowedOrigin(`chrome-extension://${OTHER_ID}/`, [GOOD_ID]), false);
assert.equal(isAllowedOrigin(`chrome-extension://${GOOD_ID}`, [GOOD_ID]), false, "needs the trailing slash Chrome sends");
assert.equal(isAllowedOrigin(`chrome-extension://${GOOD_ID}/x`, [GOOD_ID]), false);
assert.equal(isAllowedOrigin(`https://${GOOD_ID}/`, [GOOD_ID]), false);
assert.equal(isAllowedOrigin(`chrome-extension://${GOOD_ID.toUpperCase()}/`, [GOOD_ID]), false);
assert.equal(isAllowedOrigin(`chrome-extension://${GOOD_ID}/`, []), false, "empty allow-list means nobody");
assert.equal(isAllowedOrigin(`chrome-extension://${GOOD_ID}/`, undefined), false);
assert.equal(isAllowedOrigin(null, [GOOD_ID]), false);
assert.equal(isAllowedOrigin("chrome-extension://short/", ["short"]), false, "ids are 32 letters a-p");
assert.equal(findOrigin(["--parent-window=123", `chrome-extension://${GOOD_ID}/`]), `chrome-extension://${GOOD_ID}/`);
assert.equal(findOrigin(["--parent-window=123"]), null);
assert.equal(findOrigin(undefined), null);

// ── The relay, against a fake app on a real pipe ─────────────────────────────

let pipeCounter = 0;
function freshPipeName() {
  pipeCounter += 1;
  return getPipeName(`test-${process.pid}-${Date.now()}-${pipeCounter}`);
}

// A stand-in for the app: answers {type:"ping"} with a pong, using the same framing.
function startFakeApp(pipeName, behavior = {}) {
  const connections = new Set();
  const received = [];
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    const reader = createMessageReader({
      onMessage(message) {
        received.push(message);
        if (behavior.onMessage) return behavior.onMessage(message, connection);
        connection.write(encodeMessage({ id: message.id, ok: true, type: "pong", appVersion: "test" }));
      },
      onError() {}
    });
    connection.on("data", (chunk) => reader.push(chunk));
  });
  return new Promise((resolve) => {
    server.listen(pipeName, () =>
      resolve({
        received,
        connections,
        send: (message) => connections.forEach((c) => c.write(encodeMessage(message))),
        close: () => new Promise((done) => { connections.forEach((c) => c.destroy()); server.close(done); })
      })
    );
  });
}

// Plays the browser: writes frames to the helper's stdin, reads frames from stdout.
function startHarness(options = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const frames = [];
  const waiting = [];
  const reader = createMessageReader({
    onMessage(value) {
      if (waiting.length) waiting.shift()(value);
      else frames.push(value);
    },
    onError() {}
  });
  stdout.on("data", (chunk) => reader.push(chunk));

  let resolveExit;
  const exited = new Promise((resolve) => (resolveExit = resolve));

  const host = runHost({
    stdin,
    stdout,
    argv: [`chrome-extension://${GOOD_ID}/`],
    allowedExtensionIds: [GOOD_ID],
    requestTimeoutMs: 400,
    exit: (code) => resolveExit(code),
    ...options
  });

  return {
    host,
    exited,
    send: (message) => stdin.write(encodeMessage(message)),
    sendRaw: (buffer) => stdin.write(buffer),
    endInput: () => stdin.end(),
    next: (timeoutMs = 2000) =>
      frames.length
        ? Promise.resolve(frames.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no message from the helper")), timeoutMs);
            waiting.push((value) => { clearTimeout(timer); resolve(value); });
          }),
    pendingFrames: () => frames.length
  };
}

async function main() {
  // Round trip: browser -> helper -> app -> helper -> browser, with the id preserved
  {
    const pipeName = freshPipeName();
    const app = await startFakeApp(pipeName);
    const browser = startHarness({ pipeName });
    browser.send({ id: 1, type: "ping" });
    assert.deepEqual(await browser.next(), { id: 1, ok: true, type: "pong", appVersion: "test" });
    browser.send({ id: "abc", type: "ping" });
    assert.equal((await browser.next()).id, "abc");
    assert.deepEqual(app.received, [{ id: 1, type: "ping" }, { id: "abc", type: "ping" }]);
    assert.equal(app.connections.size, 1, "one connection is reused");
    browser.endInput();
    assert.equal(await browser.exited, 0, "browser closed the connection: exit cleanly");
    await sleep(50);
    assert.equal(app.connections.size, 0, "the pipe is closed on exit");
    await app.close();
  }

  // Messages without an id are relayed too
  {
    const pipeName = freshPipeName();
    const app = await startFakeApp(pipeName, { onMessage: (m, c) => c.write(encodeMessage({ ok: true, echo: m })) });
    const browser = startHarness({ pipeName });
    browser.send({ type: "hello" });
    assert.deepEqual(await browser.next(), { ok: true, echo: { type: "hello" } });
    browser.host.close();
    await app.close();
  }

  // App not running, then started: the helper reconnects on the next message
  {
    const pipeName = freshPipeName();
    const browser = startHarness({ pipeName });
    browser.send({ id: 1, type: "ping" });
    assert.deepEqual(await browser.next(), { id: 1, ok: false, error: "app-not-running" });
    browser.send({ type: "ping" });
    assert.deepEqual(await browser.next(), { ok: false, error: "app-not-running" });

    const app = await startFakeApp(pipeName);
    browser.send({ id: 2, type: "ping" });
    assert.equal((await browser.next()).ok, true);
    browser.host.close();
    await app.close();
  }

  // The app disappears mid-request, and later returns
  {
    const pipeName = freshPipeName();
    let app = await startFakeApp(pipeName, { onMessage: (message, connection) => connection.destroy() });
    const browser = startHarness({ pipeName });
    browser.send({ id: 7, type: "ping" });
    assert.deepEqual(await browser.next(), { id: 7, ok: false, error: "app-disconnected" });
    await app.close();

    app = await startFakeApp(pipeName);
    browser.send({ id: 8, type: "ping" });
    assert.equal((await browser.next()).ok, true, "reconnects after the app comes back");
    browser.host.close();
    await app.close();
  }

  // The app never answers: the request times out instead of hanging
  {
    const pipeName = freshPipeName();
    const app = await startFakeApp(pipeName, { onMessage: () => {} });
    const browser = startHarness({ pipeName });
    browser.send({ id: 9, type: "ping" });
    assert.deepEqual(await browser.next(), { id: 9, ok: false, error: "timeout" });
    browser.host.close();
    await app.close();
  }

  // A late answer after a timeout is still forwarded; one answer per request otherwise
  {
    const pipeName = freshPipeName();
    const app = await startFakeApp(pipeName);
    const browser = startHarness({ pipeName });
    browser.send({ id: 1, type: "ping" });
    await browser.next();
    await sleep(500); // longer than the timeout: nothing stray may arrive
    assert.equal(browser.pendingFrames(), 0, "an answered request never times out later");
    browser.host.close();
    await app.close();
  }

  // Unsolicited messages from the app (events) reach the browser
  {
    const pipeName = freshPipeName();
    const app = await startFakeApp(pipeName);
    const browser = startHarness({ pipeName });
    browser.send({ id: 1, type: "ping" });
    await browser.next();
    app.send({ type: "event", name: "locked" });
    assert.deepEqual(await browser.next(), { type: "event", name: "locked" });
    browser.host.close();
    await app.close();
  }

  // Bad input from the browser
  {
    const pipeName = freshPipeName();
    const app = await startFakeApp(pipeName);
    const browser = startHarness({ pipeName });
    for (const bad of [[1, 2], null, "text", 5, { id: { nested: true }, type: "ping" }, { id: null }]) {
      browser.send(bad);
      assert.deepEqual(await browser.next(), { ok: false, error: "bad-message" }, JSON.stringify(bad));
    }
    assert.deepEqual(app.received, [], "bad messages never reach the app");
    browser.send({ id: 1, type: "ping" });
    assert.equal((await browser.next()).ok, true, "still working after bad messages");
    browser.host.close();
    await app.close();
  }

  // Oversized or broken framing ends the session
  for (const [name, raw] of [
    ["oversized frame", (() => { const b = Buffer.alloc(4); b.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0); return b; })()],
    ["invalid json", Buffer.concat([(() => { const b = Buffer.alloc(4); b.writeUInt32LE(3, 0); return b; })(), Buffer.from("{{{")])]
  ]) {
    const pipeName = freshPipeName();
    const app = await startFakeApp(pipeName);
    const browser = startHarness({ pipeName });
    browser.sendRaw(raw);
    assert.deepEqual(await browser.next(), { ok: false, error: "bad-message" }, name);
    assert.equal(await browser.exited, 1, name);
    assert.deepEqual(app.received, []);
    await app.close();
  }

  // Wrong caller: refused before anything is read or relayed
  for (const [name, options] of [
    ["unknown extension", { argv: [`chrome-extension://${OTHER_ID}/`] }],
    ["no origin", { argv: [] }],
    ["empty allow-list", { allowedExtensionIds: [] }]
  ]) {
    const pipeName = freshPipeName();
    const app = await startFakeApp(pipeName);
    const browser = startHarness({ pipeName, ...options });
    assert.deepEqual(await browser.next(), { ok: false, error: "origin-not-allowed" }, name);
    assert.equal(await browser.exited, 1, name);
    browser.send({ id: 1, type: "ping" });
    await sleep(100);
    assert.deepEqual(app.received, [], `${name}: nothing is relayed`);
    await app.close();
  }

  // The real helper process: refuses an extension that is not on its allow-list
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "native-host", "host.js"), `chrome-extension://${GOOD_ID}/`], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    let output = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => (output = Buffer.concat([output, chunk])));
    const timer = setTimeout(() => { child.kill(); reject(new Error("host.js did not exit")); }, 5000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 1);
        assert.deepEqual(JSON.parse(output.subarray(4).toString("utf8")), { ok: false, error: "origin-not-allowed" });
        assert.equal(output.readUInt32LE(0), output.length - 4, "stdout holds exactly one framed message");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

  console.log("native-host tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
