const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { createVaultStore } = require("./services/vaultStore");
const { isSafeExternalUrl, createPathGrants } = require("./services/ipcGuards");

const isDevelopment = !app.isPackaged;
const DEFAULT_ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");
let vaultStore;
let mainWindow;
const pathGrants = createPathGrants();

function openExternalSafely(url) {
  if (isSafeExternalUrl(url)) {
    shell.openExternal(url);
  }
}

// Without a stable AppUserModelID, Windows can group/cache the taskbar
// button under the underlying electron.exe process instead of this app's
// own identity, which makes a dynamic setIcon() call (used for the custom
// branding logo) unreliable to see reflected in the taskbar.
if (process.platform === "win32") {
  app.setAppUserModelId("com.securelogin.vault");
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#f6f7fb",
    title: "Secure Login Vault",
    icon: DEFAULT_ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Notify the renderer when the window is minimized or loses focus entirely
  // (e.g. user alt-tabs away or minimizes to taskbar). The renderer decides
  // whether to actually lock based on whether auto-lock is enabled and starts
  // a short grace timer rather than locking instantly, since focus is regained
  // is a very common, harmless case (alt-tab, notification, etc).
  mainWindow.on("minimize", () => {
    mainWindow.webContents.send("vault:window-backgrounded", { reason: "minimize" });
  });

  mainWindow.on("blur", () => {
    mainWindow.webContents.send("vault:window-backgrounded", { reason: "blur" });
  });

  mainWindow.on("focus", () => {
    mainWindow.webContents.send("vault:window-foregrounded");
  });

  mainWindow.on("restore", () => {
    mainWindow.webContents.send("vault:window-foregrounded");
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (url !== currentUrl) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  // Disable manual reload shortcuts (Ctrl/Cmd+R, Ctrl/Cmd+Shift+R, F5,
  // Shift+F5) in production. There's no "page" for the user to refresh here —
  // it just re-runs the auth check and flashes the UI for no benefit, and for
  // a security-sensitive app it's better not to offer a reload affordance at
  // all. Left enabled in development since it's a normal part of iterating.
  if (!isDevelopment) {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      const key = (input.key || "").toLowerCase();
      const isRefreshCombo =
        (key === "r" && (input.control || input.meta)) || key === "f5";

      if (isRefreshCombo) {
        event.preventDefault();
      }
    });
  }

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (isDevelopment) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function registerAuthHandlers() {
  // ─── Auth & vault lifecycle ─────────────────────────────────────────────────
  ipcMain.handle("vault:get-state", async () => {
    return vaultStore.getState();
  });

  ipcMain.handle("vault:create", async (_event, payload) => {
    return handleVaultOperation(() => vaultStore.createVault(payload));
  });

  ipcMain.handle("vault:unlock", async (_event, payload) => {
    return handleVaultOperation(() => vaultStore.unlockVault(payload));
  });

  ipcMain.handle("vault:lock", async () => {
    return vaultStore.lockVault();
  });

  ipcMain.handle("vault:get-dashboard-data", async () => {
    return handleVaultOperation(() => vaultStore.getDashboardData());
  });

  // ─── Phase 5: Credential CRUD ───────────────────────────────────────────────
  ipcMain.handle("vault:get-credentials", async () => {
    return handleVaultOperation(() => vaultStore.getAllCredentials());
  });

  ipcMain.handle("vault:get-credentials-for-export", async () => {
    return handleVaultOperation(() => vaultStore.getAllCredentialsForExport());
  });

  ipcMain.handle("vault:get-credential", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.getCredential(id));
  });

  ipcMain.handle("vault:add-credential", async (_event, data) => {
    return handleVaultOperation(() => vaultStore.createCredential(data));
  });

  ipcMain.handle("vault:update-credential", async (_event, id, data) => {
    return handleVaultOperation(() => vaultStore.editCredential(id, data));
  });

  ipcMain.handle("vault:delete-credential", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.removeCredential(id));
  });

  ipcMain.handle("vault:delete-credentials-by-groups", async (_event, groupNames) => {
    return handleVaultOperation(() => vaultStore.removeCredentialsByGroups(groupNames));
  });

  ipcMain.handle("vault:toggle-favorite", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.toggleCredentialFavorite(id));
  });

  ipcMain.handle("vault:get-categories", async () => {
    return handleVaultOperation(() => vaultStore.getAllCategories());
  });

  // ─── Category management ────────────────────────────────────────────────────
  ipcMain.handle("vault:get-categories-with-usage", async () => {
    return handleVaultOperation(() => vaultStore.getCategoriesWithUsage());
  });

  ipcMain.handle("vault:add-category", async (_event, name) => {
    return handleVaultOperation(() => vaultStore.createCategory(name));
  });

  ipcMain.handle("vault:rename-category", async (_event, currentName, newName) => {
    return handleVaultOperation(() => vaultStore.editCategory(currentName, newName));
  });

  ipcMain.handle("vault:delete-category", async (_event, name, reassignTo) => {
    return handleVaultOperation(() => vaultStore.removeCategory(name, reassignTo));
  });

  // ─── Phase 6: Live Search ───────────────────────────────────────────────────
  ipcMain.handle("vault:search-credentials", async (_event, options) => {
    return handleVaultOperation(() => vaultStore.searchVaultCredentials(options));
  });

  // ─── Group management ───────────────────────────────────────────────────────
  ipcMain.handle("vault:get-groups", async () => {
    return handleVaultOperation(() => vaultStore.getAllGroups());
  });

  ipcMain.handle("vault:get-groups-with-usage", async () => {
    return handleVaultOperation(() => vaultStore.getGroupsWithUsage());
  });

  ipcMain.handle("vault:add-group", async (_event, name) => {
    return handleVaultOperation(() => vaultStore.createGroup(name));
  });

  ipcMain.handle("vault:rename-group", async (_event, currentName, newName) => {
    return handleVaultOperation(() => vaultStore.editGroup(currentName, newName));
  });

  ipcMain.handle("vault:delete-group", async (_event, name) => {
    return handleVaultOperation(() => vaultStore.removeGroup(name));
  });

  ipcMain.handle("vault:get-active-group", async () => {
    return handleVaultOperation(() => vaultStore.getCurrentActiveGroup());
  });

  ipcMain.handle("vault:set-active-group", async (_event, name) => {
    return handleVaultOperation(() => vaultStore.setCurrentActiveGroup(name));
  });

  // ─── Client Vault CRUD ──────────────────────────────────────────────────────
  ipcMain.handle("vault:get-clients", async () => {
    return handleVaultOperation(() => vaultStore.getAllClients());
  });

  ipcMain.handle("vault:get-client", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.getClient(id));
  });

  ipcMain.handle("vault:add-client", async (_event, data) => {
    return handleVaultOperation(() => vaultStore.createClient(data));
  });

  ipcMain.handle("vault:update-client", async (_event, id, data) => {
    return handleVaultOperation(() => vaultStore.editClient(id, data));
  });

  ipcMain.handle("vault:delete-client", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.removeClient(id));
  });

  ipcMain.handle("vault:toggle-client-favorite", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.toggleClientFav(id));
  });

  ipcMain.handle("vault:search-clients", async (_event, options) => {
    return handleVaultOperation(() => vaultStore.searchVaultClients(options));
  });
}

