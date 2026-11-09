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

const { matchLogins } = require("./siteMatch");
const { createRateLimiter } = require("./rateLimit");

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

// vault: { getCredentials() }            required for find-logins and get-login
// approve({ host, name }) -> boolean      optional: ask the person in the app before a password is released
function createExtensionHandlers({ getAppVersion, pairing, vault, approve, now = Date.now, fillLimits = {} }) {
  const limits = { ...FILL_LIMITS, ...fillLimits };
  const overallLimiter = createRateLimiter({ max: limits.overall, windowMs: limits.windowMs, now });
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
  }

  return handlers;
}

module.exports = { createExtensionHandlers, requireAuth, PROTOCOL_VERSION, FILL_LIMITS };
