const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic } = require("./fsUtils");

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION = [7, 14, 30];

function createAutomaticBackups({ configPath, vault, now = Date.now }) {
  let state = { version: 1, id: crypto.randomUUID(), enabled: false, folder: "", keep: 7, lastSuccess: 0, files: [] };
  let error = "";
  let retryAfter = 0;
  let running = false;
  let queue = Promise.resolve();
  let timer;
  const serial = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const owns = name => typeof name === "string" && new RegExp(`^slv-auto-${state.id}-[0-9]{13}-[a-f0-9]{12}\\.slvbackup$`).test(name);
  const status = () => ({ enabled: state.enabled, folder: state.folder, keep: state.keep,
    lastSuccess: state.lastSuccess, nextDue: state.lastSuccess ? state.lastSuccess + DAY_MS : 0,
    running, error,
    latestBackup: state.files[0] ? { fileName: state.files[0], createdAt: Number(state.files[0].split("-").at(-2)) } : null });
  async function load() {
    try {
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      if (saved.version !== 1 || !/^[a-f0-9-]{36}$/.test(saved.id) || typeof saved.enabled !== "boolean"
        || typeof saved.folder !== "string" || (saved.folder && !path.isAbsolute(saved.folder))
        || !RETENTION.includes(saved.keep) || !Number.isFinite(saved.lastSuccess) || !Array.isArray(saved.files)) throw new Error("Invalid backup settings");
      state = saved;
      state.files = saved.files.filter(owns);
    } catch (e) {
      if (e.code !== "ENOENT") error = "Automatic backup settings could not be loaded. Choose a folder to set up again.";
    }
  }
  async function commit(next) {
    await writeJsonAtomic(configPath, next);
    state = next;
  }
  async function requireUnlocked() {
    if (!(await vault.getState()).isUnlocked) throw new Error("Unlock the vault first.");
  }
  async function verifiedFolder() {
    if (!state.folder || await fs.realpath(state.folder) !== state.folder) throw new Error("Backup folder is unavailable or has moved.");
    if (!(await fs.stat(state.folder)).isDirectory()) throw new Error("Choose a backup folder.");
  }
  // Select only the newest successful backup recorded by this installation.
  // Never accept a path from the renderer or silently fall back to an older file.
  const latestForVerification = () => serial(async () => {
    await requireUnlocked();
    const name = state.files[0];
    if (!state.folder || !owns(name)) throw Object.assign(new Error("No automatic backup is recorded yet. Create one or choose another backup."), { isPublic: true });
    try {
      await verifiedFolder();
      const target = path.join(state.folder, name);
      if (path.dirname(target) !== state.folder) throw new Error("Invalid backup location");
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(target) !== target) throw new Error("Invalid backup file");
      return target;
    } catch {
      throw Object.assign(new Error("The latest automatic backup is unavailable. Reconnect its drive or choose another backup."), { isPublic: true });
    }
  });
  // Caller supplies only a path returned by the native folder picker.
  const chooseFolder = folder => serial(async () => {
    await requireUnlocked();
    const resolved = await fs.realpath(folder);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error("Choose a folder.");
    if (resolved === state.folder) return status();
    // Moving destination starts a new schedule. Old folders are never pruned.
    await commit({ ...state, enabled: false, folder: resolved, lastSuccess: 0, files: [] });
    error = ""; retryAfter = 0;
    return status();
  });
  const configure = options => serial(async () => {
    await requireUnlocked();
    if (typeof options?.enabled !== "boolean" || !RETENTION.includes(options.keep)) throw new Error("Choose a valid backup setting.");
    if (options.enabled) await verifiedFolder();
    await commit({ ...state, enabled: options.enabled, keep: options.keep });
    error = ""; retryAfter = 0;
    return status();
  });
  async function prune() {
    // Only names recorded after successful writes by this installation are
    // eligible. Ignore unrelated/manual files, directories and links.
    const old = state.files.slice(state.keep);
    const retained = state.files.slice(0, state.keep);
    for (const name of old) {
      if (!owns(name)) continue;
      const target = path.join(state.folder, name);
      if (path.dirname(target) !== state.folder) continue;
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) { retained.push(name); continue; }
        await fs.unlink(target);
      } catch (e) { if (e.code !== "ENOENT") { retained.push(name); error = "Backup saved, but some older automatic backups could not be removed."; } }
    }
    if (old.length) await commit({ ...state, files: retained });
  }
  const run = ({ force = false } = {}) => serial(async () => {
    if (!state.enabled) return status();
    if (!force && (now() < retryAfter || (state.lastSuccess && now() - state.lastSuccess < DAY_MS))) return status();
    try { if (!(await vault.getState()).isUnlocked) return status(); }
    catch {
      error = "The vault could not be checked for backup. Reopen SLV and check that your vault unlocks normally.";
      retryAfter = now() + 5 * 60 * 1000;
      return status();
    }
    running = true;
    try {
      await verifiedFolder();
      const name = `slv-auto-${state.id}-${String(now()).padStart(13, "0")}-${crypto.randomBytes(6).toString("hex")}.slvbackup`;
      const target = path.join(state.folder, name);
      // Even a collision must not overwrite a pre-existing file.
      const existing = await fs.lstat(target).catch(e => { if (e.code === "ENOENT") return null; throw e; });
      if (existing) throw new Error("Backup name already exists.");
      await vault.createEncryptedBackup(target);
      // No retention deletion before a new verified backup and its record exist.
      await commit({ ...state, lastSuccess: now(), files: [name, ...state.files] });
      error = ""; retryAfter = 0;
      await verifiedFolder();
      await prune();
    } catch {
      error = "Automatic backup could not finish. Check the folder is connected and writable, then try again.";
      retryAfter = now() + 5 * 60 * 1000;
    } finally { running = false; }
    return status();
  });
  return { load, status, chooseFolder, configure, run, latestForVerification,
    start() { if (!timer) { timer = setInterval(() => { run().catch(() => {}); }, 60000); timer.unref(); } },
    stop() { clearInterval(timer); timer = null; }
  };
}
module.exports = { createAutomaticBackups, DAY_MS };
