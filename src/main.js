const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, safeStorage, clipboard, Tray, Menu, screen, session, powerMonitor } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const { pathToFileURL } = require("url");
const { createVaultStore } = require("./services/vaultStore");
const { isSafeExternalUrl, createPathGrants, isTrustedAppSender } = require("./services/ipcGuards");
const { runVaultOperation, assertVaultOperationActive, beforeVaultCommit } = require("./services/vaultOperationContext");
const { createLockManager, normalizePolicy } = require("./services/lockManager");
const { writeJsonAtomic, readBoundedText, MAX_IMPORT_BYTES } = require("./services/fsUtils");
const { buildLoginTarget, describeTargetProblem } = require("./services/siteLogin");
const { createLoginWindows } = require("./services/loginWindows");
const { createExtensionBridge } = require("./services/extensionBridge");
const { createExtensionHandlers } = require("./services/extensionHandlers");
const { createPairing } = require("./services/extensionPairing");
const { createPairingStorage } = require("./services/pairingStorage");
const { getPipeName } = require("./native-host/pipeName");
const { createBrowserSetup } = require("./services/browserSetup");
const browserSavePrompt = require("./services/browserSavePrompt");
const { createAutomaticBackups } = require("./services/automaticBackups");
const { createBackupVerification } = require("./services/backupVerification");
const { createAuthenticator } = require("./services/authenticator");
const { createDesktopIntegration, DesktopIntegrationError } = require("./services/desktopIntegration");
const { applySessionPermissions } = require("./services/sessionPermissions");
const { createSensitiveClipboard } = require("./services/sensitiveClipboard");

const isDevelopment = !app.isPackaged;
const DEFAULT_ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");
let vaultStore;
let mainWindow;
let lockManager;
let loginWindows;
let extensionBridge;
let extensionPairing;
let pairingStorage;
let browserSetup;
let automaticBackups;
let backupVerification;
let trashMaintenance;
let authenticator;
let sensitiveClipboard;
let desktopIntegration;
let compactUnlock = false;
let dashboardBounds;
let dashboardWasMaximized = false;
let servicesDisposed = false;
let clipboardCleanup = Promise.resolve();
let quitCleanupStarted = false;
let quitCleanupComplete = false;
let pairingExpiresAt = 0;
let systemSessionLocked = false;
let systemSuspended = false;
const systemLockHandlers = {
  "lock-screen": () => { systemSessionLocked = true; lockDesktopVault("system-lock"); },
  "unlock-screen": () => { systemSessionLocked = false; }, // Never unlock the vault here.
  suspend: () => { systemSuspended = true; lockDesktopVault("suspend"); },
  resume: () => { systemSuspended = false; lockDesktopVault("resume"); }
};
const pathGrants = createPathGrants();
const exportApproval = require("./services/exportApproval").createExportApproval();
const credentialExport = require("./shared/credentialExport");
// One writer process per user-data profile. The native helper runs separately
// through its own entry point and does not acquire this desktop lock.
const ownsDesktopInstance = app.requestSingleInstanceLock();
if (!ownsDesktopInstance) app.quit();
app.on("second-instance", () => {
  showMainWindow();
});
const appPageUrl = pathToFileURL(path.join(__dirname, "renderer", "index.html")).href;
const lockedRequests = new Set([
  "vault:get-state", "vault:create", "vault:unlock", "vault:lock", "vault:pick-restore-file", "vault:restore-backup",
  "vault:reset-with-recovery-key", "vault:set-lock-policy", "app:get-info", "app:set-window-title", "app:set-window-icon",
  "vault:get-extension-bridge", "vault:get-browser-setup", "vault:get-extension-pairing",
  "app:get-desktop-integration", "app:hide-locked-window"
]);
function handleAppRequest(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const trusted = () => isTrustedAppSender(event, mainWindow, appPageUrl);
    if (!trusted()) return { ok: false, message: "Open this action in Secure Login Vault." };
    const epoch = vaultStore.getOperationEpoch();
    const protectedRequest = !lockedRequests.has(channel);
    const check = () => {
      if ((channel === "vault:unlock" || channel === "vault:create") && (systemSessionLocked || systemSuspended)) {
        throw createPublicError("Unlock Windows and resume the computer before opening the vault.");
      }
      if (!trusted() || (protectedRequest && (!vaultStore.isUnlocked() || epoch !== vaultStore.getOperationEpoch()))) {
        throw createPublicError("Vault is locked or its session changed. Try again after unlocking.");
      }
    };
    const context = { check, buffers: new Set(), committing: false };
    try {
      check();
      const result = await runVaultOperation(context, () => handler(event, ...args));
      check();
      return result;
    } catch (error) { return { ok: false, message: error?.isPublic ? error.message : "Vault operation failed." }; }
    finally { for (const buffer of context.buffers) buffer.fill(0); }
  });
}

// Native dialogs take focus from the window; keep that from triggering the
// background auto-lock while the user is picking a file (time-limited, see
// lockManager).
async function withNativeDialog(openDialog) {
  lockManager.pauseBackground();
  try {
    const result = await openDialog();
    assertVaultOperationActive();
    return result;
  } finally {
    lockManager.resumeBackground();
  }
}

// The vault counts as "left" only when none of the app's windows (the main
// window or a login window) has focus. Moving focus between them is not leaving.
function handleAppWindowBlur() {
  setTimeout(() => {
    const stillActive = BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
    );
    if (!stillActive) lockManager.windowBackgrounded();
  }, 100);
}

function handleAppWindowFocus() {
  lockManager.windowForegrounded();
}

