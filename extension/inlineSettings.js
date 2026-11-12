(function () {
  const api = globalThis.SLVApi || chrome;
  const toggle = document.getElementById("inline-enabled");
  const note = document.getElementById("inline-note");
  async function update(message) {
    const result = await api.runtime.sendMessage(message);
    if (!result || result.error) throw Error("Unavailable");
    toggle.checked = result.enabled === true;
    note.textContent = result.enabled ? "On. Reload open login pages once, then focus a login field and click SLV. The app must be running and paired." : "Off. Fill in the extension popup still works.";
  }
  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked; toggle.disabled = true;
    try {
      if (enabled && !(await api.permissions.request({ origins: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"] }))) {
        toggle.checked = false; note.textContent = "Website access was not allowed. Use Fill in the extension popup."; return;
      }
      await update({ type: "inline-set", enabled });
    } catch { toggle.checked = false; note.textContent = "Could not change inline fill. Reload the extension and check again."; }
    finally { toggle.disabled = false; }
  });
  update({ type: "inline-get" }).catch(() => { note.textContent = "Reload the extension to check this setting."; }).finally(() => { toggle.disabled = false; });
})();
