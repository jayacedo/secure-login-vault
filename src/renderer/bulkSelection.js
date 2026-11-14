// Selection contains IDs only and is cleared whenever the visible list refreshes.
let bulkSelectionEnabled = false;
const bulkSelectedIds = new Set();
let bulkMoveDialog = null;

function renderBulkSelectionCell(entry) {
  return `<span role="cell" class="bulk-select-cell"><input type="checkbox" data-select-credential="${entry.id}" aria-label="Select ${escapeHtml(entry.websiteName)}"></span>`;
}

function updateBulkSelectionControls() {
  const table = document.querySelector(".credential-table");
  table?.classList.toggle("is-selecting", bulkSelectionEnabled);
  const bar = document.querySelector("#bulk-selection-bar");
  if (!bar) return;
  bar.hidden = !bulkSelectionEnabled;
  document.querySelector("#bulk-select-toggle").setAttribute("aria-pressed", String(bulkSelectionEnabled));
  document.querySelector("#bulk-selection-count").textContent = `${bulkSelectedIds.size} selected`;
  document.querySelector("#bulk-move-btn").disabled = bulkSelectedIds.size === 0;
  const checks = [...table.querySelectorAll("[data-select-credential]")];
  for (const check of checks) {
    check.checked = bulkSelectedIds.has(Number(check.dataset.selectCredential));
    check.closest(".credential-row").classList.toggle("is-bulk-selected", check.checked);
  }
  const all = document.querySelector("#bulk-select-all");
  all.disabled = checks.length === 0;
  all.checked = checks.length > 0 && checks.every(check => check.checked);
  all.indeterminate = bulkSelectedIds.size > 0 && !all.checked;
}

function resetBulkSelection() {
  bulkSelectionEnabled = false;
  bulkSelectedIds.clear();
  closeBulkMove();
  updateBulkSelectionControls();
}

function setupBulkSelection() {
  document.querySelector("#bulk-select-toggle").addEventListener("click", () => {
    if (bulkSelectionEnabled) resetBulkSelection();
    else { bulkSelectionEnabled = true; updateBulkSelectionControls(); document.querySelector("#bulk-select-all").focus(); }
  });
  document.querySelector("#bulk-selection-cancel").addEventListener("click", () => { resetBulkSelection(); document.querySelector("#bulk-select-toggle").focus(); });
  document.querySelector("#bulk-move-btn").addEventListener("click", openBulkMove);
  document.querySelector(".credential-table").addEventListener("change", event => {
    if (!bulkSelectionEnabled) return;
    if (event.target.id === "bulk-select-all") {
      const checks = [...document.querySelectorAll("[data-select-credential]")];
      if (event.target.checked && checks.length > 500) showToast("Select up to 500 entries at a time. Filter the list to narrow it down.", "info");
      else { bulkSelectedIds.clear(); if (event.target.checked) checks.forEach(check => bulkSelectedIds.add(Number(check.dataset.selectCredential))); }
    } else if (event.target.matches("[data-select-credential]")) {
      const id = Number(event.target.dataset.selectCredential);
      if (!event.target.checked) bulkSelectedIds.delete(id);
      else if (bulkSelectedIds.size < 500) bulkSelectedIds.add(id);
      else showToast("Select up to 500 entries at a time.", "info");
    }
    updateBulkSelectionControls();
  });
  updateBulkSelectionControls();
}

function closeBulkMove() {
  const state = bulkMoveDialog;
  bulkMoveDialog = null;
  state?.overlay.remove();
}

