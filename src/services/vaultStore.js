const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const bcrypt = require("bcryptjs");
const { promisify } = require("util");
const { writeJsonAtomic, fileExists } = require("./fsUtils");
const { currentVaultOperation, runVaultOperation, assertVaultOperationActive, beforeVaultCommit, trackVaultBuffer } = require("./vaultOperationContext");
const {
  previewCredentialMove,
  moveCredentialsToGroup,
  previewCredentialCategory,
  changeCredentialCategory,
  undoBulkCredentialChange,
  previewCredentialFavorites,
  changeCredentialFavorites,
  createEncryptedVaultFile,
  readDashboardData,
  verifyEncryptedVaultFile,
  verifyEncryptedVaultPayload,
  inspectEncryptedVault,
  getCredentials,
  getCredentialsForExport,
  getCredentialById,
  getCredentialPasswordHistory,
  getCredentialDetails,
  getVaultHealth,
  getDuplicateReview,
  resolveDuplicateReview,
  addCredential,
  updateBrowserPassword,
  getActivityHistory,
  purgeActivityHistory,
  updateCredential,
  deleteCredential,
  manageCredentialTrash,
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
  let bulkUndo = null;
  let operationEpoch = 0;
  let operationQueue = Promise.resolve();
  const owner = {};

  function currentKey() {
    const operation = currentVaultOperation();
    return operation?.owner === owner ? operation.key : sessionKey;
  }

  function serialize(operation, requiresUnlock = true) {
    return (...args) => {
      const requestedEpoch = operationEpoch;
      const requestedSession = session?.id;
      const task = operationQueue.then(async () => {
        if (requestedEpoch !== operationEpoch || (requiresUnlock && (!sessionKey || requestedSession !== session?.id))) {
          throw createSessionChangedError();
        }
        const state = { owner, epoch: operationEpoch, key: sessionKey ? Buffer.from(sessionKey) : null, buffers: new Set(), committing: false,
          check() { if (this.epoch !== operationEpoch) throw createSessionChangedError(); } };
        if (state.key) state.buffers.add(state.key);
        try {
          return await runVaultOperation(state, async () => {
            const result = await operation(...args);
            state.check();
            return result;
          });
        } finally { for (const buffer of state.buffers) buffer.fill(0); }
      });
      operationQueue = task.catch(() => {});
      return task;
    };
  }

  function replaceSessionKey(key) {
    const operation = currentVaultOperation();
    // A completed commit must not undo a lock that arrived during disk IO.
    if (operation?.owner === owner && operation.epoch !== operationEpoch) return;
    if (sessionKey) sessionKey.fill(0);
    sessionKey = Buffer.from(key);
  }

  function lockForReplacement() {
    assertVaultOperationActive();
    lockVault();
    const operation = currentVaultOperation();
    if (operation?.owner === owner) operation.epoch = operationEpoch;
  }

  async function getState() {
    const hasAuth = await fileExists(authFilePath);
    const hasDatabase = await fileExists(databaseFilePath);

    return {
      hasVault: hasAuth,
      // Stored unencrypted on purpose: it must be readable before unlocking.
      passwordHint: hasAuth ? (await readPublicAuthInfo()).hint : "",
      hasRecoveryKey: hasAuth ? (await readPublicAuthInfo()).hasRecoveryKey : false,
      databaseReady: hasDatabase,
      isUnlocked: Boolean(sessionKey),
      phase: "UI Polish",
      storagePath: hasAuth ? authFilePath : null,
      databasePath: hasDatabase ? databaseFilePath : null,
      session: getPublicSession(),
      unlockedAt: session ? session.unlockedAt : null
    };
  }

  async function createVault({ masterPassword, confirmPassword, hint }) {
    const normalizedPassword = normalizePassword(masterPassword);
    const normalizedConfirmation = normalizePassword(confirmPassword);

    validateNewPassword(normalizedPassword, normalizedConfirmation);
    const passwordHint = normalizePasswordHint(hint, normalizedPassword);

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
    if (passwordHint) authRecord.hint = passwordHint;

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

    // Vaults with a recovery key encrypt the database with a random data key,
    // stored wrapped by the password-derived key. Older vaults use the
    // password-derived key directly.
    const databaseKey = authRecord.keyWrap ? unwrapBytes(authRecord.keyWrap.dek, key) : key;

    await ensureVaultDatabase(authRecord, databaseKey);
    startSession(databaseKey, new Date().toISOString());
    if (databaseKey !== key) key.fill(0);

    return {
      unlocked: true,
      isUnlocked: true,
      session: getPublicSession(),
      unlockedAt: session.unlockedAt
    };
  }

  function lockVault() {
    bulkUndo = null;
    operationEpoch++;
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
    return readDashboardData(databaseFilePath, currentKey());
  }

  // ─── Phase 5: Credential operations ────────────────────────────────────────

  async function getAllCredentials() {
    ensureUnlocked();
    return getCredentials(databaseFilePath, currentKey());
  }

  async function getAllCredentialsForExport() {
    ensureUnlocked();
    return getCredentialsForExport(databaseFilePath, currentKey());
  }

  async function getCredential(id) {
    ensureUnlocked();
    return getCredentialById(databaseFilePath, currentKey(), Number(id));
  }

  async function createCredential(data) {
    ensureUnlocked();
    return addCredential(databaseFilePath, currentKey(), data);
  }

  async function createBrowserCredential(data, organization) {
    ensureUnlocked();
    return addCredential(databaseFilePath, currentKey(),
      { ...data, groupName: organization.groupName, category: organization.category },
      { expectedActiveGroup: organization.activeGroup, source: "browser" });
  }

  async function editCredential(id, data) {
    ensureUnlocked();
    return updateCredential(databaseFilePath, currentKey(), Number(id), data);
  }

  async function getPasswordHistory(id) {
    ensureUnlocked();
    const credentialId = Number(id);
    if (!Number.isSafeInteger(credentialId) || credentialId <= 0) throw createPublicError("Credential not found.");
    return getCredentialPasswordHistory(databaseFilePath, currentKey(), credentialId);
  }

  async function checkVaultHealth() {
    ensureUnlocked();
    const key = currentKey();
    const report = await getVaultHealth(databaseFilePath, key);
    ensureUnlocked();
    if (key !== currentKey()) throw createPublicError("Vault session changed. Check again.");
    return report;
  }

  async function removeCredential(id) {
    ensureUnlocked();
    return deleteCredential(databaseFilePath, currentKey(), Number(id));
  }

  async function manageTrash(action, id, confirmed) {
    ensureUnlocked();
    const key = currentKey();
    const guard = () => {
      ensureUnlocked();
      if (key !== currentKey()) throw createPublicError("Vault session changed. Open Recently Deleted again.");
    };
    const result = await manageCredentialTrash(databaseFilePath, key, action, id, confirmed, guard);
    guard();
    return result;
  }

  async function reviewDuplicates(choice) {
    ensureUnlocked();
    const key = currentKey();
    const guard = () => {
      ensureUnlocked();
      if (key !== currentKey()) throw createPublicError("Vault session changed. Open Duplicate Login Review again.");
    };
    const result = choice === undefined ? await getDuplicateReview(databaseFilePath, key, guard) : await resolveDuplicateReview(databaseFilePath, key, choice, guard);
    guard();
    return result;
  }

  async function removeCredentialsByGroups(groupNames) {
    ensureUnlocked();
    return deleteCredentialsByGroups(databaseFilePath, currentKey(), groupNames);
  }

  async function toggleCredentialFavorite(id) {
    ensureUnlocked();
    return toggleFavorite(databaseFilePath, currentKey(), Number(id));
  }

  async function getAllCategories() {
    ensureUnlocked();
    return getCategories(databaseFilePath, currentKey());
  }

  // ─── Category management ────────────────────────────────────────────────────

  async function getCategoriesWithUsage() {
    ensureUnlocked();
    return getCategoryUsage(databaseFilePath, currentKey());
  }

  async function createCategory(name) {
    ensureUnlocked();
    return addCategory(databaseFilePath, currentKey(), name);
  }

  async function editCategory(currentName, newName) {
    ensureUnlocked();
    return renameCategory(databaseFilePath, currentKey(), currentName, newName);
  }

  async function removeCategory(name, reassignTo) {
    ensureUnlocked();
    return deleteCategory(databaseFilePath, currentKey(), name, reassignTo);
  }

  async function searchVaultCredentials(options) {
    ensureUnlocked();
    return searchCredentials(databaseFilePath, currentKey(), options);
  }

  // ─── Group management ───────────────────────────────────────────────────────

  async function getAllGroups() {
    ensureUnlocked();
    return getGroups(databaseFilePath, currentKey());
  }

  async function getGroupsWithUsage() {
    ensureUnlocked();
    return getGroupUsage(databaseFilePath, currentKey());
  }

  async function createGroup(name) {
    ensureUnlocked();
    return addGroup(databaseFilePath, currentKey(), name);
  }

  async function editGroup(currentName, newName) {
    ensureUnlocked();
    return renameGroup(databaseFilePath, currentKey(), currentName, newName);
  }

  async function removeGroup(name) {
    ensureUnlocked();
    return deleteGroup(databaseFilePath, currentKey(), name);
  }

  async function getCurrentActiveGroup() {
    ensureUnlocked();
    return getActiveGroup(databaseFilePath, currentKey());
  }

  async function setCurrentActiveGroup(name) {
    ensureUnlocked();
    return setActiveGroup(databaseFilePath, currentKey(), name);
  }

  // ─── Client Vault operations ────────────────────────────────────────────────

  async function getAllClients() {
    ensureUnlocked();
    return getClients(databaseFilePath, currentKey());
  }

  async function getClient(id) {
    ensureUnlocked();
    return getClientById(databaseFilePath, currentKey(), Number(id));
  }

  async function createClient(data) {
    ensureUnlocked();
    return addClient(databaseFilePath, currentKey(), data);
  }

  async function editClient(id, data) {
    ensureUnlocked();
    return updateClient(databaseFilePath, currentKey(), Number(id), data);
  }

  async function removeClient(id) {
    ensureUnlocked();
    return deleteClient(databaseFilePath, currentKey(), Number(id));
  }

  async function toggleClientFav(id) {
    ensureUnlocked();
    return toggleClientFavorite(databaseFilePath, currentKey(), Number(id));
  }

  async function searchVaultClients(options) {
    ensureUnlocked();
    return searchClients(databaseFilePath, currentKey(), options);
  }

  // ─── Phase 10: Change Master Password ──────────────────────────────────────

  async function changeMasterPassword({ currentPassword, newPassword, confirmPassword, hint }) {
    ensureUnlocked();

    const normalizedCurrent = normalizePassword(currentPassword);
    const normalizedNew     = normalizePassword(newPassword);
    const normalizedConfirm = normalizePassword(confirmPassword);

    if (!normalizedCurrent) throw createPublicError("Enter your current master password.");

    const authRecord = await readAuthRecord();
    const passwordMatches = await bcrypt.compare(normalizedCurrent, authRecord.passwordHash);
    if (!passwordMatches) throw createPublicError("Current master password is incorrect.");

    validateNewPassword(normalizedNew, normalizedConfirm);
    // The old hint describes the old password, so it is replaced by the one
    // supplied here (or removed when none is given).
    const newHint = normalizePasswordHint(hint, normalizedNew);

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
    delete updatedAuthRecord.hint;
    if (newHint) updatedAuthRecord.hint = newHint;

    if (authRecord.keyWrap) {
      // The database stays encrypted with the same data key; only its wrapper
      // changes, so this is a single atomic file write and the recovery key
      // keeps working.
      updatedAuthRecord.keyWrap = {
        ...authRecord.keyWrap,
        dek: wrapBytes(currentKey(), newKey)
      };
      await writeJsonAtomic(authFilePath, updatedAuthRecord);
      newKey.fill(0);
      return { changed: true };
    }

    // Legacy vault: re-key the SQLite database with the new password key.
    // Two files must change and they cannot be swapped atomically together.
    // Keep a copy of the old database first: if we fail (or crash) between the
    // two writes, the old auth record + old database copy are still a matching
    // pair (see recovery in ensureVaultDatabase).
    const { rekeyEncryptedVaultFile } = require("./sqliteVault");
    await fs.copyFile(databaseFilePath, databaseBackupPath);
    try {
      await rekeyEncryptedVaultFile(databaseFilePath, currentKey(), newKey);
      await writeJsonAtomic(authFilePath, updatedAuthRecord);
    } catch (error) {
      // Put the old database back so it matches the unchanged auth record.
      await fs.copyFile(databaseBackupPath, databaseFilePath).catch(() => {});
      throw error;
    }
    await fs.rm(databaseBackupPath, { force: true }).catch(() => {});

    // Update live session key
    replaceSessionKey(newKey);

    return { changed: true };
  }

  // Changing only the hint needs the current password: a hint weakens the vault,
  // so it should not be editable by someone who walked up to an unlocked app.
  async function setPasswordHint({ currentPassword, hint }) {
    ensureUnlocked();

    const normalizedCurrent = normalizePassword(currentPassword);
    if (!normalizedCurrent) throw createPublicError("Enter your current master password.");

    const authRecord = await readAuthRecord();
    const passwordMatches = await bcrypt.compare(normalizedCurrent, authRecord.passwordHash);
    if (!passwordMatches) throw createPublicError("Current master password is incorrect.");

    const newHint = normalizePasswordHint(hint, normalizedCurrent);
    const updated = { ...authRecord, updatedAt: new Date().toISOString() };
    delete updated.hint;
    if (newHint) updated.hint = newHint;

    await writeJsonAtomic(authFilePath, updated);
    return { hint: newHint };
  }

  // ─── Recovery key ──────────────────────────────────────────────────────────

  // Creates (or replaces) the recovery key and returns its text. The key is
  // never stored; only the data key wrapped by it is. Generating a new key
  // makes the previous one stop working. Vaults created before recovery keys
  // existed are converted to the data-key layout the first time.
  async function createRecoveryKey({ currentPassword }) {
    ensureUnlocked();

    const normalizedCurrent = normalizePassword(currentPassword);
    if (!normalizedCurrent) throw createPublicError("Enter your current master password.");

    const authRecord = await readAuthRecord();
    const passwordMatches = await bcrypt.compare(normalizedCurrent, authRecord.passwordHash);
    if (!passwordMatches) throw createPublicError("Current master password is incorrect.");

    const recovery = generateRecoveryKey();
    const recoverySalt = crypto.randomBytes(32);
    const recoveryWrapKey = deriveRecoveryWrapKey(recovery.bytes, recoverySalt);
    const now = new Date().toISOString();

    if (authRecord.keyWrap) {
      await writeJsonAtomic(authFilePath, {
        ...authRecord,
        updatedAt: now,
        keyWrap: {
          ...authRecord.keyWrap,
          recovery: {
            salt: recoverySalt.toString("base64"),
            dek: wrapBytes(currentKey(), recoveryWrapKey)
          }
        }
      });
      return { recoveryKey: recovery.text, converted: false };
    }

    // Convert: re-encrypt the database with a new random data key. Same
    // protection as a master password change: keep the old database until the
    // auth record that matches the new one is safely written.
    const dataKey = trackVaultBuffer(crypto.randomBytes(32));
    const updatedAuthRecord = {
      ...authRecord,
      updatedAt: now,
      keyWrap: {
        dek: wrapBytes(dataKey, currentKey()),
        recovery: {
          salt: recoverySalt.toString("base64"),
          dek: wrapBytes(dataKey, recoveryWrapKey)
        }
      }
    };

    const { rekeyEncryptedVaultFile } = require("./sqliteVault");
    await fs.copyFile(databaseFilePath, databaseBackupPath);
    try {
      await rekeyEncryptedVaultFile(databaseFilePath, currentKey(), dataKey);
      await writeJsonAtomic(authFilePath, updatedAuthRecord);
    } catch (error) {
      await fs.copyFile(databaseBackupPath, databaseFilePath).catch(() => {});
      throw error;
    }
    await fs.rm(databaseBackupPath, { force: true }).catch(() => {});

    replaceSessionKey(dataKey);
    return { recoveryKey: recovery.text, converted: true };
  }

  // Sets a new master password using the recovery key. Works while locked. The
  // vault stays locked afterwards; the user logs in with the new password.
  async function resetWithRecoveryKey({ recoveryKey, newPassword, confirmPassword, hint }) {
    const authRecord = await readAuthRecord();
    const recovery = authRecord.keyWrap && authRecord.keyWrap.recovery;
    if (!recovery) throw createPublicError("This vault does not have a recovery key.");

    const recoveryBytes = parseRecoveryKey(recoveryKey);
    if (!recoveryBytes) throw createPublicError("That is not a valid recovery key. Check it and try again.");

    let dataKey;
    try {
      dataKey = unwrapBytes(
        recovery.dek,
        deriveRecoveryWrapKey(recoveryBytes, Buffer.from(recovery.salt, "base64"))
      );
    } catch {
      throw createPublicError("The recovery key is incorrect.");
    }

    const normalizedNew = normalizePassword(newPassword);
    validateNewPassword(normalizedNew, normalizePassword(confirmPassword));
    const newHint = normalizePasswordHint(hint, normalizedNew);

    // Make sure the data key really opens this vault before changing anything.
    await verifyEncryptedVaultFile(databaseFilePath, dataKey);

    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(normalizedNew, BCRYPT_ROUNDS);
    const salt = crypto.randomBytes(32);
    const newKey = await deriveVaultKey(normalizedNew, salt);

    const updatedAuthRecord = {
      ...authRecord,
      updatedAt: now,
      passwordHash,
      keyDerivation: { ...authRecord.keyDerivation, salt: salt.toString("base64") },
      encryption: {
        ...authRecord.encryption,
        vaultCheck: encryptJson(
          { type: "secure-login-vault-auth-check", createdAt: now, check: crypto.randomBytes(32).toString("base64") },
          newKey
        )
      },
      keyWrap: { ...authRecord.keyWrap, dek: wrapBytes(dataKey, newKey) }
    };
    delete updatedAuthRecord.hint;
    if (newHint) updatedAuthRecord.hint = newHint;

    lockForReplacement();
    await writeJsonAtomic(authFilePath, updatedAuthRecord);
    newKey.fill(0);
    dataKey.fill(0);

    return { reset: true };
  }

  // ─── Phase 9: Encrypted Backup & Restore ───────────────────────────────────

  // The backup bundles the two files that already make up the vault on disk —
  // the auth record (master password hash + key-derivation salt) and the
  // encrypted SQLite database — into a single portable JSON file. Nothing
  // written in plaintext: credential data remains encrypted. The auth record
  // includes public metadata (salt, password hash and optional hint). Verify
  // the encrypted snapshot in memory before writing it atomically. Restoring
  // requires the master password in use when this backup was created.
  async function createEncryptedBackup(destinationPath) {
    ensureUnlocked();
    const originalKey = currentKey();
    const backupKey = Buffer.from(originalKey);
    try {
      const authRaw = await fs.readFile(authFilePath, "utf8");
      const auth = JSON.parse(authRaw);
      if (!isValidAuthRecord(auth)) throw createPublicError("Vault authentication data is invalid.");
      const database = JSON.parse(await fs.readFile(databaseFilePath, "utf8"));
      await verifyEncryptedVaultPayload(database, backupKey);
      // A master-password change/recovery conversion swaps auth and database
      // separately. Never publish a mismatched pair or a snapshot across locks.
      if (currentKey() !== originalKey || authRaw !== await fs.readFile(authFilePath, "utf8")) {
        throw createPublicError("The vault changed during backup. Try again.");
      }
      const bundle = {
        format: "secure-login-vault-backup", version: 1,
        createdAt: new Date().toISOString(), auth, database
      };
      await writeJsonAtomic(destinationPath, bundle);
      return { written: true, filePath: destinationPath };
    } finally { backupKey.fill(0); }
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

    const backupDataKey = bundle.auth.keyWrap ? unwrapBytes(bundle.auth.keyWrap.dek, key) : key;
    await verifyEncryptedVaultPayload(bundle.database, backupDataKey);

    // Lock any active session before overwriting the files it points to.
    lockForReplacement();

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
      else await fs.rm(databaseFilePath, { force: true }).catch(() => {});
      if (hadAuth) await fs.copyFile(authFilePath + preRestoreSuffix, authFilePath).catch(() => {});
      else await fs.rm(authFilePath, { force: true }).catch(() => {});
      throw error;
    }

    return { restored: true, createdAt: bundle.createdAt };
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  // Facts the login screen needs before the vault is unlocked.
  async function readPublicAuthInfo() {
    try {
      const record = JSON.parse(await fs.readFile(authFilePath, "utf8"));
      return {
        hint: typeof record.hint === "string" ? record.hint : "",
        hasRecoveryKey: Boolean(record.keyWrap && record.keyWrap.recovery)
      };
    } catch {
      return { hint: "", hasRecoveryKey: false };
    }
  }

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
        // Everything matches, so any leftover pre-change copy (from a crash after
        // the auth record was already written) is stale: remove it.
        await fs.rm(databaseBackupPath, { force: true }).catch(() => {});
      } catch (error) {
        // Interrupted master-password change: the database was re-keyed but the
        // auth record was not updated. The pre-change copy matches this key.
        let recoveryPath = databaseBackupPath;
        if (!(await fileExists(recoveryPath))) {
          const previousAuth = await fs.readFile(authFilePath + preRestoreSuffix, "utf8").catch(() => "");
          const currentAuth = await fs.readFile(authFilePath, "utf8");
          if (previousAuth !== currentAuth || !(await fileExists(databaseFilePath + preRestoreSuffix))) throw error;
          recoveryPath = databaseFilePath + preRestoreSuffix;
        }
        await verifyEncryptedVaultFile(recoveryPath, key).catch(() => {
          throw error;
        });
        beforeVaultCommit();
        await fs.copyFile(recoveryPath, databaseFilePath);
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
    assertVaultOperationActive();
    if (!sessionKey) {
      throw createPublicError("Vault is locked.");
    }
  }

  function startSession(key, now) {
    bulkUndo = null;
    assertVaultOperationActive();
    replaceSessionKey(key);
    operationEpoch++;
    const operation = currentVaultOperation();
    if (operation?.owner === owner) operation.epoch = operationEpoch;
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

  async function applyBulkChange(operation, choice) {
    let receipt;
    const result = await operation(databaseFilePath, currentKey(), choice, session.id, value => { receipt = value; });
    assertVaultOperationActive();
    bulkUndo = receipt ? { ...receipt, token: crypto.randomUUID(), sessionId: session.id } : null;
    return { ...result, undoToken: bulkUndo?.token || null };
  }

  async function undoBulkChange(token) {
    if (typeof token !== "string" || !bulkUndo || bulkUndo.token !== token || bulkUndo.sessionId !== session.id) {
      throw createPublicError("Undo is no longer available. Only the latest bulk change in this unlocked session can be undone.");
    }
    const result = await undoBulkCredentialChange(databaseFilePath, currentKey(), bulkUndo);
    assertVaultOperationActive();
    bulkUndo = null;
    return result;
  }

  const operations = {
    createVault,
    getDashboardData,
    getState,
    lockVault,
    unlockVault,
    getAllCredentials,
    getAllCredentialsForExport,
    getCredential,
    getCredentialDetails: id => getCredentialDetails(databaseFilePath, currentKey(), id),
    createCredential,
    createBrowserCredential,
    updateBrowserPassword: (id, password) => { ensureUnlocked(); return updateBrowserPassword(databaseFilePath, currentKey(), Number(id), password); },
    getActivityHistory: options => { ensureUnlocked(); return getActivityHistory(databaseFilePath, currentKey(), options); },
    purgeActivityHistory: () => { ensureUnlocked(); return purgeActivityHistory(databaseFilePath, currentKey()); },
    editCredential,
    previewCredentialMove: choice => previewCredentialMove(databaseFilePath, currentKey(), choice, session.id),
    moveCredentialsToGroup: choice => applyBulkChange(moveCredentialsToGroup, choice),
    previewCredentialCategory: choice => previewCredentialCategory(databaseFilePath, currentKey(), choice, session.id),
    changeCredentialCategory: choice => applyBulkChange(changeCredentialCategory, choice),
    undoBulkChange,
    previewCredentialFavorites: choice => previewCredentialFavorites(databaseFilePath, currentKey(), choice, session.id),
    changeCredentialFavorites: choice => applyBulkChange(changeCredentialFavorites, choice),
    getPasswordHistory,
    checkVaultHealth,
    getDuplicateReview: () => reviewDuplicates(),
    resolveDuplicateReview: choice => reviewDuplicates(choice === undefined ? null : choice),
    removeCredential,
    getDeletedCredentials: () => manageTrash("list"),
    restoreDeletedCredential: id => manageTrash("restore", id),
    permanentlyDeleteCredential: (id, confirmed) => manageTrash("delete", id, confirmed),
    purgeDeletedCredentials: () => manageTrash("purge"),
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
    inspectStorage: () => inspectEncryptedVault(databaseFilePath, currentKey()),
    changeMasterPassword,
    setPasswordHint,
    createRecoveryKey,
    resetWithRecoveryKey
  };
  const publicWhileLocked = new Set(["createVault", "unlockVault", "restoreEncryptedBackup", "resetWithRecoveryKey"]);
  for (const [name, operation] of Object.entries(operations)) {
    if (name !== "getState" && name !== "lockVault") operations[name] = serialize(operation, !publicWhileLocked.has(name));
  }
  operations.getOperationEpoch = () => operationEpoch;
  operations.isUnlocked = () => Boolean(sessionKey);
  return operations;
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

// ─── Data-key wrapping and recovery key helpers ──────────────────────────────

function wrapBytes(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encrypted.toString("base64")
  };
}

