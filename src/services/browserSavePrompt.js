const { BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("path");

// Only metadata reaches this renderer. The password stays in the save handler.
function showSaveLoginPrompt({ parent, host, username, groups, categories, activeGroup, signal, timeoutMs = 30000 }) {
  if (!parent || parent.isDestroyed() || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent, modal: true, show: false, width: 530, height: 530, resizable: false,
      minimizable: false, maximizable: false, autoHideMenuBar: true,
      title: "Save login — Secure Login Vault",
      icon: path.join(__dirname, "../../assets/icon.ico"),
      webPreferences: { preload: path.join(__dirname, "../saveLoginPreload.js"),
        nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "slv-save-prompt" }
    });
    let finished = false;
    const readyChannel = `slv:save-prompt-ready:${win.webContents.id}`;
    const responseChannel = `slv:save-prompt-response:${win.webContents.id}`;
    const allowed = (event) => !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
    const done = (value = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      ipcMain.removeHandler(readyChannel);
      ipcMain.removeListener(responseChannel, respond);
      if (!win.isDestroyed()) win.destroy();
      resolve(value);
    };
    const cancel = () => done(false);
    const respond = (event, selection) => {
      if (!allowed(event)) return;
      if (selection?.approved !== true) return done(false);
      if (typeof selection.groupName !== "string" || !["", ...groups].includes(selection.groupName)
        || typeof selection.category !== "string" || !categories.includes(selection.category)) return done(false);
      done({ approved: true, groupName: selection.groupName, category: selection.category, activeGroup });
    };
    const timer = setTimeout(cancel, timeoutMs);
    ipcMain.handle(readyChannel, (event) => allowed(event) ? { host, username, groups, categories, activeGroup, dark: nativeTheme.shouldUseDarkColors } : null);
    ipcMain.on(responseChannel, respond);
    signal?.addEventListener("abort", cancel, { once: true });
    win.on("closed", cancel);
    win.webContents.on("render-process-gone", cancel);
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.once("ready-to-show", () => { if (!finished) { win.show(); win.focus(); } });
    win.webContents.once("did-finish-load", () => {
      if (!finished) win.webContents.send("slv:save-prompt-channels", { ready: readyChannel, response: responseChannel });
    });
    win.loadFile(path.join(__dirname, "../renderer/save-login.html")).catch(cancel);
  });
}

module.exports = { showSaveLoginPrompt };
