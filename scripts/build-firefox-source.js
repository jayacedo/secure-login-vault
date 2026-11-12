// Explicit allowlist: do not include vaults, profiles, local configuration or Git.
const fs = require("fs/promises");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync } = require("child_process");
const { buildFirefox, writeZip } = require("./build-firefox");
const root = path.resolve(__dirname, "..");

async function main() {
  const built = await buildFirefox({ archive: false });
  await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
  const stage = await fs.mkdtemp(path.join(root, ".tmp", "firefox-review-source-"));
  const files = ["scripts/build-firefox.js", "scripts/sync-extension-fill.js",
    "scripts/sync-secure-channel.js", "src/login/formFill.js",
    "src/shared/secureChannel.js", "src/native-host/config.js"];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(stage, file));
  }
  for (const entry of await fs.readdir(path.join(root, "extension"), { withFileTypes: true })) {
    if ((entry.isFile() && /\.(js|json|html|css)$/.test(entry.name)) || (entry.isDirectory() && entry.name === "icons")) {
      await fs.cp(path.join(root, "extension", entry.name), path.join(stage, "extension", entry.name), { recursive: true });
    }
  }
  await fs.writeFile(path.join(stage, "README.md"), `# Secure Login Vault Firefox ${built.manifest.version} — reviewer source

This archive contains the original extension sources and the scripts needed to
reproduce the submitted Firefox add-on. JavaScript is not minified or obfuscated.
The source is provided because fillInPage.js and the Firefox manifest are generated.

## Rebuild

Tested on Windows with Node.js ${process.version} and Windows PowerShell 5.1.
No npm install, third-party build dependencies, credentials or network access required.
Extract this archive into an empty folder, open a terminal there, and run:

\`\`\`text
node scripts/sync-extension-fill.js
node scripts/sync-secure-channel.js
node scripts/build-firefox.js
\`\`\`

The installable files are generated in dist/firefox/. The unsigned ZIP is generated
in dist/secure-login-vault-firefox-${built.manifest.version}.zip. Compare extracted
file contents, not ZIP timestamps or compression metadata. Mozilla signature files
are not part of the unsigned build.

For a cross-platform file-only build, run the first two commands above and then:

\`\`\`text
node -e "require('./scripts/build-firefox').buildFirefox({archive:false}).catch(e=>{console.error(e);process.exitCode=1})"
\`\`\`

## Source map

- extension/: readable extension code, HTML, CSS and original Chromium manifest.
- src/login/formFill.js: original form-filling function; sync-extension-fill.js
  wraps it in the extension's isolated-world entry point.
- src/shared/secureChannel.js: copied unchanged into the extension.
- src/native-host/config.js: fixed public extension IDs used by the manifest builder.
- scripts/build-firefox.js: copies extension assets, replaces the Chromium
  service-worker declaration with ordered Firefox background scripts, and adds
  Firefox compatibility and data-consent declarations.
- extension/icons/: final PNG artwork; no image processing is needed to rebuild.

## Companion app

The add-on requires the Windows Secure Login Vault desktop app and registered
native messaging host com.securelogin.vault. Browser pairing is local; no website
account is required. Login fields and website origins are sent only to the local
desktop companion. The add-on does not send this data to a remote service.
Desktop source and setup documentation: https://github.com/jayacedo/secure-login-vault
`);
  const zip = path.join(root, "dist", `secure-login-vault-firefox-${built.manifest.version}-source.zip`);
  writeZip(stage, zip);
  // Rebuild from the actual archive in a separate directory, then compare every
  // shipped file byte for byte. No installed app or personal vault is involved.
  const verify = await fs.mkdtemp(path.join(root, ".tmp", "firefox-review-rebuild-"));
  execFileSync(path.join(root, "node_modules/electron-winstaller/vendor/7z.exe"), ["x", zip, `-o${verify}`, "-y"], { windowsHide: true, stdio: "pipe" });
  for (const script of ["sync-extension-fill.js", "sync-secure-channel.js", "build-firefox.js"]) {
    execFileSync(process.execPath, [path.join(verify, "scripts", script)], { cwd: verify, windowsHide: true, stdio: "pipe" });
  }
  async function compare(relative = "") {
    for (const entry of await fs.readdir(path.join(built.destination, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await compare(file);
      else assert.deepEqual(await fs.readFile(path.join(verify, "dist/firefox", file)), await fs.readFile(path.join(built.destination, file)), file);
    }
  }
  await compare();
  console.log(`PASS reviewer source rebuild matches every submitted extension file\nSource archive: ${zip}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
