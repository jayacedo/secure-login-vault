let authenticatorRequest = 0, authenticatorTimer, authenticatorToken, authenticatorReturnFocus;
function closeAuthenticator() {
  authenticatorRequest++; clearTimeout(authenticatorTimer);
  window.secureLoginVault.authenticator.stop(authenticatorToken).catch(() => {});
  authenticatorToken = undefined;
  const overlay = document.querySelector("#authenticator-overlay");
  if (overlay) { overlay.classList.remove("is-open"); overlay.replaceChildren(); }
  if (authenticatorReturnFocus?.isConnected) authenticatorReturnFocus.focus();
  authenticatorReturnFocus = null;
}
async function openAuthenticator(image, trigger, entryKind = "credential") {
  closeAuthenticator(); const request = ++authenticatorRequest; authenticatorReturnFocus = trigger || document.activeElement;
  let overlay = document.querySelector("#authenticator-overlay");
  if (!overlay) {
    overlay = document.createElement("div"); overlay.id = "authenticator-overlay"; overlay.className = "modal-overlay";
    overlay.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const buttons = [...overlay.querySelectorAll("button:not(:disabled)")], first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    document.body.append(overlay);
  }
  overlay.innerHTML = `<div class="modal-container authenticator-container" role="dialog" aria-modal="true" aria-labelledby="authenticator-title">
    <div class="modal-header"><h2 id="authenticator-title">Authenticator code</h2><button class="modal-close-btn" id="authenticator-close" type="button" aria-label="Close authenticator">${renderCloseIcon()}</button></div>
    <div class="modal-body"><p id="authenticator-account" class="authenticator-account"></p>
      <div class="authenticator-code" id="authenticator-code" aria-label="Current authenticator code">—</div>
      <progress id="authenticator-progress" max="30" value="0" aria-label="Time remaining for this code"></progress>
      <p id="authenticator-countdown" class="modal-hint"></p><p id="authenticator-status" class="modal-hint" role="status">Reading the setup QR locally…</p>
      <p class="modal-hint">Use this code for the account shown above. Your computer's date and time must be correct.</p>
      <p class="modal-hint">The QR is kept with the entry when you save it. Closing this view clears the temporary setup key. Codes stop after five minutes; reopen Generate code to continue.</p>
    </div><div class="modal-footer"><button id="authenticator-done" class="secondary-button" type="button">Close</button><button id="authenticator-copy" class="primary-button" type="button" disabled>Copy code</button></div>
  </div>`;
  overlay.classList.add("is-open");
  const find = selector => overlay.querySelector(selector);
  function paint(result) {
    find("#authenticator-account").textContent = result.account;
    find("#authenticator-code").textContent = result.code;
    find("#authenticator-progress").max = result.period; find("#authenticator-progress").value = result.remaining;
    find("#authenticator-countdown").textContent = `New code in ${result.remaining}s · ${result.period}-second codes`;
    find("#authenticator-copy").disabled = false;
  }
  function failed(message) {
    clearTimeout(authenticatorTimer); find("#authenticator-code").textContent = "—";
    find("#authenticator-copy").disabled = true; find("#authenticator-progress").value = 0;
    find("#authenticator-countdown").textContent = ""; find("#authenticator-status").setAttribute("role", "alert");
    find("#authenticator-status").textContent = message;
  }
  async function refresh() {
    try {
      const response = await window.secureLoginVault.authenticator.read(authenticatorToken);
      if (request !== authenticatorRequest) return;
      if (!response.ok) return failed(response.message || "Could not generate the code. Reopen this view.");
      paint(response.result); authenticatorTimer = setTimeout(refresh, 500);
    } catch { if (request === authenticatorRequest) failed("Could not generate the code. Reopen this view."); }
  }
  find("#authenticator-copy").addEventListener("click", async () => {
    const button = find("#authenticator-copy"); button.disabled = true;
    try {
      // Main process generates a fresh code for Copy, including at rollover.
      const response = await window.secureLoginVault.authenticator.copy(authenticatorToken);
      if (request !== authenticatorRequest) return;
      if (!response.ok) return failed(response.message || "Could not copy the code.");
      paint(response.result); find("#authenticator-status").textContent = "Code copied. SLV clears its clipboard copy when the code expires or after 30 seconds.";
    } catch { if (request === authenticatorRequest) failed("Could not copy the code."); }
  });
  for (const id of ["authenticator-close", "authenticator-done"]) find(`#${id}`).addEventListener("click", closeAuthenticator);
  find("#authenticator-close").focus();
  try {
    const response = typeof image === "number"
      ? await (entryKind === "client"
        ? window.secureLoginVault.authenticator.startClient(image)
        : window.secureLoginVault.authenticator.startCredential(image))
      : await window.secureLoginVault.authenticator.start(image);
    if (request !== authenticatorRequest) { if (response.ok) window.secureLoginVault.authenticator.stop(response.result.token).catch(() => {}); return; }
    if (!response.ok) return failed(response.message || "Could not read this authenticator QR.");
    authenticatorToken = response.result.token; paint(response.result);
    find("#authenticator-status").textContent = "Generated locally. No setup key or code is sent to the browser extension.";
    authenticatorTimer = setTimeout(refresh, 500);
  } catch { if (request === authenticatorRequest) failed("Could not read this authenticator QR."); }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) closeAuthenticator(); });
