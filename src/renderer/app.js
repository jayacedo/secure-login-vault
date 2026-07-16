// ── Phase 10: Preference keys (must be at top — used before initTheme() call) ─
const PREF_THEME         = "slv_theme";          // "light" | "dark" | "system"
const PREF_AUTO_LOCK     = "slv_auto_lock";       // seconds, 0 = off
const PREF_BACKGROUND_LOCK = "slv_background_lock_grace"; // seconds, 0 = instant
const PREF_CLIPBOARD     = "slv_clipboard_clear"; // seconds, 0 = off
const PREF_BACKUP_FOLDER = "slv_backup_folder";   // string path (display only)

// ── White-label branding preference keys ──────────────────────────────────────
const PREF_BRAND_NAME    = "slv_brand_name";   // string, defaults to DEFAULT_BRAND_NAME
const PREF_BRAND_LOGO    = "slv_brand_logo";   // data URI, optional custom logo image
const PREF_BRAND_ACCENT  = "slv_brand_accent"; // "#rrggbb", optional accent color override
const DEFAULT_BRAND_NAME = "Secure Login Vault";

const appShell = document.querySelector("#app-shell");

// ── Phase 10: apply saved theme immediately to avoid flash ────────────────────
initTheme();

// ── White-label: apply saved name/logo/accent immediately, same as theme ─────
applyBranding();

initAuth();

// ─── Phase 11: Global Keyboard Shortcuts ─────────────────────────────────────
//
//  Ctrl+N          → Add Credential (dashboard only)
//  Ctrl+F          → Focus search bar (dashboard only)
//  Ctrl+L          → Lock vault (dashboard only)
//  Ctrl+,          → Open Settings (dashboard only)
//  Escape          → Close topmost open modal (any modal)
//
// Shortcuts are suppressed when focus is inside an input/textarea/select
// unless the shortcut is Escape (which always applies).
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName?.toLowerCase();
  const inInput = tag === "input" || tag === "textarea" || tag === "select";

  // ── Escape: close the topmost open modal ──────────────────────────────────
  if (e.key === "Escape") {
    // Priority: sub-modals first, then primary modals
    const subModalOrder = [
      "#qr-lightbox-overlay",
      "#group-delete-modal-overlay",
      "#group-rename-modal-overlay",
      "#category-delete-modal-overlay",
      "#category-rename-modal-overlay",
      "#credential-modal-overlay",
      "#client-modal-overlay",
      "#categories-modal-overlay",
      "#groups-modal-overlay",
      "#help-modal-overlay",
      "#settings-modal-overlay",
      "#about-modal-overlay",
    ];
    for (const selector of subModalOrder) {
      const el = document.querySelector(selector);
      if (el && el.classList.contains("is-open")) {
        el.classList.remove("is-open");

        // Re-surface settings if categories sub-modal was closed that way
        if (selector === "#categories-modal-overlay" && _categoriesModalReopenSettings) {
          _categoriesModalReopenSettings = false;
          const settingsOverlay = document.querySelector("#settings-modal-overlay");
          if (settingsOverlay) settingsOverlay.classList.add("is-open");
        }
        // Re-surface settings if the groups sub-modal was closed that way
        if (selector === "#groups-modal-overlay") {
          if (_groupsModalReopenSettings) {
            _groupsModalReopenSettings = false;
            const settingsOverlay = document.querySelector("#settings-modal-overlay");
            if (settingsOverlay) settingsOverlay.classList.add("is-open");
          }
          loadActiveGroupControl();
          refreshCredentials();
        }
        // Re-surface settings if the help sub-modal was closed that way
        if (selector === "#help-modal-overlay" && _helpModalReopenSettings) {
          _helpModalReopenSettings = false;
          const settingsOverlay = document.querySelector("#settings-modal-overlay");
          if (settingsOverlay) settingsOverlay.classList.add("is-open");
        }
        e.preventDefault();
        return;
      }
    }
    return;
  }

  // ── All other shortcuts: ignore when typing in a field ───────────────────
  if (inInput) return;

  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;

  // Only fire dashboard shortcuts when the vault is unlocked and no modal is open
  const anyModalOpen = !!document.querySelector(".modal-overlay.is-open");
  const isDashboard = !!document.querySelector("#credential-search");

  switch (e.key.toLowerCase()) {
    case "n": {
      // Ctrl+N → Add Credential
      if (isDashboard && !anyModalOpen) {
        e.preventDefault();
        openCredentialModal(null);
      }
      break;
    }
    case "f": {
      // Ctrl+F → Focus search bar
      if (isDashboard && !anyModalOpen) {
        e.preventDefault();
        const search = document.querySelector("#credential-search");
        if (search) { search.focus(); search.select(); }
      }
      break;
    }
    case "l": {
      // Ctrl+L → Lock vault
      if (isDashboard && !anyModalOpen) {
        e.preventDefault();
        handleLockVault();
      }
      break;
    }
    case ",": {
      // Ctrl+, → Open Settings
      if (isDashboard && !anyModalOpen) {
        e.preventDefault();
        openSettingsModal();
      }
      break;
    }
  }
});

async function initAuth() {
  try {
    const state = await window.secureLoginVault.auth.getState();
    renderFromState(state);
  } catch {
    renderError("Vault status could not be loaded.");
  }
}

function renderFromState(state) {
  updateStatus(state);

  if (state.isUnlocked) {
    renderDashboard(state);
  } else if (state.hasVault) {
    renderUnlockForm();
  } else {
    renderCreateForm();
  }

  // Only reveal the shell once we know which screen is actually correct —
  // otherwise the static "Checking vault status..." intro markup paints
  // first and then gets swapped out a moment later, which looks like the
  // logo/title flashing on every refresh.
  document.body.classList.add("app-ready");
}

function renderCreateForm() {
  const authCard = getAuthCard();
  authCard.innerHTML = `
    <form class="auth-form" id="create-vault-form" novalidate>
      <div>
        <p class="eyebrow">First launch</p>
        <h2>Create Vault</h2>
        <p class="form-note">Choose a master password with at least 12 characters.</p>
      </div>

      ${renderPasswordInput({
        id: "master-password",
        label: "Master Password",
        autocomplete: "new-password"
      })}

      <div class="strength-meter" aria-live="polite">
        <div class="strength-track">
          <span id="strength-bar"></span>
        </div>
        <span id="strength-label">Strength: Empty</span>
      </div>

      ${renderPasswordInput({
        id: "confirm-password",
        label: "Confirm Password",
        autocomplete: "new-password"
      })}

      <p class="match-message" id="match-message" role="status">Passwords must match.</p>

      <ul class="validation-list" aria-label="Password requirements">
        <li id="rule-length">12 or more characters</li>
        <li id="rule-variety">Mix letters with numbers or symbols</li>
      </ul>

      <button class="primary-button" type="submit" disabled>Create Vault</button>
      <p class="form-message" id="form-message" role="status"></p>
    </form>
  `;

  const form = document.querySelector("#create-vault-form");
  setupPasswordToggles(form);
  setupCreateValidation(form);
  form.addEventListener("submit", handleCreateVault);
}

function renderUnlockForm() {
  const authCard = getAuthCard();
  authCard.innerHTML = `
    <form class="auth-form" id="unlock-vault-form" novalidate>
      <div>
        <p class="eyebrow">Returning user</p>
        <h2>Login</h2>
        <p class="form-note">Enter the master password to unlock this vault session.</p>
      </div>

      ${renderPasswordInput({
        id: "master-password",
        label: "Master Password",
        autocomplete: "current-password"
      })}

      <button class="primary-button" type="submit">Unlock Vault</button>
      <p class="form-message" id="form-message" role="status"></p>
    </form>
  `;

  const form = document.querySelector("#unlock-vault-form");
  setupPasswordToggles(form);
  form.addEventListener("submit", handleUnlockVault);
}

function renderPasswordInput({ id, label, autocomplete }) {
  return `
    <label class="password-label" for="${id}">
      <span>${label}</span>
      <span class="password-control">
        <input id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" minlength="12" maxlength="256" required />
        <button class="icon-button password-toggle" type="button" aria-label="Show ${label}" data-target="${id}" data-label="${label}" data-visible="false">
          ${renderEyeIcon()}
        </button>
      </span>
    </label>
  `;
}

let _lastAuthState = null;

function renderDashboard(state) {
  _lastAuthState = state;
  document.body.classList.add("is-dashboard");
  appShell.className = "dashboard-shell";
  appShell.setAttribute("aria-labelledby", "dashboard-title");
  const dashboardData = createEmptyDashboardData();
  appShell.innerHTML = `
    <aside class="dashboard-sidebar" aria-label="Vault navigation">
      <div class="sidebar-brand">
        ${renderBrandMark("compact")}
        <div>
          <strong>${escapeHtml(getBrandName())}</strong>
          <span>Local vault</span>
        </div>
      </div>

      <div class="sidebar-stats">
        <div class="sidebar-stat">
          <strong id="summary-total">${dashboardData.summary.totalCredentials}</strong>
          <span>Total</span>
        </div>
        <div class="sidebar-stat">
          <strong id="summary-favorites">${dashboardData.summary.favoriteCredentials}</strong>
          <span>Favs</span>
        </div>
        <div class="sidebar-stat">
          <strong id="summary-categories">${dashboardData.summary.categories}</strong>
          <span>Cats</span>
        </div>
      </div>

      <div class="category-nav-header"><span>Workspaces</span></div>
      <nav class="workspace-nav" aria-label="Workspaces">
        <button type="button" id="open-client-vault-btn">
          ${renderVaultIcon()}
          <span>Client Vault</span>
        </button>
      </nav>

      <div class="category-nav-header">
        <span>Categories</span>
        <button class="icon-button row-action-btn category-manage-btn" type="button" id="manage-categories-btn"
                aria-label="Manage Categories" title="Manage Categories">
          ${renderManageCategoriesIcon()}
        </button>
      </div>
      <nav class="category-nav" aria-label="Categories">
        ${renderCategoryButtons(dashboardData.categories)}
      </nav>

      <div class="sidebar-session">
        <span>Unlocked ${formatDateTime(state.unlockedAt)}</span>
        <button class="secondary-button sidebar-lock" type="button" id="lock-vault-button">
          ${renderLockIcon()}
          <span>Lock</span>
        </button>
      </div>
    </aside>

    <section class="dashboard-main" aria-labelledby="dashboard-title">
      <header class="dashboard-header">
        <div>
          <p class="eyebrow">Credential workspace</p>
          <h1 id="dashboard-title">Vault</h1>
        </div>
        <div class="dashboard-actions">
          <button class="icon-text-button" type="button" id="open-help-btn" aria-label="Help &amp; FAQ">
            ${renderHelpIcon()}
            <span>Help</span>
          </button>
          <button class="icon-text-button" type="button" id="open-settings-btn" aria-label="Settings">
            ${renderSettingsIcon()}
            <span>Settings</span>
          </button>
          <button class="primary-button add-button" type="button" id="add-credential-btn">
            ${renderPlusIcon()}
            <span>Add Credential</span>
          </button>
        </div>
      </header>

      <div class="active-group-banner" id="active-group-banner" style="display:none">
        ${renderShieldIcon()}
        <span>Locked to <strong id="active-group-banner-name"></strong> — other groups' credentials are hidden.</span>
        <button class="link-button" type="button" id="active-group-banner-clear">Show all</button>
      </div>

      <div class="dashboard-toolbar">
        <label class="search-box" for="credential-search">
          ${renderSearchIcon()}
          <input id="credential-search" type="search" placeholder="Search website, URL, username, email, notes, tags, category" autocomplete="off" />
        </label>
        <div class="segmented-control" aria-label="Credential filter">
          <button class="is-active" type="button" data-filter="all">All</button>
          <button type="button" data-filter="favorites">Favorites</button>
        </div>
      </div>

      <section class="credential-panel" aria-labelledby="credential-list-title">
        <div class="panel-header">
          <h2 id="credential-list-title">Credentials</h2>
          <span id="credential-count-label">${dashboardData.credentials.length} items</span>
        </div>
        <div class="credential-table" role="table" aria-label="Credential list">
          <div class="credential-row credential-row-head" role="row">
            <span role="columnheader">Website</span>
            <span role="columnheader">Username</span>
            <span role="columnheader">Password</span>
            <span role="columnheader">Category</span>
            <span role="columnheader" class="head-manage">Manage</span>
          </div>
          <div id="credential-list-body">
            ${renderCredentialRows(dashboardData.credentials)}
          </div>
        </div>
      </section>
    </section>
  `;

  document.querySelector("#lock-vault-button").addEventListener("click", handleLockVault);
  document.querySelector("#add-credential-btn").addEventListener("click", () => openCredentialModal(null));
  document.querySelector("#manage-categories-btn").addEventListener("click", openManageCategoriesModal);
  document.querySelector("#open-client-vault-btn").addEventListener("click", () => renderClientVault(state));
  document.querySelector("#active-group-banner-clear").addEventListener("click", async () => {
    await window.secureLoginVault.groups.setActive("");
    await refreshCredentials();
  });
  setupDashboardInteractions();
  loadDashboardData();
}

function renderCategoryButtons(categories) {
  return categories.map((category, index) => renderCategoryButton(category, index === 0)).join("");
}

function renderCategoryButton(category, isActive) {
  const icon = category.type === "favorites" ? renderStarIcon() : renderFolderIcon();

  return `
    <button class="${isActive ? "is-active" : ""}" type="button"
            data-type="${escapeHtml(category.type)}"
            data-name="${escapeHtml(category.name)}">
      ${icon}
      <span>${escapeHtml(category.name)}</span>
      <small>${category.count}</small>
    </button>
  `;
}

function renderCredentialRows(credentials, query = "") {
  if (credentials.length === 0) {
    const isSearching = query && query.trim().length > 0;
    return `
      <div class="empty-state" role="row">
        <div role="cell">
          ${renderVaultIcon()}
          <strong>${isSearching ? `No results for "${escapeHtml(query)}"` : "No credentials saved"}</strong>
        </div>
      </div>
    `;
  }

  return credentials.map((c) => renderCredentialRow(c, query)).join("");
}

function renderCredentialRow(credential, query = "") {
  const hl = (text) => highlightMatch(text, query);

  const tags = credential.tags
    ? credential.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => `<button type="button" class="tag-pill" data-action="filter-tag" data-tag="${escapeHtml(t)}" title="Filter by &quot;${escapeHtml(t)}&quot;">${hl(t)}</button>`)
        .join("")
    : "";

  const usernameValue = credential.username || credential.email || "";
  const usernameIsEmail = !credential.username && !!credential.email;

  return `
    <div class="credential-row credential-row-item ${credential.favorite ? "is-favorite" : ""}"
         role="row" data-id="${credential.id}">

      <span role="cell" class="cell-website">
        <span class="cell-main">
          <strong>${hl(credential.websiteName)}</strong>
          <small>${hl(credential.websiteUrl || "No URL")}</small>
          ${tags ? `<span class="tag-row">${tags}</span>` : ""}
        </span>
        ${credential.websiteUrl ? `
        <span class="cell-actions">
          <button class="icon-button row-action-btn copy-btn"
                  type="button" title="Copy URL"
                  data-action="copy-url"
                  data-id="${credential.id}"
                  data-value="${escapeHtml(credential.websiteUrl || '')}">
            ${renderLinkIcon()}
          </button>
          <button class="icon-button row-action-btn"
                  type="button" title="Open Website"
                  data-action="open-url"
                  data-id="${credential.id}"
                  data-value="${escapeHtml(credential.websiteUrl || '')}">
            ${renderExternalLinkIcon()}
          </button>
        </span>` : ""}
      </span>

      <span role="cell" class="cell-username">
        <span class="cell-main">
          <span>${usernameValue ? hl(usernameValue) : "No username"}</span>
          ${credential.username && credential.email ? `<small>${hl(credential.email)}</small>` : ""}
        </span>
        ${usernameValue ? `
        <span class="cell-actions">
          <button class="icon-button row-action-btn copy-btn"
                  type="button" title="${usernameIsEmail ? "Copy Email" : "Copy Username"}"
                  data-action="${usernameIsEmail ? "copy-email" : "copy-username"}"
                  data-id="${credential.id}"
                  data-value="${escapeHtml(usernameValue)}">
            ${usernameIsEmail ? renderMailIcon() : renderUserIcon()}
          </button>
        </span>` : ""}
      </span>

      <span role="cell" class="cell-password masked-password">
        <span class="cell-main"><span class="pw-dots">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span></span>
        <span class="cell-actions">
          <button class="icon-button row-action-btn copy-btn"
                  type="button" title="Copy Password"
                  data-action="copy-password"
                  data-id="${credential.id}">
            ${renderKeyIcon()}
          </button>
        </span>
      </span>

      <span role="cell" class="cell-category">
        ${hl(credential.category)}
        ${credential.groupName ? `<small class="group-badge" title="Group">${hl(credential.groupName)}</small>` : ""}
      </span>

      <span role="cell" class="cell-manage">
        <button class="icon-button row-action-btn fav-btn ${credential.favorite ? "is-fav-active" : ""}"
                type="button" title="Toggle Favorite"
                data-action="favorite" data-id="${credential.id}">
          ${renderStarIcon()}
        </button>
        <button class="icon-button row-action-btn"
                type="button" title="Edit"
                data-action="edit" data-id="${credential.id}">
          ${renderEditIcon()}
        </button>
        <button class="icon-button row-action-btn danger-btn"
                type="button" title="Delete"
                data-action="delete" data-id="${credential.id}"
                data-name="${escapeHtml(credential.websiteName)}">
          ${renderTrashIcon()}
        </button>
      </span>
    </div>
  `;
}

async function loadDashboardData() {
  const dashResponse = await window.secureLoginVault.vault.getDashboardData();

  if (!dashResponse.ok) {
    renderDashboardError(dashResponse.message);
    return;
  }

  updateDashboardData(dashResponse.result);
  await runSearch();
}

function updateDashboardData(data) {
  const categoryNav = document.querySelector(".category-nav");
  const total = document.querySelector("#summary-total");
  const favorites = document.querySelector("#summary-favorites");
  const categories = document.querySelector("#summary-categories");

  if (categoryNav) {
    categoryNav.innerHTML = renderCategoryButtons(data.categories);
  }

  if (total) total.textContent = data.summary.totalCredentials;
  if (favorites) favorites.textContent = data.summary.favoriteCredentials;
  if (categories) categories.textContent = data.summary.categories;

  setActiveGroupBanner(data.activeGroup);
  setupDashboardInteractions();
}

let _activeGroupBannerTimer = null;

const ACTIVE_GROUP_BANNER_DISMISSED_KEY = "sluv-active-group-banner-dismissed";

function setActiveGroupBanner(activeGroup, { forceShow = false } = {}) {
  const banner = document.querySelector("#active-group-banner");
  const nameEl = document.querySelector("#active-group-banner-name");
  if (!banner) return;

  if (_activeGroupBannerTimer) {
    clearTimeout(_activeGroupBannerTimer);
    _activeGroupBannerTimer = null;
  }

  if (activeGroup) {
    // If the user already saw (and the banner already faded for) this exact
    // active group, don't replay the show/fade cycle on every app refresh —
    // only show it fresh when the lock actually changes (forceShow), since
    // that's the only time it's new information.
    const dismissedFor = localStorage.getItem(ACTIVE_GROUP_BANNER_DISMISSED_KEY);
    if (!forceShow && dismissedFor === activeGroup) {
      banner.classList.remove("is-fading");
      banner.style.display = "none";
      return;
    }

    if (nameEl) nameEl.textContent = activeGroup;
    banner.classList.remove("is-fading");
    banner.style.display = "";

    // The lock itself is permanent and enforced server-side regardless of
    // this banner — it's just a heads-up, so it doesn't need to sit on
    // screen indefinitely. Fade it out after a few seconds; "Show all"
    // remains available any time via Settings.
    _activeGroupBannerTimer = setTimeout(() => {
      banner.classList.add("is-fading");
      setTimeout(() => {
        banner.style.display = "none";
        banner.classList.remove("is-fading");
      }, 300);
      localStorage.setItem(ACTIVE_GROUP_BANNER_DISMISSED_KEY, activeGroup);
    }, 5000);
  } else {
    banner.style.display = "none";
    localStorage.removeItem(ACTIVE_GROUP_BANNER_DISMISSED_KEY);
  }
}

function updateCredentialList(credentials) {
  const listBody = document.querySelector("#credential-list-body");
  const countLabel = document.querySelector("#credential-count-label");
  if (listBody) listBody.innerHTML = renderCredentialRows(credentials);
  if (countLabel) countLabel.textContent = `${credentials.length} items`;
  bindCredentialActions();
}