function unwrapBytes(payload, key) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return trackVaultBuffer(Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]));
  } catch {
    throw createPublicError("Vault could not be decrypted with this master password.");
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_KEY_BYTES = 20; // 160 bits -> 32 base32 characters

function encodeBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of text) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// A random 160-bit key shown as XXXX-XXXX-... (8 groups of 4).
function generateRecoveryKey() {
  const bytes = trackVaultBuffer(crypto.randomBytes(RECOVERY_KEY_BYTES));
  return { bytes, text: encodeBase32(bytes).match(/.{4}/g).join("-") };
}

// Accepts the key with or without dashes/spaces and in any letter case.
// Returns the raw bytes, or null if it is not a well-formed recovery key.
function parseRecoveryKey(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\s-]+/g, "").toUpperCase();
  if (cleaned.length !== (RECOVERY_KEY_BYTES * 8) / 5) return null;
  if (![...cleaned].every((char) => BASE32_ALPHABET.includes(char))) return null;
  return trackVaultBuffer(decodeBase32(cleaned));
}

// The recovery key is already high-entropy random data, so a fast KDF is
// enough here (unlike the human-chosen master password, which uses scrypt).
function deriveRecoveryWrapKey(recoveryBytes, salt) {
  return trackVaultBuffer(Buffer.from(
    crypto.hkdfSync("sha256", recoveryBytes, salt, "secure-login-vault-recovery-v1", 32)
  ));
}

