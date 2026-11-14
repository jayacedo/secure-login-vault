const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const initSqlJs = require("sql.js");
const { writeJsonAtomic } = require("./fsUtils");
const { buildVaultHealth } = require("./vaultHealth");
const trash = require("./credentialTrash");
const activity = require("./activityHistory");
const { collectDuplicateGroups, describeDuplicateGroup } = require("./duplicateReview");

let sqlitePromise;

function loadSqlite() {
  if (!sqlitePromise) {
    sqlitePromise = initSqlJs({
      locateFile: (fileName) => path.join(path.dirname(require.resolve("sql.js")), fileName)
    });
  }

  return sqlitePromise;
}

async function createEncryptedVaultFile(filePath, key, createdAt) {
  const databaseBytes = await createInitialDatabase(createdAt);
  let encryptedDatabase;
  try { encryptedDatabase = encryptBuffer(databaseBytes, key); }
  finally { databaseBytes.fill(0); }
  const payload = {
    format: "secure-login-vault-encrypted-sqlite",
    version: 1,
    createdAt,
    updatedAt: createdAt,
    sqlite: {
      userVersion: 1
    },
    encryption: {
      algorithm: "aes-256-gcm",
      ...encryptedDatabase
    }
  };

  await writeJsonAtomic(filePath, payload);
}

async function verifyEncryptedVaultFile(filePath, key) {
  try {
    await fs.access(filePath);
  } catch {
    throw createPublicError("Encrypted vault database is missing.");
  }

  const payload = JSON.parse(await fs.readFile(filePath, "utf8"));

  return verifyEncryptedVaultPayload(payload, key);
}

async function verifyEncryptedVaultPayload(payload, key) {

  if (!isValidEncryptedDatabase(payload)) {
    throw createPublicError("Encrypted vault database is invalid.");
  }

  const databaseBytes = decryptBuffer(payload.encryption, key);
  let db;
  try {
    const SQL = await loadSqlite();
    db = new SQL.Database(databaseBytes);
    const result = db.exec("SELECT value FROM vault_meta WHERE key = 'schema_version' LIMIT 1;");
    const schemaVersion = result[0] && result[0].values[0] && result[0].values[0][0];

    if (schemaVersion !== "1") {
      throw createPublicError("Vault database schema is not recognized.");
    }
  } finally {
    try { db?.close(); } finally { databaseBytes.fill(0); }
  }

  return true;
}

async function inspectEncryptedVault(filePath, key) {
  return withDecryptedDatabase(filePath, key, db => {
    const integrity = db.exec("PRAGMA integrity_check;");
    if (integrity.length !== 1 || integrity[0].values.length !== 1 || integrity[0].values[0][0] !== "ok") {
      throw createPublicError("The restored backup failed the database integrity check.");
    }
    if (db.exec("PRAGMA foreign_key_check;").some(result => result.values.length)) {
      throw createPublicError("The restored backup contains broken database references.");
    }
    // Preparing these queries also checks that essential application fields exist.
    db.exec("SELECT id, website_name, website_url, username, password, email, notes, tags, qr_code FROM credentials LIMIT 0;");
    db.exec("SELECT id, name, admin_password, hosting_password, ftp_password, db_password, qr_code FROM clients LIMIT 0;");
    const count = table => Number(queryOne(db, `SELECT COUNT(*) AS total FROM ${table}`).total);
    return { credentials: count("credentials"), clients: count("clients"),
      deletedCredentials: count("credential_trash"), historyEntries: count("credential_activity") };
  });
}

async function readDashboardData(filePath, key) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const activeGroup = getActiveGroupFilterValue(db);
    const groupClause = activeGroup ? `WHERE cr.group_name = @activeGroup COLLATE NOCASE` : "";
    const groupParams = activeGroup ? { "@activeGroup": activeGroup } : {};

    const categoryRows = queryAll(
      db,
      `
        SELECT
          c.name,
          COUNT(cr.id) AS credential_count
        FROM categories c
        LEFT JOIN credentials cr ON cr.category = c.name ${activeGroup ? "AND cr.group_name = @activeGroup COLLATE NOCASE" : ""}
        GROUP BY c.id, c.name
        ORDER BY c.name COLLATE NOCASE;
      `,
      groupParams
    );
    const totals = queryOne(
      db,
      `
        SELECT
          COUNT(*) AS total_count,
          COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) AS favorite_count
        FROM credentials cr
        ${groupClause};
      `,
      groupParams
    );
    const credentials = queryAll(
      db,
      `
        SELECT
          id,
          website_name,
          website_url,
          category,
          username,
          email,
          favorite,
          group_name,
          CASE WHEN COALESCE(qr_code, '') <> '' THEN 1 ELSE 0 END AS has_qr_code,
          created_at,
          updated_at
        FROM credentials cr
        ${groupClause}
        ORDER BY favorite DESC, updated_at DESC, website_name COLLATE NOCASE
        LIMIT 100;
      `,
      groupParams
    );

    return {
      summary: {
        totalCredentials: Number(totals.total_count || 0),
        favoriteCredentials: Number(totals.favorite_count || 0),
        categories: categoryRows.length
      },
      categories: [
        {
          name: "All Items",
          count: Number(totals.total_count || 0),
          type: "all"
        },
        {
          name: "Favorites",
          count: Number(totals.favorite_count || 0),
          type: "favorites"
        },
        ...categoryRows.map((row) => ({
          name: row.name,
          count: Number(row.credential_count || 0),
          type: "category"
        }))
      ],
      credentials: credentials.map((row) => ({
        id: row.id,
        websiteName: row.website_name,
        websiteUrl: row.website_url || "",
        category: row.category || "Other",
        username: row.username || "",
        email: row.email || "",
        favorite: row.favorite === 1,
        groupName: row.group_name || "",
        hasQrCode: row.has_qr_code === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      activeGroup
    };
  });
}

// ─── Phase 5: Credential CRUD ────────────────────────────────────────────────

async function getCredentials(filePath, key) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const activeGroup = getActiveGroupFilterValue(db);
    let sql = `SELECT id, website_name, website_url, category, username, password,
              email, notes, tags, favorite, group_name, created_at, updated_at,
              CASE WHEN COALESCE(qr_code, '') <> '' THEN 1 ELSE 0 END AS has_qr_code
       FROM credentials`;
    const params = [];
    if (activeGroup) {
      sql += ` WHERE group_name = ? COLLATE NOCASE`;
      params.push(activeGroup);
    }
    sql += ` ORDER BY favorite DESC, updated_at DESC, website_name COLLATE NOCASE`;
    return queryAll(db, sql, params).map(normalizeCredential);
  });
}

// Same as getCredentials, but also includes qr_code and — unlike every other
// read path in this file — ignores the active-group lock. That lock exists
// to hide other groups' credentials from casual browsing/screen-sharing; an
// explicit "Export" action is a deliberate full-vault data-portability step,
// so silently dropping locked-out groups from the file would be a surprising
// way to lose data rather than a privacy feature doing its job.
async function getCredentialsForExport(filePath, key) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const sql = `SELECT id, website_name, website_url, category, username, password,
              email, notes, tags, favorite, group_name, qr_code, created_at, updated_at
       FROM credentials
       ORDER BY favorite DESC, updated_at DESC, website_name COLLATE NOCASE`;
    return queryAll(db, sql, []).map(normalizeCredential);
  });
}