function registerImportExportHandlers() {
  // ─── Phase 9: Import ────────────────────────────────────────────────────────

  ipcMain.handle("vault:pick-import-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select a file to import",
      properties: ["openFile"],
      filters: [
        { name: "Supported files", extensions: ["csv", "json"] },
        { name: "CSV", extensions: ["csv"] },
        { name: "JSON", extensions: ["json"] },
        { name: "All files", extensions: ["*"] }
      ]
    });

    if (result.canceled || !result.filePaths[0]) {
      return { ok: true, result: { canceled: true } };
    }

    return handleVaultOperation(async () => {
      const filePath = result.filePaths[0];
      const content = await fs.readFile(filePath, "utf8");
      return {
        canceled: false,
        filePath,
        fileName: path.basename(filePath),
        content
      };
    });
  });

  // ─── Phase 9: Export ────────────────────────────────────────────────────────

  ipcMain.handle("vault:pick-export-path", async (_event, { defaultName, format }) => {
    const filterMap = {
      csv: { name: "CSV", extensions: ["csv"] },
      json: { name: "JSON", extensions: ["json"] },
      backup: { name: "Encrypted Backup", extensions: ["slvbackup"] }
    };
    const filter = filterMap[format] || { name: "All files", extensions: ["*"] };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Choose where to save the export",
      defaultPath: defaultName,
      filters: [filter]
    });

    if (result.canceled || !result.filePath) {
      return { ok: true, result: { canceled: true } };
    }

    // Remember the choice: only a path picked here may be written to below.
    pathGrants.grant("export", result.filePath);
    return { ok: true, result: { canceled: false, filePath: result.filePath } };
  });

  ipcMain.handle("vault:write-export-file", async (_event, { filePath, content } = {}) => {
    return handleVaultOperation(async () => {
      if (!pathGrants.has("export", filePath) || typeof content !== "string") {
        throw createPublicError("Choose where to save the file first.");
      }
      pathGrants.revoke("export", filePath);
      await fs.writeFile(filePath, content, "utf8");
      return { written: true, filePath };
    });
  });

  // ─── Phase 9: Encrypted Backup & Restore ───────────────────────────────────

  ipcMain.handle("vault:create-backup", async (_event, { filePath } = {}) => {
    return handleVaultOperation(async () => {
      if (!pathGrants.has("export", filePath)) {
        throw createPublicError("Choose where to save the backup first.");
      }
      pathGrants.revoke("export", filePath);
      return vaultStore.createEncryptedBackup(filePath);
    });
  });

  ipcMain.handle("vault:pick-restore-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select an encrypted backup to restore",
      properties: ["openFile"],
      filters: [{ name: "Encrypted Backup", extensions: ["slvbackup"] }]
    });

    if (result.canceled || !result.filePaths[0]) {
      return { ok: true, result: { canceled: true } };
    }

    pathGrants.grant("restore", result.filePaths[0]);
    return { ok: true, result: { canceled: false, filePath: result.filePaths[0] } };
  });

  ipcMain.handle("vault:restore-backup", async (_event, { filePath, masterPassword } = {}) => {
    return handleVaultOperation(async () => {
      if (!pathGrants.has("restore", filePath)) {
        throw createPublicError("Choose a backup file first.");
      }
      // Kept after a failed attempt (e.g. wrong password) so the user can
      // retry; revoked once the restore succeeds.
      const outcome = await vaultStore.restoreEncryptedBackup(filePath, masterPassword);
      pathGrants.revoke("restore", filePath);
      return outcome;
    });
  });
}

