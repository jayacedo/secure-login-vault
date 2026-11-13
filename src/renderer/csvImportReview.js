let csvReviewRequest = 0;
let csvReviewState = null;
function closeCsvImportReview() {
  csvReviewRequest++;
  csvReviewState = null;
  const overlay = document.querySelector('#csv-import-overlay');
  if (overlay) {
    const wasOpen = overlay.classList.contains('is-open');
    overlay.classList.remove('is-open'); overlay.replaceChildren();
    if (wasOpen) document.querySelector('[data-import="csv"]')?.focus();
  }
}

async function openCsvImportReview(content) {
  closeCsvImportReview();
  const request = csvReviewRequest;
  const parsed = CsvImport.read(content);
  const [existingRes, activeRes] = await Promise.all([
    window.secureLoginVault.credentials.getAllForExport(), window.secureLoginVault.groups.getActive()
  ]);
  if (request !== csvReviewRequest) return;
  if (!existingRes.ok || !activeRes.ok) throw Error('Unlock the vault and try importing again.');
  const existing = existingRes.result.map(({ websiteName, websiteUrl, username, groupName }) => ({ websiteName, websiteUrl, username, groupName: groupName || '' }));
  existingRes.result = null;
  const activeGroup = activeRes.result || '';
  csvReviewState = { parsed, existing, activeGroup, page: 0, busy: false, request };
  let overlay = document.querySelector('#csv-import-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'csv-import-overlay'; overlay.className = 'modal-overlay'; document.body.append(overlay); }
  overlay.innerHTML = `<div class="modal-container csv-import-container" role="dialog" aria-modal="true" aria-labelledby="csv-import-title">
    <div class="modal-header"><h2 id="csv-import-title">Review CSV import</h2><button type="button" class="modal-close-btn" id="csv-import-close" aria-label="Cancel CSV import">${renderCloseIcon()}</button></div>
    <div class="modal-body">
      <details><summary>Column mapping</summary><ul>${parsed.mapping.map(field => `<li>${escapeHtml(field.source)} → ${escapeHtml(field.label)}</li>`).join('')}</ul></details>
      <p class="modal-hint">One row becomes one credential. Existing entries stay unchanged. Passwords are hidden in this preview.</p>
      <div class="modal-form-row">
        <label class="modal-label">Group for blank cells<input id="csv-default-group" class="modal-input" value="${escapeHtml(activeGroup)}" placeholder="${activeGroup ? escapeHtml(activeGroup) : 'Unassigned'}" /></label>
        <label class="modal-label">Category for blank cells<input id="csv-default-category" class="modal-input" placeholder="Other" /></label>
      </div>
      <label class="csv-duplicate-option"><input type="checkbox" id="csv-skip-duplicates" checked /> Skip possible duplicates</label>
      <p class="modal-hint">Matches use the group, login URL (or website name when blank), and username. Password changes are not applied to existing entries.</p>
      <p id="csv-import-summary" role="status"></p>
      <div class="csv-preview-scroll"><table class="csv-preview-table"><thead><tr><th>Row</th><th>Website / Login URL</th><th>Username</th><th>Password</th><th>Group / Category</th><th>Status</th></tr></thead><tbody id="csv-preview-rows"></tbody></table></div>
      <div class="csv-preview-pages"><button class="secondary-button" type="button" id="csv-prev">Previous</button><span id="csv-page-label"></span><button class="secondary-button" type="button" id="csv-next">Next</button></div>
      <p id="csv-import-error" role="alert"></p>
    </div>
    <div class="modal-footer"><button class="secondary-button" type="button" id="csv-import-cancel">Cancel</button><button class="primary-button" type="button" id="csv-import-confirm">Import</button></div>
  </div>`;
  overlay.classList.add('is-open');
  for (const id of ['csv-import-close', 'csv-import-cancel']) overlay.querySelector(`#${id}`).onclick = () => { closeCsvImportReview(); };
  for (const id of ['csv-default-group', 'csv-default-category', 'csv-skip-duplicates']) overlay.querySelector(`#${id}`).addEventListener('input', () => { csvReviewState.page = 0; renderCsvImportReview(); });
  overlay.querySelector('#csv-prev').onclick = () => { csvReviewState.page--; renderCsvImportReview(); };
  overlay.querySelector('#csv-next').onclick = () => { csvReviewState.page++; renderCsvImportReview(); };
  overlay.querySelector('#csv-import-confirm').onclick = commitCsvImportReview;
  overlay.onkeydown = event => {
    if (event.key !== 'Tab') return;
    const controls = [...overlay.querySelectorAll('button:not(:disabled), input:not(:disabled), summary')].filter(el => el.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  renderCsvImportReview(); overlay.querySelector('#csv-import-close').focus();
}

function getCsvReviewedRows() {
  const state = csvReviewState;
  return CsvImport.review(state.parsed.entries, state.existing, {
    groupName: document.querySelector('#csv-default-group').value.trim() || state.activeGroup,
    category: document.querySelector('#csv-default-category').value.trim()
  }, document.querySelector('#csv-skip-duplicates').checked);
}

function renderCsvImportReview() {
  const rows = getCsvReviewedRows(), state = csvReviewState;
  const count = rows.filter(row => row.include).length;
  const invalid = rows.filter(row => row.issue).length, duplicates = rows.filter(row => row.duplicate).length;
  document.querySelector('#csv-import-summary').textContent = `${rows.length} rows · ${count} to import · ${rows.length - count} skipped (${invalid} incomplete/invalid; ${duplicates} possible duplicates found)`;
  document.querySelector('#csv-preview-rows').innerHTML = rows.slice(state.page * 25, (state.page + 1) * 25).map(row => `<tr>
    <td>${row.row}</td><td>${escapeHtml(row.data.websiteName || 'Missing name')}<small>${escapeHtml(row.data.websiteUrl || 'No login URL')}</small></td>
    <td>${escapeHtml(row.data.username || '—')}</td><td>${row.data.password ? '••••••••' : 'Missing'}</td>
    <td>${escapeHtml(row.data.groupName || 'Unassigned')}<small>${escapeHtml(row.data.category)}</small></td>
    <td>${escapeHtml(row.issue || (row.duplicate ? (row.include ? 'Possible duplicate — add anyway' : 'Possible duplicate — skipped') : 'Ready'))}</td>
  </tr>`).join('');
  document.querySelector('#csv-page-label').textContent = `Page ${state.page + 1} of ${Math.max(1, Math.ceil(rows.length / 25))}`;
  document.querySelector('#csv-prev').disabled = state.page === 0;
  document.querySelector('#csv-next').disabled = (state.page + 1) * 25 >= rows.length;
  const confirm = document.querySelector('#csv-import-confirm');
  confirm.textContent = `Import ${count} credential${count === 1 ? '' : 's'}`; confirm.disabled = !count;
}

async function commitCsvImportReview() {
  const state = csvReviewState;
  if (!state || state.busy) return;
  state.busy = true;
  const rows = getCsvReviewedRows();
  const overlay = document.querySelector('#csv-import-overlay');
  overlay.querySelectorAll('button,input').forEach(el => { el.disabled = true; });
  let imported = 0, failed = 0;
  try {
    const active = await window.secureLoginVault.groups.getActive();
    if (csvReviewState !== state) return;
    if (!active.ok || (active.result || '') !== state.activeGroup) throw Error('The active group changed. Close this preview and choose the file again.');
    for (const row of rows.filter(row => row.include)) {
      if (csvReviewState !== state) return;
      const result = await window.secureLoginVault.credentials.add(row.data);
      if (csvReviewState !== state) return;
      if (result.ok) imported++; else failed++;
    }
    closeCsvImportReview();
    const message = `Imported ${imported}; skipped ${rows.filter(row => !row.include).length}; failed ${failed}.`;
    setSettingsStatus(message, failed > 0); showToast(message, failed ? 'error' : 'info'); refreshCredentials();
  } catch (error) {
    if (csvReviewState !== state) return;
    // Avoid offering a retry after any writes: reopening rechecks duplicates.
    if (imported || failed) { closeCsvImportReview(); setSettingsStatus(`Import stopped. Added ${imported}; failed ${failed}. Choose the file again to review remaining rows.`, true); refreshCredentials(); }
    else {
      state.busy = false; overlay.querySelectorAll('button,input').forEach(el => { el.disabled = false; });
      renderCsvImportReview(); document.querySelector('#csv-import-error').textContent = error.message || 'Could not import the file.';
    }
  }
}
