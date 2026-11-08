const assert = require("assert");
const { JSDOM } = require("jsdom");
const { fillLoginForm } = require("../src/login/formFill");
const { resolveLoginUrl, originOf, canFillAt, buildFillScript, isLoopbackHost } = require("../src/services/siteLogin");

// ── URL rules ────────────────────────────────────────────────────────────────

function ok(input) {
  const result = resolveLoginUrl(input);
  assert.equal(result.ok, true, `${input} should be allowed: ${JSON.stringify(result)}`);
  return result;
}

function refused(input, reason) {
  const result = resolveLoginUrl(input);
  assert.equal(result.ok, false, `${input} should be refused`);
  assert.equal(result.reason, reason, `${input}: ${JSON.stringify(result)}`);
  return result;
}

assert.equal(ok("https://example.com/wp-login.php").url, "https://example.com/wp-login.php");
assert.equal(ok("  example.com/wp-admin  ").url, "https://example.com/wp-admin", "no scheme defaults to https");
assert.equal(ok("example.com:8443/login").origin, "https://example.com:8443");
assert.equal(ok("localhost:8080/wp-admin").url, "http://localhost:8080/wp-admin", "local sites default to http");
assert.equal(ok("http://localhost:3000").origin, "http://localhost:3000");
assert.equal(ok("http://127.0.0.1/login").origin, "http://127.0.0.1");
assert.equal(ok("http://site.localhost/").origin, "http://site.localhost");
assert.equal(ok("http://[::1]:5173/").host, "[::1]");
assert.equal(ok("HTTPS://Example.COM/A").origin, "https://example.com");
assert.equal(ok("192.168.1.5/wp-admin").url, "https://192.168.1.5/wp-admin", "LAN addresses default to https");

refused("", "empty");
refused("   ", "empty");
refused(null, "empty");
refused(undefined, "empty");
refused(42, "empty");
refused("javascript:alert(1)", "unsupported");
refused("JavaScript://%0aalert(1)", "unsupported");
refused("data:text/html,hi", "unsupported");
refused("mailto:a@b.com", "unsupported");
refused("file:///C:/Windows/win.ini", "unsupported");
refused("C:\\Users\\me\\x.html", "unsupported");
refused("ftp://example.com/", "unsupported");
refused("https://paypal.com@evil.example/", "invalid");
refused("https://user:pass@example.com/", "invalid");
refused("https://", "invalid");
refused("http://", "invalid");
refused("https://" + "a".repeat(3000) + ".com", "invalid");

const insecure = refused("http://example.com/wp-login.php", "insecure");
assert.equal(insecure.url, "http://example.com/wp-login.php", "insecure sites can still be opened, just not filled");
refused("http://192.168.1.5/", "insecure");
refused("http://site.local/", "insecure");
refused("http://localhost.evil.com/", "insecure");

assert.equal(isLoopbackHost("localhost"), true);
assert.equal(isLoopbackHost("127.0.0.1"), true);
assert.equal(isLoopbackHost("127.0.0.1.evil.com"), false);
assert.equal(isLoopbackHost("notlocalhost"), false);

// ── Origin matching ──────────────────────────────────────────────────────────

const origin = "https://example.com";
assert.equal(originOf("https://example.com/a?b#c"), origin);
assert.equal(originOf("not a url"), null);
assert.equal(originOf("data:text/html,x"), null);

assert.equal(canFillAt("https://example.com/wp-login.php?redirect_to=x", origin), true);
assert.equal(canFillAt("https://example.com:443/login", origin), true, "default port is the same origin");
assert.equal(canFillAt("https://www.example.com/login", origin), false, "other subdomain");
assert.equal(canFillAt("https://example.com.evil.com/login", origin), false, "look-alike host");
assert.equal(canFillAt("https://evil.com/?https://example.com", origin), false);
assert.equal(canFillAt("https://example.com:8443/login", origin), false, "other port");
assert.equal(canFillAt("http://example.com/login", origin), false, "downgraded to http");
assert.equal(canFillAt("http://example.com/login", "http://example.com"), false, "plain http is never filled");
assert.equal(canFillAt("http://localhost:3000/login", "http://localhost:3000"), true, "local http is allowed");
assert.equal(canFillAt("about:blank", origin), false);
assert.equal(canFillAt("https://example.com/", null), false);
assert.equal(canFillAt("", origin), false);

// ── Form filling (against real DOM documents) ────────────────────────────────

function page(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: "outside-only" });
  return dom.window.document;
}

// Records every submit so the tests can assert on it without navigating.
function trackSubmits(doc) {
  const submits = [];
  doc.querySelectorAll("form").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submits.push(form.id || "(form)");
    });
  });
  return submits;
}

const CREDS = { username: "admin@client.com", password: "p@ss w0rd!" };
const OPTS = { submit: false };