async function getCredentialById(filePath, key, id) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const row = queryOne(db, `SELECT * FROM credentials WHERE id = ?`, [id]);
    if (!row || !row.id) throw createPublicError("Credential not found.");
    const activeGroup = getActiveGroupFilterValue(db);
    if (activeGroup && (row.group_name || "").toLowerCase() !== activeGroup.toLowerCase()) {
      throw createPublicError("Credential not found.");
    }
    return normalizeCredential(row);
  });
}

async function getCredentialPasswordHistory(filePath, key, id) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const row = queryOne(db, "SELECT id, group_name FROM credentials WHERE id = ?", [id]);
    const activeGroup = getActiveGroupFilterValue(db);
    if (!row.id || (activeGroup && (row.group_name || "").toLowerCase() !== activeGroup.toLowerCase())) {
      throw createPublicError("Credential not found.");
    }
    return queryAll(db,
      "SELECT id, password, replaced_at AS replacedAt FROM credential_password_history WHERE credential_id = ? ORDER BY id DESC LIMIT 10",
      [id]);
  });
}

async function getVaultHealth(filePath, key) {
  return withDecryptedDatabase(filePath, key, db => {
    const activeGroup = getActiveGroupFilterValue(db);
    const rows = queryAll(db,
      "SELECT id, website_name, username, group_name, password FROM credentials" +
      (activeGroup ? " WHERE group_name = ? COLLATE NOCASE" : ""), activeGroup ? [activeGroup] : []);
    try { return buildVaultHealth(rows, activeGroup); }
    finally { for (const row of rows) row.password = ""; }
  });
}

function duplicateSnapshot(db, key) {
  const activeGroup = getActiveGroupFilterValue(db);
  const rows = queryAll(db, "SELECT * FROM credentials" + (activeGroup ? " WHERE group_name = ? COLLATE NOCASE" : ""), activeGroup ? [activeGroup] : []);
  const groups = collectDuplicateGroups(rows);
  // A keyed revision binds the full rows and scope, including fields omitted
  // from the UI. It cannot be used as an offline password guessing fingerprint.
  const revision = group => crypto.createHmac("sha256", key).update(JSON.stringify([activeGroup, group.rows])).digest("hex");
  return { activeGroup, total: rows.length, groups, revision };
}

async function getDuplicateReview(filePath, key, guard = () => {}) {
  return withDecryptedDatabase(filePath, key, db => {
    guard();
    const snapshot = duplicateSnapshot(db, key);
    return { activeGroup: snapshot.activeGroup, total: snapshot.total,
      groups: snapshot.groups.map(group => describeDuplicateGroup(group, snapshot.revision(group))) };
  });
}

async function resolveDuplicateReview(filePath, key, choice, guard = () => {}) {
  return withDecryptedDatabaseWrite(filePath, key, db => {
    guard();
    if (!choice || choice.confirmed !== true || !Number.isSafeInteger(choice.keepId) || choice.keepId <= 0 || typeof choice.revision !== "string") {
      throw createPublicError("Choose a login to keep and confirm the review.");
    }
    const snapshot = duplicateSnapshot(db, key);
    const group = snapshot.groups.find(group => group.rows.some(row => row.id === choice.keepId));
    if (!group || snapshot.revision(group) !== choice.revision) throw createPublicError("These logins or the active group changed. Refresh the review before continuing.");
    const removed = trash.moveToTrash(db, group.rows.filter(row => row.id !== choice.keepId));
    return { keptId: choice.keepId, ...removed };
  });
}

async function addCredential(filePath, key, data, options = {}) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    activity.setContext(db, options.source);
    validateCredentialData(data);
    const now = new Date().toISOString();
    const activeGroup = getActiveGroupFilterValue(db);
    // When locked to a group, newly created credentials default into that
    // group so they don't silently fall outside the current lock and stay
    // invisible to the person who just created them.
    const explicitOrganization = Object.hasOwn(options, "expectedActiveGroup");
    if (explicitOrganization) {
      if (activeGroup !== options.expectedActiveGroup
        || queryOne(db, "SELECT name FROM categories WHERE name = ?", [data.category]).name !== data.category
        || (data.groupName && queryOne(db, "SELECT name FROM groups WHERE name = ?", [data.groupName]).name !== data.groupName)) {
        throw createPublicError("Groups or categories changed. Save the login again.");
      }
    }
    const groupName = explicitOrganization ? normalizeGroupValue(data.groupName) : normalizeGroupValue(data.groupName) || activeGroup || "";
    ensureGroupExists(db, groupName);
    const stmt = db.prepare(
      `INSERT INTO credentials
        (website_name, website_url, category, username, password, email, notes, tags, favorite, group_name, qr_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run([
      data.websiteName.trim(),
      (data.websiteUrl || "").trim(),
      data.category || "Other",
      (data.username || "").trim(),
      data.password,
      (data.email || "").trim(),
      (data.notes || "").trim(),
      normalizeTags(data.tags),
      data.favorite ? 1 : 0,
      groupName || null,
      data.qrCode || null,
      now,
      now
    ]);
    stmt.free();
    const result = queryOne(db, "SELECT last_insert_rowid() AS id");
    return { id: Number(result.id), createdAt: now };
  });
}

async function updateCredential(filePath, key, id, data) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    validateCredentialData(data);
    const existing = queryOne(db, "SELECT id FROM credentials WHERE id = ?", [id]);
    if (!existing || !existing.id) throw createPublicError("Credential not found.");
    const now = new Date().toISOString();
    ensureGroupExists(db, normalizeGroupValue(data.groupName));
    const stmt = db.prepare(
      `UPDATE credentials SET
        website_name = ?, website_url = ?, category = ?, username = ?,
        password = ?, email = ?, notes = ?, tags = ?, favorite = ?, group_name = ?, qr_code = ?, updated_at = ?
       WHERE id = ?`
    );
    stmt.run([
      data.websiteName.trim(),
      (data.websiteUrl || "").trim(),
      data.category || "Other",
      (data.username || "").trim(),
      data.password,
      (data.email || "").trim(),
      (data.notes || "").trim(),
      normalizeTags(data.tags),
      data.favorite ? 1 : 0,
      normalizeGroupValue(data.groupName) || null,
      data.qrCode || null,
      now,
      id
    ]);
    stmt.free();
    return { updatedAt: now };
  });
}

function credentialMoveSnapshot(db, key, choice, sessionId, kind = "group") {
  const category = kind === "category";
  const destination = category ? choice?.targetCategory : choice?.targetGroup;
  const ids = choice?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(ids).size !== ids.length || typeof destination !== "string" || destination.length > 200 || (category && !destination.trim())) {
    throw createPublicError(`Select between 1 and 500 credentials and choose a destination ${kind}.`);
  }
  const targetName = destination.trim();
  const target = targetName ? queryOne(db, category
    ? "SELECT id, name FROM categories WHERE name = ? COLLATE NOCASE"
    : "SELECT id, name FROM groups WHERE name = ? COLLATE NOCASE", [targetName]) : { id: null, name: "" };
  if (targetName && !target.id) throw createPublicError(`The destination ${kind} no longer exists. Review again.`);
  const activeGroup = getActiveGroupFilterValue(db);
  const rows = queryAll(db, `SELECT * FROM credentials WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
  if (rows.length !== ids.length || rows.some(row => activeGroup && (row.group_name || "").toLowerCase() !== activeGroup.toLowerCase())) {
    throw createPublicError("Some selected credentials are unavailable in the active group. Refresh the list and select again.");
  }
  // Bind the review to the selected records, destination, scope and unlock session.
  const revision = crypto.createHmac("sha256", key).update(JSON.stringify([kind, sessionId, activeGroup, target, rows])).digest("hex");
  return { rows, target, activeGroup, revision };
}

