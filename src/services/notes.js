// General notes live inside the encrypted vault. Never log titles or bodies.
const PAGE_SIZE = 50;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
function fail(message) { const error = new Error(message); error.isPublic = true; throw error; }
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid note request.");
  return value;
}
function integer(value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`Invalid ${label}.`);
  return value;
}
function rows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try { statement.bind(params); const result = []; while (statement.step()) result.push(statement.getAsObject()); return result; }
  finally { statement.free(); }
}
function ensureSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS general_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, body TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  const columns = rows(db, "PRAGMA table_info(general_notes)").map(column => column.name);
  for (const name of ["deleted_at", "expires_at"]) {
    if (!columns.includes(name)) db.run(`ALTER TABLE general_notes ADD COLUMN ${name} TEXT`);
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_general_notes_expiry ON general_notes(expires_at)");
}
function fields(data) {
  object(data);
  if (typeof data.title !== "string" || !data.title.trim() || data.title.length > 120) fail("Enter a note title of 1–120 characters.");
  if (typeof data.body !== "string" || data.body.length > 100000) fail("Note text must be 100,000 characters or fewer.");
  return [data.title.trim(), data.body];
}
function get(db, id, deleted = false) {
  integer(id, "note ID");
  const note = rows(db, "SELECT * FROM general_notes WHERE id = ? AND " +
    (deleted ? "deleted_at IS NOT NULL AND expires_at > ?" : "deleted_at IS NULL"),
    deleted ? [id, new Date().toISOString()] : [id])[0];
  if (!note) fail("This note no longer exists. Refresh the notes list.");
  return note;
}
function current(db, id, revision, deleted = false) {
  integer(revision, "note revision");
  const note = get(db, id, deleted);
  if (note.revision !== revision) fail("This note changed. Reopen it before trying again.");
  return note;
}
function list(db, options = {}, deleted = false) {
  object(options);
  const { query = "", favorites = false, sort = "updated", offset = 0 } = options;
  if (typeof query !== "string" || query.length > 200 || typeof favorites !== "boolean") fail("Invalid notes filter.");
  integer(offset, "notes page", 0);
  const orders = { updated: "updated_at DESC, id DESC", "title-asc": "title COLLATE NOCASE ASC, id ASC", "title-desc": "title COLLATE NOCASE DESC, id DESC" };
  if (typeof sort !== "string" || !Object.hasOwn(orders, sort)) fail("Invalid notes sort order.");
  const scope = deleted ? "deleted_at IS NOT NULL AND expires_at > ?" : "deleted_at IS NULL";
  const filter = `WHERE ${scope} AND (? = 0 OR favorite = 1) AND (? = '' OR instr(lower(title), lower(?)) > 0 OR instr(lower(body), lower(?)) > 0)`;
  const params = [...(deleted ? [new Date().toISOString()] : []), favorites ? 1 : 0, query.trim(), query.trim(), query.trim()];
  const matched = rows(db, `SELECT count(*) AS n FROM general_notes ${filter}`, params)[0].n;
  const summary = rows(db, "SELECT count(*) AS total, coalesce(sum(favorite), 0) AS favorites FROM general_notes WHERE deleted_at IS NULL")[0];
  const items = rows(db, `SELECT id, title, substr(body, 1, 160) AS snippet, favorite, revision, created_at, updated_at, deleted_at, expires_at
    FROM general_notes ${filter} ORDER BY ${deleted && sort === "updated" ? "deleted_at DESC, id DESC" : orders[sort]} LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, offset]);
  return { ...summary, matched, items, offset, pageSize: PAGE_SIZE, hasMore: offset + items.length < matched };
}
function add(db, data) {
  const [title, body] = fields(data);
  if (rows(db, "SELECT count(*) AS n FROM general_notes")[0].n >= 10000) fail("The vault can hold up to 10,000 notes, including Recently Deleted.");
  const now = new Date().toISOString();
  db.run("INSERT INTO general_notes (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)", [title, body, now, now]);
  return get(db, rows(db, "SELECT last_insert_rowid() AS id")[0].id);
}
function update(db, id, data) {
  const [title, body] = fields(data);
  current(db, id, data.revision);
  db.run("UPDATE general_notes SET title = ?, body = ?, revision = revision + 1, updated_at = ? WHERE id = ?", [title, body, new Date().toISOString(), id]);
  return get(db, id);
}
function toggleFavorite(db, id, revision) {
  const note = current(db, id, revision);
  db.run("UPDATE general_notes SET favorite = ?, revision = revision + 1 WHERE id = ?", [note.favorite ? 0 : 1, id]);
  return get(db, id);
}
function remove(db, id, revision, confirmed) {
  if (confirmed !== true) fail("Confirm moving this note to Recently Deleted first.");
  current(db, id, revision);
  const now = Date.now();
  db.run("UPDATE general_notes SET deleted_at = ?, expires_at = ?, revision = revision + 1 WHERE id = ?",
    [new Date(now).toISOString(), new Date(now + RETENTION_MS).toISOString(), id]);
  return { deleted: true };
}
function restore(db, id, revision) {
  current(db, id, revision, true);
  db.run("UPDATE general_notes SET deleted_at = NULL, expires_at = NULL, revision = revision + 1 WHERE id = ?", [id]);
  return get(db, id);
}
function permanentlyDelete(db, id, revision, confirmed) {
  if (confirmed !== true) fail("Confirm permanent note deletion first.");
  current(db, id, revision, true);
  db.run("DELETE FROM general_notes WHERE id = ?", [id]);
  return { deleted: true };
}
function hasExpired(db) {
  return rows(db, "SELECT id FROM general_notes WHERE deleted_at IS NOT NULL AND expires_at <= ? LIMIT 1", [new Date().toISOString()]).length > 0;
}
function purge(db) {
  db.run("DELETE FROM general_notes WHERE deleted_at IS NOT NULL AND expires_at <= ?", [new Date().toISOString()]);
}
module.exports = { ensureSchema, list, get, add, update, toggleFavorite, remove, restore, permanentlyDelete, hasExpired, purge, RETENTION_MS };
