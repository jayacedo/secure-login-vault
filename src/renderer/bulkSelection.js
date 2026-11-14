// Selection contains IDs only and is cleared whenever the visible list refreshes.
let bulkSelectionEnabled = false;
let bulkShowSelected = false;
const bulkSelectedIds = new Set();
let bulkMoveDialog = null;
let bulkUndoToast = null;
let bulkSessionVersion = 0;

function clearBulkUndo(expireSession = false) {
  if (expireSession === true) bulkSessionVersion++;
  bulkUndoToast?.remove();
  bulkUndoToast = null;
}

function showBulkUndo(result, message) {
  clearBulkUndo();
  if (!result.undoToken) { showToast(message, "info"); return; }
  const toast = document.createElement("div");
  toast.id = "bulk-undo-toast";
  toast.className = "toast toast--info";
  toast.setAttribute("role", "status");
  toast.innerHTML = '<span class="toast-message"></span><button type="button" class="secondary-button" id="bulk-undo-btn">Undo</button><button type="button" class="toast-close" aria-label="Dismiss undo">&times;</button>';
  toast.querySelector(".toast-message").textContent = `${message} Undo is available until your next bulk change or lock.`;
  const button = toast.querySelector("#bulk-undo-btn");
  toast.querySelector(".toast-close").addEventListener("click", clearBulkUndo);
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    const version = bulkSessionVersion;
    try {
      const response = await window.secureLoginVault.credentials.undoBulkChange(result.undoToken);
      if (bulkUndoToast !== toast) return;
      if (!response.ok) { showToast(response.message || "Could not undo. Try again.", "error", 6000); return; }
      clearBulkUndo();
      if (document.querySelector("#credential-list-body")) await refreshCredentials();
      if (version !== bulkSessionVersion) return;
      document.querySelector("#bulk-select-toggle")?.focus();
      showToast(`Restored previous ${response.result.kind === "favorite" ? "Favorites" : response.result.kind === "group" ? "groups" : "categories"} for ${response.result.restored} credentials.`, "info");
    } catch { if (bulkUndoToast === toast) showToast("Could not undo. Try again.", "error"); }
    finally { if (bulkUndoToast === toast) button.disabled = false; }
  });
  bulkUndoToast = toast;
  getToastContainer().append(toast);
  requestAnimationFrame(() => toast.classList.add("is-visible"));
}

function renderBulkSelectionCell(entry) {
  const search = [entry.websiteName, entry.websiteUrl, entry.username, entry.email, entry.groupName].filter(Boolean).join(" ").toLowerCase();
  return `<span role="cell" class="bulk-select-cell"><input type="checkbox" data-select-credential="${entry.id}" data-bulk-search="${escapeHtml(search)}" aria-label="Select ${escapeHtml(entry.websiteName)}"></span>`;
}