async function previewCredentialMove(filePath, key, choice, sessionId) {
  return withDecryptedDatabase(filePath, key, db => {
    const snapshot = credentialMoveSnapshot(db, key, choice, sessionId);
    return { revision: snapshot.revision, activeGroup: snapshot.activeGroup, targetGroup: snapshot.target.name,
      entries: snapshot.rows.map(row => ({ id: row.id, websiteName: row.website_name,
        username: row.username || row.email || "", groupName: row.group_name || "" })),
      unchanged: snapshot.rows.filter(row => (row.group_name || "").toLowerCase() === snapshot.target.name.toLowerCase()).length };
  });
}

async function moveCredentialsToGroup(filePath, key, choice, sessionId) {
  return withDecryptedDatabaseWrite(filePath, key, db => {
    if (choice?.confirmed !== true || typeof choice.revision !== "string" || !/^[a-f0-9]{64}$/.test(choice.revision)) {
      throw createPublicError("Review and confirm the selected credentials before moving them.");
    }
    const snapshot = credentialMoveSnapshot(db, key, choice, sessionId);
    if (snapshot.revision !== choice.revision) throw createPublicError("The selected credentials, group or vault session changed. Review the move again.");
    const now = new Date().toISOString();
    let moved = 0;
    for (const row of snapshot.rows) {
      if ((row.group_name || "").toLowerCase() === snapshot.target.name.toLowerCase()) continue;
      db.run("UPDATE credentials SET group_name = ?, updated_at = ? WHERE id = ?", [snapshot.target.name || null, now, row.id]);
      moved++;
    }
    return { moved, unchanged: snapshot.rows.length - moved, targetGroup: snapshot.target.name };
  });
}

async function previewCredentialCategory(filePath, key, choice, sessionId) {
  return withDecryptedDatabase(filePath, key, db => {
    const snapshot = credentialMoveSnapshot(db, key, choice, sessionId, "category");
    return { revision: snapshot.revision, activeGroup: snapshot.activeGroup, targetCategory: snapshot.target.name,
      entries: snapshot.rows.map(row => ({ id: row.id, websiteName: row.website_name,
        username: row.username || row.email || "", category: row.category || "" })),
      unchanged: snapshot.rows.filter(row => (row.category || "").toLowerCase() === snapshot.target.name.toLowerCase()).length };
  });
}

async function changeCredentialCategory(filePath, key, choice, sessionId) {
  return withDecryptedDatabaseWrite(filePath, key, db => {
    if (choice?.confirmed !== true || typeof choice.revision !== "string" || !/^[a-f0-9]{64}$/.test(choice.revision)) {
      throw createPublicError("Review and confirm the selected credentials before changing their category.");
    }
    const snapshot = credentialMoveSnapshot(db, key, choice, sessionId, "category");
    if (snapshot.revision !== choice.revision) throw createPublicError("The selected credentials, category or vault session changed. Review again.");
    const now = new Date().toISOString();
    let changed = 0;
    for (const row of snapshot.rows) {
      if ((row.category || "").toLowerCase() === snapshot.target.name.toLowerCase()) continue;
      db.run("UPDATE credentials SET category = ?, updated_at = ? WHERE id = ?", [snapshot.target.name, now, row.id]);
      changed++;
    }
    return { changed, unchanged: snapshot.rows.length - changed, targetCategory: snapshot.target.name };
  });
}

async function deleteCredential(filePath, key, id) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const existing = queryOne(db, "SELECT * FROM credentials WHERE id = ?", [id]);
    if (!existing || !existing.id) throw createPublicError("Credential not found.");
    const activeGroup = getActiveGroupFilterValue(db);
    if (activeGroup && (existing.group_name || "").toLowerCase() !== activeGroup.toLowerCase()) throw createPublicError("Credential not found.");
    return { ...trash.moveToTrash(db, [existing]), deleted: true };
  });
}

async function updateBrowserPassword(filePath, key, id, password) {
  return withDecryptedDatabaseWrite(filePath, key, db => {
    const entry = queryOne(db, "SELECT * FROM credentials WHERE id = ?", [id]);
    const group = getActiveGroupFilterValue(db);
    if (!entry.id || (group && (entry.group_name || "").toLowerCase() !== group.toLowerCase())) throw createPublicError("Credential not found.");
    validateCredentialData({ websiteName: entry.website_name, password });
    activity.setContext(db, "browser");
    db.run("UPDATE credentials SET password = ?, updated_at = ? WHERE id = ?", [password, new Date().toISOString(), id]);
    return { updated: true };
  });
}

async function getActivityHistory(filePath, key, options) {
  return withDecryptedDatabase(filePath, key, db => activity.list(db, getActiveGroupFilterValue(db), options));
}

async function purgeActivityHistory(filePath, key) {
  const expired = await withDecryptedDatabase(filePath, key, db => activity.hasExpired(db));
  if (!expired) return { cleaned: false };
  return withDecryptedDatabaseWrite(filePath, key, () => ({ cleaned: true }));
}

async function manageCredentialTrash(filePath, key, action, id, confirmed, guard = () => {}) {
  if (action === "list") return withDecryptedDatabase(filePath, key, db => { guard(); return trash.listTrash(db, getActiveGroupFilterValue(db)); });
  if (action === "purge") {
    const expired = await withDecryptedDatabase(filePath, key, db => {
      guard();
      return queryOne(db, "SELECT id FROM credential_trash WHERE expires_at <= ? LIMIT 1", [new Date(Date.now()).toISOString()]).id;
    });
    if (!expired) return { cleaned: false };
  }
  return withDecryptedDatabaseWrite(filePath, key, db => {
    guard();
    const group = getActiveGroupFilterValue(db);
    if (action === "restore") return trash.restoreTrash(db, id, group);
    if (action === "delete") return trash.deleteTrash(db, id, group, confirmed);
    if (action === "purge") return { cleaned: true };
    throw createPublicError("Unknown Trash action.");
  });
}

