// Full-stack test: starts the real app (src/main.js) with a throwaway data folder,
// then drives it through the same window.secureLoginVault API the UI uses.
//   npm run test:app
// It never touches your real vault, and it exits by itself.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { testTempRoot } = require("./testTemp");
const { app, BrowserWindow } = require("electron");

app.setPath("userData", fs.mkdtempSync(path.join(testTempRoot(), "slv-app-test-")));
// The browser connection uses a pipe named after the OS user; give the test its own
// so it can never collide with (or touch) a real running copy of the app.
process.env.SLV_PIPE_USER = `app-test-${process.pid}`;
require("../src/main.js");

const MASTER = "integration test master password";
const WP_PASS = "S3cret pw! &=%";

const posts = [];
const server = http.createServer((req, res) => {
  const respond = (body) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>t</title>${body}`);
  };
  if (req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      posts.push({ path: req.url, fields: Object.fromEntries(new URLSearchParams(raw)) });
      respond("<h1>Dashboard</h1>");
    });
  } else {
    respond(`<form method="post" action="${req.url}">
      <input type="text" name="log" autocomplete="username">
      <input type="password" name="pwd" autocomplete="current-password">
      <input type="submit" value="Log In"></form>`);
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

async function main() {
  await app.whenReady();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  await waitFor(() => BrowserWindow.getAllWindows().length >= 1, 15000, "the main window");
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (mainWindow.webContents.isLoading()) {
    await new Promise((resolve) => mainWindow.webContents.once("did-finish-load", resolve));
  }

  // Runs code in the app's page, where window.secureLoginVault exists.
  const inApp = (code) => mainWindow.webContents.executeJavaScript(`(async () => { ${code} })()`);
  const windowCount = () => BrowserWindow.getAllWindows().length;
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS  ${name}`);
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${error.message}`);
      process.exitCode = 1;
    }
  };

  // Locked vault: nothing opens.
  await check("refuses to sign in while the vault is locked", async () => {
    const response = await inApp(`return window.secureLoginVault.login.open({ kind: "credential", id: 1 });`);
    assert.equal(response.ok, false);
    assert.match(response.message, /locked/i);
    assert.equal(windowCount(), 1);
  });

  const created = await inApp(`return window.secureLoginVault.auth.createVault(${JSON.stringify({
    masterPassword: MASTER,
    confirmPassword: MASTER
  })});`);
  assert.equal(created.ok, true, "vault creation");

  const credentialId = (
    await inApp(`return window.secureLoginVault.credentials.add(${JSON.stringify({
      websiteName: "Local WP",
      websiteUrl: `${origin}/wp-login.php`,
      username: "wp-admin",
      password: WP_PASS,
      category: "WordPress"
    })});`)
  ).result.id;

  await check("Sign in opens the site and fills a saved credential", async () => {
    const before = windowCount();
    const response = await inApp(
      `return window.secureLoginVault.login.open({ kind: "credential", id: ${credentialId} });`
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.host, `127.0.0.1`);
    await waitFor(() => posts.length >= 1, 12000, "the login POST");
    assert.deepEqual(posts[0], { path: "/wp-login.php", fields: { log: "wp-admin", pwd: WP_PASS } });
    assert.equal(windowCount(), before + 1);
    // The page never received the password: the response carries no secrets.
    assert.equal(JSON.stringify(response).includes(WP_PASS), false);
  });

  const clientId = (
    await inApp(`return window.secureLoginVault.clients.add(${JSON.stringify({
      name: "Acme",
      adminUrl: `${origin}/acme-admin`,
      adminUsername: "acme-admin",
      adminPassword: "acme-pass",
      hostingUrl: "http://example.com/panel",
      hostingUsername: "h",
      hostingPassword: "hp"
    })});`)
  ).result.id;

  await check("Client Vault: WP Admin sign-in uses the admin fields", async () => {
    posts.length = 0;
    const response = await inApp(
      `return window.secureLoginVault.login.open({ kind: "client", id: ${clientId}, which: "admin" });`
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    await waitFor(() => posts.length >= 1, 12000, "the admin login POST");
    assert.deepEqual(posts[0], { path: "/acme-admin", fields: { log: "acme-admin", pwd: "acme-pass" } });
  });

  await check("plain-http sites are refused with an explanation", async () => {
    const before = windowCount();
    const response = await inApp(
      `return window.secureLoginVault.login.open({ kind: "client", id: ${clientId}, which: "hosting" });`
    );
    assert.equal(response.ok, false);
    assert.match(response.message, /plain http/);
    assert.equal(windowCount(), before, "no window is opened for a refused site");
  });

  await check("bad requests are refused", async () => {
    for (const payload of [
      `{ kind: "credential", id: "abc" }`,
      `{ kind: "credential", id: -4 }`,
      `{ kind: "bogus", id: 1 }`,
      `{ kind: "client", id: ${clientId}, which: "ftp" }`,
      `{ kind: "client", id: ${clientId}, which: "phpmyadmin" }`,
      `{ kind: "credential", id: 99999 }`,
      `null`,
      `"just a string"`
    ]) {
      const response = await inApp(`return window.secureLoginVault.login.open(${payload});`);
      assert.equal(response.ok, false, `${payload} should be refused`);
    }
  });

  // ── The buttons themselves, clicked in the real UI ─────────────────────────
  const pageValue = (code) => mainWindow.webContents.executeJavaScript(code);
  async function waitForPage(code, what, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await pageValue(code)) return;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for: ${what}`);
  }

  // Reload so the UI starts from the unlocked dashboard (the vault is still unlocked).
  mainWindow.webContents.reload();
  await new Promise((resolve) => mainWindow.webContents.once("did-finish-load", resolve));

  await check("UI: the Sign in button on a credential row opens and fills the site", async () => {
    await waitForPage(
      `!!document.querySelector('[data-action="sign-in"][data-id="${credentialId}"]')`,
      "the Sign in button on the credential row"
    );
    posts.length = 0;
    await pageValue(`document.querySelector('[data-action="sign-in"][data-id="${credentialId}"]').click()`);
    await waitFor(() => posts.length >= 1, 12000, "the login POST from the button");
    assert.deepEqual(posts[0], { path: "/wp-login.php", fields: { log: "wp-admin", pwd: WP_PASS } });
    await waitForPage(`!!document.querySelector(".toast-message")`, "the confirmation toast");
    assert.match(await pageValue(`document.querySelector(".toast-message").textContent`), /Opening 127\.0\.0\.1/);
  });

  await check("UI: client cards show Sign in only for sites with an address and a login", async () => {
    await pageValue(`document.querySelector("#open-client-vault-btn").click()`);
    await waitForPage(`!!document.querySelector(".client-card")`, "the client card");
    const labels = await pageValue(
      `Array.from(document.querySelectorAll('.client-card [data-action="client-sign-in"]')).map(function (b) { return b.textContent.trim(); })`
    );
    assert.deepEqual(labels, ["WP Admin", "Hosting"], "phpMyAdmin has no address, so it gets no button");
  });

  await check("UI: a client's WP Admin button signs in without opening the edit dialog", async () => {
    posts.length = 0;
    await pageValue(`document.querySelector('[data-action="client-sign-in"][data-which="admin"]').click()`);
    await waitFor(() => posts.length >= 1, 12000, "the admin login POST from the button");
    assert.deepEqual(posts[0], { path: "/acme-admin", fields: { log: "acme-admin", pwd: "acme-pass" } });
    const modalOpen = await pageValue(
      `!!document.querySelector("#client-modal-overlay.is-open, #client-modal-overlay .modal-container")`
    );
    assert.equal(modalOpen, false, "clicking Sign in must not open the client editor");
  });

  await check("UI: a refused sign-in shows the reason as a message", async () => {
    // Wait out the double-click guard and the earlier toast.
    await sleep(1000);
    await pageValue(`document.querySelectorAll(".toast").forEach(function (t) { t.remove(); })`);
    await pageValue(`document.querySelector('[data-action="client-sign-in"][data-which="hosting"]').click()`);
    await waitForPage(`!!document.querySelector(".toast--error")`, "the error toast");
    assert.match(await pageValue(`document.querySelector(".toast--error .toast-message").textContent`), /plain http/);
  });

  // ── Browser extension connection ───────────────────────────────────────────
  const { encodeMessage, createMessageReader } = require("../src/native-host/framing");
  const { getPipeName } = require("../src/native-host/pipeName");
  const net = require("net");
  const pipeName = getPipeName(process.env.SLV_PIPE_USER);
  const settingsFile = path.join(app.getPath("userData"), "extension-settings.json");

  // Asks the app "ping" through the real pipe. Resolves the reply, or rejects if nothing listens.
  const pingApp = () =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(pipeName);
      const reader = createMessageReader({
        onMessage(value) { socket.destroy(); resolve(value); },
        onError: reject
      });
      socket.on("data", (chunk) => reader.push(chunk));
      socket.on("error", reject);
      socket.once("connect", () => socket.write(encodeMessage({ id: 1, type: "ping" })));
      setTimeout(() => { socket.destroy(); reject(new Error("no reply")); }, 4000);
    });

  await check("browser extension connection is off by default and nothing listens", async () => {
    const status = await pageValue(`window.secureLoginVault.settings.getExtensionBridge()`);
    assert.deepEqual(status, { ok: true, result: { enabled: false, askBeforeFill: false, running: false, error: "" } });
    await assert.rejects(() => pingApp(), "the pipe must not exist while the switch is off");
    assert.equal(fs.existsSync(settingsFile), false);
  });

  await check("turning it on starts the connection, and the app answers a ping", async () => {
    const response = await pageValue(`window.secureLoginVault.settings.setExtensionBridge({ enabled: true })`);
    assert.deepEqual(response, { ok: true, result: { enabled: true, askBeforeFill: false, running: true, error: "" } });
    const pong = await pingApp();
    assert.equal(pong.ok, true);
    assert.equal(pong.type, "pong");
    assert.equal(pong.appVersion, app.getVersion());
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), { enabled: true, askBeforeFill: false });
  });

  await check("turning it off closes the connection", async () => {
    const response = await pageValue(`window.secureLoginVault.settings.setExtensionBridge({ enabled: false })`);
    assert.deepEqual(response, { ok: true, result: { enabled: false, askBeforeFill: false, running: false, error: "" } });
    await assert.rejects(() => pingApp());
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), { enabled: false, askBeforeFill: false });
  });

  await check("invalid on/off requests are refused and change nothing", async () => {
    for (const payload of [`{ enabled: "yes" }`, `{ enabled: 1 }`, `{}`, `null`, `"on"`]) {
      const response = await pageValue(`window.secureLoginVault.settings.setExtensionBridge(${payload})`);
      assert.equal(response.ok, false, payload);
    }
    const status = await pageValue(`window.secureLoginVault.settings.getExtensionBridge()`);
    assert.equal(status.result.running, false);
  });

  await check("UI: the Settings switch turns the connection on and off", async () => {
    mainWindow.webContents.reload();
    await new Promise((resolve) => mainWindow.webContents.once("did-finish-load", resolve));
    await waitForPage(`!!document.querySelector("#open-settings-btn")`, "the dashboard");
    await pageValue(`document.querySelector("#open-settings-btn").click()`);
    await waitForPage(
      `(function () { var s = document.querySelector("#extension-bridge-select"); return !!s && !s.disabled; })()`,
      "the Browser Extension switch to be ready"
    );
    assert.equal(await pageValue(`document.querySelector("#extension-bridge-select").value`), "off");

    await pageValue(`(function () {
      var s = document.querySelector("#extension-bridge-select");
      s.value = "on";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitForPage(
      `document.querySelector("#extension-bridge-hint").textContent.indexOf("can connect") !== -1`,
      "the hint to say the extension can connect"
    );
    assert.equal((await pingApp()).ok, true, "the app answers after switching on in the UI");

    await pageValue(`(function () {
      var s = document.querySelector("#extension-bridge-select");
      s.value = "off";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitForPage(
      `document.querySelector("#extension-bridge-hint").textContent.indexOf("Off by default") !== -1`,
      "the hint to go back to off"
    );
    await assert.rejects(() => pingApp(), "nothing listens after switching off in the UI");
  });

  await check("locking the vault closes every login window", async () => {
    assert.ok(windowCount() >= 3, "login windows should still be open from earlier");
    const response = await inApp(`return window.secureLoginVault.auth.lockVault();`);
    assert.equal(response.locked, true);
    await waitFor(() => windowCount() === 1, 3000, "login windows to close");
    const again = await inApp(`return window.secureLoginVault.login.open({ kind: "credential", id: ${credentialId} });`);
    assert.equal(again.ok, false);
  });

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\napp integration tests FAILED" : "\napp integration tests passed");
  server.close();
  app.exit(process.exitCode || 0);
}

setTimeout(() => {
  console.error("app integration test timed out");
  app.exit(1);
}, 120000);

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
