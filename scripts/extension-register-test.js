const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { testTempRoot } = require("./testTemp");
const { execFileSync } = require("child_process");
const registration = require("../src/native-host/registration");
const { ALLOWED_EXTENSION_IDS } = require("../src/native-host/config");

const { HOST_NAME, BROWSERS, buildHostManifest, buildLauncher, parseRegValue, register, unregister, status, selfTest } = registration;

// A watchdog: a hang counts as a failure.
setTimeout(() => {
  console.error("extension-register test timed out");
  process.exit(1);
}, 120000).unref();

const IDS = ["abcdefghijklmnopabcdefghijklmnop"];
const tempRoots = [];
function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(testTempRoot(), `${name}-`));
  tempRoots.push(dir);
  return dir;
}

// A stand-in for reg.exe: keeps values in memory and records every call.
function fakeRegistry() {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    async runReg(args) {
      calls.push(args);
      const [command, key] = args;
      if (command === "add") {
        values.set(key, args[args.indexOf("/d") + 1]);
        return { ok: true, stdout: "", stderr: "" };
      }
      if (command === "query") {
        return values.has(key)
          ? { ok: true, stdout: `\r\n${key}\r\n    (Default)    REG_SZ    ${values.get(key)}\r\n\r\n`, stderr: "" }
          : { ok: false, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
      }
      if (command === "delete") {
        const had = values.delete(key);
        return { ok: had, stdout: "", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unknown" };
    }
  };
}

// A runtime and helper script that merely have to exist (for the fake-registry tests).
function fakeInstallSources() {
  const dir = tempDir("slv-reg-src");
  const runtimePath = path.join(dir, "runtime.exe");
  const hostScriptPath = path.join(dir, "host.js");
  fs.writeFileSync(runtimePath, "");
  fs.writeFileSync(hostScriptPath, "");
  return { runtimePath, hostScriptPath };
}

async function main() {
  // ── Host manifest ──────────────────────────────────────────────────────────
  {
    const manifest = buildHostManifest({ launcherPath: "C:\\Users\\me\\launcher.bat", allowedExtensionIds: IDS });
    assert.deepEqual(manifest, {
      name: "com.securelogin.vault",
      description: "Secure Login Vault browser helper",
      path: "C:\\Users\\me\\launcher.bat",
      type: "stdio",
      allowed_origins: [`chrome-extension://${IDS[0]}/`]
    });

    assert.equal(
      buildHostManifest({ launcherPath: "C:\\x.bat", allowedExtensionIds: [IDS[0], "ponmlkjihgfedcbaponmlkjihgfedcba"] }).allowed_origins.length,
      2
    );

    for (const bad of [[], undefined, null, "id", [""], ["short"], ["ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"], ["*"], ["abcdefghijklmnopabcdefghijklmnoq"], [IDS[0], "*"], [`chrome-extension://${IDS[0]}/`]]) {
      assert.throws(() => buildHostManifest({ launcherPath: "C:\\x.bat", allowedExtensionIds: bad }), undefined, JSON.stringify(bad));
    }
    for (const bad of ["relative.bat", "", null, 'C:\\a"b.bat', "C:\\a\nb.bat"]) {
      assert.throws(() => buildHostManifest({ launcherPath: bad, allowedExtensionIds: IDS }), undefined, JSON.stringify(bad));
    }
    for (const bad of ["Bad Name", "UPPER", "a..b", ".a", "a.", "", "a/b", "a\\b", "..\\x"]) {
      assert.throws(() => buildHostManifest({ launcherPath: "C:\\x.bat", allowedExtensionIds: IDS, hostName: bad }), /Invalid helper name/, bad);
    }
  }

  // ── Launcher ───────────────────────────────────────────────────────────────
  {
    const launcher = buildLauncher({ runtimePath: "C:\\Program Files\\App\\app.exe", hostScriptPath: "C:\\App Data\\src\\host.js" });
    assert.equal(launcher, '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\App\\app.exe" "C:\\App Data\\src\\host.js" %*\r\n');

    // % would be expanded by cmd.exe, so it must be doubled; other special characters stay inside quotes
    const tricky = buildLauncher({ runtimePath: "C:\\100%\\a (x86)&b\\app.exe", hostScriptPath: "C:\\u^s!er\\h.js" });
    assert.ok(tricky.includes('"C:\\100%%\\a (x86)&b\\app.exe"'));
    assert.ok(tricky.includes('"C:\\u^s!er\\h.js"'));
    assert.ok(tricky.endsWith(" %*\r\n"));
    assert.equal(tricky.includes("\n") && !tricky.replace(/\r\n/g, "").includes("\n"), true, "CRLF line endings only");

    for (const bad of ['C:\\a"b\\app.exe', "rel\\app.exe", "C:\\a\r\nb.exe", ""]) {
      assert.throws(() => buildLauncher({ runtimePath: bad, hostScriptPath: "C:\\h.js" }), /usable absolute path/, JSON.stringify(bad));
      assert.throws(() => buildLauncher({ runtimePath: "C:\\a.exe", hostScriptPath: bad }), /usable absolute path/, JSON.stringify(bad));
    }
  }

  // ── Reading reg.exe output ─────────────────────────────────────────────────
  assert.equal(parseRegValue("\r\nHKEY\\x\r\n    (Default)    REG_SZ    C:\\a b\\c.json\r\n"), "C:\\a b\\c.json");
  assert.equal(parseRegValue("    (Predeterminado)    REG_SZ    C:\\x.json  \r\n"), "C:\\x.json", "any language, trailing space trimmed");
  assert.equal(parseRegValue("nothing here"), null);
  assert.equal(parseRegValue(""), null);

  // ── Browsers and keys ──────────────────────────────────────────────────────
  assert.deepEqual(BROWSERS.map((b) => b.id), ["chrome", "edge", "firefox"]);
  assert.equal(registration.registryKey(BROWSERS[0], HOST_NAME), "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.securelogin.vault");
  assert.equal(registration.registryKey(BROWSERS[1], HOST_NAME), "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.securelogin.vault");
  assert.ok(BROWSERS.every((b) => b.keyRoot.startsWith("HKCU\\")), "per-user keys only, never HKLM");

  // ── register / status / unregister (fake registry) ─────────────────────────
  {
    const reg = fakeRegistry();
    const installDir = path.join(tempDir("slv-reg-dir"), "native host");
    const sources = fakeInstallSources();
    const args = { installDir, ...sources, allowedExtensionIds: IDS, runReg: reg.runReg };

    // nothing yet
    let report = await status({ installDir, allowedExtensionIds: IDS, runReg: reg.runReg });
    assert.deepEqual(report.browsers.map((b) => [b.browser, b.registered, b.ok]), [["chrome", false, false], ["edge", false, false], ["firefox", false, false]]);

    const result = await register(args);
    assert.deepEqual(result.registered, ["chrome", "edge", "firefox"]);
    assert.equal(result.launcherPath, path.join(installDir, "com.securelogin.vault.bat"));
    assert.equal(result.manifestPath, path.join(installDir, "com.securelogin.vault.json"));

    // the files hold what they should
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.path, result.launcherPath);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${IDS[0]}/`]);
    assert.equal(fs.readFileSync(result.launcherPath, "utf8"), buildLauncher(sources));

    // exactly two registry writes, for the right keys, with the manifest path as data and no shell involved
    const adds = reg.calls.filter((c) => c[0] === "add");
    assert.equal(adds.length, 3);
    assert.deepEqual(adds[0], ["add", registration.registryKey(BROWSERS[0], HOST_NAME), "/ve", "/t", "REG_SZ", "/d", result.manifestPath, "/f"]);
    assert.deepEqual(adds[1], ["add", registration.registryKey(BROWSERS[1], HOST_NAME), "/ve", "/t", "REG_SZ", "/d", result.manifestPath, "/f"]);

    report = await status({ installDir, allowedExtensionIds: IDS, runReg: reg.runReg });
    assert.ok(report.browsers.every((b) => b.registered && b.ok), JSON.stringify(report));

    // registering again is harmless and refreshes the files
    await register(args);
    assert.equal(reg.values.size, 3);

    // status notices problems
    fs.writeFileSync(result.manifestPath, JSON.stringify({ ...manifest, allowed_origins: ["chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/"] }));
    report = await status({ installDir, allowedExtensionIds: IDS, runReg: reg.runReg });
    assert.ok(report.browsers.filter(b => b.browser !== "firefox").every((b) => b.problems.includes("allowed extensions differ from this version")));

    await register(args);
    fs.rmSync(result.launcherPath);
    report = await status({ installDir, allowedExtensionIds: IDS, runReg: reg.runReg });
    assert.ok(report.browsers.every((b) => b.problems.includes("launcher file is missing")));

    await register(args);
    reg.values.set(registration.registryKey(BROWSERS[0], HOST_NAME), "C:\\somewhere\\else.json");
    report = await status({ installDir, allowedExtensionIds: IDS, runReg: reg.runReg });
    assert.ok(report.browsers[0].problems.some((p) => /different helper/.test(p)));
    assert.equal(report.browsers[1].ok, true);

    // unregister removes the keys and our two files, and leaves other files alone
    await register(args);
    const bystander = path.join(installDir, "keep-me.txt");
    fs.writeFileSync(bystander, "not ours");
    const removed = await unregister({ installDir, runReg: reg.runReg });
    assert.deepEqual(removed.removed, ["chrome", "edge", "firefox"]);
    assert.equal(reg.values.size, 0);
    assert.equal(fs.existsSync(result.manifestPath), false);
    assert.equal(fs.existsSync(result.launcherPath), false);
    assert.equal(fs.existsSync(bystander), true, "files we did not create are left alone");
    assert.equal(fs.existsSync(installDir), true, "a folder that is not empty is kept");

    // and it is harmless when nothing is registered
    fs.rmSync(bystander);
    assert.deepEqual((await unregister({ installDir, runReg: reg.runReg })).removed, []);
    assert.equal(fs.existsSync(installDir), false, "an empty folder is removed");
  }

  // ── register refuses bad input and a failing registry ──────────────────────
  {
    const reg = fakeRegistry();
    const installDir = path.join(tempDir("slv-reg-dir"), "x");
    const sources = fakeInstallSources();

    await assert.rejects(() => register({ installDir, ...sources, allowedExtensionIds: [], runReg: reg.runReg }), /allowed extension/);
    await assert.rejects(() => register({ installDir, ...sources, runtimePath: path.join(installDir, "missing.exe"), allowedExtensionIds: IDS, runReg: reg.runReg }), /runtime was not found/);
    await assert.rejects(() => register({ installDir, ...sources, hostScriptPath: path.join(installDir, "missing.js"), allowedExtensionIds: IDS, runReg: reg.runReg }), /script was not found/);
    await assert.rejects(() => register({ installDir: "relative\\dir", ...sources, allowedExtensionIds: IDS, runReg: reg.runReg }), /usable absolute path/);
    assert.equal(reg.calls.length, 0, "nothing was registered after a refusal");

    const failing = async () => ({ ok: false, stdout: "", stderr: "Access is denied" });
    await assert.rejects(() => register({ installDir, ...sources, allowedExtensionIds: IDS, runReg: failing }), /Could not register with Google Chrome/);
  }

  // ── The real registry, with a throwaway helper name (Windows only, opt-in) ──
  // Writes and removes a throwaway key under the user's real HKCU, so it only runs
  // when asked: npm run test:register:real
  const realRegistry = process.argv.includes("--real-registry");
  if (!realRegistry) console.log("(skipped: real registry round trip; npm run test:register:real runs it)");
  if (process.platform === "win32" && realRegistry) {
    const hostName = `com.securelogin.registrytest.p${process.pid}`;
    const installDir = path.join(tempDir("slv-reg-real"), "dir with spaces");
    const sources = fakeInstallSources();
    const key = (browser) => registration.registryKey(browser, hostName);
    const query = (browser) => {
      try {
        return execFileSync("reg", ["query", key(browser), "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    };

    try {
      const result = await register({ installDir, ...sources, allowedExtensionIds: IDS, hostName });
      for (const browser of BROWSERS) {
        assert.equal(parseRegValue(query(browser)), browser.id === "firefox" ? result.firefoxManifestPath : result.manifestPath, `${browser.id}: real registry holds the manifest path`);
      }
      const report = await status({ installDir, allowedExtensionIds: IDS, hostName });
      assert.ok(report.browsers.every((b) => b.ok), JSON.stringify(report));
      await unregister({ installDir, hostName });
      for (const browser of BROWSERS) {
        assert.equal(query(browser), null, `${browser.id}: key removed from the real registry`);
      }
      assert.equal(fs.existsSync(installDir), false);
    } finally {
      for (const browser of BROWSERS) {
        try {
          execFileSync("reg", ["delete", key(browser), "/f"], { stdio: "ignore" });
        } catch {
          // already gone
        }
      }
    }
  }

  // ── The launcher, started the way a browser starts it ───────────────────────
  if (process.platform === "win32") {
    const electron = require("electron");
    assert.equal(typeof electron, "string", "plain Node resolves electron to its program path");
    const hostScriptPath = path.resolve(__dirname, "..", "src", "native-host", "host.js");

    // A folder with spaces and brackets, to exercise quoting
    const installDir = path.join(tempDir("slv reg (launch)"), "native host");
    const reg = fakeRegistry();
    const result = await register({ installDir, runtimePath: electron, hostScriptPath, allowedExtensionIds: ALLOWED_EXTENSION_IDS, runReg: reg.runReg });

    const origin = `chrome-extension://${ALLOWED_EXTENSION_IDS[0]}/`;
    const reply = await selfTest({ launcherPath: result.launcherPath, origin });
    assert.equal(reply.id, "self-test", "the helper echoes the request id");
    const reachedApp = reply.ok === true && reply.type === "pong";
    assert.ok(reachedApp || (reply.ok === false && reply.error === "app-not-running"), `unexpected answer: ${JSON.stringify(reply)}`);

    // The origin really arrives through the launcher: a different extension is refused
    const stranger = await selfTest({ launcherPath: result.launcherPath, origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/" });
    assert.deepEqual(stranger, { ok: false, error: "origin-not-allowed" });

    // No origin at all is refused too
    assert.deepEqual(await selfTest({ launcherPath: result.launcherPath, origin: "" }), { ok: false, error: "origin-not-allowed" });

    // Characters that could break out of the command line are never passed along
    for (const bad of ['x" & calc & "', "a b", "x&y", "x|y", "x%y", "x\ny", "x^y", 5, null]) {
      assert.throws(() => selfTest({ launcherPath: result.launcherPath, origin: bad }), /not allowed/, JSON.stringify(bad));
    }
  }

  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
  console.log("extension-register tests passed");
}

main().catch((error) => {
  console.error(error);
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
