// Checks what the app does with the saved "Browser extension" choice at startup.
//   npm run test:startup
// It launches the real app several times (each with its own throwaway data folder
// and pipe) and checks whether the browser connection comes up.
const assert = require("assert");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { testTempRoot } = require("./testTemp");
const { spawn } = require("child_process");
const { app, BrowserWindow } = require("electron");
const { encodeMessage, createMessageReader } = require("../src/native-host/framing");
const { getPipeName } = require("../src/native-host/pipeName");

const args = process.argv.slice(2);
const isChild = args[0] === "child";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pingPipe(pipeName, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    const reader = createMessageReader({
      onMessage(value) { socket.destroy(); resolve(value); },
      onError: reject
    });
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("error", reject);
    socket.once("connect", () => socket.write(encodeMessage({ id: 1, type: "ping" })));
    setTimeout(() => { socket.destroy(); reject(new Error("no reply")); }, timeoutMs);
  });
}

// ── Child: one app launch ─────────────────────────────────────────────────────
async function runChild() {
  const [, mode, userDataDir] = args;
  app.setPath("userData", userDataDir);
  require("../src/main.js");
  await app.whenReady();

  const pipeName = getPipeName(process.env.SLV_PIPE_USER);
  while (BrowserWindow.getAllWindows().length === 0) await sleep(50);
  const win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once("did-finish-load", r));
  const status = () => win.webContents.executeJavaScript(`window.secureLoginVault.settings.getExtensionBridge()`);

  if (mode === "enabled") {
    // Give the bridge time to come up, then it must answer.
    let pong = null;
    for (let i = 0; i < 40 && !pong; i += 1) {
      pong = await pingPipe(pipeName).catch(() => null);
      if (!pong) await sleep(200);
    }
    assert.ok(pong && pong.type === "pong", "the saved On setting must start the connection");
    assert.deepEqual((await status()).result, { enabled: true, askBeforeFill: false, running: true, error: "" });
  } else if (mode === "taken") {
    // The pipe is already used by something else: the app must stay up and say so.
    await sleep(1500);
    const result = (await status()).result;
    assert.equal(result.enabled, true);
    assert.equal(result.running, false);
    assert.match(result.error, /Another copy of Secure Login Vault/);
    // The user can switch it off, and that works.
    const off = await win.webContents.executeJavaScript(`window.secureLoginVault.settings.setExtensionBridge({ enabled: false })`);
    assert.deepEqual(off.result, { enabled: false, askBeforeFill: false, running: false, error: "" });
    // Turning it on while the pipe is still taken fails cleanly and is not saved as on.
    const on = await win.webContents.executeJavaScript(`window.secureLoginVault.settings.setExtensionBridge({ enabled: true })`);
    assert.equal(on.ok, false);
    assert.match(on.message, /Another copy of Secure Login Vault/);
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, "extension-settings.json"), "utf8"));
    assert.deepEqual(saved, { enabled: false, askBeforeFill: false });
  } else {
    // default, disabled, corrupt: stays off
    await sleep(2500);
    await assert.rejects(() => pingPipe(pipeName), "nothing may listen");
    assert.deepEqual((await status()).result, { enabled: false, askBeforeFill: false, running: false, error: "" });
  }
}

// ── Parent: runs each scenario in its own app process ─────────────────────────
function launch(mode, userDataDir, pipeUser) {
  return new Promise((resolve) => {
    const env = { ...process.env, SLV_PIPE_USER: pipeUser };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [__filename, "child", mode, userDataDir], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => { child.kill(); resolve({ code: -1, output: output + "\n(timed out)" }); }, 60000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function runParent() {
  await app.whenReady();
  const results = [];

  const scenarios = [
    { name: "saved On: the connection starts with the app", mode: "enabled", file: JSON.stringify({ enabled: true }) },
    { name: "no saved choice: stays off", mode: "default", file: null },
    { name: "saved Off: stays off", mode: "disabled", file: JSON.stringify({ enabled: false }) },
    { name: "unreadable file: stays off", mode: "corrupt", file: "not json {{{" },
    { name: "wrong type in file: stays off", mode: "corrupt", file: JSON.stringify({ enabled: "true" }) },
    { name: "pipe already taken: app stays up and explains", mode: "taken", file: JSON.stringify({ enabled: true }), occupyPipe: true }
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const dir = fs.mkdtempSync(path.join(testTempRoot(), "slv-startup-"));
    if (scenario.file !== null) fs.writeFileSync(path.join(dir, "extension-settings.json"), scenario.file);

    const pipeUser = `startup-${process.pid}-${index}`;
    let blocker = null;
    if (scenario.occupyPipe) {
      blocker = net.createServer(() => {});
      await new Promise((resolve) => blocker.listen(getPipeName(pipeUser), resolve));
    }

    const { code, output } = await launch(scenario.mode, dir, pipeUser);
    if (blocker) blocker.close();
    fs.rmSync(dir, { recursive: true, force: true });

    if (code === 0) {
      results.push(`PASS  ${scenario.name}`);
    } else {
      results.push(`FAIL  ${scenario.name}\n      exit ${code}: ${output.trim().split("\n").slice(-6).join("\n      ")}`);
      process.exitCode = 1;
    }
  }

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nstartup tests FAILED" : "\nstartup tests passed");
  app.exit(process.exitCode || 0);
}

app.on("window-all-closed", () => {}); // never quit just because a window closed

const entry = isChild ? runChild() : runParent();
entry
  .then(() => {
    if (isChild) app.exit(0);
  })
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  });

setTimeout(() => {
  console.error("startup test timed out");
  app.exit(1);
}, isChild ? 55000 : 400000);
