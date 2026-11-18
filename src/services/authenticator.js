const crypto = require("crypto");
const path = require("path");
const { Worker } = require("worker_threads");
const { generateCode, fail } = require("./totp");
const { validateImage } = require("./authenticatorQr");
const SESSION_MS = 5 * 60 * 1000;
function decodeInWorker(image, signal) {
  validateImage(image);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "authenticatorWorker.js"), { workerData: { image }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    let settled = false;
    const finish = (error, value) => {
      if (settled) { value?.secret?.fill(0); return; } settled = true;
      clearTimeout(timeout); signal.removeEventListener("abort", cancel); worker.terminate().catch(() => {});
      if (error) reject(Object.assign(new Error(error), { isPublic: true })); else resolve(value);
    };
    const cancel = () => finish("Authenticator request cancelled.");
    const timeout = setTimeout(() => finish("Reading the QR took too long. Crop to one clear setup QR and try again."), 5000);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    worker.on("message", result => {
      if (!result?.ok) return finish(result?.message || "Could not read the authenticator QR.");
      const config = { ...result.config, secret: Buffer.from(result.config.secret) }; result.config.secret.fill(0); finish(null, config);
    });
    worker.on("error", () => finish("Could not read the authenticator QR."));
    worker.on("exit", () => { if (!settled) finish("Could not read the authenticator QR."); });
  });
}
function createAuthenticator({ vault, clipboard, now = Date.now, decode = decodeInWorker }) {
  let session, pending, expiryTimer, clipboardTimer, copied = null, generation = 0;
  let clipboardWork = Promise.resolve();
  function queueClipboard(operation) {
    const result = clipboardWork.then(operation);
    clipboardWork = result.catch(() => {});
    return result;
  }
  async function clearCopied() {
    clearTimeout(clipboardTimer);
    if (copied !== null && await clipboard.readText() === copied) await clipboard.clear();
    copied = null;
  }
  function stop(token) {
    if (token !== undefined && token !== session?.token) return { stopped: false };
    generation++; pending?.abort(); pending = null; clearTimeout(expiryTimer);
    session?.config.secret.fill(0); session = null;
    return { stopped: true };
  }
  function clear() {
    stop();
    // Blur/lock callers do not await cleanup. Handle OS clipboard failures here.
    return queueClipboard(clearCopied).catch(() => {});
  }
  function requireUnlocked() { if (!vault.isUnlocked()) { clear(); fail("Unlock SLV before generating an authenticator code."); } }
  function read(token) {
    requireUnlocked();
    if (!session || typeof token !== "string" || token !== session.token || now() >= session.expires || vault.getOperationEpoch() !== session.epoch) {
      stop(); fail("This authenticator view expired. Open Generate code again.");
    }
    const { account, issuer, algorithm, digits, period, extraSettings } = session.config;
    const details = { account, issuer, algorithm, digits, period, extraSettings: extraSettings || 0 };
    if (extraSettings && !session.standardConfirmed) return { ...details, requiresStandardConfirmation: true };
    return { ...generateCode(session.config, now()), ...details, standardMode: !!extraSettings };
  }
  function confirmStandard(token) {
    read(token); // Enforce the same token, expiry, lock and epoch checks.
    session.standardConfirmed = true;
    return read(token);
  }
  async function start(image) {
    requireUnlocked(); stop();
    const epoch = vault.getOperationEpoch(), request = generation, controller = new AbortController(); pending = controller;
    let config;
    try {
      // Saved-entry loading is inside the same cancellable request as decoding.
      // Closing or locking during that read must not start a later worker.
      if (typeof image === "function") image = await image();
      if (controller.signal.aborted || request !== generation || !vault.isUnlocked() || epoch !== vault.getOperationEpoch()) fail("Vault session changed. Open Generate code again after unlocking.");
      validateImage(image);
      config = await decode(image, controller.signal);
      if (controller.signal.aborted || request !== generation || !vault.isUnlocked() || epoch !== vault.getOperationEpoch()) fail("Vault session changed. Open Generate code again after unlocking.");
      const token = crypto.randomBytes(24).toString("hex");
      session = { token, config, epoch, expires: now() + SESSION_MS }; config = null;
      expiryTimer = setTimeout(() => stop(token), SESSION_MS); expiryTimer.unref();
      return { token, ...read(token) };
    } finally { config?.secret.fill(0); if (pending === controller) pending = null; }
  }
  async function copy(token) {
    if (read(token).requiresStandardConfirmation) fail("Choose Try standard TOTP before copying a code from this QR.");
    const request = generation;
    return queueClipboard(async () => {
      await clearCopied();
      if (request !== generation) fail("Authenticator request cancelled.");
      const result = read(token);
      if (result.requiresStandardConfirmation) fail("Choose Try standard TOTP before copying a code from this QR.");
      await clipboard.writeText(result.code); copied = result.code;
      // A lock, close or rollover during the write must not leave a stale code.
      if (request !== generation || !vault.isUnlocked() || session?.epoch !== vault.getOperationEpoch() || now() >= result.validUntil) {
        await clearCopied();
        fail("Authenticator request expired. Generate a new code.");
      }
      clipboardTimer = setTimeout(() => { queueClipboard(clearCopied).catch(() => {}); }, Math.max(1, Math.min(30000, result.validUntil - now()))); clipboardTimer.unref();
      return result;
    });
  }
  return { start, read, confirmStandard, copy, stop, clear };
}
module.exports = { createAuthenticator, decodeInWorker, SESSION_MS };
