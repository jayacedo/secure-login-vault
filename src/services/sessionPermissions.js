// Default deny. Only the desktop's exact main document may write clipboard text.
// No renderer receives permission to read the clipboard or access devices.
function applySessionPermissions(session, { getMainWindow = () => null, pageUrl = "" } = {}) {
  function allowed(contents, permission, details) {
    if (permission !== "clipboard-sanitized-write" || details?.isMainFrame !== true || details.requestingUrl !== pageUrl) return false;
    try {
      const window = getMainWindow();
      return Boolean(window && !window.isDestroyed() && contents === window.webContents &&
        contents.getURL() === pageUrl && contents.mainFrame.url === pageUrl);
    } catch { return false; }
  }
  session.setPermissionCheckHandler((contents, permission, _origin, details) => allowed(contents, permission, details));
  session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowed(contents, permission, details)));
}
module.exports = { applySessionPermissions };
