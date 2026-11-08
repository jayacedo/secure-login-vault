const { resolveLoginUrl, originOf, canFillAt } = require("./siteLogin");

// "Which saved logins belong to the page the browser is on?"
//
// The rule is deliberately strict: a saved login matches only when its website has
// exactly the same origin (scheme + host + port) as the page, judged by the very same
// address rules the Sign in feature uses (resolveLoginUrl / canFillAt).
//   - no subdomain matching:  www.example.com is not example.com
//   - no look-alikes:         example.com.evil.test, evil-example.com
//   - no userinfo tricks:     https://example.com@evil.test/ is evil.test
//   - https only (plain http only for the local machine), never for any other http page
// Passwords are never part of the answer, only what is needed to show a choice.
//
// Pure: no Electron, no vault. The caller supplies the credentials it is allowed to show.

const MAX_RESULTS = 20;
const MAX_TEXT = 100;
const MAX_URL = 2048;

const clip = (value) => String(value || "").trim().slice(0, MAX_TEXT);

// Returns one of
//   { ok: true, host, logins: [{ id, name, username }] }
//   { ok: false, reason: "bad-url" | "unsupported-page" | "insecure-page" }
function matchLogins(pageUrl, credentials, { limit = MAX_RESULTS } = {}) {
  if (typeof pageUrl !== "string" || pageUrl.length === 0 || pageUrl.length > MAX_URL) {
    return { ok: false, reason: "bad-url" };
  }

  let page;
  try {
    page = new URL(pageUrl);
  } catch {
    return { ok: false, reason: "bad-url" };
  }
  if (page.protocol !== "https:" && page.protocol !== "http:") return { ok: false, reason: "unsupported-page" };
  if (page.username || page.password || !page.hostname) return { ok: false, reason: "unsupported-page" };

  const origin = originOf(pageUrl);
  if (!origin) return { ok: false, reason: "unsupported-page" };
  // Plain http is never matched (it could be read or altered on the way), except locally.
  if (!canFillAt(pageUrl, origin)) return { ok: false, reason: "insecure-page" };

  const logins = [];
  for (const credential of Array.isArray(credentials) ? credentials : []) {
    if (logins.length >= Math.min(limit, MAX_RESULTS)) break;
    if (!credential || typeof credential !== "object") continue;

    const saved = resolveLoginUrl(credential.websiteUrl);
    if (!saved.ok || saved.origin !== origin) continue;

    const id = Number(credential.id);
    if (!Number.isSafeInteger(id)) continue;

    logins.push({
      id,
      name: clip(credential.websiteName) || page.hostname,
      username: clip(credential.username) || clip(credential.email)
    });
  }

  return { ok: true, host: page.host, logins };
}

module.exports = { matchLogins, MAX_RESULTS };