function openExternalSafely(url) {
  if (isSafeExternalUrl(url)) {
    shell.openExternal(url);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}

function applyWindowState(state) {
  const compact = Boolean(state.hasVault && !state.isUnlocked && desktopIntegration?.hasTray());
  if (mainWindow && !mainWindow.isDestroyed() && compact !== compactUnlock) {
    if (compact) {
      dashboardWasMaximized = mainWindow.isMaximized();
      dashboardBounds = mainWindow.getNormalBounds();
      if (dashboardWasMaximized) mainWindow.unmaximize();
      mainWindow.setMinimumSize(360, 400);
      const work = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
      mainWindow.setSize(Math.min(460, work.width), Math.min(620, work.height));
      mainWindow.center();
    } else {
      mainWindow.setMinimumSize(980, 640);
      if (dashboardBounds) mainWindow.setBounds(dashboardBounds);
      else mainWindow.setSize(1180, 760);
      if (dashboardWasMaximized) mainWindow.maximize();
    }
  }
  compactUnlock = compact;
  desktopIntegration?.refresh();
  return { ...state, compactUnlock: compact };
}

function lockDesktopVault(reason, notify = true) {
  extensionBridge?.closeConnections();
  sensitiveClipboard?.clear();
  backupVerification?.cancel();
  authenticator?.clear(); pathGrants.clear(); exportApproval.clear(); saveApprovalAbort?.abort();
  lockManager?.setUnlocked(false);
  extensionPairing?.cancelPairing(); loginWindows?.closeAll();
  const result = vaultStore.lockVault();
  desktopIntegration?.refresh();
  if (notify && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("vault:auto-locked", { reason });
  return result;
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

  mainWindow.once("ready-to-show", async () => {
    const state = applyWindowState(await vaultStore.getState());
    if (!desktopIntegration?.shouldStartHidden(process.argv, state.hasVault)) mainWindow.show();
  });
  mainWindow.webContents.on("did-start-loading", () => {
    sensitiveClipboard?.clear(); authenticator?.clear(); backupVerification?.cancel(); exportApproval.clear();
  });
  for (const event of ["render-process-gone", "destroyed"]) {
    // Do not send into a crashed/destroyed renderer. The main process revokes
    // the session immediately, including browser access and pending work.
    mainWindow.webContents.on(event, () => {
      if (!servicesDisposed) lockDesktopVault("renderer-gone", false);
    });
  }

  // Background auto-lock is enforced here, not in the renderer: minimizing or
  // losing focus starts the grace timer, regaining focus cancels it (alt-tab,
  // notifications etc. are common and harmless).
  mainWindow.on("minimize", handleAppWindowBlur);
  mainWindow.on("blur", handleAppWindowBlur);
  mainWindow.on("focus", handleAppWindowFocus);
  mainWindow.on("restore", handleAppWindowFocus);
  mainWindow.on("close", event => desktopIntegration?.handleClose(event));
  mainWindow.on("query-session-end", () => { desktopIntegration?.beginQuit(); lockDesktopVault("shutdown", false); });
  mainWindow.on("closed", () => loginWindows.closeAll());

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
  handleAppRequest("vault:copy-text", async (_event, payload) => ({ ok: true, result: await sensitiveClipboard.copy(payload) }));
  // ─── Auth & vault lifecycle ─────────────────────────────────────────────────
  handleAppRequest("vault:get-state", async () => {
    return applyWindowState(await vaultStore.getState());
  });

  handleAppRequest("vault:create", async (_event, payload) => {
    const response = await handleVaultOperation(() => vaultStore.createVault(payload));
    if (response.ok) { lockManager.setUnlocked(true); applyWindowState({ hasVault: true, isUnlocked: true }); automaticBackups.run().catch(() => {}); }
    return response;
  });

  handleAppRequest("vault:unlock", async (_event, payload) => {
    const response = await handleVaultOperation(() => vaultStore.unlockVault(payload));
    if (response.ok) {
      lockManager.setUnlocked(true);
      applyWindowState({ hasVault: true, isUnlocked: true });
      vaultStore.purgeDeletedCredentials().catch(() => {});
      vaultStore.purgeActivityHistory().catch(() => {});
      automaticBackups.run().catch(() => {});
    }
    return response;
  });

  handleAppRequest("vault:lock", async () => {
    return lockDesktopVault("manual", false);
  });

  handleAppRequest("app:get-desktop-integration", () => ({ ok: true, result: desktopIntegration.status() }));
  handleAppRequest("app:set-desktop-integration", async (_event, preferences) => {
    try { return { ok: true, result: await desktopIntegration.configure(preferences) }; }
    catch (error) { return { ok: false, message: error instanceof DesktopIntegrationError ? error.message : "Could not apply startup and tray settings. Try again." }; }
  });
  handleAppRequest("app:hide-locked-window", () => {
    if (vaultStore.isUnlocked()) return { ok: false, message: "Lock the vault before returning to the tray." };
    return { ok: desktopIntegration.hideLocked() };
  });

  handleAppRequest("vault:get-dashboard-data", async () => {
    return handleVaultOperation(() => vaultStore.getDashboardData());
  });

  // ─── Phase 5: Credential CRUD ───────────────────────────────────────────────
  handleAppRequest("vault:get-credentials", async () => {
    return handleVaultOperation(() => vaultStore.getAllCredentials());
  });

  handleAppRequest("vault:get-credentials-for-export", async () => {
    return handleVaultOperation(() => vaultStore.getAllCredentialsForExport());
  });

  handleAppRequest("vault:get-credential", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.getCredential(id));
  });

  handleAppRequest("vault:get-password-history", (event, id) => handleVaultOperation(() => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw createPublicError("Open the credential in SLV.");
    }
    return vaultStore.getPasswordHistory(id);
  }));

  handleAppRequest("vault:check-health", event => handleVaultOperation(() => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw createPublicError("Open Vault Health in SLV.");
    }
    return vaultStore.checkVaultHealth();
  }));

  handleAppRequest("vault:add-credential", async (_event, data) => {
    return handleVaultOperation(() => vaultStore.createCredential(data));
  });
  handleAppRequest("vault:import-credentials", async (_event, request) => {
    return handleVaultOperation(() => vaultStore.importCredentials(request));
  });

  handleAppRequest("vault:update-credential", async (_event, id, data) => {
    return handleVaultOperation(() => vaultStore.editCredential(id, data));
  });

  handleAppRequest("vault:delete-credential", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.removeCredential(id));
  });

  for (const [channel, operation] of [
    ["vault:authenticator-setup-key", options => require("./services/manualAuthenticator").createSetupQr(options)],
    ["vault:authenticator-start", image => authenticator.start(image)],
    ["vault:authenticator-credential", id => {
      if (!Number.isSafeInteger(id) || id <= 0) throw createPublicError("Choose a saved login.");
      return authenticator.start(async () => {
        const credential = await vaultStore.getCredential(id);
        if (!credential.qrCode) throw createPublicError("This login has no saved QR. Add one in Edit first.");
        return credential.qrCode;
      });
    }],
    ["vault:authenticator-read", token => authenticator.read(token)],
    ["vault:authenticator-client", id => {
      if (!Number.isSafeInteger(id) || id <= 0) throw createPublicError("Choose a saved client.");
      return authenticator.start(async () => {
        const client = await vaultStore.getClient(id);
        if (!client.qrCode) throw createPublicError("This client has no saved QR. Add one in Edit first.");
        return client.qrCode;
      });
    }],
    ["vault:authenticator-copy", token => authenticator.copy(token)],
    ["vault:authenticator-stop", token => authenticator.stop(token)],
    ["vault:duplicates-list", () => vaultStore.getDuplicateReview()],
    ["vault:preview-credential-move", choice => vaultStore.previewCredentialMove(choice)],
    ["vault:move-credentials-to-group", choice => vaultStore.moveCredentialsToGroup(choice)],
    ["vault:preview-credential-category", choice => vaultStore.previewCredentialCategory(choice)],
    ["vault:change-credential-category", choice => vaultStore.changeCredentialCategory(choice)],
    ["vault:undo-bulk-change", token => vaultStore.undoBulkChange(token)],
    ["vault:preview-credential-favorites", choice => vaultStore.previewCredentialFavorites(choice)],
    ["vault:change-credential-favorites", choice => vaultStore.changeCredentialFavorites(choice)],
    ["vault:credential-details", id => vaultStore.getCredentialDetails(id)],
    ["vault:activity-history", options => vaultStore.getActivityHistory(options)],
    ["vault:duplicates-resolve", choice => vaultStore.resolveDuplicateReview(choice)],
    ["vault:trash-list", () => vaultStore.getDeletedCredentials()],
    ["vault:trash-restore", id => vaultStore.restoreDeletedCredential(id)],
    ["vault:trash-delete", (id, confirmed) => vaultStore.permanentlyDeleteCredential(id, confirmed)]
  ]) {
    handleAppRequest(channel, (event, ...args) => handleVaultOperation(() => {
      if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw createPublicError("Open the review in SLV.");
      }
      return operation(...args);
    }));
  }

  handleAppRequest("vault:delete-credentials-by-groups", async (_event, groupNames) => {
    return handleVaultOperation(() => vaultStore.removeCredentialsByGroups(groupNames));
  });

  handleAppRequest("vault:toggle-favorite", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.toggleCredentialFavorite(id));
  });

  handleAppRequest("vault:get-categories", async () => {
    return handleVaultOperation(() => vaultStore.getAllCategories());
  });

  // ─── Category management ────────────────────────────────────────────────────
  handleAppRequest("vault:get-categories-with-usage", async () => {
    return handleVaultOperation(() => vaultStore.getCategoriesWithUsage());
  });

  handleAppRequest("vault:add-category", async (_event, name) => {
    return handleVaultOperation(() => vaultStore.createCategory(name));
  });

  handleAppRequest("vault:rename-category", async (_event, currentName, newName) => {
    return handleVaultOperation(() => vaultStore.editCategory(currentName, newName));
  });

  handleAppRequest("vault:delete-category", async (_event, name, reassignTo) => {
    return handleVaultOperation(() => vaultStore.removeCategory(name, reassignTo));
  });

  // ─── Phase 6: Live Search ───────────────────────────────────────────────────
  handleAppRequest("vault:search-credentials", async (_event, options) => {
    return handleVaultOperation(() => vaultStore.searchVaultCredentials(options));
  });

  // ─── Group management ───────────────────────────────────────────────────────
  handleAppRequest("vault:get-groups", async () => {
    return handleVaultOperation(() => vaultStore.getAllGroups());
  });

  handleAppRequest("vault:get-groups-with-usage", async () => {
    return handleVaultOperation(() => vaultStore.getGroupsWithUsage());
  });

  handleAppRequest("vault:add-group", async (_event, name) => {
    return handleVaultOperation(() => vaultStore.createGroup(name));
  });

  handleAppRequest("vault:rename-group", async (_event, currentName, newName) => {
    return handleVaultOperation(() => vaultStore.editGroup(currentName, newName));
  });

  handleAppRequest("vault:delete-group", async (_event, name, reassignToName, expectedCount) => {
    return handleVaultOperation(() => vaultStore.removeGroup(name, reassignToName, expectedCount));
  });

  handleAppRequest("vault:get-active-group", async () => {
    return handleVaultOperation(() => vaultStore.getCurrentActiveGroup());
  });

  handleAppRequest("vault:set-active-group", async (_event, name) => {
    return handleVaultOperation(() => vaultStore.setCurrentActiveGroup(name));
  });

  // ─── Client Vault CRUD ──────────────────────────────────────────────────────
  // Notes use the trusted-main-window and unlocked-session guards.
  for (const method of ["listNotes", "getNote", "addNote", "updateNote", "toggleNoteFavorite", "deleteNote"]) {
    handleAppRequest(`vault:notes:${method}`, async (_event, ...args) =>
      handleVaultOperation(() => vaultStore[method](...args)));
  }

  handleAppRequest("vault:get-clients", async () => {
    return handleVaultOperation(() => vaultStore.getAllClients());
  });

  handleAppRequest("vault:get-client", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.getClient(id));
  });

  handleAppRequest("vault:add-client", async (_event, data) => {
    return handleVaultOperation(() => vaultStore.createClient(data));
  });

  handleAppRequest("vault:update-client", async (_event, id, data) => {
    return handleVaultOperation(() => vaultStore.editClient(id, data));
  });

  handleAppRequest("vault:delete-client", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.removeClient(id));
  });

  handleAppRequest("vault:toggle-client-favorite", async (_event, id) => {
    return handleVaultOperation(() => vaultStore.toggleClientFav(id));
  });

  handleAppRequest("vault:search-clients", async (_event, options) => {
    return handleVaultOperation(() => vaultStore.searchVaultClients(options));
  });
}

