// Appearance only. Preview uses disabled controls and never requests vault data.
const UNLOCK_LAYOUT_KEY = 'slv_unlock_layout';
const UNLOCK_LAYOUTS = [
  { id: 'minimal', name: 'Minimal', description: 'Centered and spacious.' },
  { id: 'floating', name: 'Floating card', description: 'Soft depth. Recommended.' },
  { id: 'compact', name: 'Compact', description: 'Simple and space efficient.' }
];

function getUnlockLayout() {
  const saved = getPref(UNLOCK_LAYOUT_KEY, 'floating');
  return UNLOCK_LAYOUTS.some(layout => layout.id === saved) ? saved : 'floating';
}

function renderUnlockLayout(state, preview = false) {
  const layout = getUnlockLayout();
  const hasHint = preview || Boolean(state.passwordHint);
  const help = state.hasRecoveryKey || hasHint ? `<div class="unlock-help">
    ${state.hasRecoveryKey ? `<button class="link-button" type="button" ${preview ? 'disabled' : 'id="forgot-password-btn"'}>Forgot password?</button>` : ''}
    ${hasHint ? `<div class="hint-reveal"><button class="link-button" type="button" ${preview ? 'disabled' : 'id="show-hint-btn" aria-expanded="false" aria-controls="hint-text"'}>Show password hint</button>${preview ? '' : '<p class="hint-text" id="hint-text" hidden></p>'}</div>` : ''}
  </div>` : '';
  const field = preview ? `<label class="password-label"><span>Master Password</span><span class="password-control"><input type="password" disabled aria-label="Preview password field" /><span class="unlock-preview-eye" aria-hidden="true">${renderEyeIcon()}</span></span></label>`
    : renderPasswordInput({ id: 'master-password', label: 'Master Password', autocomplete: 'current-password' });
  const cancel = preview || state.compactUnlock ? `<button class="secondary-button unlock-cancel" type="button" ${preview ? 'disabled' : 'id="unlock-cancel-btn"'}>Cancel</button>` : '';
  return `<div class="unlock-screen unlock-layout-${layout}">
    <div class="unlock-brand">${renderBrandMark('compact')}<div class="unlock-brand-name"><strong>${escapeHtml(getBrandName())}</strong><small>Local vault</small></div><span class="unlock-locked">${renderLockIcon()} Locked</span></div>
    <${preview ? 'div' : 'form'} class="auth-form unlock-form" ${preview ? '' : 'id="unlock-vault-form" novalidate'}>
      <div class="unlock-heading"><h2>Welcome back</h2><p class="form-note">Enter your master password to unlock.</p></div>
      ${field}
      ${layout === 'minimal' ? '' : help}
      <div class="unlock-actions"><button class="primary-button" type="${preview ? 'button' : 'submit'}" ${preview ? 'disabled' : ''}>Unlock Vault</button>${layout === 'minimal' ? '' : cancel}</div>
      ${layout === 'minimal' ? help + cancel : ''}
      ${preview ? '' : '<p class="form-message" id="form-message" role="status"></p>'}
    </${preview ? 'div' : 'form'}>
  </div>`;
}

function renderUnlockLayoutSettings() {
  return `<div class="unlock-layout-settings">
    <h4 class="settings-row-name" id="unlock-layout-label">Unlock screen layout</h4>
    <p class="settings-row-hint">Choose a layout. Saved automatically on this device; your theme and branding apply to every style.</p>
    <div class="unlock-layout-choices" role="group" aria-labelledby="unlock-layout-label">
      ${UNLOCK_LAYOUTS.map(layout => `<button type="button" class="unlock-layout-choice" data-unlock-layout="${layout.id}" aria-pressed="${getUnlockLayout() === layout.id}">
        <span class="unlock-mini unlock-mini-${layout.id}" aria-hidden="true"><span class="mini-brand"></span><span class="mini-card"><span class="mini-title"></span><span class="mini-field"></span><span class="mini-help"></span><span class="mini-action"></span></span></span>
        <strong>${layout.name}</strong><small>${layout.description}</small>
      </button>`).join('')}
    </div>
    <button type="button" class="secondary-button" id="unlock-layout-preview-btn">Preview unlock screen</button>
    <p class="settings-row-hint" id="unlock-layout-status" role="status"></p>
  </div>`;
}

function setupUnlockLayoutSettings(overlay) {
  overlay.querySelectorAll('[data-unlock-layout]').forEach(button => button.addEventListener('click', () => {
    const layout = UNLOCK_LAYOUTS.find(item => item.id === button.dataset.unlockLayout);
    if (!layout) return;
    setPref(UNLOCK_LAYOUT_KEY, layout.id);
    overlay.querySelectorAll('[data-unlock-layout]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    overlay.querySelector('#unlock-layout-status').textContent = `${layout.name} saved. Used the next time you unlock.`;
  }));
  overlay.querySelector('#unlock-layout-preview-btn').addEventListener('click', openUnlockLayoutPreview);
}

let unlockPreviewReturnFocus = null;
function closeUnlockLayoutPreview(restoreFocus = true) {
  document.querySelector('#unlock-layout-preview')?.remove();
  if (restoreFocus && unlockPreviewReturnFocus?.isConnected) unlockPreviewReturnFocus.focus();
  unlockPreviewReturnFocus = null;
}

function openUnlockLayoutPreview() {
  closeUnlockLayoutPreview(false);
  unlockPreviewReturnFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.id = 'unlock-layout-preview';
  overlay.className = 'modal-overlay is-open';
  overlay.innerHTML = `<section class="modal-container unlock-preview-container" role="dialog" aria-modal="true" aria-labelledby="unlock-preview-title" aria-describedby="unlock-preview-note">
    <div class="modal-header"><h2 id="unlock-preview-title">Unlock screen preview</h2><button type="button" class="modal-close-btn" aria-label="Close preview">${renderCloseIcon()}</button></div>
    <div class="modal-body"><p class="form-note" id="unlock-preview-note">Preview only. Your vault stays unlocked. These controls are inactive.</p>${renderUnlockLayout({ compactUnlock: true, hasRecoveryKey: true }, true)}</div>
  </section>`;
  const close = overlay.querySelector('.modal-close-btn');
  close.addEventListener('click', () => closeUnlockLayoutPreview());
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeUnlockLayoutPreview(); }
    // The only active control is Close; keep keyboard focus inside the preview.
    if (event.key === 'Tab') { event.preventDefault(); close.focus(); }
  });
  document.body.append(overlay);
  close.focus();
}
