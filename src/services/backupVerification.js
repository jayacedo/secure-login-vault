const fs = require("fs/promises");
const path = require("path");
const { Worker } = require("worker_threads");
const fail = message => Object.assign(new Error(message), { isPublic: true });

function createBackupVerification({ directory, timeoutMs = 60000 }) {
  let active = null;
  async function prepare() {
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw fail("Backup check folder is unavailable.");
    // Leftovers after a crash contain only the encrypted snapshot and vault files.
    for (const name of await fs.readdir(directory)) {
      if (!/^check-[a-zA-Z0-9]{6}$/.test(name)) continue;
      const target = path.join(directory, name);
      const stat = await fs.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rm(target, { recursive: true, force: true });
    }
  }
  function cancel() { active?.controller.abort(); }
  async function verify(sourcePath, masterPassword) {
    if (active) throw fail("A backup check is already running.");
    if (typeof masterPassword !== "string" || !masterPassword || masterPassword.length > 256) throw fail("Enter the backup's master password (up to 256 characters).");
    const request = { controller: new AbortController(), worker: null, workspace: null };
    active = request;
    try {
      request.workspace = await fs.mkdtemp(path.join(directory, "check-"));
      if (request.controller.signal.aborted) throw fail("Backup check cancelled.");
      const result = await new Promise((resolve, reject) => {
        const worker = request.worker = new Worker(path.join(__dirname, "backupVerificationWorker.js"), {
          workerData: { sourcePath, masterPassword, workspace: request.workspace },
          resourceLimits: { maxOldGenerationSizeMb: 512 }
        });
        let settled = false;
        const finish = (error, value) => {
          if (settled) return; settled = true;
          clearTimeout(timer); request.controller.signal.removeEventListener("abort", aborted);
          error ? reject(error) : resolve(value);
        };
        const aborted = () => finish(fail("Backup check cancelled."));
        const timer = setTimeout(() => finish(fail("Backup check took too long. Try again with a smaller backup.")), timeoutMs);
        request.controller.signal.addEventListener("abort", aborted, { once: true });
        worker.on("message", message => message?.ok ? finish(null, message.result) : finish(fail(message?.message || "Backup check failed.")));
        worker.on("error", () => finish(fail("Backup check could not finish.")));
        worker.on("exit", () => { if (!settled) finish(fail("Backup check stopped unexpectedly.")); });
      });
      if (request.controller.signal.aborted) throw fail("Backup check cancelled.");
      return result;
    } finally {
      masterPassword = "";
      try {
        await request.worker?.terminate();
        if (request.workspace) await fs.rm(request.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch { throw fail("Temporary backup check files could not be removed. Restart SLV to retry cleanup."); }
      finally { if (active === request) active = null; }
    }
  }
  return { prepare, verify, cancel };
}
module.exports = { createBackupVerification };
