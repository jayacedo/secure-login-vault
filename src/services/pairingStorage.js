const fs = require("fs");
const path = require("path");

// Keeps the browser pairing secret in a file in the app's data folder, encrypted with
// the operating system's per-user protection (Electron's safeStorage: DPAPI on
// Windows). Another Windows account, or another computer, cannot read it; the app
// then simply counts as "not paired".
//
// load / save use Electron's asynchronous encryption API. load() returns null
// when there is nothing usable; save() throws when the
// secret could NOT be stored safely (it never falls back to plain text).

function createPairingStorage({ filePath, safeStorage, fileSystem = fs }) {
  const encryptionAvailable = async () => {
    try {
      return await safeStorage.isAsyncEncryptionAvailable() === true;
    } catch {
      return false;
    }
  };

  return {
    async load() {
      if (!await encryptionAvailable()) return null;
      let bytes;
      try {
        bytes = fileSystem.readFileSync(filePath);
      } catch {
        return null; // no file yet
      }
      try {
        const decrypted = await safeStorage.decryptStringAsync(bytes);
        if (decrypted.isTemporarilyUnavailable || typeof decrypted.result !== "string") return null;
        const parsed = JSON.parse(decrypted.result);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null; // wrong user, damaged or tampered file
      }
    },

    async save(value, isCurrent = () => true) {
      if (!await encryptionAvailable()) {
        throw new Error("Encryption is not available on this account.");
      }
      const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(value));
      // A cancelled/expired request must not commit after encryption completes.
      if (!isCurrent()) throw new Error("Pairing request expired.");
      const temporary = `${filePath}.${process.pid}.tmp`;
      try {
        fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
        fileSystem.writeFileSync(temporary, encrypted);
        fileSystem.renameSync(temporary, filePath);
      } catch (error) {
        try {
          fileSystem.rmSync(temporary, { force: true });
        } catch {
          // nothing to clean up
        }
        throw error;
      }
    },

    clear() {
      fileSystem.rmSync(filePath, { force: true });
    },

    isAvailable: encryptionAvailable
  };
}

module.exports = { createPairingStorage };