// ─── Browser extension connection ─────────────────────────────────────────────
//
// Off by default: until the user turns it on in Settings, the app listens on
// nothing. The choice is stored in the app's data folder (not in the page).

const EXTENSION_SETTINGS_FILE = "extension-settings.json";
const extensionState = { enabled: false, askBeforeFill: false, error: "" };

function extensionSettingsPath() {
  return path.join(app.getPath("userData"), EXTENSION_SETTINGS_FILE);
}

function extensionStatus() {
  return {
    enabled: extensionState.enabled,
    askBeforeFill: extensionState.askBeforeFill,
    running: extensionBridge.isRunning(),
    error: extensionState.error
  };
}

async function startExtensionBridge() {
  try {
    await extensionBridge.start();
    extensionState.error = "";
    return true;
  } catch (error) {
    extensionState.error =
      error && error.code === "EADDRINUSE"
        ? "Another copy of Secure Login Vault is already using the browser connection."
        : "The browser connection could not be started.";
    return false;
  }
}

async function loadExtensionSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(extensionSettingsPath(), "utf8"));
    extensionState.enabled = saved && saved.enabled === true;
    extensionState.askBeforeFill = saved && saved.askBeforeFill === true;
  } catch {
    extensionState.enabled = false; // missing or unreadable: stay off
  }
  if (extensionState.enabled) {
    await startExtensionBridge();
  }
}

