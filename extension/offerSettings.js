(function () {
  const extensionApi = globalThis.SLVApi || chrome;
  const toggle = document.getElementById("offers-enabled");
  const allow = document.getElementById("offers-allow");
  const note = document.getElementById("offers-note");
  const origins = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];
  async function update(message, changed = false) {
    try {
      const result = await extensionApi.runtime.sendMessage(message);
      if (!result || result.error) throw new Error("Unavailable");
      toggle.checked = result.enabled === true;
      allow.hidden = !result.blocked;
      note.textContent = result.blocked ? "Offers are off for " + result.host + "." :
        result.enabled ? (changed ? "Enabled. Reload open login pages once. Keep SLV running and paired." : "On. SLV must be running and paired. You confirm saves in the app.") : "Off. You can still use Save this login above.";
    } catch {
      note.textContent = "Could not change offers. Reload the extension and try again.";
    } finally { toggle.disabled = false; allow.disabled = false; }
  }
  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    toggle.disabled = true;
    try {
      // Chrome requires this request to run directly from the user's gesture.
      if (enabled && !(await extensionApi.permissions.request({ origins }))) {
        toggle.checked = false;
        note.textContent = "Website access was not allowed. Manual Save still works.";
        return;
      }
      await update({ type: "offers-set", enabled }, true);
    } catch { toggle.checked = false; note.textContent = "Could not enable offers. Reload the extension and try again."; }
    finally { toggle.disabled = false; }
  });
  allow.addEventListener("click", () => {
    allow.disabled = true;
    update({ type: "offers-allow-site" }, true);
  });
  update({ type: "offers-get" });
})();
