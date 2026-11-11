// What the app answers to the browser extension, by message "type". Each handler
// receives the validated request and the connection's context, and returns the fields
// of the reply (the bridge adds "id" and "ok"). Returning { error } sends a failure
// reply; throwing sends a generic one.
//
// Open to any caller (they reveal nothing about the vault):
//   ping                          "are you there?"
//   pair-begin / pair-finish      one-time pairing, needs the code shown in the app
//   auth-begin / auth-finish      two-way proof with the paired secret
// Everything else goes through requireAuth(): only a connection that has completed
// auth-finish may use it.
//   find-logins { url }           which saved logins belong to this page (exact origin);
//                                 names and usernames only, never passwords
//   get-login { loginId, url }    the username and password of ONE saved login, only if its
//                                 saved address has exactly the origin of url. The only
//                                 request that ever returns a password.
//   save-login { url, username, password }
//                                 add a new login for the exact origin of url, or update the
//                                 password of the saved login with the same origin and username.
//                                 ALWAYS confirmed by the person in the app first; nothing is
//                                 written without that.

const { matchLogins } = require("./siteMatch");
const { createRateLimiter } = require("./rateLimit");
const { originOf } = require("./siteLogin");

const PROTOCOL_VERSION = 1;

// Wraps a handler so it only runs for an authenticated connection.
function requireAuth(handler) {
  return (request, context) => {
    if (!context || context.authenticated !== true) return { error: "not-authenticated" };
    return handler(request, context);
  };
}

const LOCKED_MESSAGE = "Vault is locked.";

// Passwords leave the app one at a time, and not faster than a person could use them.
const FILL_LIMITS = Object.freeze({ perConnection: 10, overall: 20, windowMs: 60 * 1000 });

// Saving changes the vault, so it is limited much harder than filling.
const SAVE_LIMITS = Object.freeze({ perConnection: 5, overall: 10, windowMs: 60 * 1000 });
const MAX_USERNAME = 256;
const MAX_PASSWORD = 1024;

