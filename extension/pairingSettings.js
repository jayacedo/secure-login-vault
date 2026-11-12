(function () {
  const extensionApi = globalThis.SLVApi || chrome;
  const toggle = document.getElementById("session-pairing");
  const note = document.getElementById("session-pairing-note");
  let knownMode = false;
  async function update(message) {
    toggle.disabled = true;
    try {
      const result = await extensionApi.runtime.sendMessage(message);
      if (typeof result?.sessionOnly !== "boolean") throw new Error("Unavailable");
      toggle.checked = result.sessionOnly;
      knownMode = result.sessionOnly;
      note.textContent = result.sessionOnly ? "Pair again after the browser restarts or the extension reloads. The browser keeps the pairing secret only in memory." : "Pairing is remembered in this browser profile. Enable this option to keep its secret off disk.";
    } catch { toggle.checked = knownMode; note.textContent = "Could not change pairing storage. Reload the extension and check the setting again."; }
    finally { toggle.disabled = false; }
  }
  toggle.addEventListener("change", () => update({ type: "pairing-storage-set", sessionOnly: toggle.checked }));
  update({ type: "pairing-storage-get" });
})();
