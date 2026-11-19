const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { testTempRoot } = require("./testTemp");
const { createVaultStore } = require("../src/services/vaultStore");
const { createBackupVerification } = require("../src/services/backupVerification");
const initSqlJs = require("sql.js");
const notes = require("../src/services/notes");

async function main() {
  // All database reads below are confined to files created by this test.
  const root = await fs.mkdtemp(path.join(testTempRoot(), "notes-test-"));
  const store = createVaultStore(path.join(root, "synthetic"));
  const restored = createVaultStore(path.join(root, "restored"));
  const password = "Synthetic notes passphrase only";
  try {
    await assert.rejects(store.listNotes(), /locked/i);
    await store.createVault({ masterPassword: password, confirmPassword: password });
    const oldBackup = path.join(root, "before-notes.slvbackup");
    await store.createEncryptedBackup(oldBackup);
    assert.equal((await store.listNotes()).total, 0);
    let first = await store.addNote({ title: "Synthetic alpha", body: "Unique synthetic body 19a7\n<script>not executable</script>" });
    const second = await store.addNote({ title: "Synthetic beta", body: "Checklist\nOne\nTwo" });
    const encrypted = await fs.readFile(path.join(root, "synthetic/vault/vault-data.slv"), "utf8");
    assert(!encrypted.includes(first.title)); assert(!encrypted.includes(first.body));
    assert.equal((await store.listNotes({ query: "19a7" })).matched, 1);
    assert.equal((await store.listNotes({ query: "' OR 1=1 --" })).matched, 0);
    assert.equal((await store.listNotes({ sort: "title-desc" })).items[0].id, second.id);
    assert(!Object.hasOwn((await store.listNotes()).items[0], "body"), "list does not return complete note bodies");
    first = await store.toggleNoteFavorite(first.id, first.revision);
    assert.equal((await store.listNotes({ favorites: true })).matched, 1);
    await assert.rejects(store.updateNote(first.id, { title: "stale", body: "stale", revision: 1 }), /changed/i);
    first = await store.updateNote(first.id, { title: first.title, body: "Updated synthetic text", revision: first.revision });
    for (const data of [null, [], {}, { title: " ", body: "" }, { title: "x", body: 1 }, { title: "x".repeat(121), body: "" }, { title: "x", body: "x".repeat(100001) }]) await assert.rejects(store.addNote(data));
    for (const id of [0, -1, "1", 1.5, null]) await assert.rejects(store.getNote(id));
    for (const options of [null, [], { offset: -1 }, { sort: "DROP TABLE" }, { query: 1 }, { favorites: "yes" }]) await assert.rejects(store.listNotes(options));
    const parallel = await Promise.allSettled([store.updateNote(first.id, { ...first, body: "First concurrent save" }), store.updateNote(first.id, { ...first, body: "Second concurrent save" })]);
    assert.equal(parallel.filter(result => result.status === "fulfilled").length, 1, "stale writes cannot overwrite one another");
    first = await store.getNote(first.id);
    await assert.rejects(store.deleteNote(second.id, second.revision, false), /confirm/i);
    await assert.rejects(store.deleteNote(second.id, second.revision + 1, true), /changed/i);
    const backup = path.join(root, "notes.slvbackup");
    await store.createEncryptedBackup(backup);
    assert(!(await fs.readFile(backup, "utf8")).includes(first.body));
    const verifier = createBackupVerification({ directory: path.join(root, "verify") });
    await verifier.prepare();
    assert.equal((await verifier.verify(backup, password)).counts.notes, 2);
    assert.equal((await verifier.verify(oldBackup, password)).counts.notes, 0, "backups from before notes remain readable");
    await restored.restoreEncryptedBackup(backup, password);
    await restored.unlockVault({ masterPassword: password });
    assert.deepEqual(await restored.getNote(first.id), first, "encrypted full backup restores notes exactly");
    await store.deleteNote(second.id, second.revision, true);
    await assert.rejects(store.getNote(second.id), /no longer exists/i);
    let deleted = await store.getDeletedNote(second.id);
    assert.equal(deleted.body, second.body);
    assert.equal(Date.parse(deleted.expires_at) - Date.parse(deleted.deleted_at), notes.RETENTION_MS);
    assert.equal((await store.listDeletedNotes({ query: "Checklist" })).matched, 1);
    assert.equal((await store.listNotes({ query: "Checklist" })).matched, 0);
    await assert.rejects(store.updateNote(deleted.id, { ...deleted, body: "cannot edit trash" }), /no longer exists/i);
    await assert.rejects(store.toggleNoteFavorite(deleted.id, deleted.revision), /no longer exists/i);
    await assert.rejects(store.permanentlyDeleteNote(first.id, first.revision, true), /no longer exists/i);
    await assert.rejects(store.restoreNote(deleted.id, second.revision), /changed/i);
    await assert.rejects(store.permanentlyDeleteNote(deleted.id, deleted.revision, false), /confirm/i);
    const trashBackup = path.join(root, "with-deleted-notes.slvbackup");
    await store.createEncryptedBackup(trashBackup);
    const checked = await verifier.verify(trashBackup, password);
    assert.equal(checked.counts.notes, 1); assert.equal(checked.counts.deletedNotes, 1);
    const cancelledRestore = store.restoreNote(deleted.id, deleted.revision);
    store.lockVault(); await assert.rejects(cancelledRestore);
    await store.unlockVault({ masterPassword: password });
    assert.deepEqual(await store.getDeletedNote(second.id), deleted, "locking cancels queued restore without changing the deleted note");
    restored.lockVault();
    await restored.restoreEncryptedBackup(trashBackup, password);
    await restored.unlockVault({ masterPassword: password });
    assert.deepEqual(await restored.getDeletedNote(second.id), deleted, "backup retains deleted content and original expiry");
    let recovered = await store.restoreNote(deleted.id, deleted.revision);
    for (const field of ["id", "title", "body", "favorite", "created_at", "updated_at"]) assert.equal(recovered[field], second[field], `restore retains ${field}`);
    assert.equal((await store.listDeletedNotes()).matched, 0);
    await assert.rejects(store.restoreNote(deleted.id, deleted.revision), /no longer exists/i);
    await store.deleteNote(recovered.id, recovered.revision, true);
    deleted = await store.getDeletedNote(recovered.id);
    const race = await Promise.allSettled([store.restoreNote(deleted.id, deleted.revision), store.permanentlyDeleteNote(deleted.id, deleted.revision, true)]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1, "restore/delete race cannot lose a restored note");
    if (race[0].status === "fulfilled") {
      recovered = await store.getNote(second.id);
      await store.deleteNote(recovered.id, recovered.revision, true);
      deleted = await store.getDeletedNote(second.id);
      await store.permanentlyDeleteNote(deleted.id, deleted.revision, true);
    }
    assert.equal((await store.listDeletedNotes()).matched, 0);
    await assert.rejects(store.getDeletedNote(second.id), /no longer exists/i);
    const pending = store.addNote({ title: "Must not save after lock", body: "Synthetic" });
    store.lockVault();
    await assert.rejects(pending);
    await assert.rejects(store.getNote(first.id), /locked/i);
    for (const operation of [() => store.listDeletedNotes(), () => store.getDeletedNote(first.id), () => store.restoreNote(first.id, 1), () => store.permanentlyDeleteNote(first.id, 1, true), () => store.purgeDeletedNotes()]) await assert.rejects(operation, /locked/i);
    await store.unlockVault({ masterPassword: password });
    assert.equal((await store.listNotes()).total, 1);
    assert.deepEqual(await store.getNote(first.id), first);
    // Exercise pagination and schema upgrades using a new in-memory synthetic DB.
    const SQL = await initSqlJs(), db = new SQL.Database();
    try {
      // Reproduce the schema shipped before Recently Deleted, using fake data.
      db.run("CREATE TABLE general_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      db.run("INSERT INTO general_notes (title, body, created_at, updated_at) VALUES ('Legacy synthetic', 'Old fake content', '2026-01-01', '2026-01-01')");
      notes.ensureSchema(db); notes.ensureSchema(db);
      assert.equal(notes.get(db, 1).body, "Old fake content");
      assert.equal(notes.get(db, 1).deleted_at, null);
      for (let i = 0; i < 54; i++) notes.add(db, { title: `Synthetic ${String(i).padStart(2, "0")}`, body: "Synthetic page test" });
      const one = notes.list(db, { sort: "title-asc" }), two = notes.list(db, { sort: "title-asc", offset: 50 });
      assert.equal(one.items.length, 50); assert(one.hasMore);
      assert.equal(two.items.length, 5); assert(!two.hasMore);
      assert.equal(new Set([...one.items, ...two.items].map(n => n.id)).size, 55);
      for (const n of [...one.items, ...two.items]) notes.remove(db, n.id, n.revision, true);
      assert.equal(notes.list(db).total, 0);
      assert.equal(notes.list(db, {}, true).items.length, 50);
      assert.equal(notes.list(db, { offset: 50 }, true).items.length, 5);
      db.run("UPDATE general_notes SET expires_at = ? WHERE id = 1", [new Date(Date.now() - 1000).toISOString()]);
      assert.equal(notes.list(db, {}, true).matched, 54);
      assert.throws(() => notes.get(db, 1, true), /no longer exists/);
      assert.throws(() => notes.restore(db, 1, 2), /no longer exists/);
      assert(notes.hasExpired(db)); notes.purge(db); assert(!notes.hasExpired(db));
      assert.equal(db.exec("SELECT count(*) FROM general_notes")[0].values[0][0], 54);
    } finally { db.close(); }
    console.log("Notes: CRUD, validation, search, paging, stale writes, lock cancellation, encryption and backup compatibility passed (synthetic only).");
  } finally {
    store.lockVault(); restored.lockVault();
    // root was freshly allocated above; no existing vault/profile is accessed.
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
