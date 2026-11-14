const fs = require('fs/promises');
const { writeJsonAtomic } = require('./fsUtils');

const DEFAULTS = Object.freeze({ startWithWindows: false, startInTray: false, closeToTray: false });
const STARTUP_ARGUMENT = '--slv-startup';
class DesktopIntegrationError extends Error {}
function normalizePreferences(value) {
  if (!value || typeof value !== 'object' || Object.keys(DEFAULTS).some(key => typeof value[key] !== 'boolean')) {
    throw new DesktopIntegrationError('Choose valid startup and tray settings.');
  }
  return Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, value[key]]));
}

function createDesktopIntegration({ app, Tray, Menu, configPath, iconPath, getWindow, isUnlocked,
  lockVault, openWindow, platform = process.platform, portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
  executable = process.execPath, write = writeJsonAtomic }) {
  const supported = platform === 'win32';
  const startupSupported = supported && app.isPackaged && !portable;
  // Electron's Windows launch-item lookup parses path as a command line. Without
  // quotes, a spaced install path is truncated and a successful registration
  // incorrectly looks disabled. Use the same quoted path for reads and writes.
  const loginOptions = { path: `"${executable}"`, args: [STARTUP_ARGUMENT] };
  let preferences = { ...DEFAULTS }, tray = null, quitting = false, saving = false, warning = '';

  function loginState() {
    return startupSupported ? app.getLoginItemSettings(loginOptions) : { openAtLogin: false, executableWillLaunchAtLogin: false };
  }
  function status() {
    let startup = false;
    try { const login = loginState(); startup = Boolean(login.openAtLogin && login.executableWillLaunchAtLogin); }
    catch { warning = 'Windows startup status could not be read.'; }
    return { ...preferences, startWithWindows: startup, supported, startupSupported, trayAvailable: Boolean(tray), warning };
  }
  function refresh() {
    const wanted = supported && Object.values(preferences).some(Boolean);
    if (!wanted && tray) {
      // Removing the only way to reopen a hidden app must bring its window back.
      if (!getWindow()?.isVisible()) openWindow();
      tray.destroy(); tray = null;
    }
    if (wanted && !tray) {
      try {
        tray = new Tray(iconPath);
        tray.on('click', openWindow);
        tray.on('double-click', openWindow);
        warning = '';
      } catch { tray = null; warning = 'The system tray is unavailable. SLV will open as a normal window.'; }
    }
    if (tray) {
      tray.setToolTip(`Secure Login Vault — ${isUnlocked() ? 'Unlocked' : 'Locked'}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open SLV', click: openWindow },
        { label: 'Lock Vault', enabled: isUnlocked(), click: () => lockVault('tray') },
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } }
      ]));
    }
  }
  return {
    async load() {
      try { preferences = normalizePreferences(JSON.parse(await fs.readFile(configPath, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') warning = 'Startup preferences could not be read; default window behavior is being used.'; }
      // Never rewrite Windows startup registration just because the app launched.
      refresh();
    },
    status, refresh,
    async configure(value) {
      if (saving) throw new DesktopIntegrationError('Startup settings are already being saved.');
      const next = normalizePreferences(value);
      if (!supported || (next.startWithWindows && !startupSupported)) throw new DesktopIntegrationError('Start with Windows requires the installed Windows app.');
      saving = true;
      let oldLogin, changedLogin = false;
      let failureMessage = 'Could not update Windows startup. Check Windows Startup Apps and try again.';
      try {
        if (startupSupported) {
          oldLogin = loginState();
          const currentlyEnabled = Boolean(oldLogin.openAtLogin && oldLogin.executableWillLaunchAtLogin);
          if (currentlyEnabled !== next.startWithWindows || (!next.startWithWindows && oldLogin.openAtLogin)) {
            changedLogin = true;
            app.setLoginItemSettings({ ...loginOptions, openAtLogin: next.startWithWindows, enabled: next.startWithWindows });
            const actual = loginState();
            if (Boolean(actual.openAtLogin && actual.executableWillLaunchAtLogin) !== next.startWithWindows) throw new DesktopIntegrationError('Windows did not apply the startup setting. Check Windows Startup Apps and try again.');
          }
        }
        failureMessage = 'Could not save startup and tray preferences. Check access to the app data folder and try again.';
        await write(configPath, next);
        preferences = next; refresh();
        return status();
      } catch (error) {
        if (changedLogin && oldLogin) {
          try { app.setLoginItemSettings({ ...loginOptions, openAtLogin: Boolean(oldLogin.openAtLogin), enabled: Boolean(oldLogin.executableWillLaunchAtLogin) }); } catch { /* Status reports the actual Windows registration on the next read. */ }
        }
        throw error instanceof DesktopIntegrationError ? error : new DesktopIntegrationError(failureMessage);
      } finally { saving = false; }
    },
    hasTray: () => Boolean(tray),
    shouldStartHidden: (args, hasVault) => Boolean(hasVault && tray && preferences.startInTray && args.includes(STARTUP_ARGUMENT)),
    hideLocked() {
      if (!tray || quitting) return false;
      lockVault('tray'); getWindow()?.hide(); return true;
    },
    handleClose(event) {
      if (quitting || !tray || (!preferences.closeToTray && isUnlocked())) return;
      event.preventDefault(); this.hideLocked();
    },
    beginQuit() { quitting = true; },
    dispose() { quitting = true; tray?.destroy(); tray = null; }
  };
}
module.exports = { createDesktopIntegration, normalizePreferences, DEFAULTS, STARTUP_ARGUMENT, DesktopIntegrationError };
