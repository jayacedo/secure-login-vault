// Popup: asks the background worker for the connection status and shows it.
// Everything shown is set with textContent; nothing is built from markup.
(function () {
  const statusBox = document.getElementById("status");
  const title = document.getElementById("status-title");
  const detail = document.getElementById("status-detail");
  const recheck = document.getElementById("recheck");

  function show(state, titleText, detailText) {
    statusBox.dataset.state = state; // "checking", "connected" or "problem" (styled in popup.css)
    title.textContent = titleText;
    detail.textContent = detailText;
  }

  function check() {
    recheck.disabled = true;
    show("checking", "Checking...", "");

    chrome.runtime.sendMessage({ type: "get-status" }, (status) => {
      recheck.disabled = false;

      if (chrome.runtime.lastError || !status || typeof status !== "object") {
        show("problem", "No answer", "The extension could not check the connection. Reload the extension and try again.");
        return;
      }

      show(status.connected === true ? "connected" : "problem", String(status.title || ""), String(status.detail || ""));
    });
  }

  recheck.addEventListener("click", check);
  check();
})();