const MAX_HINT_LENGTH = 100;

// Cleans a password hint and refuses anything that would hand over the password.
// Returns "" for no hint.
function normalizePasswordHint(value, masterPassword) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw createPublicError("Password hint is not valid.");

  const hint = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!hint) return "";

  if (hint.length > MAX_HINT_LENGTH) {
    throw createPublicError(`Password hint must be ${MAX_HINT_LENGTH} characters or fewer.`);
  }
  if (masterPassword && hint.toLowerCase().includes(masterPassword.toLowerCase())) {
    throw createPublicError("Password hint must not contain your master password.");
  }

  return hint;
}

async function deriveVaultKey(password, salt) {
  return trackVaultBuffer(await scryptAsync(password, salt, 32, SCRYPT_OPTIONS));
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

    try { return JSON.parse(decrypted.toString("utf8")); }
    finally { decrypted.fill(0); }
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
      isValidKeyWrap(record.keyWrap) &&
      (!record.storage ||
        (record.storage.type === "encrypted-sqlite" &&
          record.storage.fileName === DATABASE_FILE_NAME))
  );
}

function isValidWrappedKey(value) {
  return Boolean(
    value &&
      typeof value.iv === "string" &&
      typeof value.tag === "string" &&
      typeof value.ciphertext === "string"
  );
}

function isValidKeyWrap(keyWrap) {
  if (keyWrap === undefined) return true;
  return Boolean(
    keyWrap &&
      isValidWrappedKey(keyWrap.dek) &&
      (keyWrap.recovery === undefined ||
        (typeof keyWrap.recovery.salt === "string" && isValidWrappedKey(keyWrap.recovery.dek)))
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

function createSessionChangedError() {
  const error = createPublicError("Vault is locked or its session changed. Try again after unlocking.");
  error.code = "VAULT_SESSION_CHANGED";
  return error;
}

function createPublicError(message) {
  const error = new Error(message);
  error.isPublic = true;
  return error;
}

module.exports = {
  createVaultStore
};
