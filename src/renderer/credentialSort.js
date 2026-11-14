const CREDENTIAL_SORT_KEY = "slv_credential_sort";
const CREDENTIAL_SORT_OPTIONS = [
  ["website-asc", "Website A–Z"], ["website-desc", "Website Z–A"],
  ["username-asc", "Username A–Z"], ["username-desc", "Username Z–A"],
  ["created-desc", "Recently added"], ["updated-desc", "Recently updated"]
];
let credentialSortOrder = "updated-desc";
try {
  const saved = localStorage.getItem(CREDENTIAL_SORT_KEY);
  if (CREDENTIAL_SORT_OPTIONS.some(([value]) => value === saved)) credentialSortOrder = saved;
} catch { /* Sorting still works when preference storage is unavailable. */ }
const credentialSortCollator = new Intl.Collator(undefined, {numeric:true, sensitivity:"base"});

function renderCredentialSortControl() {
  return `<select id="credential-sort" class="settings-input credential-sort" aria-label="Sort credentials">
    ${CREDENTIAL_SORT_OPTIONS.map(([value,label]) => `<option value="${value}">${label}</option>`).join("")}
  </select>`;
}

function renderCredentialSortData(entry) {
  return `data-sort-website="${escapeHtml(entry.websiteName || "")}" data-sort-username="${escapeHtml(entry.username || entry.email || "")}"
    data-sort-created="${Number.isFinite(Date.parse(entry.createdAt)) ? Date.parse(entry.createdAt) : 0}"
    data-sort-updated="${Number.isFinite(Date.parse(entry.updatedAt)) ? Date.parse(entry.updatedAt) : 0}"`;
}

function applyCredentialSort() {
  const body = document.querySelector("#credential-list-body");
  if (!body) return;
  const [field,direction] = credentialSortOrder.split("-");
  const rows = [...body.querySelectorAll(".credential-row-item")];
  const text = (row,key) => row.dataset[key].trim();
  rows.sort((a,b) => {
    let order;
    if (field === "created" || field === "updated") {
      const key = field === "created" ? "sortCreated" : "sortUpdated";
      order = Number(b.dataset[key]) - Number(a.dataset[key]);
    } else {
      const key = field === "website" ? "sortWebsite" : "sortUsername";
      const left = text(a,key), right = text(b,key);
      // Keep missing names/usernames at the end in either direction.
      if (!left !== !right) return left ? -1 : 1;
      order = credentialSortCollator.compare(left,right) * (direction === "asc" ? 1 : -1);
    }
    return order || credentialSortCollator.compare(text(a,"sortWebsite"),text(b,"sortWebsite"))
      || credentialSortCollator.compare(text(a,"sortUsername"),text(b,"sortUsername"))
      || Number(a.dataset.id) - Number(b.dataset.id);
  });
  const focused = body.contains(document.activeElement) ? document.activeElement : null;
  const fragment = document.createDocumentFragment();
  rows.forEach(row => fragment.append(row));
  body.append(fragment); // Move existing nodes: selection, hidden rows and actions survive.
  focused?.focus({preventScroll:true});
  const select = document.querySelector("#credential-sort");
  if (select) select.value = credentialSortOrder;
  document.querySelectorAll("[data-credential-sort]").forEach(button => {
    const key = button.dataset.credentialSort;
    const active = field === key;
    button.parentElement.setAttribute("aria-sort", active ? (direction === "asc" ? "ascending" : "descending") : "none");
    button.querySelector(".sort-indicator").textContent = active ? (direction === "asc" ? "↑" : "↓") : "↕";
    const label = key === "website" ? "Website" : "Username";
    button.setAttribute("aria-label", `Sort ${label} ${active && direction === "asc" ? "Z to A" : "A to Z"}`);
  });
}

function setupCredentialSorting() {
  const change = value => {
    if (!CREDENTIAL_SORT_OPTIONS.some(([option]) => option === value)) return;
    credentialSortOrder = value;
    try { localStorage.setItem(CREDENTIAL_SORT_KEY,value); } catch { /* Keep session preference. */ }
    applyCredentialSort();
  };
  document.querySelector("#credential-sort").addEventListener("change", event => change(event.target.value));
  document.querySelectorAll("[data-credential-sort]").forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.credentialSort;
    change(`${key}-${credentialSortOrder === `${key}-asc` ? "desc" : "asc"}`);
  }));
  applyCredentialSort();
}
