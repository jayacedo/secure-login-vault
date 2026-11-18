// Plaintext export confirmation. Passwords are never retained in module state.
let plaintextExportState = null;

function closePlaintextExport() {
  const state = plaintextExportState;
  if (!state) return;
  plaintextExportState = null;
  state.overlay.querySelector("input").value = "";
  state.overlay.remove();
  window.secureLoginVault.importExport.cancelExport().catch(() => {});
  state.trigger?.focus();
}

function openPlaintextExport(format, trigger) {
  if (plaintextExportState || !["csv", "json"].includes(format)) return;
  const overlay = document.createElement("div");
  overlay.id = "plaintext-export-overlay";
  overlay.className = "modal-overlay is-open";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "plaintext-export-heading");
  overlay.innerHTML = `<form class="modal-container backup-check-container">
    <div class="modal-header"><h2 id="plaintext-export-heading">Export ${format.toUpperCase()}?</h2>
      <button type="button" class="modal-close-btn" aria-label="Close">${renderCloseIcon()}</button></div>
    <div class="modal-body">
      <p><strong>This file contains unencrypted passwords.</strong></p>
      <p class="settings-section-hint">All saved logins will be exported, including entries outside your current group or filter. Anyone who can open the file can read its contents. Use an encrypted backup for safekeeping.</p>
      <label class="field-label" for="plaintext-export-password">Confirm master password</label>
      <input id="plaintext-export-password" class="settings-input" type="password" maxlength="256" autocomplete="off" spellcheck="false" required>
      <p class="settings-section-hint">Approval lasts two minutes and permits one export.</p>
      <p id="plaintext-export-status" role="status" aria-live="polite"></p>
    </div>
    <div class="modal-footer"><button type="button" class="secondary-button" id="plaintext-export-cancel">Cancel</button>
      <button type="submit" class="primary-button" id="plaintext-export-confirm">Export ${format.toUpperCase()}</button></div>
  </form>`;
  const state = plaintextExportState = { overlay, trigger, busy: false };
  const input = overlay.querySelector("input");
  const status = overlay.querySelector("#plaintext-export-status");
  const confirm = overlay.querySelector("#plaintext-export-confirm");
  overlay.querySelector(".modal-close-btn").addEventListener("click", closePlaintextExport);
  overlay.querySelector("#plaintext-export-cancel").addEventListener("click", closePlaintextExport);
  overlay.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    if (state.busy || plaintextExportState !== state || !input.value) return;
    state.busy = true; confirm.disabled = true; input.disabled = true;
    status.textContent = "Confirming master password…";
    const api = window.secureLoginVault.importExport;
    try {
      const pending = api.authorizeExport({ format, masterPassword: input.value });
      input.value = "";
      const approval = await pending;
      if (plaintextExportState !== state) return;
      if (!approval.ok) throw Error(approval.message);
      status.textContent = "Choose where to save the export…";
      const token = approval.result.token;
      const picked = await api.pickExportPath({ format, token,
        defaultName: `secure-login-vault-export-${new Date().toISOString().slice(0, 10)}.${format}` });
      if (plaintextExportState !== state) return;
      if (!picked.ok) throw Error(picked.message);
      if (picked.result.canceled) { closePlaintextExport(); return; }
      status.textContent = "Exporting…";
      const written = await api.writeExportFile({ format, token, filePath: picked.result.filePath });
      if (plaintextExportState !== state) return;
      if (!written.ok) throw Error(written.message);
      const { count, filePath } = written.result;
      closePlaintextExport();
      setSettingsStatus(`Exported ${count} login${count === 1 ? "" : "s"} to ${filePath}.`);
      showToast("Export complete", "info");
    } catch (error) {
      if (plaintextExportState !== state) return;
      await api.cancelExport().catch(() => {});
      if (plaintextExportState !== state) return;
      status.textContent = error.message || "Export failed. Please try again.";
    } finally {
      input.value = "";
      if (plaintextExportState === state) {
        state.busy = false; confirm.disabled = false; input.disabled = false; input.focus();
      }
    }
  });
  document.body.append(overlay);
  input.focus();
}
