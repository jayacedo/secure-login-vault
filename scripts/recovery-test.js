const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const { testTempRoot } = require("./testTemp");
const { createVaultStore } = require("../src/services/vaultStore");

const PW1 = "correct horse battery staple";
const PW2 = "another long passphrase 2026";
const PW3 = "third unrelated passphrase 77";
const KEY_FORMAT = /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/;

async function newVault(prefix) {
  const root = await fs.mkdtemp(path.join(testTempRoot(), prefix));
  const store = createVaultStore(root);
  await store.createVault({ masterPassword: PW1, confirmPassword: PW1, hint: "first hint" });
  await store.createCredential({ websiteName: "Example", password: "secret-1" });
  await store.createCredential({ websiteName: "Second", password: "secret-2" });
  const dir = path.join(root, "vault");
  return {
    root,
    store,
    authPath: path.join(dir, "vault-auth.json"),
    dbPath: path.join(dir, "vault-data.slv"),
    readAuth: async () => JSON.parse(await fs.readFile(path.join(dir, "vault-auth.json"), "utf8"))
  };
}

async function credentialCount(store) {
  return (await store.getAllCredentials()).length;
}

async function run() {
  const roots = [];
  try {
    // ── Legacy vault: no recovery key until one is created ────────────────────
    const v = await newVault("slv-rec-a-");
    roots.push(v.root);
    const { store } = v;

    assert.equal((await store.getState()).hasRecoveryKey, false);
    await assert.rejects(
      () => store.resetWithRecoveryKey({ recoveryKey: "AAAA", newPassword: PW2, confirmPassword: PW2 }),
      /does not have a recovery key/
    );

    // Wrong or missing password cannot create a key, and nothing changes.
    await assert.rejects(() => store.createRecoveryKey({ currentPassword: "wrong password value" }), /incorrect/);
    await assert.rejects(() => store.createRecoveryKey({ currentPassword: "" }), /current master password/);
    assert.equal("keyWrap" in (await v.readAuth()), false);

    // ── Create: converts the vault, returns a well-formed key ─────────────────
    const created = await store.createRecoveryKey({ currentPassword: PW1 });
    assert.match(created.recoveryKey, KEY_FORMAT);
    assert.equal(created.converted, true);
    assert.equal(await credentialCount(store), 2, "data survives the conversion");
    assert.equal((await store.getState()).hasRecoveryKey, true);

    const authText = await fs.readFile(v.authPath, "utf8");
    const dbText = await fs.readFile(v.dbPath, "utf8");
    const rawKey = created.recoveryKey.replace(/-/g, "");
    for (const text of [authText, dbText]) {
      assert.equal(text.includes(created.recoveryKey), false);
      assert.equal(text.includes(rawKey), false);
      assert.equal(text.includes(PW1), false);
    }
    await assert.rejects(() => fs.access(`${v.dbPath}.rekey.bak`), "no leftover pre-change copy");

    store.lockVault();
    await store.unlockVault({ masterPassword: PW1 });
    assert.equal(await credentialCount(store), 2);

    // ── Changing the password on a data-key vault leaves the database alone ───
    const dbBefore = await fs.readFile(v.dbPath, "utf8");
    await store.changeMasterPassword({ currentPassword: PW1, newPassword: PW2, confirmPassword: PW2 });
    assert.equal(await fs.readFile(v.dbPath, "utf8"), dbBefore, "database file is not rewritten");
    assert.equal(await credentialCount(store), 2);
    store.lockVault();
    await assert.rejects(() => store.unlockVault({ masterPassword: PW1 }), /incorrect/);
    await store.unlockVault({ masterPassword: PW2 });
    assert.equal(await credentialCount(store), 2);
    assert.equal((await store.getState()).hasRecoveryKey, true, "recovery key survives a password change");
    store.lockVault();

    // ── Reset with the recovery key (vault locked) ────────────────────────────
    const key = created.recoveryKey;

    await assert.rejects(
      () => store.resetWithRecoveryKey({ recoveryKey: "not a key", newPassword: PW3, confirmPassword: PW3 }),
      /not a valid recovery key/
    );
    await assert.rejects(
      () =>
        store.resetWithRecoveryKey({
          recoveryKey: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA",
          newPassword: PW3,
          confirmPassword: PW3
        }),
      /recovery key is incorrect/
    );
    await assert.rejects(
      () => store.resetWithRecoveryKey({ recoveryKey: key, newPassword: "short", confirmPassword: "short" }),
      /at least 12 characters/
    );
    await assert.rejects(
      () => store.resetWithRecoveryKey({ recoveryKey: key, newPassword: PW3, confirmPassword: PW1 + "x" }),
      /does not match/
    );
    await assert.rejects(
      () =>
        store.resetWithRecoveryKey({
          recoveryKey: key,
          newPassword: PW3,
          confirmPassword: PW3,
          hint: `it is ${PW3}`
        }),
      /must not contain/
    );
    // All of the failures above left the vault untouched.
    await store.unlockVault({ masterPassword: PW2 });
    store.lockVault();

    // Accepts lower case, no dashes and extra spaces.
    const sloppyKey = `  ${key.replace(/-/g, "").toLowerCase()} `;
    const reset = await store.resetWithRecoveryKey({
      recoveryKey: sloppyKey,
      newPassword: PW3,
      confirmPassword: PW3,
      hint: "after reset"
    });
    assert.equal(reset.reset, true);
    assert.equal((await store.getState()).isUnlocked, false, "reset leaves the vault locked");
    assert.equal((await store.getState()).passwordHint, "after reset");
    await assert.rejects(() => store.unlockVault({ masterPassword: PW2 }), /incorrect/);
    await store.unlockVault({ masterPassword: PW3 });
    assert.equal(await credentialCount(store), 2, "data intact after reset");

    // The same recovery key still works after being used.
    store.lockVault();
    await store.resetWithRecoveryKey({ recoveryKey: key, newPassword: PW1, confirmPassword: PW1 });
    assert.equal((await store.getState()).passwordHint, "", "reset without a hint clears the old one");
    await store.unlockVault({ masterPassword: PW1 });

    // ── Regenerating replaces the key ─────────────────────────────────────────
    const regenerated = await store.createRecoveryKey({ currentPassword: PW1 });
    assert.equal(regenerated.converted, false);
    assert.notEqual(regenerated.recoveryKey, key);
    store.lockVault();
    await assert.rejects(
      () => store.resetWithRecoveryKey({ recoveryKey: key, newPassword: PW2, confirmPassword: PW2 }),
      /recovery key is incorrect/
    );
    await store.resetWithRecoveryKey({
      recoveryKey: regenerated.recoveryKey,
      newPassword: PW2,
      confirmPassword: PW2
    });
    await store.unlockVault({ masterPassword: PW2 });

    // ── Backups of a data-key vault restore and keep the recovery key ─────────
    const backupPath = path.join(v.root, "test.slvbackup");
    await store.createEncryptedBackup(backupPath);
    await store.createCredential({ websiteName: "Third", password: "x" });
    await store.restoreEncryptedBackup(backupPath, PW2);
    await store.unlockVault({ masterPassword: PW2 });
    assert.equal(await credentialCount(store), 2);
    store.lockVault();
    await store.resetWithRecoveryKey({
      recoveryKey: regenerated.recoveryKey,
      newPassword: PW3,
      confirmPassword: PW3
    });
    await store.unlockVault({ masterPassword: PW3 });
    store.lockVault();

    // ── A tampered keyWrap is rejected instead of crashing ────────────────────
    const auth = await v.readAuth();
    auth.keyWrap = { dek: "nope" };
    await fs.writeFile(v.authPath, JSON.stringify(auth));
    await assert.rejects(() => store.unlockVault({ masterPassword: PW3 }), /invalid/);

    // ── Crash while converting: DB re-keyed, auth still legacy ────────────────
    const c = await newVault("slv-rec-b-");
    roots.push(c.root);
    const legacyAuth = await fs.readFile(c.authPath, "utf8");
    const legacyDb = await fs.readFile(c.dbPath, "utf8");
    await c.store.createRecoveryKey({ currentPassword: PW1 });
    const convertedDb = await fs.readFile(c.dbPath, "utf8");
    c.store.lockVault();

    await fs.writeFile(c.authPath, legacyAuth); // auth write never happened
    await fs.writeFile(c.dbPath, convertedDb); // database was already re-keyed
    await fs.writeFile(`${c.dbPath}.rekey.bak`, legacyDb); // pre-change copy
    await c.store.unlockVault({ masterPassword: PW1 });
    assert.equal(await credentialCount(c.store), 2, "interrupted conversion recovers");
    await assert.rejects(() => fs.access(`${c.dbPath}.rekey.bak`));
    c.store.lockVault();

    // ── Crash after the auth write: stale pre-change copy is cleaned up ───────
    const d = await newVault("slv-rec-c-");
    roots.push(d.root);
    const oldDb = await fs.readFile(d.dbPath, "utf8");
    await d.store.createRecoveryKey({ currentPassword: PW1 });
    d.store.lockVault();
    await fs.writeFile(`${d.dbPath}.rekey.bak`, oldDb); // left behind by a crash
    await d.store.unlockVault({ masterPassword: PW1 });
    await assert.rejects(() => fs.access(`${d.dbPath}.rekey.bak`), "stale copy removed on unlock");
    d.store.lockVault();

    console.log("recovery-key tests passed");
  } finally {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
