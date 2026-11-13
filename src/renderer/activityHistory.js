let activityRequest = 0, activityDebounce;
const activityLabels = { added: "Login added", updated: "Login updated", password_updated: "Password updated", deleted: "Moved to Recently Deleted", restored: "Login restored", permanently_deleted: "Permanently deleted" };
function closeActivityHistory() {
  activityRequest++; clearTimeout(activityDebounce);
  const overlay = document.querySelector("#activity-history-overlay");
  if (overlay) { overlay.classList.remove("is-open"); overlay.replaceChildren(); }
  document.querySelector("#activity-history-btn")?.focus();
}
async function openActivityHistory() {
  closeActivityHistory();
  let overlay = document.querySelector("#activity-history-overlay");
  if (!overlay) {
    overlay = document.createElement("div"); overlay.id = "activity-history-overlay"; overlay.className = "modal-overlay";
    overlay.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const controls = [...overlay.querySelectorAll("button:not(:disabled), input, select")].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    document.body.append(overlay);
  }
  overlay.innerHTML = `<div class="modal-container activity-container" role="dialog" aria-modal="true" aria-labelledby="activity-title">
    <div class="modal-header"><h2 id="activity-title">Activity History</h2><button class="modal-close-btn" id="activity-close" type="button" aria-label="Close activity history">${renderCloseIcon()}</button></div>
    <div class="modal-body"><p class="modal-hint">Login changes from the last 90 days. History starts with this update and stays encrypted in your vault. Password values and private notes are not recorded.</p>
      <div class="activity-filters">
        <label>Search<input id="activity-search" type="search" maxlength="200" placeholder="Login name or group" autocomplete="off"></label>
        <label>Action<select id="activity-action"><option value="">All actions</option>${Object.entries(activityLabels).map(([key, text]) => `<option value="${key}">${text}</option>`).join("")}</select></label>
        <label>Source<select id="activity-source"><option value="">All sources</option><option value="desktop">Desktop</option><option value="browser">Browser</option></select></label>
      </div>
      <p id="activity-scope" class="modal-hint"></p><p id="activity-status" class="modal-hint" role="status" aria-live="polite"></p>
      <div id="activity-results" aria-busy="true"></div>
      <p class="modal-hint activity-footnote">Groups reflect each event's saved group. Older encrypted backups keep their own snapshots. This covers credential changes, not Client Vault or website sign-ins.</p>
    </div>
    <div class="modal-footer activity-footer"><button id="activity-refresh" class="secondary-button" type="button">Refresh</button><div class="activity-pages"><button id="activity-prev" class="secondary-button" type="button" disabled>Previous</button><button id="activity-next" class="secondary-button" type="button" disabled>Next</button></div><button id="activity-done" class="primary-button" type="button">Close</button></div>
  </div>`;
  overlay.classList.add("is-open");
  const find = selector => overlay.querySelector(selector);
  let offset = 0;
  async function load(reset = false) {
    clearTimeout(activityDebounce); if (reset) offset = 0;
    const request = ++activityRequest;
    const results = find("#activity-results"), status = find("#activity-status");
    results.replaceChildren(); results.setAttribute("aria-busy", "true"); status.setAttribute("role", "status"); status.textContent = "Loading activity…";
    find("#activity-prev").disabled = find("#activity-next").disabled = true;
    try {
      const response = await window.secureLoginVault.credentials.getActivityHistory({ query: find("#activity-search").value, event: find("#activity-action").value, source: find("#activity-source").value, offset });
      if (request !== activityRequest) return;
      if (!response.ok) throw new Error(response.message || "Could not load activity.");
      const report = response.result;
      if (report.total && offset >= report.total) { offset = 0; return load(); }
      find("#activity-scope").textContent = report.activeGroup ? `Group: ${report.activeGroup}` : "All credential groups";
      status.textContent = report.total ? `${offset + 1}–${offset + report.entries.length} of ${report.total} events · Newest first` : "No activity matches. New login changes will appear here.";
      for (const entry of report.entries) {
        const card = document.createElement("article"); card.className = "activity-entry";
        const heading = document.createElement("strong"); heading.textContent = entry.websiteName;
        const action = document.createElement("p"); action.textContent = activityLabels[entry.event] || "Login changed";
        const detail = document.createElement("p"); detail.className = "activity-detail";
        const time = document.createElement("time"); time.dateTime = entry.occurredAt; time.textContent = new Date(entry.occurredAt).toLocaleString();
        detail.append(time, document.createTextNode(` · ${entry.source === "browser" ? "Browser" : "Desktop"} · ${entry.groupName || "Unassigned"}`));
        card.append(heading, action, detail); results.append(card);
      }
      find("#activity-prev").disabled = offset === 0;
      find("#activity-next").disabled = offset + report.entries.length >= report.total;
    } catch (error) { if (request === activityRequest) { status.setAttribute("role", "alert"); status.textContent = error.message; } }
    finally { if (request === activityRequest) results.setAttribute("aria-busy", "false"); }
  }
  for (const id of ["activity-close", "activity-done"]) find(`#${id}`).addEventListener("click", closeActivityHistory);
  find("#activity-search").addEventListener("input", () => {
    activityRequest++; clearTimeout(activityDebounce);
    find("#activity-prev").disabled = find("#activity-next").disabled = true;
    activityDebounce = setTimeout(() => load(true), 200);
  });
  for (const id of ["activity-action", "activity-source"]) find(`#${id}`).addEventListener("change", () => load(true));
  find("#activity-refresh").addEventListener("click", () => load(true));
  find("#activity-prev").addEventListener("click", () => { offset = Math.max(0, offset - 50); load(); });
  find("#activity-next").addEventListener("click", () => { offset += 50; load(); });
  find("#activity-search").focus(); await load();
}
