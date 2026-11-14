// Optional, isolated top-frame script. Reads a form only on a trusted submit following
// a real click/key press in that form. Never intercepts submission or observes values as typed.
(function () {
  const extensionApi = globalThis.SLVApi || chrome;
  if (window !== window.top || globalThis.slvOfferInstalled) return;
  globalThis.slvOfferInstalled = true;
  let enabled = false;
  let gestureForm = null;
  let gestureAt = 0;
  let host = null;
  let shownToken = "";
  let expiryTimer;
  const send = (message) => extensionApi.runtime.sendMessage(message).catch(() => null);

  function close() {
    clearTimeout(expiryTimer);
    if (host) host.remove();
    host = null;
    shownToken = "";
  }
  function show(offer) {
    if (!offer || offer.origin !== location.origin || typeof offer.token !== "string" ||
        !["add", "update", "locked"].includes(offer.mode) || offer.expires <= Date.now()) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", () => show(offer), { once: true });
      return;
    }
    if (shownToken === offer.token) return;
    close();
    shownToken = offer.token;
    host = document.createElement("div");
    host.style.cssText = "all:initial!important;position:fixed!important;top:16px!important;right:16px!important;z-index:2147483647!important;width:min(350px,calc(100vw - 32px))!important;display:block!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: dark; }
      * { box-sizing: border-box; }
      section { padding:18px; border:1px solid #36584e; border-radius:12px; background:#141c24; color:#e8edf2; box-shadow:0 8px 30px #0005; font:14px/1.5 system-ui,sans-serif; }
      h2 { margin:0 0 6px; font-size:16px; } p { margin:6px 0 14px; overflow-wrap:anywhere; color:#b5c4d0; }
      strong { color:#50dbb2; font-size:12px; } .actions { display:flex; flex-wrap:wrap; gap:8px; }
      button { font:600 13px/1.5 system-ui,sans-serif; padding:8px 12px; border:1px solid #50616d; border-radius:7px; background:transparent; color:#e8edf2; cursor:pointer; }
      button:first-child { background:#38c7a0; border-color:#38c7a0; color:#08271e; }
      button:focus-visible { outline:2px solid #fff; outline-offset:3px; } button:disabled { opacity:.6; cursor:wait; }
      .never { padding:8px 0 0; border:0; font-weight:400; color:#b5c4d0; }
    `;
    const panel = document.createElement("section");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Secure Login Vault save offer");
    const brand = document.createElement("strong"); brand.textContent = "SECURE LOGIN VAULT";
    const title = document.createElement("h2"); title.textContent = offer.mode === "update" ? "Update this password?" : "Save these login details?";
    const note = document.createElement("p");
    note.setAttribute("role", "status");
    note.textContent = new URL(offer.origin).host + (offer.mode === "locked" ? " — unlock SLV before saving." : " — confirm in the SLV app when you save.");
    const actions = document.createElement("div"); actions.className = "actions";
    const save = document.createElement("button"); save.type = "button"; save.textContent = offer.mode === "update" ? "Update" : "Save";
    const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.textContent = "Not now";
    const never = document.createElement("button"); never.type = "button"; never.className = "never"; never.textContent = "Never for this site";
    const controls = [save, dismiss, never];
    async function act(event, type) {
      if (!event.isTrusted) return;
      controls.forEach(button => { button.disabled = true; });
      if (type === "offer-save") { clearTimeout(expiryTimer); note.textContent = "Confirm in the SLV app…"; }
      const result = await send({ type, token: offer.token });
      if (shownToken !== offer.token) return;
      if (type !== "offer-save") { close(); return; }
      title.textContent = result?.ok ? "Done" : "Not saved";
      note.textContent = result?.message || "This offer expired. Open the extension to save your login.";
      actions.remove(); never.remove();
      const done = document.createElement("button"); done.type = "button"; done.textContent = "Close";
      done.addEventListener("click", close); panel.append(done);
      expiryTimer = setTimeout(close, 10000);
    }
    save.addEventListener("click", event => act(event, "offer-save"));
    dismiss.addEventListener("click", event => act(event, "offer-dismiss"));
    never.addEventListener("click", event => act(event, "offer-never"));
    actions.append(save, dismiss); panel.append(brand, title, note, actions, never);
    shadow.append(style, panel); document.body.append(host);
    expiryTimer = setTimeout(close, Math.max(0, offer.expires - Date.now()));
  }
  async function refresh() {
    const result = await send({ type: "offer-ready" });
    enabled = result?.enabled === true;
    if (!enabled) close();
    else if (result.offer) show(result.offer);
  }
  function gesture(event) {
    if (!event.isTrusted) return;
    const element = event.target;
    gestureForm = element?.form || element?.closest?.("form") || null;
    gestureAt = Date.now();
  }
  document.addEventListener("click", gesture, true);
  document.addEventListener("keydown", gesture, true);
  document.addEventListener("submit", event => {
    const form = event.target;
    if (!enabled || !event.isTrusted || form !== gestureForm || Date.now() - gestureAt > 10000 ||
        !(form instanceof HTMLFormElement)) return;
    // Do not mix credentials with another origin (SSO/embedded or cross-site actions).
    try {
      const action = event.submitter?.hasAttribute("formaction")
        ? event.submitter.getAttribute("formaction") : form.getAttribute("action");
      if (new URL(action || location.href, document.baseURI).origin !== location.origin) return;
    } catch { return; }
    gestureForm = null;
    let read = slvReadFormInPage(location.origin, form, { readUsernameStep: true, allowMissingUsername: true });
    if (read.status === "username-only") {
      send({ type: "offer-username", username: read.username });
      return;
    }
    if (read.status !== "read" && read.status !== "no-username") return;
    send({ type: "offer-capture", username: read.username, password: read.password }).then(result => {
      if (result?.offer) show(result.offer);
    });
    read.password = "";
    read = null;
  }, true);
  extensionApi.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== extensionApi.runtime.id || sender.tab) return;
    if (message?.type === "slv-offer") show(message.offer);
    if (message?.type === "slv-offers-refresh") refresh();
  });
  window.addEventListener("pagehide", () => { enabled = false; gestureForm = null; close(); });
  window.addEventListener("pageshow", refresh);
  refresh();
})();
