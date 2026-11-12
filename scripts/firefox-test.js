const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { execFileSync } = require("child_process");
const { buildFirefox } = require("./build-firefox");
const { testTempRoot } = require("./testTemp");
const { fakeRegistry } = require("./browserSetupTestUtils");
const registration = require("../src/native-host/registration");
const { isAllowedCaller } = require("../src/native-host/hostRelay");
const { FIREFOX_EXTENSION_ID, ALLOWED_FIREFOX_IDS, ALLOWED_EXTENSION_IDS } = require("../src/native-host/config");
async function main() {
  const { destination, zipPath, manifest } = await buildFirefox();
  assert.equal(manifest.browser_specific_settings.gecko.id, FIREFOX_EXTENSION_ID);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.equal(manifest.background.service_worker, undefined);
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.background.scripts.at(-1), "background.js");
  for (const file of await fs.readdir(path.resolve("extension"))) {
    if (!/\.(js|html|css)$/.test(file)) continue;
    assert.deepEqual(await fs.readFile(path.join(destination, file)), await fs.readFile(path.join("extension", file)), file + " shares production source");
  }
  const root = await fs.mkdtemp(path.join(testTempRoot(), "firefox-package-"));
  // Check the actual stored names before extracting: Windows extractors accept
  // backslashes and previously concealed an archive rejected by Mozilla.
  const entries = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive = [IO.Compression.ZipFile]::OpenRead($env:SLV_FIREFOX_TEST_ZIP); try { @($archive.Entries | ForEach-Object { $_.FullName }) | ConvertTo-Json -Compress } finally { $archive.Dispose() }"],
  { windowsHide: true, env: { ...process.env, SLV_FIREFOX_TEST_ZIP: zipPath }, encoding: "utf8" }));
  assert.equal(new Set(entries).size, entries.length, "no duplicate ZIP entries");
  assert.ok(entries.includes("manifest.json"), "manifest at archive root");
  for (const entry of entries) {
    assert.equal(entry.includes("\\"), false, `ZIP entry uses forward slashes: ${entry}`);
    assert.equal(entry.startsWith("/") || entry.split("/").includes(".."), false, "relative archive entry");
  }
  for (const file of [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) {
    assert.ok(entries.includes(file), `manifest icon exists at exact ZIP path: ${file}`);
  }
  const unpack = path.join(root, "unzipped");
  execFileSync(path.resolve("node_modules/electron-winstaller/vendor/7z.exe"), ["x", zipPath, `-o${unpack}`, "-y"], { windowsHide: true, stdio: "pipe" });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(unpack, "manifest.json"))), manifest);
  for (const file of manifest.background.scripts) assert.deepEqual(await fs.readFile(path.join(unpack, file)), await fs.readFile(path.join(destination, file)));
  for (const file of entries) assert.deepEqual(await fs.readFile(path.join(unpack, file)), await fs.readFile(path.join(destination, file)), `archive bytes match: ${file}`);
  console.log("PASS Firefox package identity, minimal permissions, ordered event-page scripts, shared source and ZIP contents");

  const args = [path.join(root, "native.json"), FIREFOX_EXTENSION_ID];
  assert.equal(isAllowedCaller(args, ALLOWED_EXTENSION_IDS, ALLOWED_FIREFOX_IDS), true);
  assert.equal(isAllowedCaller([`chrome-extension://${ALLOWED_EXTENSION_IDS[0]}/`], ALLOWED_EXTENSION_IDS, ALLOWED_FIREFOX_IDS), true);
  for (const bad of [[], [FIREFOX_EXTENSION_ID], ["relative.json", FIREFOX_EXTENSION_ID], [...args, "extra"], [args[0], "other@example"], [args[0], "moz-extension://random/"], [args[0], FIREFOX_EXTENSION_ID + " "], [FIREFOX_EXTENSION_ID, args[0]]]) {
    assert.equal(isAllowedCaller(bad, ALLOWED_EXTENSION_IDS, ALLOWED_FIREFOX_IDS), false, JSON.stringify(bad));
  }
  const registry = fakeRegistry();
  const options = { installDir: path.join(root, "native"), runtimePath: process.execPath,
    hostScriptPath: path.resolve("src/native-host/host.js"), allowedExtensionIds: ALLOWED_EXTENSION_IDS, runReg: registry.runReg };
  const result = await registration.register(options);
  const native = JSON.parse(await fs.readFile(result.firefoxManifestPath));
  assert.deepEqual(native.allowed_extensions, [FIREFOX_EXTENSION_ID]);
  assert.equal(native.allowed_origins, undefined);
  assert.equal(registry.values.get("HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.securelogin.vault"), result.firefoxManifestPath);
  assert.equal((await registration.status(options)).browsers.every(b => b.ok), true);
  await fs.writeFile(result.firefoxManifestPath, JSON.stringify({ ...native, allowed_extensions: ["*"] }));
  const status = await registration.status(options);
  assert.equal(status.browsers.find(b => b.browser === "firefox").ok, false);
  assert.equal(status.browsers.filter(b => b.browser !== "firefox").every(b => b.ok), true);
  await registration.unregister(options);
  assert.equal(registry.values.size, 0);
  console.log("PASS Firefox native allowlist, forged caller rejection, separate per-user manifest, tamper detection and cleanup");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
