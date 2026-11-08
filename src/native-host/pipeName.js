const os = require("os");
const path = require("path");

// Where the app listens for the browser helper. One name per OS user, so two
// people on the same computer never share a channel. (Non-Windows uses a unix
// socket path so the tests can run anywhere; the app itself is Windows-only.)
function getPipeName(username, platform = process.platform) {
  let name = username;
  if (name === undefined) {
    try {
      name = os.userInfo().username;
    } catch {
      name = "user";
    }
  }

  const safe = String(name).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "user";

  return platform === "win32"
    ? `\\\\.\\pipe\\secure-login-vault-${safe}`
    : path.join(os.tmpdir(), `secure-login-vault-${safe}.sock`);
}

module.exports = { getPipeName };
