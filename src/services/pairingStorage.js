const fs = require("fs");
const path = require("path");

// Keeps the browser pairing secret in a file in the app's data folder, encrypted with
// the operating system's per-user protection (Electron's safeStorage: DPAPI on
// Windows). Another Windows account, or another computer, cannot read it; the app
// then simply counts as "not paired".
//
// The interface is the one extensionPairing.js expects: synchronous load / save /
// clear. load() returns null when there is nothing usable; save() throws when the
// secret could NOT be stored safely (it never falls back to plain text).

function createPairingStorage({ filePath, safeStorage, fileSystem = fs }) {
  const encryptionAvailable = () => {
    try {
      return safeStorage.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  };

  return {
    load() {
      if (!encryptionAvailable()) return null;
      let bytes;
      try {
        bytes = fileSystem.readFileSync(filePath);
      } catch {
        return null; // no file yet
      }
      try {
        const parsed = JSON.parse(safeStorage.decryptString(bytes));
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null; // wrong user, damaged or tampered file
      }
    },

    save(value) {
      if (!encryptionAvailable()) {
        throw new Error("Encryption is not available on this account.");
      }
      const encrypted = safeStorage.encryptString(JSON.stringify(value));
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
