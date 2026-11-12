const crypto = require("crypto");
const { createChannel } = require("../shared/secureChannel");

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
  maxPending: 8,
  maxPairings: 32
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
  pairingId: (secret) => hmacHex(secret, "slv-pairing-id-v1"),
  replaceProof: (secret, nonceE, nonceA, proof) => hmacHex(secret, `slv-repair-v1|${nonceE}|${nonceA}|${proof}`),
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

  let records = new Map();
  const browserName = value => ["Google Chrome", "Microsoft Edge", "Firefox"].includes(value) ? value : "Browser";
  try {
    const saved = storage.load();
    const entries = saved?.version === 2 && Array.isArray(saved.pairings) ? saved.pairings
      : saved?.secret ? [{ secret: saved.secret, name: "Existing browser", legacy: true, createdAt: 0 }] : [];
    if (entries.length > config.maxPairings) throw new Error("Invalid pairing data");
    for (const entry of entries) {
      if (typeof entry?.secret !== "string" || !PROOF_HEX.test(entry.secret)) throw new Error("Invalid pairing data");
      const secret = Buffer.from(entry.secret, "hex");
      const id = protocol.pairingId(secret);
      if (records.has(id) || (entry.id && entry.id !== id)) throw new Error("Invalid pairing data");
      records.set(id, { id, secret, name: entry.name === "Existing browser" ? entry.name : browserName(entry.name),
        createdAt: Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0 ? entry.createdAt : 0, legacy: entry.legacy === true });
    }
    if ([...records.values()].filter(record => record.legacy).length > 1) throw new Error("Invalid legacy pairings");
  } catch {
    records = new Map(); // unreadable storage fails closed
  }

  function persist(next) {
    if (!next.size) storage.clear();
    else storage.save({ version: 2, pairings: [...next.values()].map(record => ({ ...record, secret: record.secret.toString("hex") })) });
    records = next; // do not change live access if atomic persistence fails
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

  function addPending(kind, nonceE, context, metadata = {}) {
    prunePending();
    if (pending.size >= config.maxPending) return null;
    const nonceA = randomNonce();
    pending.set(nonceA, { kind, nonceE, context, expiresAt: now() + config.pendingTtlMs, ...metadata });
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
      for (const [key, entry] of pending) if (entry.kind === "pair") pending.delete(key);
      return { code: formatCode(encodeCode(codeBytes)), expiresAt: active.expiresAt };
    },

    cancelPairing() {
      active = null;
      for (const [key, entry] of pending) if (entry.kind === "pair") pending.delete(key);
    },

    isPairingActive: () => codeIsLive(),
    isPaired: () => records.size > 0,
    list: () => [...records.values()].map(({ id, name, createdAt }) => ({ id, name, createdAt })),

    // Forgets the secret. Returns true if there was one.
    unpair(id) {
      if (id !== undefined && (typeof id !== "string" || !PROOF_HEX.test(id))) throw new Error("Invalid pairing ID");
      const was = id === undefined ? records.size > 0 : records.has(id);
      const next = id === undefined ? new Map() : new Map(records);
      if (id !== undefined) next.delete(id);
      persist(next);
      if (id === undefined) { pending.clear(); active = null; }
      else for (const [key, entry] of pending) if (entry.record?.id === id) pending.delete(key);
      return was;
    },

    // ── Messages from the extension ───────────────────────────────────────────

    pairBegin({ nonceE, browserName: name }, context) {
      if (!validNonce(nonceE)) return { error: "bad-message" };
      if (!codeIsLive()) return { error: "no-pairing" };
      const nonceA = addPending("pair", nonceE, context, { name: browserName(name), legacy: name === undefined });
      if (!nonceA) return { error: "busy" };
      return { nonceA, appProof: protocol.appProof(active.authKey, "pair", nonceE, nonceA) };
    },

    pairFinish({ nonceE, nonceA, extProof, replaceId, replaceProof }, context) {
      if (!validNonce(nonceE) || !validNonce(nonceA) || !validProof(extProof)) return { error: "bad-message" };
      if (!codeIsLive()) return { error: "no-pairing" };
      const entry = takePending("pair", nonceE, nonceA, context);
      if (!entry) return { error: "bad-proof" };

      const expected = protocol.extProof(active.authKey, "pair", nonceE, nonceA);
      if (!equalHex(expected, extProof)) {
        failCode();
        return { error: "bad-proof" };
      }

      const newSecret = protocol.pairingSecret(active.codeBytes, nonceE, nonceA);
      const next = new Map(records);
      // A browser may rotate only its own key, after proving both the new code
      // and its existing secret. A claimed public ID alone cannot evict anyone.
      if (replaceId !== undefined || replaceProof !== undefined) {
        if (!validProof(replaceId) || !validProof(replaceProof)) return { error: "bad-message" };
        const prior = records.get(replaceId);
        if (prior && !equalHex(protocol.replaceProof(prior.secret, nonceE, nonceA, extProof), replaceProof)) return { error: "bad-proof" };
        if (prior) next.delete(replaceId);
      }
      // Preserve the old client's fallback slot. An unauthenticated caller's
      // version/name claim must never evict an existing pairing.
      if (next.size >= config.maxPairings) return { error: "pairing-limit" };
      const id = protocol.pairingId(newSecret);
      next.set(id, { id, secret: newSecret, name: entry.name, createdAt: now(),
        legacy: entry.legacy && ![...next.values()].some(record => record.legacy) });
      try {
        persist(next);
      } catch {
        return { error: "storage-failed" };
      }
      active = null; // one use only
      for (const [key, value] of pending) if (value.kind === "pair") pending.delete(key);
      return { paired: true };
    },

    authBegin({ nonceE, pairingId }, context) {
      if (!validNonce(nonceE)) return { error: "bad-message" };
      if (pairingId !== undefined && !validProof(pairingId)) return { error: "bad-message" };
      const record = pairingId === undefined ? [...records.values()].find(value => value.legacy) : records.get(pairingId);
      if (!record) return { error: "not-paired" };
      const nonceA = addPending("auth", nonceE, context, { record });
      if (!nonceA) return { error: "busy" };
      return { nonceA, appProof: protocol.appProof(record.secret, "auth-v2", nonceE, nonceA) };
    },

    async authFinish({ nonceE, nonceA, extProof }, context) {
      if (!validNonce(nonceE) || !validNonce(nonceA) || !validProof(extProof)) return { error: "bad-message" };
      if (!records.size) return { error: "not-paired" };
      const record = takePending("auth", nonceE, nonceA, context)?.record;
      if (!record || records.get(record.id) !== record) return { error: "bad-proof" };
      const secret = record.secret;
      if (!equalHex(protocol.extProof(secret, "auth-v2", nonceE, nonceA), extProof)) return { error: "bad-proof" };
      const channel = await createChannel({ secret, nonceE, nonceA, role: "app", crypto: crypto.webcrypto });
      if (context.signal?.aborted || records.get(record.id) !== record) { channel.destroy(); return { error: "not-authenticated" }; }
      context.isPairingCurrent = () => records.get(record.id) === record;
      context.pairingId = record.id;
      context.channel = channel;
      context.authenticated = true;
      return { authenticated: true };
    }
  };
}

module.exports = { createPairing, protocol, encodeCode, parseCode, formatCode, CODE_LENGTH, DEFAULTS };