function bindCredentialActions() {
  const listBody = document.querySelector("#credential-list-body");
  if (!listBody) return;

  // Clone to remove old listeners, then re-attach
  const fresh = listBody.cloneNode(true);
  listBody.parentNode.replaceChild(fresh, listBody);

  fresh.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = Number(btn.dataset.id);

    if (action === "favorite") {
      const res = await window.secureLoginVault.credentials.toggleFavorite(id);
      if (res.ok) refreshCredentials();
    }

    if (action === "edit") {
      await openCredentialModal(id);
    }

    if (action === "filter-tag") {
      const tag = btn.dataset.tag || "";
      const searchInput = document.querySelector("#credential-search");
      searchState.query = tag;
      if (searchInput) searchInput.value = tag;
      runSearch();
      return;
    }

    if (action === "delete") {
      const name = btn.dataset.name;
      if (confirm(`Delete "${name}"? This cannot be undone.`)) {
        const res = await window.secureLoginVault.credentials.remove(id);
        if (res.ok) refreshCredentials();
      }
    }

    // ── Clipboard actions ────────────────────────────────────────────────────
    if (action === "copy-username") {
      const val = btn.dataset.value;
      if (val) copyToClipboard(val, "Username copied!", btn);
    }

    if (action === "copy-password") {
      // Password is not in the DOM — fetch the credential securely
      const res = await window.secureLoginVault.credentials.getOne(id);
      if (res.ok && res.result.password) {
        copyToClipboard(res.result.password, "Password copied!", btn, true);
      }
    }

    if (action === "copy-email") {
      const val = btn.dataset.value;
      if (val) copyToClipboard(val, "Email copied!", btn);
    }

    if (action === "copy-url") {
      const val = btn.dataset.value;
      if (val) copyToClipboard(val, "URL copied!", btn);
    }

    if (action === "open-url") {
      const val = btn.dataset.value;
      if (val) window.open(resolveWebsiteUrl(val), "_blank");
    }
  });
}

async function refreshCredentials() {
  // Re-run the current search so active filters/query are preserved
  await runSearch();

  // Also refresh summary counts and category nav
  const dashRes = await window.secureLoginVault.vault.getDashboardData();

  if (dashRes.ok) {
    const s = dashRes.result.summary;
    const total = document.querySelector("#summary-total");
    const favs = document.querySelector("#summary-favorites");
    const cats = document.querySelector("#summary-categories");
    if (total) total.textContent = s.totalCredentials;
    if (favs) favs.textContent = s.favoriteCredentials;
    if (cats) cats.textContent = s.categories;

    const categoryNav = document.querySelector(".category-nav");
    if (categoryNav) {
      categoryNav.innerHTML = renderCategoryButtons(dashRes.result.categories);
      setupDashboardInteractions();
    }

    setActiveGroupBanner(dashRes.result.activeGroup);
  }
}

function renderDashboardError(message) {
  const listBody = document.querySelector("#credential-list-body");

  if (!listBody) {
    return;
  }

  listBody.innerHTML = `
    <div class="empty-state error-state" role="row">
      <div role="cell">
        ${renderVaultIcon()}
        <strong>${escapeHtml(message || "Database could not be loaded.")}</strong>
      </div>
    </div>
  `;
}

function createEmptyDashboardData() {
  return {
    summary: {
      totalCredentials: 0,
      favoriteCredentials: 0,
      categories: 0
    },
    categories: [
      { name: "All Items", count: 0, type: "all" },
      { name: "Favorites", count: 0, type: "favorites" }
    ],
    credentials: []
  };
}

function setupPasswordToggles(container) {
  for (const button of container.querySelectorAll(".password-toggle")) {
    button.addEventListener("click", () => {
      const input = container.querySelector(`#${button.dataset.target}`);
      const isVisible = button.dataset.visible === "true";
      input.type = isVisible ? "password" : "text";
      button.dataset.visible = String(!isVisible);
      button.setAttribute("aria-label", `${isVisible ? "Show" : "Hide"} ${button.dataset.label}`);
      button.innerHTML = isVisible ? renderEyeIcon() : renderEyeOffIcon();
      input.focus();
    });
  }
}

function setupCreateValidation(form) {
  const passwordInput = form.querySelector("#master-password");
  const confirmationInput = form.querySelector("#confirm-password");
  const submit = form.querySelector("button[type='submit']");
  const strengthBar = form.querySelector("#strength-bar");
  const strengthLabel = form.querySelector("#strength-label");
  const matchMessage = form.querySelector("#match-message");
  const lengthRule = form.querySelector("#rule-length");
  const varietyRule = form.querySelector("#rule-variety");

  const update = () => {
    const password = passwordInput.value;
    const confirmation = confirmationInput.value;
    const strength = getPasswordStrength(password);
    const passwordsMatch = password.length > 0 && password === confirmation;
    const lengthValid = password.length >= 12;
    const varietyValid = hasPasswordVariety(password);
    const canSubmit = lengthValid && varietyValid && passwordsMatch;

    strengthBar.style.width = `${strength.percent}%`;
    strengthBar.dataset.level = strength.level;
    strengthLabel.textContent = `Strength: ${strength.label}`;

    lengthRule.classList.toggle("is-valid", lengthValid);
    varietyRule.classList.toggle("is-valid", varietyValid);
    matchMessage.textContent = passwordsMatch ? "Passwords match." : "Passwords must match.";
    matchMessage.classList.toggle("is-valid", passwordsMatch);
    matchMessage.classList.toggle("is-error", confirmation.length > 0 && !passwordsMatch);

    passwordInput.setCustomValidity(lengthValid && varietyValid ? "" : "Choose a stronger master password.");
    confirmationInput.setCustomValidity(passwordsMatch ? "" : "Passwords must match.");
    submit.disabled = !canSubmit;
  };

  passwordInput.addEventListener("input", update);
  confirmationInput.addEventListener("input", update);
  update();
}

async function handleCreateVault(event) {
  event.preventDefault();
  const form = event.currentTarget;

  if (!form.reportValidity()) {
    return;
  }

  const button = form.querySelector("button[type='submit']");
  const message = form.querySelector("#form-message");
  const payload = {
    masterPassword: form.querySelector("#master-password").value,
    confirmPassword: form.querySelector("#confirm-password").value
  };

  setBusy(button, message, "Creating vault...");

  const response = await window.secureLoginVault.auth.createVault(payload);

  if (!response.ok) {
    setIdle(button);
    showMessage(message, response.message, true);
    return;
  }

  const state = await window.secureLoginVault.auth.getState();
  renderFromState(state);
}

async function handleUnlockVault(event) {
  event.preventDefault();
  const form = event.currentTarget;

  if (!form.reportValidity()) {
    return;
  }

  const button = form.querySelector("button[type='submit']");
  const message = form.querySelector("#form-message");
  const passwordInput = form.querySelector("#master-password");

  setBusy(button, message, "Unlocking vault...");

  const response = await window.secureLoginVault.auth.unlockVault({
    masterPassword: passwordInput.value
  });

  if (!response.ok) {
    setIdle(button);
    passwordInput.select();
    showMessage(message, response.message, true);
    return;
  }

  const state = await window.secureLoginVault.auth.getState();
  renderFromState(state);
}

async function handleLockVault() {
  await window.secureLoginVault.auth.lockVault();

  // Reset search state on lock
  searchState.query = "";
  searchState.onlyFavorites = false;
  searchState.category = null;
  clearTimeout(searchState.debounceTimer);
  const state = await window.secureLoginVault.auth.getState();
  document.body.classList.remove("is-dashboard");
  appShell.className = "app-shell";
  appShell.setAttribute("aria-labelledby", "app-title");
  appShell.innerHTML = `
    <section class="vault-panel auth-layout">
      <div class="intro-column">
        ${renderBrandMark()}
        <div class="intro-copy">
          <p class="eyebrow">Offline credential vault</p>
          <h1 id="app-title">${escapeHtml(getBrandName())}</h1>
          <p>
            Protect local credentials behind a master password before the vault workspace opens.
          </p>
        </div>

      </div>

      <div class="auth-card" id="auth-card" aria-live="polite">
        <div class="auth-loading">Checking vault status...</div>
      </div>
    </section>
  `;
  renderFromState(state);
}

// ─── Phase 6: Search state ────────────────────────────────────────────────────

const searchState = {
  query: "",
  onlyFavorites: false,
  category: null,        // null = all, string = specific category
  debounceTimer: null
};

function setupDashboardInteractions() {
  // Category nav
  for (const button of document.querySelectorAll(".category-nav button")) {
    button.addEventListener("click", () => {
      document
        .querySelectorAll(".category-nav button")
        .forEach((item) => item.classList.toggle("is-active", item === button));

      const type = button.dataset.type;
      const name = button.dataset.name;

      if (type === "all") {
        searchState.category = null;
        searchState.onlyFavorites = false;
      } else if (type === "favorites") {
        searchState.category = null;
        searchState.onlyFavorites = true;
      } else {
        searchState.category = name;
        searchState.onlyFavorites = false;
      }

      // Sync segmented control to "All" when navigating by category
      if (type !== "favorites") {
        document.querySelectorAll(".segmented-control button").forEach((b, i) => {
          b.classList.toggle("is-active", i === 0);
        });
      }

      runSearch();
    });
  }

  // Segmented control (All / Favorites)
  for (const button of document.querySelectorAll(".segmented-control button")) {
    button.addEventListener("click", () => {
      document
        .querySelectorAll(".segmented-control button")
        .forEach((item) => item.classList.toggle("is-active", item === button));

      const isFavoritesTab = button.dataset.filter === "favorites";
      searchState.onlyFavorites = isFavoritesTab;

      // When switching to Favorites tab, clear category filter
      if (isFavoritesTab) {
        searchState.category = null;
        // Highlight Favorites in category nav
        document.querySelectorAll(".category-nav button").forEach((b) => {
          b.classList.toggle("is-active", b.dataset.type === "favorites");
        });
      } else {
        // Back to All — highlight "All Items" in nav
        document.querySelectorAll(".category-nav button").forEach((b, i) => {
          b.classList.toggle("is-active", i === 0);
        });
      }

      runSearch();
    });
  }

  // Search input
  const searchInput = document.querySelector("#credential-search");
  if (searchInput) {
    // Restore previous query value if navigating back
    searchInput.value = searchState.query;

    searchInput.addEventListener("input", () => {
      searchState.query = searchInput.value;
      clearTimeout(searchState.debounceTimer);
      searchState.debounceTimer = setTimeout(runSearch, 180);
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchInput.value = "";
        searchState.query = "";
        runSearch();
      }
    });
  }

  // Phase 10: Settings
  const settingsBtn = document.querySelector("#open-settings-btn");
  if (settingsBtn) {
    settingsBtn.addEventListener("click", openSettingsModal);
  }

  // Help & FAQ
  const helpBtn = document.querySelector("#open-help-btn");
  if (helpBtn) {
    helpBtn.addEventListener("click", openHelpModal);
  }


  // Phase 10: Start auto-lock watcher after dashboard is ready
  startAutoLockWatcher();
}

async function runSearch() {
  const res = await window.secureLoginVault.credentials.search({
    query: searchState.query,
    onlyFavorites: searchState.onlyFavorites,
    category: searchState.category
  });

  if (!res.ok) return;

  const credentials = res.result;
  const listBody = document.querySelector("#credential-list-body");
  const countLabel = document.querySelector("#credential-count-label");

  if (listBody) {
    listBody.innerHTML = renderCredentialRows(credentials, searchState.query);
  }
  if (countLabel) {
    const label = searchState.query
      ? `${credentials.length} result${credentials.length !== 1 ? "s" : ""} for "${searchState.query}"`
      : `${credentials.length} items`;
    countLabel.textContent = label;
  }

  bindCredentialActions();
}

// ─── 2FA QR upload field (shared by the Credential and Client modals) ────────
//
// Stores the QR image itself (as a data URI, auto-downscaled on upload) so it
// can be pulled up on screen and re-scanned with a phone later. The app never
// decodes or reads the QR — it's opaque image data, protected by the same
// whole-database encryption as everything else.

function renderQrUploadField(id, existingDataUri) {
  return `
    <div class="qr-field" data-qr-id="${id}">
      <span class="modal-label-text">2FA QR Code <span class="modal-hint">(optional — for re-scanning later)</span></span>
      <input type="hidden" id="${id}" value="${escapeHtml(existingDataUri || "")}" />
      <input type="file" accept="image/*" id="${id}-file" class="qr-file-input" hidden />
      <div class="qr-upload-area" id="${id}-area">
        ${existingDataUri ? renderQrPreviewMarkup(id, existingDataUri) : renderQrEmptyMarkup(id)}
      </div>
      <p class="form-message is-error" id="${id}-error" style="display:none"></p>
    </div>
  `;
}

function renderQrEmptyMarkup(id) {
  return `
    <button type="button" class="qr-upload-btn" data-qr-action="upload" data-qr-id="${id}">
      ${renderQrIcon()}
      <span>Upload QR Image</span>
    </button>
  `;
}

function renderQrPreviewMarkup(id, dataUri, originalBytes) {
  const storedBytes = estimateDataUriBytes(dataUri);
  const sizeLine = originalBytes
    ? `Original: ${formatFileSize(originalBytes)} · Stored: ${formatFileSize(storedBytes)}`
    : `Size: ${formatFileSize(storedBytes)}`;

  return `
    <div class="qr-preview">
      <img src="${dataUri}" alt="2FA QR code" class="qr-thumb" data-qr-action="view" data-qr-id="${id}" />
      <div class="qr-preview-details">
        <span class="qr-size-hint">${sizeLine}</span>
        <div class="qr-preview-actions">
          <button type="button" class="secondary-button" data-qr-action="upload" data-qr-id="${id}">Replace</button>
          <button type="button" class="danger-button" data-qr-action="remove" data-qr-id="${id}">Remove</button>
        </div>
      </div>
    </div>
  `;
}

// Base64 encodes ~4 bytes for every 3 source bytes, minus any trailing "="
// padding — this recovers the actual decoded byte size from a data URI
// string without needing to decode it.
function estimateDataUriBytes(dataUri) {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const padding = (base64.match(/=+$/) || [""])[0].length;
  return Math.max(0, Math.round((base64.length * 3) / 4) - padding);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setupQrUploadField(container, id) {
  const hiddenInput = container.querySelector(`#${id}`);
  const fileInput = container.querySelector(`#${id}-file`);
  const area = container.querySelector(`#${id}-area`);
  const errorEl = container.querySelector(`#${id}-error`);
  if (!hiddenInput || !fileInput || !area) return;

  const showQrError = (msg) => {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.style.display = "";
    }
  };
  const clearQrError = () => {
    if (errorEl) errorEl.style.display = "none";
  };

  area.addEventListener("click", (e) => {
    const target = e.target.closest("[data-qr-action]");
    if (!target) return;

    if (target.dataset.qrAction === "upload") {
      fileInput.click();
    } else if (target.dataset.qrAction === "remove") {
      hiddenInput.value = "";
      area.innerHTML = renderQrEmptyMarkup(id);
      clearQrError();
    } else if (target.dataset.qrAction === "view") {
      if (hiddenInput.value) openQrLightbox(hiddenInput.value);
    }
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = ""; // allow re-selecting the same file again later
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showQrError("Please select an image file.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showQrError("Image is too large (max 8 MB).");
      return;
    }

    try {
      const dataUri = await resizeImageToDataUri(file, QR_MAX_DIMENSION);
      hiddenInput.value = dataUri;
      area.innerHTML = renderQrPreviewMarkup(id, dataUri, file.size);
      clearQrError();
    } catch {
      showQrError("Could not read that image. Try a different file.");
    }
  });
}

// A full "set up 2FA" screenshot often has the actual QR code occupying only
// a fraction of the frame — capping at a low resolution left too few pixels
// per module once that whole screenshot was squeezed down, and scanners
// couldn't read it. 1200px keeps a real phone photo from bloating the vault
// (every write re-encrypts the whole database file) while leaving enough
// resolution for the QR to stay scannable even when it's not tightly cropped.
const QR_MAX_DIMENSION = 1200;

function resizeImageToDataUri(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File could not be read."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image could not be decoded."));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function getOrCreateQrLightboxOverlay() {
  let overlay = document.querySelector("#qr-lightbox-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "qr-lightbox-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("is-open");
    });
  }
  return overlay;
}

function openQrLightbox(dataUri) {
  const overlay = getOrCreateQrLightboxOverlay();
  overlay.innerHTML = `
    <div class="modal-container qr-lightbox-container" role="dialog" aria-modal="true" aria-labelledby="qr-lightbox-heading">
      <div class="modal-header">
        <h2 id="qr-lightbox-heading">2FA QR Code</h2>
        <button class="modal-close-btn" type="button" id="qr-lightbox-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body qr-lightbox-body">
        <img src="${dataUri}" alt="2FA QR code" class="qr-lightbox-img" />
        <span class="qr-size-hint">Stored size: ${formatFileSize(estimateDataUriBytes(dataUri))}</span>
        <p class="modal-hint">Point your authenticator app's camera at this code to re-add it on a new device. If it won't scan, try re-uploading a version cropped tightly around just the QR code.</p>
      </div>
    </div>
  `;
  overlay.classList.add("is-open");
  overlay.querySelector("#qr-lightbox-close-btn").addEventListener("click", () => overlay.classList.remove("is-open"));
}

// ─── Credential Modal ─────────────────────────────────────────────────────────

function getOrCreateModalOverlay() {
  let overlay = document.querySelector("#credential-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "credential-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      // Do NOT close on outside click — user may have half-filled the form.
      // Modal only closes via the X button, Cancel, or successful Save.
    });
  }
  return overlay;
}

