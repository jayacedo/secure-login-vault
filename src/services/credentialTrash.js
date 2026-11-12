// All tables below live inside the existing encrypted SQLite vault.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COLUMNS = ["id", "website_name", "website_url", "category", "username", "password", "email", "notes", "tags", "favorite", "group_name", "qr_code", "created_at", "updated_at"];
function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try { stmt.bind(params); const result = []; while (stmt.step()) result.push(stmt.getAsObject()); return result; }
  finally { stmt.free(); }
}
function fail(message) { const error = new Error(message); error.isPublic = true; throw error; }
function ensureTrashSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS credential_trash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_name TEXT NOT NULL, username TEXT, group_name TEXT, category TEXT,
    deleted_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    credential_json TEXT NOT NULL, history_json TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_credential_trash_expiry ON credential_trash(expires_at)");
}
function purgeTrash(db, now = Date.now()) {
  db.run("DELETE FROM credential_trash WHERE expires_at <= ?", [new Date(now).toISOString()]);
  return db.getRowsModified();
}
function moveToTrash(db, entries) {
  const now = Date.now(), deletedAt = new Date(now).toISOString(), expiresAt = new Date(now + RETENTION_MS).toISOString();
  for (const entry of entries) {
    const history = rows(db, "SELECT password, replaced_at FROM credential_password_history WHERE credential_id = ? ORDER BY id ASC", [entry.id]);
    db.run(`INSERT INTO credential_trash (website_name, username, group_name, category, deleted_at, expires_at, credential_json, history_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [entry.website_name, entry.username, entry.group_name, entry.category, deletedAt, expiresAt, JSON.stringify(entry), JSON.stringify(history)]);
    db.run("DELETE FROM credentials WHERE id = ?", [entry.id]);
  }
  return { deleted: entries.length, expiresAt };
}
function listTrash(db, activeGroup) {
  return { activeGroup, retentionDays: 30, entries: rows(db,
    `SELECT id, website_name AS websiteName, username, group_name AS groupName, category,
       deleted_at AS deletedAt, expires_at AS expiresAt FROM credential_trash WHERE expires_at > ?` +
    (activeGroup ? " AND group_name = ? COLLATE NOCASE" : "") + " ORDER BY deleted_at DESC, id DESC",
    [new Date(Date.now()).toISOString(), ...(activeGroup ? [activeGroup] : [])]) };
}
function getTrashEntry(db, id, activeGroup) {
  if (!Number.isSafeInteger(id) || id <= 0) fail("Deleted login not found.");
  const entry = rows(db, "SELECT * FROM credential_trash WHERE id = ? AND expires_at > ?", [id, new Date(Date.now()).toISOString()])[0];
  if (!entry || (activeGroup && (entry.group_name || "").toLowerCase() !== activeGroup.toLowerCase())) fail("Deleted login not found or its 30 days have expired.");
  return entry;
}
function restoreTrash(db, id, activeGroup) {
  const entry = getTrashEntry(db, id, activeGroup);
  const credential = JSON.parse(entry.credential_json), history = JSON.parse(entry.history_json);
  if (rows(db, "SELECT id FROM credentials WHERE id = ?", [credential.id]).length) fail("This login already exists. Refresh Recently Deleted.");
  // Restore the original organization, recreating a removed group/category.
  const now = new Date(Date.now()).toISOString();
  for (const [table, name] of [["groups", credential.group_name], ["categories", credential.category]]) {
    if (name && !rows(db, `SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`, [name]).length) {
      db.run(`INSERT INTO ${table} (name, created_at) VALUES (?, ?)`, [name, now]);
    }
  }
  db.run(`INSERT INTO credentials (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`, COLUMNS.map(column => credential[column] ?? null));
  for (const item of history.slice(-10)) db.run("INSERT INTO credential_password_history (credential_id, password, replaced_at) VALUES (?, ?, ?)", [credential.id, item.password, item.replaced_at]);
  db.run("DELETE FROM credential_trash WHERE id = ?", [id]);
  return { restored: true, id: credential.id };
}
function deleteTrash(db, id, activeGroup, confirmed) {
  if (confirmed !== true) fail("Confirm permanent deletion first.");
  getTrashEntry(db, id, activeGroup);
  db.run("DELETE FROM credential_trash WHERE id = ?", [id]);
  return { deleted: true };
}
module.exports = { ensureTrashSchema, moveToTrash, listTrash, restoreTrash, deleteTrash, purgeTrash, RETENTION_MS };
