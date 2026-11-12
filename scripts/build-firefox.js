const fs = require("fs/promises");
const path = require("path");
const { execFileSync } = require("child_process");
const { FIREFOX_EXTENSION_ID } = require("../src/native-host/config");
const root = path.resolve(__dirname, "..");
const source = path.join(root, "extension");
const destination = path.join(root, "dist", "firefox");

async function buildFirefox({ archive = true } = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
  delete manifest.key;
  delete manifest.minimum_chrome_version;
  // Firefox uses an event page instead of a service worker. Dependencies are
  // loaded in order; background.js imports them only in Chromium workers.
  manifest.background = { scripts: ["browserApi.js", "privateStorage.js", "status.js", "pairing.js", "secureChannel.js", "secretStorage.js", "link.js", "fillInPage.js", "readFormInPage.js", "saveOffers.js", "inlineFill.js", "background.js"] };
  manifest.browser_specific_settings = { gecko: {
    id: FIREFOX_EXTENSION_ID,
    strict_min_version: "140.0",
    // These go to the user's local desktop vault, never a remote service.
    data_collection_permissions: { required: ["authenticationInfo", "browsingActivity"] }
  } };
  // Only this fixed generated folder is replaced; release and source are untouched.
  if (path.dirname(destination) !== path.join(root, "dist")) throw new Error("Invalid output folder");
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  const realRoot = await fs.realpath(root);
  const realParent = await fs.realpath(path.dirname(destination));
  if (realParent.toLowerCase() !== path.join(realRoot, "dist").toLowerCase()) throw new Error("Output parent must stay inside this workspace");
  const existing = await fs.lstat(destination).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error("Output folder must not be a link");
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if ((entry.isFile() && /\.(js|html|css)$/.test(entry.name)) || (entry.isDirectory() && entry.name === "icons")) {
      await fs.cp(path.join(source, entry.name), path.join(destination, entry.name), { recursive: true });
    }
  }
  await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const zipPath = path.join(root, "dist", `secure-login-vault-firefox-${manifest.version}.zip`);
  if (archive) writeZip(destination, zipPath);
  return { destination, zipPath, manifest };
}

function writeZip(destination, zipPath) {
    // Compress-Archive on Windows writes backslashes in nested entry names,
    // which Mozilla rejects. Explicitly use ZIP's forward-slash paths.
    // No interpolated shell paths; environment values are passed as literal paths.
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      [
        "$ErrorActionPreference='Stop'",
        "Add-Type -AssemblyName System.IO.Compression",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        "$sourceRoot = [IO.Path]::GetFullPath($env:SLV_FIREFOX_SOURCE)",
        "$zipStream = [IO.File]::Open($env:SLV_FIREFOX_ZIP, [IO.FileMode]::Create)",
        "try { $zipArchive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create); try { foreach ($sourceFile in [IO.Directory]::GetFiles($sourceRoot, '*', [IO.SearchOption]::AllDirectories)) { $entryName = $sourceFile.Substring($sourceRoot.Length + 1).Replace([char]92, [char]47); [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipArchive, $sourceFile, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null } } finally { $zipArchive.Dispose() } } finally { $zipStream.Dispose() }"
      ].join("; ")],
    { windowsHide: true, env: { ...process.env, SLV_FIREFOX_SOURCE: destination, SLV_FIREFOX_ZIP: zipPath }, stdio: "pipe" });
}
if (require.main === module) buildFirefox().then(result => {
  console.log(`Firefox temporary add-on: ${result.destination}\nUnsigned package for Mozilla signing: ${result.zipPath}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildFirefox, writeZip };
