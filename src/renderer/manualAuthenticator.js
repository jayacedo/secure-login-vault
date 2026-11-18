function renderManualAuthenticator(id) {
  return `<button type="button" class="secondary-button" id="${id}-manual-toggle" aria-expanded="false" aria-controls="${id}-manual">Enter setup key manually</button>
    <div id="${id}-manual" class="manual-authenticator" hidden>
      <label class="field-label" for="${id}-secret">Authenticator setup key</label>
      <div class="manual-authenticator-key"><input id="${id}-secret" class="settings-input" type="password" maxlength="256" autocomplete="off" spellcheck="false" autocapitalize="off">
        <button type="button" class="secondary-button" id="${id}-secret-show" aria-pressed="false">Show</button></div>
      <p class="modal-hint">Enter the secret from the site's 2FA setup, not its temporary verification code. Spaces are accepted. Converted locally to a QR and encrypted when you save this entry.</p>
      <details><summary>Advanced settings</summary><p class="modal-hint">Use the site's settings. Defaults: SHA1, 6 digits, 30 seconds.</p>
        <div class="manual-authenticator-options">
          <label>Algorithm<select class="modal-input" id="${id}-algorithm"><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label>
          <label>Digits<select class="modal-input" id="${id}-digits"><option>6</option><option>8</option></select></label>
          <label>Interval (seconds)<input class="settings-input" type="number" id="${id}-period" min="15" max="120" step="1" value="30"></label>
        </div>
      </details>
      <div class="qr-preview-actions"><button type="button" class="primary-button" id="${id}-manual-use">Use setup key</button>
        <button type="button" class="secondary-button" id="${id}-manual-cancel">Cancel</button></div>
    </div>
    <div id="${id}-replace-confirm" class="manual-authenticator" hidden>
      <p>Replace the existing 2FA setup? The new setup takes effect when you save this entry.</p>
      <div class="qr-preview-actions"><button type="button" class="danger-button" id="${id}-replace-yes">Replace setup</button>
        <button type="button" class="secondary-button" id="${id}-replace-no">Keep existing</button></div>
    </div>`;
}

function setupManualAuthenticator(container, id, commit, showError, clearError) {
  const find = suffix => container.querySelector(`#${id}${suffix}`);
  const field = find('').closest('.qr-field'), input = find('-secret'), panel = find('-manual');
  let request = 0, pending = null;
  const live = () => field.isConnected && container.classList.contains('is-open');
  const mask = () => { input.type = 'password'; find('-secret-show').textContent = 'Show'; find('-secret-show').setAttribute('aria-pressed', 'false'); };
  function reset() {
    request++; pending = null; input.value = ''; mask(); panel.hidden = true;
    find('-manual-toggle').setAttribute('aria-expanded', 'false'); find('-replace-confirm').hidden = true;
    find('-manual-use').disabled = false; input.disabled = false; field.dataset.setupPending = '';
    return request;
  }
  function offer(image, bytes, expected = request) {
    if (!live() || expected !== request) return;
    input.value = ''; mask();
    if (find('').value) {
      pending = { image, bytes }; field.dataset.setupPending = 'true';
      panel.hidden = true; find('-manual-toggle').setAttribute('aria-expanded', 'false');
      find('-replace-confirm').hidden = false; find('-replace-no').focus();
    } else { reset(); commit(image, bytes); }
  }
  find('-manual-toggle').addEventListener('click', () => {
    const opening = panel.hidden; reset(); clearError(); panel.hidden = !opening;
    find('-manual-toggle').setAttribute('aria-expanded', String(opening));
    if (opening) input.focus();
  });
  input.addEventListener('input', () => { field.dataset.setupPending = input.value ? 'true' : ''; });
  find('-secret-show').addEventListener('click', () => {
    const reveal = input.type === 'password'; input.type = reveal ? 'text' : 'password';
    find('-secret-show').textContent = reveal ? 'Hide' : 'Show'; find('-secret-show').setAttribute('aria-pressed', String(reveal));
  });
  find('-manual-cancel').addEventListener('click', () => { reset(); clearError(); find('-manual-toggle').focus(); });
  find('-replace-no').addEventListener('click', () => { reset(); clearError(); find('-manual-toggle').focus(); });
  find('-replace-yes').addEventListener('click', () => {
    if (!pending || !live()) return;
    const chosen = pending; reset(); closeAuthenticator(); commit(chosen.image, chosen.bytes);
  });
  find('-manual-use').addEventListener('click', async () => {
    if (!input.value || find('-manual-use').disabled) return;
    const current = ++request; clearError(); field.dataset.setupPending = 'true';
    find('-manual-use').disabled = true; input.disabled = true;
    try {
      const resultPromise = window.secureLoginVault.authenticator.createSetupQr({ secret: input.value,
        algorithm: find('-algorithm').value, digits: find('-digits').value, period: find('-period').value });
      input.value = ''; mask();
      const result = await resultPromise;
      if (!live() || current !== request) return;
      if (!result.ok) { field.dataset.setupPending = ''; showError(result.message || 'Could not use this setup key.'); return; }
      offer(result.result.image);
    } catch { if (live() && current === request) { field.dataset.setupPending = ''; showError('Could not use this setup key. Try again.'); } }
    finally { if (live() && current === request) { input.value = ''; input.disabled = false; find('-manual-use').disabled = false; } }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); find('-manual-use').click(); }
  });
  return { offer, reset,
    beginUpload() { const current = reset(); field.dataset.setupPending = 'true'; return current; },
    failUpload(current, message) { if (live() && current === request) { reset(); showError(message); } }
  };
}

function hasPendingAuthenticator(container) {
  return !!container?.querySelector('.qr-field[data-setup-pending="true"]');
}
