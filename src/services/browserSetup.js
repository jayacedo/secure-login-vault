const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const registration = require("../native-host/registration");
const { ALLOWED_EXTENSION_IDS, FIREFOX_EXTENSION_ID } = require("../native-host/config");

function publicError(message) {
  return Object.assign(new Error(message), { isPublic: true });
}

// Paths come only from the main process, never from renderer input.
function createBrowserSetup({
  packaged, resourcesPath, appPath, runtimePath, localAppData,
  portable = false, platform = process.platform, openPath,
  runReg, selfTest = registration.selfTest
}) {
  const extensionPath = path.join(packaged ? resourcesPath : appPath, "extension");
  const firefoxExtensionPath = packaged ? path.join(resourcesPath, "extension-firefox") : path.join(appPath, "dist", "firefox");
  const hostScriptPath = packaged
    ? path.join(resourcesPath, "native-host", "host.js")
    : path.join(appPath, "src", "native-host", "host.js");
  const installDir = path.join(localAppData, "SecureLoginVault", "native-host");
  const options = { installDir, runtimePath, hostScriptPath, allowedExtensionIds: ALLOWED_EXTENSION_IDS, runReg };
  const reason = platform !== "win32" ? "Browser setup is available on Windows."
    : portable ? "Install SLV using the Setup installer to connect your browser. The portable app runs from a temporary folder." : "";
  let settingUp = false;

  async function verifyBundle() {
    if (reason) throw publicError(reason);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, "manifest.json"), "utf8"));
      const digest = crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
      const id = digest.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
      if (!ALLOWED_EXTENSION_IDS.includes(id)) throw new Error("Wrong extension");
      const firefox = JSON.parse(await fs.readFile(path.join(firefoxExtensionPath, "manifest.json"), "utf8"));
      if (firefox.browser_specific_settings?.gecko?.id !== FIREFOX_EXTENSION_ID || firefox.version !== manifest.version) throw new Error("Wrong Firefox extension");
      await Promise.all([
        fs.access(runtimePath),
        ...["host.js", "hostRelay.js", "framing.js", "pipeName.js", "config.js"].map((file) => fs.access(path.join(path.dirname(hostScriptPath), file))),
        ...[extensionPath, firefoxExtensionPath].flatMap(folder => ["browserApi.js", "privateStorage.js", "background.js", "popup.html", "popup.js", "popup.css", "status.js", "link.js", "pairing.js", "fillInPage.js", "readFormInPage.js", "saveOffers.js", "offerContent.js", "offerSettings.js", "secureChannel.js", "secretStorage.js", "pairingSettings.js", ...Object.values(manifest.icons || {})].map((file) => fs.access(path.join(folder, file))))
      ]);
    } catch {
      throw publicError("The bundled browser files are missing or invalid. Reinstall SLV using the latest Setup installer.");
    }
  }

  async function status() {
    if (reason) return { supported: false, ready: false, message: reason };
    try { await verifyBundle(); } catch (error) {
      return { supported: false, ready: false, message: error.message };
    }
    const result = await registration.status(options);
    return { supported: true, ready: result.browsers.every((browser) => browser.ok), browsers: result.browsers, extensionPath, firefoxExtensionPath };
  }

  async function setup() {
    if (settingUp) throw publicError("Browser setup is already running.");
    settingUp = true;
    let probePath;
    try {
      await verifyBundle();
      // Prove the shipped executable can run the helper before changing registration.
      await fs.mkdir(installDir, { recursive: true });
      probePath = path.join(installDir, `slv-check-${crypto.randomUUID()}.bat`);
      await fs.writeFile(probePath, registration.buildLauncher(options), "utf8");
      const reply = await selfTest({ launcherPath: probePath, origin: `chrome-extension://${ALLOWED_EXTENSION_IDS[0]}/` });
      if (!((reply.ok === true && reply.type === "pong") || reply.error === "app-not-running")) {
        throw new Error("Helper check failed");
      }
      await registration.register(options);
      const result = await status();
      if (!result.ready) throw new Error("Registration check failed");
      return result;
    } catch (error) {
      if (error.isPublic) throw error;
      throw publicError("Browser setup could not finish. Close other SLV versions and try Set Up Browser Extension again.");
    } finally {
      if (probePath) await fs.rm(probePath, { force: true }).catch(() => {});
      settingUp = false;
    }
  }

  async function openFolder(browser = "chrome") {
    if (!["chrome", "firefox"].includes(browser)) throw publicError("Choose Chrome/Edge or Firefox.");
    await verifyBundle();
    const selectedPath = browser === "firefox" ? firefoxExtensionPath : extensionPath;
    if (await openPath(selectedPath)) throw publicError("Could not open the extension folder. Use the folder path shown in Settings.");
    return { extensionPath: selectedPath };
  }

  return { status, setup, openFolder };
}

module.exports = { createBrowserSetup };