// ─── Asking before the browser extension fills a login ────────────────────────
//
// With "Ask before filling" on, every password request from the extension waits for
// a click in the app. The prompt names only the entry and the site, defaults to
// "Don't fill", allows one prompt at a time (a second request is declined at once), and
// declines by itself after a while. SLV_APPROVAL_TIMEOUT_MS only exists so tests need
// not wait; it can only shorten the time.
let approvalOpen = false;
let saveApprovalAbort = null;
const APPROVAL_TIMEOUT_MS = Math.min(30000, Math.max(200, Number(process.env.SLV_APPROVAL_TIMEOUT_MS) || 30000));

// What is shown comes from saved data, so strip anything that could reorder or hide text.
const forPrompt = (text) => String(text || "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 80);

async function askBeforeFilling({ host, name }, signal) {
  if (!extensionState.askBeforeFill) return true;
  return confirmInApp({
    message: `Fill "${forPrompt(name)}" on ${forPrompt(host)}?`,
    detail: "A browser extension asked to fill this login. Choose Fill only if you just asked for it.",
    buttons: ["Don't fill", "Fill"], signal
  });
}

// Saving from the browser is ALWAYS confirmed here (there is no setting to skip it), because
// it changes the vault. The prompt shows the site and the username, never the password.
async function askBeforeSaving({ host, username, name, mode }, signal) {
  const site = forPrompt(host);
  const user = forPrompt(username);
  if (mode === "update") {
    return confirmInApp({
      message: `Update the saved password for "${forPrompt(name)}" (${user}) on ${site}?`,
      detail: "A browser extension asked to save a changed password. Choose Update only if you just changed it.",
      buttons: ["Don't update", "Update"],
      signal
    });
  }
  if (approvalOpen || !mainWindow || mainWindow.isDestroyed() || signal?.aborted) return false;
  approvalOpen = true;
  const abort = new AbortController();
  saveApprovalAbort = abort;
  const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const [groups, categories, activeGroup] = await Promise.all([
      vaultStore.getAllGroups(), vaultStore.getAllCategories(), vaultStore.getCurrentActiveGroup()
    ]);
    if (abort.signal.aborted) return false;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.flashFrame(true);
    return await withNativeDialog(() => browserSavePrompt.showSaveLoginPrompt({
      parent: mainWindow, host: site, username: user, groups, categories, activeGroup,
      signal: abort.signal, timeoutMs: APPROVAL_TIMEOUT_MS
    }));
  } catch { return false; }
  finally {
    signal?.removeEventListener("abort", cancel);
    if (saveApprovalAbort === abort) saveApprovalAbort = null;
    approvalOpen = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
  }
}

// One question at a time. The first button is the default and what closing the box means;
// no answer in time is "no".
async function confirmInApp({ message, detail, buttons, signal }) {
  if (approvalOpen || !mainWindow || mainWindow.isDestroyed() || signal?.aborted) return false;

  approvalOpen = true;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => abort.abort(), APPROVAL_TIMEOUT_MS);
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.flashFrame(true);
    const result = await withNativeDialog(() =>
      dialog.showMessageBox(mainWindow, {
        type: "question",
        title: "Secure Login Vault",
        message,
        detail,
        buttons,
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: abort.signal
      })
    );
    return !abort.signal.aborted && result && result.response === 1;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    approvalOpen = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false);
  }
}

// The list in the window was loaded before the browser changed the vault; ask it to reload.
function tellWindowCredentialsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("vault:credentials-changed");
}

