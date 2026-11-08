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

  function showResult(status) {
    setBusy(false);

    if (chrome.runtime.lastError || !status || typeof status !== "object") {
      show("problem", "No answer", "The extension could not check the connection. Reload the extension and try again.");
      pairingBox.hidden = true;
      forgetButton.hidden = true;
      return;
    }

    let state = "problem";
    if (status.connected === true) state = "connected";
    else if (status.danger === true) state = "danger";
    show(state, String(status.title || ""), String(status.detail || ""));

    // Only the exact boolean true shows these controls.
    pairingBox.hidden = status.canPair !== true;
    forgetButton.hidden = status.canForget !== true;
  }

  function ask(message, pendingTitle) {
    setBusy(true);
    show("checking", pendingTitle, "");
    chrome.runtime.sendMessage(message, showResult);
  }

  function check() {
    ask({ type: "get-status" }, "Checking...");
  }

  function pair() {
    const code = codeInput.value;
    codeInput.value = ""; // never kept in the popup
    if (!code.trim()) {
      show("problem", "Paste the code first", "Copy the code from Settings > Pair Browser in the app, then paste it here.");
      return;
    }
    ask({ type: "pair", code: code }, "Pairing...");
  }

  recheck.addEventListener("click", check);
  pairButton.addEventListener("click", pair);
  codeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") pair();
  });
  forgetButton.addEventListener("click", () => ask({ type: "forget" }, "Forgetting..."));
  check();
})();
