const net = require("net");
const { encodeMessage, createMessageReader } = require("./framing");

// The browser helper's whole job: take framed JSON messages from the browser
// (stdin), pass them to the running app over a named pipe, and pass the app's
// replies back (stdout). It holds no secrets and makes no decisions; the app
// decides what to answer. It also never logs message contents.
//
// Everything is injected (streams, argv, pipe name, exit) so it can be tested
// without a browser. src/native-host/host.js wires in the real ones.

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})\/$/;

function findOrigin(argv) {
  return (argv || []).find((arg) => typeof arg === "string" && arg.startsWith("chrome-extension://")) || null;
}

// Chrome passes the caller as "chrome-extension://<id>/" as the first argument.
function isAllowedOrigin(origin, allowedExtensionIds) {
  const match = typeof origin === "string" ? EXTENSION_ORIGIN.exec(origin) : null;
  return Boolean(match && Array.isArray(allowedExtensionIds) && allowedExtensionIds.includes(match[1]));
}

function runHost({
  stdin,
  stdout,
  argv,
  pipeName,
  allowedExtensionIds,
  requestTimeoutMs = 10000,
  approvalRequestTimeoutMs = 40000,
  exit
}) {
  let socket = null;
  let connecting = null;
  let closed = false;
  const pending = new Map(); // request id -> timeout handle

  // stdout carries only framed messages; anything else would corrupt the stream.
  function reply(message) {
    if (closed) return;
    try {
      stdout.write(encodeMessage(message));
    } catch {
      stdout.write(encodeMessage({ id: message.id, ok: false, error: "response-too-large" }));
    }
  }

  function shutdown(code) {
    if (closed) return;
    closed = true;
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    if (socket) socket.destroy();
    socket = null;
    exit(code);
  }

  function failPending(error) {
    for (const [id, timer] of pending) {
      clearTimeout(timer);
      reply({ id, ok: false, error });
    }
    pending.clear();
  }

  function connectToApp() {
    if (socket && !socket.destroyed) return Promise.resolve(socket);
    if (connecting) return connecting;

    connecting = new Promise((resolve, reject) => {
      const candidate = net.createConnection(pipeName);

      candidate.once("error", (error) => {
        connecting = null;
        reject(error);
      });

      candidate.once("connect", () => {
        connecting = null;
        socket = candidate;

        const fromApp = createMessageReader({
          onMessage(value) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
              if (value.id !== undefined && pending.has(value.id)) {
                clearTimeout(pending.get(value.id));
                pending.delete(value.id);
              }
              reply(value);
            }
          },
          onError() {
            candidate.destroy(); // the app sent garbage: drop the link
          }
        });

        candidate.on("data", (chunk) => fromApp.push(chunk));
        candidate.on("close", () => {
          if (socket === candidate) socket = null;
          failPending("app-disconnected");
        });
        candidate.on("error", () => {}); // "close" follows; nothing else to do

        resolve(candidate);
      });
    });

    return connecting;
  }

  function handleBrowserMessage(value) {
    const isObject = value && typeof value === "object" && !Array.isArray(value);
    const hasId = isObject && value.id !== undefined;
    const idIsValid = !hasId || typeof value.id === "string" || typeof value.id === "number";

    if (!isObject || !idIsValid) {
      reply({ ok: false, error: "bad-message" });
      return;
    }

    connectToApp().then(
      (link) => {
        if (closed) return;
        if (hasId) {
          pending.set(
            value.id,
            setTimeout(() => {
              pending.delete(value.id);
              reply({ id: value.id, ok: false, error: "timeout" });
            }, value.type === "save-login" || value.type === "get-login" ? approvalRequestTimeoutMs : requestTimeoutMs)
          );
        }
        link.write(encodeMessage(value));
      },
      () => {
        reply(hasId ? { id: value.id, ok: false, error: "app-not-running" } : { ok: false, error: "app-not-running" });
      }
    );
  }

  // Who started us? Only the extension we expect may use the helper.
  if (!isAllowedOrigin(findOrigin(argv), allowedExtensionIds)) {
    stdout.write(encodeMessage({ ok: false, error: "origin-not-allowed" }));
    closed = true;
    exit(1);
    return { close() {} };
  }

  const fromBrowser = createMessageReader({
    onMessage: handleBrowserMessage,
    onError() {
      reply({ ok: false, error: "bad-message" });
      shutdown(1);
    }
  });

  stdin.on("data", (chunk) => fromBrowser.push(chunk));
  stdin.on("end", () => shutdown(0));
  stdin.on("error", () => shutdown(1));

  return { close: () => shutdown(0) };
}

module.exports = { runHost, isAllowedOrigin, findOrigin };