// WordPress login
{
  const doc = page(`
    <form id="loginform" action="/wp-login.php" method="post">
      <p><label for="user_login">Username or Email Address</label>
      <input type="text" name="log" id="user_login" autocomplete="username" /></p>
      <p><label for="user_pass">Password</label>
      <input type="password" name="pwd" id="user_pass" autocomplete="current-password" /></p>
      <input type="checkbox" name="rememberme" id="rememberme" />
      <input type="submit" name="wp-submit" id="wp-submit" value="Log In" />
    </form>`);
  const submits = trackSubmits(doc);

  const result = fillLoginForm(doc, CREDS, OPTS);
  assert.deepEqual(result, { status: "filled", filledUsername: true, filledPassword: true, submitted: false });
  assert.equal(doc.querySelector("#user_login").value, CREDS.username);
  assert.equal(doc.querySelector("#user_pass").value, CREDS.password);
  assert.deepEqual(submits, [], "no submit unless asked");

  const again = fillLoginForm(doc, CREDS, { submit: true });
  assert.equal(again.submitted, true);
  assert.deepEqual(submits, ["loginform"]);
}

// Frameworks listen for input/change events, not just the value
{
  const doc = page(`<form><input name="email" type="email" /><input type="password" /><button>Sign in</button></form>`);
  const seen = [];
  doc.querySelectorAll("input").forEach((input) => {
    ["input", "change"].forEach((type) => input.addEventListener(type, () => seen.push(`${input.type}:${type}`)));
  });
  fillLoginForm(doc, CREDS, OPTS);
  assert.deepEqual(seen.sort(), ["email:change", "email:input", "password:change", "password:input"]);
}

// Generic form without autocomplete hints, button without a type (defaults to submit)
{
  const doc = page(`
    <form id="f"><input name="uname"><input type="password" name="pw"><button>Enter</button></form>`);
  const submits = trackSubmits(doc);
  const result = fillLoginForm(doc, CREDS, { submit: true });
  assert.equal(result.status, "filled");
  assert.equal(doc.querySelector("[name=uname]").value, CREDS.username);
  assert.equal(result.submitted, true);
  assert.deepEqual(submits, ["f"]);
}

// A newsletter box elsewhere on the page never receives the username
{
  const doc = page(`
    <form id="news"><input type="email" name="newsletter_email" placeholder="Your email"><button>Subscribe</button></form>
    <form id="login"><input type="text" name="login"><input type="password"><button type="submit">Log in</button></form>`);
  const submits = trackSubmits(doc);
  fillLoginForm(doc, CREDS, { submit: true });
  assert.equal(doc.querySelector("[name=newsletter_email]").value, "");
  assert.equal(doc.querySelector("[name=login]").value, CREDS.username);
  assert.deepEqual(submits, ["login"], "the login form is submitted, not the newsletter form");
}

// Sign-up and change-password forms are left alone
{
  const doc = page(`
    <form><input name="email" type="email"><input type="password" name="p1"><input type="password" name="p2"><button>Create account</button></form>`);
  const result = fillLoginForm(doc, CREDS, { submit: true });
  assert.equal(result.status, "no-form");
  assert.equal(doc.querySelector("[name=p1]").value, "");
  assert.equal(doc.querySelector("[name=email]").value, "");
}
{
  const doc = page(`
    <form><input type="password" autocomplete="new-password"><button>Save</button></form>`);
  assert.equal(fillLoginForm(doc, CREDS, OPTS).status, "no-form");
}

// Hidden, disabled and read-only fields are never touched
{
  const doc = page(`
    <form id="trap" style="display:none"><input name="u1"><input type="password" name="trap_pw"></form>
    <form id="real">
      <input name="honeypot" style="display:none">
      <input name="user"><input type="password" name="pw"><button>Go</button>
    </form>`);
  fillLoginForm(doc, CREDS, OPTS);
  assert.equal(doc.querySelector("[name=trap_pw]").value, "");
  assert.equal(doc.querySelector("[name=u1]").value, "");
  assert.equal(doc.querySelector("[name=honeypot]").value, "");
  assert.equal(doc.querySelector("[name=user]").value, CREDS.username);
  assert.equal(doc.querySelector("[name=pw]").value, CREDS.password);
}
{
  const doc = page(`<form><input name="user"><input type="password" disabled><button>Go</button></form>`);
  assert.equal(fillLoginForm(doc, CREDS, OPTS).status, "no-form");
}
{
  const doc = page(`<form><input name="user"><input type="password" readonly><button>Go</button></form>`);
  assert.equal(fillLoginForm(doc, CREDS, OPTS).status, "no-form");
}