async function openCredentialModal(editId) {
  const overlay = getOrCreateModalOverlay();
  const isEdit = editId !== null && editId !== undefined;

  let cred = null;
  let categories = [];
  let groups = [];

  const [catRes, groupRes, credRes] = await Promise.all([
    window.secureLoginVault.credentials.getCategories(),
    window.secureLoginVault.groups.getAll(),
    isEdit ? window.secureLoginVault.credentials.getOne(editId) : Promise.resolve(null)
  ]);

  if (catRes.ok) categories = catRes.result;
  if (groupRes.ok) groups = groupRes.result;
  if (isEdit && credRes && credRes.ok) cred = credRes.result;

  const categoryOptions = categories
    .map(
      (c) =>
        `<option value="${escapeHtml(c)}" ${cred && cred.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`
    )
    .join("");

  const groupOptions =
    `<option value="" ${cred && !cred.groupName ? "selected" : ""}>Unassigned</option>` +
    groups
      .map(
        (g) =>
          `<option value="${escapeHtml(g)}" ${cred && cred.groupName === g ? "selected" : ""}>${escapeHtml(g)}</option>`
      )
      .join("");

  overlay.innerHTML = `
    <div class="modal-container" role="dialog" aria-modal="true" aria-labelledby="modal-heading">
      <div class="modal-header">
        <h2 id="modal-heading">${isEdit ? "Edit Credential" : "Add Credential"}</h2>
        <button class="modal-close-btn" type="button" id="modal-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body">
        <div class="modal-form-row">
          <label class="modal-label" for="m-website-name">
            <span class="modal-label-text">Website Name <span class="required-mark">*</span></span>
            <input id="m-website-name" type="text" class="modal-input"
                   placeholder="My WordPress Site"
                   value="${cred ? escapeHtml(cred.websiteName) : ""}" required />
          </label>
          <label class="modal-label" for="m-category">
            <span class="modal-label-text">Category</span>
            <select id="m-category" class="modal-input">${categoryOptions}</select>
          </label>
        </div>

        <label class="modal-label" for="m-website-url">
          <span class="modal-label-text">Website URL</span>
          <input id="m-website-url" type="url" class="modal-input"
                 placeholder="https://example.com"
                 value="${cred ? escapeHtml(cred.websiteUrl) : ""}" />
        </label>

        <div class="modal-form-row">
          <label class="modal-label" for="m-username">
            <span class="modal-label-text">Username</span>
            <input id="m-username" type="text" class="modal-input" autocomplete="off"
                   placeholder="admin"
                   value="${cred ? escapeHtml(cred.username) : ""}" />
          </label>
          <label class="modal-label" for="m-email">
            <span class="modal-label-text">Email</span>
            <input id="m-email" type="email" class="modal-input"
                   placeholder="you@example.com"
                   value="${cred ? escapeHtml(cred.email) : ""}" />
          </label>
        </div>

        <label class="modal-label" for="m-password">
          <span class="modal-label-text">Password <span class="required-mark">*</span></span>
          <span class="password-control">
            <input id="m-password" type="password" class="modal-input" autocomplete="new-password"
                   placeholder="Password"
                   value="${cred ? escapeHtml(cred.password) : ""}" required />
            <button class="icon-button password-toggle" type="button"
                    aria-label="Show Password"
                    data-target="m-password" data-label="Password" data-visible="false">
              ${renderEyeIcon()}
            </button>
          </span>
        </label>

        <div class="gen-panel" id="gen-panel">
          <div class="gen-header">
            <button class="gen-toggle-btn is-open" type="button" id="gen-toggle-btn">
              ${renderDiceIcon()}
              <span>Password Generator</span>
              ${renderChevronIcon()}
            </button>
          </div>
          <div class="gen-body is-open" id="gen-body">
            <div class="gen-preview-row">
              <span class="gen-preview" id="gen-preview" title="Generated password">Click Generate</span>
              <button class="gen-action-btn" type="button" id="gen-copy-btn" title="Copy">
                ${renderCopyIcon()}
              </button>
              <button class="gen-action-btn gen-use-btn" type="button" id="gen-use-btn" title="Use this password">
                ${renderCheckIcon()}
                <span>Use</span>
              </button>
            </div>

            <div class="gen-strength-row">
              <div class="gen-strength-track"><span id="gen-strength-bar"></span></div>
              <span class="gen-strength-label" id="gen-strength-label">Not generated</span>
            </div>

            <div class="gen-length-row">
              <label class="gen-label" for="gen-length">Length</label>
              <input id="gen-length" type="range" min="8" max="64" value="20" class="gen-slider" />
              <span class="gen-length-val" id="gen-length-val">20</span>
            </div>

            <div class="gen-options">
              <label class="gen-check"><input type="checkbox" id="gen-upper" checked /><span>Uppercase A-Z</span></label>
              <label class="gen-check"><input type="checkbox" id="gen-lower" checked /><span>Lowercase a-z</span></label>
              <label class="gen-check"><input type="checkbox" id="gen-numbers" checked /><span>Numbers 0-9</span></label>
              <label class="gen-check"><input type="checkbox" id="gen-symbols" checked /><span>Symbols !@#...</span></label>
              <label class="gen-check"><input type="checkbox" id="gen-exclude-similar" /><span>Exclude similar (0Ol1I)</span></label>
            </div>

            <button class="gen-generate-btn" type="button" id="gen-generate-btn">
              ${renderDiceIcon()} Generate
            </button>
          </div>
        </div>

        <label class="modal-label" for="m-tags">
          <span class="modal-label-text">Tags <span class="modal-hint">(comma-separated)</span></span>
          <input id="m-tags" type="text" class="modal-input"
                 placeholder="client, important, 2fa"
                 value="${cred ? escapeHtml(cred.tags) : ""}" />
        </label>

        <label class="modal-label" for="m-group">
          <span class="modal-label-text">Group <span class="modal-hint">(who this belongs to)</span></span>
          <select id="m-group" class="modal-input">${groupOptions}</select>
        </label>

        <label class="modal-label" for="m-notes">
          <span class="modal-label-text">Notes</span>
          <textarea id="m-notes" class="modal-input modal-textarea"
                    rows="2"
                    placeholder="Additional notes...">${cred ? escapeHtml(cred.notes) : ""}</textarea>
        </label>

        ${renderQrUploadField("m-qr", cred ? cred.qrCode : "")}

        <label class="modal-checkbox-label" for="m-favorite">
          <input id="m-favorite" type="checkbox" ${cred && cred.favorite ? "checked" : ""} />
          <span>Mark as Favorite</span>
        </label>

        <p class="form-message is-error" id="modal-error" style="display:none"></p>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="modal-cancel-btn">Cancel</button>
        <button class="primary-button" type="button" id="modal-save-btn">
          ${isEdit ? "Update Credential" : "Save Credential"}
        </button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");
  overlay.querySelector("#modal-close-btn").addEventListener("click", closeCredentialModal);
  overlay.querySelector("#modal-cancel-btn").addEventListener("click", closeCredentialModal);
  overlay.querySelector("#modal-save-btn").addEventListener("click", () =>
    submitCredentialModal(isEdit ? editId : null)
  );
  setupPasswordToggles(overlay);
  setupPasswordGenerator(overlay);
  setupQrUploadField(overlay, "m-qr");
  setTimeout(() => overlay.querySelector("#m-website-name").focus(), 50);
}

function closeCredentialModal() {
  const overlay = document.querySelector("#credential-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");
}

async function submitCredentialModal(editId) {
  const websiteName = document.querySelector("#m-website-name").value.trim();
  const password = document.querySelector("#m-password").value;
  const errorEl = document.querySelector("#modal-error");

  if (!websiteName || !password) {
    errorEl.textContent = "Website Name and Password are required.";
    errorEl.style.display = "";
    return;
  }

  errorEl.style.display = "none";

  const data = {
    websiteName,
    websiteUrl: document.querySelector("#m-website-url").value.trim(),
    category: document.querySelector("#m-category").value,
    username: document.querySelector("#m-username").value.trim(),
    email: document.querySelector("#m-email").value.trim(),
    password,
    tags: document.querySelector("#m-tags").value.trim(),
    groupName: document.querySelector("#m-group").value,
    notes: document.querySelector("#m-notes").value.trim(),
    qrCode: document.querySelector("#m-qr").value,
    favorite: document.querySelector("#m-favorite").checked
  };

  const saveBtn = document.querySelector("#modal-save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  let res;
  if (editId !== null) {
    res = await window.secureLoginVault.credentials.update(editId, data);
  } else {
    res = await window.secureLoginVault.credentials.add(data);
  }

  if (!res.ok) {
    errorEl.textContent = res.message;
    errorEl.style.display = "";
    saveBtn.disabled = false;
    saveBtn.textContent = editId !== null ? "Update Credential" : "Save Credential";
    return;
  }

  closeCredentialModal();
  refreshCredentials();
}

// ─── Client Vault ─────────────────────────────────────────────────────────────
//
// A separate workspace from the credential dashboard above — one record per
// client holding WP admin, hosting, FTP/SFTP, database, and domain/SSL
// details, plus notes. Intentionally has no relationship to Groups (see the
// rename note in sqliteVault.js) — the two are independent concepts that
// happen to both be about "who this belongs to".

const clientSearchState = {
  query: "",
  onlyFavorites: false,
  debounceTimer: null
};

async function renderClientVault(state) {
  _lastAuthState = state;
  document.body.classList.add("is-dashboard");
  appShell.className = "dashboard-shell";
  appShell.setAttribute("aria-labelledby", "dashboard-title");

  appShell.innerHTML = `
    <aside class="dashboard-sidebar" aria-label="Vault navigation">
      <div class="sidebar-brand">
        ${renderBrandMark("compact")}
        <div>
          <strong>${escapeHtml(getBrandName())}</strong>
          <span>Local vault</span>
        </div>
      </div>

      <div class="sidebar-stats">
        <div class="sidebar-stat">
          <strong id="client-summary-total">0</strong>
          <span>Clients</span>
        </div>
        <div class="sidebar-stat">
          <strong id="client-summary-favorites">0</strong>
          <span>Favs</span>
        </div>
        <div class="sidebar-stat">
          <strong id="client-summary-ssl">0</strong>
          <span>SSL Due</span>
        </div>
      </div>

      <div class="category-nav-header"><span>Workspaces</span></div>
      <nav class="workspace-nav" aria-label="Workspaces">
        <button type="button" class="is-active">
          ${renderVaultIcon()}
          <span>Client Vault</span>
        </button>
      </nav>

      <div class="category-nav-header"><span>Categories</span></div>
      <nav class="workspace-nav" aria-label="Categories">
        <button type="button" id="client-vault-back-to-credentials">
          ${renderFolderIcon()}
          <span>Credentials</span>
        </button>
      </nav>

      <div class="sidebar-session">
        <span>Unlocked ${formatDateTime(state.unlockedAt)}</span>
        <button class="secondary-button sidebar-lock" type="button" id="lock-vault-button">
          ${renderLockIcon()}
          <span>Lock</span>
        </button>
      </div>
    </aside>

    <section class="dashboard-main" aria-labelledby="dashboard-title">
      <header class="dashboard-header">
        <div>
          <p class="eyebrow">Workspace</p>
          <h1 id="dashboard-title">Client Vault</h1>
        </div>
        <div class="dashboard-actions">
          <button class="primary-button add-button" type="button" id="add-client-btn">
            ${renderPlusIcon()}
            <span>Add Client</span>
          </button>
        </div>
      </header>

      <div class="dashboard-toolbar">
        <label class="search-box" for="client-search">
          ${renderSearchIcon()}
          <input id="client-search" type="search" placeholder="Search clients, domains, hosting providers" autocomplete="off" />
        </label>
        <div class="segmented-control" aria-label="Client filter">
          <button class="is-active" type="button" data-filter="all">All</button>
          <button type="button" data-filter="favorites">Favorites</button>
        </div>
      </div>

      <div class="client-grid" id="client-grid">
        <div class="empty-state" role="row"><div role="cell">${renderVaultIcon()}<strong>Loading...</strong></div></div>
      </div>
    </section>
  `;

  document.querySelector("#lock-vault-button").addEventListener("click", handleLockVault);
  document.querySelector("#add-client-btn").addEventListener("click", () => openClientModal(null));
  document.querySelector("#client-vault-back-to-credentials").addEventListener("click", () => renderDashboard(state));

  setupClientVaultInteractions();
  await loadClientVaultData();
}

function setupClientVaultInteractions() {
  for (const button of document.querySelectorAll(".segmented-control button[data-filter]")) {
    button.addEventListener("click", () => {
      document
        .querySelectorAll(".segmented-control button")
        .forEach((b) => b.classList.toggle("is-active", b === button));
      clientSearchState.onlyFavorites = button.dataset.filter === "favorites";
      runClientSearch();
    });
  }

  const searchInput = document.querySelector("#client-search");
  if (searchInput) {
    searchInput.value = clientSearchState.query;
    searchInput.addEventListener("input", () => {
      clientSearchState.query = searchInput.value;
      clearTimeout(clientSearchState.debounceTimer);
      clientSearchState.debounceTimer = setTimeout(runClientSearch, 180);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchInput.value = "";
        clientSearchState.query = "";
        runClientSearch();
      }
    });
  }

  // Delegated once on the stable grid container — renderClientGrid only ever
  // replaces its innerHTML, so this listener survives every search/refresh
  // without needing to be re-attached (and never duplicates).
  const grid = document.querySelector("#client-grid");
  if (grid) {
    grid.addEventListener("click", async (e) => {
      if (e.target.closest('[data-action="quick-link"]')) return; // let the anchor navigate

      const favBtn = e.target.closest('[data-action="favorite"]');
      if (favBtn) {
        e.stopPropagation();
        const res = await window.secureLoginVault.clients.toggleFavorite(Number(favBtn.dataset.id));
        if (res.ok) runClientSearch();
        return;
      }

      const card = e.target.closest(".client-card");
      if (card) openClientModal(Number(card.dataset.id));
    });
  }
}

async function loadClientVaultData() {
  const res = await window.secureLoginVault.clients.getAll();
  if (!res.ok) {
    renderClientVaultError(res.message);
    return;
  }
  renderClientSummary(res.result);
  renderClientGrid(res.result);
}

async function runClientSearch() {
  const res = await window.secureLoginVault.clients.search({
    query: clientSearchState.query,
    onlyFavorites: clientSearchState.onlyFavorites
  });
  if (!res.ok) return;
  renderClientGrid(res.result, clientSearchState.query);
}

function renderClientSummary(clients) {
  const total = document.querySelector("#client-summary-total");
  const favorites = document.querySelector("#client-summary-favorites");
  const sslDue = document.querySelector("#client-summary-ssl");
  if (total) total.textContent = clients.length;
  if (favorites) favorites.textContent = clients.filter((c) => c.favorite).length;
  if (sslDue) {
    sslDue.textContent = clients.filter((c) => {
      const status = computeExpiryStatus(c.sslExpiry);
      return status && status.cls !== "ssl-ok";
    }).length;
  }
}

function renderClientVaultError(message) {
  const grid = document.querySelector("#client-grid");
  if (!grid) return;
  grid.innerHTML = `
    <div class="empty-state" role="row">
      <div role="cell">
        ${renderVaultIcon()}
        <strong>${escapeHtml(message || "Clients could not be loaded.")}</strong>
      </div>
    </div>
  `;
}

// Pure helper: how many days until the given ISO date, bucketed into the
// same ok/warning/expired severity used by the plugin-style SOP badge.
function computeExpiryStatus(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  if (Number.isNaN(target.getTime())) return null;
  const days = Math.ceil((target.getTime() - Date.now()) / 86400000);
  if (days < 0) return { cls: "ssl-bad", label: "SSL expired" };
  if (days <= 14) return { cls: "ssl-warn", label: `SSL: ${days}d left` };
  return { cls: "ssl-ok", label: `SSL: ${days}d left` };
}

function renderClientGrid(clients, query = "") {
  const grid = document.querySelector("#client-grid");
  if (!grid) return;

  if (clients.length === 0) {
    const isSearching = query && query.trim().length > 0;
    grid.innerHTML = `
      <div class="empty-state" role="row">
        <div role="cell">
          ${renderVaultIcon()}
          <strong>${isSearching ? `No results for "${escapeHtml(query)}"` : "No clients saved yet"}</strong>
        </div>
      </div>
    `;
    return;
  }

  grid.innerHTML = clients.map((c) => renderClientCard(c, query)).join("");
}

function renderClientCard(client, query = "") {
  const hl = (text) => highlightMatch(text, query);
  const ssl = computeExpiryStatus(client.sslExpiry);

  const links = [
    { label: "WP Admin", url: client.adminUrl },
    { label: "Hosting", url: client.hostingUrl },
    { label: "phpMyAdmin", url: client.phpMyAdminUrl }
  ].filter((l) => l.url);

  return `
    <div class="client-card ${client.favorite ? "is-favorite" : ""}" data-id="${client.id}">
      <div class="client-card-head">
        <div>
          <h3>${hl(client.name)}</h3>
          ${client.domain ? `<span class="domain">${hl(client.domain)}</span>` : ""}
        </div>
        <button class="fav-star-btn ${client.favorite ? "" : "is-off"}" type="button"
                data-action="favorite" data-id="${client.id}"
                title="${client.favorite ? "Unfavorite" : "Favorite"}" aria-label="Toggle favorite">
          ${renderStarIcon()}
        </button>
      </div>
      <div class="client-meta-row">
        ${client.hostingProvider ? `<span class="chip host">${renderFolderIcon()}${hl(client.hostingProvider)}</span>` : ""}
        ${ssl ? `<span class="chip ${ssl.cls}">${renderShieldIcon()}${ssl.label}</span>` : ""}
      </div>
      ${links.length ? `
        <div class="quick-links">
          ${links
            .map(
              (l) =>
                `<a href="${escapeHtml(resolveWebsiteUrl(l.url))}" target="_blank" rel="noopener"
                    title="${escapeHtml(l.label)}" data-action="quick-link">${renderExternalLinkIcon()}</a>`
            )
            .join("")}
        </div>
      ` : ""}
    </div>
  `;
}

// ─── Client Modal ─────────────────────────────────────────────────────────────

function getOrCreateClientModalOverlay() {
  let overlay = document.querySelector("#client-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "client-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

// Like renderPasswordInput, but without the master-password-specific
// required/minlength constraints — a client's hosting/FTP/DB password may
// legitimately be short, unknown yet, or blank.
function renderClientPasswordField(id, label, value) {
  return `
    <label class="modal-label" for="${id}">
      <span class="modal-label-text">${label}</span>
      <span class="password-control">
        <input id="${id}" type="password" class="modal-input" autocomplete="new-password"
               value="${escapeHtml(value || "")}" />
        <button class="icon-button password-toggle" type="button"
                aria-label="Show ${label}" data-target="${id}" data-label="${label}" data-visible="false">
          ${renderEyeIcon()}
        </button>
      </span>
    </label>
  `;
}

async function openClientModal(editId) {
  const overlay = getOrCreateClientModalOverlay();
  const isEdit = editId !== null && editId !== undefined;

  let client = null;
  if (isEdit) {
    const res = await window.secureLoginVault.clients.getOne(editId);
    if (res.ok) client = res.result;
  }
  const c = client || {};

  overlay.innerHTML = `
    <div class="modal-container client-modal-container" role="dialog" aria-modal="true" aria-labelledby="client-modal-heading">
      <div class="modal-header">
        <h2 id="client-modal-heading">${isEdit ? "Edit Client" : "Add Client"}</h2>
        <button class="modal-close-btn" type="button" id="client-modal-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body">
        <div class="modal-form-row">
          <label class="modal-label" for="cm-name">
            <span class="modal-label-text">Client / Business Name <span class="required-mark">*</span></span>
            <input id="cm-name" type="text" class="modal-input" placeholder="e.g. Pearl Farm Resort"
                   value="${escapeHtml(c.name || "")}" required />
          </label>
          <label class="modal-label" for="cm-domain">
            <span class="modal-label-text">Domain</span>
            <input id="cm-domain" type="text" class="modal-input" placeholder="example.com"
                   value="${escapeHtml(c.domain || "")}" />
          </label>
        </div>

        <label class="modal-label" for="cm-category">
          <span class="modal-label-text">Category <span class="modal-hint">(optional)</span></span>
          <input id="cm-category" type="text" class="modal-input" placeholder="e.g. WordPress Maintenance"
                 value="${escapeHtml(c.category || "")}" />
        </label>

        <h3 class="settings-section-title client-modal-section">WordPress Admin</h3>
        <label class="modal-label" for="cm-admin-url">
          <span class="modal-label-text">Admin URL</span>
          <input id="cm-admin-url" type="text" class="modal-input" placeholder="https://example.com/wp-admin"
                 value="${escapeHtml(c.adminUrl || "")}" />
        </label>
        <div class="modal-form-row">
          <label class="modal-label" for="cm-admin-username">
            <span class="modal-label-text">Username</span>
            <input id="cm-admin-username" type="text" class="modal-input" autocomplete="off"
                   value="${escapeHtml(c.adminUsername || "")}" />
          </label>
          ${renderClientPasswordField("cm-admin-password", "Password", c.adminPassword)}
        </div>

        <h3 class="settings-section-title client-modal-section">Hosting</h3>
        <div class="modal-form-row">
          <label class="modal-label" for="cm-hosting-provider">
            <span class="modal-label-text">Hosting Provider</span>
            <input id="cm-hosting-provider" type="text" class="modal-input" placeholder="SiteGround"
                   value="${escapeHtml(c.hostingProvider || "")}" />
          </label>
          <label class="modal-label" for="cm-hosting-url">
            <span class="modal-label-text">cPanel / Plesk URL</span>
            <input id="cm-hosting-url" type="text" class="modal-input" placeholder="https://..."
                   value="${escapeHtml(c.hostingUrl || "")}" />
          </label>
        </div>
        <div class="modal-form-row">
          <label class="modal-label" for="cm-hosting-username">
            <span class="modal-label-text">Username</span>
            <input id="cm-hosting-username" type="text" class="modal-input" autocomplete="off"
                   value="${escapeHtml(c.hostingUsername || "")}" />
          </label>
          ${renderClientPasswordField("cm-hosting-password", "Password", c.hostingPassword)}
        </div>

        <h3 class="settings-section-title client-modal-section">FTP / SFTP</h3>
        <div class="modal-form-row">
          <label class="modal-label" for="cm-ftp-host">
            <span class="modal-label-text">Host</span>
            <input id="cm-ftp-host" type="text" class="modal-input" placeholder="ftp.example.com"
                   value="${escapeHtml(c.ftpHost || "")}" />
          </label>
          <label class="modal-label" for="cm-ftp-port">
            <span class="modal-label-text">Port</span>
            <input id="cm-ftp-port" type="text" class="modal-input" placeholder="22"
                   value="${escapeHtml(c.ftpPort || "")}" />
          </label>
        </div>
        <div class="modal-form-row">
          <label class="modal-label" for="cm-ftp-username">
            <span class="modal-label-text">Username</span>
            <input id="cm-ftp-username" type="text" class="modal-input" autocomplete="off"
                   value="${escapeHtml(c.ftpUsername || "")}" />
          </label>
          ${renderClientPasswordField("cm-ftp-password", "Password", c.ftpPassword)}
        </div>

        <h3 class="settings-section-title client-modal-section">Database</h3>
        <div class="modal-form-row">
          <label class="modal-label" for="cm-db-host">
            <span class="modal-label-text">DB Host</span>
            <input id="cm-db-host" type="text" class="modal-input" placeholder="localhost"
                   value="${escapeHtml(c.dbHost || "")}" />
          </label>
          <label class="modal-label" for="cm-db-name">
            <span class="modal-label-text">DB Name</span>
            <input id="cm-db-name" type="text" class="modal-input"
                   value="${escapeHtml(c.dbName || "")}" />
          </label>
        </div>
        <div class="modal-form-row">
          <label class="modal-label" for="cm-db-username">
            <span class="modal-label-text">DB Username</span>
            <input id="cm-db-username" type="text" class="modal-input" autocomplete="off"
                   value="${escapeHtml(c.dbUsername || "")}" />
          </label>
          ${renderClientPasswordField("cm-db-password", "DB Password", c.dbPassword)}
        </div>
        <label class="modal-label" for="cm-pma-url">
          <span class="modal-label-text">phpMyAdmin URL</span>
          <input id="cm-pma-url" type="text" class="modal-input" placeholder="https://..."
                 value="${escapeHtml(c.phpMyAdminUrl || "")}" />
        </label>

        <h3 class="settings-section-title client-modal-section">Domain &amp; SSL</h3>
        <div class="modal-form-row">
          <label class="modal-label" for="cm-registrar">
            <span class="modal-label-text">Registrar</span>
            <input id="cm-registrar" type="text" class="modal-input" placeholder="Namecheap"
                   value="${escapeHtml(c.registrar || "")}" />
          </label>
          <label class="modal-label" for="cm-domain-expiry">
            <span class="modal-label-text">Domain Expiry</span>
            <input id="cm-domain-expiry" type="date" class="modal-input"
                   value="${escapeHtml(c.domainExpiry || "")}" />
          </label>
        </div>
        <label class="modal-label" for="cm-ssl-expiry">
          <span class="modal-label-text">SSL Expiry</span>
          <input id="cm-ssl-expiry" type="date" class="modal-input"
                 value="${escapeHtml(c.sslExpiry || "")}" />
        </label>

        <label class="modal-label" for="cm-notes">
          <span class="modal-label-text">Notes</span>
          <textarea id="cm-notes" class="modal-input modal-textarea" rows="2"
                    placeholder="Anything else worth remembering...">${escapeHtml(c.notes || "")}</textarea>
        </label>

        <div class="quick-links-preview" id="cm-quick-links-preview"></div>

        ${renderQrUploadField("cm-qr", c.qrCode)}

        <label class="modal-checkbox-label" for="cm-favorite">
          <input id="cm-favorite" type="checkbox" ${c.favorite ? "checked" : ""} />
          <span>Mark as Favorite</span>
        </label>

        <p class="form-message is-error" id="client-modal-error" style="display:none"></p>
      </div>
      <div class="modal-footer">
        ${isEdit ? `<button class="danger-button" type="button" id="client-modal-delete-btn">Delete</button>` : ""}
        <button class="secondary-button" type="button" id="client-modal-cancel-btn">Cancel</button>
        <button class="primary-button" type="button" id="client-modal-save-btn">
          ${isEdit ? "Update Client" : "Save Client"}
        </button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");
  overlay.querySelector("#client-modal-close-btn").addEventListener("click", closeClientModal);
  overlay.querySelector("#client-modal-cancel-btn").addEventListener("click", closeClientModal);
  overlay.querySelector("#client-modal-save-btn").addEventListener("click", () =>
    submitClientModal(isEdit ? editId : null)
  );
  if (isEdit) {
    overlay.querySelector("#client-modal-delete-btn").addEventListener("click", () => deleteClientFromModal(editId));
  }
  setupPasswordToggles(overlay);
  setupQrUploadField(overlay, "cm-qr");
  updateQuickLinksPreview();
  ["cm-admin-url", "cm-hosting-url", "cm-pma-url"].forEach((id) => {
    overlay.querySelector(`#${id}`).addEventListener("input", updateQuickLinksPreview);
  });
  setTimeout(() => overlay.querySelector("#cm-name").focus(), 50);
}

