// Reads what the person typed into the login form of the current page, for "Save this login".
// The background worker injects slvReadFormInPage into the tab's main page only. It must be
// completely self-contained (it is copied into the page as text). It never changes
// the DOM or sends anything anywhere. A retry keeps only an opaque document token
// in the isolated world, never credentials. Results return only to the worker.
//
// Returns { status } where status is
//   "read"       also { username, password }
//   "blocked"    the page is not at the origin the worker looked at (it moved on)
//   "no-form"    no visible password field
//   "empty"      the password field is empty
//   "ambiguous"  several different passwords (for example a change-password form)
//   "no-username" no username was typed before the password
//   "too-long"   a value is larger than the app accepts
function slvReadFormInPage(expectedOrigin, submittedForm, options) {
  options = options || {};
  var MAX_USERNAME = 256;
  var MAX_PASSWORD = 1024;

  if (location.origin !== expectedOrigin) return { status: "blocked" };
  // A manual username retry is tied to this exact document, URL and short-lived
  // popup request. Only an opaque token is retained in the isolated world.
  if (options.verifyToken) {
    var context = globalThis.slvSaveUsernameContext;
    delete globalThis.slvSaveUsernameContext;
    if (!context || context.token !== options.verifyToken || context.url !== location.href || context.expires <= Date.now()) return { status: "blocked" };
  }

  function visible(element) {
    if (element.disabled || element.type === "hidden") return false;
    var rects = element.getClientRects ? element.getClientRects().length : 0;
    if (!(element.offsetWidth > 0 || element.offsetHeight > 0 || rects > 0)) return false;
    var style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  var inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
  if (submittedForm) inputs = inputs.filter(function (input) { return input.form === submittedForm; });
  var passwords = inputs.filter(function (input) {
    return input.type === "password" && visible(input);
  });
  if (!passwords.length) {
    if (options.readUsernameStep) {
      var users = inputs.filter(function (input) {
        return visible(input) && ["text", "email", "tel"].includes(input.type) &&
          ((input.autocomplete || "").split(/\s+/).includes("username") || input.type === "email");
      }).filter(function (input) { return input.value.trim(); });
      if (users.length === 1 && users[0].value.trim().length <= MAX_USERNAME) return { status: "username-only", username: users[0].value.trim() };
    }
    return { status: "no-form" };
  }

  // Choose the form containing the typed password. Never combine a username from
  // another form (for example search, newsletter signup, or a second login).
  var filled = passwords.filter(function (input) { return Boolean(input.value); });
  if (!filled.length) return { status: "empty" };
  var first = filled[0];
  if (filled.some(function (input) { return input.form !== first.form; })) return { status: "ambiguous" };
  passwords = passwords.filter(function (input) { return input.form === first.form; });

  var typed = [];
  passwords.forEach(function (input) {
    if (input.value && typed.indexOf(input.value) === -1) typed.push(input.value);
  });
  if (!typed.length) return { status: "empty" };
  if (typed.length > 1) return { status: "ambiguous" }; // old + new password, or a mistyped confirmation
  var password = typed[0];

  // The username is the last text-like field before the first password field that has something in it.
  var username = "";
  var explicitUsername = "";
  inputs.forEach(function (input) {
    if (input.form !== first.form) return;
    if (input === first || !(first.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_PRECEDING)) return;
    var type = (input.getAttribute("type") || "text").toLowerCase();
    if (["text", "email", "tel"].indexOf(type) === -1 || !visible(input)) return;
    if (input.value && input.value.trim()) {
      username = input.value.trim();
      if ((input.autocomplete || "").split(/\s+/).includes("username")) explicitUsername = username;
    }
  });
  username = explicitUsername || username;
  // Google's password step renders the chosen account outside the form. Limit
  // this adapter to its exact origin and selected-account markers, not page text.
  if (!username && location.origin === "https://accounts.google.com") {
    var accounts = Array.from(document.querySelectorAll("#profileIdentifier, [data-profile-identifier]"))
      .filter(visible).map(function (element) { return (element.getAttribute("data-profile-identifier") || element.textContent || "").trim(); })
      .filter(function (value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= MAX_USERNAME; });
    var unique = Array.from(new Set(accounts));
    if (unique.length === 1) username = unique[0];
  }
  if (!username && typeof options.username === "string") username = options.username.trim();
  if (password.length > MAX_PASSWORD) return { status: "too-long" };
  if (!username) {
    if (options.contextToken) globalThis.slvSaveUsernameContext = { token: options.contextToken, url: location.href, expires: Date.now() + 120000 };
    return options.allowMissingUsername ? { status: "no-username", password: password } : { status: "no-username" };
  }

  if (username.length > MAX_USERNAME || password.length > MAX_PASSWORD) return { status: "too-long" };
  return { status: "read", username: username, password: password };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { slvReadFormInPage: slvReadFormInPage };
}
