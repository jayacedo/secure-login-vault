// What the app answers to the browser extension, by message "type". Each handler
// receives the validated request and returns the fields of the reply (the bridge
// adds "id" and "ok"), or throws to send a generic failure.
//
// Phase 1 knows a single question, "are you there?". Nothing here reveals vault
// contents or whether the vault is locked.

const PROTOCOL_VERSION = 1;

function createExtensionHandlers({ getAppVersion }) {
  return {
    ping() {
      return { type: "pong", appVersion: getAppVersion(), protocol: PROTOCOL_VERSION };
    }
  };
}

module.exports = { createExtensionHandlers, PROTOCOL_VERSION };
