const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { testTempRoot } = require("./testTemp");
const { createBrowserSetup } = require("../src/services/browserSetup");
const { fakeRegistry } = require("./browserSetupTestUtils");

async function main() {
  const root = await fs.mkdtemp(path.join(testTempRoot(), "browser-setup-"));
  const resources = path.join(root, "Installed App", "resources");
  await fs.mkdir(resources, { recursive: true });
  await fs.cp(path.join(__dirname, "../extension"), path.join(resources, "extension"), { recursive: true });
  await fs.cp(path.join(__dirname, "../dist/firefox"), path.join(resources, "extension-firefox"), { recursive: true });
  await fs.cp(path.join(__dirname, "../src/native-host"), path.join(resources, "native-host"), { recursive: true });
  const runtime = path.join(root, "Installed App", "Secure Login Vault.exe");
  await fs.writeFile(runtime, "test runtime");
  const registry = fakeRegistry();
  let opened;
  let probes = 0;
  const options = {
    packaged: true, resourcesPath: resources, appPath: path.join(root, "no-project-folder"),
    runtimePath: runtime, localAppData: path.join(root, "User Data"), platform: "win32",
    runReg: registry.runReg, openPath: async (folder) => { opened = folder; return ""; },
    selfTest: async ({ launcherPath }) => {
      const launcher = await fs.readFile(launcherPath, "utf8");
      assert.ok(launcher.includes(runtime));
      assert.ok(launcher.includes(path.join(resources, "native-host", "host.js")));
      probes += 1;
      return { ok: false, error: "app-not-running" };
    }
  };
  const service = createBrowserSetup(options);
  assert.equal((await service.status()).ready, false);
  assert.equal((await service.setup()).ready, true);
  assert.equal(registry.values.size, 3, "Chrome, Edge and Firefox registered per user");
  for (const key of registry.values.keys()) assert.ok(key.startsWith("HKCU\\"));
  assert.equal((await service.setup()).ready, true, "repeat setup repairs in place");
  assert.equal(probes, 2);
  await service.openFolder();
  assert.equal(opened, path.join(resources, "extension"));
  await service.openFolder("firefox");
  assert.equal(opened, path.join(resources, "extension-firefox"));
  await assert.rejects(() => service.openFolder("../"), /Choose/);
  const helperDir = path.join(options.localAppData, "SecureLoginVault", "native-host");
  assert.deepEqual((await fs.readdir(helperDir)).sort(), ["com.securelogin.vault.bat", "com.securelogin.vault.firefox.json", "com.securelogin.vault.json"]);
  console.log("PASS installed resource paths, preflight, idempotent setup, fixed folder and probe cleanup");

  const movedRuntime = path.join(root, "Moved.exe");
  await fs.copyFile(runtime, movedRuntime);
  const moved = createBrowserSetup({ ...options, runtimePath: movedRuntime, selfTest: async () => ({ ok: true, type: "pong" }) });
  assert.equal((await moved.status()).ready, false, "old developer or installation paths are detected");
  assert.equal((await moved.setup()).ready, true);
  console.log("PASS registration detects and repairs another installation");

  for (const extra of [{ portable: true }, { platform: "linux" }]) {
    const unsupported = createBrowserSetup({ ...options, ...extra });
    assert.equal((await unsupported.status()).supported, false);
    await assert.rejects(unsupported.setup(), (error) => error.isPublic);
  }
  const prior = JSON.stringify([...registry.values]);
  await assert.rejects(createBrowserSetup({ ...options, selfTest: async () => ({ ok: false, error: "timeout" }) }).setup(), /could not finish/);
  assert.equal(JSON.stringify([...registry.values]), prior, "a failed runtime probe cannot change registration");
  await assert.rejects(createBrowserSetup({ ...options, openPath: async () => "error" }).openFolder(), /Could not open/);
  console.log("PASS portable/unsupported platforms, failed preflight and folder errors");

  const manifestPath = path.join(resources, "extension", "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, key: "wrong" }));
  assert.equal((await service.status()).supported, false);
  await assert.rejects(service.setup(), /missing or invalid/);
  assert.equal(JSON.stringify([...registry.values]), prior);
  console.log("PASS mismatched extension identity refuses registration");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