function updateBulkSelectionControls() {
  const table = document.querySelector(".credential-table");
  table?.classList.toggle("is-selecting", bulkSelectionEnabled);
  const bar = document.querySelector("#bulk-selection-bar");
  if (!bar) return;
  bar.hidden = !bulkSelectionEnabled;
  document.querySelector("#bulk-select-toggle").setAttribute("aria-pressed", String(bulkSelectionEnabled));
  document.querySelector("#bulk-move-btn").disabled = bulkSelectedIds.size === 0;
  document.querySelector("#bulk-category-btn").disabled = bulkSelectedIds.size === 0;
  for (const id of ["bulk-actions-toggle", "bulk-favorite-add", "bulk-favorite-remove"]) document.getElementById(id).disabled = bulkSelectedIds.size === 0;
  if (!bulkSelectionEnabled || !bulkSelectedIds.size) closeBulkActions();
  const checks = [...table.querySelectorAll("[data-select-credential]")];
  const selectedOnly = bulkSelectionEnabled && bulkShowSelected;
  const search = document.querySelector("#bulk-selection-search");
  search.disabled = selectedOnly;
  document.querySelector("#bulk-show-selected").setAttribute("aria-pressed", String(selectedOnly));
  const query = bulkSelectionEnabled && !selectedOnly ? search.value.trim().toLowerCase() : "";
  for (const check of checks) {
    check.checked = bulkSelectedIds.has(Number(check.dataset.selectCredential));
    const row = check.closest(".credential-row");
    row.hidden = !matchesCredentialQuickFilter(row) || (selectedOnly ? !check.checked : Boolean(query && !check.dataset.bulkSearch.includes(query)));
    row.classList.toggle("is-bulk-selected", check.checked);
  }
  const visible = checks.filter(check => !check.closest(".credential-row").hidden);
  const hiddenSelected = checks.filter(check => check.checked && check.closest(".credential-row").hidden).length;
  document.querySelector("#bulk-selection-count").textContent = `${bulkSelectedIds.size} selected${hiddenSelected ? ` (${hiddenSelected} hidden)` : ""}`;
  document.querySelector("#bulk-selection-results").textContent = selectedOnly
    ? "Showing selected entries. Turn off Show selected to resume Find logins."
    : query ? `${visible.length} matching login${visible.length === 1 ? "" : "s"}` : "";
  document.querySelector("#bulk-selection-results").hidden = !selectedOnly && !query;
  const all = document.querySelector("#bulk-select-all");
  all.disabled = visible.length === 0;
  all.checked = visible.length > 0 && visible.every(check => check.checked);
  all.indeterminate = visible.some(check => check.checked) && !all.checked;
  updateCredentialFilterSummary();
}

function resetBulkSelection() {
  closeBulkActions();
  bulkSelectionEnabled = false;
  bulkShowSelected = false;
  bulkSelectedIds.clear();
  const search = document.querySelector("#bulk-selection-search");
  if (search) search.value = "";
  closeBulkMove();
  updateBulkSelectionControls();
}

function setupBulkSelection() {
  setupBulkActions();
  document.querySelector("#bulk-select-toggle").addEventListener("click", () => {
    if (bulkSelectionEnabled) resetBulkSelection();
    else { bulkSelectionEnabled = true; updateBulkSelectionControls(); document.querySelector("#bulk-select-all").focus(); }
  });
  document.querySelector("#bulk-selection-cancel").addEventListener("click", () => { resetBulkSelection(); document.querySelector("#bulk-select-toggle").focus(); });
  document.querySelector("#bulk-move-btn").addEventListener("click", () => { closeBulkActions(); openBulkMove(); });
  document.querySelector("#bulk-category-btn").addEventListener("click", () => { closeBulkActions(); openBulkMove("category"); });
  document.querySelector("#bulk-favorite-add").addEventListener("click", () => { closeBulkActions(); openBulkFavorites(true); });
  document.querySelector("#bulk-favorite-remove").addEventListener("click", () => { closeBulkActions(); openBulkFavorites(false); });
  document.querySelector("#bulk-show-selected").addEventListener("click", () => {
    bulkShowSelected = !bulkShowSelected;
    updateBulkSelectionControls();
  });
  document.querySelector("#bulk-selection-search").addEventListener("input", updateBulkSelectionControls);
  document.querySelector(".credential-table").addEventListener("change", event => {
    if (!bulkSelectionEnabled) return;
    if (event.target.id === "bulk-select-all") {
      const checks = [...document.querySelectorAll("[data-select-credential]")].filter(check => !check.closest(".credential-row").hidden);
      const additions = checks.filter(check => !bulkSelectedIds.has(Number(check.dataset.selectCredential))).length;
      if (event.target.checked && bulkSelectedIds.size + additions > 500) showToast("Select up to 500 entries at a time. Filter the list to narrow it down.", "info");
      else checks.forEach(check => { const id = Number(check.dataset.selectCredential); if (event.target.checked) bulkSelectedIds.add(id); else bulkSelectedIds.delete(id); });
    } else if (event.target.matches("[data-select-credential]")) {
      const id = Number(event.target.dataset.selectCredential);
      if (!event.target.checked) bulkSelectedIds.delete(id);
      else if (bulkSelectedIds.size < 500) bulkSelectedIds.add(id);
      else showToast("Select up to 500 entries at a time.", "info");
    }
    const checksBefore = [...document.querySelectorAll("[data-select-credential]")].filter(check => !check.closest(".credential-row").hidden);
    const focusedIndex = checksBefore.indexOf(event.target);
    updateBulkSelectionControls();
    // Unchecking removes the focused row from this view. Keep keyboard focus usable.
    if (bulkShowSelected && (event.target.closest(".credential-row-item")?.hidden || event.target.disabled)) {
      const remaining = checksBefore.filter(check => !check.closest(".credential-row").hidden);
      (remaining[Math.min(Math.max(focusedIndex, 0), remaining.length - 1)] || document.querySelector("#bulk-show-selected")).focus();
    }
  });
  updateBulkSelectionControls();
}

