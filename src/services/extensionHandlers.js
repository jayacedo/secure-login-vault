// What the app answers to the browser extension, by message "type". Each handler
// receives the validated request and the connection's context, and returns the fields
// of the reply (the bridge adds "id" and "ok"). Returning { error } sends a failure
// reply; throwing sends a generic one.
//
// Open to any caller (they reveal nothing about the vault):
//   ping                          "are you there?"
//   pair-begin / pair-finish      one-time pairing, needs the code shown in the app
//   auth-begin / auth-finish      two-way proof with the paired secret
// Everything added later goes through requireAuth(): only a connection that has
// completed auth-finish may use it.

const PROTOCOL_VERSION = 1;

// Wraps a handler so it only runs for an authenticated connection.
function requireAuth(handler) {
  return (request, context) => {
    if (!context || context.authenticated !== true) return { error: "not-authenticated" };
    return handler(request, context);
  };
}

function createExtensionHandlers({ getAppVersion, pairing }) {
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

  return handlers;
}

module.exports = { createExtensionHandlers, requireAuth, PROTOCOL_VERSION };
