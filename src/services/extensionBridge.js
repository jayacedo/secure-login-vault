const net = require("net");
const { encodeMessage, createMessageReader } = require("../native-host/framing");

// The app's end of the browser-extension link: a server on a per-user named pipe
// that the browser helper (src/native-host) connects to.
//
// This file only handles the connection: framing, limits and routing a message to
// a handler by its "type". What the app is willing to answer lives in the
// handlers (extensionHandlers.js). It never logs message contents.
//
// Windows' default pipe permissions let other local users open the pipe read-only
// (they cannot send), so the limits below also protect against someone simply
// occupying connection slots: a connection must speak within a few seconds or it
// is dropped.

const DEFAULT_LIMITS = Object.freeze({
  maxConnections: 4,
  maxMessageBytes: 64 * 1024, // requests are tiny; far below the 1 MiB framing ceiling
  maxMessagesPerSecond: 50,
  firstMessageTimeoutMs: 5000,
  idleTimeoutMs: 10 * 60 * 1000
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isValidId = (id) => id === undefined || typeof id === "string" || typeof id === "number";

function createExtensionBridge({ pipeName, handlers = {}, limits = {} }) {
  const config = { ...DEFAULT_LIMITS, ...limits };
  const connections = new Set();
  let server = null;

  function send(socket, message) {
    if (socket.destroyed) return;
    try {
      socket.write(encodeMessage(message));
    } catch {
      // Reply too large to frame: tell the caller something went wrong instead.
      socket.write(encodeMessage({ id: message.id, ok: false, error: "internal-error" }));
    }
  }

  async function handleMessage(socket, context, value) {
    if (!isPlainObject(value) || !isValidId(value.id)) {
      send(socket, { ok: false, error: "bad-message" });
      return;
    }

    const { id, type } = value;
    // Own properties only, so a "type" like "constructor" or "__proto__" is just unknown.
    if (typeof type !== "string" || !hasOwn(handlers, type)) {
      send(socket, { id, ok: false, error: "unknown-type" });
      return;
    }

    try {
      const result = await handlers[type](value, context);
      if (isPlainObject(result) && typeof result.error === "string") {
        // A handler refusing on purpose (e.g. "not-paired"): a failure reply, nothing else.
        send(socket, { id, ok: false, error: result.error });
      } else {
        send(socket, { ...(isPlainObject(result) ? result : {}), id, ok: true });
      }
    } catch {
      // Details stay inside the app; the extension only learns that it failed.
      send(socket, { id, ok: false, error: "internal-error" });
    }
  }

  function onConnection(socket) {
    if (connections.size >= config.maxConnections) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    // Per-connection state the handlers may read and set (e.g. "authenticated").
    const abort = new AbortController();
    const context = { authenticated: false, signal: abort.signal };

    let windowStart = Date.now();
    let windowCount = 0;
    let idleTimer = null;
    let firstMessageTimer = setTimeout(() => socket.destroy(), config.firstMessageTimeoutMs);

    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.destroy(), config.idleTimeoutMs);
    };

    const reader = createMessageReader({
      maxBytes: config.maxMessageBytes,
      onMessage(value) {
        clearTimeout(firstMessageTimer);
        firstMessageTimer = null;
        armIdleTimer();

        const now = Date.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          windowCount = 0;
        }
        windowCount += 1;
        if (windowCount > config.maxMessagesPerSecond) {
          socket.destroy(); // flooding: drop the connection
          return;
        }

        handleMessage(socket, context, value);
      },
      onError() {
        socket.destroy(); // malformed or oversized: drop the connection
      }
    });

    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", () => {}); // "close" follows
    socket.on("close", () => {
      context.authenticated = false;
      abort.abort();
      clearTimeout(firstMessageTimer);
      clearTimeout(idleTimer);
      connections.delete(socket);
    });
  }

  return {
    // Resolves when listening; rejects (e.g. EADDRINUSE) if the pipe is taken.
    start() {
      if (server) return Promise.resolve();

      return new Promise((resolve, reject) => {
        const candidate = net.createServer(onConnection);
        candidate.once("error", reject);
        candidate.listen(pipeName, () => {
          candidate.removeListener("error", reject);
          candidate.on("error", () => {});
          server = candidate;
          resolve();
        });
      });
    },

    stop() {
      if (!server) return Promise.resolve();
      const closing = server;
      server = null;
      for (const socket of connections) socket.destroy();
      connections.clear();
      return new Promise((resolve) => closing.close(() => resolve()));
    },

    // Drops every open connection but keeps listening (e.g. after unpairing).
    closeConnections() {
      for (const socket of connections) socket.destroy();
      connections.clear();
    },

    isRunning: () => server !== null,
    connectionCount: () => connections.size
  };
}

module.exports = { createExtensionBridge, DEFAULT_LIMITS };
