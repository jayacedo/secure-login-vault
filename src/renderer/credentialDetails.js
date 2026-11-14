let credentialDetailsState = null;

function hideCredentialDetailsSecrets() {
  const state = credentialDetailsState;
  if (!state) return;
  state.passwordRequest++;
  clearTimeout(state.revealTimer);
  state.revealed = false;
  state.overlay.querySelector("#detail-password").textContent = "••••••••";
  const reveal = state.overlay.querySelector("#detail-reveal");
  reveal.textContent = "Reveal"; reveal.setAttribute("aria-pressed", "false");
  const history = state.overlay.querySelector("#password-history");
  history.open = false;
  state.overlay.querySelectorAll("#password-history input").forEach(input => { input.value = ""; });
  state.overlay.querySelector("#password-history-list").replaceChildren();
}

function closeCredentialDetails(restoreFocus = true) {
  const state = credentialDetailsState;
  if (!state) return;
  hideCredentialDetailsSecrets();
  credentialDetailsState = null;
  if (state.openedAuthenticator) closeAuthenticator();
  state.overlay.replaceChildren(); state.overlay.remove();
  if (restoreFocus && state.trigger?.isConnected) state.trigger.focus({preventScroll:true});
}

async function openCredentialDetails(id, trigger) {
  closeCredentialDetails(false);
  const overlay = document.createElement("div");
  overlay.id = "credential-details-overlay";
  overlay.className = "modal-overlay credential-details-overlay is-open";
  overlay.tabIndex = -1;
  overlay.innerHTML = `<section class="modal-container credential-details-container" role="dialog" aria-modal="true" aria-labelledby="credential-details-title">
    <div class="modal-header"><h2 id="credential-details-title">Credential details</h2><button class="modal-close-btn" type="button" aria-label="Close details" id="detail-close">${renderCloseIcon()}</button></div>
    <div class="modal-body">
      <p id="detail-status" role="status">Loading details…</p>
      <div id="detail-content" hidden>
        <h3 id="detail-name"></h3><div id="detail-fields"></div>
        <section class="detail-field"><h3>Password</h3><div class="detail-password-controls">
          <span id="detail-password" class="detail-value">••••••••</span>
          <button type="button" class="secondary-button" id="detail-reveal" aria-pressed="false">Reveal</button>
          <button type="button" class="secondary-button" id="detail-copy-password">Copy</button>
        </div><p class="modal-hint">Hidden again after 30 seconds or when SLV loses focus.</p></section>
        <div id="detail-organization"></div>
        <section class="detail-field"><h3>2FA</h3><p id="detail-2fa-status" class="modal-hint"></p><button type="button" class="secondary-button" id="detail-2fa" hidden>Generate code</button></section>
        <details class="password-history" id="password-history"><summary>Password history</summary>
          <p class="modal-hint">Latest 10 previous passwords. Show or copy a previous password here; use Edit to change the saved login.</p><div id="password-history-list" aria-live="polite"></div></details>
        <p class="modal-hint" id="detail-dates"></p>
      </div>
    </div>
    <div class="modal-footer"><button class="secondary-button" type="button" id="detail-done">Close</button><button class="primary-button" type="button" id="detail-edit" disabled>Edit</button></div>
  </section>`;
  const state = {id, trigger, overlay, passwordRequest:0, revealed:false, revealTimer:null, openedAuthenticator:false};
  credentialDetailsState = state;
  document.body.append(overlay);
  const find = selector => overlay.querySelector(selector);
  const status = find("#detail-status");
  const close = () => closeCredentialDetails();
  find("#detail-close").addEventListener("click",close);
  find("#detail-done").addEventListener("click",close);
  find("#detail-edit").addEventListener("click",()=>{closeCredentialDetails(false);openCredentialModal(id);});
  find("#detail-2fa").addEventListener("click",event=>{
    hideCredentialDetailsSecrets(); state.openedAuthenticator = true; openAuthenticator(id,event.currentTarget);
  });
  const password = async reveal => {
    if (reveal && state.revealed) { hideCredentialDetailsSecrets(); return; }
    const request = ++state.passwordRequest;
    const button = find(reveal ? "#detail-reveal" : "#detail-copy-password");
    button.disabled = true;
    try {
      const response = await window.secureLoginVault.credentials.getOne(id);
      if (credentialDetailsState !== state || state.passwordRequest !== request) return;
      if (!response.ok) throw Error(response.message || "Could not read this password.");
      if (reveal) {
        state.revealed = true;
        find("#detail-password").textContent = response.result.password;
        button.textContent = "Hide"; button.setAttribute("aria-pressed","true");
        clearTimeout(state.revealTimer);
        state.revealTimer = setTimeout(hideCredentialDetailsSecrets,30000);
      } else copyToClipboard(response.result.password,"Password copied!",button,true);
      response.result.password = "";
    } catch (error) { if (credentialDetailsState === state) status.textContent = error.message; }
    finally { if (credentialDetailsState === state) button.disabled = false; }
  };
  find("#detail-reveal").addEventListener("click",()=>password(true));
  find("#detail-copy-password").addEventListener("click",()=>password(false));
  overlay.addEventListener("keydown",event=>{
    if(event.key === "Escape") { event.preventDefault();event.stopPropagation();close(); }
    if(event.key === "Tab") {
      const controls=[...overlay.querySelectorAll("button:not(:disabled), summary, input")].filter(el=>el.getClientRects().length);
      const first=controls[0], last=controls.at(-1);
      if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  find("#detail-close").focus();
  const field = (container,label,value,copyLabel) => {
    const section=document.createElement("section");section.className="detail-field";
    const heading=document.createElement("h3");heading.textContent=label;
    const line=document.createElement("div");line.className="detail-field-line";
    const text=document.createElement("p");text.className="detail-value";text.textContent=value || "Not set";
    line.append(text);
    if(value && copyLabel){
      const copy=document.createElement("button");copy.type="button";copy.className="secondary-button detail-copy";
      copy.textContent="Copy";copy.setAttribute("aria-label",`Copy ${label.toLowerCase()}`);
      copy.addEventListener("click",()=>copyToClipboard(value,copyLabel,copy));line.append(copy);
    }
    section.append(heading,line);container.append(section);
  };
  try {
    const response=await window.secureLoginVault.credentials.getDetails(id);
    if(credentialDetailsState!==state)return;
    if(!response.ok)throw Error(response.message || "Could not load credential details.");
    const entry=response.result;
    find("#detail-name").textContent=entry.websiteName;
    field(find("#detail-fields"),"Login URL",entry.websiteUrl,"URL copied!");
    field(find("#detail-fields"),"Username",entry.username,"Username copied!");
    field(find("#detail-fields"),"Email",entry.email,"Email copied!");
    field(find("#detail-organization"),"Group",entry.groupName || "Ungrouped");
    field(find("#detail-organization"),"Category",entry.category);
    field(find("#detail-organization"),"Notes",entry.notes);
    field(find("#detail-organization"),"Tags",entry.tags);
    find("#detail-2fa-status").textContent=entry.hasQrCode ? "A QR image is saved. Generate checks whether it is a supported authenticator setup QR." : "No QR image saved. Add one in Edit.";
    find("#detail-2fa").hidden=!entry.hasQrCode;
    const date=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():"Not available";
    find("#detail-dates").textContent=`Created: ${date(entry.createdAt)} · Updated: ${date(entry.updatedAt)}`;
    setupPasswordHistory(overlay,id,{readOnly:true});
    find("#detail-content").hidden=false;find("#detail-edit").disabled=false;status.textContent="";
  } catch(error) { if(credentialDetailsState===state)status.textContent=error.message; }
}

window.addEventListener("blur",hideCredentialDetailsSecrets);
document.addEventListener("visibilitychange",()=>{if(document.hidden)closeCredentialDetails(false);});
