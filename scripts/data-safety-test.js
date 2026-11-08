const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createVaultStore } = require("../src/services/vaultStore");

const PW1 = "correct horse battery staple";
const PW2 = "another long passphrase 2026";

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slv-safety-"));
  const dir = path.join(root, "vault");
  const authPath = path.join(dir, "vault-auth.json");
  const dbPath = path.join(dir, "vault-data.slv");
  const store = createVaultStore(root);

  try {
    await store.createVault({ masterPassword: PW1, confirmPassword: PW1 });
    await store.createCredential({ websiteName: "Example", password: "secret" });

    // 1. Stale temp files must not block saving.
    await fs.writeFile(`${dbPath}.tmp`, "stale");
    await fs.writeFile(`${authPath}.tmp`, "stale");
    await store.createCredential({ websiteName: "Second", password: "secret2" });
    assert.equal((await store.getAllCredentials()).length, 2);

    // 2a. Normal master password change works and old password stops working.
    await store.changeMasterPassword({ currentPassword: PW1, newPassword: PW2, confirmPassword: PW2 });
    store.lockVault();
    await assert.rejects(() => store.unlockVault({ masterPassword: PW1 }), /incorrect/);
    await store.unlockVault({ masterPassword: PW2 });
    assert.equal((await store.getAllCredentials()).length, 2);
    await assert.rejects(() => fs.access(`${dbPath}.rekey.bak`));

    // 2b. Simulated crash: database re-keyed, auth record still old.
    const oldAuth = await fs.readFile(authPath, "utf8");
    const oldDb = await fs.readFile(dbPath, "utf8");
    await store.changeMasterPassword({ currentPassword: PW2, newPassword: PW1, confirmPassword: PW1 });
    const newDb = await fs.readFile(dbPath, "utf8");
    await fs.writeFile(authPath, oldAuth);       // auth never got updated
    await fs.writeFile(dbPath, newDb);            // db under the new key
    await fs.writeFile(`${dbPath}.rekey.bak`, oldDb); // pre-change copy
    store.lockVault();
    await store.unlockVault({ masterPassword: PW2 });
    assert.equal((await store.getAllCredentials()).length, 2);

    // 3. Restore keeps the replaced vault as a .pre-restore.bak copy.
    const backupPath = path.join(root, "test.slvbackup");
    await store.createEncryptedBackup(backupPath);
    await store.createCredential({ websiteName: "Third", password: "x" });
    const before = await fs.readFile(dbPath, "utf8");
    await store.restoreEncryptedBackup(backupPath, PW2);
    assert.equal(await fs.readFile(`${dbPath}.pre-restore.bak`, "utf8"), before);
    await store.unlockVault({ masterPassword: PW2 });
    assert.equal((await store.getAllCredentials()).length, 2);

    console.log("data-safety tests passed");
  } finally {
    store.lockVault();
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
