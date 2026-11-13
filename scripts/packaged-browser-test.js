// Tests the payload extracted from Setup, using the shipped executable as the only
// helper runtime. The test controller uses Node; the installed helper does not.
const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const asar = require("@electron/asar");
const { testTempRoot } = require("./testTemp");
const { fakeRegistry } = require("./browserSetupTestUtils");
const { pair, authenticate } = require("./pairingTestClient");
const { JSDOM } = require("jsdom");

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "packaged-browser-"));
  const install = path.join(root, "Fresh Install With Spaces");
  const version = require("../package.json").version;
  const installer = path.join(__dirname, "../release", `Secure Login Vault Setup ${version}.exe`);
  const sevenZip = path.join(__dirname, "../node_modules/electron-winstaller/vendor/7z.exe");
  const payload = path.join(root, "installer-payload");
  await fs.access(installer);
  execFileSync(sevenZip, ["e", installer, "$PLUGINSDIR\\app-64.7z", `-o${payload}`, "-y"], { windowsHide: true, stdio: "pipe" });
  execFileSync(sevenZip, ["x", path.join(payload, "app-64.7z"), `-o${install}`, "-y"], { windowsHide: true, stdio: "pipe" });
  const resources = path.join(install, "resources");
  const appCode = path.join(root, "app-code");
  asar.extractAll(path.join(resources, "app.asar"), appCode);
  const fromApp = (file) => require(path.join(appCode, "src", file));
  const packageInfo = JSON.parse(await fs.readFile(path.join(appCode, "package.json"), "utf8"));
  assert.equal(packageInfo.version, require("../package.json").version);
  for (const file of ["index.html", "app.js", "styles.css", "helpContent.js", "duplicateReview.js", "activityHistory.js", "authenticator.js", "csvImport.js", "csvImportReview.js", "save-login.html", "save-login.css", "save-login.js"]) {
    assert.deepEqual(await fs.readFile(path.join(appCode, "src/renderer", file)),
      await fs.readFile(path.join(__dirname, "../src/renderer", file)), `installed Settings renderer is current: ${file}`);
  }
  for (const file of ["main.js", "preload.js", "saveLoginPreload.js", "services/browserSavePrompt.js", "services/automaticBackups.js", "services/vaultStore.js", "services/sqliteVault.js", "services/vaultHealth.js", "services/credentialTrash.js", "services/duplicateReview.js", "services/activityHistory.js", "services/authenticator.js", "services/authenticatorQr.js", "services/authenticatorWorker.js", "services/totp.js", "services/vaultOperationContext.js", "services/ipcGuards.js", "services/fsUtils.js"]) {
    assert.deepEqual(await fs.readFile(path.join(appCode, "src", file)),
      await fs.readFile(path.join(__dirname, "../src", file)), `installed desktop code is current: ${file}`);
  }
  for (const file of await fs.readdir(path.join(__dirname, "../extension"))) {
    if (!/\.(js|json|html|css)$/.test(file)) continue;
    assert.deepEqual(await fs.readFile(path.join(resources, "extension", file)),
      await fs.readFile(path.join(__dirname, "../extension", file)), `installed extension is current: ${file}`);
  }
  const archiveFiles = asar.listPackage(path.join(resources, "app.asar"));
  assert.equal(archiveFiles.some((file) => /[\\/]\.tmp[\\/]|vault-auth\.json|vault-data\.slv$/.test(file)), false);

  const { createBrowserSetup } = fromApp("services/browserSetup");
  const { createVaultStore } = fromApp("services/vaultStore");
  const { createPairing } = fromApp("services/extensionPairing");
  const { createExtensionHandlers } = fromApp("services/extensionHandlers");
  const { createExtensionBridge } = fromApp("services/extensionBridge");
  const { getPipeName } = fromApp("native-host/pipeName");
  const { encodeMessage, createMessageReader } = fromApp("native-host/framing");
  const { ALLOWED_EXTENSION_IDS, FIREFOX_EXTENSION_ID } = fromApp("native-host/config");
  const registration = fromApp("native-host/registration");
  process.env.SLV_PIPE_USER = `packaged-${process.pid}`;
  const pipeName = getPipeName(process.env.SLV_PIPE_USER);
  const registry = fakeRegistry();
  const runtimePath = path.join(install, "Secure Login Vault.exe");
  const setup = createBrowserSetup({
    packaged: true, resourcesPath: resources, appPath: path.join(root, "absent-project"),
    runtimePath, localAppData: path.join(root, "User"), platform: "win32",
    runReg: registry.runReg, openPath: async () => ""
  });
  const ready = await setup.setup(); // real packaged runtime, real host, fake registry
  assert.equal(ready.ready, true);
  const firefox = process.argv.includes("--firefox");
  const manifestPath = [...registry.values.entries()].find(([key]) => key.includes(firefox ? "Mozilla" : "Google"))[1];
  for (const file of await fs.readdir(path.join(resources, "extension-firefox"))) {
    if (!/\.(js|json|html|css)$/.test(file)) continue;
    assert.deepEqual(await fs.readFile(path.join(resources, "extension-firefox", file)), await fs.readFile(path.join(__dirname, "../dist/firefox", file)), "packaged Firefox " + file);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const launcher = await fs.readFile(manifest.path, "utf8");
  assert.ok(launcher.includes(runtimePath));
  assert.ok(launcher.includes(path.join(resources, "native-host", "host.js")));
  assert.equal(launcher.includes("node_modules"), false);
  assert.equal(launcher.includes("\\src\\"), false);
  assert.equal((await registration.selfTest({ launcherPath: manifest.path, origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/" })).error, "origin-not-allowed");
  console.log("PASS relocated package includes the extension and standalone helper, rejects other extensions, and uses the shipped runtime");

  const vault = createVaultStore(path.join(root, "Vault"));
  const master = "packaged test master password";
  await vault.createVault({ masterPassword: master, confirmPassword: master });
  let secret;
  const pairing = createPairing({ storage: { load: () => secret, save: (value) => { secret = value; }, clear: () => { secret = null; } } });
  const bridge = createExtensionBridge({ pipeName, handlers: createExtensionHandlers({
    getAppVersion: () => packageInfo.version, pairing,
    vault: {
      getCredentials: () => vault.getAllCredentials(),
      addCredential: (data) => vault.createBrowserCredential(data, { groupName: "", category: "Other", activeGroup: "" }),
      updatePassword: (id, password) => vault.updateBrowserPassword(id, password)
    }, approveSave: async () => true
  }) });
  await bridge.start();
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot, "System32") };
  delete env.ELECTRON_RUN_AS_NODE;
  const caller = firefox ? `"${manifestPath}" "${FIREFOX_EXTENSION_ID}"` : `"chrome-extension://${ALLOWED_EXTENSION_IDS[0]}/"`;
  const child = spawn(`"${manifest.path}" ${caller}`, { shell: true, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0;
  const reader = createMessageReader({ onMessage: (message) => {
    const waiter = pending.get(message.id);
    if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
  }, onError: () => { throw new Error("Invalid native response"); } });
  child.stdout.on("data", (data) => reader.push(data));
  const conn = { request(message) {
    return new Promise((resolve, reject) => {
      const id = message.id || `packaged-${++nextId}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native request timed out: ${message.type}`)); }, 10000);
      pending.set(id, { resolve, timer });
      child.stdin.write(encodeMessage({ ...message, id }));
    });
  } };
  try {
    const paired = await pair(conn, pairing.startPairing().code, { browserName: firefox ? "Firefox" : "Google Chrome" });
    assert.equal(paired.finish.ok, true);
    const peer = await pair(conn, pairing.startPairing().code, { browserName: firefox ? "Google Chrome" : "Firefox" });
    assert.equal(peer.finish.ok, true);
    assert.equal(pairing.list().length, 2, "packaged app preserves both browser pairings");
    assert.equal((await authenticate(conn, paired.secret)).finish.ok, true);
    pairing.unpair(pairing.list().find(browser => browser.name === (firefox ? "Google Chrome" : "Firefox")).id);
    assert.equal((await conn.request({ type: "channel-check" })).ok, true, "packaged active browser survives removing its peer");
    const login = { type: "save-login", url: "https://example.test", username: "packaged-user", password: "dummy-first" };
    assert.equal((await conn.request({ ...login, type: "inspect-login" })).mode, "add");
    assert.equal((await conn.request(login)).mode, "add");
    assert.equal((await conn.request({ ...login, type: "inspect-login" })).mode, "unchanged");
    assert.equal((await conn.request({ ...login, type: "inspect-login", password: "dummy-updated" })).mode, "update");
    const list = await conn.request({ type: "find-logins", url: login.url });
    assert.equal(list.logins.length, 1);
    const id = list.logins[0].id;
    const fetched = await conn.request({ type: "get-login", url: login.url, loginId: id });
    assert.equal(fetched.password, login.password);
    // Use the filler shipped inside the installer, against a representative form.
    const dom = new JSDOM('<input autocomplete="username"><input type="password">', { url: login.url, runScripts: "outside-only" });
    dom.window.eval(await fs.readFile(path.join(resources, "extension", "fillInPage.js"), "utf8"));
    const filled = dom.window.slvFillInPage(login.url, fetched, { submit: false, layout: false });
    assert.equal(filled.status, "filled");
    assert.equal(dom.window.document.querySelector('input[type="password"]').value, login.password);
    dom.window.close();
    assert.equal((await conn.request({ ...login, password: "dummy-updated" })).mode, "update");
    assert.equal((await vault.getPasswordHistory(id))[0].password, login.password, "browser updates preserve the previous password");
    assert.deepEqual((await vault.getActivityHistory({ source: "browser" })).entries.map(entry => entry.event), ["password_updated", "added"], "packaged browser writes record activity without secret values");
    assert.equal((await vault.getAllCredentials()).length, 1);
    const health = await vault.checkVaultHealth();
    assert.equal(health.total, 1);
    assert.equal(JSON.stringify(health).includes("dummy-updated"), false, "health report excludes password values");
    vault.lockVault();
    await assert.rejects(vault.checkVaultHealth(), /locked|unlock/i);
    assert.equal((await conn.request({ type: "get-login", url: login.url, loginId: id })).error, "locked");
    assert.equal((await conn.request(login)).error, "locked");
    await vault.unlockVault({ masterPassword: master });
    assert.equal((await conn.request({ type: "get-login", url: login.url, loginId: id })).password, "dummy-updated");
    console.log(`PASS packaged ${firefox ? "Firefox" : "Chromium"} native transport: pairing, authentication, save, fill, update, lock and encrypted persistence (no Node.js on helper PATH)`);
  } finally {
    child.stdin.end();
    for (const waiter of pending.values()) clearTimeout(waiter.timer);
    await bridge.stop();
  }
}
setTimeout(() => { console.error("Packaged browser test timed out"); process.exit(1); }, 120000).unref();
main().catch((error) => { console.error(error); process.exitCode = 1; });
