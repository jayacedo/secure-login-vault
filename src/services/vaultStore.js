const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const bcrypt = require("bcryptjs");
const { promisify } = require("util");
const { writeJsonAtomic, fileExists } = require("./fsUtils");
const {
  createEncryptedVaultFile,
  readDashboardData,
  verifyEncryptedVaultFile,
  getCredentials,
  getCredentialsForExport,
  getCredentialById,
  addCredential,
  updateCredential,
  deleteCredential,
  deleteCredentialsByGroups,
  toggleFavorite,
  getCategories,
  getCategoryUsage,
  addCategory,
  renameCategory,
  deleteCategory,
  searchCredentials,
  getGroups,
  getGroupUsage,
  addGroup,
  renameGroup,
  deleteGroup,
  getActiveGroup,
  setActiveGroup,
  getClients,
  getClientById,
  addClient,
  updateClient,
  deleteClient,
  toggleClientFavorite,
  searchClients
} = require("./sqliteVault");

const scryptAsync = promisify(crypto.scrypt);

const AUTH_FILE_NAME = "vault-auth.json";
const DATABASE_FILE_NAME = "vault-data.slv";
const BCRYPT_ROUNDS = 12;
const SCRYPT_OPTIONS = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
};

function createVaultStore(basePath) {
  const vaultDirectory = path.join(basePath, "vault");
  const authFilePath = path.join(vaultDirectory, AUTH_FILE_NAME);
  const databaseFilePath = path.join(vaultDirectory, DATABASE_FILE_NAME);
  const databaseBackupPath = `${databaseFilePath}.rekey.bak`;
  const preRestoreSuffix = ".pre-restore.bak";
  let sessionKey = null;
  let session = null;

  async function getState() {
    const hasAuth = await fileExists(authFilePath);
    const hasDatabase = await fileExists(databaseFilePath);

    return {
      hasVault: hasAuth,
      databaseReady: hasDatabase,
      isUnlocked: Boolean(sessionKey),
      phase: "UI Polish",
      storagePath: hasAuth ? authFilePath : null,
      databasePath: hasDatabase ? databaseFilePath : null,
      session: getPublicSession(),
      unlockedAt: session ? session.unlockedAt : null
    };
  }

  async function createVault({ masterPassword, confirmPassword }) {
    const normalizedPassword = normalizePassword(masterPassword);
    const normalizedConfirmation = normalizePassword(confirmPassword);

    validateNewPassword(normalizedPassword, normalizedConfirmation);

    if ((await fileExists(authFilePath)) || (await fileExists(databaseFilePath))) {
      throw createPublicError("Vault already exists. Unlock it with the master password.");
    }

    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(normalizedPassword, BCRYPT_ROUNDS);
    const salt = crypto.randomBytes(32);
    const key = await deriveVaultKey(normalizedPassword, salt);
    const encryptedCheck = encryptJson(
      {
        type: "secure-login-vault-auth-check",
        createdAt: now,
        check: crypto.randomBytes(32).toString("base64")
      },
      key
    );

    const authRecord = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      passwordHash,
      passwordHashing: {
        algorithm: "bcrypt",
        rounds: BCRYPT_ROUNDS
      },
      keyDerivation: {
        algorithm: "scrypt",
        salt: salt.toString("base64"),
        keyLength: 32,
        options: SCRYPT_OPTIONS
      },
      encryption: {
        algorithm: "aes-256-gcm",
        vaultCheck: encryptedCheck
      },
      storage: {
        type: "encrypted-sqlite",
        fileName: DATABASE_FILE_NAME
      }
    };

    await fs.mkdir(vaultDirectory, { recursive: true });
    await createEncryptedVaultFile(databaseFilePath, key, now);
    await writeJsonAtomic(authFilePath, authRecord);

    startSession(key, now);

    return {
      created: true,
      isUnlocked: true,
      session: getPublicSession(),
      unlockedAt: session.unlockedAt
    };
  }

  async function unlockVault({ masterPassword }) {
    const normalizedPassword = normalizePassword(masterPassword);

    if (!normalizedPassword) {
      throw createPublicError("Enter the master password.");
    }

    const authRecord = await readAuthRecord();
    const passwordMatches = await bcrypt.compare(normalizedPassword, authRecord.passwordHash);

    if (!passwordMatches) {
      throw createPublicError("Master password is incorrect.");
    }

    const key = await deriveVaultKey(
      normalizedPassword,
      Buffer.from(authRecord.keyDerivation.salt, "base64")
    );

    const check = decryptJson(authRecord.encryption.vaultCheck, key);

    if (check.type !== "secure-login-vault-auth-check") {
      throw createPublicError("Vault verification failed.");
    }

    await ensureVaultDatabase(authRecord, key);
    startSession(key, new Date().toISOString());

    return {
      unlocked: true,
      isUnlocked: true,
      session: getPublicSession(),
      unlockedAt: session.unlockedAt
    };
  }

  function lockVault() {
    if (sessionKey) {
      sessionKey.fill(0);
    }

    sessionKey = null;
    session = null;

    return {
      locked: true,
      isUnlocked: false
    };
  }

  async function getDashboardData() {
    ensureUnlocked();
    return readDashboardData(databaseFilePath, sessionKey);
  }

  // ─── Phase 5: Credential operations ────────────────────────────────────────

  async function getAllCredentials() {
    ensureUnlocked();
    return getCredentials(databaseFilePath, sessionKey);
  }

  async function getAllCredentialsForExport() {
    ensureUnlocked();
    return getCredentialsForExport(databaseFilePath, sessionKey);
  }

  async function getCredential(id) {
    ensureUnlocked();
    return getCredentialById(databaseFilePath, sessionKey, Number(id));
  }

  async function createCredential(data) {
    ensureUnlocked();
    return addCredential(databaseFilePath, sessionKey, data);
  }

  async function editCredential(id, data) {
    ensureUnlocked();
    return updateCredential(databaseFilePath, sessionKey, Number(id), data);
  }

  async function removeCredential(id) {
    ensureUnlocked();
    return deleteCredential(databaseFilePath, sessionKey, Number(id));
  }

  async function removeCredentialsByGroups(groupNames) {
    ensureUnlocked();
    return deleteCredentialsByGroups(databaseFilePath, sessionKey, groupNames);
  }

  async function toggleCredentialFavorite(id) {
    ensureUnlocked();
    return toggleFavorite(databaseFilePath, sessionKey, Number(id));
  }

  async function getAllCategories() {
    ensureUnlocked();
    return getCategories(databaseFilePath, sessionKey);
  }

  // ─── Category management ────────────────────────────────────────────────────

  async function getCategoriesWithUsage() {
    ensureUnlocked();
    return getCategoryUsage(databaseFilePath, sessionKey);
  }

  async function createCategory(name) {
    ensureUnlocked();
    return addCategory(databaseFilePath, sessionKey, name);
  }

  async function editCategory(currentName, newName) {
    ensureUnlocked();
    return renameCategory(databaseFilePath, sessionKey, currentName, newName);
  }

  async function removeCategory(name, reassignTo) {
    ensureUnlocked();
    return deleteCategory(databaseFilePath, sessionKey, name, reassignTo);
  }

  async function searchVaultCredentials(options) {
    ensureUnlocked();
    return searchCredentials(databaseFilePath, sessionKey, options);
  }

  // ─── Group management ───────────────────────────────────────────────────────

  async function getAllGroups() {
    ensureUnlocked();
    return getGroups(databaseFilePath, sessionKey);
  }

  async function getGroupsWithUsage() {
    ensureUnlocked();
    return getGroupUsage(databaseFilePath, sessionKey);
  }

  async function createGroup(name) {
    ensureUnlocked();
    return addGroup(databaseFilePath, sessionKey, name);
  }

  async function editGroup(currentName, newName) {
    ensureUnlocked();
    return renameGroup(databaseFilePath, sessionKey, currentName, newName);
  }

  async function removeGroup(name) {
    ensureUnlocked();
    return deleteGroup(databaseFilePath, sessionKey, name);
  }

  async function getCurrentActiveGroup() {
    ensureUnlocked();
    return getActiveGroup(databaseFilePath, sessionKey);
  }

  async function setCurrentActiveGroup(name) {
    ensureUnlocked();
    return setActiveGroup(databaseFilePath, sessionKey, name);
  }

  // ─── Client Vault operations ────────────────────────────────────────────────

  async function getAllClients() {
    ensureUnlocked();
    return getClients(databaseFilePath, sessionKey);
  }

  async function getClient(id) {
    ensureUnlocked();
    return getClientById(databaseFilePath, sessionKey, Number(id));
  }

  async function createClient(data) {
    ensureUnlocked();
    return addClient(databaseFilePath, sessionKey, data);
  }

  async function editClient(id, data) {
    ensureUnlocked();
    return updateClient(databaseFilePath, sessionKey, Number(id), data);
  }

  async function removeClient(id) {
    ensureUnlocked();
    return deleteClient(databaseFilePath, sessionKey, Number(id));
  }

  async function toggleClientFav(id) {
    ensureUnlocked();
    return toggleClientFavorite(databaseFilePath, sessionKey, Number(id));
  }

  async function searchVaultClients(options) {
    ensureUnlocked();
    return searchClients(databaseFilePath, sessionKey, options);
  }

  // ─── Phase 10: Change Master Password ──────────────────────────────────────

  async function changeMasterPassword({ currentPassword, newPassword, confirmPassword }) {
    ensureUnlocked();

    const normalizedCurrent = normalizePassword(currentPassword);
    const normalizedNew     = normalizePassword(newPassword);
    const normalizedConfirm = normalizePassword(confirmPassword);

    if (!normalizedCurrent) throw createPublicError("Enter your current master password.");

    const authRecord = await readAuthRecord();
    const passwordMatches = await bcrypt.compare(normalizedCurrent, authRecord.passwordHash);
    if (!passwordMatches) throw createPublicError("Current master password is incorrect.");

    validateNewPassword(normalizedNew, normalizedConfirm);

    const now          = new Date().toISOString();
    const passwordHash = await bcrypt.hash(normalizedNew, BCRYPT_ROUNDS);
    const salt         = crypto.randomBytes(32);
    const newKey       = await deriveVaultKey(normalizedNew, salt);

    const encryptedCheck = encryptJson(
      { type: "secure-login-vault-auth-check", createdAt: now, check: crypto.randomBytes(32).toString("base64") },
      newKey
    );

    const updatedAuthRecord = {
      ...authRecord,
      updatedAt: now,
      passwordHash,
      keyDerivation: {
        ...authRecord.keyDerivation,
        salt: salt.toString("base64")
      },
      encryption: {
        ...authRecord.encryption,
        vaultCheck: encryptedCheck
      }
    };

    // Re-key the SQLite database: read with old key, write with new key
    // Two files must change and they cannot be swapped atomically together.
    // Keep a copy of the old database first: if we fail (or crash) between the
    // two writes, the old auth record + old database copy are still a matching
    // pair (see recovery in ensureVaultDatabase).
    const { rekeyEncryptedVaultFile } = require("./sqliteVault");
    await fs.copyFile(databaseFilePath, databaseBackupPath);
    try {
      await rekeyEncryptedVaultFile(databaseFilePath, sessionKey, newKey);
      await writeJsonAtomic(authFilePath, updatedAuthRecord);
    } catch (error) {
      // Put the old database back so it matches the unchanged auth record.
      await fs.copyFile(databaseBackupPath, databaseFilePath).catch(() => {});
      throw error;
    }
    await fs.rm(databaseBackupPath, { force: true }).catch(() => {});

    // Update live session key
    sessionKey.fill(0);
    sessionKey = newKey;

    return { changed: true };
  }

  // ─── Phase 9: Encrypted Backup & Restore ───────────────────────────────────

  // The backup bundles the two files that already make up the vault on disk —
  // the auth record (master password hash + key-derivation salt) and the
  // encrypted SQLite database — into a single portable JSON file. Nothing
  // inside is decrypted or re-encrypted for the backup; both pieces are
  // already AES-256-GCM encrypted at rest, so the backup is exactly as safe
  // as the live vault. Restoring it requires the same master password that
  // was used to create it.
  async function createEncryptedBackup(destinationPath) {
    ensureUnlocked();

    const authRaw = await fs.readFile(authFilePath, "utf8");
    const databaseRaw = await fs.readFile(databaseFilePath, "utf8");

    const bundle = {
      format: "secure-login-vault-backup",
      version: 1,
      createdAt: new Date().toISOString(),
      auth: JSON.parse(authRaw),
      database: JSON.parse(databaseRaw)
    };

    await fs.writeFile(destinationPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    return { written: true, filePath: destinationPath };
  }

  // Restoring does NOT require the vault to currently be unlocked — this is
  // meant to work for disaster recovery (reinstalled app, lost vault file).
  // It DOES require the master password the backup was created with, since
  // that is what proves the restore is legitimate and lets us re-derive the
  // encryption key to verify the backup is genuine before overwriting
  // anything on disk.
  async function restoreEncryptedBackup(sourcePath, masterPassword) {
    const normalizedPassword = normalizePassword(masterPassword);
    if (!normalizedPassword) {
      throw createPublicError("Enter the master password for this backup.");
    }

    const raw = await fs.readFile(sourcePath, "utf8");
    let bundle;
    try {
      bundle = JSON.parse(raw);
    } catch {
      throw createPublicError("Backup file is not valid.");
    }

    if (!isValidBackupBundle(bundle)) {
      throw createPublicError("Backup file format is not recognized.");
    }

    if (!isValidAuthRecord(bundle.auth)) {
      throw createPublicError("Backup file is corrupted or incompatible.");
    }

    const passwordMatches = await bcrypt.compare(normalizedPassword, bundle.auth.passwordHash);
    if (!passwordMatches) {
      throw createPublicError("Master password does not match this backup.");
    }

    const key = await deriveVaultKey(
      normalizedPassword,
      Buffer.from(bundle.auth.keyDerivation.salt, "base64")
    );
    const check = decryptJson(bundle.auth.encryption.vaultCheck, key);
    if (check.type !== "secure-login-vault-auth-check") {
      throw createPublicError("Backup file could not be verified.");
    }

    // Lock any active session before overwriting the files it points to.
    lockVault();

    await fs.mkdir(vaultDirectory, { recursive: true });

    // Keep the vault being replaced so a restore is never destructive. These
    // copies are overwritten by the next restore.
    const hadAuth = await fileExists(authFilePath);
    const hadDatabase = await fileExists(databaseFilePath);
    if (hadAuth) await fs.copyFile(authFilePath, authFilePath + preRestoreSuffix);
    if (hadDatabase) await fs.copyFile(databaseFilePath, databaseFilePath + preRestoreSuffix);

    try {
      await writeJsonAtomic(databaseFilePath, bundle.database);
      await writeJsonAtomic(authFilePath, bundle.auth);
    } catch (error) {
      // Roll back to the previous pair so the vault is never half-restored.
      if (hadDatabase) await fs.copyFile(databaseFilePath + preRestoreSuffix, databaseFilePath).catch(() => {});
      if (hadAuth) await fs.copyFile(authFilePath + preRestoreSuffix, authFilePath).catch(() => {});
      throw error;
    }

    return { restored: true, createdAt: bundle.createdAt };
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  async function readAuthRecord() {
    if (!(await fileExists(authFilePath))) {
      throw createPublicError("No vault exists yet. Create a master password first.");
    }

    const raw = await fs.readFile(authFilePath, "utf8");
    const record = JSON.parse(raw);

    if (!isValidAuthRecord(record)) {
      throw createPublicError("Vault authentication data is invalid.");
    }

    return record;
  }

  async function ensureVaultDatabase(authRecord, key) {
    if (await fileExists(databaseFilePath)) {
      try {
        await verifyEncryptedVaultFile(databaseFilePath, key);
      } catch (error) {
        // Interrupted master-password change: the database was re-keyed but the
        // auth record was not updated. The pre-change copy matches this key.
        if (!(await fileExists(databaseBackupPath))) throw error;
        await verifyEncryptedVaultFile(databaseBackupPath, key).catch(() => {
          throw error;
        });
        await fs.copyFile(databaseBackupPath, databaseFilePath);
        await fs.rm(databaseBackupPath, { force: true }).catch(() => {});
      }
      return;
    }

    if (authRecord.storage) {
      throw createPublicError("Encrypted vault database is missing.");
    }

    const now = new Date().toISOString();
    await createEncryptedVaultFile(databaseFilePath, key, authRecord.createdAt || now);
    await writeJsonAtomic(authFilePath, {
      ...authRecord,
      updatedAt: now,
      storage: {
        type: "encrypted-sqlite",
        fileName: DATABASE_FILE_NAME
      }
    });
  }

  function ensureUnlocked() {
    if (!sessionKey) {
      throw createPublicError("Vault is locked.");
    }
  }

  function startSession(key, now) {
    sessionKey = key;
    session = {
      id: crypto.randomUUID(),
      unlockedAt: now,
      lastActivityAt: now
    };
  }

  function getPublicSession() {
    if (!session) {
      return null;
    }

    session.lastActivityAt = new Date().toISOString();

    return {
      id: session.id,
      unlockedAt: session.unlockedAt,
      lastActivityAt: session.lastActivityAt
    };
  }

  return {
    createVault,
    getDashboardData,
    getState,
    lockVault,
    unlockVault,
    getAllCredentials,
    getAllCredentialsForExport,
    getCredential,
    createCredential,
    editCredential,
    removeCredential,
    removeCredentialsByGroups,
    toggleCredentialFavorite,
    getAllCategories,
    getCategoriesWithUsage,
    createCategory,
    editCategory,
    removeCategory,
    searchVaultCredentials,
    getAllGroups,
    getGroupsWithUsage,
    createGroup,
    editGroup,
    removeGroup,
    getCurrentActiveGroup,
    setCurrentActiveGroup,
    getAllClients,
    getClient,
    createClient,
    editClient,
    removeClient,
    toggleClientFav,
    searchVaultClients,
    createEncryptedBackup,
    restoreEncryptedBackup,
    changeMasterPassword
  };
}

function normalizePassword(value) {
  return typeof value === "string" ? value : "";
}

function validateNewPassword(masterPassword, confirmPassword) {
  if (!masterPassword) {
    throw createPublicError("Enter a master password.");
  }

  if (masterPassword.length < 12) {
    throw createPublicError("Master password must be at least 12 characters.");
  }

  if (masterPassword.length > 256) {
    throw createPublicError("Master password must be 256 characters or fewer.");
  }

  if (masterPassword !== confirmPassword) {
    throw createPublicError("Master password confirmation does not match.");
  }
}

async function deriveVaultKey(password, salt) {
  return scryptAsync(password, salt, 32, SCRYPT_OPTIONS);
}

function encryptJson(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64")
  };
}

