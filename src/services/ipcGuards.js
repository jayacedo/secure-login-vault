const path = require("path");

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const GRANT_TTL_MS = 10 * 60 * 1000;

function isTrustedAppSender(event, window, expectedUrl) {
  try {
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === expectedUrl);
  } catch { return false; }
}

// Only plain web/mail links may leave the app. Credential URLs are free text
// typed by the user, so file:, javascript:, ms-*: and other custom protocols
// must never reach shell.openExternal.
function isSafeExternalUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return false;

  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Remembers file paths the user explicitly picked in a native dialog, so the
// renderer can only read/write a path the main process has seen the user choose
// rather than any path it supplies itself.
function createPathGrants(now = () => Date.now()) {
  const grants = new Map();

  function keyFor(kind, filePath) {
    return `${kind}:${path.resolve(filePath)}`;
  }

  return {
    clear() { grants.clear(); },
    grant(kind, filePath) {
      if (typeof filePath !== "string" || !filePath) return;
      grants.set(keyFor(kind, filePath), now() + GRANT_TTL_MS);
    },
    // True if the user picked this path for this purpose recently.
    has(kind, filePath) {
      if (typeof filePath !== "string" || !filePath) return false;
      const key = keyFor(kind, filePath);
      const expires = grants.get(key);
      if (expires === undefined) return false;
      if (expires < now()) {
        grants.delete(key);
        return false;
      }
      return true;
    },
    revoke(kind, filePath) {
      if (typeof filePath === "string" && filePath) {
        grants.delete(keyFor(kind, filePath));
      }
    }
  };
}

module.exports = { isSafeExternalUrl, createPathGrants, isTrustedAppSender };