async function pairingStatus() {
  const codeActive = extensionPairing.isPairingActive();
  return {
    paired: extensionPairing.isPaired(),
    browsers: extensionPairing.list(),
    codeActive,
    expiresAt: codeActive ? pairingExpiresAt : 0,
    encryptionAvailable: await pairingStorage.isAvailable()
  };
}

function registerExtensionHandlers() {
  handleAppRequest("vault:get-browser-setup", () => handleVaultOperation(() => browserSetup.status()));
  handleAppRequest("vault:setup-browser-extension", () => handleVaultOperation(async () => {
    if (!(await vaultStore.getState()).isUnlocked) throw createPublicError("Unlock the vault first.");
    const result = await browserSetup.setup();
    if (!(await startExtensionBridge())) throw createPublicError(extensionState.error);
    await writeJsonAtomic(extensionSettingsPath(), { enabled: true, askBeforeFill: extensionState.askBeforeFill });
    extensionState.enabled = true;
    // Registration is complete even when Explorer cannot be opened.
    let folderOpened = true;
    try { await browserSetup.openFolder(); } catch { folderOpened = false; }
    return { ...result, folderOpened, bridge: extensionStatus() };
  }));
  handleAppRequest("vault:open-extension-folder", (_event, browser) => handleVaultOperation(async () => {
    if (!(await vaultStore.getState()).isUnlocked) throw createPublicError("Unlock the vault first.");
    return browserSetup.openFolder(browser);
  }));

  // Pairing is only ever started from the unlocked app, by the person at the screen.
  handleAppRequest("vault:get-extension-pairing", async () => {
    return handleVaultOperation(async () => pairingStatus());
  });

  handleAppRequest("vault:start-extension-pairing", async () => {
    return handleVaultOperation(async () => {
      if (!(await vaultStore.getState()).isUnlocked) {
        throw createPublicError("Unlock the vault first.");
      }
      if (!extensionBridge.isRunning()) {
        throw createPublicError("Turn Browser Extension On first.");
      }
      if (!await pairingStorage.isAvailable()) {
        throw createPublicError("Windows encryption is not available for this account, so the pairing cannot be stored safely.");
      }
      assertVaultOperationActive();
      const started = extensionPairing.startPairing();
      pairingExpiresAt = started.expiresAt;
      return { code: started.code, expiresAt: started.expiresAt };
    });
  });

  handleAppRequest("vault:cancel-extension-pairing", async () => {
    return handleVaultOperation(async () => {
      extensionPairing.cancelPairing();
      return pairingStatus();
    });
  });

  handleAppRequest("vault:unpair-extension", async (_event, pairingId) => {
    return handleVaultOperation(async () => {
      if (!(await vaultStore.getState()).isUnlocked) throw createPublicError("Unlock the vault first.");
      if (pairingId !== undefined && (typeof pairingId !== "string" || !/^[0-9a-f]{64}$/.test(pairingId))) throw createPublicError("Choose a paired browser.");
      try {
        await extensionPairing.unpair(pairingId);
      } catch {
        throw createPublicError("The pairing could not be removed. Close other programs using the app data folder and try again.");
      }
      extensionBridge.closeConnections(pairingId); // only the selected browser loses access
      return pairingStatus();
    });
  });

  handleAppRequest("vault:get-extension-bridge", async () => {
    return handleVaultOperation(async () => extensionStatus());
  });

  handleAppRequest("vault:set-extension-bridge", async (_event, payload) => {
    return handleVaultOperation(async () => {
      if (!payload || typeof payload.enabled !== "boolean") {
        throw createPublicError("Choose On or Off.");
      }

      if (payload.enabled) {
        // Only record "on" if it actually started.
        if (!(await startExtensionBridge())) {
          throw createPublicError(extensionState.error);
        }
      } else {
        await extensionBridge.stop();
        extensionState.error = "";
      }

      extensionState.enabled = payload.enabled;
      await writeJsonAtomic(extensionSettingsPath(), { enabled: payload.enabled, askBeforeFill: extensionState.askBeforeFill });
      return extensionStatus();
    });
  });

  // Optional: confirm in the app every time the browser extension wants to fill a login.
  handleAppRequest("vault:set-extension-ask-before-fill", async (_event, payload) => {
    return handleVaultOperation(async () => {
      if (!payload || typeof payload.enabled !== "boolean") {
        throw createPublicError("Choose On or Off.");
      }
      await writeJsonAtomic(extensionSettingsPath(), { enabled: extensionState.enabled, askBeforeFill: payload.enabled });
      extensionState.askBeforeFill = payload.enabled;
      return extensionStatus();
    });
  });
}

function registerLoginHandlers() {
  // "Sign in": the renderer only says which saved entry; the main process reads
  // the credentials itself, so the password never goes through the page.
  handleAppRequest("vault:open-login-window", async (_event, payload) => {
    return handleVaultOperation(async () => {
      const request = payload && typeof payload === "object" ? payload : {};
      const id = Number(request.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw createPublicError("Choose an entry to sign in to.");
      }

      let record;
      if (request.kind === "credential") {
        record = await vaultStore.getCredential(id);
      } else if (request.kind === "client") {
        record = await vaultStore.getClient(id);
      } else {
        throw createPublicError("Choose an entry to sign in to.");
      }

      const target = buildLoginTarget(request.kind, record, request.which);
      if (!target.ok) {
        throw createPublicError(describeTargetProblem(target.reason));
      }

      assertVaultOperationActive();
      const opened = loginWindows.open({ ...target, submit: true });
      return { opened: true, host: opened.host };
    });
  });
}

