const crypto = require("crypto");

// Pairing and mutual authentication between the app and the browser extension.
//
// Why: the pipe the extension talks to is not proof of anything. A local program
// could create it before the app starts and pretend to be the app (and the app
// cannot tell a real extension from any other program that opens the pipe). So each
// side must prove it holds a secret the other side shared with it, and neither proof
// can be used to guess the secret.
//
// 1. PAIRING (once). The user presses "Pair browser" in the unlocked app, which shows
//    a one-time pairing code (128 random bits, valid for a couple of minutes), and
//    pastes it into the extension. The code is never sent over the pipe. Both sides
//    prove they know it, app first, with fresh random nonces from each side:
//      extension -> app : pair-begin  { nonceE }
//      app -> extension : { nonceA, appProof }      appProof = HMAC(kAuth, "app|nonceE|nonceA")
//      extension -> app : pair-finish { nonceE, nonceA, extProof }
//    Both then derive the long-term secret from the code and both nonces. The code
//    has 128 bits, so seeing the proofs reveals nothing usable, and the code dies
//    after one success, after it expires, or after too many bad attempts.
//
// 2. EVERY CONNECTION AFTER THAT. The same two-way proof, keyed with the long-term
//    secret instead of the code (auth-begin / auth-finish). A connection that has not
//    completed it is not "authenticated" and may only ask the harmless questions.
//
// The secret is held by the app through an injected `storage` (the real one protects
// it with Windows' per-user encryption); this module never touches the disk itself.
// It never logs anything.

const CODE_BYTES = 16;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0 or 1
const CODE_LENGTH = Math.ceil((CODE_BYTES * 8) / 5); // 26 characters
const NONCE_HEX = /^[0-9a-f]{32}$/;
const PROOF_HEX = /^[0-9a-f]{64}$/;

const DEFAULTS = Object.freeze({
  codeTtlMs: 2 * 60 * 1000,
  maxFailedAttempts: 10,
  pendingTtlMs: 30 * 1000,
  maxPending: 8
});

function encodeCode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CODE_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Groups of 4 for reading and typing: ABCD-EFGH-...
function formatCode(raw) {
  return raw.match(/.{1,4}/g).join("-");
}

// Accepts what a person might paste or type (any case, spaces, dashes); returns the
// 16 code bytes, or null if it is not a well-formed code.
function parseCode(text) {
  if (typeof text !== "string" || text.length > 100) return null;
  const clean = text.toUpperCase().replace(/[\s-]/g, "");
  if (clean.length !== CODE_LENGTH) return null;

  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = CODE_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  if (value !== 0) return null; // the unused trailing bits must be zero
  return Buffer.from(bytes);
}

const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 32));
const hmacHex = (key, text) => crypto.createHmac("sha256", key).update(text, "utf8").digest("hex");

