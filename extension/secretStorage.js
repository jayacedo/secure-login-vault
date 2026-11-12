// Pairing persistence is explicit. Session-only mode uses Chrome's memory storage;
// local mode preserves existing pairing behavior, but is NOT OS-encrypted storage.
(function (root) {
  const KEY = "slvPairingSecret";
  const MODE = "slvSessionPairing";
  function createSecretStorage(chrome) {
    const local = chrome.isFirefox ? root.SLVPrivateStorage.createPrivateStorage() : chrome.storage.local;
    // Firefox session storage is never exposed to content scripts. Its local
    // extension storage is, so neither the secret nor its mode is kept there.
    const ready = chrome.isFirefox ? Promise.all([
      local.ready,
      chrome.storage.session.get(MODE),
      chrome.storage.local.remove(KEY)
    ]) : Promise.all([
      chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
      chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    ]);
    ready.catch(() => {});
    async function sessionOnly() { await ready; return (await local.get(MODE))[MODE] === true; }
    const area = only => only ? chrome.storage.session : local;
    return {
      ready,
      sessionOnly,
      async get() {
        const only = await sessionOnly();
        if (only) await local.remove(KEY); // repair an interrupted migration, never restore a disk secret
        const value = (await area(only).get(KEY))[KEY];
        return typeof value === "string" ? value : null;
      },
      async set(secret) {
        const only = await sessionOnly();
        await area(only).set({ [KEY]: secret });
        await area(!only).remove(KEY);
      },
      async clear() { await ready; await local.remove(KEY); await chrome.storage.session.remove(KEY); },
      async setSessionOnly(only) {
        if (typeof only !== "boolean") throw new Error("Invalid mode");
        const oldMode = await sessionOnly();
        if (only === oldMode) return;
        const secret = (await area(oldMode).get(KEY))[KEY];
        if (typeof secret === "string") await area(only).set({ [KEY]: secret });
        await area(oldMode).remove(KEY);
        await local.set({ [MODE]: only });
      }
    };
  }
  root.SLVSecretStorage = { createSecretStorage };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SLVSecretStorage;
})(typeof self !== "undefined" ? self : globalThis);
