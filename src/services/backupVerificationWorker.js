const { parentPort, workerData } = require("worker_threads");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { readBoundedFile, MAX_BACKUP_BYTES } = require("./fsUtils");
const { createVaultStore } = require("./vaultStore");

async function run() {
  let bytes, store;
  try {
    bytes = await readBoundedFile(workerData.sourcePath, MAX_BACKUP_BYTES, "an encrypted backup file");
    const fingerprint = crypto.createHash("sha256").update(bytes).digest("hex");
    const snapshot = path.join(workerData.workspace, "snapshot.slvbackup");
    await fs.writeFile(snapshot, bytes, { flag: "wx", mode: 0o600 });
    bytes.fill(0); bytes = null;
    // The real restore/unlock path runs against a new store, never the active one.
    store = createVaultStore(workerData.workspace);
    const restored = await store.restoreEncryptedBackup(snapshot, workerData.masterPassword);
    await store.unlockVault({ masterPassword: workerData.masterPassword });
    workerData.masterPassword = "";
    const counts = await store.inspectStorage();
    return { verified: true, restored: true, integrity: "ok", counts, fingerprint,
      backupCreatedAt: typeof restored.createdAt === "string" && Number.isFinite(Date.parse(restored.createdAt)) ? new Date(restored.createdAt).toISOString() : null,
      checkedAt: new Date().toISOString() };
  } finally { workerData.masterPassword = ""; bytes?.fill(0); store?.lockVault(); }
}
run().then(result => parentPort.postMessage({ ok: true, result }), error => {
  parentPort.postMessage({ ok: false, message: error.isPublic ? error.message : "Backup check failed. The file may be damaged, incompatible or unreadable." });
}).finally(() => parentPort.close());
