const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const { testTempRoot } = require("./testTemp");
const { createVaultStore } = require("../src/services/vaultStore");

const PW1 = "correct horse battery staple";
const PW2 = "another long passphrase 2026";

async function run() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "slv-hint-"));
  const store = createVaultStore(root);

  try {
    // No vault yet: no hint.
    assert.equal((await store.getState()).passwordHint, "");

    // Hints that give the password away, or are too long / not text, are refused
    // and must not leave a half-created vault behind.
    for (const [hint, pattern] of [
      [`my password is ${PW1}`, /must not contain/],
      [PW1.toUpperCase(), /must not contain/],
      ["x".repeat(101), /100 characters/],
      [12345, /not valid/]
    ]) {
      await assert.rejects(
        () => store.createVault({ masterPassword: PW1, confirmPassword: PW1, hint }),
        pattern
      );
      assert.equal((await store.getState()).hasVault, false);
    }

    // A good hint is stored, cleaned up, and readable while the vault is locked.
    await store.createVault({
      masterPassword: PW1,
      confirmPassword: PW1,
      hint: "  first   pet\nand the year\t "
    });
    store.lockVault();
    let state = await store.getState();
    assert.equal(state.isUnlocked, false);
    assert.equal(state.passwordHint, "first pet and the year");

    // Changing the hint needs the right current password.
    await store.unlockVault({ masterPassword: PW1 });
    await assert.rejects(
      () => store.setPasswordHint({ currentPassword: "wrong password value", hint: "new" }),
      /incorrect/
    );
    await assert.rejects(
      () => store.setPasswordHint({ currentPassword: "", hint: "new" }),
      /current master password/
    );
    await assert.rejects(
      () => store.setPasswordHint({ currentPassword: PW1, hint: `it is ${PW1}` }),
      /must not contain/
    );
    assert.equal((await store.getState()).passwordHint, "first pet and the year");

    const saved = await store.setPasswordHint({ currentPassword: PW1, hint: "street I grew up on" });
    assert.equal(saved.hint, "street I grew up on");
    assert.equal((await store.getState()).passwordHint, "street I grew up on");

    // Empty hint removes it, and the vault still unlocks.
    await store.setPasswordHint({ currentPassword: PW1, hint: "   " });
    assert.equal((await store.getState()).passwordHint, "");
    const authRecord = JSON.parse(await fs.readFile(path.join(root, "vault", "vault-auth.json"), "utf8"));
    assert.equal("hint" in authRecord, false);
    store.lockVault();
    await store.unlockVault({ masterPassword: PW1 });

    // Changing the master password replaces the (now stale) hint.
    await store.setPasswordHint({ currentPassword: PW1, hint: "old hint" });
    await store.changeMasterPassword({
      currentPassword: PW1,
      newPassword: PW2,
      confirmPassword: PW2,
      hint: "new hint"
    });
    assert.equal((await store.getState()).passwordHint, "new hint");

    await store.changeMasterPassword({
      currentPassword: PW2,
      newPassword: PW1,
      confirmPassword: PW1
    });
    assert.equal((await store.getState()).passwordHint, "", "no hint supplied clears the old one");

    await assert.rejects(
      () =>
        store.changeMasterPassword({
          currentPassword: PW1,
          newPassword: PW2,
          confirmPassword: PW2,
          hint: `${PW2} is it`
        }),
      /must not contain/
    );
    store.lockVault();
    await store.unlockVault({ masterPassword: PW1 }); // failed change left the vault intact

    // Locked vault cannot have its hint changed.
    store.lockVault();
    await assert.rejects(
      () => store.setPasswordHint({ currentPassword: PW1, hint: "x" }),
      /locked/
    );

    console.log("hint tests passed");
  } finally {
    store.lockVault();
    await fs.rm(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