function decryptJson(payload, key) {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "base64")
    );

    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final()
    ]);

    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    throw createPublicError("Vault could not be decrypted with this master password.");
  }
}

function isValidAuthRecord(record) {
  return Boolean(
    record &&
      record.version === 1 &&
      typeof record.passwordHash === "string" &&
      record.keyDerivation &&
      record.keyDerivation.algorithm === "scrypt" &&
      typeof record.keyDerivation.salt === "string" &&
      record.encryption &&
      record.encryption.algorithm === "aes-256-gcm" &&
      record.encryption.vaultCheck &&
      typeof record.encryption.vaultCheck.iv === "string" &&
      typeof record.encryption.vaultCheck.tag === "string" &&
      typeof record.encryption.vaultCheck.ciphertext === "string" &&
      (!record.storage ||
        (record.storage.type === "encrypted-sqlite" &&
          record.storage.fileName === DATABASE_FILE_NAME))
  );
}

function isValidBackupBundle(bundle) {
  return Boolean(
    bundle &&
      bundle.format === "secure-login-vault-backup" &&
      bundle.version === 1 &&
      bundle.auth &&
      bundle.database &&
      bundle.database.format === "secure-login-vault-encrypted-sqlite"
  );
}

function createPublicError(message) {
  const error = new Error(message);
  error.isPublic = true;
  return error;
}

module.exports = {
  createVaultStore
};