async function openBulkMove() {
  if (!bulkSelectedIds.size || bulkMoveDialog) return;
  const state = { ids: [...bulkSelectedIds], review: null, busy: false, overlay: document.createElement("div") };
  bulkMoveDialog = state;
  const overlay = state.overlay;
  overlay.id = "bulk-move-overlay";
  overlay.className = "modal-overlay is-open";
  overlay.tabIndex = -1;
  overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-labelledby", "bulk-move-title");
  overlay.innerHTML = `<div class="modal-container bulk-move-container">
    <div class="modal-header"><h2 id="bulk-move-title">Move selected credentials</h2><button type="button" class="modal-close-btn" aria-label="Close">${renderCloseIcon()}</button></div>
    <div class="modal-body">
      <p>${state.ids.length} selected. Choose an existing group, then review the entries before applying.</p>
      <label for="bulk-move-target" class="field-label">Destination group</label>
      <select id="bulk-move-target" class="settings-input" disabled><option value="">Ungrouped</option></select>
      <p class="settings-section-hint">Only the group assignment changes. Moving entries out of the active group removes them from its filtered view.</p>
      <div id="bulk-move-review" hidden></div>
      <p id="bulk-move-status" role="status" aria-live="polite">Loading groups…</p>
    </div>
    <div class="modal-footer"><button type="button" class="secondary-button" id="bulk-move-cancel">Cancel</button>
      <button type="button" class="primary-button" id="bulk-move-confirm" disabled>Review move</button></div>
  </div>`;
  document.body.append(overlay);
  overlay.focus();
  const target = overlay.querySelector("select"), confirm = overlay.querySelector("#bulk-move-confirm");
  const message = overlay.querySelector("#bulk-move-status"), review = overlay.querySelector("#bulk-move-review");
  const cancel = () => { if (!state.busy) { closeBulkMove(); document.querySelector("#bulk-move-btn")?.focus(); } };
  overlay.querySelector(".modal-close-btn").addEventListener("click", cancel);
  overlay.querySelector("#bulk-move-cancel").addEventListener("click", cancel);
  target.addEventListener("change", () => { state.review = null; review.hidden = true; review.replaceChildren(); confirm.textContent = "Review move"; message.textContent = ""; });
  const busy = value => {
    state.busy = value;
    overlay.querySelectorAll("button, select").forEach(element => { element.disabled = value; });
    if (value) overlay.focus(); else confirm.focus();
  };
  confirm.addEventListener("click", async () => {
    if (state.busy) return;
    busy(true); message.textContent = state.review ? "Moving credentials…" : "Preparing review…";
    const choice = { ids: state.ids, targetGroup: target.value };
    try {
      if (!state.review) {
        const response = await window.secureLoginVault.credentials.previewMove(choice);
        if (bulkMoveDialog !== state) return;
        if (!response.ok) throw Error(response.message);
        state.review = response.result;
        const title = document.createElement("p");
        title.textContent = `Destination: ${state.review.targetGroup || "Ungrouped"}. ${state.review.entries.length - state.review.unchanged} will move; ${state.review.unchanged} already there.`;
        const list = document.createElement("ul");
        for (const entry of state.review.entries) {
          const item = document.createElement("li");
          item.textContent = `${entry.websiteName}${entry.username ? ` · ${entry.username}` : ""} — ${entry.groupName || "Ungrouped"}`;
          list.append(item);
        }
        review.replaceChildren(title, list); review.hidden = false;
        confirm.textContent = "Confirm move"; message.textContent = "Review these entries, then confirm.";
      } else {
        const response = await window.secureLoginVault.credentials.moveToGroup({ ...choice, revision: state.review.revision, confirmed: true });
        if (response.ok) {
          resetBulkSelection();
          if (document.querySelector("#credential-list-body")) {
            await refreshCredentials();
            showToast(`Moved ${response.result.moved} to ${response.result.targetGroup || "Ungrouped"}.${response.result.unchanged ? ` ${response.result.unchanged} already there.` : ""}`, "info");
          }
          return;
        }
        if (bulkMoveDialog !== state) return;
        throw Error(response.message);
      }
    } catch (error) {
      if (bulkMoveDialog !== state) return;
      state.review = null; review.hidden = true; review.replaceChildren(); confirm.textContent = "Review move";
      message.textContent = error.message || "Could not move the selected entries. Review again.";
    } finally { if (bulkMoveDialog === state) busy(false); }
  });
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key === "Tab") {
      const items = [...overlay.querySelectorAll("button, select")].filter(item => !item.disabled);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  try {
    const response = await window.secureLoginVault.groups.getAll();
    if (bulkMoveDialog !== state) return;
    if (!response.ok) throw Error(response.message);
    for (const name of response.result) { const option = document.createElement("option"); option.value = name; option.textContent = name; target.append(option); }
    target.disabled = confirm.disabled = false; message.textContent = ""; target.focus();
  } catch (error) { if (bulkMoveDialog === state) message.textContent = error.message || "Could not load groups."; }
}