function closeBulkActions(restoreFocus = false) {
  const menu = document.querySelector("#bulk-actions-menu");
  if (!menu) return;
  menu.hidden = true;
  const toggle = document.querySelector("#bulk-actions-toggle");
  toggle.setAttribute("aria-expanded", "false");
  if (restoreFocus) toggle.focus();
}

function setupBulkActions() {
  const toggle = document.querySelector("#bulk-actions-toggle"), menu = document.querySelector("#bulk-actions-menu");
  const open = () => {
    menu.classList.remove("is-above"); menu.hidden = false;
    menu.classList.toggle("is-above", menu.getBoundingClientRect().bottom > innerHeight - 12);
    toggle.setAttribute("aria-expanded", "true"); menu.querySelector("button:not(:disabled)")?.focus({preventScroll:true});
  };
  toggle.addEventListener("click", () => menu.hidden ? open() : closeBulkActions(true));
  toggle.addEventListener("keydown", event => { if (event.key === "ArrowDown") { event.preventDefault(); open(); } });
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeBulkActions(true); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      const index = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  });
  menu.parentElement.addEventListener("focusout", event => { if (!menu.parentElement.contains(event.relatedTarget)) closeBulkActions(); });
}
document.addEventListener("pointerdown", event => { if (!event.target.closest(".bulk-actions")) closeBulkActions(); });
window.addEventListener("resize", () => closeBulkActions());

async function openBulkFavorites(favorite) {
  if (!bulkSelectedIds.size || bulkMoveDialog) return;
  const label = favorite ? "Add to Favorites" : "Remove from Favorites";
  const state = {ids: [...bulkSelectedIds], review: null, busy: false, overlay: document.createElement("div")};
  bulkMoveDialog = state;
  const overlay = state.overlay;
  overlay.id = "bulk-move-overlay"; overlay.className = "modal-overlay is-open"; overlay.tabIndex = -1;
  overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-labelledby", "bulk-favorites-title");
  overlay.innerHTML = `<div class="modal-container bulk-move-container"><div class="modal-header"><h2 id="bulk-favorites-title">${label}</h2><button type="button" class="modal-close-btn" aria-label="Close">${renderCloseIcon()}</button></div>
    <div class="modal-body"><p>Review selected entries before changing their Favorites status.</p><div id="bulk-move-review"></div><p id="bulk-move-status" role="status"></p></div>
    <div class="modal-footer"><button type="button" class="secondary-button" id="bulk-move-cancel">Cancel</button><button type="button" class="primary-button" id="bulk-move-confirm">${label}</button></div></div>`;
  document.body.append(overlay);
  const confirm = overlay.querySelector("#bulk-move-confirm"), message = overlay.querySelector("#bulk-move-status"), review = overlay.querySelector("#bulk-move-review");
  const cancel = () => { if (!state.busy) { closeBulkMove(); document.querySelector("#bulk-actions-toggle")?.focus(); } };
  overlay.querySelector(".modal-close-btn").addEventListener("click", cancel);
  overlay.querySelector("#bulk-move-cancel").addEventListener("click", cancel);
  const busy = value => { state.busy = value; overlay.querySelectorAll("button").forEach(button => {button.disabled = value;}); if (value) overlay.focus(); else confirm.focus(); };
  const operate = async () => {
    if (state.busy) return;
    busy(true);
    const choice = {ids: state.ids, favorite};
    const applying = Boolean(state.review);
    message.textContent = applying ? "Applying changes…" : "Preparing review…";
    const version = bulkSessionVersion;
    try {
      const api = window.secureLoginVault.credentials;
      const response = await (applying ? api.changeFavorites({...choice, revision:state.review.revision, confirmed:true}) : api.previewFavorites(choice));
      if (bulkMoveDialog !== state || version !== bulkSessionVersion) return;
      if (!response.ok) throw Error(response.message);
      if (applying) {
        resetBulkSelection(); await refreshCredentials();
        if (version !== bulkSessionVersion || !document.querySelector("#credential-list-body")) return;
        showBulkUndo(response.result, `${response.result.changed} ${favorite ? "added to" : "removed from"} Favorites. ${response.result.unchanged} already ${favorite ? "favorited" : "not favorited"}.`);
        document.querySelector("#bulk-select-toggle")?.focus();
        return;
      }
      state.review = response.result;
      const summary = document.createElement("p"); summary.textContent = `${state.review.entries.length - state.review.unchanged} will change; ${state.review.unchanged} already ${favorite ? "favorited" : "not favorited"}.`;
      const list = document.createElement("ul");
      for (const entry of state.review.entries) { const item = document.createElement("li"); item.textContent = `${entry.websiteName}${entry.username ? ` · ${entry.username}` : ""} — ${entry.favorite ? "Favorite" : "Not a favorite"}`; list.append(item); }
      review.replaceChildren(summary, list); confirm.textContent = label; message.textContent = "Undo is available after applying, until your next bulk change or lock.";
    } catch (error) {
      if (bulkMoveDialog !== state) return;
      state.review = null; review.replaceChildren(); confirm.textContent = "Review again"; message.textContent = error.message || "Could not change Favorites. Review again.";
    } finally { if (bulkMoveDialog === state) busy(false); }
  };
  confirm.addEventListener("click", operate);
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key === "Tab") {
      const items = [...overlay.querySelectorAll("button:not(:disabled)")];
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) {event.preventDefault();items.at(-1).focus();}
      else if (!event.shiftKey && document.activeElement === items.at(-1)) {event.preventDefault();items[0].focus();}
    }
  });
  await operate();
}

