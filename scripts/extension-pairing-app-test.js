// Pairing in the real app: its main process, the encrypted secret on disk and the
// Settings screen, with an extension stand-in talking to the real named pipe.
//   npm run test:pairing-app
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { testTempRoot } = require("./testTemp");
const { app, BrowserWindow, safeStorage, dialog } = require("electron");

const userData = fs.mkdtempSync(path.join(testTempRoot(), "slv-pairing-app-"));
app.setPath("userData", userData);
const pipeUser = `pairing-app-${process.pid}`;
process.env.SLV_PIPE_USER = pipeUser; // own pipe: a real running app is never touched
process.env.SLV_APPROVAL_TIMEOUT_MS = "1500"; // the "ask before filling" prompt gives up quickly in this test
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

  await check("find-logins in the real app: only for a verified connection, only exact matches, no secrets, and not while locked", async () => {
    const add = (data) => api(`credentials.add(${JSON.stringify(data)})`);
    assert.equal((await add({ websiteName: "Example", websiteUrl: "https://example.com/login", username: "alice", password: "pw-SECRET-1", category: "Other", notes: "NOTE-SECRET" })).ok, true);
    assert.equal((await add({ websiteName: "Example admin", websiteUrl: "example.com", username: "root", password: "pw-SECRET-2", category: "Other" })).ok, true);
    assert.equal((await add({ websiteName: "Sub", websiteUrl: "https://www.example.com", username: "bob", password: "pw-SECRET-3", category: "Other" })).ok, true);
    assert.equal((await add({ websiteName: "Local", websiteUrl: "http://localhost:3000", username: "dev", password: "pw-SECRET-4", category: "Other" })).ok, true);

    const anonymous = await connect(pipeName);
    assert.equal((await anonymous.request({ type: "find-logins", url: "https://example.com/" })).error, "not-authenticated");
    anonymous.close();

    const conn = await connect(pipeName);
    assert.equal((await authenticate(conn, secret)).finish.ok, true);
    const found = await conn.request({ type: "find-logins", url: "https://example.com/account" });
    assert.equal(found.ok, true, JSON.stringify(found));
    assert.deepEqual(found.logins.map((l) => [l.name, l.username]).sort((x, y) => x[0].localeCompare(y[0])), [["Example", "alice"], ["Example admin", "root"]]);
    const text = JSON.stringify(found);
    for (const secretText of ["pw-SECRET", "NOTE-SECRET"]) assert.equal(text.includes(secretText), false, secretText);

    assert.deepEqual((await conn.request({ type: "find-logins", url: "https://www.example.com/" })).logins.map((l) => l.username), ["bob"]);
    assert.deepEqual((await conn.request({ type: "find-logins", url: "http://localhost:3000/x" })).logins.map((l) => l.username), ["dev"]);
    assert.deepEqual((await conn.request({ type: "find-logins", url: "https://evil-example.com/" })).logins, []);
    assert.equal((await conn.request({ type: "find-logins", url: "http://example.com/" })).error, "insecure-page");

    // locking the vault ends access to the list on the very next request
    assert.equal((await api("auth.lockVault()")).ok !== false, true);
    assert.equal((await conn.request({ type: "find-logins", url: "https://example.com/" })).error, "locked");
    assert.equal((await api(`auth.unlockVault(${JSON.stringify({ masterPassword: MASTER })})`)).ok, true, "unlock again");
    assert.equal((await conn.request({ type: "find-logins", url: "https://example.com/" })).ok, true, "and it works again once unlocked");
    conn.close();
  });

  await check("get-login in the real app: the saved password, only for the exact site, never while locked", async () => {
    const conn = await connect(pipeName);
    assert.equal((await authenticate(conn, secret)).finish.ok, true);
    const list = await conn.request({ type: "find-logins", url: "https://example.com/" });
    const alice = list.logins.find((l) => l.username === "alice");
    const www = (await conn.request({ type: "find-logins", url: "https://www.example.com/" })).logins[0];
    assert.ok(alice && www, "the saved logins are found");

    const got = await conn.request({ type: "get-login", loginId: alice.id, url: "https://example.com" });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.deepEqual({ host: got.host, username: got.username, password: got.password }, { host: "example.com", username: "alice", password: "pw-SECRET-1" });
    assert.equal(JSON.stringify(got).includes("NOTE-SECRET"), false);

    // the other site's login id cannot be used here, nor this one there
    assert.equal((await conn.request({ type: "get-login", loginId: www.id, url: "https://example.com" })).error, "no-match");
    assert.equal((await conn.request({ type: "get-login", loginId: alice.id, url: "https://www.example.com" })).error, "no-match");
    assert.equal((await conn.request({ type: "get-login", loginId: alice.id, url: "https://evil-example.com" })).error, "no-match");
    assert.equal((await conn.request({ type: "get-login", loginId: alice.id, url: "http://example.com" })).error, "insecure-page");

    // an unverified connection gets nothing
    const anonymous = await connect(pipeName);
    const refused = await anonymous.request({ type: "get-login", loginId: alice.id, url: "https://example.com" });
    assert.deepEqual({ ok: refused.ok, error: refused.error, password: refused.password }, { ok: false, error: "not-authenticated", password: undefined });
    anonymous.close();

    // a locked vault releases nothing, even to a verified connection
    assert.equal((await api("auth.lockVault()")).ok !== false, true);
    const locked = await conn.request({ type: "get-login", loginId: alice.id, url: "https://example.com" });
    assert.deepEqual({ ok: locked.ok, error: locked.error, password: locked.password }, { ok: false, error: "locked", password: undefined });
    assert.equal((await api(`auth.unlockVault(${JSON.stringify({ masterPassword: MASTER })})`)).ok, true, "unlock again");
    conn.close();
  });

  await check("Ask before filling: off by default; when on, the person decides in a prompt that shows no secrets", async () => {
    const prompts = [];
    let answer = 1;
    let hang = false;
    // stand-in for the native dialog (the real one needs a person to click)
    dialog.showMessageBox = (window, options) => {
      prompts.push(options);
      return new Promise((resolve) => {
        if (hang) options.signal.addEventListener("abort", () => resolve({ response: options.cancelId }));
        else setTimeout(() => resolve({ response: answer }), 50);
      });
    };

    const conn = await connect(pipeName);
    assert.equal((await authenticate(conn, secret)).finish.ok, true);
    const alice = (await conn.request({ type: "find-logins", url: "https://example.com/" })).logins.find((l) => l.username === "alice");
    const ask = () => conn.request({ type: "get-login", loginId: alice.id, url: "https://example.com" });

    const before = await api("settings.getExtensionBridge()");
    assert.equal(before.result.askBeforeFill, false, "off by default");
    assert.equal((await ask()).password, "pw-SECRET-1");
    assert.equal(prompts.length, 0, "no prompt while the setting is off");

    assert.equal((await api("settings.setExtensionAskBeforeFill({ enabled: true })")).result.askBeforeFill, true);
    const settingsFile = JSON.parse(fs.readFileSync(path.join(userData, "extension-settings.json"), "utf8"));
    assert.deepEqual(settingsFile, { enabled: true, askBeforeFill: true }, "saved, and the connection setting is kept");

    // approved
    answer = 1;
    assert.equal((await ask()).password, "pw-SECRET-1");
    assert.equal(prompts.length, 1);
    const shown = JSON.stringify(prompts[0]);
    assert.match(prompts[0].message, /Example/);
    assert.match(prompts[0].message, /example\.com/);
    for (const secretText of ["pw-SECRET", "alice", "NOTE-SECRET"]) assert.equal(shown.includes(secretText), false, `the prompt does not show ${secretText}`);
    assert.deepEqual(prompts[0].buttons, ["Don't fill", "Fill"]);
    assert.equal(prompts[0].defaultId, 0, "pressing Enter means Don't fill");
    assert.equal(prompts[0].cancelId, 0, "closing the prompt means Don't fill");

    // declined
    answer = 0;
    const declined = await ask();
    assert.deepEqual({ ok: declined.ok, error: declined.error, password: declined.password }, { ok: false, error: "declined", password: undefined });

    // no answer in time: declined by itself
    hang = true;
    const started = Date.now();
    const timedOut = await ask();
    assert.equal(timedOut.error, "declined");
    assert.ok(Date.now() - started < 4000, "gave up by itself");
    hang = false;

    // a request that fails the checks is never prompted
    const promptsBefore = prompts.length;
    assert.equal((await conn.request({ type: "get-login", loginId: alice.id, url: "https://evil-example.com" })).error, "no-match");
    assert.equal(prompts.length, promptsBefore);

    // a second request while a prompt is open is declined at once, with no second prompt
    hang = true;
    const first = ask();
    await sleep(200);
    const second = await ask();
    assert.equal(second.error, "declined");
    assert.equal(prompts.length, promptsBefore + 1, "one prompt at a time");
    assert.equal((await first).error, "declined", "and the first gives up by itself");
    hang = false;

    // switched off again
    assert.equal((await api("settings.setExtensionAskBeforeFill({ enabled: false })")).result.askBeforeFill, false);
    assert.equal((await ask()).password, "pw-SECRET-1");

    // bad settings values are refused
    for (const bad of ["on", 1, null, {}]) assert.equal((await api(`settings.setExtensionAskBeforeFill({ enabled: ${JSON.stringify(bad)} })`)).ok, false);
    conn.close();
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

  await check("Settings: Ask Before Filling shows the saved choice, saves changes, and is remembered", async () => {
    const setSelect = (value) => ui(`const e = document.querySelector("#extension-ask-select"); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event("change")); return true;`);
    const bridge = async () => (await api("settings.getExtensionBridge()")).result;
    assert.equal(await q("#extension-ask-select", "value"), "off");
    assert.equal(await q("#extension-ask-select", "disabled"), false);

    await setSelect("on");
    await waitFor(async () => (await bridge()).askBeforeFill === true, 5000, "the setting to be saved");
    assert.equal(await q("#extension-ask-select", "value"), "on");
    assert.equal((await bridge()).enabled, true, "the connection setting is untouched");

    // reopening Settings shows what is saved
    await ui("document.querySelector('#settings-modal-overlay').remove(); await openSettingsModal(); return true;");
    await waitFor(async () => (await q("#extension-bridge-hint")) !== "Lets the Secure Login Vault browser extension connect to this app. Off by default.", 5000, "the status to load");
    assert.equal(await q("#extension-ask-select", "value"), "on");

    await setSelect("off");
    await waitFor(async () => (await bridge()).askBeforeFill === false, 5000, "the setting to be saved");
    assert.equal(await q("#extension-ask-select", "value"), "off");
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
