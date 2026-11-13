// Activity metadata lives only in the encrypted vault. Temporary triggers make
// events atomic with credential changes without changing old-version SQL writes.
const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 86400000;
const EVENTS = ["added", "updated", "password_updated", "deleted", "restored", "permanently_deleted"];
function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try { stmt.bind(params); const result = []; while (stmt.step()) result.push(stmt.getAsObject()); return result; }
  finally { stmt.free(); }
}
function cutoff() { return new Date(Date.now() - RETENTION_MS).toISOString(); }
function ensureSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS credential_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, credential_id INTEGER NOT NULL,
    website_name TEXT NOT NULL, group_name TEXT NOT NULL,
    event TEXT NOT NULL, source TEXT NOT NULL, occurred_at TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_activity_time ON credential_activity(occurred_at, id)");
  db.run("CREATE TEMP TABLE IF NOT EXISTS slv_activity_context (source TEXT, action TEXT)");
  db.run("INSERT INTO slv_activity_context SELECT 'desktop', '' WHERE NOT EXISTS (SELECT 1 FROM slv_activity_context)");
  const fields = ["website_name", "website_url", "category", "username", "password", "email", "notes", "tags", "favorite", "group_name", "qr_code"];
  for (const [operation, row, event, when] of [
    ["INSERT", "NEW", "CASE WHEN (SELECT action FROM slv_activity_context) = 'restored' THEN 'restored' ELSE 'added' END", ""],
    ["UPDATE", "NEW", "CASE WHEN OLD.password IS NOT NEW.password THEN 'password_updated' ELSE 'updated' END", "WHEN " + fields.map(field => `OLD.${field} IS NOT NEW.${field}`).join(" OR ")],
    ["DELETE", "OLD", "'deleted'", ""]
  ]) {
    db.run(`CREATE TEMP TRIGGER IF NOT EXISTS slv_activity_${operation.toLowerCase()} AFTER ${operation} ON main.credentials ${when}
      BEGIN INSERT INTO credential_activity (credential_id, website_name, group_name, event, source, occurred_at)
        VALUES (${row}.id, ${row}.website_name, COALESCE(${row}.group_name, ''), ${event},
          (SELECT source FROM slv_activity_context), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END`);
  }
}
function setContext(db, source = "desktop", action = "") {
  db.run("UPDATE slv_activity_context SET source = ?, action = ?", [source === "browser" ? "browser" : "desktop", action === "restored" ? action : ""]);
}
function recordPermanentDelete(db, entry) {
  const credential = JSON.parse(entry.credential_json);
  db.run("INSERT INTO credential_activity (credential_id, website_name, group_name, event, source, occurred_at) VALUES (?, ?, ?, 'permanently_deleted', 'desktop', ?)",
    [credential.id, entry.website_name, entry.group_name || "", new Date().toISOString()]);
}
function purge(db) { db.run("DELETE FROM credential_activity WHERE occurred_at <= ?", [cutoff()]); }
function hasExpired(db) { return rows(db, "SELECT id FROM credential_activity WHERE occurred_at <= ? LIMIT 1", [cutoff()]).length > 0; }
function list(db, activeGroup, options = {}) {
  const fail = () => { const error = new Error("Activity filters are not valid."); error.isPublic = true; throw error; };
  if (!options || typeof options !== "object" || Array.isArray(options)) fail();
  const { query = "", event = "", source = "", offset = 0 } = options;
  if (typeof query !== "string" || query.length > 200 || (event && !EVENTS.includes(event)) || !["", "desktop", "browser"].includes(source) || !Number.isSafeInteger(offset) || offset < 0) fail();
  const clauses = ["occurred_at > ?"], params = [cutoff()];
  if (activeGroup) { clauses.push("group_name = ? COLLATE NOCASE"); params.push(activeGroup); }
  if (event) { clauses.push("event = ?"); params.push(event); }
  if (source) { clauses.push("source = ?"); params.push(source); }
  if (query.trim()) { clauses.push("(instr(lower(website_name), lower(?)) > 0 OR instr(lower(group_name), lower(?)) > 0)"); params.push(query.trim(), query.trim()); }
  const where = clauses.join(" AND ");
  const total = rows(db, `SELECT COUNT(*) AS total FROM credential_activity WHERE ${where}`, params)[0].total;
  return { activeGroup, retentionDays: RETENTION_DAYS, total, offset, pageSize: 50,
    entries: rows(db, `SELECT id, credential_id AS credentialId, website_name AS websiteName, group_name AS groupName,
      event, source, occurred_at AS occurredAt FROM credential_activity WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT 50 OFFSET ?`, [...params, offset]) };
}
module.exports = { ensureSchema, setContext, recordPermanentDelete, purge, hasExpired, list, RETENTION_MS };
