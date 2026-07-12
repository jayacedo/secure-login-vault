const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createVaultStore } = require("../src/services/vaultStore");

async function run() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "secure-login-vault-auth-"));
  const vaultStore = createVaultStore(tempRoot);
  const password = "correct horse battery staple";

  try {
    let state = await vaultStore.getState();
    assert.equal(state.hasVault, false);
    assert.equal(state.isUnlocked, false);
    assert.equal(state.databaseReady, false);

    await assert.rejects(
      () =>
        vaultStore.createVault({
          masterPassword: "short",
          confirmPassword: "short"
        }),
      /at least 12 characters/
    );

    await assert.rejects(
      () =>
        vaultStore.createVault({
          masterPassword: password,
          confirmPassword: "different password value"
        }),
      /confirmation does not match/
    );

    const created = await vaultStore.createVault({
      masterPassword: password,
      confirmPassword: password
    });

    assert.equal(created.created, true);
    assert.equal(created.isUnlocked, true);

    state = await vaultStore.getState();
    assert.equal(state.hasVault, true);
    assert.equal(state.databaseReady, true);
    assert.equal(state.isUnlocked, true);

    let dashboardData = await vaultStore.getDashboardData();
    assert.equal(dashboardData.summary.totalCredentials, 0);
    assert.equal(dashboardData.summary.favoriteCredentials, 0);
    assert.equal(dashboardData.summary.categories, 12);
    assert.equal(dashboardData.categories[0].name, "All Items");
    assert.equal(dashboardData.categories[1].name, "Favorites");
    assert.equal(dashboardData.credentials.length, 0);

    const locked = vaultStore.lockVault();
    assert.equal(locked.isUnlocked, false);

    await assert.rejects(() => vaultStore.getDashboardData(), /Vault is locked/);

    await assert.rejects(
      () => vaultStore.unlockVault({ masterPassword: "incorrect password value" }),
      /Master password is incorrect/
    );

    const unlocked = await vaultStore.unlockVault({ masterPassword: password });
    assert.equal(unlocked.unlocked, true);
    assert.equal(unlocked.isUnlocked, true);

    dashboardData = await vaultStore.getDashboardData();
    assert.equal(dashboardData.summary.categories, 12);

    const authRecord = await fs.readFile(
      path.join(tempRoot, "vault", "vault-auth.json"),
      "utf8"
    );
    const encryptedDatabase = await fs.readFile(
      path.join(tempRoot, "vault", "vault-data.slv"),
      "utf8"
    );

    assert.equal(authRecord.includes(password), false);
    assert.equal(encryptedDatabase.includes(password), false);
    assert.equal(encryptedDatabase.includes("SQLite format 3"), false);

    vaultStore.lockVault();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
