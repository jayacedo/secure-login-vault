let duplicateRequest = 0;
let returnToDuplicateReview = false;
function closeDuplicateReview() {
  duplicateRequest++; returnToDuplicateReview = false;
  const overlay = document.querySelector("#duplicate-review-overlay");
  if (overlay) { overlay.classList.remove("is-open"); overlay.replaceChildren(); }
  document.querySelector("#review-duplicates-btn")?.focus();
}
async function openDuplicateReview() {
  const request = ++duplicateRequest;
  let overlay = document.querySelector("#duplicate-review-overlay");
  if (!overlay) {
    overlay = document.createElement("div"); overlay.id = "duplicate-review-overlay"; overlay.className = "modal-overlay";
    overlay.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const controls = [...overlay.querySelectorAll("button:not(:disabled), input:not(:disabled)")].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    document.body.append(overlay);
  }
  overlay.innerHTML = `<div class="modal-container duplicate-container" role="dialog" aria-modal="true" aria-labelledby="duplicate-title">
    <div class="modal-header"><h2 id="duplicate-title">Duplicate Login Review</h2><button class="modal-close-btn" id="duplicate-close" type="button" aria-label="Close duplicate review">${renderCloseIcon()}</button></div>
    <div class="modal-body"><p class="modal-hint">Matches use the same website origin and exact username (email when username is blank). Different paths may serve different accounts. These are suggestions to review, not proof that an entry is unnecessary.</p>
      <p class="modal-hint">Choose one login to keep, then review before moving the other copies to Recently Deleted for 30 days. No fields or password histories are merged. Password values stay out of this comparison.</p>
      <p id="duplicate-scope" class="modal-hint"></p><div id="duplicate-results" aria-busy="true"><p role="status">Checking saved logins...</p></div>
      <p id="duplicate-status" role="status" aria-live="polite"></p></div>
    <div class="modal-footer"><button class="secondary-button" id="duplicate-refresh" type="button">Refresh review</button><button class="primary-button" id="duplicate-done" type="button">Close</button></div>
  </div>`;
  overlay.classList.add("is-open");
  for (const id of ["duplicate-close", "duplicate-done"]) overlay.querySelector(`#${id}`).addEventListener("click", closeDuplicateReview);
  overlay.querySelector("#duplicate-refresh").addEventListener("click", openDuplicateReview);
  overlay.querySelector("#duplicate-close").focus();
  const results = overlay.querySelector("#duplicate-results"), status = overlay.querySelector("#duplicate-status");
  let busy = false;
  try {
    const response = await window.secureLoginVault.credentials.getDuplicates();
    if (request !== duplicateRequest) return;
    if (!response.ok) throw new Error(response.message || "Could not check duplicate logins.");
    const report = response.result;
    overlay.querySelector("#duplicate-scope").textContent = report.activeGroup ? `Group: ${report.activeGroup}. Other groups are excluded.` : "All credential groups. Recently Deleted and Client Vault are excluded.";
    results.replaceChildren();
    const summary = document.createElement("p"); summary.textContent = report.groups.length ? `${report.groups.length} matching ${report.groups.length === 1 ? "set" : "sets"} to review across ${report.total} saved logins.` : "No matching duplicate logins found in this scope. Entries without a valid website or username/email are skipped.";
    results.append(summary);
    report.groups.forEach((group, index) => {
      const section = document.createElement("section"); section.className = "duplicate-set";
      const title = document.createElement("h3"); title.textContent = `${group.origin} · ${group.username}`;
      const warning = document.createElement("p"); warning.className = "modal-hint";
      warning.textContent = [group.passwordsDiffer ? "Passwords differ. Check which login is current before cleanup." : "Passwords match; other details may still differ.", group.multipleGroups ? "These entries belong to different groups. They may be intentional." : "", "Use Review / Edit to inspect notes, passwords and history."].filter(Boolean).join(" ");
      const cards = document.createElement("div"); cards.className = "duplicate-cards";
      const review = document.createElement("button"); review.type = "button"; review.className = "secondary-button"; review.textContent = "Review cleanup"; review.disabled = true; review.dataset.duplicateAction = "review";
      const confirmation = document.createElement("div"); confirmation.className = "duplicate-confirmation";
      let keepId = null;
      for (const entry of group.entries) {
        const card = document.createElement("article"); card.className = "duplicate-card";
        const label = document.createElement("label"); label.className = "duplicate-keep";
        const radio = document.createElement("input"); radio.type = "radio"; radio.name = `duplicate-keep-${index}`; radio.value = entry.id; radio.dataset.duplicateKeep = entry.id;
        const name = document.createElement("strong"); name.textContent = `Keep: ${entry.websiteName}`;
        label.append(radio, name);
        radio.addEventListener("change", () => { keepId = entry.id; review.disabled = false; confirmation.replaceChildren(); });
        card.append(label);
        const lines = [entry.websiteUrl, `Group: ${entry.groupName || "Unassigned"}`, `Category: ${entry.category}`, `Updated: ${new Date(entry.updatedAt).toLocaleString()}`, `Created: ${new Date(entry.createdAt).toLocaleString()}`,
          `Favorite: ${entry.favorite ? "Yes" : "No"} · Notes: ${entry.hasNotes ? "Yes" : "No"} · QR image: ${entry.hasQrCode ? "Yes" : "No"}`, `Tags: ${entry.tags || "None"}`];
        for (const text of lines) { const line = document.createElement("p"); line.className = "modal-hint"; line.textContent = text; card.append(line); }
        const edit = document.createElement("button"); edit.type = "button"; edit.className = "secondary-button"; edit.textContent = "Review / Edit"; edit.dataset.duplicateEdit = entry.id;
        edit.addEventListener("click", () => { closeDuplicateReview(); returnToDuplicateReview = true; openCredentialModal(entry.id); });
        card.append(edit); cards.append(card);
      }
      review.addEventListener("click", () => {
        if (!keepId || busy) return;
        confirmation.replaceChildren();
        const kept = group.entries.find(entry => entry.id === keepId), removed = group.entries.filter(entry => entry.id !== keepId);
        const note = document.createElement("p"); note.textContent = `Keep "${kept.websiteName}" (${kept.groupName || "Unassigned"}). Move ${removed.length} ${removed.length === 1 ? "copy" : "copies"}, including password history, to Recently Deleted:`;
        const list = document.createElement("ul");
        for (const entry of removed) { const item = document.createElement("li"); item.textContent = `${entry.websiteName} — ${entry.groupName || "Unassigned"} / ${entry.category}`; list.append(item); }
        const confirm = document.createElement("button"); confirm.type = "button"; confirm.className = "danger-button"; confirm.textContent = `Move ${removed.length} ${removed.length === 1 ? "copy" : "copies"} to Recently Deleted`; confirm.dataset.duplicateAction = "confirm";
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary-button"; cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => { confirmation.replaceChildren(); review.focus(); });
        confirm.addEventListener("click", async () => {
          if (busy) return;
          busy = true;
          overlay.querySelectorAll(".modal-body button, .modal-body input, #duplicate-refresh").forEach(control => { control.disabled = true; });
          status.textContent = "Moving selected copies...";
          try {
            const response = await window.secureLoginVault.credentials.resolveDuplicates({ keepId, revision: group.revision, confirmed: true });
            if (request !== duplicateRequest) return;
            if (!response.ok) throw new Error(response.message || "Cleanup failed. Refresh the review.");
            await refreshCredentials();
            if (request !== duplicateRequest) return;
            showToast(`${response.result.deleted} copies moved to Recently Deleted. The kept login is unchanged.`);
            await openDuplicateReview();
          } catch (error) {
            if (request === duplicateRequest) {
              status.textContent = error.message; status.setAttribute("role", "alert");
              overlay.querySelector("#duplicate-refresh").disabled = false;
            }
          } finally { busy = false; }
        });
        confirmation.append(note, list, confirm, cancel); cancel.focus();
      });
      section.append(title, warning, cards, review, confirmation); results.append(section);
    });
  } catch (error) {
    if (request === duplicateRequest) { results.textContent = error.message; results.setAttribute("role", "alert"); }
  } finally { if (request === duplicateRequest) results.setAttribute("aria-busy", "false"); }
}