function updateQuickLinksPreview() {
  const preview = document.querySelector("#cm-quick-links-preview");
  if (!preview) return;
  const adminUrl = document.querySelector("#cm-admin-url")?.value.trim();
  const hostingUrl = document.querySelector("#cm-hosting-url")?.value.trim();
  const pmaUrl = document.querySelector("#cm-pma-url")?.value.trim();
  const links = [
    { label: "WP Admin", url: adminUrl },
    { label: "Hosting", url: hostingUrl },
    { label: "phpMyAdmin", url: pmaUrl }
  ].filter((l) => l.url);

  preview.innerHTML = `
    <span class="modal-label-text">Quick Links <span class="modal-hint">(generated from the URLs above)</span></span>
    <div class="computed-links-row">
      ${
        links.length
          ? links.map((l) => `<span class="computed-link-chip">${renderExternalLinkIcon()}${escapeHtml(l.label)}</span>`).join("")
          : `<span class="modal-hint">Fill in a URL above to generate a quick link.</span>`
      }
    </div>
  `;
}

function closeClientModal() {
  const overlay = document.querySelector("#client-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");
}

async function submitClientModal(editId) {
  const name = document.querySelector("#cm-name").value.trim();
  const errorEl = document.querySelector("#client-modal-error");

  if (!name) {
    errorEl.textContent = "Client / Business Name is required.";
    errorEl.style.display = "";
    return;
  }
  errorEl.style.display = "none";

  const isEdit = editId !== null && editId !== undefined;
  const data = {
    name,
    domain: document.querySelector("#cm-domain").value.trim(),
    category: document.querySelector("#cm-category").value.trim(),
    adminUrl: document.querySelector("#cm-admin-url").value.trim(),
    adminUsername: document.querySelector("#cm-admin-username").value.trim(),
    adminPassword: document.querySelector("#cm-admin-password").value,
    hostingProvider: document.querySelector("#cm-hosting-provider").value.trim(),
    hostingUrl: document.querySelector("#cm-hosting-url").value.trim(),
    hostingUsername: document.querySelector("#cm-hosting-username").value.trim(),
    hostingPassword: document.querySelector("#cm-hosting-password").value,
    ftpHost: document.querySelector("#cm-ftp-host").value.trim(),
    ftpPort: document.querySelector("#cm-ftp-port").value.trim(),
    ftpUsername: document.querySelector("#cm-ftp-username").value.trim(),
    ftpPassword: document.querySelector("#cm-ftp-password").value,
    dbHost: document.querySelector("#cm-db-host").value.trim(),
    dbName: document.querySelector("#cm-db-name").value.trim(),
    dbUsername: document.querySelector("#cm-db-username").value.trim(),
    dbPassword: document.querySelector("#cm-db-password").value,
    phpMyAdminUrl: document.querySelector("#cm-pma-url").value.trim(),
    registrar: document.querySelector("#cm-registrar").value.trim(),
    domainExpiry: document.querySelector("#cm-domain-expiry").value,
    sslExpiry: document.querySelector("#cm-ssl-expiry").value,
    notes: document.querySelector("#cm-notes").value.trim(),
    qrCode: document.querySelector("#cm-qr").value,
    favorite: document.querySelector("#cm-favorite").checked
  };

  const saveBtn = document.querySelector("#client-modal-save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  const res = isEdit
    ? await window.secureLoginVault.clients.update(editId, data)
    : await window.secureLoginVault.clients.add(data);

  if (!res.ok) {
    errorEl.textContent = res.message;
    errorEl.style.display = "";
    saveBtn.disabled = false;
    saveBtn.textContent = isEdit ? "Update Client" : "Save Client";
    return;
  }

  closeClientModal();
  await loadClientVaultData();
}

async function deleteClientFromModal(id) {
  const nameEl = document.querySelector("#cm-name");
  const name = nameEl ? nameEl.value.trim() : "this client";
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  const res = await window.secureLoginVault.clients.remove(id);
  if (res.ok) {
    closeClientModal();
    await loadClientVaultData();
  }
}

// ─── Phase 10: Settings Modal (full: Theme, Auto-Lock, Change PW, Info + Phase 9 Import/Export) ──

// ── Preferences stored in localStorage ────────────────────────────────────────

function getPref(key, fallback) {
  const v = localStorage.getItem(key);
  return v !== null ? v : fallback;
}

function setPref(key, value) {
  localStorage.setItem(key, String(value));
}

// ── Theme ──────────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "dark") {
    root.setAttribute("data-theme", "dark");
  } else if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", prefersDark ? "dark" : "light");
  } else {
    root.setAttribute("data-theme", "light");
  }
}

function initTheme() {
  const saved = getPref(PREF_THEME, "light");
  applyTheme(saved);

  // React to OS changes when "system" is selected
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getPref(PREF_THEME, "light") === "system") applyTheme("system");
  });
}

// ── White-label branding ───────────────────────────────────────────────────────
//
// Lets a deployment rename the app, swap the logo shown inside it, and
// recolor the accent used throughout the UI, all from Settings > Branding.
// Everything is stored locally (same mechanism as theme/auto-lock prefs) and
// re-applied on every launch via applyBranding(), called right next to
// initTheme() so there's no flash of the default brand before it kicks in.
//
// The window/taskbar icon (Windows) also follows the custom logo now, via
// the branding.setWindowIcon IPC bridge — main.js applies it with
// BrowserWindow.setIcon() since that can't be done from the renderer.

function getBrandName() {
  return getPref(PREF_BRAND_NAME, DEFAULT_BRAND_NAME);
}

function getBrandLogo() {
  return getPref(PREF_BRAND_LOGO, "");
}

function getBrandAccent() {
  return getPref(PREF_BRAND_ACCENT, "");
}

// Renders the little logo box used in the sidebar, the login screen, and the
// About modal — a custom uploaded image if one is set, otherwise the default
// vault glyph. `extraClass` carries sizing variants like "compact".
function renderBrandMark(extraClass = "") {
  const logo = getBrandLogo();
  const cls = extraClass ? `brand-mark ${extraClass}` : "brand-mark";
  if (logo) {
    return `<div class="${cls}" aria-hidden="true"><img src="${logo}" class="brand-mark-logo" alt="" /></div>`;
  }
  return `<div class="${cls}" aria-hidden="true"><span></span></div>`;
}

function applyBranding() {
  const name = getBrandName();
  document.title = name;

  const root = document.documentElement;
  const accent = getBrandAccent();
  if (accent) {
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-strong", shadeColor(accent, -15));
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-strong");
  }

  // Best-effort: also update the native window title bar, if the preload
  // bridge exposes it. Older builds without this IPC channel just keep
  // whatever title main.js set at launch.
  if (window.secureLoginVault?.branding?.setWindowTitle) {
    window.secureLoginVault.branding.setWindowTitle(name);
  }

  // Same idea for the window/taskbar icon — passing "" resets it back to the
  // packaged default on the main-process side when no custom logo is set.
  if (window.secureLoginVault?.branding?.setWindowIcon) {
    window.secureLoginVault.branding.setWindowIcon(getBrandLogo());
  }

  // Patch whatever brand name/logo elements already exist on screen (sidebar,
  // login screen, About modal) so a change in Settings shows up immediately
  // instead of requiring the dashboard to be re-rendered from scratch.
  document.querySelectorAll(".sidebar-brand strong, .about-app-name, #app-title")
    .forEach((el) => { el.textContent = name; });

  const logo = getBrandLogo();
  document.querySelectorAll(".brand-mark").forEach((el) => {
    el.innerHTML = logo ? `<img src="${escapeHtml(logo)}" class="brand-mark-logo" alt="" />` : "<span></span>";
  });
}