function equalHex(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// The cryptographic pieces, exported so the extension's own implementation (WebCrypto)
// can be tested against exactly these functions.
const protocol = {
  pairingAuthKey: (codeBytes) => hkdf(codeBytes, "slv-pair-v1", "auth"),
  pairingSecret: (codeBytes, nonceE, nonceA) => hkdf(codeBytes, Buffer.from(nonceE + nonceA, "utf8"), "secret"),
  appProof: (key, label, nonceE, nonceA) => hmacHex(key, `${label}-app|${nonceE}|${nonceA}`),
  extProof: (key, label, nonceE, nonceA) => hmacHex(key, `${label}-ext|${nonceE}|${nonceA}`)
};

function createPairing({ storage, now = Date.now, randomBytes = crypto.randomBytes, limits = {} }) {
  if (!storage || typeof storage.load !== "function" || typeof storage.save !== "function" || typeof storage.clear !== "function") {
    throw new Error("A storage with load, save and clear is required.");
  }
  const config = { ...DEFAULTS, ...limits };

  let secret = null; // Buffer once paired
  try {
    const saved = storage.load();
    if (saved && typeof saved.secret === "string" && /^[0-9a-f]{64}$/.test(saved.secret)) {
      secret = Buffer.from(saved.secret, "hex");
    }
  } catch {
    secret = null; // unreadable storage means "not paired"
  }

  let active = null; // { codeBytes, authKey, expiresAt, failures }
  const pending = new Map(); // nonceA -> { kind, nonceE, context, expiresAt }

  const randomNonce = () => randomBytes(16).toString("hex");

  function codeIsLive() {
    if (!active) return false;
    if (now() >= active.expiresAt) {
      active = null;
      return false;
    }
    return true;
  }

  function prunePending() {
    const time = now();
    for (const [key, entry] of pending) {
      if (time >= entry.expiresAt) pending.delete(key);
    }
  }

  function addPending(kind, nonceE, context) {
    prunePending();
    if (pending.size >= config.maxPending) return null;
    const nonceA = randomNonce();
    pending.set(nonceA, { kind, nonceE, context, expiresAt: now() + config.pendingTtlMs });
    return nonceA;
  }

  // Takes the pending entry for a finish message: it must exist, be of the right kind
  // and belong to this very connection and nonceE. It can be used only once.
  function takePending(kind, nonceE, nonceA, context) {
    prunePending();
    const entry = pending.get(nonceA);
    if (!entry) return null;
    pending.delete(nonceA);
    if (entry.kind !== kind || entry.nonceE !== nonceE || entry.context !== context) return null;
    return entry;
  }

  const validNonce = (value) => typeof value === "string" && NONCE_HEX.test(value);
  const validProof = (value) => typeof value === "string" && PROOF_HEX.test(value);

  function failCode() {
    if (!active) return;
    active.failures += 1;
    if (active.failures >= config.maxFailedAttempts) active = null;
  }

  return {
    // A new one-time code, shown to the user. Replaces any earlier unused code.
    startPairing() {
      const codeBytes = randomBytes(CODE_BYTES);
      active = {
        codeBytes,
        authKey: protocol.pairingAuthKey(codeBytes),
        expiresAt: now() + config.codeTtlMs,
        failures: 0
      };
      pending.clear();
      return { code: formatCode(encodeCode(codeBytes)), expiresAt: active.expiresAt };
    },

    cancelPairing() {
      active = null;
      for (const [key, entry] of pending) if (entry.kind === "pair") pending.delete(key);
    },

    isPairingActive: () => codeIsLive(),
    isPaired: () => secret !== null,

    // Forgets the secret. Returns true if there was one.
    unpair() {
      const was = secret !== null;
      secret = null;
      pending.clear();
      storage.clear();
      return was;
    },

    // ── Messages from the extension ───────────────────────────────────────────

    pairBegin({ nonceE }, context) {
      if (!validNonce(nonceE)) return { error: "bad-message" };
      if (!codeIsLive()) return { error: "no-pairing" };
      const nonceA = addPending("pair", nonceE, context);
      if (!nonceA) return { error: "busy" };
      return { nonceA, appProof: protocol.appProof(active.authKey, "pair", nonceE, nonceA) };
    },

    pairFinish({ nonceE, nonceA, extProof }, context) {
      if (!validNonce(nonceE) || !validNonce(nonceA) || !validProof(extProof)) return { error: "bad-message" };
      if (!codeIsLive()) return { error: "no-pairing" };
      if (!takePending("pair", nonceE, nonceA, context)) return { error: "bad-proof" };

      const expected = protocol.extProof(active.authKey, "pair", nonceE, nonceA);
      if (!equalHex(expected, extProof)) {
        failCode();
        return { error: "bad-proof" };
      }

      const newSecret = protocol.pairingSecret(active.codeBytes, nonceE, nonceA);
      try {
        storage.save({ secret: newSecret.toString("hex") });
      } catch {
        return { error: "storage-failed" };
      }
      secret = newSecret;
      active = null; // one use only
      pending.clear();
      return { paired: true };
    },

    authBegin({ nonceE }, context) {
      if (!validNonce(nonceE)) return { error: "bad-message" };
      if (!secret) return { error: "not-paired" };
      const nonceA = addPending("auth", nonceE, context);
      if (!nonceA) return { error: "busy" };
      return { nonceA, appProof: protocol.appProof(secret, "auth", nonceE, nonceA) };
    },

    authFinish({ nonceE, nonceA, extProof }, context) {
      if (!validNonce(nonceE) || !validNonce(nonceA) || !validProof(extProof)) return { error: "bad-message" };
      if (!secret) return { error: "not-paired" };
      if (!takePending("auth", nonceE, nonceA, context)) return { error: "bad-proof" };
      if (!equalHex(protocol.extProof(secret, "auth", nonceE, nonceA), extProof)) return { error: "bad-proof" };
      context.authenticated = true;
      return { authenticated: true };
    }
  };
}

module.exports = { createPairing, protocol, encodeCode, parseCode, formatCode, CODE_LENGTH, DEFAULTS };