function registerImportExportHandlers() {
  handleAppRequest("vault:backup-check-status", async () => ({ ok: true,
    result: { ...backupVerification.status(automaticBackups.status().latestBackup),
      hasLatestAutomaticBackup: Boolean(automaticBackups.status().latestBackup) } }));
  handleAppRequest("vault:select-latest-backup-check", async () => handleVaultOperation(async () => {
    const filePath = await automaticBackups.latestForVerification();
    assertVaultOperationActive();
    pathGrants.grant("backup-check", filePath);
    return { filePath };
  }));
  handleAppRequest("vault:pick-backup-check", async () => {
    const picked = await withNativeDialog(() => dialog.showOpenDialog(mainWindow, {
      title: "Select an encrypted backup to verify", properties: ["openFile"],
      filters: [{ name: "Encrypted Backup", extensions: ["slvbackup"] }]
    }));
    if (picked.canceled || !picked.filePaths[0]) return { ok: true, result: { canceled: true } };
    pathGrants.grant("backup-check", picked.filePaths[0]);
    return { ok: true, result: { filePath: picked.filePaths[0] } };
  });
  handleAppRequest("vault:verify-backup", async (_event, { filePath, masterPassword } = {}) => handleVaultOperation(async () => {
    if (!pathGrants.has("backup-check", filePath)) throw createPublicError("Choose a backup to check first.");
    const result = await backupVerification.verify(filePath, masterPassword);
    pathGrants.revoke("backup-check", filePath);
    return result;
  }));
  handleAppRequest("vault:cancel-backup-check", async (_event, { filePath } = {}) => {
    backupVerification.cancel();
    pathGrants.revoke("backup-check", filePath);
    return { ok: true };
  });
  // ─── Phase 9: Import ────────────────────────────────────────────────────────

  handleAppRequest("vault:pick-import-file", async () => {
    const result = await withNativeDialog(() =>
      dialog.showOpenDialog(mainWindow, {
        title: "Select a file to import",
        properties: ["openFile"],
        filters: [
          { name: "Supported files", extensions: ["csv", "json"] },
          { name: "CSV", extensions: ["csv"] },
          { name: "JSON", extensions: ["json"] },
          { name: "All files", extensions: ["*"] }
        ]
      })
    );

    if (result.canceled || !result.filePaths[0]) {
      return { ok: true, result: { canceled: true } };
    }

    return handleVaultOperation(async () => {
      const filePath = result.filePaths[0];
      const content = await readBoundedText(filePath, MAX_IMPORT_BYTES, "an import file", assertVaultOperationActive);
      return {
        canceled: false,
        filePath,
        fileName: path.basename(filePath),
        content
      };
    });
  });

  // ─── Phase 9: Export ────────────────────────────────────────────────────────

  handleAppRequest("vault:authorize-export", async (_event, { masterPassword, format } = {}) => handleVaultOperation(async () => {
    const started = exportApproval.begin();
    if (!["csv", "json"].includes(format)) throw createPublicError("Choose CSV or JSON export.");
    const epoch = vaultStore.getOperationEpoch();
    await vaultStore.verifyExportPassword({ masterPassword });
    assertVaultOperationActive();
    return { token: exportApproval.approve(started, format, epoch) };
  }));
  handleAppRequest("vault:cancel-export", async () => { exportApproval.clear(); return { ok: true }; });
  handleAppRequest("vault:pick-export-path", async (_event, { defaultName, format, token } = {}) => {
    if (!["csv", "json", "backup"].includes(format) || typeof defaultName !== "string" || defaultName.length > 4096) throw createPublicError("Choose a supported export format.");
    if (format !== "backup") exportApproval.validate(token, format, vaultStore.getOperationEpoch());
    const filterMap = {
      csv: { name: "CSV", extensions: ["csv"] },
      json: { name: "JSON", extensions: ["json"] },
      backup: { name: "Encrypted Backup", extensions: ["slvbackup"] }
    };
    const filter = filterMap[format] || { name: "All files", extensions: ["*"] };

    const result = await withNativeDialog(() =>
      dialog.showSaveDialog(mainWindow, {
        title: "Choose where to save the export",
        defaultPath: defaultName,
        filters: [filter]
      })
    );

    if (result.canceled || !result.filePath) {
      if (format !== "backup") exportApproval.clear();
      return { ok: true, result: { canceled: true } };
    }

    // Remember the choice: only a path picked here may be written to below.
    if (format === "backup") pathGrants.grant("backup-export", result.filePath);
    else exportApproval.bind(token, format, vaultStore.getOperationEpoch(), result.filePath);
    return { ok: true, result: { canceled: false, filePath: result.filePath } };
  });

  handleAppRequest("vault:write-export-file", async (_event, { filePath, token, format } = {}) => {
    return handleVaultOperation(async () => {
      const receipt = exportApproval.consume(token, format, vaultStore.getOperationEpoch(), filePath);
      const credentials = await vaultStore.getAllCredentialsForExport();
      assertVaultOperationActive();
      exportApproval.assertLive(receipt, vaultStore.getOperationEpoch());
      const content = format === "json" ? credentialExport.buildJsonExport(credentials) : credentialExport.buildCsvExport(credentials);
      // Stage plaintext exports and recheck the originating unlocked session
      // immediately before publishing them. Cancelled temp files are removed.
      const temporary = `${filePath}.${require("crypto").randomBytes(6).toString("hex")}.tmp`;
      try {
        await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
        exportApproval.assertLive(receipt, vaultStore.getOperationEpoch());
        beforeVaultCommit();
        await fs.rename(temporary, filePath);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      return { written: true, filePath, count: credentials.length };
    });
  });

  // ─── Phase 9: Encrypted Backup & Restore ───────────────────────────────────

  handleAppRequest("vault:create-backup", async (_event, { filePath } = {}) => {
    return handleVaultOperation(async () => {
      if (!pathGrants.has("backup-export", filePath)) {
        throw createPublicError("Choose where to save the backup first.");
      }
      pathGrants.revoke("backup-export", filePath);
      return vaultStore.createEncryptedBackup(filePath);
    });
  });

  handleAppRequest("vault:pick-restore-file", async () => {
    const result = await withNativeDialog(() =>
      dialog.showOpenDialog(mainWindow, {
        title: "Select an encrypted backup to restore",
        properties: ["openFile"],
        filters: [{ name: "Encrypted Backup", extensions: ["slvbackup"] }]
      })
    );

    if (result.canceled || !result.filePaths[0]) {
      return { ok: true, result: { canceled: true } };
    }

    pathGrants.grant("restore", result.filePaths[0]);
    return { ok: true, result: { canceled: false, filePath: result.filePaths[0] } };
  });

  handleAppRequest("vault:restore-backup", async (_event, { filePath, masterPassword } = {}) => {
    return handleVaultOperation(async () => {
      if (!pathGrants.has("restore", filePath)) {
        throw createPublicError("Choose a backup file first.");
      }
      // Kept after a failed attempt (e.g. wrong password) so the user can
      // retry; revoked once the restore succeeds.
      authenticator.clear();
      backupVerification.cancel();
      const outcome = await vaultStore.restoreEncryptedBackup(filePath, masterPassword);
      pathGrants.clear(); exportApproval.clear();
      lockManager.setUnlocked(false); // restore locks the vault
      loginWindows.closeAll();
      pathGrants.revoke("restore", filePath);
      return outcome;
    });
  });
}

// ─── Auto-lock policy ─────────────────────────────────────────────────────────

const LOCK_POLICY_FILE = "lock-policy.json";

function lockPolicyPath() {
  return path.join(app.getPath("userData"), LOCK_POLICY_FILE);
}

async function loadLockPolicy() {
  try {
    lockManager.setPolicy(JSON.parse(await fs.readFile(lockPolicyPath(), "utf8")));
  } catch {
    // Missing or unreadable: keep the built-in defaults until the renderer syncs.
  }
}

function registerLockPolicyHandlers() {
  // The renderer reports its settings; the main process validates, stores and
  // enforces them. Persisted so the policy applies from the next launch too.
  handleAppRequest("vault:set-lock-policy", async (_event, payload) => {
    return handleVaultOperation(async () => {
      let policy;
      try {
        policy = normalizePolicy(payload);
      } catch (error) {
        throw createPublicError(error.message);
      }
      lockManager.setPolicy(policy);
      await writeJsonAtomic(lockPolicyPath(), policy);
      return { applied: true };
    });
  });

  // Fire-and-forget user-activity ping that restarts the inactivity timer.
  ipcMain.on("vault:activity", (event) => {
    if (isTrustedAppSender(event, mainWindow, appPageUrl)) {
      lockManager.noteActivity();
    }
  });
}

function registerSettingsHandlers() {
  const backupOperation = (event, operation) => handleVaultOperation(async () => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw createPublicError("Open Settings in SLV.");
    if (!(await vaultStore.getState()).isUnlocked) throw createPublicError("Unlock the vault first.");
    return operation();
  });
  handleAppRequest("vault:auto-backup-status", event => backupOperation(event, () => automaticBackups.status()));
  handleAppRequest("vault:auto-backup-configure", (event, options) => backupOperation(event, async () => {
    await automaticBackups.configure(options);
    return automaticBackups.run();
  }));
  handleAppRequest("vault:auto-backup-now", event => backupOperation(event, () => automaticBackups.run({ force: true })));
  handleAppRequest("vault:auto-backup-folder", event => backupOperation(event, async () => {
    const result = await withNativeDialog(() => dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder for automatic encrypted backups", properties: ["openDirectory", "createDirectory"]
    }));
    if (result.canceled || !result.filePaths[0]) return automaticBackups.status();
    return automaticBackups.chooseFolder(result.filePaths[0]);
  }));
  // ─── Phase 10: Settings ─────────────────────────────────────────────────────

  handleAppRequest("vault:change-master-password", async (_event, payload) => {
    exportApproval.clear();
    return handleVaultOperation(() => vaultStore.changeMasterPassword(payload));
  });

  handleAppRequest("vault:set-password-hint", async (_event, payload) => {
    return handleVaultOperation(() => vaultStore.setPasswordHint(payload));
  });

  handleAppRequest("vault:create-recovery-key", async (_event, payload) => {
    return handleVaultOperation(() => vaultStore.createRecoveryKey(payload || {}));
  });

  // Works while the vault is locked; leaves it locked (the user logs in next).
  handleAppRequest("vault:reset-with-recovery-key", async (_event, payload) => {
    authenticator.clear();
    backupVerification.cancel();
    const response = await handleVaultOperation(() => vaultStore.resetWithRecoveryKey(payload || {}));
    if (response.ok) {
      pathGrants.clear(); exportApproval.clear();
      authenticator.clear();
      lockManager.setUnlocked(false);
      loginWindows.closeAll();
    }
    return response;
  });

  handleAppRequest("app:get-info", async () => {
    return handleVaultOperation(async () => ({
      version: app.getVersion(),
      userData: app.getPath("userData"),
      vaultDirectory: path.join(app.getPath("userData"), "vault")
    }));
  });

  handleAppRequest("app:pick-folder", async () => {
    const result = await withNativeDialog(() =>
      dialog.showOpenDialog(mainWindow, {
        title: "Select Folder",
        properties: ["openDirectory", "createDirectory"]
      })
    );
    if (result.canceled || !result.filePaths[0]) {
      return { ok: true, result: { canceled: true } };
    }
    return { ok: true, result: { canceled: false, folderPath: result.filePaths[0] } };
  });

  // White-label branding: lets the renderer rename the OS window title bar
  // to match a custom app name set in Settings. Renderer-supplied, so keep
  // this a simple, harmless string op with a sane length cap — it can only
  // ever change window chrome text, never anything security-sensitive.
  handleAppRequest("app:set-window-title", async (_event, title) => {
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
  handleAppRequest("app:set-window-icon", async (_event, dataUri) => {
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

app.whenReady().then(async () => {
  if (!ownsDesktopInstance) return;
  applySessionPermissions(session.defaultSession, { getMainWindow: () => mainWindow, pageUrl: appPageUrl });
  vaultStore = createVaultStore(app.getPath("userData"));
  sensitiveClipboard = createSensitiveClipboard({ clipboard, vault: vaultStore });
  // Register before asynchronous service initialization. These boundaries bypass
  // inactivity settings and native-dialog grace periods. Resume also locks as a
  // fallback if the platform did not deliver a suspend notification.
  systemSessionLocked = powerMonitor.getSystemIdleState(1) === "locked";
  for (const [event, handler] of Object.entries(systemLockHandlers)) powerMonitor.on(event, handler);
  backupVerification = createBackupVerification({ directory: path.join(app.getPath("userData"), "backup-checks") });
  try { await backupVerification.prepare(); }
  catch {
    // An unavailable check folder must not prevent access to the user's vault.
    backupVerification = { cancel() {}, status() { return { lastCheck: null, warning: "Backup check folder is unavailable. Restart SLV and try again.", newerAutomaticBackup: null }; },
      async verify() { throw createPublicError("Backup check folder is unavailable. Restart SLV and try again."); } };
  }
  automaticBackups = createAutomaticBackups({ configPath: path.join(app.getPath("userData"), "automatic-backups.json"), vault: vaultStore });
  authenticator = createAuthenticator({ vault: vaultStore, clipboard });
  await automaticBackups.load();
  automaticBackups.start();
  trashMaintenance = setInterval(() => {
    vaultStore.purgeDeletedCredentials().catch(() => {});
    vaultStore.purgeActivityHistory().catch(() => {});
  }, 60 * 60 * 1000);
  trashMaintenance.unref();
  browserSetup = createBrowserSetup({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: path.join(__dirname, ".."),
    runtimePath: process.execPath,
    localAppData: process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local"),
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    openPath: (folder) => shell.openPath(folder)
  });
  loginWindows = createLoginWindows({
    openExternal: openExternalSafely,
    onBlur: handleAppWindowBlur,
    onFocus: handleAppWindowFocus,
    onActivity: () => lockManager.noteActivity(),
    isDevelopment
  });
  pairingStorage = createPairingStorage({
    filePath: path.join(app.getPath("userData"), "extension-pairing.bin"),
    safeStorage
  });
  extensionPairing = await createPairing({ storage: pairingStorage });
  extensionBridge = createExtensionBridge({
    // SLV_PIPE_USER only exists so tests can use their own pipe, never a real user's.
    pipeName: getPipeName(process.env.SLV_PIPE_USER || undefined),
    handlers: createExtensionHandlers({ getAppVersion: () => app.getVersion(),
      pairing: extensionPairing,
      approve: askBeforeFilling,
      approveSave: askBeforeSaving,
      // Respects the active-group lock like every other read; throws while locked.
      vault: {
        getCredentials: () => vaultStore.getAllCredentials(),
        addCredential: async (data, organization) => {
          if (!organization) throw new Error("Browser save needs an organization choice.");
          const saved = await vaultStore.createBrowserCredential(data, organization);
          tellWindowCredentialsChanged();
          return saved;
        },
        // Only the password changes; everything else about the login is kept as it is.
        updatePassword: async (id, password) => {
          await vaultStore.updateBrowserPassword(id, password);
          tellWindowCredentialsChanged();
        }
      }
    })
  });
  lockManager = createLockManager({
    onLock: (reason) => {
      lockDesktopVault(reason);
    }
  });
  loadLockPolicy();
  registerAuthHandlers();
  registerLockPolicyHandlers();
  registerLoginHandlers();
  registerExtensionHandlers();
  loadExtensionSettings();
  registerImportExportHandlers();
  registerSettingsHandlers();
  desktopIntegration = createDesktopIntegration({
    app, Tray, Menu, configPath: path.join(app.getPath("userData"), "desktop-integration.json"),
    iconPath: DEFAULT_ICON_PATH, getWindow: () => mainWindow,
    isUnlocked: () => vaultStore.isUnlocked(), lockVault: lockDesktopVault, openWindow: showMainWindow
  });
  await desktopIntegration.load();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else showMainWindow();
  });
});

function disposeDesktopServices() {
  backupVerification?.cancel();
  if (servicesDisposed) return;
  servicesDisposed = true;
  for (const [event, handler] of Object.entries(systemLockHandlers)) powerMonitor.removeListener(event, handler);
  pathGrants.clear(); exportApproval.clear(); saveApprovalAbort?.abort();
  desktopIntegration?.dispose();
  automaticBackups?.stop();
  clearInterval(trashMaintenance);
  clipboardCleanup = Promise.all([authenticator?.clear(), sensitiveClipboard?.clear()]);
  if (extensionBridge) {
    extensionBridge.stop();
  }
  if (loginWindows) {
    loginWindows.closeAll();
  }
  if (lockManager) {
    lockManager.dispose();
  }
  if (vaultStore) {
    vaultStore.lockVault();
  }

}

app.on("before-quit", event => {
  desktopIntegration?.beginQuit(); disposeDesktopServices();
  if (quitCleanupComplete) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  // Give asynchronous clipboard cleanup time to finish before Electron exits.
  // A stalled OS clipboard must not leave the application impossible to quit.
  let timeout;
  Promise.race([clipboardCleanup, new Promise(resolve => { timeout = setTimeout(resolve, 2000); })])
    .catch(() => {})
    .finally(() => { clearTimeout(timeout); quitCleanupComplete = true; app.quit(); });
});
app.on("window-all-closed", () => {
  disposeDesktopServices();
  if (process.platform !== "darwin") app.quit();
});
