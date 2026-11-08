// A stand-in for the extension's side of pairing, for tests that talk to the real app
// over its named pipe. It implements the protocol on its own (Node's crypto), not by
// reusing src/services/extensionPairing.js, so the two cannot agree by sharing a mistake.
const crypto = require("crypto");
const net = require("net");
const { encodeMessage, createMessageReader } = require("../src/native-host/framing");

const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 32));
const mac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
const nonce = () => crypto.randomBytes(16).toString("hex");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function decodeCode(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

const proofs = {
  pairKey: (codeBytes) => hkdf(codeBytes, "slv-pair-v1", "auth"),
  pairSecret: (codeBytes, ne, na) => hkdf(codeBytes, Buffer.from(ne + na), "secret"),
  app: (key, label, ne, na) => mac(key, `${label}-app|${ne}|${na}`),
  ext: (key, label, ne, na) => mac(key, `${label}-ext|${ne}|${na}`)
};

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
        whenClosed: () => new Promise((res) => (closed ? res() : socket.once("close", res))),
        request(message, timeoutMs = 5000) {
          return new Promise((res) => {
            const id = nonce();
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
        }
      })
    );
    socket.once("error", reject);
  });
}

// Pairing with the code shown in the app. Returns the app's answers, whether the app's
// proof checked out, and the secret this side derived.
async function pair(conn, code) {
  const codeBytes = decodeCode(code);
  const ne = nonce();
  const begin = await conn.request({ type: "pair-begin", nonceE: ne });
  if (!begin || begin.ok !== true) return { begin };
  const key = proofs.pairKey(codeBytes);
  const appOk = begin.appProof === proofs.app(key, "pair", ne, begin.nonceA);
  const finish = await conn.request({ type: "pair-finish", nonceE: ne, nonceA: begin.nonceA, extProof: proofs.ext(key, "pair", ne, begin.nonceA) });
  return { begin, finish, appOk, secret: proofs.pairSecret(codeBytes, ne, begin.nonceA) };
}

// The per-connection proof with a secret.
async function authenticate(conn, secret) {
  const ne = nonce();
  const begin = await conn.request({ type: "auth-begin", nonceE: ne });
  if (!begin || begin.ok !== true) return { begin };
  const appOk = begin.appProof === proofs.app(secret, "auth", ne, begin.nonceA);
  const finish = await conn.request({ type: "auth-finish", nonceE: ne, nonceA: begin.nonceA, extProof: proofs.ext(secret, "auth", ne, begin.nonceA) });
  return { begin, finish, appOk };
}

module.exports = { connect, pair, authenticate, nonce, decodeCode };
