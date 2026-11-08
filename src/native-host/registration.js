const fs = require("fs/promises");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { encodeMessage, createMessageReader } = require("./framing");

// Registers the browser helper (host.js) with Chrome and Edge so the extension can
// start it. For each browser that means:
//   1. a launcher (.bat) that runs the helper with the app's own Electron in
//      plain-Node mode, so no separate Node install is needed;
//   2. a manifest (.json) that names the launcher and lists the ONLY extension
//      allowed to use it ("allowed_origins");
//   3. a per-user registry value pointing the browser at that manifest.
// Everything is per user (HKCU, %LOCALAPPDATA%): no administrator rights.
//
// Threat note: the launcher and manifest live in a folder only this user can write,
// like any native messaging host. A program already running as this user could edit
// them, but such a program can already edit the user's registry and files too.

const HOST_NAME = "com.securelogin.vault";
const HOST_DESCRIPTION = "Secure Login Vault browser helper";

const BROWSERS = [
  { id: "chrome", label: "Google Chrome", keyRoot: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" },
  { id: "edge", label: "Microsoft Edge", keyRoot: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts" }
];

const EXTENSION_ID = /^[a-p]{32}$/;
const HOST_NAME_RULE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/; // Chrome's rule for native host names

function assertHostName(hostName) {
  if (typeof hostName !== "string" || !HOST_NAME_RULE.test(hostName)) {
    throw new Error("Invalid helper name.");
  }
}

function assertUsablePath(value, what) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /["\r\n\0]/.test(value)) {
    throw new Error(`${what} is not a usable absolute path.`);
  }
}

function registryKey(browser, hostName) {
  return `${browser.keyRoot}\\${hostName}`;
}

function buildHostManifest({ launcherPath, allowedExtensionIds, hostName = HOST_NAME }) {
  assertHostName(hostName);
  assertUsablePath(launcherPath, "The launcher");

  if (!Array.isArray(allowedExtensionIds) || allowedExtensionIds.length === 0) {
    throw new Error("At least one allowed extension is required.");
  }
  for (const id of allowedExtensionIds) {
    if (typeof id !== "string" || !EXTENSION_ID.test(id)) {
      throw new Error("An extension ID is not valid.");
    }
  }

  return {
    name: hostName,
    description: HOST_DESCRIPTION,
    path: launcherPath,
    type: "stdio",
    allowed_origins: allowedExtensionIds.map((id) => `chrome-extension://${id}/`)
  };
}

// Runs the helper with Electron acting as plain Node. %* passes through what the
// browser supplies (the calling extension's origin).
function buildLauncher({ runtimePath, hostScriptPath }) {
  assertUsablePath(runtimePath, "The runtime");
  assertUsablePath(hostScriptPath, "The helper script");

  // In a .bat file a literal % must be written %%; inside quotes everything else
  // in a Windows path is literal.
  const quoted = (value) => `"${value.replace(/%/g, "%%")}"`;

  return [
    "@echo off",
    "set ELECTRON_RUN_AS_NODE=1",
    `${quoted(runtimePath)} ${quoted(hostScriptPath)} %*`,
    ""
  ].join("\r\n");
}

function defaultRunReg(args) {
  return new Promise((resolve) => {
    execFile("reg", args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// "(Default)    REG_SZ    C:\path\file.json"  ->  "C:\path\file.json"
function parseRegValue(stdout) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /REG_SZ\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

function filesFor(installDir, hostName) {
  return {
    launcherPath: path.join(installDir, `${hostName}.bat`),
    manifestPath: path.join(installDir, `${hostName}.json`)
  };
}

async function writeFileAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function register({
  installDir,
  runtimePath,
  hostScriptPath,
  allowedExtensionIds,
  hostName = HOST_NAME,
  runReg = defaultRunReg,
  browsers = BROWSERS
}) {
  assertHostName(hostName);
  assertUsablePath(installDir, "The install folder");
  assertUsablePath(runtimePath, "The runtime");
  assertUsablePath(hostScriptPath, "The helper script");

  await fs.access(runtimePath).catch(() => {
    throw new Error(`The runtime was not found: ${runtimePath}`);
  });
  await fs.access(hostScriptPath).catch(() => {
    throw new Error(`The helper script was not found: ${hostScriptPath}`);
  });

  const { launcherPath, manifestPath } = filesFor(installDir, hostName);
  const manifest = buildHostManifest({ launcherPath, allowedExtensionIds, hostName });
  const launcher = buildLauncher({ runtimePath, hostScriptPath });

  await fs.mkdir(installDir, { recursive: true });
  await writeFileAtomic(launcherPath, launcher);
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const registered = [];
  for (const browser of browsers) {
    const result = await runReg(["add", registryKey(browser, hostName), "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
    if (!result.ok) {
      throw new Error(`Could not register with ${browser.label}.`);
    }
    registered.push(browser.id);
  }

  return { launcherPath, manifestPath, registered };
}

async function unregister({ installDir, hostName = HOST_NAME, runReg = defaultRunReg, browsers = BROWSERS }) {
  assertHostName(hostName);
  assertUsablePath(installDir, "The install folder");

  const removed = [];
  for (const browser of browsers) {
    const key = registryKey(browser, hostName);
    const exists = (await runReg(["query", key, "/ve"])).ok;
    if (!exists) continue; // nothing to remove
    const result = await runReg(["delete", key, "/f"]);
    if (!result.ok) {
      throw new Error(`Could not remove the registration for ${browser.label}.`);
    }
    removed.push(browser.id);
  }

  // Only the two files this module creates, and the folder if that leaves it empty.
  const { launcherPath, manifestPath } = filesFor(installDir, hostName);
  await fs.rm(launcherPath, { force: true });
  await fs.rm(manifestPath, { force: true });
  await fs.rmdir(installDir).catch(() => {});

  return { removed };
}

async function status({
  installDir,
  allowedExtensionIds,
  hostName = HOST_NAME,
  runReg = defaultRunReg,
  browsers = BROWSERS
}) {
  assertHostName(hostName);
  const { launcherPath, manifestPath } = filesFor(installDir, hostName);
  const exists = (file) => fs.access(file).then(() => true, () => false);
  const expectedOrigins = (allowedExtensionIds || []).map((id) => `chrome-extension://${id}/`);

  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    manifest = null;
  }

  const launcherExists = await exists(launcherPath);
  const report = [];

  for (const browser of browsers) {
    const query = await runReg(["query", registryKey(browser, hostName), "/ve"]);
    const registeredPath = query.ok ? parseRegValue(query.stdout) : null;
    const problems = [];

    if (!registeredPath) problems.push("not registered");
    else if (path.resolve(registeredPath).toLowerCase() !== path.resolve(manifestPath).toLowerCase()) {
      problems.push("registered, but pointing at a different helper");
    }
    if (registeredPath && !manifest) problems.push("manifest file is missing or unreadable");
    if (manifest) {
      const origins = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
      if (JSON.stringify([...origins].sort()) !== JSON.stringify([...expectedOrigins].sort())) {
        problems.push("allowed extensions differ from this version");
      }
      if (path.resolve(String(manifest.path)).toLowerCase() !== path.resolve(launcherPath).toLowerCase()) {
        problems.push("manifest points at a different launcher");
      }
    }
    if (registeredPath && !launcherExists) problems.push("launcher file is missing");

    report.push({ browser: browser.id, label: browser.label, registered: Boolean(registeredPath), ok: problems.length === 0, problems });
  }

  return { browsers: report, launcherPath, manifestPath };
}

// Starts the helper exactly as a browser would (through the launcher, with the
// extension's origin), sends one ping, and returns the helper's answer. The answer
// is either the app's pong or { error: "app-not-running" }; both prove the launcher,
// the runtime and the helper work. A wrong origin gives "origin-not-allowed".
function selfTest({ launcherPath, origin, timeoutMs = 15000 }) {
  assertUsablePath(launcherPath, "The launcher");
  // The command line is built as one string (a .bat file needs a shell), so only
  // plain URL characters are accepted in what goes into it.
  if (typeof origin !== "string" || !/^[A-Za-z0-9:/._-]*$/.test(origin)) {
    throw new Error("The origin contains characters that are not allowed.");
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // the launcher sets what it needs
    const child = spawn(`"${launcherPath}" "${origin}"`, { shell: true, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close the helper's input the way a browser does so it exits by itself;
      // killing the launcher is only a fallback.
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      const fallback = setTimeout(() => child.kill(), 2000);
      fallback.unref();
      child.once("exit", () => clearTimeout(fallback));
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("The helper did not answer in time.")), timeoutMs);

    const reader = createMessageReader({
      onMessage: (value) => finish(null, value),
      onError: () => finish(new Error("The helper sent an unreadable answer."))
    });
    child.stdout.on("data", (chunk) => reader.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("exit", () => finish(new Error("The helper exited without answering.")));

    child.stdin.write(encodeMessage({ id: "self-test", type: "ping" }));
  });
}

module.exports = {
  HOST_NAME,
  BROWSERS,
  registryKey,
  buildHostManifest,
  buildLauncher,
  parseRegValue,
  register,
  unregister,
  status,
  selfTest
};
