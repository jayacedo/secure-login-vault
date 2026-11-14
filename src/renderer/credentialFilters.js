const CREDENTIAL_QUICK_FILTERS = [
  ["all", "All logins"], ["has-2fa", "Has 2FA"],
  ["no-url", "No login URL"], ["uncategorized", "Uncategorized"]
];
let credentialQuickFilter = "all";

function renderCredentialQuickFilters() {
  return `<div class="credential-quick-filters">
    <select id="credential-quick-filter" class="settings-input" aria-label="Quick filter credentials"
      title="Has 2FA: saved QR image. Uncategorized: Other or no category.">
      ${CREDENTIAL_QUICK_FILTERS.map(([value,label]) => `<option value="${value}">${label}</option>`).join("")}
    </select>
    <button id="credential-clear-filter" type="button" class="secondary-button" hidden>Clear filter</button>
  </div>`;
}

function renderCredentialFilterData(entry) {
  const uncategorized = !String(entry.category || "").trim() || String(entry.category).trim().toLowerCase() === "other";
  return `data-filter-qr="${Boolean(entry.hasQrCode)}" data-filter-no-url="${!String(entry.websiteUrl || "").trim()}" data-filter-uncategorized="${uncategorized}"`;
}

function matchesCredentialQuickFilter(row) {
  switch (credentialQuickFilter) {
    case "has-2fa": return row.dataset.filterQr === "true";
    case "no-url": return row.dataset.filterNoUrl === "true";
    case "uncategorized": return row.dataset.filterUncategorized === "true";
    default: return true;
  }
}

function updateCredentialFilterSummary() {
  const body = document.querySelector("#credential-list-body");
  const label = document.querySelector("#credential-count-label");
  if (!body || !label) return;
  const rows = [...body.querySelectorAll(".credential-row-item")];
  const visible = rows.filter(row => !row.hidden).length;
  const selectionSearch = bulkSelectionEnabled && document.querySelector("#bulk-selection-search")?.value.trim();
  const filtering = credentialQuickFilter !== "all" || Boolean(selectionSearch);
  label.textContent = filtering ? `${visible} of ${rows.length} matching` : searchState.query
    ? `${rows.length} result${rows.length === 1 ? "" : "s"} for "${searchState.query}"` : `${rows.length} items`;
  let empty = body.querySelector("#credential-filter-empty");
  if (!empty) {
    empty = document.createElement("p"); empty.id = "credential-filter-empty";
    empty.className = "credential-filter-empty"; empty.setAttribute("role", "status");
    empty.textContent = "No logins match these filters. Clear the quick filter or adjust your search, category or group.";
    body.append(empty);
  }
  empty.hidden = !filtering || visible !== 0;
  // Avoid two different empty messages when the server-side search has no results.
  body.querySelector(".empty-state")?.toggleAttribute("hidden", filtering && visible === 0);
  const select = document.querySelector("#credential-quick-filter");
  if (select) select.value = credentialQuickFilter;
  const clear = document.querySelector("#credential-clear-filter");
  if (clear) clear.hidden = credentialQuickFilter === "all";
}

function setupCredentialQuickFilters() {
  const select = document.querySelector("#credential-quick-filter");
  const change = value => {
    if (!CREDENTIAL_QUICK_FILTERS.some(([key]) => key === value)) return;
    credentialQuickFilter = value;
    closeCredentialDetails(false);
    // Dashboard filter changes clear selection, matching search/category behavior.
    resetBulkSelection();
    updateCredentialFilterSummary();
  };
  select.addEventListener("change", event => change(event.target.value));
  document.querySelector("#credential-clear-filter").addEventListener("click", () => {
    change("all"); select.focus();
  });
  updateBulkSelectionControls();
}