function registerSettingsHandlers() {
  // ─── Phase 10: Settings ─────────────────────────────────────────────────────

  ipcMain.handle("vault:change-master-password", async (_event, payload) => {
    return handleVaultOperation(() => vaultStore.changeMasterPassword(payload));
  });

  ipcMain.handle("app:get-info", async () => {
    return handleVaultOperation(async () => ({
      version: app.getVersion(),
      userData: app.getPath("userData"),
      vaultDirectory: path.join(app.getPath("userData"), "vault")
    }));
  });

  ipcMain.handle("app:pick-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Select Folder",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: true, result: { canceled: true } };
    }
    return { ok: true, result: { canceled: false, folderPath: result.filePaths[0] } };
  });

  // White-label branding: lets the renderer rename the OS window title bar
  // to match a custom app name set in Settings. Renderer-supplied, so keep
  // this a simple, harmless string op with a sane length cap — it can only
  // ever change window chrome text, never anything security-sensitive.
  ipcMain.handle("app:set-window-title", async (_event, title) => {
    if (typeof title !== "string" || !title.trim()) return { ok: false };
    if (!mainWindow) return { ok: false };
    mainWindow.setTitle(title.trim().slice(0, 100));
    return { ok: true };
  });

  // Lets a custom Logo set in Settings also apply to the window/taskbar icon,
  // not just the in-page brand mark — BrowserWindow's icon is otherwise fixed
  // at window-creation time. Renderer-supplied, so validate it's actually
  // image data before handing it to nativeImage; anything else (including an
  // empty string, when no custom logo is set) falls back to the packaged icon.
  ipcMain.handle("app:set-window-icon", async (_event, dataUri) => {
    if (!mainWindow) return { ok: false };

    if (typeof dataUri === "string" && dataUri.startsWith("data:image/")) {
      const image = nativeImage.createFromDataURL(dataUri);
      if (!image.isEmpty()) {
        mainWindow.setIcon(image);
        return { ok: true };
      }
    }

    mainWindow.setIcon(DEFAULT_ICON_PATH);
    return { ok: true };
  });
}

function createPublicError(message) {
  const error = new Error(message);
  error.isPublic = true;
  return error;
}

async function handleVaultOperation(operation) {
  try {
    return {
      ok: true,
      result: await operation()
    };
  } catch (error) {
    return {
      ok: false,
      message: error && error.isPublic ? error.message : "Vault operation failed."
    };
  }
}

app.whenReady().then(() => {
  vaultStore = createVaultStore(app.getPath("userData"));
  registerAuthHandlers();
  registerImportExportHandlers();
  registerSettingsHandlers();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (vaultStore) {
    vaultStore.lockVault();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});