// Backs the "Replace" import mode: deletes every credential belonging to the
// given group name(s) (an empty string means "no group") before the import's
// rows are inserted, so re-importing the same group repeatedly doesn't pile
// up duplicates. Deliberately ignores the active-group lock — same reasoning
// as getCredentialsForExport, this is an explicit data-management action, not
// casual browsing the lock is meant to restrict. Any group NOT present in
// groupNames is left completely untouched.
async function deleteCredentialsByGroups(filePath, key, groupNames) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const names = Array.from(new Set((groupNames || []).map((g) => (g || "").trim())));
    const namedGroups = names.filter((g) => g !== "");
    const includeUnassigned = names.includes("");

    const conditions = [];
    const params = [];
    if (namedGroups.length > 0) {
      conditions.push(`group_name COLLATE NOCASE IN (${namedGroups.map(() => "?").join(", ")})`);
      params.push(...namedGroups);
    }
    if (includeUnassigned) {
      conditions.push(`(group_name IS NULL OR group_name = '')`);
    }
    if (conditions.length === 0) {
      return { deleted: 0 };
    }

    const whereClause = conditions.join(" OR ");
    return trash.moveToTrash(db, queryAll(db, `SELECT * FROM credentials WHERE ${whereClause}`, params));
  });
}

async function toggleFavorite(filePath, key, id) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const row = queryOne(db, "SELECT favorite FROM credentials WHERE id = ?", [id]);
    if (!row || row.favorite === undefined) throw createPublicError("Credential not found.");
    const newValue = row.favorite === 1 ? 0 : 1;
    const stmt = db.prepare("UPDATE credentials SET favorite = ?, updated_at = ? WHERE id = ?");
    stmt.run([newValue, new Date().toISOString(), id]);
    stmt.free();
    return { favorite: newValue === 1 };
  });
}

// ─── Client Vault CRUD ────────────────────────────────────────────────────────
//
// A "client" is a WordPress developer's customer record — WP admin, hosting,
// FTP/SFTP, database, and domain/SSL details grouped under one entity, plus
// notes. It is intentionally independent from "groups" above (see the rename
// note in ensureSchemaUpgrades) — the two are unrelated concepts.

const CLIENT_COLUMNS = "id, name, domain, category, favorite, " +
  "admin_url, admin_username, admin_password, " +
  "hosting_provider, hosting_url, hosting_username, hosting_password, " +
  "ftp_host, ftp_port, ftp_username, ftp_password, " +
  "db_host, db_name, db_username, db_password, phpmyadmin_url, " +
  "registrar, domain_expiry, ssl_expiry, notes, created_at, updated_at";

// Columns written by add/update, in a fixed order shared with clientDataToParams
// below — kept as a list (rather than hand-repeating 24 "?" placeholders) so the
// column list and its values can never silently drift out of sync.
const CLIENT_WRITE_COLUMNS = [
  "name", "domain", "category", "favorite",
  "admin_url", "admin_username", "admin_password",
  "hosting_provider", "hosting_url", "hosting_username", "hosting_password",
  "ftp_host", "ftp_port", "ftp_username", "ftp_password",
  "db_host", "db_name", "db_username", "db_password", "phpmyadmin_url",
  "registrar", "domain_expiry", "ssl_expiry", "notes", "qr_code"
];

function clientDataToParams(data) {
  return [
    data.name.trim(),
    (data.domain || "").trim(),
    (data.category || "").trim(),
    data.favorite ? 1 : 0,
    (data.adminUrl || "").trim(),
    (data.adminUsername || "").trim(),
    data.adminPassword || "",
    (data.hostingProvider || "").trim(),
    (data.hostingUrl || "").trim(),
    (data.hostingUsername || "").trim(),
    data.hostingPassword || "",
    (data.ftpHost || "").trim(),
    (data.ftpPort || "").trim(),
    (data.ftpUsername || "").trim(),
    data.ftpPassword || "",
    (data.dbHost || "").trim(),
    (data.dbName || "").trim(),
    (data.dbUsername || "").trim(),
    data.dbPassword || "",
    (data.phpMyAdminUrl || "").trim(),
    (data.registrar || "").trim(),
    (data.domainExpiry || "").trim(),
    (data.sslExpiry || "").trim(),
    (data.notes || "").trim(),
    data.qrCode || null
  ];
}

function normalizeClient(row) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain || "",
    category: row.category || "",
    favorite: row.favorite === 1,
    adminUrl: row.admin_url || "",
    adminUsername: row.admin_username || "",
    adminPassword: row.admin_password || "",
    hostingProvider: row.hosting_provider || "",
    hostingUrl: row.hosting_url || "",
    hostingUsername: row.hosting_username || "",
    hostingPassword: row.hosting_password || "",
    ftpHost: row.ftp_host || "",
    ftpPort: row.ftp_port || "",
    ftpUsername: row.ftp_username || "",
    ftpPassword: row.ftp_password || "",
    dbHost: row.db_host || "",
    dbName: row.db_name || "",
    dbUsername: row.db_username || "",
    dbPassword: row.db_password || "",
    phpMyAdminUrl: row.phpmyadmin_url || "",
    registrar: row.registrar || "",
    domainExpiry: row.domain_expiry || "",
    sslExpiry: row.ssl_expiry || "",
    notes: row.notes || "",
    qrCode: row.qr_code || "",
    hasQrCode: row.has_qr_code === 1 || Boolean(row.qr_code),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateClientData(data) {
  if (!data.name || !data.name.trim()) {
    throw createPublicError("Client name is required.");
  }
}

async function getClients(filePath, key) {
  return withDecryptedDatabase(filePath, key, (db) => {
    return queryAll(
      db,
      `SELECT ${CLIENT_COLUMNS}, CASE WHEN COALESCE(qr_code, '') <> '' THEN 1 ELSE 0 END AS has_qr_code
       FROM clients ORDER BY favorite DESC, updated_at DESC, name COLLATE NOCASE`
    ).map(normalizeClient);
  });
}

async function getClientById(filePath, key, id) {
  return withDecryptedDatabase(filePath, key, (db) => {
    // Includes qr_code, unlike the list/search queries above/below — the QR
    // image is only needed for editing or an explicit Generate 2FA request,
    // not when pulling every client into the grid.
    const row = queryOne(db, `SELECT ${CLIENT_COLUMNS}, qr_code FROM clients WHERE id = ?`, [id]);
    if (!row || !row.id) throw createPublicError("Client not found.");
    return normalizeClient(row);
  });
}