// Formless page (single-page apps): the field before the password is used
{
  const doc = page(`
    <div class="app"><div class="box"><input name="email" type="email"><input type="password"><button>Sign in</button></div></div>`);
  const clicked = [];
  doc.querySelector("button").addEventListener("click", () => clicked.push("click"));
  const result = fillLoginForm(doc, CREDS, { submit: true });
  assert.equal(result.filledUsername, true);
  assert.equal(doc.querySelector("[name=email]").value, CREDS.username);
  assert.deepEqual(clicked, ["click"], "falls back to clicking the button when there is no form");
}

// Password-only credentials (no username saved)
{
  const doc = page(`<form><input name="user"><input type="password"><button>Go</button></form>`);
  const result = fillLoginForm(doc, { username: "", password: "pw-only" }, OPTS);
  assert.equal(result.filledUsername, false);
  assert.equal(result.filledPassword, true);
  assert.equal(doc.querySelector("[name=user]").value, "");
}

// Two-step login: username first, password on the next screen
{
  const doc = page(`
    <form id="step1"><input type="email" name="identifier" autocomplete="username"><button type="submit">Next</button></form>`);
  const submits = trackSubmits(doc);
  const result = fillLoginForm(doc, CREDS, { submit: true });
  assert.deepEqual(result, { status: "username-only", filledUsername: true, filledPassword: false, submitted: true });
  assert.equal(doc.querySelector("[name=identifier]").value, CREDS.username);
  assert.deepEqual(submits, ["step1"]);
}

// A lone newsletter or sign-up box is not the first step of a two-step login
// (this is what stops the app from filling and submitting it by mistake)
{
  const doc = page(`
    <form id="news"><input type="email" name="newsletter_email" placeholder="Your email"><button type="submit">Subscribe</button></form>`);
  const submits = trackSubmits(doc);
  const result = fillLoginForm(doc, CREDS, { submit: true });
  assert.equal(result.status, "no-form");
  assert.equal(doc.querySelector("[name=newsletter_email]").value, "");
  assert.deepEqual(submits, []);
}

// On a page without a <form>, a nearby search or code field is not the username
{
  const doc = page(`<div><input name="user_search" placeholder="Search users"><input type="password"><button>Sign in</button></div>`);
  const result = fillLoginForm(doc, CREDS, OPTS);
  assert.equal(result.filledPassword, true);
  assert.equal(result.filledUsername, false);
  assert.equal(doc.querySelector("[name=user_search]").value, "");
}

// A lone search box is not a login field
{
  const doc = page(`<form><input type="text" name="q" placeholder="Search"><button>Go</button></form>`);
  const result = fillLoginForm(doc, CREDS, { submit: true });
  assert.equal(result.status, "no-form");
  assert.equal(doc.querySelector("[name=q]").value, "");
}

// Nothing on the page
assert.equal(fillLoginForm(page("<p>Hello</p>"), CREDS, OPTS).status, "no-form");

// Missing credentials never throw
assert.equal(fillLoginForm(page("<p>Hello</p>"), undefined, undefined).status, "no-form");

// ── The injected script ──────────────────────────────────────────────────────

// Secrets full of characters that would break naive string building.
const NASTY = [
  `quote" and 'single' and \`tick\``,
  "back\\slash \\u0041 \\n",
  "line1\nline2\r\n\u2028\u2029",
  "${process.exit(1)} + </script><img src=x>",
  "\u00e9\u00e8 \u4e2d\u6587 \ud83d\ude00"
];

for (const secret of NASTY) {
  const dom = new JSDOM(
    `<!doctype html><form id="f"><input name="user"><input type="password" name="pw"><button>Go</button></form>`,
    { runScripts: "outside-only" }
  );
  const submits = [];
  dom.window.document.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    submits.push(1);
  });

  const script = buildFillScript({ username: secret, password: secret }, { submit: true, layout: false });
  const result = dom.window.eval(script);

  // Single-line inputs drop CR/LF themselves (HTML value sanitization); nothing
  // else may change, and the script must still parse and run.
  const expected = secret.replace(/[\r\n]/g, "");
  assert.equal(result.status, "filled");
  assert.equal(dom.window.document.querySelector("[name=user]").value, expected, "username survives intact");
  assert.equal(dom.window.document.querySelector("[name=pw]").value, expected, "password survives intact");
  assert.equal(submits.length, 1);
}

// The script is self-contained: it runs with no access to this module's scope.
{
  const script = buildFillScript(CREDS, { layout: false });
  assert.equal(script.includes("require("), false);
  assert.equal(script.startsWith("(function fillLoginForm"), true);
  assert.equal(script.includes(CREDS.password), true, "credentials are embedded as data");
  const dom = new JSDOM(`<form><input name="u"><input type="password"><button>x</button></form>`, {
    runScripts: "outside-only"
  });
  assert.equal(dom.window.eval(script).status, "filled");
}

console.log("site-login tests passed");
