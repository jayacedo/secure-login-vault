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
    layout: !(options && options.layout === false)
  });

  return `(${fillLoginForm.toString()})(document, ${payload}, ${settings})`;
}

module.exports = {
  isLoopbackHost,
  resolveLoginUrl,
  originOf,
  canFillAt,
  buildFillScript
};