// Lightens (positive percent) or darkens (negative percent) a "#rrggbb"
// color, used to derive a hover/strong accent variant from the single color
// picked in Settings.
function shadeColor(hex, percent) {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return hex;
  const num = parseInt(clean, 16);
  if (Number.isNaN(num)) return hex;
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
  const r = clamp(((num >> 16) & 0xff) + (percent / 100) * 255);
  const g = clamp(((num >> 8) & 0xff) + (percent / 100) * 255);
  const b = clamp((num & 0xff) + (percent / 100) * 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// Same resize as resizeImageToDataUri, but keeps transparency instead of
// filling a white background — a logo needs to sit on the sidebar's
// existing panel color (light or dark), not a white square.
function resizeLogoToDataUri(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File could not be read."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image could not be decoded."));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve({ dataUri: canvas.toDataURL("image/png"), width, height });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Auto-Lock ──────────────────────────────────────────────────────────────────

let _autoLockTimer = null;
let _backgroundLockTimer = null;
let _unsubscribeWindowBackgrounded = null;
let _unsubscribeWindowForegrounded = null;

function getAutoLockDelay() {
  return parseInt(getPref(PREF_AUTO_LOCK, "0"), 10) || 0;
}

// Returns the background-lock grace period in ms, or null if disabled.
// "0" means instant (lock immediately on minimize/blur).
function getBackgroundLockGraceMs() {
  const stored = getPref(PREF_BACKGROUND_LOCK, "10");
  if (stored === "off") return null;
  const seconds = parseInt(stored, 10);
  return Number.isNaN(seconds) ? null : seconds * 1000;
}

function resetAutoLockTimer() {
  clearTimeout(_autoLockTimer);
  const seconds = getAutoLockDelay();
  if (!seconds) return;

  _autoLockTimer = setTimeout(async () => {
    await window.secureLoginVault.auth.lockVault();
    showToast("Vault locked due to inactivity", "info");
    window.location.reload();
  }, seconds * 1000);
}

async function lockDueToBackgrounding() {
  await window.secureLoginVault.auth.lockVault();
  window.location.reload();
}

function startAutoLockWatcher() {
  // Clear any previously registered background-lock listeners first, since
  // this function can be called again (e.g. when the user changes a setting),
  // and we don't want duplicate IPC listeners stacking up.
  if (_unsubscribeWindowBackgrounded) {
    _unsubscribeWindowBackgrounded();
    _unsubscribeWindowBackgrounded = null;
  }
  if (_unsubscribeWindowForegrounded) {
    _unsubscribeWindowForegrounded();
    _unsubscribeWindowForegrounded = null;
  }
  clearTimeout(_backgroundLockTimer);

  // Background lock (minimize/blur) is its own toggle, independent of the
  // inactivity Auto-Lock setting — a user may want one without the other.
  const graceMs = getBackgroundLockGraceMs();
  if (graceMs !== null) {
    _unsubscribeWindowBackgrounded = window.secureLoginVault.auth.onWindowBackgrounded(() => {
      clearTimeout(_backgroundLockTimer);
      if (graceMs === 0) {
        lockDueToBackgrounding();
      } else {
        _backgroundLockTimer = setTimeout(lockDueToBackgrounding, graceMs);
      }
    });

    _unsubscribeWindowForegrounded = window.secureLoginVault.auth.onWindowForegrounded(() => {
      clearTimeout(_backgroundLockTimer);
    });
  }

  if (!getAutoLockDelay()) return;
  ["mousemove", "keydown", "mousedown", "scroll", "touchstart"].forEach((evt) => {
    window.addEventListener(evt, resetAutoLockTimer, { passive: true });
  });
  resetAutoLockTimer();
}

// ── Clipboard clear delay (Phase 8 hook, configurable in Phase 10) ─────────────

function getClipboardClearDelay() {
  const stored = getPref(PREF_CLIPBOARD, "30");
  if (stored === "0") return 0;
  return (parseInt(stored, 10) || 30) * 1000;
}

// ── Settings modal helpers ─────────────────────────────────────────────────────

function getOrCreateSettingsOverlay() {
  let overlay = document.querySelector("#settings-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "settings-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

async function openSettingsModal() {
  const overlay = getOrCreateSettingsOverlay();

  // Load app info for the "About" section
  let appInfo = { version: "Unavailable", vaultDirectory: "Unavailable" };
  try {
    const res = await window.secureLoginVault.settings.getAppInfo();
    if (res.ok) appInfo = res.result;
  } catch { /* swallow */ }

  const currentTheme    = getPref(PREF_THEME, "light");
  const currentAutoLock = getPref(PREF_AUTO_LOCK, "0");
  const currentBackgroundLock = getPref(PREF_BACKGROUND_LOCK, "10");
  const currentClip     = getPref(PREF_CLIPBOARD, "30");
  const currentBackupFolder = getPref(PREF_BACKUP_FOLDER, "");
  const currentBrandName   = getBrandName();
  const currentBrandLogo   = getBrandLogo();
  const currentBrandAccent = getBrandAccent();

  overlay.innerHTML = `
    <div class="modal-container settings-modal-container" role="dialog" aria-modal="true" aria-labelledby="settings-modal-heading">
      <div class="modal-header">
        <h2 id="settings-modal-heading">Settings</h2>
        <button class="modal-close-btn" type="button" id="settings-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body settings-modal-body">

        <!-- ── Branding (white-label) ──────────────────────────── -->
        <section class="settings-section">
          <h3 class="settings-section-title">Branding</h3>
          <p class="settings-section-hint">
            Rename the app, swap its logo, and recolor the accent used throughout —
            useful if you're deploying this under a client's own identity.
          </p>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">App Name</span>
              <span class="settings-row-hint">Shown in the sidebar, login screen, About, and window title.</span>
            </div>
            <div class="settings-row-control settings-backup-folder-control">
              <input class="settings-input" type="text" id="brand-name-input" maxlength="60"
                     style="max-width:220px" value="${escapeHtml(currentBrandName)}"
                     placeholder="${escapeHtml(DEFAULT_BRAND_NAME)}" />
              <div class="settings-backup-folder-btns">
                <button class="primary-button settings-action-btn" type="button" id="brand-name-save-btn">Save</button>
              </div>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">
                Logo
                <span class="info-tooltip" tabindex="0" title="Replaces the default mark in the sidebar, login screen, and About. Square image recommended (e.g. 256×256px); it's shown in a small square badge, so tall or wide logos will letterbox.">
                  ${renderInfoIcon()}
                </span>
              </span>
            </div>
            <div class="settings-row-control">
              <div class="brand-logo-field" id="brand-logo-field">
                <div class="brand-logo-preview-wrap" id="brand-logo-preview-wrap">
                  ${currentBrandLogo
                    ? `<img src="${currentBrandLogo}" class="brand-logo-preview" alt="" />`
                    : `<div class="brand-logo-empty">No logo set</div>`}
                </div>
                <input type="file" accept="image/*" id="brand-logo-file" hidden />
                <div class="settings-backup-folder-btns">
                  <button class="secondary-button settings-action-btn" type="button" id="brand-logo-upload-btn">
                    ${renderFileIcon()} <span>${currentBrandLogo ? "Replace" : "Upload"}</span>
                  </button>
                  <button class="danger-button settings-action-btn" type="button" id="brand-logo-remove-btn"
                    ${currentBrandLogo ? "" : "disabled"}>
                    ${renderCloseIcon()} <span>Remove</span>
                  </button>
                </div>
              </div>
              <p class="form-message" id="brand-logo-error" style="display:none"></p>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Accent Color</span>
              <span class="settings-row-hint">Used for buttons, links, and highlights across the app.</span>
            </div>
            <div class="settings-row-control settings-backup-folder-control">
              <input type="color" id="brand-accent-input" class="brand-accent-swatch"
                     value="${currentBrandAccent || "#1f7a68"}" />
              <div class="settings-backup-folder-btns">
                <button class="primary-button settings-action-btn" type="button" id="brand-accent-save-btn">Apply</button>
                <button class="secondary-button settings-action-btn" type="button" id="brand-accent-reset-btn">Reset</button>
              </div>
            </div>
          </div>
        </section>

        <!-- ── Appearance ────────────────────────────────────── -->
        <section class="settings-section">
          <h3 class="settings-section-title">Appearance</h3>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Theme</span>
              <span class="settings-row-hint">Choose light, dark, or follow the OS setting.</span>
            </div>
            <div class="settings-row-control">
              <div class="segmented-control" role="group" aria-label="Theme">
                <button class="seg-btn ${currentTheme === "light"  ? "is-active" : ""}" data-theme="light"  type="button">Light</button>
                <button class="seg-btn ${currentTheme === "dark"   ? "is-active" : ""}" data-theme="dark"   type="button">Dark</button>
                <button class="seg-btn ${currentTheme === "system" ? "is-active" : ""}" data-theme="system" type="button">System</button>
              </div>
            </div>
          </div>
        </section>

        <!-- ── Security ──────────────────────────────────────── -->
        <section class="settings-section">
          <h3 class="settings-section-title">Security</h3>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Auto-Lock</span>
              <span class="settings-row-hint">Lock the vault after a period of inactivity.</span>
            </div>
            <div class="settings-row-control">
              <select class="settings-select" id="auto-lock-select">
                <option value="0"    ${currentAutoLock === "0"    ? "selected" : ""}>Disabled</option>
                <option value="300"  ${currentAutoLock === "300"  ? "selected" : ""}>5 minutes</option>
                <option value="600"  ${currentAutoLock === "600"  ? "selected" : ""}>10 minutes</option>
                <option value="1800" ${currentAutoLock === "1800" ? "selected" : ""}>30 minutes</option>
                <option value="3600" ${currentAutoLock === "3600" ? "selected" : ""}>1 hour</option>
              </select>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Lock on Minimize</span>
              <span class="settings-row-hint">Lock the vault after the window is minimized or loses focus.</span>
            </div>
            <div class="settings-row-control">
              <select class="settings-select" id="background-lock-select">
                <option value="off" ${currentBackgroundLock === "off" ? "selected" : ""}>Disabled</option>
                <option value="0"   ${currentBackgroundLock === "0"   ? "selected" : ""}>Instant</option>
                <option value="10"  ${currentBackgroundLock === "10"  ? "selected" : ""}>10 seconds</option>
                <option value="30"  ${currentBackgroundLock === "30"  ? "selected" : ""}>30 seconds</option>
                <option value="60"  ${currentBackgroundLock === "60"  ? "selected" : ""}>1 minute</option>
              </select>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Clipboard Auto-Clear</span>
              <span class="settings-row-hint">Clear copied passwords from clipboard automatically.</span>
            </div>
            <div class="settings-row-control">
              <select class="settings-select" id="clipboard-clear-select">
                <option value="0"  ${currentClip === "0"  ? "selected" : ""}>Disabled</option>
                <option value="15" ${currentClip === "15" ? "selected" : ""}>15 seconds</option>
                <option value="30" ${currentClip === "30" ? "selected" : ""}>30 seconds</option>
                <option value="60" ${currentClip === "60" ? "selected" : ""}>1 minute</option>
              </select>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Default Backup Folder</span>
              <span class="settings-row-hint">Where encrypted backups are saved by default.</span>
            </div>
            <div class="settings-row-control settings-backup-folder-control">
              <span class="settings-backup-folder-path" id="backup-folder-display">
                ${currentBackupFolder ? escapeHtml(currentBackupFolder) : "System default (Save dialog)"}
              </span>
              <div class="settings-backup-folder-btns">
                <button class="secondary-button settings-action-btn" type="button" id="backup-folder-pick-btn">
                  ${renderFolderIcon()} <span>Choose...</span>
                </button>
                <button class="secondary-button settings-action-btn" type="button" id="backup-folder-clear-btn"
                  ${currentBackupFolder ? "" : "disabled"}>
                  ${renderCloseIcon()} <span>Clear</span>
                </button>
              </div>
            </div>
          </div>

          <div class="settings-subgroup" style="margin-top: 16px;">
            <h4 class="settings-subgroup-title">Change Master Password</h4>
            <div class="change-pw-form" id="change-pw-form">
              <div class="settings-input-row">
                <label class="settings-input-label" for="cpw-current">Current Password</label>
                <div class="settings-input-wrap">
                  <input class="settings-input" type="password" id="cpw-current" autocomplete="current-password" placeholder="Current master password">
                  <button class="settings-eye-btn" type="button" data-target="cpw-current" aria-label="Show/Hide">
                    ${renderEyeIcon()}
                  </button>
                </div>
              </div>
              <div class="settings-input-row">
                <label class="settings-input-label" for="cpw-new">New Password</label>
                <div class="settings-input-wrap">
                  <input class="settings-input" type="password" id="cpw-new" autocomplete="new-password" placeholder="At least 12 characters">
                  <button class="settings-eye-btn" type="button" data-target="cpw-new" aria-label="Show/Hide">
                    ${renderEyeIcon()}
                  </button>
                </div>
              </div>
              <div class="settings-input-row">
                <label class="settings-input-label" for="cpw-confirm">Confirm New Password</label>
                <div class="settings-input-wrap">
                  <input class="settings-input" type="password" id="cpw-confirm" autocomplete="new-password" placeholder="Repeat new password">
                  <button class="settings-eye-btn" type="button" data-target="cpw-confirm" aria-label="Show/Hide">
                    ${renderEyeIcon()}
                  </button>
                </div>
              </div>
              <p class="form-message" id="cpw-status" style="display:none"></p>
              <button class="primary-button settings-cpw-btn" type="button" id="cpw-submit-btn">
                Change Password
              </button>
            </div>
          </div>
        </section>

        <!-- ── Categories ────────────────────────────────────── -->
        <section class="settings-section">
          <h3 class="settings-section-title">Categories</h3>
          <p class="settings-section-hint">
            Add, rename, or delete the categories used to organize your credentials.
          </p>
          <div class="settings-action-row">
            <button class="secondary-button settings-action-btn" type="button" id="settings-manage-categories-btn">
              ${renderManageCategoriesIcon()} <span>Manage Categories</span>
            </button>
          </div>
        </section>

        <!-- ── Groups ─────────────────────────────────── -->
        <section class="settings-section">
          <h3 class="settings-section-title">Groups</h3>
          <p class="settings-section-hint">
            Group credentials however is useful to you. Lock the vault to one group
            and credentials for every other group are hidden from the list entirely
            — useful if a time tracker or screenshot tool might capture your screen.
          </p>
          <div class="settings-row">
            <div class="settings-row-label">
              <span class="settings-row-name">Active Group</span>
              <span class="settings-row-hint" id="active-group-status-hint">Loading...</span>
            </div>
            <div class="settings-row-control settings-backup-folder-control">
              <select class="settings-input" id="settings-active-group-select" style="max-width:200px">
                <option value="">All (no lock)</option>
              </select>
              <div class="settings-backup-folder-btns">
                <button class="primary-button settings-action-btn" type="button" id="settings-apply-active-group-btn">
                  ${renderShieldIcon()} <span>Apply</span>
                </button>
              </div>
            </div>
          </div>
          <div class="settings-action-row">
            <button class="secondary-button settings-action-btn" type="button" id="settings-manage-groups-btn">
              ${renderManageCategoriesIcon()} <span>Manage Groups</span>
            </button>
          </div>
        </section>

        <!-- ── Import & Export ───────────────────────────────── -->
        <section class="settings-section">
          <h3 class="settings-section-title">Import &amp; Export</h3>
          <p class="settings-section-hint">
            Import credentials from a CSV, JSON, or KeePass CSV export. Export your
            vault as CSV, JSON, or a fully encrypted backup file.
          </p>

          <div class="settings-subgroup">
            <h4 class="settings-subgroup-title">Import</h4>
            <div class="settings-action-row">
              <button class="secondary-button settings-action-btn" type="button" data-import="csv">
                ${renderFileIcon()} <span>Import CSV</span>
              </button>
              <button class="secondary-button settings-action-btn" type="button" data-import="json">
                ${renderFileIcon()} <span>Import JSON</span>
              </button>
              <button class="secondary-button settings-action-btn" type="button" data-import="keepass">
                ${renderFileIcon()} <span>Import KeePass CSV</span>
              </button>
            </div>
          </div>

          <div class="settings-subgroup">
            <h4 class="settings-subgroup-title">Export</h4>
            <div class="settings-action-row">
              <button class="secondary-button settings-action-btn" type="button" data-export="csv">
                ${renderDownloadIcon()} <span>Export CSV</span>
              </button>
              <button class="secondary-button settings-action-btn" type="button" data-export="json">
                ${renderDownloadIcon()} <span>Export JSON</span>
              </button>
              <button class="secondary-button settings-action-btn" type="button" data-export="backup">
                ${renderShieldIcon()} <span>Encrypted Backup</span>
              </button>
            </div>
          </div>

          <div class="settings-subgroup">
            <h4 class="settings-subgroup-title">Restore</h4>
            <div class="settings-action-row">
              <button class="secondary-button settings-action-btn" type="button" id="settings-restore-btn">
                ${renderRestoreIcon()} <span>Restore from Backup</span>
              </button>
            </div>
            <p class="settings-section-hint settings-warning-hint">
              Restoring replaces everything currently in your vault. This can't be undone.
            </p>
          </div>

          <p class="form-message" id="settings-status" style="display:none"></p>
        </section>

        <!-- ── About ─────────────────────────────────────────── -->
        <section class="settings-section">
          <h3 class="settings-section-title">About</h3>
          <div class="settings-info-grid">
            <span class="settings-info-key">Version</span>
            <span class="settings-info-val">${escapeHtml(appInfo.version)}</span>
            <span class="settings-info-key">Vault location</span>
            <span class="settings-info-val settings-info-path">${escapeHtml(appInfo.vaultDirectory)}</span>
          </div>
          <div class="settings-action-row" style="margin-top: 14px;">
            <button class="secondary-button settings-action-btn" type="button" id="settings-open-help-btn">
              ${renderHelpIcon()} <span>Help &amp; FAQ</span>
            </button>
            <button class="secondary-button settings-action-btn" type="button" id="settings-open-about-btn">
              ${renderInfoIcon()} <span>About ${escapeHtml(getBrandName())}</span>
            </button>
          </div>
        </section>

      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="settings-done-btn">Close</button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");

  // ── Close ────────────────────────────────────────────────────────────────────
  overlay.querySelector("#settings-close-btn").addEventListener("click", closeSettingsModal);
  overlay.querySelector("#settings-done-btn").addEventListener("click", closeSettingsModal);

  // ── Branding: App Name ────────────────────────────────────────────────────────
  overlay.querySelector("#brand-name-save-btn").addEventListener("click", () => {
    const input = overlay.querySelector("#brand-name-input");
    const value = input.value.trim();
    setPref(PREF_BRAND_NAME, value);
    input.value = value || DEFAULT_BRAND_NAME;
    applyBranding();
    setSettingsStatus("App name saved.");
  });

  // ── Branding: Logo ─────────────────────────────────────────────────────────────
  const logoFileInput = overlay.querySelector("#brand-logo-file");
  const logoPreviewWrap = overlay.querySelector("#brand-logo-preview-wrap");
  const logoRemoveBtn = overlay.querySelector("#brand-logo-remove-btn");
  const logoUploadBtnLabel = overlay.querySelector("#brand-logo-upload-btn span");
  const logoErrorEl = overlay.querySelector("#brand-logo-error");

  const showLogoError = (msg) => {
    logoErrorEl.textContent = msg;
    logoErrorEl.className = "form-message is-error";
    logoErrorEl.style.display = "";
  };
  const showLogoNotice = (msg) => {
    logoErrorEl.textContent = msg;
    logoErrorEl.className = "form-message";
    logoErrorEl.style.display = "";
  };
  const clearLogoError = () => { logoErrorEl.style.display = "none"; };

  overlay.querySelector("#brand-logo-upload-btn").addEventListener("click", () => logoFileInput.click());

  logoRemoveBtn.addEventListener("click", () => {
    setPref(PREF_BRAND_LOGO, "");
    applyBranding();
    logoPreviewWrap.innerHTML = `<div class="brand-logo-empty">No logo set</div>`;
    logoRemoveBtn.disabled = true;
    logoUploadBtnLabel.textContent = "Upload";
    clearLogoError();
    setSettingsStatus("Logo removed — using the default mark.");
  });

  logoFileInput.addEventListener("change", async () => {
    const file = logoFileInput.files[0];
    logoFileInput.value = ""; // allow re-selecting the same file again later
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showLogoError("Please select an image file.");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showLogoError("Image is too large (max 8 MB).");
      return;
    }

    try {
      const { dataUri, width, height } = await resizeLogoToDataUri(file, 256);
      setPref(PREF_BRAND_LOGO, dataUri);
      applyBranding();
      logoPreviewWrap.innerHTML = `<img src="${dataUri}" class="brand-logo-preview" alt="" />`;
      logoRemoveBtn.disabled = false;
      logoUploadBtnLabel.textContent = "Replace";

      const aspect = Math.max(width, height) / Math.min(width, height);
      if (aspect > 1.6) {
        showLogoNotice("Logo saved. It's shown in a small square badge, so this image will letterbox — a square crop will look sharper.");
      } else {
        clearLogoError();
        setSettingsStatus("Logo updated.");
      }
    } catch {
      showLogoError("Could not read that image. Try a different file.");
    }
  });

  // ── Branding: Accent Color ─────────────────────────────────────────────────────
  overlay.querySelector("#brand-accent-save-btn").addEventListener("click", () => {
    const value = overlay.querySelector("#brand-accent-input").value;
    setPref(PREF_BRAND_ACCENT, value);
    applyBranding();
    setSettingsStatus("Accent color applied.");
  });

  overlay.querySelector("#brand-accent-reset-btn").addEventListener("click", () => {
    setPref(PREF_BRAND_ACCENT, "");
    applyBranding();
    overlay.querySelector("#brand-accent-input").value = "#1f7a68";
    setSettingsStatus("Accent color reset to default.");
  });

  // ── Theme segmented control ──────────────────────────────────────────────────
  overlay.querySelectorAll(".seg-btn[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".seg-btn[data-theme]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const theme = btn.dataset.theme;
      setPref(PREF_THEME, theme);
      applyTheme(theme);
    });
  });

  // ── Auto-lock select ─────────────────────────────────────────────────────────
  overlay.querySelector("#auto-lock-select").addEventListener("change", (e) => {
    setPref(PREF_AUTO_LOCK, e.target.value);
    clearTimeout(_autoLockTimer);
    startAutoLockWatcher();
  });

  // ── Background lock (minimize/blur) select ─────────────────────────────────────
  overlay.querySelector("#background-lock-select").addEventListener("change", (e) => {
    setPref(PREF_BACKGROUND_LOCK, e.target.value);
    startAutoLockWatcher();
  });

  // ── Clipboard clear select ───────────────────────────────────────────────────
  overlay.querySelector("#clipboard-clear-select").addEventListener("change", (e) => {
    setPref(PREF_CLIPBOARD, e.target.value);
  });

  // ── Backup folder ────────────────────────────────────────────────────────────
  overlay.querySelector("#backup-folder-pick-btn").addEventListener("click", async () => {
    const res = await window.secureLoginVault.settings.pickFolder();
    if (!res.ok || res.result.canceled) return;
    const folderPath = res.result.folderPath;
    setPref(PREF_BACKUP_FOLDER, folderPath);
    overlay.querySelector("#backup-folder-display").textContent = folderPath;
    overlay.querySelector("#backup-folder-clear-btn").disabled = false;
    showToast("Default backup folder updated", "info");
  });

  overlay.querySelector("#backup-folder-clear-btn").addEventListener("click", () => {
    setPref(PREF_BACKUP_FOLDER, "");
    overlay.querySelector("#backup-folder-display").textContent = "System default (Save dialog)";
    overlay.querySelector("#backup-folder-clear-btn").disabled = true;
    showToast("Backup folder cleared", "info");
  });

  // ── Password visibility toggles ──────────────────────────────────────────────
  overlay.querySelectorAll(".settings-eye-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = overlay.querySelector(`#${btn.dataset.target}`);
      if (!input) return;
      const isVisible = input.type === "text";
      input.type = isVisible ? "password" : "text";
      btn.innerHTML = isVisible ? renderEyeIcon() : renderEyeOffIcon();
      btn.setAttribute("aria-label", isVisible ? "Show" : "Hide");
    });
  });

  // ── Change master password ───────────────────────────────────────────────────
  overlay.querySelector("#cpw-submit-btn").addEventListener("click", runChangeMasterPassword);

  // ── Manage Categories (opens its own modal on top) ──────────────────────────
  overlay.querySelector("#settings-manage-categories-btn").addEventListener("click", openManageCategoriesModal);

  // ── Groups: active-group selector + Manage Groups modal ─────────────────────
  overlay.querySelector("#settings-manage-groups-btn").addEventListener("click", openManageGroupsModal);
  overlay.querySelector("#settings-apply-active-group-btn").addEventListener("click", runApplyActiveGroup);
  loadActiveGroupControl();

  // ── Help & FAQ (opens its own modal on top) ──────────────────────────────────
  overlay.querySelector("#settings-open-help-btn").addEventListener("click", openHelpModal);

  // ── About (opens its own modal on top) ───────────────────────────────────────
  overlay.querySelector("#settings-open-about-btn").addEventListener("click", openAboutModal);

  // ── Import / Export (Phase 9 wiring) ────────────────────────────────────────
  overlay.querySelectorAll("[data-import]").forEach((btn) => {
    btn.addEventListener("click", () => runImportFlow(btn.dataset.import, btn));
  });
  overlay.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => runExportFlow(btn.dataset.export, btn));
  });
  overlay.querySelector("#settings-restore-btn").addEventListener("click", runRestoreFlow);
}

function closeSettingsModal() {
  const overlay = document.querySelector("#settings-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");
}

// ─── Groups: Active Group control (lives in Settings) ────────────────────────

async function loadActiveGroupControl() {
  const select = document.querySelector("#settings-active-group-select");
  const hint = document.querySelector("#active-group-status-hint");
  if (!select) return;

  const [groupsRes, activeRes] = await Promise.all([
    window.secureLoginVault.groups.getAll(),
    window.secureLoginVault.groups.getActive()
  ]);

  const groups = groupsRes.ok ? groupsRes.result : [];
  const active = activeRes.ok ? activeRes.result : "";

  select.innerHTML =
    `<option value="">All (no lock)</option>` +
    groups
      .map((g) => `<option value="${escapeHtml(g)}" ${g === active ? "selected" : ""}>${escapeHtml(g)}</option>`)
      .join("");

  if (hint) {
    hint.textContent = active
      ? `Locked to "${active}" — credentials outside this group are hidden.`
      : "Not locked — all credentials are visible.";
  }
}

async function runApplyActiveGroup() {
  const select = document.querySelector("#settings-active-group-select");
  const hint = document.querySelector("#active-group-status-hint");
  if (!select) return;

  const value = select.value;
  const res = await window.secureLoginVault.groups.setActive(value);

  if (!res.ok) {
    if (hint) hint.textContent = res.message || "Could not change the active group.";
    return;
  }

  if (hint) {
    hint.textContent = value
      ? `Locked to "${value}" — credentials outside this group are hidden.`
      : "Not locked — all credentials are visible.";
  }

  showToast(value ? `Locked to "${value}"` : "Lock cleared — showing all credentials", "info");
  setActiveGroupBanner(value, { forceShow: true });
  await refreshCredentials();
}

// ─── Manage Categories: List Modal ────────────────────────────────────────────
//
// Three dedicated modals instead of one modal that mutates its own list rows
// in place: a List modal (browse/add/entry point), a Rename modal, and a
// Delete modal. Renaming or deleting opens a small modal on top of the List
// modal and closes back down to it; the List modal always re-fetches and
// fully replaces its body rather than patching individual rows. Nothing ever
// rewrites `innerHTML` on a node nested inside a live scrollable list.

function getOrCreateCategoriesOverlay() {
  let overlay = document.querySelector("#categories-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "categories-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

// Tracks whether Settings was open when Manage Categories was launched, so
// closing the List modal can restore it. Only one `position: fixed` modal
// overlay is ever visible at a time.
let _categoriesModalReopenSettings = false;

async function openManageCategoriesModal() {
  const settingsOverlay = document.querySelector("#settings-modal-overlay");
  _categoriesModalReopenSettings = Boolean(settingsOverlay && settingsOverlay.classList.contains("is-open"));
  // Note: we deliberately do NOT remove "is-open" from the Settings overlay
  // here. Both overlays are full-viewport `position: fixed` backdrops, so
  // leaving Settings underneath is visually identical to hiding it — but
  // removing it first creates a one-frame gap with zero backdrops visible
  // (since display:none/flex can't cross-fade), which flashes the plain
  // dashboard background behind both modals.

  const overlay = getOrCreateCategoriesOverlay();
  overlay.innerHTML = `
    <div class="modal-container categories-modal-container" role="dialog" aria-modal="true" aria-labelledby="categories-modal-heading">
      <div class="modal-header">
        <h2 id="categories-modal-heading">Manage Categories</h2>
        <button class="modal-close-btn" type="button" id="categories-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body categories-modal-body">
        <div class="category-add-row">
          <input class="modal-input" type="text" id="new-category-input" placeholder="New category name" maxlength="60" autocomplete="off" />
          <button class="primary-button" type="button" id="add-category-btn">
            ${renderPlusIcon()} <span>Add</span>
          </button>
        </div>
        <p class="form-message" id="categories-status" style="display:none"></p>
        <div class="category-manage-list" id="category-manage-list" aria-label="Categories">
          <div class="category-manage-loading">Loading categories...</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="categories-done-btn">Close</button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");

  overlay.querySelector("#categories-close-btn").addEventListener("click", closeManageCategoriesModal);
  overlay.querySelector("#categories-done-btn").addEventListener("click", closeManageCategoriesModal);

  const input = overlay.querySelector("#new-category-input");
  overlay.querySelector("#add-category-btn").addEventListener("click", () => runAddCategory());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runAddCategory();
  });

  await loadCategoryManageList();
}

function closeManageCategoriesModal() {
  const overlay = document.querySelector("#categories-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");

  if (_categoriesModalReopenSettings) {
    _categoriesModalReopenSettings = false;
    const settingsOverlay = document.querySelector("#settings-modal-overlay");
    if (settingsOverlay) settingsOverlay.classList.add("is-open");
  }
}

function setCategoriesStatus(message, isError = false) {
  const el = document.querySelector("#categories-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = isError ? "form-message is-error" : "form-message is-success";
  el.style.display = message ? "" : "none";
}

// Always re-fetches and fully replaces the list body — never patches a
// single row's innerHTML while it stays mounted inside the scroll container.
async function loadCategoryManageList() {
  const list = document.querySelector("#category-manage-list");
  if (!list) return;

  const res = await window.secureLoginVault.categories.getAllWithUsage();
  if (!res.ok) {
    list.innerHTML = `<div class="category-manage-empty">Could not load categories.</div>`;
    return;
  }

  const categories = res.result;
  list.innerHTML = categories.map((cat) => renderCategoryManageRow(cat)).join("");

  list.querySelectorAll("[data-action='rename-category']").forEach((btn) => {
    btn.addEventListener("click", () => openRenameCategoryModal(btn.dataset.name));
  });
  list.querySelectorAll("[data-action='delete-category']").forEach((btn) => {
    const category = categories.find((c) => c.name === btn.dataset.name);
    btn.addEventListener("click", () => openDeleteCategoryModal(category, categories));
  });
}

function renderCategoryManageRow(category) {
  const safeName = escapeHtml(category.name);
  const countLabel = `${category.credentialCount} credential${category.credentialCount === 1 ? "" : "s"}`;

  return `
    <div class="category-manage-row" data-name="${safeName}">
      <div class="category-manage-info">
        <span class="category-manage-name">${safeName}</span>
        <span class="category-manage-count">${countLabel}</span>
      </div>
      <div class="category-manage-actions">
        <button class="icon-button row-action-btn" type="button" data-action="rename-category"
                data-name="${safeName}" title="Rename" aria-label="Rename ${safeName}">
          ${renderEditIcon()}
        </button>
        <button class="icon-button row-action-btn danger-btn" type="button" data-action="delete-category"
                data-name="${safeName}" title="Delete" aria-label="Delete ${safeName}">
          ${renderTrashIcon()}
        </button>
      </div>
    </div>
  `;
}

async function runAddCategory() {
  const input = document.querySelector("#new-category-input");
  if (!input) return;
  const name = input.value.trim();

  if (!name) {
    setCategoriesStatus("Enter a category name.", true);
    return;
  }

  const res = await window.secureLoginVault.categories.add(name);
  if (!res.ok) {
    setCategoriesStatus(res.message || "Could not add category.", true);
    return;
  }

  input.value = "";
  setCategoriesStatus(`Added "${res.result.name}".`);
  await loadCategoryManageList();
  await refreshCredentials();
}

// ─── Manage Categories: Rename Modal ──────────────────────────────────────────
//
// A separate, single-purpose modal that stacks on top of the List modal.
// It never touches the list's DOM directly — it just calls the rename API
// and, on success, hides itself and tells the List modal to reload.

function getOrCreateRenameCategoryOverlay() {
  let overlay = document.querySelector("#category-rename-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "category-rename-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

function openRenameCategoryModal(currentName) {
  const listOverlay = document.querySelector("#categories-modal-overlay");
  if (listOverlay) listOverlay.classList.remove("is-open");

  const overlay = getOrCreateRenameCategoryOverlay();
  overlay.innerHTML = `
    <div class="modal-container category-subtask-modal-container" role="dialog" aria-modal="true" aria-labelledby="rename-category-heading">
      <div class="modal-header">
        <h2 id="rename-category-heading">Rename Category</h2>
        <button class="modal-close-btn" type="button" id="rename-category-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body">
        <label class="modal-label" for="rename-category-input">
          <span class="modal-label-text">Category name</span>
          <input class="modal-input" type="text" id="rename-category-input" maxlength="60"
                 value="${escapeHtml(currentName)}" autocomplete="off" />
        </label>
        <p class="form-message" id="rename-category-status" style="display:none"></p>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="rename-category-cancel-btn">Cancel</button>
        <button class="primary-button" type="button" id="rename-category-save-btn">Save</button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");

  const input = overlay.querySelector("#rename-category-input");
  const save = () => confirmRenameCategory(currentName);

  overlay.querySelector("#rename-category-close-btn").addEventListener("click", closeRenameCategoryModal);
  overlay.querySelector("#rename-category-cancel-btn").addEventListener("click", closeRenameCategoryModal);
  overlay.querySelector("#rename-category-save-btn").addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") closeRenameCategoryModal();
  });

  input.focus();
  input.select();
}

