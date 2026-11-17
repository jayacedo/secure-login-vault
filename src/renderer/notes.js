// Plaintext UI only: no note content in browser storage, logs, HTML, or URLs.
let notesView = null;
// Chromium's default selection copy includes themed HTML. Route reading-pane
// copies through the plain-text clipboard service, including its lock cleanup.
document.addEventListener("copy", event => {
  if (event.defaultPrevented || !notesView?.note || notesView.editing) return;
  if (document.activeElement?.closest("input, textarea, select, [contenteditable]")) return;
  const detail = document.querySelector("#note-detail"), selection = window.getSelection();
  if (!detail || !selection || selection.isCollapsed || !selection.rangeCount ||
      !detail.contains(selection.anchorNode) || !detail.contains(selection.focusNode)) return;
  const text = selection.toString();
  if (!text) return;
  event.preventDefault();
  copyToClipboard(text, "Note text copied!", null, true);
});
function renderNotesIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>';
}
function resetNotesWorkspace() {
  if (notesView) {
    clearTimeout(notesView.timer);
    notesView.note = null;
    notesView.items = [];
    document.querySelector("#notes-workspace")?.replaceChildren();
  }
  notesView = null;
  document.body.classList.remove("has-notes-workspace");
}
function notesDirty() {
  if (!notesView?.editing) return false;
  return document.querySelector("#note-title")?.value !== (notesView.creating ? "" : notesView.note?.title || "") ||
    document.querySelector("#note-body")?.value !== (notesView.creating ? "" : notesView.note?.body || "");
}
function notesMayLeave() {
  return !notesView?.busy && (!notesDirty() || window.confirm("Discard unsaved note changes?"));
}
function noteIconButton(id, label, icon, pressed) {
  return `<button type="button" id="${id}" class="icon-text-button dashboard-icon-button" aria-label="${label}"${pressed === undefined ? "" : ` aria-pressed="${pressed}"`}>${icon}<span class="dashboard-action-tooltip" aria-hidden="true">${label}</span></button>`;
}
function notesMessage(text) {
  const el = document.querySelector("#notes-message");
  if (el) { el.textContent = text; el.hidden = !text; }
}
function renderNotesWorkspace(state) {
  resetNotesWorkspace();
  closeCredentialDetails(false);
  resetBulkSelection();
  _lastAuthState = state;
  const view = notesView = { note: null, items: [], editing: false, creating: false, busy: false, query: "", favorites: false, sort: "updated", offset: 0, listRequest: 0, detailRequest: 0 };
  document.body.classList.remove("has-credential-list");
  document.body.classList.add("is-dashboard", "has-notes-workspace");
  appShell.className = "dashboard-shell";
  appShell.setAttribute("aria-labelledby", "dashboard-title");
  appShell.innerHTML = `
    <aside class="dashboard-sidebar" aria-label="Vault navigation">
      <div class="sidebar-brand">${renderBrandMark("compact")}<div><strong>${escapeHtml(getBrandName())}</strong><span>Local vault</span></div></div>
      <div class="sidebar-stats"><div class="sidebar-stat"><strong id="notes-total">0</strong><span>Notes</span></div><div class="sidebar-stat"><strong id="notes-favorites-total">0</strong><span>Favs</span></div></div>
      <div class="category-nav-header"><span>Workspaces</span></div>
      <nav class="workspace-nav" aria-label="Workspaces">
        <button type="button" id="notes-open-vault">${renderFolderIcon()}<span>Vault</span></button>
        <button type="button" id="notes-open-clients">${renderVaultIcon()}<span>Client Vault</span></button>
        <button type="button" class="is-active" aria-current="page">${renderNotesIcon()}<span>Notes</span></button>
      </nav>
      <div class="sidebar-session"><span>Unlocked ${formatDateTime(state.unlockedAt)}</span>${noteIconButton("lock-vault-button", "Lock vault", renderLockIcon())}</div>
    </aside>
    <section class="dashboard-main" id="notes-workspace" aria-labelledby="dashboard-title">
      <header class="dashboard-header"><div><p class="eyebrow">Private workspace</p><h1 id="dashboard-title">Notes</h1></div>
        <button type="button" id="add-note-btn" class="primary-button add-button dashboard-icon-button" aria-label="Add note">${renderPlusIcon()}<span class="dashboard-action-tooltip" aria-hidden="true">Add note</span></button>
      </header>
      <p class="notes-intro">General notes, encrypted in your vault. Included in full encrypted backups.</p>
      <div class="dashboard-toolbar notes-toolbar">
        <label class="search-box" for="notes-search">${renderSearchIcon()}<input id="notes-search" type="search" maxlength="200" placeholder="Search note titles and text" autocomplete="off"></label>
        <button type="button" class="secondary-button" id="notes-favorites" aria-pressed="false">Favorites</button>
        <select id="notes-sort" class="settings-input" aria-label="Sort notes"><option value="updated">Recently updated</option><option value="title-asc">Title A–Z</option><option value="title-desc">Title Z–A</option></select>
      </div>
      <p id="notes-message" role="status" hidden></p>
      <div class="notes-layout">
        <section class="notes-list-panel" aria-label="Saved notes">
          <div class="notes-list-header"><span id="notes-count" role="status">Loading notes…</span><button class="link-button" id="notes-refresh" type="button">Refresh</button></div>
          <div id="notes-list"></div>
          <div class="notes-pagination"><button type="button" class="secondary-button" id="notes-previous" disabled>Previous</button><button type="button" class="secondary-button" id="notes-next" disabled>Next</button></div>
        </section>
        <section id="note-detail" class="note-detail" aria-label="Note details"><p class="notes-placeholder">Choose a note, or add your first one.</p></section>
      </div>
    </section>`;
  document.querySelector("#lock-vault-button").onclick = handleLockVault;
  document.querySelector("#notes-open-vault").onclick = () => { if (notesMayLeave()) renderDashboard(state); };
  document.querySelector("#notes-open-clients").onclick = () => { if (notesMayLeave()) renderClientVault(state); };
  document.querySelector("#add-note-btn").onclick = () => { if (notesMayLeave()) { view.detailRequest++; view.editing = true; view.creating = true; renderNoteDetail(); } };
  document.querySelector("#notes-search").oninput = event => {
    view.query = event.target.value; view.offset = 0;
    clearTimeout(view.timer); view.timer = setTimeout(() => loadNotesList(view), 180);
  };
  document.querySelector("#notes-favorites").onclick = event => {
    view.favorites = !view.favorites; view.offset = 0;
    event.currentTarget.setAttribute("aria-pressed", String(view.favorites)); loadNotesList(view);
  };
  document.querySelector("#notes-sort").onchange = event => { view.sort = event.target.value; view.offset = 0; loadNotesList(view); };
  document.querySelector("#notes-refresh").onclick = async () => {
    if (!notesMayLeave()) return;
    view.editing = false; view.creating = false;
    if (view.note) await openNote(view.note.id);
    else renderNoteDetail();
    loadNotesList(view);
  };
  document.querySelector("#notes-previous").onclick = () => { view.offset = Math.max(0, view.offset - 50); loadNotesList(view); };
  document.querySelector("#notes-next").onclick = () => { view.offset += 50; loadNotesList(view); };
  loadNotesList(view);
}
async function loadNotesList(view = notesView) {
  if (!view || view !== notesView) return;
  const request = ++view.listRequest;
  document.querySelector("#notes-previous").disabled = true;
  document.querySelector("#notes-next").disabled = true;
  try {
    const response = await window.secureLoginVault.notes.list({ query: view.query, favorites: view.favorites, sort: view.sort, offset: view.offset });
    if (view !== notesView || request !== view.listRequest) return;
    if (!response.ok) throw new Error(response.message);
    const data = response.result;
    if (data.matched && view.offset >= data.matched) { view.offset = Math.floor((data.matched - 1) / data.pageSize) * data.pageSize; return loadNotesList(view); }
    view.items = data.items;
    document.querySelector("#notes-total").textContent = data.total;
    document.querySelector("#notes-favorites-total").textContent = data.favorites;
    document.querySelector("#notes-count").textContent = data.matched ? `${data.offset + 1}–${data.offset + data.items.length} of ${data.matched} notes` : "No matching notes";
    document.querySelector("#notes-list").innerHTML = data.items.length ? data.items.map(note => `
      <button type="button" class="note-list-item" data-note-id="${note.id}" aria-pressed="${view.note?.id === note.id}">
        <strong>${note.favorite ? '<span aria-label="Favorite">★ </span>' : ""}${escapeHtml(note.title)}</strong>
        <span class="note-snippet">${escapeHtml(note.snippet) || "Empty note"}</span><small>${escapeHtml(formatDateTime(note.updated_at))}</small>
      </button>`).join("") : '<p class="notes-placeholder">No notes here yet. Add a note or change your filters.</p>';
    document.querySelectorAll("[data-note-id]").forEach(button => { button.onclick = () => openNote(Number(button.dataset.noteId)); });
    document.querySelector("#notes-previous").disabled = view.busy || view.offset === 0;
    document.querySelector("#notes-next").disabled = view.busy || !data.hasMore;
  } catch (error) { if (view === notesView && request === view.listRequest) notesMessage(error.message || "Could not load notes."); }
}
async function openNote(id) {
  const view = notesView;
  if (!view || !notesMayLeave()) return;
  const request = ++view.detailRequest;
  view.editing = false; view.creating = false; view.note = null;
  notesMessage("");
  document.querySelector("#note-detail").textContent = "Loading note…";
  try {
    const response = await window.secureLoginVault.notes.getOne(id);
    if (view !== notesView || request !== view.detailRequest) return;
    if (!response.ok) throw new Error(response.message);
    view.note = response.result;
    renderNoteDetail();
    document.querySelectorAll("[data-note-id]").forEach(button => button.setAttribute("aria-pressed", String(Number(button.dataset.noteId) === id)));
  } catch (error) {
    if (view === notesView && request === view.detailRequest) { renderNoteDetail(); notesMessage(error.message || "Could not open note."); }
  }
}
function renderNoteDetail() {
  const view = notesView, detail = document.querySelector("#note-detail");
  if (!view || !detail) return;
  const note = view.note;
  if (view.editing) {
    detail.innerHTML = `<form id="note-form" class="note-editor">
      <h2>${view.creating ? "New note" : "Edit note"}</h2>
      <label for="note-title">Title</label><input id="note-title" class="settings-input" required maxlength="120" autocomplete="off">
      <label for="note-body">Note</label><textarea id="note-body" class="settings-input" maxlength="100000" spellcheck="false" placeholder="Write your note…"></textarea>
      <small>Save to keep changes. Locking the vault discards unsaved edits.</small>
      <div class="note-editor-actions"><button type="button" class="secondary-button" id="note-cancel">Cancel</button><button type="submit" class="primary-button" id="note-save">Save note</button></div>
    </form>`;
    document.querySelector("#note-title").value = view.creating ? "" : note.title;
    document.querySelector("#note-body").value = view.creating ? "" : note.body;
    document.querySelector("#note-title").focus();
    document.querySelector("#note-cancel").onclick = () => { if (notesMayLeave()) { view.editing = false; view.creating = false; renderNoteDetail(); } };
    document.querySelector("#note-form").onsubmit = event => {
      event.preventDefault();
      const data = { title: document.querySelector("#note-title").value, body: document.querySelector("#note-body").value };
      mutateNote(() => view.creating ? window.secureLoginVault.notes.add(data) : window.secureLoginVault.notes.update(note.id, { ...data, revision: note.revision }));
    };
    return;
  }
  if (!note) { detail.innerHTML = '<p class="notes-placeholder">Choose a note, or add a new one.</p>'; return; }
  detail.innerHTML = `<header class="note-detail-header"><div><h2 id="note-heading"></h2><small>Updated ${escapeHtml(formatDateTime(note.updated_at))}</small></div>
      <div class="note-detail-actions">${noteIconButton("note-favorite", note.favorite ? "Remove favorite" : "Add favorite", renderStarIcon(), !!note.favorite)}${noteIconButton("note-edit", "Edit note", renderEditIcon())}${noteIconButton("note-delete", "Delete note", renderTrashIcon())}</div></header>
    <div id="note-delete-confirm" class="note-delete-confirm" hidden><p>Permanently delete this note? It cannot be restored from Recently Deleted.</p><button type="button" class="danger-button" id="note-delete-now">Delete note</button> <button type="button" class="secondary-button" id="note-delete-cancel">Cancel</button></div>
    <div id="note-reading-body" class="note-reading-body"></div>`;
  document.querySelector("#note-heading").textContent = note.title;
  document.querySelector("#note-reading-body").textContent = note.body || "This note is empty.";
  document.querySelector("#note-favorite").onclick = () => mutateNote(() => window.secureLoginVault.notes.toggleFavorite(note.id, note.revision));
  document.querySelector("#note-edit").onclick = () => { if (!view.busy) { view.editing = true; view.creating = false; renderNoteDetail(); } };
  document.querySelector("#note-delete").onclick = () => { document.querySelector("#note-delete-confirm").hidden = false; document.querySelector("#note-delete-cancel").focus(); };
  document.querySelector("#note-delete-cancel").onclick = () => { document.querySelector("#note-delete-confirm").hidden = true; document.querySelector("#note-delete").focus(); };
  document.querySelector("#note-delete-now").onclick = () => mutateNote(() => window.secureLoginVault.notes.remove(note.id, note.revision, true), true);
}
async function mutateNote(operation, deleting = false) {
  const view = notesView;
  if (!view || view.busy) return;
  view.busy = true;
  notesMessage("");
  document.querySelectorAll("#notes-workspace button, #notes-workspace input, #notes-workspace textarea, #notes-workspace select").forEach(el => { el.disabled = true; });
  try {
    const response = await operation();
    if (view !== notesView) return;
    if (!response.ok) throw new Error(response.message);
    view.note = deleting ? null : response.result;
    view.editing = false; view.creating = false;
    renderNoteDetail();
    notesMessage(deleting ? "Note deleted." : "Note saved.");
  } catch (error) { if (view === notesView) notesMessage(error.message || "Could not save note."); }
  finally {
    if (view === notesView) {
      view.busy = false;
      document.querySelectorAll("#notes-workspace button, #notes-workspace input, #notes-workspace textarea, #notes-workspace select").forEach(el => { el.disabled = false; });
      await loadNotesList(view);
    }
  }
}
