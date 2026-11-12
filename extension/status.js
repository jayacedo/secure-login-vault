// Turns the browser helper's answer (or the browser's error) into something the
// popup can show. Pure: no browser APIs, so it is unit-tested in Node and loaded
// into the background worker with importScripts().
(function (root) {
  const HOST_NAME = "com.securelogin.vault";
  const EXPECTED_PROTOCOL = 2;

  function result(state, title, detail, extra) {
    return Object.assign({ state: state, connected: state === "connected", title: title, detail: detail }, extra || {});
  }

  // reply: what the app sent back (or undefined); runtimeError: chrome.runtime.lastError.message (or "")
  function describeStatus(reply, runtimeError) {
    const problem = typeof runtimeError === "string" ? runtimeError : "";

    if (problem) {
      if (/not found|no such native application/i.test(problem)) {
        return result(
          "helper-missing",
          "Helper not installed",
          "Your browser cannot find the Secure Login Vault helper. Install or register it, then check again."
        );
      }
      if (/forbidden/i.test(problem)) {
        return result(
          "helper-forbidden",
          "Helper does not allow this extension",
          "The helper's registration does not list this extension. Register the helper again."
        );
      }
      return result(
        "helper-error",
        "Helper stopped unexpectedly",
        "The helper started but ended without answering. Check again, or register the helper again."
      );
    }

    if (!reply || typeof reply !== "object") {
      return result("error", "No answer", "The helper did not send a usable answer.");
    }

    if (reply.ok === true && reply.type === "pong") {
      if (reply.protocol !== EXPECTED_PROTOCOL) {
        return result(
          "version-mismatch",
          "Versions do not match",
          "This extension and the desktop app speak different versions. Update both to the latest version."
        );
      }
      const version = typeof reply.appVersion === "string" ? reply.appVersion.slice(0, 32) : "";
      return result("connected", "Connected", version ? "Secure Login Vault " + version : "Secure Login Vault", {
        appVersion: version
      });
    }

    switch (reply.error) {
      case "app-not-running":
        return result(
          "app-not-running",
          "Not connected",
          "Secure Login Vault is not running, or the browser connection is off. Open the app, go to Settings > Security, and set Browser Extension to On."
        );
      case "origin-not-allowed":
        return result(
          "helper-forbidden",
          "Helper does not allow this extension",
          "The helper does not recognise this extension. Register the helper again."
        );
      case "timeout":
        return result("no-answer", "No answer", "The app did not answer in time. Check that it is running, then check again.");
      default:
        return result("error", "Something went wrong", "The app could not answer. Check again in a moment.");
    }
  }

  const api = { HOST_NAME: HOST_NAME, EXPECTED_PROTOCOL: EXPECTED_PROTOCOL, describeStatus: describeStatus };
  root.SLVStatus = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