function closeRenameCategoryModal() {
  const overlay = document.querySelector("#category-rename-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");

  const listOverlay = document.querySelector("#categories-modal-overlay");
  if (listOverlay) listOverlay.classList.add("is-open");
}

function setRenameCategoryStatus(message, isError = false) {
  const el = document.querySelector("#rename-category-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = isError ? "form-message is-error" : "form-message is-success";
  el.style.display = message ? "" : "none";
}

async function confirmRenameCategory(currentName) {
  const overlay = document.querySelector("#category-rename-modal-overlay");
  const input = overlay && overlay.querySelector("#rename-category-input");
  const newName = input ? input.value.trim() : "";

  if (!newName) {
    setRenameCategoryStatus("Category name cannot be empty.", true);
    return;
  }

  if (newName === currentName) {
    closeRenameCategoryModal();
    return;
  }

  const res = await window.secureLoginVault.categories.rename(currentName, newName);
  if (!res.ok) {
    setRenameCategoryStatus(res.message || "Could not rename category.", true);
    return;
  }

  closeRenameCategoryModal();
  setCategoriesStatus(`Renamed "${currentName}" to "${res.result.name}".`);
  await loadCategoryManageList();
  await refreshCredentials();
}

// ─── Manage Categories: Delete Modal ──────────────────────────────────────────
//
// Also a separate, single-purpose modal. If the category is in use, it shows
// a reassignment picker; otherwise it's a plain confirm. Either way it only
// ever calls the delete API and then asks the List modal to reload.

function getOrCreateDeleteCategoryOverlay() {
  let overlay = document.querySelector("#category-delete-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "category-delete-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

function openDeleteCategoryModal(category, knownCategories) {
  if (!category) return;
  const listOverlay = document.querySelector("#categories-modal-overlay");
  if (listOverlay) listOverlay.classList.remove("is-open");

  const overlay = getOrCreateDeleteCategoryOverlay();
  const inUse = category.credentialCount > 0;
  const safeName = escapeHtml(category.name);

  const reassignSection = inUse
    ? `
      <p class="modal-confirm-text">
        "${safeName}" is used by ${category.credentialCount} credential${category.credentialCount === 1 ? "" : "s"}.
        Choose a category to move ${category.credentialCount === 1 ? "it" : "them"} to before deleting:
      </p>
      <label class="modal-label" for="delete-category-reassign-select">
        <span class="modal-label-text">Reassign to</span>
        <select class="modal-input" id="delete-category-reassign-select">
          ${(knownCategories || [])
            .filter((c) => c.name !== category.name)
            .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`)
            .join("")}
        </select>
      </label>
    `
    : `<p class="modal-confirm-text">Delete the category "${safeName}"? This cannot be undone.</p>`;

  overlay.innerHTML = `
    <div class="modal-container category-subtask-modal-container" role="dialog" aria-modal="true" aria-labelledby="delete-category-heading">
      <div class="modal-header">
        <h2 id="delete-category-heading">Delete Category</h2>
        <button class="modal-close-btn" type="button" id="delete-category-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body">
        ${reassignSection}
        <p class="form-message" id="delete-category-status" style="display:none"></p>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="delete-category-cancel-btn">Cancel</button>
        <button class="primary-button danger-button" type="button" id="delete-category-confirm-btn">
          ${renderTrashIcon()} <span>Delete</span>
        </button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");

  overlay.querySelector("#delete-category-close-btn").addEventListener("click", closeDeleteCategoryModal);
  overlay.querySelector("#delete-category-cancel-btn").addEventListener("click", closeDeleteCategoryModal);
  overlay.querySelector("#delete-category-confirm-btn").addEventListener("click", () => confirmDeleteCategory(category));
}

function closeDeleteCategoryModal() {
  const overlay = document.querySelector("#category-delete-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");

  const listOverlay = document.querySelector("#categories-modal-overlay");
  if (listOverlay) listOverlay.classList.add("is-open");
}

function setDeleteCategoryStatus(message, isError = false) {
  const el = document.querySelector("#delete-category-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = isError ? "form-message is-error" : "form-message is-success";
  el.style.display = message ? "" : "none";
}

async function confirmDeleteCategory(category) {
  const overlay = document.querySelector("#category-delete-modal-overlay");
  const select = overlay && overlay.querySelector("#delete-category-reassign-select");
  const reassignTo = select ? select.value : null;
  const inUse = category.credentialCount > 0;

  if (inUse && !reassignTo) {
    setDeleteCategoryStatus("Choose a category to reassign to.", true);
    return;
  }

  const res = await window.secureLoginVault.categories.remove(category.name, reassignTo || null);
  if (!res.ok) {
    setDeleteCategoryStatus(res.message || "Could not delete category.", true);
    return;
  }

  closeDeleteCategoryModal();
  setCategoriesStatus(
    inUse
      ? `Deleted "${category.name}" and moved its credentials to "${reassignTo}".`
      : `Deleted "${category.name}".`
  );
  await loadCategoryManageList();
  await refreshCredentials();
}

// ─── Manage Groups: List Modal ─────────────────────────────────────────────────
//
// Mirrors the Manage Categories list/rename/delete pattern. Deleting a group
// doesn't require reassignment (unlike categories, which always need a
// fallback) — affected credentials simply become unassigned.

function getOrCreateGroupsOverlay() {
  let overlay = document.querySelector("#groups-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "groups-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

let _groupsModalReopenSettings = false;

async function openManageGroupsModal() {
  const settingsOverlay = document.querySelector("#settings-modal-overlay");
  _groupsModalReopenSettings = Boolean(settingsOverlay && settingsOverlay.classList.contains("is-open"));

  const overlay = getOrCreateGroupsOverlay();
  overlay.innerHTML = `
    <div class="modal-container categories-modal-container" role="dialog" aria-modal="true" aria-labelledby="groups-modal-heading">
      <div class="modal-header">
        <h2 id="groups-modal-heading">Manage Groups</h2>
        <button class="modal-close-btn" type="button" id="groups-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body categories-modal-body">
        <div class="category-add-row">
          <input class="modal-input" type="text" id="new-group-input" placeholder="New group name (e.g. Team A)" maxlength="60" autocomplete="off" />
          <button class="primary-button" type="button" id="add-group-btn">
            ${renderPlusIcon()} <span>Add</span>
          </button>
        </div>
        <p class="form-message" id="groups-status" style="display:none"></p>
        <div class="category-manage-list" id="group-manage-list" aria-label="Groups">
          <div class="category-manage-loading">Loading groups...</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="groups-done-btn">Close</button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");

  overlay.querySelector("#groups-close-btn").addEventListener("click", closeManageGroupsModal);
  overlay.querySelector("#groups-done-btn").addEventListener("click", closeManageGroupsModal);

  const input = overlay.querySelector("#new-group-input");
  overlay.querySelector("#add-group-btn").addEventListener("click", () => runAddGroup());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runAddGroup();
  });

  await loadGroupManageList();
}

function closeManageGroupsModal() {
  const overlay = document.querySelector("#groups-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");

  if (_groupsModalReopenSettings) {
    _groupsModalReopenSettings = false;
    const settingsOverlay = document.querySelector("#settings-modal-overlay");
    if (settingsOverlay) settingsOverlay.classList.add("is-open");
  }

  // The active-group lock or group list may have changed while this modal
  // was open — refresh the settings control and the vault list/banner.
  loadActiveGroupControl();
  refreshCredentials();
}

function setGroupsStatus(message, isError = false) {
  const el = document.querySelector("#groups-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = isError ? "form-message is-error" : "form-message is-success";
  el.style.display = message ? "" : "none";
}

async function loadGroupManageList() {
  const list = document.querySelector("#group-manage-list");
  if (!list) return;

  const res = await window.secureLoginVault.groups.getAllWithUsage();
  if (!res.ok) {
    list.innerHTML = `<div class="category-manage-empty">Could not load groups.</div>`;
    return;
  }

  const groups = res.result;
  if (groups.length === 0) {
    list.innerHTML = `<div class="category-manage-empty">No groups yet. Add one above to get started.</div>`;
  } else {
    list.innerHTML = groups.map((g) => renderGroupManageRow(g)).join("");
  }

  list.querySelectorAll("[data-action='rename-group']").forEach((btn) => {
    btn.addEventListener("click", () => openRenameGroupModal(btn.dataset.name));
  });
  list.querySelectorAll("[data-action='delete-group']").forEach((btn) => {
    const group = groups.find((g) => g.name === btn.dataset.name);
    btn.addEventListener("click", () => openDeleteGroupModal(group));
  });
}

function renderGroupManageRow(group) {
  const safeName = escapeHtml(group.name);
  const countLabel = `${group.credentialCount} credential${group.credentialCount === 1 ? "" : "s"}`;

  return `
    <div class="category-manage-row" data-name="${safeName}">
      <div class="category-manage-info">
        <span class="category-manage-name">${safeName}${group.isActive ? ' <small class="group-badge">Active</small>' : ""}</span>
        <span class="category-manage-count">${countLabel}</span>
      </div>
      <div class="category-manage-actions">
        <button class="icon-button row-action-btn" type="button" data-action="rename-group"
                data-name="${safeName}" title="Rename" aria-label="Rename ${safeName}">
          ${renderEditIcon()}
        </button>
        <button class="icon-button row-action-btn danger-btn" type="button" data-action="delete-group"
                data-name="${safeName}" title="Delete" aria-label="Delete ${safeName}">
          ${renderTrashIcon()}
        </button>
      </div>
    </div>
  `;
}

async function runAddGroup() {
  const input = document.querySelector("#new-group-input");
  const name = input ? input.value.trim() : "";

  if (!name) {
    setGroupsStatus("Enter a group name.", true);
    return;
  }

  const res = await window.secureLoginVault.groups.add(name);
  if (!res.ok) {
    setGroupsStatus(res.message || "Could not add group.", true);
    return;
  }

  input.value = "";
  setGroupsStatus(`Added "${res.result.name}".`);
  await loadGroupManageList();
}

// ─── Manage Groups: Rename Modal ────────────────────────────────────────────────

function getOrCreateRenameGroupOverlay() {
  let overlay = document.querySelector("#group-rename-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "group-rename-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

function openRenameGroupModal(currentName) {
  const listOverlay = document.querySelector("#groups-modal-overlay");
  if (listOverlay) listOverlay.classList.remove("is-open");

  const overlay = getOrCreateRenameGroupOverlay();
  overlay.innerHTML = `
    <div class="modal-container category-subtask-modal-container" role="dialog" aria-modal="true" aria-labelledby="rename-group-heading">
      <div class="modal-header">
        <h2 id="rename-group-heading">Rename Group</h2>
        <button class="modal-close-btn" type="button" id="rename-group-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body">
        <label class="modal-label" for="rename-group-input">
          <span class="modal-label-text">Group name</span>
          <input class="modal-input" type="text" id="rename-group-input" maxlength="60"
                 value="${escapeHtml(currentName)}" />
        </label>
        <p class="form-message" id="rename-group-status" style="display:none"></p>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="rename-group-cancel-btn">Cancel</button>
        <button class="primary-button" type="button" id="rename-group-save-btn">Save</button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");

  const input = overlay.querySelector("#rename-group-input");
  const save = () => confirmRenameGroup(currentName);

  overlay.querySelector("#rename-group-close-btn").addEventListener("click", closeRenameGroupModal);
  overlay.querySelector("#rename-group-cancel-btn").addEventListener("click", closeRenameGroupModal);
  overlay.querySelector("#rename-group-save-btn").addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") closeRenameGroupModal();
  });

  input.focus();
  input.select();
}

function closeRenameGroupModal() {
  const overlay = document.querySelector("#group-rename-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");

  const listOverlay = document.querySelector("#groups-modal-overlay");
  if (listOverlay) listOverlay.classList.add("is-open");
}

function setRenameGroupStatus(message, isError = false) {
  const el = document.querySelector("#rename-group-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = isError ? "form-message is-error" : "form-message is-success";
  el.style.display = message ? "" : "none";
}

async function confirmRenameGroup(currentName) {
  const overlay = document.querySelector("#group-rename-modal-overlay");
  const input = overlay && overlay.querySelector("#rename-group-input");
  const newName = input ? input.value.trim() : "";

  if (!newName) {
    setRenameGroupStatus("Group name cannot be empty.", true);
    return;
  }

  if (newName === currentName) {
    closeRenameGroupModal();
    return;
  }

  const res = await window.secureLoginVault.groups.rename(currentName, newName);
  if (!res.ok) {
    setRenameGroupStatus(res.message || "Could not rename group.", true);
    return;
  }

  closeRenameGroupModal();
  setGroupsStatus(`Renamed "${currentName}" to "${res.result.name}".`);
  await loadGroupManageList();
}

// ─── Manage Groups: Delete Modal ────────────────────────────────────────────────

function getOrCreateDeleteGroupOverlay() {
  let overlay = document.querySelector("#group-delete-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "group-delete-modal-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

function openDeleteGroupModal(group) {
  if (!group) return;
  const listOverlay = document.querySelector("#groups-modal-overlay");
  if (listOverlay) listOverlay.classList.remove("is-open");

  const overlay = getOrCreateDeleteGroupOverlay();
  const inUse = group.credentialCount > 0;
  const safeName = escapeHtml(group.name);

  const bodyText = inUse
    ? `<p class="modal-confirm-text">
        "${safeName}" is used by ${group.credentialCount} credential${group.credentialCount === 1 ? "" : "s"}.
        Deleting it will leave ${group.credentialCount === 1 ? "that credential" : "those credentials"} unassigned
        (visible only when no group is active). This cannot be undone.
      </p>`
    : `<p class="modal-confirm-text">Delete the group "${safeName}"? This cannot be undone.</p>`;

  overlay.innerHTML = `
    <div class="modal-container category-subtask-modal-container" role="dialog" aria-modal="true" aria-labelledby="delete-group-heading">
      <div class="modal-header">
        <h2 id="delete-group-heading">Delete Group</h2>
        <button class="modal-close-btn" type="button" id="delete-group-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body">
        ${bodyText}
        <p class="form-message" id="delete-group-status" style="display:none"></p>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="delete-group-cancel-btn">Cancel</button>
        <button class="primary-button danger-button" type="button" id="delete-group-confirm-btn">
          ${renderTrashIcon()} <span>Delete</span>
        </button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");

  overlay.querySelector("#delete-group-close-btn").addEventListener("click", closeDeleteGroupModal);
  overlay.querySelector("#delete-group-cancel-btn").addEventListener("click", closeDeleteGroupModal);
  overlay.querySelector("#delete-group-confirm-btn").addEventListener("click", () => confirmDeleteGroup(group));
}

function closeDeleteGroupModal() {
  const overlay = document.querySelector("#group-delete-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");

  const listOverlay = document.querySelector("#groups-modal-overlay");
  if (listOverlay) listOverlay.classList.add("is-open");
}

function setDeleteGroupStatus(message, isError = false) {
  const el = document.querySelector("#delete-group-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = isError ? "form-message is-error" : "form-message is-success";
  el.style.display = message ? "" : "none";
}

async function confirmDeleteGroup(group) {
  const res = await window.secureLoginVault.groups.remove(group.name);
  if (!res.ok) {
    setDeleteGroupStatus(res.message || "Could not delete group.", true);
    return;
  }

  closeDeleteGroupModal();
  setGroupsStatus(`Deleted "${group.name}".`);
  await loadGroupManageList();
}

function setSettingsStatus(message, isError = false) {
  const el = document.querySelector("#settings-status");
  if (!el) return;
  el.textContent = message;
  el.className = isError ? "form-message is-error" : "form-message";
  el.style.display = message ? "" : "none";
}

function setSettingsButtonsDisabled(disabled) {
  document
    .querySelectorAll("#settings-modal-overlay .settings-action-btn")
    .forEach((btn) => (btn.disabled = disabled));
}

// ── Change Master Password flow ────────────────────────────────────────────────

async function runChangeMasterPassword() {
  const overlay      = document.querySelector("#settings-modal-overlay");
  const currentInput = overlay.querySelector("#cpw-current");
  const newInput     = overlay.querySelector("#cpw-new");
  const confirmInput = overlay.querySelector("#cpw-confirm");
  const statusEl     = overlay.querySelector("#cpw-status");
  const submitBtn    = overlay.querySelector("#cpw-submit-btn");

  function showCpwStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = isError ? "form-message is-error" : "form-message is-success";
    statusEl.style.display = msg ? "" : "none";
  }

  showCpwStatus("", false);

  const payload = {
    currentPassword: currentInput.value,
    newPassword:     newInput.value,
    confirmPassword: confirmInput.value
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Changing...";

  const res = await window.secureLoginVault.settings.changeMasterPassword(payload);

  submitBtn.disabled = false;
  submitBtn.textContent = "Change Password";

  if (!res.ok) {
    showCpwStatus(res.message || "Could not change password.", true);
    return;
  }

  currentInput.value = "";
  newInput.value     = "";
  confirmInput.value = "";
  showCpwStatus("Master password changed successfully.", false);
  showToast("Master password changed", "info");
}

// ─── Phase 9: Import ───────────────────────────────────────────────────────────

async function runImportFlow(formatKind, triggerBtn) {
  setSettingsStatus("");
  const picked = await window.secureLoginVault.importExport.pickImportFile();

  if (!picked.ok) {
    setSettingsStatus(picked.message, true);
    return;
  }
  if (picked.result.canceled) return;

  let rows;
  try {
    rows = parseImportFile(formatKind, picked.result.content, picked.result.fileName);
  } catch (err) {
    setSettingsStatus(err.message || "Could not read that file.", true);
    return;
  }

  if (!rows.length) {
    setSettingsStatus("No importable rows were found in that file.", true);
    return;
  }

  await openImportModeModal(rows, triggerBtn);
}

// Lets the user choose how the parsed rows should land: Merge (add alongside
// whatever already exists — safe, but re-importing the same file repeatedly
// piles up duplicates) or Replace (clear out existing credentials in the
// group(s) this file contains first, then insert — for the "re-sync this
// group from another device" case). Replace never touches any group that
// isn't actually present in the file.
async function openImportModeModal(rows, triggerBtn) {
  const groupKeys = Array.from(new Set(rows.map((r) => (r.groupName || "").trim())));
  const groupLabels = groupKeys.map((g) => (g ? g : "Unassigned"));

  const existingRes = await window.secureLoginVault.credentials.getAllForExport();
  const existing = existingRes.ok ? existingRes.result : [];
  const existingCount = existing.filter((c) => groupKeys.includes((c.groupName || "").trim())).length;

  const overlay = getOrCreateImportModeOverlay();
  overlay.innerHTML = `
    <div class="modal-container import-mode-container" role="dialog" aria-modal="true" aria-labelledby="import-mode-heading">
      <div class="modal-header">
        <h2 id="import-mode-heading">Import ${rows.length} Credential${rows.length === 1 ? "" : "s"}</h2>
        <button class="modal-close-btn" type="button" id="import-mode-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body">
        <p class="modal-hint">
          This file contains: <strong>${groupLabels.map(escapeHtml).join(", ")}</strong>.
          ${existingCount > 0
            ? `You already have <strong>${existingCount}</strong> credential${existingCount === 1 ? "" : "s"} in ${groupLabels.length === 1 ? "that group" : "those groups"}.`
            : `You don't have any existing credentials in ${groupLabels.length === 1 ? "that group" : "those groups"} yet.`}
        </p>
        <div class="import-mode-options">
          <button type="button" class="secondary-button import-mode-btn" id="import-mode-merge-btn">
            <strong>Merge</strong>
            <span>Add these ${rows.length} alongside what's already there.</span>
          </button>
          <button type="button" class="danger-button import-mode-btn" id="import-mode-replace-btn" ${existingCount === 0 ? "disabled" : ""}>
            <strong>Replace</strong>
            <span>Delete the ${existingCount} existing credential${existingCount === 1 ? "" : "s"} in ${groupLabels.length === 1 ? "that group" : "those groups"} first, then import. Cannot be undone.</span>
          </button>
        </div>
      </div>
    </div>
  `;
  overlay.classList.add("is-open");

  const close = () => overlay.classList.remove("is-open");
  overlay.querySelector("#import-mode-close-btn").addEventListener("click", close);
  overlay.querySelector("#import-mode-merge-btn").addEventListener("click", () => {
    close();
    performImport(rows, triggerBtn, { replace: false, groupKeys: [] });
  });
  overlay.querySelector("#import-mode-replace-btn").addEventListener("click", () => {
    close();
    performImport(rows, triggerBtn, { replace: true, groupKeys });
  });
}

function getOrCreateImportModeOverlay() {
  let overlay = document.querySelector("#import-mode-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "import-mode-overlay";
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
  }
  return overlay;
}

async function performImport(rows, triggerBtn, { replace, groupKeys }) {
  setSettingsButtonsDisabled(true);
  const originalLabel = triggerBtn.innerHTML;
  triggerBtn.innerHTML = `<span>Importing...</span>`;

  let deleted = 0;
  if (replace && groupKeys.length > 0) {
    const delRes = await window.secureLoginVault.credentials.removeByGroups(groupKeys);
    if (delRes.ok) deleted = delRes.result.deleted;
  }

  let imported = 0;
  let failed = 0;
  const failedNames = [];

  for (const row of rows) {
    const res = await window.secureLoginVault.credentials.add(row);
    if (res.ok) {
      imported++;
    } else {
      failed++;
      failedNames.push(row.websiteName || "(unnamed)");
    }
  }

  setSettingsButtonsDisabled(false);
  triggerBtn.innerHTML = originalLabel;

  const deletedNote = replace ? `Replaced ${deleted} existing. ` : "";
  const summary = failed
    ? `${deletedNote}Imported ${imported} of ${rows.length}. ${failed} failed: ${failedNames.slice(0, 5).join(", ")}${failedNames.length > 5 ? "..." : ""}`
    : `${deletedNote}Imported ${imported} credential${imported === 1 ? "" : "s"} successfully.`;

  setSettingsStatus(summary, Boolean(failed));
  showToast(failed ? "Import finished with some errors" : "Import complete", failed ? "error" : "info");
  refreshCredentials();
}

function parseImportFile(formatKind, content, fileName) {
  if (formatKind === "json") return parseJsonImport(content);
  if (formatKind === "csv") return parseCsvImport(content, mapStandardCsvRow);
  if (formatKind === "keepass") return parseCsvImport(content, mapKeePassCsvRow);
  throw new Error(`Unsupported import format: ${formatKind}`);
}

function parseJsonImport(content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error("That file is not valid JSON.");
  }

  const list = Array.isArray(data) ? data : Array.isArray(data.credentials) ? data.credentials : null;
  if (!list) throw new Error("JSON file must contain an array of credentials.");

  return list
    .map((item) => ({
      websiteName: String(item.websiteName || item.website_name || item.name || "").trim(),
      websiteUrl: String(item.websiteUrl || item.website_url || item.url || "").trim(),
      category: String(item.category || "Other").trim() || "Other",
      username: String(item.username || "").trim(),
      email: String(item.email || "").trim(),
      password: String(item.password || ""),
      tags: String(item.tags || "").trim(),
      groupName: String(item.groupName || item.group_name || item.clientGroup || "").trim(),
      notes: String(item.notes || "").trim(),
      qrCode: String(item.qrCode || item.qr_code || ""),
      favorite: Boolean(item.favorite)
    }))
    .filter((row) => row.websiteName && row.password);
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes
// ("" inside a quoted field), commas/newlines inside quotes, and CRLF/LF.
function parseCsvRows(content) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const text = content.replace(/^\uFEFF/, ""); // strip BOM if present

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // swallow; \n (if present) handles the row break
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function parseCsvImport(content, mapRowFn) {
  const rows = parseCsvRows(content);
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const dataRows = rows.slice(1);

  return dataRows
    .map((cells) => {
      const record = {};
      header.forEach((key, idx) => (record[key] = (cells[idx] || "").trim()));
      return mapRowFn(record);
    })
    .filter((row) => row.websiteName && row.password);
}

// Maps a CSV exported by this app (or a similarly-shaped generic CSV).
function mapStandardCsvRow(record) {
  return {
    websiteName: record["website name"] || record["website_name"] || record["website"] || record["name"] || "",
    websiteUrl: record["website url"] || record["website_url"] || record["url"] || "",
    category: record["category"] || "Other",
    username: record["username"] || "",
    email: record["email"] || "",
    password: record["password"] || "",
    tags: record["tags"] || "",
    groupName: record["group"] || "",
    notes: record["notes"] || "",
    favorite: ["1", "true", "yes"].includes((record["favorite"] || "").toLowerCase())
  };
}

// Maps KeePass's standard CSV export columns:
// "Group","Title","Username","Password","URL","Notes"
function mapKeePassCsvRow(record) {
  const group = record["group"] || "";
  const category = group.split(/[\\/]/).filter(Boolean).pop() || "Other";

  return {
    websiteName: record["title"] || record["account"] || "",
    websiteUrl: record["url"] || "",
    category,
    username: record["username"] || record["user name"] || "",
    email: "",
    password: record["password"] || "",
    tags: "",
    notes: record["notes"] || "",
    favorite: false
  };
}

// ─── Phase 9: Export ───────────────────────────────────────────────────────────

async function runExportFlow(formatKind, triggerBtn) {
  setSettingsStatus("");

  if (formatKind === "backup") {
    await runBackupExport(triggerBtn);
    return;
  }

  const allRes = await window.secureLoginVault.credentials.getAllForExport();
  if (!allRes.ok) {
    setSettingsStatus(allRes.message, true);
    return;
  }

  const credentials = allRes.result;
  const stamp = new Date().toISOString().slice(0, 10);
  const defaultName = `secure-login-vault-export-${stamp}.${formatKind}`;

  const picked = await window.secureLoginVault.importExport.pickExportPath({
    defaultName,
    format: formatKind
  });
  if (!picked.ok) {
    setSettingsStatus(picked.message, true);
    return;
  }
  if (picked.result.canceled) return;

  const content = formatKind === "json" ? buildJsonExport(credentials) : buildCsvExport(credentials);

  setSettingsButtonsDisabled(true);
  const writeRes = await window.secureLoginVault.importExport.writeExportFile({
    filePath: picked.result.filePath,
    content
  });
  setSettingsButtonsDisabled(false);

  if (!writeRes.ok) {
    setSettingsStatus(writeRes.message, true);
    return;
  }

  setSettingsStatus(`Exported ${credentials.length} credential${credentials.length === 1 ? "" : "s"} to ${picked.result.filePath}.`);
  showToast("Export complete", "info");
}

// Includes every field (via ...rest), so the qrCode data URI rides along
// automatically — JSON has no practical size limit for it.
function buildJsonExport(credentials) {
  const payload = {
    format: "secure-login-vault-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    credentials: credentials.map(({ id, ...rest }) => rest)
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// CSV deliberately excludes qrCode (unlike JSON above): a QR data URI can
// run past Excel/Sheets' per-cell character limit, and would make an
// already-plain-text CSV export even riskier to casually open. Use JSON
// (or the encrypted backup) to carry 2FA QR codes between vaults.

function buildCsvExport(credentials) {
  const headers = [
    "Website Name", "Website URL", "Category", "Username",
    "Email", "Password", "Tags", "Group", "Notes", "Favorite"
  ];
  const lines = [headers.map(csvEscape).join(",")];

  for (const c of credentials) {
    lines.push(
      [
        c.websiteName, c.websiteUrl, c.category, c.username,
        c.email, c.password, c.tags, c.groupName, c.notes, c.favorite ? "true" : "false"
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  return `${lines.join("\r\n")}\r\n`;
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function runBackupExport(triggerBtn) {
  const stamp      = new Date().toISOString().slice(0, 10);
  const fileName   = `secure-login-vault-backup-${stamp}.slvbackup`;
  const savedFolder = getPref(PREF_BACKUP_FOLDER, "");
  // If the user has set a default folder, pre-fill the save dialog with it.
  // The path separator is normalised to forward-slash for Electron's dialog.
  const defaultName = savedFolder
    ? `${savedFolder.replace(/\\/g, "/")}/${fileName}`
    : fileName;

  const picked = await window.secureLoginVault.importExport.pickExportPath({
    defaultName,
    format: "backup"
  });
  if (!picked.ok) {
    setSettingsStatus(picked.message, true);
    return;
  }
  if (picked.result.canceled) return;

  setSettingsButtonsDisabled(true);
  const res = await window.secureLoginVault.importExport.createBackup({
    filePath: picked.result.filePath
  });
  setSettingsButtonsDisabled(false);

  if (!res.ok) {
    setSettingsStatus(res.message, true);
    return;
  }

  setSettingsStatus(`Encrypted backup saved to ${res.result.filePath}.`);
  showToast("Encrypted backup created", "info");
}

// ─── Phase 9: Restore ──────────────────────────────────────────────────────────

async function runRestoreFlow() {
  setSettingsStatus("");

  const picked = await window.secureLoginVault.importExport.pickRestoreFile();
  if (!picked.ok) {
    setSettingsStatus(picked.message, true);
    return;
  }
  if (picked.result.canceled) return;

  // Show a proper modal to confirm + collect master password
  const result = await showRestorePasswordModal();
  if (!result) return; // user cancelled

  setSettingsButtonsDisabled(true);
  const res = await window.secureLoginVault.importExport.restoreBackup({
    filePath: picked.result.filePath,
    masterPassword: result
  });
  setSettingsButtonsDisabled(false);

  if (!res.ok) {
    setSettingsStatus(res.message, true);
    return;
  }

  setSettingsStatus("Backup restored. Reloading...");
  showToast("Vault restored from backup", "info");
  setTimeout(() => window.location.reload(), 900);
}

// Returns the entered password string, or null if cancelled
function showRestorePasswordModal() {
  return new Promise((resolve) => {
    // Remove any existing instance
    document.querySelector("#restore-pw-modal-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "restore-pw-modal-overlay";
    overlay.className = "modal-overlay is-open";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "restore-pw-heading");

    overlay.innerHTML = `
      <div class="modal-container restore-pw-modal-container">
        <div class="modal-header">
          <h2 id="restore-pw-heading">Restore from Backup</h2>
          <button class="modal-close-btn" type="button" id="restore-pw-close-btn" title="Close">
            ${renderCloseIcon()}
          </button>
        </div>
        <div class="modal-body">
          <p class="modal-confirm-text">
            Enter the master password that was used to create this backup.
            This will replace everything currently in your vault and cannot be undone.
          </p>
          <div class="settings-input-wrap" style="margin-bottom: 10px;">
            <input class="settings-input" type="password" id="restore-pw-input"
                   autocomplete="current-password" placeholder="Backup master password" />
            <button class="settings-eye-btn" type="button" id="restore-pw-eye" aria-label="Show/Hide">
              ${renderEyeIcon()}
            </button>
          </div>
          <p class="form-message" id="restore-pw-error" style="display:none; color: var(--danger);"></p>
        </div>
        <div class="modal-footer">
          <button class="secondary-button" type="button" id="restore-pw-cancel-btn">Cancel</button>
          <button class="primary-button" type="button" id="restore-pw-confirm-btn">Restore</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector("#restore-pw-input");
    const errorEl = overlay.querySelector("#restore-pw-error");
    const eyeBtn = overlay.querySelector("#restore-pw-eye");

    // Eye toggle
    eyeBtn.addEventListener("click", () => {
      const isVisible = input.type === "text";
      input.type = isVisible ? "password" : "text";
      eyeBtn.innerHTML = isVisible ? renderEyeIcon() : renderEyeOffIcon();
    });

    function close(value) {
      overlay.remove();
      resolve(value);
    }

    overlay.querySelector("#restore-pw-close-btn").addEventListener("click", () => close(null));
    overlay.querySelector("#restore-pw-cancel-btn").addEventListener("click", () => close(null));
    overlay.querySelector("#restore-pw-confirm-btn").addEventListener("click", () => {
      const pw = input.value;
      if (!pw) {
        errorEl.textContent = "Please enter the backup master password.";
        errorEl.style.display = "";
        return;
      }
      close(pw);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") overlay.querySelector("#restore-pw-confirm-btn").click();
      if (e.key === "Escape") close(null);
    });

    // Focus the input
    setTimeout(() => input.focus(), 50);
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function highlightMatch(text, query) {
  const safe = escapeHtml(String(text || ""));
  if (!query || !query.trim()) return safe;
  const escaped = escapeHtml(query.trim()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  return safe.replace(re, `<mark class="search-highlight">$1</mark>`);
}

function updateStatus(_state) { /* status grid removed in Phase 11 polish */ }

function setBusy(button, message, text) {
  button.disabled = true;
  button.dataset.label = button.textContent;
  button.textContent = text;
  showMessage(message, "", false);
}

function setIdle(button) {
  button.disabled = false;
  button.textContent = button.dataset.label;
}

function showMessage(element, text, isError) {
  element.textContent = text;
  element.classList.toggle("is-error", isError);
}

function renderError(message) {
  const authCard = getAuthCard();
  authCard.innerHTML = `<p class="form-message is-error" role="alert">${message}</p>`;
  document.body.classList.add("app-ready");
}

function getAuthCard() {
  return document.querySelector("#auth-card");
}

function getPasswordStrength(password) {
  if (!password) {
    return { label: "Empty", level: "empty", percent: 0 };
  }

  let score = 0;

  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  const levels = [
    { label: "Weak", level: "weak", percent: 25 },
    { label: "Fair", level: "fair", percent: 45 },
    { label: "Good", level: "good", percent: 70 },
    { label: "Strong", level: "strong", percent: 100 }
  ];

  if (score <= 1) return levels[0];
  if (score === 2) return levels[1];
  if (score === 3) return levels[2];
  return levels[3];
}

function hasPasswordVariety(password) {
  const hasLetters = /[A-Za-z]/.test(password);
  const hasNumbersOrSymbols = /[^A-Za-z]/.test(password);
  return hasLetters && hasNumbersOrSymbols;
}

function formatDateTime(value) {
  if (!value) {
    return "Current session";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

// ─── Password Generator ───────────────────────────────────────────────────────

function setupPasswordGenerator(container) {
  const toggleBtn   = container.querySelector("#gen-toggle-btn");
  const genBody     = container.querySelector("#gen-body");
  const lengthInput = container.querySelector("#gen-length");
  const lengthVal   = container.querySelector("#gen-length-val");
  const generateBtn = container.querySelector("#gen-generate-btn");
  const copyBtn     = container.querySelector("#gen-copy-btn");
  const useBtn      = container.querySelector("#gen-use-btn");
  const preview     = container.querySelector("#gen-preview");
  const strengthBar = container.querySelector("#gen-strength-bar");
  const strengthLbl = container.querySelector("#gen-strength-label");
  const passwordInput = container.querySelector("#m-password");

  let isOpen = false;
  let lastGenerated = "";

  // Null guard — if any element is missing, bail out silently
  if (!toggleBtn || !genBody || !lengthInput || !generateBtn) {
    console.warn("[SLV] Password generator elements not found in container");
    return;
  }

  // Toggle open/close
  toggleBtn.addEventListener("click", () => {
    isOpen = !isOpen;
    genBody.classList.toggle("is-open", isOpen);
    toggleBtn.classList.toggle("is-open", isOpen);
    if (isOpen && !lastGenerated) generate();
  });

  // Sync isOpen state with the HTML (gen-body starts open via class in template)
  isOpen = true;

  // Defer the first generate() so the modal is fully painted before
  // we update strengthBar.style.width — otherwise the CSS transition
  // fires on a not-yet-visible element and the bar stays at 0.
  requestAnimationFrame(() => requestAnimationFrame(() => generate()));

  // Length slider
  lengthInput.addEventListener("input", () => {
    lengthVal.textContent = lengthInput.value;
    if (isOpen) generate();
  });

  // Checkboxes — regenerate on change
  ["gen-upper", "gen-lower", "gen-numbers", "gen-symbols", "gen-exclude-similar"].forEach((id) => {
    container.querySelector(`#${id}`).addEventListener("change", () => {
      if (isOpen) generate();
    });
  });

  // Generate button
  generateBtn.addEventListener("click", generate);

  // Copy button
  copyBtn.addEventListener("click", () => {
    if (!lastGenerated) return;
    copyToClipboard(lastGenerated, "Password copied!", copyBtn, false);
  });

  // Use button — puts generated password into the password field
  useBtn.addEventListener("click", () => {
    if (!lastGenerated) return;
    passwordInput.value = lastGenerated;
    // Show the password so user can see what was inserted
    passwordInput.type = "text";
    const toggle = container.querySelector(".password-toggle");
    if (toggle) {
      toggle.dataset.visible = "true";
      toggle.setAttribute("aria-label", "Hide Password");
      toggle.innerHTML = renderEyeOffIcon();
    }
    // Flash the field
    passwordInput.classList.add("is-filled");
    setTimeout(() => passwordInput.classList.remove("is-filled"), 600);
  });

  function generate() {
    const length  = Number(lengthInput.value);
    const upper   = container.querySelector("#gen-upper").checked;
    const lower   = container.querySelector("#gen-lower").checked;
    const numbers = container.querySelector("#gen-numbers").checked;
    const symbols = container.querySelector("#gen-symbols").checked;
    const noSimilar = container.querySelector("#gen-exclude-similar").checked;

    const password = generatePassword({ length, upper, lower, numbers, symbols, noSimilar });
    lastGenerated = password;

    preview.textContent = password || "Select at least one character type";

    const strength = getPasswordStrength(password);
    const pct = strength.percent;
    strengthBar.style.width = `${pct}%`;
    strengthBar.dataset.level = strength.level;
    strengthLbl.textContent = strength.label;
  }
}

function generatePassword({ length, upper, lower, numbers, symbols, noSimilar }) {
  let chars = "";
  const UPPER   = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const UPPER_F = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const LOWER   = "abcdefghjkmnpqrstuvwxyz";
  const LOWER_F = "abcdefghijklmnopqrstuvwxyz";
  const NUMS    = "23456789";
  const NUMS_F  = "0123456789";
  const SYMS    = "!@#$%^&*()-_=+[]{}|;:,.<>?";

  if (upper)   chars += noSimilar ? UPPER   : UPPER_F;
  if (lower)   chars += noSimilar ? LOWER   : LOWER_F;
  if (numbers) chars += noSimilar ? NUMS    : NUMS_F;
  if (symbols) chars += SYMS;

  if (!chars) return "";

  // Guarantee at least one character from each selected set
  const required = [];
  if (upper)   required.push(pickRandom(noSimilar ? UPPER   : UPPER_F));
  if (lower)   required.push(pickRandom(noSimilar ? LOWER   : LOWER_F));
  if (numbers) required.push(pickRandom(noSimilar ? NUMS    : NUMS_F));
  if (symbols) required.push(pickRandom(SYMS));

  const remaining = length - required.length;
  const result = [...required];
  for (let i = 0; i < remaining; i++) {
    result.push(pickRandom(chars));
  }

  // Shuffle using crypto random values
  for (let i = result.length - 1; i > 0; i--) {
    const j = cryptoRandInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result.join("");
}

function pickRandom(str) {
  return str[cryptoRandInt(str.length)];
}

function cryptoRandInt(max) {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] % max;
}

// ─── Icons ────────────────────────────────────────────────────────────────────

// ─── Help & FAQ Modal ─────────────────────────────────────────────────────────
//
// A single scrollable modal grouped into sections, each containing
// accordion-style question/answer items. Content is static (no DB calls),
// built fresh every time the modal opens so search/expand state always
// starts clean. Follows the same overlay/container/header/body/footer
// pattern as the Settings and Manage Categories modals.

const FAQ_SECTIONS = [
  {
    title: "Getting Started",
    items: [
      {
        q: "What is my master password, and why do I need it every time?",
        a: "Your master password is the one key that unlocks your entire vault. " +
           "Secure Login Vault doesn't store it anywhere — it's used to unlock the " +
           "encryption on your data each time you open the app. That's exactly why " +
           "it needs to be entered every session: there's no \"behind the scenes\" " +
           "copy of it for the app to check against."
      },
      {
        q: "I forgot my master password. Can you recover it for me?",
        a: "No — and this is by design. Your master password is never saved anywhere, " +
           "not even in a hidden or hashed form that could be reversed. If it's lost, " +
           "the credentials in that vault can't be recovered either. The best " +
           "protection against this is keeping a written copy somewhere safe (like a " +
           "physical safe or a separate password manager) and making regular " +
           "encrypted backups, which still require the password to restore but at " +
           "least protect you from a corrupted database file."
      },
      {
        q: "Why does the app say \"At least 12 characters\" when creating a password?",
        a: "Both your master password and any change to it require a minimum length " +
           "of 12 characters. Short passwords are far easier to guess or crack, and " +
           "since this single password protects everything in your vault, it's worth " +
           "making it long and memorable rather than short and complex."
      }
    ]
  },
  {
    title: "Security & Encryption",
    items: [
      {
        q: "How is my data actually protected?",
        a: "Everything is protected in layers. Your master password is never stored — " +
           "instead, the app keeps a one-way scrambled version of it (so it can " +
           "check you typed the right one, without ever knowing the original). A " +
           "separate, slower scrambling process turns your password into the actual " +
           "encryption key, and that key locks your entire credential database using " +
           "a strong, modern encryption standard (AES-256 — the same level of " +
           "encryption used by banks and governments). Without the right master " +
           "password, the stored data is unreadable noise."
      },
      {
        q: "Is anything ever stored as plain, readable text?",
        a: "No. Website passwords, your master password, and the encryption key " +
           "itself are never written to disk in readable form. The only things you " +
           "can read without unlocking the vault are non-sensitive details like the " +
           "app version and where the vault file lives on your computer."
      },
      {
        q: "Does the app connect to the internet or send my data anywhere?",
        a: "No. Secure Login Vault is built to work fully offline. Your vault file " +
           "lives only on your computer, and nothing is uploaded, synced, or sent to " +
           "any server. The only network-style actions are ones you trigger yourself, " +
           "like opening a saved website link in your browser."
      },
      {
        q: "What happens if someone copies my vault file?",
        a: "Having the file alone isn't enough — it's encrypted, so without your " +
           "master password it can't be opened or read. That said, treat the vault " +
           "file (and any backups) the way you'd treat a physical key: don't leave " +
           "copies somewhere a stranger could grab them, and don't email it to " +
           "yourself over an unsecured connection."
      },
      {
        q: "Why does the app lock itself after a while?",
        a: "That's Auto-Lock, found in Settings → Security. If you step away from " +
           "your computer with the vault open, anyone who sits down could see your " +
           "credentials. After your chosen period of inactivity (5, 10, 30 minutes, " +
           "1 hour, or never), the app automatically locks and asks for your master " +
           "password again."
      },
      {
        q: "Why did my copied password disappear from my clipboard?",
        a: "That's intentional — it's the Clipboard Auto-Clear setting. After you " +
           "copy a password, the app wipes it from your clipboard a short time later " +
           "(15s, 30s, or 1 minute, configurable in Settings → Security) so it " +
           "doesn't linger somewhere another app could accidentally read it. If you " +
           "need more time, paste it right after copying, or increase the timeout " +
           "in Settings."
      }
    ]
  },
  {
    title: "Backup & Restore",
    items: [
      {
        q: "What's the difference between an Encrypted Backup, CSV, and JSON export?",
        a: "An Encrypted Backup (.slvbackup) is a full, password-protected snapshot " +
           "of your vault — the safest way to back things up, since it stays " +
           "encrypted the whole time. CSV and JSON exports are plain, readable files " +
           "useful for moving data into a spreadsheet or another tool, but they are " +
           "NOT encrypted, so anyone who opens that file can read your saved " +
           "credentials. Use CSV/JSON only for migration, and delete the file " +
           "afterward."
      },
      {
        q: "Where do my backups get saved?",
        a: "By default, you'll be asked where to save each backup. You can set a " +
           "default backup folder in Settings → Security so it's quicker next time. " +
           "Either way, it's worth keeping a copy somewhere other than your main " +
           "hard drive too — like a USB drive or external storage — in case your " +
           "computer is lost, stolen, or fails."
      },
      {
        q: "What happens if I restore a backup?",
        a: "Restoring completely replaces everything currently in your vault with " +
           "what's in the backup file. Anything added since that backup was made " +
           "will be lost. This can't be undone, so if you're unsure, export your " +
           "current vault first before restoring an older one."
      },
      {
        q: "Do I need my master password to restore a backup?",
        a: "Yes — an encrypted backup was locked with a master password at the time " +
           "it was made, and you'll need that same password to unlock and restore it."
      }
    ]
  },
  {
    title: "Import & Export",
    items: [
      {
        q: "What can I import into my vault?",
        a: "You can bring in credentials from a CSV file, a JSON file, or a CSV " +
           "exported from KeePass. The app reads the file, matches up the columns, " +
           "and adds the credentials to your vault."
      },
      {
        q: "Will importing create duplicates if I run it twice?",
        a: "Each import adds new credential entries — it doesn't automatically check " +
           "whether a similar entry already exists. If you accidentally import the " +
           "same file twice, you may end up with duplicates that you'll need to " +
           "remove manually. It's a good habit to double-check before re-importing " +
           "a file."
      },
      {
        q: "Is it safe to export to CSV or JSON?",
        a: "The export itself is safe, but the resulting file is not encrypted — " +
           "anyone who opens it can read every password in plain text. Only export " +
           "to CSV/JSON when you genuinely need to (like moving to a new tool), " +
           "store the file somewhere secure in the meantime, and delete it once " +
           "you're done."
      }
    ]
  },
  {
    title: "Everyday Use",
    items: [
      {
        q: "How do I organize my credentials?",
        a: "Use Categories (like WordPress, Hosting, or Email) to group similar " +
           "logins, and Favorites to pin the ones you use most so they show up at " +
           "the top. You can manage your category list anytime from Settings → " +
           "Categories — add new ones, rename them, or delete ones you no longer " +
           "need."
      },
      {
        q: "Why don't I see copy/edit/delete buttons on a credential until I hover over it?",
        a: "That's intentional — it keeps the list clean and readable instead of " +
           "crowding every row with icons all the time. Move your mouse over a " +
           "credential row (or over the username/password field specifically) and " +
           "the relevant action buttons fade into view. On a touchscreen or " +
           "trackpad, tapping the row works the same way."
      },
      {
        q: "What does the search bar actually search through?",
        a: "Typing in the search bar searches across website name, URL, username, " +
           "email, notes, tags, and category all at once, and it's case-insensitive " +
           "— so you don't need to remember the exact spelling or capitalization."
      },
      {
        q: "Can I change my master password without losing my saved logins?",
        a: "Yes. Settings → Security → Change Master Password re-locks your vault " +
           "with the new password without ever exposing your stored credentials in " +
           "the process. You'll need to confirm your current password first."
      },
      {
        q: "Can I move my vault file to a different folder or drive?",
        a: "Yes, the database location can be changed from Settings. The app copies " +
           "the vault to the new location, verifies the copy is intact, and only " +
           "then removes the original — so you're never left without a working " +
           "copy mid-move."
      }
    ]
  },
  {
    title: "Troubleshooting",
    items: [
      {
        q: "The app won't accept my master password, but I'm sure it's correct.",
        a: "Double-check Caps Lock and your keyboard layout, since the password " +
           "field doesn't reveal typos. If you're using the Show/Hide password " +
           "toggle, confirm what's actually typed matches what you intended. As a " +
           "security measure, there's no \"forgot password\" option, so if the " +
           "password genuinely doesn't work, your only path back in is restoring " +
           "from a backup made with a password you do remember."
      },
      {
        q: "Something in the app looks visually off — a button or icon in the wrong place.",
        a: "Try closing and reopening the relevant screen, since most display " +
           "glitches clear up when a panel is rebuilt. If it persists, restarting " +
           "the app usually resolves it. This doesn't affect the safety of your " +
           "encrypted data — it's strictly cosmetic."
      },
      {
        q: "My import didn't bring in all my credentials.",
        a: "This is usually a formatting issue in the source file — an unexpected " +
           "column order, missing headers, or a few accidental quote marks or " +
           "commas inside a field. Try opening the file in a spreadsheet program " +
           "first to check that rows look clean and consistent before importing " +
           "again."
      },
      {
        q: "Opening a website from the app doesn't open my browser.",
        a: "The app hands the link off to whatever browser is set as your " +
           "computer's default. If nothing opens, check your system's default " +
           "browser setting, and make sure the saved URL is a complete, valid " +
           "address (for example, starting with https://)."
      }
    ]
  }
];

function getOrCreateHelpOverlay() {
  let overlay = document.querySelector("#help-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "help-modal-overlay";
    overlay.className = "modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "help-modal-heading");
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeHelpModal();
    });
  }
  return overlay;
}

// Tracks whether Settings was open when Help was launched, so closing Help
// can restore it — same pattern used by the Manage Categories modal.
let _helpModalReopenSettings = false;

function openHelpModal() {
  const settingsOverlay = document.querySelector("#settings-modal-overlay");
  _helpModalReopenSettings = Boolean(settingsOverlay && settingsOverlay.classList.contains("is-open"));
  // See note in openManageCategoriesModal: deliberately not removing
  // "is-open" from Settings here to avoid a one-frame backdrop gap.

  const overlay = getOrCreateHelpOverlay();

  const sectionsHtml = FAQ_SECTIONS.map((section, sIdx) => `
    <section class="faq-section">
      <h3 class="settings-section-title">${escapeHtml(section.title)}</h3>
      <div class="faq-list">
        ${section.items.map((item, iIdx) => `
          <div class="faq-item" data-section="${sIdx}" data-item="${iIdx}">
            <button class="faq-question" type="button" aria-expanded="false">
              <span>${escapeHtml(item.q)}</span>
              ${renderChevronIcon()}
            </button>
            <div class="faq-answer">
              <p>${escapeHtml(item.a.replaceAll(DEFAULT_BRAND_NAME, getBrandName()))}</p>
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `).join("");

  overlay.innerHTML = `
    <div class="modal-container settings-modal-container help-modal-container" role="dialog" aria-modal="true" aria-labelledby="help-modal-heading">
      <div class="modal-header">
        <h2 id="help-modal-heading">Help &amp; FAQ</h2>
        <button class="modal-close-btn" type="button" id="help-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body settings-modal-body help-modal-body">
        <label class="search-box faq-search-box" for="faq-search-input">
          ${renderSearchIcon()}
          <input id="faq-search-input" type="search" placeholder="Search the FAQ" autocomplete="off" />
        </label>
        <div id="faq-sections-wrap">
          ${sectionsHtml}
        </div>
        <p class="faq-empty-state" id="faq-empty-state" style="display:none;">
          No matching questions. Try a different search term.
        </p>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="help-done-btn">Close</button>
      </div>
    </div>
  `;

  overlay.classList.add("is-open");

  overlay.querySelector("#help-close-btn").addEventListener("click", closeHelpModal);
  overlay.querySelector("#help-done-btn").addEventListener("click", closeHelpModal);

  // ── Accordion toggle ──────────────────────────────────────────────────────
  overlay.querySelectorAll(".faq-question").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest(".faq-item");
      const isOpen = item.classList.contains("is-open");
      item.classList.toggle("is-open", !isOpen);
      btn.setAttribute("aria-expanded", String(!isOpen));
    });
  });

  // ── Live search/filter ────────────────────────────────────────────────────
  const searchInput = overlay.querySelector("#faq-search-input");
  const emptyState = overlay.querySelector("#faq-empty-state");
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    let visibleCount = 0;

    overlay.querySelectorAll(".faq-section").forEach((section) => {
      let sectionHasMatch = false;
      section.querySelectorAll(".faq-item").forEach((item) => {
        const text = item.textContent.toLowerCase();
        const matches = !query || text.includes(query);
        item.style.display = matches ? "" : "none";
        // Auto-expand matches while searching; collapse again when cleared
        if (query && matches) {
          item.classList.add("is-open");
          item.querySelector(".faq-question").setAttribute("aria-expanded", "true");
        } else if (!query) {
          item.classList.remove("is-open");
          item.querySelector(".faq-question").setAttribute("aria-expanded", "false");
        }
        if (matches) {
          sectionHasMatch = true;
          visibleCount++;
        }
      });
      section.style.display = sectionHasMatch ? "" : "none";
    });

    emptyState.style.display = visibleCount === 0 ? "" : "none";
  });
}

function closeHelpModal() {
  const overlay = document.querySelector("#help-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");

  if (_helpModalReopenSettings) {
    _helpModalReopenSettings = false;
    const settingsOverlay = document.querySelector("#settings-modal-overlay");
    if (settingsOverlay) settingsOverlay.classList.add("is-open");
  }
}

// ─── About Modal ─────────────────────────────────────────────────────────────

function getOrCreateAboutOverlay() {
  let overlay = document.querySelector("#about-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "about-modal-overlay";
    overlay.className = "modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "about-modal-heading");
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAboutModal();
    });
  }
  return overlay;
}

function openAboutModal() {
  const overlay = getOrCreateAboutOverlay();
  overlay.innerHTML = `
    <div class="modal-container about-modal-container">
      <div class="modal-header">
        <h2 id="about-modal-heading">About</h2>
        <button class="modal-close-btn" type="button" id="about-close-btn" title="Close">
          ${renderCloseIcon()}
        </button>
      </div>
      <div class="modal-body about-modal-body">
        <div class="about-icon-wrap" aria-hidden="true">
          ${renderBrandMark("about-brand")}
        </div>
        <h3 class="about-app-name">${escapeHtml(getBrandName())}</h3>
        <p class="about-version">Version 1.0.0</p>
        <div class="about-divider"></div>
        <dl class="about-info">
          <div>
            <dt>Author</dt>
            <dd>YajAce</dd>
          </div>
        </dl>
      </div>
      <div class="modal-footer">
        <button class="secondary-button" type="button" id="about-done-btn">Close</button>
      </div>
    </div>
  `;
  overlay.classList.add("is-open");
  overlay.querySelector("#about-close-btn").addEventListener("click", closeAboutModal);
  overlay.querySelector("#about-done-btn").addEventListener("click", closeAboutModal);
}

function closeAboutModal() {
  const overlay = document.querySelector("#about-modal-overlay");
  if (overlay) overlay.classList.remove("is-open");
}

// ─── Info Icon ────────────────────────────────────────────────────────────────

function renderInfoIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="16" x2="12" y2="12"></line>
      <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
  `;
}

function renderHelpIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-2.9 2.5-2.9 4.5"></path>
      <line x1="12" y1="17.5" x2="12.01" y2="17.5"></line>
    </svg>
  `;
}

function renderEyeIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
}

function renderEyeOffIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 3 18 18"></path>
      <path d="M10.6 10.6A3 3 0 0 0 14 14"></path>
      <path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4.1"></path>
      <path d="M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7c1.7 0 3.2-.4 4.4-1"></path>
    </svg>
  `;
}

function renderSearchIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7"></circle>
      <path d="m16 16 4 4"></path>
    </svg>
  `;
}

function renderPlusIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14"></path>
      <path d="M5 12h14"></path>
    </svg>
  `;
}

function renderSettingsIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M12 2v3"></path>
      <path d="M12 19v3"></path>
      <path d="m4.9 4.9 2.1 2.1"></path>
      <path d="m17 17 2.1 2.1"></path>
      <path d="M2 12h3"></path>
      <path d="M19 12h3"></path>
      <path d="m4.9 19.1 2.1-2.1"></path>
      <path d="m17 7 2.1-2.1"></path>
    </svg>
  `;
}

function renderLockIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2"></rect>
      <path d="M8 10V7a4 4 0 0 1 8 0v3"></path>
    </svg>
  `;
}

// ─── Phase 9: Import / Export / Backup icons ──────────────────────────────────

function renderFileIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <path d="M14 2v6h6"></path>
    </svg>
  `;
}

function renderDownloadIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12"></path>
      <path d="m7 10 5 5 5-5"></path>
      <path d="M5 21h14"></path>
    </svg>
  `;
}

function renderShieldIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"></path>
      <path d="m9 12 2 2 4-4"></path>
    </svg>
  `;
}

function renderQrIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7"></rect>
      <rect x="14" y="3" width="7" height="7"></rect>
      <rect x="3" y="14" width="7" height="7"></rect>
      <path d="M14 14h3v3h-3z"></path>
      <path d="M18 14h3"></path>
      <path d="M14 18h3v3"></path>
      <path d="M21 18v3"></path>
    </svg>
  `;
}

function renderRestoreIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 2.6-6.4"></path>
      <path d="M3 4v5h5"></path>
    </svg>
  `;
}

function renderFolderIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
    </svg>
  `;
}

function renderManageCategoriesIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18"></path>
      <path d="M3 12h12"></path>
      <path d="M3 18h7"></path>
      <circle cx="19" cy="12" r="2"></circle>
      <circle cx="16" cy="18" r="2"></circle>
    </svg>
  `;
}

// ─── Phase 8: Clipboard Management ──────────────────────────────────────────

// Auto-clear timer reference
let _clipboardClearTimer = null;

/**
 * Copy text to clipboard, show a toast, and schedule auto-clear.
 * @param {string}  text        - Text to copy
 * @param {string}  label       - Toast message
 * @param {Element} [triggerEl] - Button that triggered the copy (gets a tick animation)
 * @param {boolean} [sensitive] - If true, schedules auto-clear of clipboard
 */
// ─── URL Resolution ─────────────────────────────────────────────────────────

// Local development hosts are almost always served over plain HTTP unless
// the user has specifically set up TLS — forcing https:// on these makes the
// open-website action silently fail to connect. Real-world domains, on the
// other hand, overwhelmingly require https://. So: detect the local cases
// and use http:// for those, https:// for everything else.
const LOCAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|.+\.local|.+\.test|.+\.localhost)(:\d+)?($|\/)/i;
const LOCAL_LAN_IP_PATTERN = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

function resolveWebsiteUrl(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return trimmed;

  // Already has an explicit protocol — respect it as-is.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;

  const isLocal = LOCAL_HOST_PATTERN.test(trimmed) || LOCAL_LAN_IP_PATTERN.test(trimmed);
  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

function copyToClipboard(text, label, triggerEl = null, sensitive = false) {
  navigator.clipboard.writeText(text).then(() => {
    // Visual feedback on trigger button
    if (triggerEl) {
      triggerEl.classList.add("is-copied");
      setTimeout(() => triggerEl.classList.remove("is-copied"), 1500);
    }

    // Show toast
    showToast(label, sensitive ? "sensitive" : "info");

    // Auto-clear clipboard for sensitive values (passwords)
    if (sensitive) {
      const delay = getClipboardClearDelay();
      if (delay > 0) {
        clearTimeout(_clipboardClearTimer);
        _clipboardClearTimer = setTimeout(() => {
          navigator.clipboard.writeText("").catch(() => {});
          showToast("Clipboard cleared automatically", "info");
        }, delay);
      }
    }
  }).catch(() => {
    showToast("Failed to copy - check browser permissions", "error");
  });
}

// ─── Toast System ─────────────────────────────────────────────────────────────

let _toastContainer = null;

function getToastContainer() {
  if (!_toastContainer) {
    _toastContainer = document.createElement("div");
    _toastContainer.id = "toast-container";
    _toastContainer.setAttribute("aria-live", "polite");
    _toastContainer.setAttribute("aria-atomic", "false");
    document.body.appendChild(_toastContainer);
  }
  return _toastContainer;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {"info"|"sensitive"|"error"} type
 * @param {number} duration  ms before auto-dismiss (default 2800)
 */
function showToast(message, type = "info", duration = 2800) {
  const container = getToastContainer();

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", "status");

  // Icon
  const iconMap = {
    info:      renderToastCopyIcon(),
    sensitive: renderToastLockIcon(),
    error:     renderToastErrorIcon()
  };

  toast.innerHTML = `
    <span class="toast-icon">${iconMap[type] || iconMap.info}</span>
    <span class="toast-message">${message}</span>
    <button class="toast-close" type="button" aria-label="Dismiss">&times;</button>
  `;

  // Dismiss on close button
  toast.querySelector(".toast-close").addEventListener("click", () => dismissToast(toast));

  container.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => toast.classList.add("is-visible"));

  // Auto-dismiss
  const timer = setTimeout(() => dismissToast(toast), duration);
  toast._timer = timer;
}

function dismissToast(toast) {
  clearTimeout(toast._timer);
  toast.classList.remove("is-visible");
  toast.classList.add("is-hiding");
  setTimeout(() => toast.remove(), 300);
}

// ─── Toast SVG icons (inline, no external dependency) ─────────────────────────

function renderToastCopyIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 6 9 17l-5-5"/>
  </svg>`;
}

function renderToastLockIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>`;
}

function renderToastErrorIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>`;
}

