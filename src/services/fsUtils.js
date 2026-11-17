const crypto = require("crypto");
const fs = require("fs/promises");
const { beforeVaultCommit } = require("./vaultOperationContext");

const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const readError = message => Object.assign(new Error(message), { isPublic: true });
// Read from one handle, with a fixed allocation and a final EOF/metadata check.
// A file growing after stat must never turn this into an unbounded read.
async function readBoundedFile(filePath, maxBytes, label, check = () => {}) {
  check();
  const source = await fs.open(filePath, "r");
  let bytes;
  try {
    const stat = await source.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw readError(`Choose ${label} up to ${maxBytes / 1024 / 1024} MB.`);
    check();
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const { bytesRead } = await source.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!bytesRead) throw readError("The file changed while being read. Choose it again.");
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead } = await source.read(extra, 0, 1, offset); extra.fill(0);
    const after = await source.stat();
    check();
    if (bytesRead || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw readError("The file changed while being read. Choose it again.");
    }
    return bytes;
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await source.close(); }
}
async function readBoundedText(filePath, maxBytes, label, check) {
  const bytes = await readBoundedFile(filePath, maxBytes, label, check);
  try { return bytes.toString("utf8"); } finally { bytes.fill(0); }
}

// Writes JSON via a uniquely named temp file + rename. The temp name is unique
// per call so a leftover file from an earlier crash can never block a save, and
// the temp file is removed if the write or rename fails.
async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await fs.writeFile(temporaryPath, json, { encoding: "utf8", flag: "wx" });
    beforeVaultCommit();
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

module.exports = { writeJsonAtomic, fileExists, readBoundedFile, readBoundedText, MAX_IMPORT_BYTES, MAX_BACKUP_BYTES };
