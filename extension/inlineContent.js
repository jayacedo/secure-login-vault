// Isolated top-frame UI. No page bridge, password reads or automatic vault lookups.
(function () {
  const api = globalThis.SLVApi || chrome;
  if (window !== window.top || globalThis.slvInlineInstalled) return;
  globalThis.slvInlineInstalled = true;
  let enabled = false, filling = false, target = null, host = null, shadow = null, panel = null;
  let revision = 0, timer, observer, scheduled = false;
  globalThis.slvInlineContext = null;
  const send = message => api.runtime.sendMessage(message).catch(() => null);
  function visible(input) {
    if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly || !input.isConnected || !input.form) return false;
    const rect = input.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) return false;
    for (let node = input; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.inert || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  }
  function eligible(input) {
    if (!visible(input)) return false;
    try { if (new URL(input.form.action || location.href, location.href).origin !== location.origin) return false; } catch { return false; }
    const type = input.type;
    const ac = (input.autocomplete || "").toLowerCase();
    const hint = [input.name, input.id, input.placeholder, input.getAttribute("aria-label")].join(" ");
    if (/new-password|one-time-code/.test(ac) || /search|newsletter|subscribe|coupon|captcha|otp|verif|confirm|new.?pass/i.test(hint)) return false;
    const passwords = [...input.form.querySelectorAll('input[type="password"]')].filter(visible);
    if (passwords.length > 1 || passwords.some(x => /new-password/.test(x.autocomplete))) return false;
    if (type === "password") return passwords.length === 1;
    if (!["text", "email", "tel"].includes(type)) return false;
    return passwords.length === 1 || /username|email/.test(ac) || /user|login|email|identifier/i.test(hint);
  }
  function closeChooser() {
    const token = globalThis.slvInlineContext?.token;
    revision++; filling = false; clearTimeout(timer); globalThis.slvInlineContext = null;
    if (panel) { panel.remove(); panel = null; if (token) send({ type: "inline-dismiss", token }); }
    shadow?.querySelector(".slv-button")?.setAttribute("aria-expanded", "false");
  }
  function remove() { closeChooser(); host?.remove(); host = shadow = target = null; }
  function position() {
    if (!host || !eligible(target)) { remove(); return; }
    const rect = target.getBoundingClientRect();
    const button = shadow.querySelector(".slv-button");
    const x = Math.max(8, Math.min(rect.right + 6, innerWidth - 44));
    const y = Math.max(8, Math.min(rect.top + (rect.height - 28) / 2, innerHeight - 36));
    button.style.left = x + "px"; button.style.top = y + "px";
    if (panel) {
      const width = Math.min(320, innerWidth - 16);
      panel.style.width = width + "px";
      panel.style.left = Math.max(8, Math.min(x + 36 - width, innerWidth - width - 8)) + "px";
      const height = Math.min(panel.offsetHeight, innerHeight - 24);
      panel.style.top = Math.max(8, y + 34 + height <= innerHeight - 8 ? y + 34 : y - height - 6) + "px";
    }
  }
  function reposition() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (host) position(); });
  }
  function show(input) {
    if (!enabled || !eligible(input)) return;
    if (input === target && host) { position(); return; }
    remove(); target = input;
    host = document.createElement("div");
    host.style.cssText = "all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;display:block!important;";
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme:dark; } * { box-sizing:border-box; }
      button { font:600 13px/1.4 system-ui,sans-serif; cursor:pointer; border:1px solid #526575; border-radius:7px; background:#17222e; color:#edf5fa; padding:8px; }
      button:focus-visible { outline:2px solid #63e6bf; outline-offset:2px; } button:disabled { opacity:.6; cursor:wait; }
      .slv-button { position:fixed; height:28px; padding:3px 6px; font-size:11px; color:#6ee7c1; border-color:#3c9279; }
      section { position:fixed; padding:14px; max-height:calc(100vh - 24px); overflow:auto; border:1px solid #3c9279; border-radius:10px; background:#141c24; box-shadow:0 8px 24px #0006; color:#edf5fa; font:13px/1.5 system-ui,sans-serif; }
      header { display:flex; align-items:center; justify-content:space-between; gap:8px; } h2 { margin:0; font-size:14px; }
      p { color:#b5c4d0; overflow-wrap:anywhere; margin:8px 0; } .account { display:block; width:100%; text-align:left; margin-top:8px; overflow-wrap:anywhere; }
      .account span { display:block; font-weight:400; color:#b5c4d0; } .close { padding:2px 7px; }
    `;
    const button = document.createElement("button"); button.type = "button"; button.className = "slv-button";
    button.textContent = "SLV"; button.setAttribute("aria-label", "Choose a login from Secure Login Vault");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", event => {
      if (!event.isTrusted || !enabled) return;
      event.stopPropagation();
      if (panel) closeChooser(); else openChooser();
    });
    shadow.append(style, button); document.documentElement.append(host); position();
  }
  async function openChooser() {
    closeChooser();
    if (!eligible(target)) return remove();
    const current = revision;
    const field = target, form = target.form, url = location.href;
    panel = document.createElement("section"); panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "SLV saved logins");
    const header = document.createElement("header");
    const title = document.createElement("h2"); title.textContent = "Secure Login Vault";
    const close = document.createElement("button"); close.type = "button"; close.className = "close"; close.textContent = "×"; close.setAttribute("aria-label", "Close saved logins");
    close.addEventListener("click", () => { closeChooser(); shadow?.querySelector(".slv-button")?.focus(); });
    header.append(title, close);
    const origin = document.createElement("p"); origin.textContent = location.host;
    const note = document.createElement("p"); note.setAttribute("role", "status"); note.textContent = "Looking up matching logins…";
    panel.append(header, origin, note); shadow.append(panel); shadow.querySelector(".slv-button").setAttribute("aria-expanded", "true"); position();
    const result = await send({ type: "inline-list" });
    if (current !== revision || !panel || field !== target || location.href !== url) return;
    if (!result?.ok || result.origin !== location.origin) { note.textContent = result?.message || "Open the extension to check the connection."; position(); return; }
    globalThis.slvInlineContext = { token: result.token, expires: result.expires, target: field, form, url };
    timer = setTimeout(closeChooser, Math.max(0, result.expires - Date.now()));
    note.textContent = result.logins.length ? "Choose an account to fill. Nothing is submitted." : "No saved logins for this site.";
    for (const login of result.logins) {
      const account = document.createElement("button"); account.type = "button"; account.className = "account";
      account.textContent = login.name;
      const user = document.createElement("span"); user.textContent = login.username; account.append(user);
      account.addEventListener("click", async event => {
        if (!event.isTrusted || !enabled || !eligible(field) || field !== target || !globalThis.slvInlineContext) return;
        event.stopPropagation();
        clearTimeout(timer);
        filling = true;
        globalThis.slvInlineContext.expires = Date.now() + 90000;
        panel.querySelectorAll(".account").forEach(button => { button.disabled = true; });
        note.textContent = "Filling… Confirm in SLV if prompted.";
        timer = setTimeout(closeChooser, 90000);
        const filled = await send({ type: "inline-fill", token: result.token, loginId: login.id });
        if (current !== revision || !panel) return;
        filling = false;
        globalThis.slvInlineContext = null;
        panel.querySelectorAll(".account").forEach(button => button.remove());
        note.textContent = filled?.message || "Could not fill. Open the extension to check the connection.";
        clearTimeout(timer); timer = setTimeout(closeChooser, filled?.ok ? 4000 : 10000); position();
      });
      panel.append(account);
    }
    position(); panel.querySelector(".account")?.focus();
  }
  async function refresh() {
    const result = await send({ type: "inline-ready" });
    enabled = result?.enabled === true;
    if (!enabled) { remove(); observer?.disconnect(); }
    else {
      if (!observer) observer = new MutationObserver(reposition);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden", "type", "disabled", "readonly", "autocomplete"] });
      show(document.activeElement);
    }
  }
  document.addEventListener("focusin", event => {
    if (!enabled || filling || event.target === host) return;
    if (eligible(event.target)) show(event.target); else if (!panel) remove();
  }, true);
  document.addEventListener("pointerdown", event => { if (host && !event.composedPath().includes(host) && event.target !== target) closeChooser(); }, true);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && panel) { event.preventDefault(); closeChooser(); target?.focus(); }
  }, true);
  document.addEventListener("visibilitychange", () => { if (document.hidden) remove(); else refresh(); });
  window.addEventListener("pagehide", remove);
  window.addEventListener("pageshow", refresh);
  window.addEventListener("popstate", remove);
  window.addEventListener("hashchange", remove);
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  api.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === api.runtime.id && message?.type === "slv-inline-refresh") refresh();
  });
  refresh();
})();