// ─── New row icon renderers for Phase 8 ──────────────────────────────────────

function renderUserIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>`;
}

function renderKeyIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="7.5" cy="15.5" r="5.5"/>
    <path d="M21 2 11.5 11.5"/>
    <path d="M15.5 6 19 9.5"/>
    <path d="M18 7l2 2"/>
  </svg>`;
}

function renderMailIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2"/>
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
  </svg>`;
}

function renderLinkIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>`;
}

function renderExternalLinkIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M15 3h6v6"/>
    <path d="M10 14 21 3"/>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
  </svg>`;
}

function renderStarIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"></path>
    </svg>
  `;
}

function renderVaultIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2"></rect>
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M12 9v2"></path>
      <path d="M12 13v2"></path>
    </svg>
  `;
}

function renderEditIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"></path>
      <path d="M20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path>
    </svg>
  `;
}

function renderTrashIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12z"></path>
      <path d="M19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path>
    </svg>
  `;
}

function renderCloseIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
      <path d="M18 6 6 18"></path>
      <path d="M6 6l12 12"></path>
    </svg>
  `;
}

function renderDiceIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="3"></rect>
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"></circle>
      <circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none"></circle>
      <circle cx="8" cy="16" r="1.2" fill="currentColor" stroke="none"></circle>
      <circle cx="16" cy="16" r="1.2" fill="currentColor" stroke="none"></circle>
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"></circle>
    </svg>
  `;
}

function renderCopyIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
}

function renderCheckIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6 9 17l-5-5"></path>
    </svg>
  `;
}

function renderChevronIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" class="gen-chevron">
      <path d="m6 9 6 6 6-6"></path>
    </svg>
  `;
}
