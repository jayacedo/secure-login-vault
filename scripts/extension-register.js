// Registers (or removes) the browser helper for Chrome, Edge and Firefox, for development.
//
//   npm run extension:register     install the helper for the current user
//   npm run extension:unregister   remove it again
//   npm run extension:status       show what is registered
//
// No administrator rights are needed. Run `register` again after moving this folder.
const os = require("os");
const path = require("path");
const registration = require("../src/native-host/registration");
const { ALLOWED_EXTENSION_IDS } = require("../src/native-host/config");

const installDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "SecureLoginVault", "native-host");
const hostScriptPath = path.join(__dirname, "..", "src", "native-host", "host.js");

function electronPath() {
  // From plain Node, require("electron") gives the path to the Electron program.
  const resolved = require("electron");
  if (typeof resolved !== "string") throw new Error("Could not find the Electron program. Run npm install first.");
  return resolved;
}

async function main() {
  const command = process.argv[2];

  if (process.platform !== "win32") {
    throw new Error("Registration is only supported on Windows.");
  }

  if (command === "register") {
    const result = await registration.register({
      installDir,
      runtimePath: electronPath(),
      hostScriptPath: path.resolve(hostScriptPath),
      allowedExtensionIds: ALLOWED_EXTENSION_IDS
    });
    console.log("Registered the Secure Login Vault helper for:", result.registered.join(", "));
    console.log("  launcher:", result.launcherPath);
    console.log("  manifest:", result.manifestPath);

    // Start it the way the browser will, to prove it works.
    const origin = `chrome-extension://${ALLOWED_EXTENSION_IDS[0]}/`;
    const reply = await registration.selfTest({ launcherPath: result.launcherPath, origin });
    if (reply.ok && reply.type === "pong") {
      console.log(`Self-test: the helper reached the app (version ${reply.appVersion}).`);
    } else if (reply.error === "app-not-running") {
      console.log("Self-test: the helper started and works. The app is not listening yet:");
      console.log("  open Secure Login Vault > Settings > Security and set Browser Extension to On.");
    } else {
      console.log("Self-test: unexpected answer:", JSON.stringify(reply));
      process.exitCode = 1;
    }
    console.log("Now load the extension: chrome://extensions > Developer mode > Load unpacked > the 'extension' folder.");
    console.log("Firefox: npm run extension:build-firefox, then about:debugging > This Firefox > Load Temporary Add-on > dist/firefox/manifest.json.");
  } else if (command === "unregister") {
    const result = await registration.unregister({ installDir });
    console.log(result.removed.length ? `Removed the registration for: ${result.removed.join(", ")}` : "Nothing was registered.");
  } else if (command === "status") {
    const result = await registration.status({ installDir, allowedExtensionIds: ALLOWED_EXTENSION_IDS });
    for (const browser of result.browsers) {
      const line = browser.ok ? "registered and correct" : browser.problems.join("; ");
      console.log(`${browser.label}: ${line}`);
    }
    if (result.browsers.some((browser) => !browser.ok)) process.exitCode = 1;
  } else {
    console.error("Usage: node scripts/extension-register.js register | unregister | status");
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
