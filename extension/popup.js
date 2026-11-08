// Popup: shows the connection status from the background worker and offers to pair
// (paste the code from the app) or forget the pairing. Everything shown is set with
// textContent; nothing is built from markup. The code is never stored by the popup:
// it goes to the background worker and the field is cleared straight away.
(function () {
  const statusBox = document.getElementById("status");
  const title = document.getElementById("status-title");
  const detail = document.getElementById("status-detail");
  const recheck = document.getElementById("recheck");
  const pairingBox = document.getElementById("pairing");
  const codeInput = document.getElementById("code");
  const pairButton = document.getElementById("pair");
  const forgetButton = document.getElementById("forget");
  const siteBox = document.getElementById("site");
  const siteTitle = document.getElementById("site-title");
  const loginList = document.getElementById("logins");
  const siteNote = document.getElementById("site-note");

  let pageOrigin = ""; // only the origin of the tab, never its full address

  function show(state, titleText, detailText) {
    statusBox.dataset.state = state; // "checking", "connected", "problem" or "danger" (see popup.css)
    title.textContent = titleText;
    detail.textContent = detailText;
  }

  function setBusy(busy) {
    recheck.disabled = busy;
    pairButton.disabled = busy;
    forgetButton.disabled = busy;
    codeInput.disabled = busy;
  }

  // The origin (scheme + host + port) of the tab the popup was opened on, or "" for
  // anything that is not an http(s) page. Needs only the activeTab permission.
  function currentOrigin(callback) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = !chrome.runtime.lastError && Array.isArray(tabs) ? tabs[0] : null;
        if (!tab || typeof tab.url !== "string") return callback("");
        try {
          const url = new URL(tab.url);
          callback(url.protocol === "https:" || url.protocol === "http:" ? url.origin : "");
        } catch (error) {
          callback("");
        }
      });
    } catch (error) {
      callback("");
    }
  }

  function showSite(status) {
    siteBox.hidden = true;
    loginList.textContent = "";
    siteTitle.textContent = "";
    siteNote.textContent = "";
    if (status.connected !== true) return; // logins are only ever shown on a verified link

    const site = status.site && typeof status.site === "object" ? status.site : null;
    let note = "";
    if (!pageOrigin) {
      note = "Saved logins are not offered on this kind of page.";
    } else if (!site) {
      return;
    } else if (site.state === "ok" && Array.isArray(site.logins)) {
      const host = typeof site.host === "string" && site.host ? site.host : new URL(pageOrigin).host;
      siteTitle.textContent = "Saved logins for " + host;
      for (const login of site.logins.slice(0, 20)) {
        if (!login || typeof login !== "object") continue;
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.className = "login-name";
        name.textContent = String(login.name || "");
        item.appendChild(name);
        if (login.username) {
          const user = document.createElement("span");
          user.className = "login-user";
          user.textContent = String(login.username);
          item.appendChild(user);
        }
        loginList.appendChild(item);
      }
      if (!loginList.children.length) note = "No saved logins for this site.";
    } else if (site.state === "locked") {
      note = "Secure Login Vault is locked. Unlock it to see your logins here.";
    } else if (site.state === "insecure") {
      note = "This page is not secure (http), so no logins are offered.";
    } else if (site.state === "unsupported") {
      note = "Saved logins are not offered on this kind of page.";
    } else {
      note = "Could not look up saved logins. Check again.";
    }

    siteNote.textContent = note;
    siteBox.hidden = false;
  }

  function showResult(status) {
    setBusy(false);

    if (chrome.runtime.lastError || !status || typeof status !== "object") {
      show("problem", "No answer", "The extension could not check the connection. Reload the extension and try again.");
      pairingBox.hidden = true;
      forgetButton.hidden = true;
      showSite({});
      return;
    }

    let state = "problem";
    if (status.connected === true) state = "connected";
    else if (status.danger === true) state = "danger";
    show(state, String(status.title || ""), String(status.detail || ""));

    // Only the exact boolean true shows these controls.
    pairingBox.hidden = status.canPair !== true;
    forgetButton.hidden = status.canForget !== true;
    showSite(status);
  }

  function ask(message, pendingTitle) {
    setBusy(true);
    show("checking", pendingTitle, "");
    chrome.runtime.sendMessage(message, showResult);
  }

  function check() {
    currentOrigin((origin) => {
      pageOrigin = origin;
      ask(origin ? { type: "get-status", url: origin } : { type: "get-status" }, "Checking...");
    });
  }

  function pair() {
    const code = codeInput.value;
    codeInput.value = ""; // never kept in the popup
    if (!code.trim()) {
      show("problem", "Paste the code first", "Copy the code from Settings > Pair Browser in the app, then paste it here.");
      return;
    }
    ask(pageOrigin ? { type: "pair", code: code, url: pageOrigin } : { type: "pair", code: code }, "Pairing...");
  }

  recheck.addEventListener("click", check);
  pairButton.addEventListener("click", pair);
  codeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") pair();
  });
  forgetButton.addEventListener("click", () => ask({ type: "forget" }, "Forgetting..."));
  check();
})();
