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
  function clearCopied() {
    clearTimeout(clipboardTimer);
    if (copied !== null && clipboard.readText() === copied) clipboard.clear();
    copied = null;
  }
  function stop(token) {
    if (token !== undefined && token !== session?.token) return { stopped: false };
    generation++; pending?.abort(); pending = null; clearTimeout(expiryTimer);
    session?.config.secret.fill(0); session = null;
    return { stopped: true };
  }
  function clear() { stop(); clearCopied(); }
  function requireUnlocked() { if (!vault.isUnlocked()) { clear(); fail("Unlock SLV before generating an authenticator code."); } }
  function read(token) {
    requireUnlocked();
    if (!session || typeof token !== "string" || token !== session.token || now() >= session.expires || vault.getOperationEpoch() !== session.epoch) {
      stop(); fail("This authenticator view expired. Open Generate code again.");
    }
    return { ...generateCode(session.config, now()), account: session.config.account, issuer: session.config.issuer, algorithm: session.config.algorithm };
  }
  async function start(image) {
    requireUnlocked(); validateImage(image); stop();
    const epoch = vault.getOperationEpoch(), request = generation, controller = new AbortController(); pending = controller;
    let config;
    try {
      config = await decode(image, controller.signal);
      if (controller.signal.aborted || request !== generation || !vault.isUnlocked() || epoch !== vault.getOperationEpoch()) fail("Vault session changed. Open Generate code again after unlocking.");
      const token = crypto.randomBytes(24).toString("hex");
      session = { token, config, epoch, expires: now() + SESSION_MS }; config = null;
      expiryTimer = setTimeout(() => stop(token), SESSION_MS); expiryTimer.unref();
      return { token, ...read(token) };
    } finally { config?.secret.fill(0); if (pending === controller) pending = null; }
  }
  function copy(token) {
    const result = read(token); clearCopied();
    clipboard.writeText(result.code); copied = result.code;
    clipboardTimer = setTimeout(clearCopied, Math.max(1, Math.min(30000, result.validUntil - now()))); clipboardTimer.unref();
    return result;
  }
  return { start, read, copy, stop, clear };
}
module.exports = { createAuthenticator, decodeInWorker, SESSION_MS };