async function addClient(filePath, key, data) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    validateClientData(data);
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO clients (${CLIENT_WRITE_COLUMNS.join(", ")}, created_at, updated_at)
       VALUES (${CLIENT_WRITE_COLUMNS.map(() => "?").join(", ")}, ?, ?)`
    );
    stmt.run([...clientDataToParams(data), now, now]);
    stmt.free();
    const result = queryOne(db, "SELECT last_insert_rowid() AS id");
    return { id: Number(result.id), createdAt: now };
  });
}

async function updateClient(filePath, key, id, data) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    validateClientData(data);
    const existing = queryOne(db, "SELECT id FROM clients WHERE id = ?", [id]);
    if (!existing || !existing.id) throw createPublicError("Client not found.");
    const now = new Date().toISOString();
    const stmt = db.prepare(
      `UPDATE clients SET ${CLIENT_WRITE_COLUMNS.map((c) => `${c} = ?`).join(", ")}, updated_at = ?
       WHERE id = ?`
    );
    stmt.run([...clientDataToParams(data), now, id]);
    stmt.free();
    return { updatedAt: now };
  });
}

async function deleteClient(filePath, key, id) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const existing = queryOne(db, "SELECT id FROM clients WHERE id = ?", [id]);
    if (!existing || !existing.id) throw createPublicError("Client not found.");
    const stmt = db.prepare("DELETE FROM clients WHERE id = ?");
    stmt.run([id]);
    stmt.free();
    return { deleted: true };
  });
}

async function toggleClientFavorite(filePath, key, id) {
  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const row = queryOne(db, "SELECT favorite FROM clients WHERE id = ?", [id]);
    if (!row || row.favorite === undefined) throw createPublicError("Client not found.");
    const newValue = row.favorite === 1 ? 0 : 1;
    const stmt = db.prepare("UPDATE clients SET favorite = ?, updated_at = ? WHERE id = ?");
    stmt.run([newValue, new Date().toISOString(), id]);
    stmt.free();
    return { favorite: newValue === 1 };
  });
}

async function searchClients(filePath, key, { query = "", onlyFavorites = false } = {}) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const term = `%${query.trim()}%`;
    const hasQuery = query.trim().length > 0;

    let sql = `SELECT ${CLIENT_COLUMNS}, CASE WHEN COALESCE(qr_code, '') <> '' THEN 1 ELSE 0 END AS has_qr_code FROM clients WHERE 1=1`;
    const params = [];

    if (hasQuery) {
      sql += `
        AND (
          name LIKE ? COLLATE NOCASE OR
          domain LIKE ? COLLATE NOCASE OR
          hosting_provider LIKE ? COLLATE NOCASE
        )
      `;
      params.push(term, term, term);
    }

    if (onlyFavorites) {
      sql += ` AND favorite = 1`;
    }

    sql += ` ORDER BY favorite DESC, updated_at DESC, name COLLATE NOCASE`;

    return queryAll(db, sql, params).map(normalizeClient);
  });
}

async function getCategories(filePath, key) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const builtIn = queryAll(
      db,
      "SELECT name FROM categories ORDER BY name COLLATE NOCASE"
    ).map((r) => r.name);
    const custom = queryAll(
      db,
      `SELECT DISTINCT category AS name FROM credentials
       WHERE category IS NOT NULL AND category != ''`
    )
      .map((r) => r.name)
      .filter((n) => !builtIn.includes(n));
    return [...builtIn, ...custom];
  });
}

// ─── Category management: add / rename / delete ──────────────────────────────

async function getCategoryUsage(filePath, key) {
  // Returns every managed category (from the categories table) along with
  // how many credentials currently reference it, so the renderer can decide
  // whether a delete needs a reassignment step.
  return withDecryptedDatabase(filePath, key, (db) => {
    const rows = queryAll(
      db,
      `
        SELECT c.id, c.name, COUNT(cr.id) AS credential_count
        FROM categories c
        LEFT JOIN credentials cr ON cr.category = c.name COLLATE NOCASE
        GROUP BY c.id, c.name
        ORDER BY c.name COLLATE NOCASE;
      `
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      credentialCount: Number(row.credential_count || 0)
    }));
  });
}

async function addCategory(filePath, key, name) {
  const trimmed = normalizeCategoryName(name);

  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const existing = queryOne(
      db,
      "SELECT id FROM categories WHERE name = ? COLLATE NOCASE",
      [trimmed]
    );
    if (existing.id !== undefined) {
      throw createPublicError(`Category "${trimmed}" already exists.`);
    }

    const stmt = db.prepare("INSERT INTO categories (name, created_at) VALUES (?, ?);");
    stmt.run([trimmed, new Date().toISOString()]);
    stmt.free();

    return { name: trimmed };
  });
}

async function renameCategory(filePath, key, currentName, newName) {
  const from = normalizeCategoryName(currentName);
  const to = normalizeCategoryName(newName);

  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const row = queryOne(db, "SELECT id, name FROM categories WHERE name = ? COLLATE NOCASE", [from]);
    if (row.id === undefined) {
      throw createPublicError(`Category "${from}" was not found.`);
    }

    if (to.toLowerCase() !== from.toLowerCase()) {
      const clash = queryOne(
        db,
        "SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id != ?",
        [to, row.id]
      );
      if (clash.id !== undefined) {
        throw createPublicError(`Category "${to}" already exists.`);
      }
    }

    const updateCategory = db.prepare("UPDATE categories SET name = ? WHERE id = ?;");
    updateCategory.run([to, row.id]);
    updateCategory.free();

    // Cascade the rename onto every credential currently filed under the old name.
    const updateCredentials = db.prepare(
      "UPDATE credentials SET category = ?, updated_at = ? WHERE category = ? COLLATE NOCASE;"
    );
    updateCredentials.run([to, new Date().toISOString(), row.name]);
    updateCredentials.free();

    return { name: to };
  });
}

async function deleteCategory(filePath, key, name, reassignToName) {
  const target = normalizeCategoryName(name);

  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const row = queryOne(db, "SELECT id, name FROM categories WHERE name = ? COLLATE NOCASE", [target]);
    if (row.id === undefined) {
      throw createPublicError(`Category "${target}" was not found.`);
    }

    const remainingCount = queryOne(db, "SELECT COUNT(*) AS total FROM categories").total;
    if (Number(remainingCount) <= 1) {
      throw createPublicError("At least one category must remain.");
    }

    const usage = queryOne(
      db,
      "SELECT COUNT(*) AS total FROM credentials WHERE category = ? COLLATE NOCASE",
      [row.name]
    );
    const inUse = Number(usage.total || 0) > 0;

    if (inUse) {
      if (!reassignToName) {
        throw createPublicError(
          `"${row.name}" is used by ${usage.total} credential${usage.total === 1 ? "" : "s"}. Choose a category to reassign them to.`
        );
      }

      const reassignTo = normalizeCategoryName(reassignToName);
      if (reassignTo.toLowerCase() === row.name.toLowerCase()) {
        throw createPublicError("Choose a different category to reassign to.");
      }

      const reassignRow = queryOne(
        db,
        "SELECT id, name FROM categories WHERE name = ? COLLATE NOCASE",
        [reassignTo]
      );
      if (reassignRow.id === undefined) {
        throw createPublicError(`Category "${reassignTo}" was not found.`);
      }

      const moveCredentials = db.prepare(
        "UPDATE credentials SET category = ?, updated_at = ? WHERE category = ? COLLATE NOCASE;"
      );
      moveCredentials.run([reassignRow.name, new Date().toISOString(), row.name]);
      moveCredentials.free();
    }

    const deleteStmt = db.prepare("DELETE FROM categories WHERE id = ?;");
    deleteStmt.run([row.id]);
    deleteStmt.free();

    return { deleted: true, reassignedCount: inUse ? Number(usage.total || 0) : 0 };
  });
}

function normalizeCategoryName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw createPublicError("Category name cannot be empty.");
  }
  if (trimmed.length > 60) {
    throw createPublicError("Category name must be 60 characters or fewer.");
  }
  return trimmed;
}

// ─── Phase 6: Live Search ─────────────────────────────────────────────────────

async function searchCredentials(filePath, key, { query = "", onlyFavorites = false, category = null } = {}) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const term = `%${query.trim()}%`;
    const hasQuery = query.trim().length > 0;
    const hasCategory = category && category !== "all";
    const activeGroup = getActiveGroupFilterValue(db);

    let sql = `
      SELECT id, website_name, website_url, category, username, password,
             email, notes, tags, favorite, group_name, created_at, updated_at,
             CASE WHEN COALESCE(qr_code, '') <> '' THEN 1 ELSE 0 END AS has_qr_code
      FROM credentials
      WHERE 1=1
    `;
    const params = [];

    if (hasQuery) {
      sql += `
        AND (
          website_name LIKE ? COLLATE NOCASE OR
          website_url  LIKE ? COLLATE NOCASE OR
          username     LIKE ? COLLATE NOCASE OR
          email        LIKE ? COLLATE NOCASE OR
          notes        LIKE ? COLLATE NOCASE OR
          tags         LIKE ? COLLATE NOCASE OR
          category     LIKE ? COLLATE NOCASE
        )
      `;
      params.push(term, term, term, term, term, term, term);
    }

    if (onlyFavorites) {
      sql += ` AND favorite = 1`;
    }

    if (hasCategory) {
      sql += ` AND category = ?`;
      params.push(category);
    }

    if (activeGroup) {
      sql += ` AND group_name = ? COLLATE NOCASE`;
      params.push(activeGroup);
    }

    sql += ` ORDER BY favorite DESC, updated_at DESC, website_name COLLATE NOCASE`;

    return queryAll(db, sql, params).map(normalizeCredential);
  });
}

// ─── Group management: add / rename / delete / active lock ───────────────────
//
// Groups are a separate axis from categories — they answer "whose data is
// this" rather than "what kind of credential is this". When a group is
// "active" (locked), every read path in this file (dashboard, list, search,
// single-credential lookup) filters at the SQL level, so rows for other
// groups are never pulled out of the encrypted database into memory or
// rendered into the DOM in the first place.

async function getGroups(filePath, key) {
  return withDecryptedDatabase(filePath, key, (db) => {
    return queryAll(db, "SELECT name FROM groups ORDER BY name COLLATE NOCASE").map((r) => r.name);
  });
}

async function getGroupUsage(filePath, key) {
  return withDecryptedDatabase(filePath, key, (db) => {
    const rows = queryAll(
      db,
      `
        SELECT g.id, g.name, COUNT(cr.id) AS credential_count
        FROM groups g
        LEFT JOIN credentials cr ON cr.group_name = g.name COLLATE NOCASE
        GROUP BY g.id, g.name
        ORDER BY g.name COLLATE NOCASE;
      `
    );
    const activeGroup = getActiveGroupFilterValue(db);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      credentialCount: Number(row.credential_count || 0),
      isActive: activeGroup.toLowerCase() === String(row.name).toLowerCase()
    }));
  });
}

async function addGroup(filePath, key, name) {
  const trimmed = normalizeGroupName(name);

  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const existing = queryOne(db, "SELECT id FROM groups WHERE name = ? COLLATE NOCASE", [trimmed]);
    if (existing.id !== undefined) {
      throw createPublicError(`Group "${trimmed}" already exists.`);
    }

    const stmt = db.prepare("INSERT INTO groups (name, created_at) VALUES (?, ?);");
    stmt.run([trimmed, new Date().toISOString()]);
    stmt.free();

    return { name: trimmed };
  });
}

async function renameGroup(filePath, key, currentName, newName) {
  const from = normalizeGroupName(currentName);
  const to = normalizeGroupName(newName);

  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const row = queryOne(db, "SELECT id, name FROM groups WHERE name = ? COLLATE NOCASE", [from]);
    if (row.id === undefined) {
      throw createPublicError(`Group "${from}" was not found.`);
    }

    if (to.toLowerCase() !== from.toLowerCase()) {
      const clash = queryOne(db, "SELECT id FROM groups WHERE name = ? COLLATE NOCASE AND id != ?", [to, row.id]);
      if (clash.id !== undefined) {
        throw createPublicError(`Group "${to}" already exists.`);
      }
    }

    const updateGroup = db.prepare("UPDATE groups SET name = ? WHERE id = ?;");
    updateGroup.run([to, row.id]);
    updateGroup.free();

    const updateCredentials = db.prepare(
      "UPDATE credentials SET group_name = ?, updated_at = ? WHERE group_name = ? COLLATE NOCASE;"
    );
    updateCredentials.run([to, new Date().toISOString(), row.name]);
    updateCredentials.free();

    // Keep the active-group lock pointed at the renamed group instead of
    // silently dropping back to "All" (which would defeat the lock).
    const activeGroup = getActiveGroupFilterValue(db);
    if (activeGroup.toLowerCase() === row.name.toLowerCase()) {
      setActiveGroupValue(db, to);
    }

    return { name: to };
  });
}

async function deleteGroup(filePath, key, name) {
  const target = normalizeGroupName(name);

  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    const row = queryOne(db, "SELECT id, name FROM groups WHERE name = ? COLLATE NOCASE", [target]);
    if (row.id === undefined) {
      throw createPublicError(`Group "${target}" was not found.`);
    }

    const usage = queryOne(
      db,
      "SELECT COUNT(*) AS total FROM credentials WHERE group_name = ? COLLATE NOCASE",
      [row.name]
    );

    // Unlike categories, groups have no mandatory fallback — credentials
    // simply become unassigned (group_name = NULL) rather than requiring
    // a reassignment target.
    const clearCredentials = db.prepare(
      "UPDATE credentials SET group_name = NULL, updated_at = ? WHERE group_name = ? COLLATE NOCASE;"
    );
    clearCredentials.run([new Date().toISOString(), row.name]);
    clearCredentials.free();

    const deleteStmt = db.prepare("DELETE FROM groups WHERE id = ?;");
    deleteStmt.run([row.id]);
    deleteStmt.free();

    const activeGroup = getActiveGroupFilterValue(db);
    if (activeGroup.toLowerCase() === row.name.toLowerCase()) {
      setActiveGroupValue(db, "");
    }

    return { deleted: true, unassignedCount: Number(usage.total || 0) };
  });
}

async function getActiveGroup(filePath, key) {
  return withDecryptedDatabase(filePath, key, (db) => getActiveGroupFilterValue(db));
}

async function setActiveGroup(filePath, key, name) {
  const trimmed = typeof name === "string" ? name.trim() : "";

  return withDecryptedDatabaseWrite(filePath, key, (db) => {
    if (trimmed) {
      const row = queryOne(db, "SELECT id, name FROM groups WHERE name = ? COLLATE NOCASE", [trimmed]);
      if (row.id === undefined) {
        throw createPublicError(`Group "${trimmed}" was not found.`);
      }
      setActiveGroupValue(db, row.name);
      return { activeGroup: row.name };
    }

    setActiveGroupValue(db, "");
    return { activeGroup: "" };
  });
}

function getActiveGroupFilterValue(db) {
  const row = queryOne(db, "SELECT value FROM vault_meta WHERE key = 'active_group'");
  return typeof row.value === "string" ? row.value.trim() : "";
}

function setActiveGroupValue(db, value) {
  const stmt = db.prepare(
    "INSERT INTO vault_meta (key, value) VALUES ('active_group', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
  );
  stmt.run([value || ""]);
  stmt.free();
}

function normalizeGroupName(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw createPublicError("Group name cannot be empty.");
  }
  if (trimmed.length > 60) {
    throw createPublicError("Group name must be 60 characters or fewer.");
  }
  return trimmed;
}

function normalizeGroupValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Creates the group if a credential is being tagged with a name that doesn't
// exist in the groups table yet — a no-op if it already does. Manually adding
// a credential can never hit the "doesn't exist" branch (the group dropdown
// there only ever offers real groups), but CSV/JSON import hands over
// arbitrary group name strings from another vault, and without this those
// names would tag the credential correctly while staying invisible in the
// Active Group dropdown and Manage Groups list until someone created them
// there by hand.
function ensureGroupExists(db, name) {
  const trimmed = normalizeGroupValue(name);
  if (!trimmed) return;
  const existing = queryOne(db, "SELECT id FROM groups WHERE name = ? COLLATE NOCASE", [trimmed]);
  if (existing.id === undefined) {
    const stmt = db.prepare("INSERT INTO groups (name, created_at) VALUES (?, ?);");
    stmt.run([trimmed, new Date().toISOString()]);
    stmt.free();
  }
}

// ─── Schema upgrades (applied in-memory on every database open) ──────────────
//
// There's no formal migration runner here — instead, every time the database
// is decrypted into memory (read or write path), we make sure newer tables/
// columns exist before any query touches them. CREATE TABLE/INDEX use
// IF NOT EXISTS and the column check is explicit, so this is safe to run on
// every open, including vaults that were created before this feature existed.
function ensureSchemaUpgrades(db) {
  db.run("PRAGMA secure_delete = ON");
  trash.ensureTrashSchema(db);
  // History and the password change commit together in the encrypted database.
  // Triggers cover desktop edits, browser updates and any future SQL update path.
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_password_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER NOT NULL,
      password TEXT NOT NULL,
      replaced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_password_history_credential ON credential_password_history (credential_id, id);
    CREATE TRIGGER IF NOT EXISTS credential_password_changed
    AFTER UPDATE OF password ON credentials
    WHEN OLD.password IS NOT NEW.password
    BEGIN
      INSERT INTO credential_password_history (credential_id, password, replaced_at)
        VALUES (OLD.id, OLD.password, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      DELETE FROM credential_password_history WHERE credential_id = OLD.id AND id NOT IN (
        SELECT id FROM credential_password_history WHERE credential_id = OLD.id ORDER BY id DESC LIMIT 10
      );
    END;
    CREATE TRIGGER IF NOT EXISTS credential_history_deleted
    AFTER DELETE ON credentials
    BEGIN
      DELETE FROM credential_password_history WHERE credential_id = OLD.id;
    END;
  `);
  const groupsTable = queryAll(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'groups'"
  );
  if (groupsTable.length === 0) {
    db.exec(`
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
  }

  const columns = queryAll(db, "PRAGMA table_info(credentials)");
  const hasClientGroupColumn = columns.some((c) => c.name === "client_group");
  if (!hasClientGroupColumn) {
    db.exec(`ALTER TABLE credentials ADD COLUMN client_group TEXT;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_credentials_client_group ON credentials (client_group);`);
  }

  // "client_group" was renamed to the neutral "group_name" once the vault
  // grew an unrelated "Client Vault" feature, to stop the two concepts from
  // sharing the word "client". Old vaults keep the original column (harmless,
  // unused going forward) — its values are copied into the new column once.
  const hasGroupNameColumn = columns.some((c) => c.name === "group_name");
  if (!hasGroupNameColumn) {
    db.exec(`ALTER TABLE credentials ADD COLUMN group_name TEXT;`);
    db.exec(`UPDATE credentials SET group_name = client_group WHERE client_group IS NOT NULL;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_credentials_group_name ON credentials (group_name);`);
  }

  const clientsTable = queryAll(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clients'"
  );
  if (clientsTable.length === 0) {
    db.exec(`
      CREATE TABLE clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        domain TEXT,
        category TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        admin_url TEXT,
        admin_username TEXT,
        admin_password TEXT,
        hosting_provider TEXT,
        hosting_url TEXT,
        hosting_username TEXT,
        hosting_password TEXT,
        ftp_host TEXT,
        ftp_port TEXT,
        ftp_username TEXT,
        ftp_password TEXT,
        db_host TEXT,
        db_name TEXT,
        db_username TEXT,
        db_password TEXT,
        phpmyadmin_url TEXT,
        registrar TEXT,
        domain_expiry TEXT,
        ssl_expiry TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_clients_name ON clients (name);
      CREATE INDEX idx_clients_favorite ON clients (favorite);
    `);
  }

  // 2FA QR code image (data URI) — stored as an opaque blob, never decoded/
  // parsed by storage. Explicit Generate code requests decode it in a worker.
  // Protected by the same whole-database envelope as
  // everything else, so no separate encryption is needed.
  const hasCredentialQrColumn = columns.some((c) => c.name === "qr_code");
  if (!hasCredentialQrColumn) {
    db.exec(`ALTER TABLE credentials ADD COLUMN qr_code TEXT;`);
  }

  const clientColumns = queryAll(db, "PRAGMA table_info(clients)");
  const hasClientQrColumn = clientColumns.some((c) => c.name === "qr_code");
  if (!hasClientQrColumn) {
    db.exec(`ALTER TABLE clients ADD COLUMN qr_code TEXT;`);
  }

  const metaRow = queryOne(db, "SELECT value FROM vault_meta WHERE key = 'active_group'");
  if (metaRow.value === undefined) {
    const insertMeta = db.prepare("INSERT OR IGNORE INTO vault_meta (key, value) VALUES ('active_group', '');");
    insertMeta.run([]);
    insertMeta.free();
  }
  activity.ensureSchema(db);
}

// ─── Write helper (decrypt → mutate → re-encrypt → save) ─────────────────────

const databaseWriteQueues = new Map();
function withDecryptedDatabaseWrite(filePath, key, operation) {
  // Concurrent browser/desktop edits must read the last committed password.
  const name = path.resolve(filePath);
  const previous = databaseWriteQueues.get(name) || Promise.resolve();
  const result = previous.then(() => performDatabaseWrite(filePath, key, operation));
  const settled = result.catch(() => {});
  databaseWriteQueues.set(name, settled);
  settled.then(() => { if (databaseWriteQueues.get(name) === settled) databaseWriteQueues.delete(name); });
  return result;
}

async function performDatabaseWrite(filePath, key, operation) {
  const raw = await fs.readFile(filePath, "utf8");
  const payload = JSON.parse(raw);

  if (!isValidEncryptedDatabase(payload)) {
    throw createPublicError("Encrypted vault database is invalid.");
  }

  const databaseBytes = decryptBuffer(payload.encryption, key);
  let db, updatedBytes;
  try {
    const SQL = await loadSqlite();
    db = new SQL.Database(databaseBytes);
    ensureSchemaUpgrades(db);
    trash.purgeTrash(db);
    activity.purge(db);
    const result = operation(db);
    updatedBytes = Buffer.from(db.export());
    const encryptedDatabase = encryptBuffer(updatedBytes, key);
    const updatedPayload = {
      ...payload,
      updatedAt: new Date().toISOString(),
      encryption: {
        algorithm: "aes-256-gcm",
        ...encryptedDatabase
      }
    };
    await writeJsonAtomic(filePath, updatedPayload);
    return result;
  } finally {
    try { db?.close(); } finally { databaseBytes.fill(0); updatedBytes?.fill(0); }
  }
}

// ─── Phase 10: Re-key the encrypted database with a new key ──────────────────

async function rekeyEncryptedVaultFile(filePath, oldKey, newKey) {
  const raw = await fs.readFile(filePath, "utf8");
  const payload = JSON.parse(raw);

  if (!isValidEncryptedDatabase(payload)) {
    throw createPublicError("Encrypted vault database is invalid.");
  }

  // Decrypt with the current (old) key
  const databaseBytes = decryptBuffer(payload.encryption, oldKey);

  // Re-encrypt with the new key
  let reEncrypted;
  try { reEncrypted = encryptBuffer(databaseBytes, newKey); }
  finally { databaseBytes.fill(0); }
  const updatedPayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
    encryption: {
      algorithm: "aes-256-gcm",
      ...reEncrypted
    }
  };

  await writeJsonAtomic(filePath, updatedPayload);
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function withDecryptedDatabase(filePath, key, operation) {
  const payload = JSON.parse(await fs.readFile(filePath, "utf8"));

  if (!isValidEncryptedDatabase(payload)) {
    throw createPublicError("Encrypted vault database is invalid.");
  }

  const databaseBytes = decryptBuffer(payload.encryption, key);
  let db;
  try {
    const SQL = await loadSqlite();
    db = new SQL.Database(databaseBytes);
    ensureSchemaUpgrades(db);
    return operation(db);
  } finally {
    try { db?.close(); } finally { databaseBytes.fill(0); }
  }
}

function normalizeCredential(row) {
  return {
    id: row.id,
    websiteName: row.website_name,
    websiteUrl: row.website_url || "",
    category: row.category || "Other",
    username: row.username || "",
    password: row.password || "",
    email: row.email || "",
    notes: row.notes || "",
    tags: row.tags || "",
    favorite: row.favorite === 1,
    groupName: row.group_name || "",
    qrCode: row.qr_code || "",
    hasQrCode: row.has_qr_code === 1 || Boolean(row.qr_code),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeTags(tags) {
  if (!tags) return "";
  if (Array.isArray(tags)) return tags.map((t) => t.trim()).filter(Boolean).join(",");
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .join(",");
}

function validateCredentialData(data) {
  if (!data.websiteName || !data.websiteName.trim()) {
    throw createPublicError("Website Name is required.");
  }
  if (!data.password) {
    throw createPublicError("Password is required.");
  }
}

async function createInitialDatabase(createdAt) {
  const SQL = await loadSqlite();
  const db = new SQL.Database();

  try {
    db.exec(`
      PRAGMA user_version = 1;

      CREATE TABLE vault_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        website_name TEXT NOT NULL,
        website_url TEXT,
        category TEXT,
        username TEXT,
        password TEXT NOT NULL,
        email TEXT,
        notes TEXT,
        tags TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        group_name TEXT,
        qr_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_credentials_website_name ON credentials (website_name);
      CREATE INDEX idx_credentials_username ON credentials (username);
      CREATE INDEX idx_credentials_category ON credentials (category);
      CREATE INDEX idx_credentials_favorite ON credentials (favorite);
      CREATE INDEX idx_credentials_group_name ON credentials (group_name);

      CREATE TABLE clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        domain TEXT,
        category TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        admin_url TEXT,
        admin_username TEXT,
        admin_password TEXT,
        hosting_provider TEXT,
        hosting_url TEXT,
        hosting_username TEXT,
        hosting_password TEXT,
        ftp_host TEXT,
        ftp_port TEXT,
        ftp_username TEXT,
        ftp_password TEXT,
        db_host TEXT,
        db_name TEXT,
        db_username TEXT,
        db_password TEXT,
        phpmyadmin_url TEXT,
        registrar TEXT,
        domain_expiry TEXT,
        ssl_expiry TEXT,
        notes TEXT,
        qr_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_clients_name ON clients (name);
      CREATE INDEX idx_clients_favorite ON clients (favorite);
    `);

    const meta = db.prepare("INSERT INTO vault_meta (key, value) VALUES (?, ?);");
    meta.run(["schema_version", "1"]);
    meta.run(["created_at", createdAt]);
    meta.run(["active_group", ""]);
    meta.free();

    const category = db.prepare("INSERT INTO categories (name, created_at) VALUES (?, ?);");
    for (const name of getDefaultCategories()) {
      category.run([name, createdAt]);
    }
    category.free();

    return Buffer.from(db.export());
  } finally {
    db.close();
  }
}

function getDefaultCategories() {
  return [
    "WordPress",
    "Hosting",
    "Domain",
    "Email",
    "FTP",
    "Database",
    "API",
    "Cloudflare",
    "Social Media",
    "Development",
    "Client Portal",
    "Other"
  ];
}

function encryptBuffer(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64")
  };
}

function decryptBuffer(payload, key) {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "base64")
    );

    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final()
    ]);
  } catch {
    throw createPublicError("Encrypted vault database could not be decrypted.");
  }
}

function queryAll(db, sql, params = []) {
  const statement = db.prepare(sql);

  try {
    statement.bind(params);
    const rows = [];

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }

    return rows;
  } finally {
    statement.free();
  }
}

function queryOne(db, sql, params = []) {
  return queryAll(db, sql, params)[0] || {};
}

function isValidEncryptedDatabase(payload) {
  return Boolean(
    payload &&
      payload.format === "secure-login-vault-encrypted-sqlite" &&
      payload.version === 1 &&
      payload.encryption &&
      payload.encryption.algorithm === "aes-256-gcm" &&
      typeof payload.encryption.iv === "string" &&
      typeof payload.encryption.tag === "string" &&
      typeof payload.encryption.ciphertext === "string"
  );
}

function createPublicError(message) {
  const error = new Error(message);
  error.isPublic = true;
  return error;
}

module.exports = {
  previewCredentialMove,
  moveCredentialsToGroup,
  previewCredentialCategory,
  changeCredentialCategory,
  createEncryptedVaultFile,
  readDashboardData,
  verifyEncryptedVaultFile,
  verifyEncryptedVaultPayload,
  inspectEncryptedVault,
  rekeyEncryptedVaultFile,
  getCredentials,
  getCredentialsForExport,
  getCredentialById,
  getCredentialPasswordHistory,
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
};