// vault: { getCredentials() }            required for find-logins and get-login
// approve({ host, name }) -> boolean      optional: ask the person in the app before a password is released
// vault.addCredential(data), vault.updatePassword(id, password)   needed for save-login
// approveSave({ host, username, name, mode }) -> boolean   required for save-login (mode "add" | "update");
//                                         without it nothing is ever saved
function createExtensionHandlers({ getAppVersion, pairing, vault, approve, approveSave, now = Date.now, fillLimits = {}, saveLimits = {} }) {
  const limits = { ...FILL_LIMITS, ...fillLimits };
  const overallLimiter = createRateLimiter({ max: limits.overall, windowMs: limits.windowMs, now });
  const saveLimit = { ...SAVE_LIMITS, ...saveLimits };
  const overallSaveLimiter = createRateLimiter({ max: saveLimit.overall, windowMs: saveLimit.windowMs, now });
  const handlers = {
    ping() {
      return { type: "pong", appVersion: getAppVersion(), protocol: PROTOCOL_VERSION };
    }
  };

  if (pairing) {
    handlers["pair-begin"] = (request, context) => pairing.pairBegin(request, context);
    handlers["pair-finish"] = (request, context) => pairing.pairFinish(request, context);
    handlers["auth-begin"] = (request, context) => pairing.authBegin(request, context);
    handlers["auth-finish"] = (request, context) => pairing.authFinish(request, context);
  }

  // The credentials the person may see, or { error: "locked" }; other failures are thrown.
  async function readCredentials() {
    try {
      return { credentials: await vault.getCredentials() };
    } catch (error) {
      if (error && error.message === LOCKED_MESSAGE) return { error: "locked" };
      throw error; // anything else is a failure, not "locked"
    }
  }

  if (vault) {
    handlers["find-logins"] = requireAuth(async (request) => {
      if (typeof request.url !== "string") return { error: "bad-message" };

      const read = await readCredentials();
      if (read.error) return { error: read.error };

      const match = matchLogins(request.url, read.credentials);
      if (!match.ok) return { error: match.reason };
      return { host: match.host, logins: match.logins };
    });

    handlers["get-login"] = requireAuth(async (request, context) => {
      // loginId is a number, not a numeric string, and url is the page's origin.
      if (!Number.isSafeInteger(request.loginId) || typeof request.url !== "string") return { error: "bad-message" };

      // Counted before anything else, so guessing ids or origins is limited too.
      if (!context.fillLimiter) context.fillLimiter = createRateLimiter({ max: limits.perConnection, windowMs: limits.windowMs, now });
      if (!context.fillLimiter.take() || !overallLimiter.take()) return { error: "rate-limited" };

      const read = await readCredentials();
      if (read.error) return { error: read.error };

      const credential = (Array.isArray(read.credentials) ? read.credentials : []).find((c) => c && typeof c === "object" && Number(c.id) === request.loginId);
      if (!credential) return { error: "no-match" };

      // The page must be exactly the site this login was saved for: the same rule as
      // find-logins, applied to this one login, so an id cannot be used on another site.
      const match = matchLogins(request.url, [credential]);
      if (!match.ok) return { error: match.reason };
      if (match.logins.length !== 1) return { error: "no-match" };

      const username = String(credential.username || credential.email || "");
      const password = String(credential.password || "");
      if (!username && !password) return { error: "no-credentials" };

      if (approve) {
        // Only the site and the entry's name are shown; the person decides in the app.
        const approved = await approve({ host: match.host, name: match.logins[0].name });
        if (approved !== true) return { error: "declined" };

        // Time has passed while the person decided: the vault may have been locked or the
        // entry changed. Read it again and apply every check to what is there now.
        const fresh = await readCredentials();
        if (fresh.error) return { error: fresh.error };
        const current = (Array.isArray(fresh.credentials) ? fresh.credentials : []).find((c) => c && typeof c === "object" && Number(c.id) === request.loginId);
        const again = current ? matchLogins(request.url, [current]) : null;
        if (!again || !again.ok || again.logins.length !== 1) return { error: "no-match" };
        return { host: again.host, username: String(current.username || current.email || ""), password: String(current.password || "") };
      }

      return { host: match.host, username, password };
    });

    // The saved login (if any) for exactly this origin and username.
    const findSaved = (credentials, url, username) =>
      (Array.isArray(credentials) ? credentials : []).find((c) => {
        if (!c || typeof c !== "object" || !Number.isSafeInteger(Number(c.id))) return false;
        if (String(c.username || c.email || "").trim() !== username) return false;
        const match = matchLogins(url, [c]);
        return match.ok && match.logins.length === 1;
      });

    const isLocked = (error) => Boolean(error && error.message === LOCKED_MESSAGE);

    handlers["save-login"] = requireAuth(async (request, context) => {
      if (typeof request.url !== "string" || typeof request.username !== "string" || typeof request.password !== "string") return { error: "bad-message" };
      const username = request.username.trim();
      if (!username || username.length > MAX_USERNAME || !request.password || request.password.length > MAX_PASSWORD) return { error: "bad-message" };

      // The page must be a secure page of a real site; only its origin is ever saved.
      const page = matchLogins(request.url, []);
      if (!page.ok) return { error: page.reason };
      const origin = originOf(request.url);
      if (!origin) return { error: "unsupported-page" };

      if (!context.saveLimiter) context.saveLimiter = createRateLimiter({ max: saveLimit.perConnection, windowMs: saveLimit.windowMs, now });
      if (!context.saveLimiter.take() || !overallSaveLimiter.take()) return { error: "rate-limited" };

      const read = await readCredentials();
      if (read.error) return { error: read.error };
      const existing = findSaved(read.credentials, origin, username);
      if (existing && String(existing.password || "") === request.password) return { error: "unchanged" };

      const mode = existing ? "update" : "add";
      const name = existing ? String(existing.websiteName || page.host) : page.host;

      // Always asked, never optional. With no way to ask, nothing is saved.
      if (typeof approveSave !== "function") return { error: "declined" };
      const previousPassword = existing ? String(existing.password || "") : null;
      const approved = await approveSave({ host: page.host, username, name, mode }, context.signal);
      if (approved !== true || context.authenticated !== true || context.signal?.aborted) return { error: "declined" };

      // Time has passed while the person decided: look again and save only what they agreed to.
      const fresh = await readCredentials();
      if (fresh.error) return { error: fresh.error };
      const now2 = findSaved(fresh.credentials, origin, username);
      const sameChoice = existing ? now2 && Number(now2.id) === Number(existing.id) && String(now2.password || "") === previousPassword : !now2;
      if (!sameChoice) return { error: "changed" };
      if (context.authenticated !== true || context.signal?.aborted) return { error: "declined" };

      try {
        if (existing) await vault.updatePassword(Number(existing.id), request.password);
        else await vault.addCredential({ websiteName: page.host, websiteUrl: origin, username, password: request.password });
      } catch (error) {
        if (isLocked(error)) return { error: "locked" };
        throw error;
      }
      return { host: page.host, mode };
    });
  }

  return handlers;
}

module.exports = { createExtensionHandlers, requireAuth, PROTOCOL_VERSION, FILL_LIMITS, SAVE_LIMITS };