function closeBulkMove() {
  const state = bulkMoveDialog;
  bulkMoveDialog = null;
  state?.overlay.remove();
}

async function openBulkMove(kind = "group") {
  if (!bulkSelectedIds.size || bulkMoveDialog) return;
  const category = kind === "category";
  const reviewLabel = category ? "Review changes" : "Review move";
  const confirmLabel = category ? "Confirm changes" : "Confirm move";
  const resultField = category ? "targetCategory" : "targetGroup";
  const returnButton = "#bulk-actions-toggle";
  const credentials = window.secureLoginVault.credentials;
  const state = { ids: [...bulkSelectedIds], review: null, busy: false, overlay: document.createElement("div") };
  bulkMoveDialog = state;
  const overlay = state.overlay;
  overlay.id = "bulk-move-overlay";
  overlay.className = "modal-overlay is-open";
  overlay.tabIndex = -1;
  overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-labelledby", "bulk-move-title");
  overlay.innerHTML = `<div class="modal-container bulk-move-container">
    <div class="modal-header"><h2 id="bulk-move-title">${category ? "Change category for selected credentials" : "Move selected credentials"}</h2><button type="button" class="modal-close-btn" aria-label="Close">${renderCloseIcon()}</button></div>
    <div class="modal-body">
      <p>${state.ids.length} selected. Choose an existing ${category ? "category" : "group"}, then review the entries before applying.</p>
      <label for="bulk-move-target" class="field-label">${category ? "New category" : "Destination group"}</label>
      <select id="bulk-move-target" class="settings-input" disabled>${category ? '<option value="" disabled selected>Choose a category</option>' : '<option value="">Ungrouped</option>'}</select>
      <p class="settings-section-hint">${category ? "Groups and login details stay unchanged. Entries outside the current category filter disappear from its view after applying." : "Only the group assignment changes. Moving entries out of the active group removes them from its filtered view."}</p>
      <div id="bulk-move-review" hidden></div>
      <p id="bulk-move-status" role="status" aria-live="polite">Loading options…</p>
    </div>
    <div class="modal-footer"><button type="button" class="secondary-button" id="bulk-move-cancel">Cancel</button>
      <button type="button" class="primary-button" id="bulk-move-confirm" disabled>${reviewLabel}</button></div>
  </div>`;
  document.body.append(overlay);
  overlay.focus();
  const target = overlay.querySelector("select"), confirm = overlay.querySelector("#bulk-move-confirm");
  const message = overlay.querySelector("#bulk-move-status"), review = overlay.querySelector("#bulk-move-review");
  const cancel = () => { if (!state.busy) { closeBulkMove(); document.querySelector(returnButton)?.focus(); } };
  overlay.querySelector(".modal-close-btn").addEventListener("click", cancel);
  overlay.querySelector("#bulk-move-cancel").addEventListener("click", cancel);
  target.addEventListener("change", () => { state.review = null; review.hidden = true; review.replaceChildren(); confirm.textContent = reviewLabel; confirm.disabled = category && !target.value; message.textContent = ""; });
  const busy = value => {
    state.busy = value;
    overlay.querySelectorAll("button, select").forEach(element => { element.disabled = value; });
    if (!value) confirm.disabled = category && !target.value;
    if (value) overlay.focus(); else confirm.focus();
  };
  confirm.addEventListener("click", async () => {
    if (state.busy) return;
    busy(true); message.textContent = state.review ? "Applying changes…" : "Preparing review…";
    const choice = { ids: state.ids, [resultField]: target.value };
    try {
      if (!state.review) {
        const response = await (category ? credentials.previewCategory(choice) : credentials.previewMove(choice));
        if (bulkMoveDialog !== state) return;
        if (!response.ok) throw Error(response.message);
        state.review = response.result;
        const title = document.createElement("p");
        title.textContent = `${category ? "New category" : "Destination"}: ${state.review[resultField] || "Ungrouped"}. ${state.review.entries.length - state.review.unchanged} will ${category ? "change" : "move"}; ${state.review.unchanged} already ${category ? "assigned" : "there"}.`;
        const list = document.createElement("ul");
        for (const entry of state.review.entries) {
          const item = document.createElement("li");
          item.textContent = `${entry.websiteName}${entry.username ? ` · ${entry.username}` : ""} — ${category ? (entry.category || "No category") : (entry.groupName || "Ungrouped")}`;
          list.append(item);
        }
        review.replaceChildren(title, list); review.hidden = false;
        confirm.textContent = confirmLabel; message.textContent = "Review these entries, then confirm.";
      } else {
        const version = bulkSessionVersion;
        const confirmedChoice = { ...choice, revision: state.review.revision, confirmed: true };
        const response = await (category ? credentials.changeCategory(confirmedChoice) : credentials.moveToGroup(confirmedChoice));
        if (response.ok) {
          resetBulkSelection();
          if (document.querySelector("#credential-list-body")) {
            await refreshCredentials();
            if (version !== bulkSessionVersion || !document.querySelector("#credential-list-body")) return;
            showBulkUndo(response.result, `${category ? `Changed category for ${response.result.changed}` : `Moved ${response.result.moved}`} to ${response.result[resultField] || "Ungrouped"}.${response.result.unchanged ? ` ${response.result.unchanged} already assigned.` : ""}`);
          }
          return;
        }
        if (bulkMoveDialog !== state) return;
        throw Error(response.message);
      }
    } catch (error) {
      if (bulkMoveDialog !== state) return;
      state.review = null; review.hidden = true; review.replaceChildren(); confirm.textContent = reviewLabel;
      message.textContent = error.message || "Could not update the selected entries. Review again.";
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
    const response = await (category ? window.secureLoginVault.categories.getAllWithUsage() : window.secureLoginVault.groups.getAll());
    if (bulkMoveDialog !== state) return;
    if (!response.ok) throw Error(response.message);
    for (const entry of response.result) { const name = category ? entry.name : entry; const option = document.createElement("option"); option.value = name; option.textContent = name; target.append(option); }
    target.disabled = false; confirm.disabled = category && !target.value; message.textContent = ""; target.focus();
  } catch (error) { if (bulkMoveDialog === state) message.textContent = error.message || "Could not load options."; }
}
