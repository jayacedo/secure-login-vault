const crypto = require("crypto");
const fs = require("fs/promises");

// Writes JSON via a uniquely named temp file + rename. The temp name is unique
// per call so a leftover file from an earlier crash can never block a save, and
// the temp file is removed if the write or rename fails.
async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await fs.writeFile(temporaryPath, json, { encoding: "utf8", flag: "wx" });
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

module.exports = { writeJsonAtomic, fileExists };
