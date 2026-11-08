const crypto = require("crypto");
const { BrowserWindow } = require("electron");
const { canFillAt, buildFillScript } = require("./siteLogin");

// Opens a saved site in its own window and fills its login form.
//
// Safety properties (see siteLogin.js for the URL/origin rules):
//  - The renderer never sees the password; the main process holds it only while
//    the window is open and drops it when the window closes.
//  - Each window gets a throwaway in-memory session (no cookies kept on disk).
//  - The form is only filled while the page is on exactly the saved origin, and
//    the injected script re-checks that itself. A password is filled at most
//    once per window, so a wrong password is never retried (no lock-outs).
//  - The fill runs in an isolated JavaScript world, so the page's own scripts
//    cannot read the credentials from it.
//  - Camera/location/notification and similar permission requests are denied.

const ISOLATED_WORLD_ID = 1000;
const FILL_ATTEMPT_DELAYS_MS = [0, 400, 1200, 2500, 5000, 9000];
const MAX_WINDOWS = 8;
const ACTIVITY_THROTTLE_MS = 5000;

function createPublicError(message) {
  const error = new Error(message);
  error.isPublic = true;
  return error;
}

function createLoginWindows({
  openExternal,
  onBlur = () => {},
  onFocus = () => {},
  onActivity = () => {},
  show = true,
  isDevelopment = false
} = {}) {
  const windows = new Set();

  function open(target) {
    if (windows.size >= MAX_WINDOWS) {
      throw createPublicError("Too many login windows are open. Close one and try again.");
    }

    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      minWidth: 640,
      minHeight: 480,
      show: false,
      title: target.host,
      backgroundColor: "#ffffff",
      autoHideMenuBar: true,
      webPreferences: {
        // No "persist:" prefix: the session lives in memory and disappears.
        partition: `slv-login-${crypto.randomUUID()}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: isDevelopment
      }
    });
    win.removeMenu();
    windows.add(win);

    const contents = win.webContents;
    const loginSession = contents.session;

    // Secrets live only in this closure until the window closes.
    let credentials = { username: target.username, password: target.password };
    const state = {
      closed: false,
      busy: false,
      passwordFills: 0,
      usernameFills: 0,
      cycle: 0,
      timers: new Set(),
      lastActivity: 0
    };

    loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    loginSession.setPermissionCheckHandler(() => false);

    // ── Navigation: web pages only ──────────────────────────────────────────
    const onlyWebAddresses = (event, url) => {
      if (!/^https?:/i.test(url)) event.preventDefault();
    };
    contents.on("will-navigate", onlyWebAddresses);
    contents.on("will-redirect", onlyWebAddresses);

    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) {
        if (canFillAt(url, target.origin)) {
          // Same site: stay in this window.
          setImmediate(() => {
            if (!win.isDestroyed()) contents.loadURL(url);
          });
        } else if (openExternal) {
          openExternal(url);
        }
      }
      return { action: "deny" };
    });

    // The title always shows the host the window is really on, so a redirect to
    // a different site is visible.
    function updateTitle(pageTitle) {
      if (win.isDestroyed()) return;
      let host = target.host;
      try {
        host = new URL(contents.getURL()).host || host;
      } catch {
        // keep the saved host
      }
      win.setTitle(pageTitle ? `${host} - ${pageTitle}` : host);
    }
    contents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      updateTitle(title);
    });
    contents.on("did-navigate", () => updateTitle(contents.getTitle()));

    // ── Filling ─────────────────────────────────────────────────────────────
    function clearTimers() {
      for (const timer of state.timers) clearTimeout(timer);
      state.timers.clear();
    }

    // Returns "retry" while nothing fillable was found yet, otherwise "stop".
    async function attemptFill() {
      if (state.closed || win.isDestroyed() || state.passwordFills >= 1) return "stop";
      if (!canFillAt(contents.getURL(), target.origin)) return "retry";

      let result;
      try {
        result = await contents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [
          {
            code: buildFillScript(credentials, {
              submit: target.submit,
              expectedOrigin: target.origin,
              skipUsernameOnly: state.usernameFills >= 1
            })
          }
        ]);
      } catch {
        return "retry";
      }

      if (!result || result.status === "blocked" || result.status === "no-form") return "retry";
      if (result.status === "filled" && result.filledPassword) {
        state.passwordFills += 1;
        return "stop";
      }
      if (result.status === "username-only" && result.filledUsername) {
        // Keep watching: the password field usually appears next, on this page
        // or on the one it navigates to.
        state.usernameFills += 1;
        return "retry";
      }
      return "retry";
    }

    // Pages (especially single-page apps) draw their login form late, so try a
    // few times after each load.
    function startFillCycle() {
      clearTimers();
      state.cycle += 1;
      const cycle = state.cycle;

      for (const delay of FILL_ATTEMPT_DELAYS_MS) {
        const timer = setTimeout(async () => {
          state.timers.delete(timer);
          if (cycle !== state.cycle || state.busy || state.closed) return;
          state.busy = true;
          try {
            if ((await attemptFill()) === "stop" && cycle === state.cycle) {
              state.cycle += 1; // cancels this cycle's remaining attempts
              clearTimers();
            }
          } finally {
            state.busy = false;
          }
        }, delay);
        state.timers.add(timer);
      }
    }

    contents.on("did-finish-load", startFillCycle);
    contents.on("did-navigate-in-page", startFillCycle);

    // ── App-wide lock bookkeeping ───────────────────────────────────────────
    win.on("blur", onBlur);
    win.on("minimize", onBlur);
    win.on("focus", onFocus);
    win.on("restore", onFocus);

    const noteActivity = () => {
      const now = Date.now();
      if (now - state.lastActivity < ACTIVITY_THROTTLE_MS) return;
      state.lastActivity = now;
      onActivity();
    };
    contents.on("before-input-event", noteActivity);
    contents.on("input-event", noteActivity);

    if (!isDevelopment) {
      contents.on("devtools-opened", () => contents.closeDevTools());
    }

    win.once("ready-to-show", () => {
      if (show) win.show();
    });

    win.on("closed", () => {
      state.closed = true;
      clearTimers();
      credentials = null; // drop the secrets
      windows.delete(win);
      loginSession.clearStorageData().catch(() => {});
      loginSession.clearCache().catch(() => {});
    });

    contents.loadURL(target.url).catch(() => {
      // A failed load shows Chromium's own error page; nothing to do here.
    });

    return { host: target.host, window: win };
  }

  function closeAll() {
    for (const win of [...windows]) {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  return {
    open,
    closeAll,
    count: () => windows.size
  };
}

module.exports = { createLoginWindows };
