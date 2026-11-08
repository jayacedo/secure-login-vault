// Pairing in the real app: its main process, the encrypted secret on disk and the
// Settings screen, with an extension stand-in talking to the real named pipe.
//   npm run test:pairing-app
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { testTempRoot } = require("./testTemp");
const { app, BrowserWindow, safeStorage } = require("electron");

const userData = fs.mkdtempSync(path.join(testTempRoot(), "slv-pairing-app-"));
app.setPath("userData", userData);
const pipeUser = `pairing-app-${process.pid}`;
process.env.SLV_PIPE_USER = pipeUser; // own pipe: a real running app is never touched
require("../src/main.js");

const { getPipeName } = require("../src/native-host/pipeName");
const { createPairing } = require("../src/services/extensionPairing");
const { createPairingStorage } = require("../src/services/pairingStorage");
const { connect, pair, authenticate, nonce } = require("./pairingTestClient");

const MASTER = "pairing app test master password";
const pipeName = getPipeName(pipeUser);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

async function main() {
  await app.whenReady();
  await waitFor(() => BrowserWindow.getAllWindows().length > 0, 15000, "the app window");
  const win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once("did-finish-load", resolve));

  const inApp = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const api = (call) => inApp(`return window.secureLoginVault.${call};`);
  const status = async () => (await api("settings.getExtensionPairing()")).result;

  const results = [];
  const check = async (name, fn) => {
    console.log(`...   ${name}`);
    try {
      await fn();
      results.push(`PASS  ${name}`);
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${error.message}`);
      process.exitCode = 1;
    }
  };

  const pairingFile = path.join(userData, "extension-pairing.bin");
  let secret = null;

  await check("starts unpaired with Windows encryption available", async () => {
    const s = await status();
    assert.deepEqual(s, { paired: false, codeActive: false, expiresAt: 0, encryptionAvailable: true });
  });

  await check("a code cannot be started while the vault is locked", async () => {
    const res = await api("settings.startExtensionPairing()");
    assert.equal(res.ok, false);
    assert.match(res.message, /Unlock/);
  });

  assert.equal((await api(`auth.createVault(${JSON.stringify({ masterPassword: MASTER, confirmPassword: MASTER })})`)).ok, true, "vault creation");

  await check("a code cannot be started while the browser connection is off", async () => {
    const res = await api("settings.startExtensionPairing()");
    assert.equal(res.ok, false);
    assert.match(res.message, /Browser Extension On/);
  });

  assert.equal((await api("settings.setExtensionBridge({ enabled: true })")).ok, true, "switch the connection on");

  await check("a code is created; the status never carries it", async () => {
    const res = await api("settings.startExtensionPairing()");
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(res.result.code, /^([A-Z2-9]{4}-){6}[A-Z2-9]{2}$/);
    assert.ok(res.result.expiresAt > Date.now() && res.result.expiresAt <= Date.now() + 2 * 60 * 1000);
    const s = await status();
    assert.equal(s.codeActive, true);
    assert.equal(JSON.stringify(s).includes(res.result.code), false);
  });

  await check("a wrong code over the pipe is refused and the real code still works", async () => {
    const real = (await api("settings.startExtensionPairing()")).result.code;
    const conn = await connect(pipeName);
    const wrong = real.replace(/^./, real[0] === "A" ? "B" : "A");
    const bad = await pair(conn, wrong);
    assert.equal(bad.appOk, false);
    assert.equal(bad.finish.ok, false);
    assert.equal((await status()).paired, false);

    const good = await pair(conn, real);
    assert.equal(good.appOk, true);
    assert.equal(good.finish.paired, true);
    secret = good.secret;
    conn.close();
  });

  await check("paired: the secret is stored encrypted, not as plain text", async () => {
    const s = await status();
    assert.deepEqual({ paired: s.paired, codeActive: s.codeActive }, { paired: true, codeActive: false });
    const bytes = fs.readFileSync(pairingFile);
    assert.equal(bytes.includes(Buffer.from(secret.toString("hex"))), false, "secret not in the file in plain hex");
    assert.equal(bytes.includes(Buffer.from("secret")), false, "no plain field name either");
    const files = fs.readdirSync(userData).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(files, [], "no temporary files left behind");
  });

  await check("the pairing survives a restart (a fresh load of the same file)", async () => {
    const again = createPairing({ storage: createPairingStorage({ filePath: pairingFile, safeStorage }) });
    assert.equal(again.isPaired(), true);
    const conn = await connect(pipeName);
    const run = await authenticate(conn, secret);
    assert.equal(run.appOk, true);
    assert.equal(run.finish.ok, true);
    conn.close();
  });

  await check("a damaged pairing file means not paired, never a crash", async () => {
    const original = fs.readFileSync(pairingFile);
    for (const damaged of [Buffer.from("garbage"), Buffer.alloc(0), Buffer.concat([original.subarray(0, original.length - 5), Buffer.from("xxxxx")])]) {
      fs.writeFileSync(`${pairingFile}.copy`, damaged);
      const copy = createPairing({ storage: createPairingStorage({ filePath: `${pairingFile}.copy`, safeStorage }) });
      assert.equal(copy.isPaired(), false);
    }
    fs.rmSync(`${pairingFile}.copy`, { force: true });
  });

  await check("locking the vault withdraws an unused code", async () => {
    assert.equal((await api("settings.startExtensionPairing()")).ok, true);
    assert.equal((await status()).codeActive, true);
    assert.equal((await api("auth.lockVault()")).ok !== false, true);
    assert.equal((await status()).codeActive, false);
    const conn = await connect(pipeName);
    assert.equal((await conn.request({ type: "pair-begin", nonceE: nonce() })).error, "no-pairing");
    conn.close();
    assert.equal((await api(`auth.unlockVault(${JSON.stringify({ masterPassword: MASTER })})`)).ok, true, "unlock again");
  });

  // ── The Settings screen, in the real window ─────────────────────────────────
  const ui = (code) => inApp(code);
  const q = (selector, property = "textContent") => ui(`const e = document.querySelector(${JSON.stringify(selector)}); return e ? e.${property} : null;`);
  const click = (selector) => ui(`document.querySelector(${JSON.stringify(selector)}).click(); return true;`);
  // "visible" means really on screen (display:none counts as not visible), not just the hidden attribute
  const visible = (selector) => ui(`const e = document.querySelector(${JSON.stringify(selector)}); return Boolean(e) && e.getClientRects().length > 0;`);

  await check("Settings shows the paired state with Pair again and Unpair", async () => {
    await ui("await openSettingsModal(); return true;");
    await waitFor(async () => (await q("#extension-pair-hint")) !== "Checking...", 5000, "the pairing hint");
    assert.match(await q("#extension-pair-hint"), /^Paired\./);
    assert.equal(await q("#extension-pair-btn"), "Pair again");
    assert.equal(await visible("#extension-unpair-btn"), true);
    assert.equal(await visible("#extension-pair-code-box"), false);
  });

  await check("Settings: Pair again shows the code, Copy and Cancel", async () => {
    await click("#extension-pair-btn");
    await waitFor(() => visible("#extension-pair-code-box"), 5000, "the code box");
    assert.match(await q("#extension-pair-code"), /^([A-Z2-9]{4}-){6}[A-Z2-9]{2}$/);
    assert.equal(await visible("#extension-pair-copy-btn"), true);
    assert.equal(await visible("#extension-pair-cancel-btn"), true);
    assert.equal(await visible("#extension-pair-btn"), false);
    assert.equal(await visible("#extension-unpair-btn"), false);
    assert.match(await q("#extension-pair-hint"), /Paste this code/);
  });

  await check("Settings: finishing the pairing from the extension side updates the screen", async () => {
    const shown = await q("#extension-pair-code");
    const conn = await connect(pipeName);
    const run = await pair(conn, shown);
    assert.equal(run.finish.paired, true);
    assert.notDeepEqual(run.secret, secret, "a new pairing means a new secret");
    secret = run.secret;
    conn.close();
    await waitFor(async () => !(await visible("#extension-pair-code-box")), 6000, "the code box to go away");
    assert.match(await q("#extension-pair-hint"), /^Paired\./);
    assert.equal(await q("#extension-pair-code"), "", "the code is wiped from the page");
  });

  await check("Settings: Cancel withdraws the code", async () => {
    await click("#extension-pair-btn");
    await waitFor(() => visible("#extension-pair-code-box"), 5000, "the code box");
    await click("#extension-pair-cancel-btn");
    await waitFor(async () => !(await visible("#extension-pair-code-box")), 5000, "the code box to hide");
    assert.equal((await status()).codeActive, false);
    assert.equal(await q("#extension-pair-code"), "");
    assert.match(await q("#extension-pair-hint"), /cancelled/);
  });

  await check("Settings: closing the window withdraws an unused code", async () => {
    await click("#extension-pair-btn");
    await waitFor(() => visible("#extension-pair-code-box"), 5000, "the code box");
    assert.equal((await status()).codeActive, true);
    await ui(`document.querySelector("#settings-modal-overlay").remove(); return true;`);
    await waitFor(async () => !(await status()).codeActive, 6000, "the code to be withdrawn");
  });

  await check("Settings: Unpair needs two clicks, then ends the link and drops connections", async () => {
    await ui("await openSettingsModal(); return true;");
    await waitFor(async () => (await q("#extension-pair-hint")) !== "Checking...", 5000, "the pairing hint");
    const conn = await connect(pipeName);
    assert.equal((await authenticate(conn, secret)).finish.ok, true);

    await click("#extension-unpair-btn");
    assert.equal(await q("#extension-unpair-btn"), "Click again to unpair");
    assert.equal((await status()).paired, true, "one click does nothing yet");

    await click("#extension-unpair-btn");
    await waitFor(async () => !(await status()).paired, 5000, "unpairing");
    await waitFor(() => conn.isClosed(), 5000, "the open connection to be dropped");
    await waitFor(async () => /^Not paired/.test(await q("#extension-pair-hint")), 5000, "the hint to update");
    assert.equal(await visible("#extension-unpair-btn"), false);
    assert.equal(await q("#extension-pair-btn"), "Pair browser");
    assert.equal(fs.existsSync(pairingFile), false, "the stored secret is deleted");

    const again = await connect(pipeName);
    const run = await authenticate(again, secret);
    assert.equal(run.begin.error, "not-paired");
    again.close();
  });

  await check("Settings: the Unpair button disarms itself", async () => {
    // pair once more so Unpair is available
    await click("#extension-pair-btn");
    await waitFor(() => visible("#extension-pair-code-box"), 5000, "the code box");
    const conn = await connect(pipeName);
    assert.equal((await pair(conn, await q("#extension-pair-code"))).finish.paired, true);
    conn.close();
    await waitFor(() => visible("#extension-unpair-btn"), 6000, "the Unpair button");
    await click("#extension-unpair-btn");
    assert.equal(await q("#extension-unpair-btn"), "Click again to unpair");
    await sleep(4400);
    assert.equal(await q("#extension-unpair-btn"), "Unpair");
    assert.equal((await status()).paired, true);
  });

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\npairing app tests FAILED" : "\npairing app tests passed");
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    // the app still has files open; the folder is inside the git-ignored .tmp
  }
  app.exit(process.exitCode || 0);
}

app.on("window-all-closed", () => {});

setTimeout(() => {
  console.error("pairing app test timed out");
  app.exit(1);
}, 240000);

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
