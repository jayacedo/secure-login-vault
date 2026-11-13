const { parentPort, workerData } = require("worker_threads");
const { decodeQr } = require("./authenticatorQr");
let config;
try {
  config = decodeQr(workerData.image);
  const secret = new Uint8Array(config.secret);
  parentPort.postMessage({ ok: true, config: { ...config, secret } }, [secret.buffer]);
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.isPublic ? error.message : "Could not read the authenticator QR." });
} finally { config?.secret.fill(0); }
