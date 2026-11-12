// Minimal Marionette client for an isolated, headless Firefox test profile.
const net = require("net");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launchFirefox(profile, executable = process.env.SLV_FIREFOX_PATH || "C:\\Program Files\\Mozilla Firefox\\firefox.exe") {
  await fs.access(executable);
  const port = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  await fs.mkdir(profile, { recursive: true });
  const prefs = { "marionette.port": port, "browser.shell.checkDefaultBrowser": false,
    "browser.startup.homepage_override.mstone": "ignore", "browser.startup.page": 0,
    "datareporting.policy.dataSubmissionEnabled": false, "toolkit.telemetry.enabled": false,
    "app.update.auto": false, "browser.aboutwelcome.enabled": false };
  await fs.writeFile(path.join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));
  const child = spawn(executable, ["-headless", "-no-remote", "-profile", profile, "-marionette", "--remote-allow-system-access", "about:blank"], { windowsHide: true, stdio: "ignore", env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } });
  let startupError;
  child.on("error", error => { startupError = error; });
  let socket;
  for (let i = 0; i < 100 && !socket; i++) {
    if (startupError) throw startupError;
    socket = await new Promise(resolve => {
      const candidate = net.createConnection({ host: "127.0.0.1", port });
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", () => { candidate.destroy(); resolve(null); });
    });
    if (!socket) await sleep(100);
  }
  if (!socket) { child.kill(); throw new Error("Firefox Marionette did not start"); }
  let buffer = Buffer.alloc(0), nextId = 0;
  const pending = new Map();
  socket.on("data", data => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) return;
      const size = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + size) return;
      const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size));
      buffer = buffer.subarray(colon + 1 + size);
      if (!Array.isArray(packet)) continue; // server greeting
      const waiter = pending.get(packet[1]);
      if (!waiter) continue;
      pending.delete(packet[1]); clearTimeout(waiter.timer);
      if (packet[2]) waiter.reject(new Error(JSON.stringify(packet[2]))); else waiter.resolve(packet[3]);
    }
  });
  function command(name, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Firefox command timed out: " + name)); }, 45000);
      pending.set(id, { resolve, reject, timer });
      const data = Buffer.from(JSON.stringify([0, id, name, params]));
      socket.write(Buffer.concat([Buffer.from(`${data.length}:`), data]));
    });
  }
  const client = { command,
    async script(script, args = [], async = false) {
      const result = await command(async ? "WebDriver:ExecuteAsyncScript" : "WebDriver:ExecuteScript", { script, args, newSandbox: false, sandbox: "default" });
      return result.value;
    },
    async close() {
      await command("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => {});
      socket.destroy();
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Firefox closed")); }
      if (child.exitCode === null) child.kill();
    }
  };
  try { await command("WebDriver:NewSession", { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } }); }
  catch (error) { await client.close(); throw error; }
  return client;
}
module.exports = { launchFirefox };
