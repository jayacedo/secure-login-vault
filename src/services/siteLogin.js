const { fillLoginForm } = require("../login/formFill");

// Rules for the "Sign in" feature (opening a saved site and filling its login
// form). Everything here is pure so it can be tested without Electron.

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

// Turns what the user saved as a "website" into a URL we are willing to open and
// fill. Passwords are only ever filled over https (plain http only for the
// local machine), so anything else is reported, not fixed up silently.
//
//   { ok: true,  url, origin, host }         safe to open and fill
//   { ok: false, reason, url?, origin? }     reason: empty | invalid | unsupported | insecure
//
// "insecure" still carries the url so the caller may open it without filling.
function resolveLoginUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > 2048) return { ok: false, reason: "invalid" };

  let candidate = text;
  const hasAuthority = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const looksLikeHostPort = /^[^:/?#]+:\d+(\/|$|\?|#)/.test(text);

  if (!hasAuthority) {
    // "javascript:...", "mailto:...", "C:\\..." and similar are not websites.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !looksLikeHostPort) {
      return { ok: false, reason: "unsupported" };
    }
    let guess;
    try {
      guess = new URL(`https://${text}`);
    } catch {
      return { ok: false, reason: "invalid" };
    }
    candidate = `${isLoopbackHost(guess.hostname) ? "http" : "https"}://${text}`;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported" };
  }
  // https://paypal.com@evil.example/ would otherwise look like paypal.com.
  if (url.username || url.password || !url.hostname) {
    return { ok: false, reason: "invalid" };
  }

  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return { ok: false, reason: "insecure", url: url.href, origin: url.origin };
  }

  return { ok: true, url: url.href, origin: url.origin, host: url.hostname };
}

function originOf(value) {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

// True only when the page we are about to fill is exactly the site that was
// saved: same scheme, host and port, and still https (or local http). A page
// that redirected somewhere else, or a look-alike host, never matches.
function canFillAt(currentUrl, expectedOrigin) {
  const current = originOf(currentUrl);
  if (!current || !expectedOrigin || current !== expectedOrigin) return false;

  const { protocol, hostname } = new URL(currentUrl);
  return protocol === "https:" || (protocol === "http:" && isLoopbackHost(hostname));
}

// Source text to run inside the page (in an isolated world). The credentials are
// embedded as JSON data, never concatenated as code.
function buildFillScript(credentials, options) {
  const toLiteral = (value) =>
    JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

  const payload = toLiteral({
    username: String((credentials && credentials.username) || ""),
    password: String((credentials && credentials.password) || "")
  });
  const settings = toLiteral({
    submit: Boolean(options && options.submit),
    layout: !(options && options.layout === false),
    skipUsernameOnly: Boolean(options && options.skipUsernameOnly)
  });

  // Last line of defence: the page may have navigated between the caller's
  // origin check and this script running, so it re-checks where it is running.
  const guard =
    options && options.expectedOrigin
      ? `if (location.origin !== ${toLiteral(String(options.expectedOrigin))}) { return { status: "blocked" }; } `
      : "";

  return `(function () { ${guard}return (${fillLoginForm.toString()})(document, ${payload}, ${settings}); })()`;
}

// What the "Sign in" button needs from a saved entry. Returns the target to open
// and fill, or { ok: false, reason } with a reason from resolveLoginUrl or:
//   "no-credentials" (nothing to fill) | "unknown" (bad request)
function buildLoginTarget(kind, record, which) {
  if (!record || typeof record !== "object") return { ok: false, reason: "unknown" };

  let rawUrl;
  let username;
  let password;
  let label;

  if (kind === "credential") {
    rawUrl = record.websiteUrl;
    username = record.username || record.email;
    password = record.password;
    label = record.websiteName;
  } else if (kind === "client" && which === "admin") {
    rawUrl = record.adminUrl;
    username = record.adminUsername;
    password = record.adminPassword;
    label = `${record.name} - WP Admin`;
  } else if (kind === "client" && which === "hosting") {
    rawUrl = record.hostingUrl;
    username = record.hostingUsername;
    password = record.hostingPassword;
    label = `${record.name} - Hosting`;
  } else if (kind === "client" && which === "phpmyadmin") {
    rawUrl = record.phpMyAdminUrl;
    username = record.dbUsername;
    password = record.dbPassword;
    label = `${record.name} - phpMyAdmin`;
  } else {
    return { ok: false, reason: "unknown" };
  }

  const resolved = resolveLoginUrl(rawUrl);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  if (!username && !password) return { ok: false, reason: "no-credentials" };

  return {
    ok: true,
    url: resolved.url,
    origin: resolved.origin,
    host: resolved.host,
    username: String(username || ""),
    password: String(password || ""),
    label: String(label || resolved.host)
  };
}

// Plain-language message for a refused target; safe to show to the user.
function describeTargetProblem(reason) {
  switch (reason) {
    case "empty":
      return "This entry has no website address to open.";
    case "invalid":
    case "unsupported":
      return "This entry's website address is not a valid web address.";
    case "insecure":
      return "This site uses plain http, so Secure Login Vault will not fill a password there. Open it in your browser instead.";
    case "no-credentials":
      return "This entry has no saved username or password to fill in.";
    default:
      return "Could not open this entry.";
  }
}

module.exports = {
  isLoopbackHost,
  resolveLoginUrl,
  originOf,
  canFillAt,
  buildFillScript,
  buildLoginTarget,
  describeTargetProblem
};
