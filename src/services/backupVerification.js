const fs = require("fs/promises");
const path = require("path");
const { Worker } = require("worker_threads");
const { writeJsonAtomic } = require("./fsUtils");
const fail = message => Object.assign(new Error(message), { isPublic: true });
const cancelled = () => Object.assign(fail("Backup check cancelled."), { code: "BACKUP_CHECK_CANCELLED" });
const validDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));

function createBackupVerification({ directory, timeoutMs = 60000, statusPath = `${directory}.json` }) {
  let active = null;
  let lastCheck = null, statusWarning = "", saveQueue = Promise.resolve();
  async function loadStatus() {
    try {
      const saved = JSON.parse(await fs.readFile(statusPath, "utf8"));
      const value = saved.lastCheck;
      if (saved.version !== 1 || !value || !["passed", "failed"].includes(value.outcome)
        || !validDate(value.checkedAt) || !(value.backupCreatedAt === null || validDate(value.backupCreatedAt))
        || typeof value.fileName !== "string" || !value.fileName || value.fileName.length > 255
        || path.basename(value.fileName) !== value.fileName) throw new Error("Invalid check summary");
      lastCheck = { fileName: value.fileName, outcome: value.outcome, checkedAt: value.checkedAt, backupCreatedAt: value.backupCreatedAt };
      statusWarning = "";
    } catch (error) {
      lastCheck = null;
      statusWarning = error.code === "ENOENT" ? "" : "The saved backup check summary could not be loaded. Run a new check.";
    }
  }
  function status(latestAutomatic = null) {
    return { lastCheck: lastCheck ? { ...lastCheck } : null, warning: statusWarning,
      newerAutomaticBackup: lastCheck?.outcome === "passed" && validDate(lastCheck.backupCreatedAt) && Number.isFinite(latestAutomatic?.createdAt)
        ? latestAutomatic.createdAt > Date.parse(lastCheck.backupCreatedAt) : null };
  }
  async function remember(filePath, outcome, result) {
    // Deliberately whitelist metadata: never persist passwords, counts or errors.
    const record = { fileName: path.basename(filePath), outcome, checkedAt: new Date().toISOString(),
      backupCreatedAt: outcome === "passed" && validDate(result?.backupCreatedAt) ? result.backupCreatedAt : null };
    const saving = saveQueue.then(async () => {
      try {
        await writeJsonAtomic(statusPath, { version: 1, lastCheck: record });
        lastCheck = record; statusWarning = "";
      } catch {
        statusWarning = "The latest check result could not be saved. The summary below may show an earlier check.";
      }
    });
    saveQueue = saving.catch(() => {});
    await saving;
  }
  async function prepare() {
    await loadStatus();
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
    let result;
    try { result = await run(sourcePath, masterPassword); }
    catch (error) {
      if (error.code !== "BACKUP_CHECK_CANCELLED") await remember(sourcePath, "failed");
      throw error;
    } finally { masterPassword = ""; }
    await remember(sourcePath, "passed", result);
    return result;
  }
  async function run(sourcePath, masterPassword) {
    const request = { controller: new AbortController(), worker: null, workspace: null };
    active = request;
    try {
      request.workspace = await fs.mkdtemp(path.join(directory, "check-"));
      if (request.controller.signal.aborted) throw cancelled();
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
        const aborted = () => finish(cancelled());
        const timer = setTimeout(() => finish(fail("Backup check took too long. Try again with a smaller backup.")), timeoutMs);
        request.controller.signal.addEventListener("abort", aborted, { once: true });
        worker.on("message", message => message?.ok ? finish(null, message.result) : finish(fail(message?.message || "Backup check failed.")));
        worker.on("error", () => finish(fail("Backup check could not finish.")));
        worker.on("exit", () => { if (!settled) finish(fail("Backup check stopped unexpectedly.")); });
      });
      if (request.controller.signal.aborted) throw cancelled();
      return result;
    } finally {
      masterPassword = "";
      try {
        await request.worker?.terminate();
        if (request.workspace) await fs.rm(request.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch { throw fail("Temporary backup check files could not be removed. Restart SLV to retry cleanup."); }
      finally { if (active === request) active = null; }
      if (request.controller.signal.aborted) throw cancelled();
    }
  }
  return { prepare, verify, cancel, status };
}
module.exports = { createBackupVerification };
