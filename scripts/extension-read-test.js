// slvReadFormInPage: what "Save this login" reads from the page, in a jsdom page.
//   npm run test:read
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const file = path.join(__dirname, "..", "extension", "readFormInPage.js");
const source = fs.readFileSync(file, "utf8");
const { slvReadFormInPage } = require(file);

function read(html, { url = "https://example.com/login", expected = "https://example.com", hide = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><title>t</title>${html}`, { url, runScripts: "outside-only" });
  const { window } = dom;
  // jsdom has no layout: report a size for everything except what the test marks as hidden
  for (const property of ["offsetWidth", "offsetHeight"]) {
    Object.defineProperty(window.HTMLElement.prototype, property, {
      get() { return this.hasAttribute("data-hidden") || hide.some((s) => this.matches(s)) ? 0 : 100; }
    });
  }
  const fn = window.eval(`(${slvReadFormInPage.toString()})`);
  return fn(expected);
}

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`PASS  ${name}`);
  } catch (error) {
    results.push(`FAIL  ${name}\n      ${error.stack || error.message}`);
    process.exitCode = 1;
  }
};

check("a typical login form: username before the password", () => {
  assert.deepEqual(read('<form><input type="text" value="alice"><input type="password" value="pw-1"></form>'), { status: "read", username: "alice", password: "pw-1" });
  assert.deepEqual(read('<form><input type="email" value=" a@b.test "><input type="password" value="pw-1"></form>'), { status: "read", username: "a@b.test", password: "pw-1" }, "trimmed");
  assert.deepEqual(read('<input type="tel" value="0917"><input type="password" value="pw-1">'), { status: "read", username: "0917", password: "pw-1" }, "no <form> needed");
});

check("the username is the last filled-in field before the password, not a field after it", () => {
  const html = '<input type="text" value="search term"><input type="text" value="alice"><input type="password" value="pw"><input type="text" value="after">';
  assert.equal(read(html).username, "alice");
  assert.equal(read('<input type="password" value="pw"><input type="text" value="after">').status, "no-username");
});

check("hidden fields and checkboxes are not mistaken for the login", () => {
  assert.equal(read('<input type="hidden" value="token"><input type="checkbox" value="on"><input type="text" value="alice"><input type="password" value="pw">').username, "alice");
  assert.equal(read('<input type="text" value="trap" data-hidden><input type="text" value="alice"><input type="password" value="pw">').username, "alice", "a hidden text field is skipped");
  assert.equal(read('<input type="text" value="alice"><input type="password" value="trap" data-hidden>').status, "no-form", "a hidden password is skipped");
  assert.equal(read('<input type="text" value="alice"><input type="password" value="pw" disabled>').status, "no-form");
});

check("credentials come from the same form, including externally associated inputs", () => {
  assert.equal(read('<form><input value="search-user"></form><form><input type="password" value="pw"></form>').status, "no-username");
  assert.equal(read('<form><input value="unused"><input type="password"></form><form><input value="alice"><input type="password" value="pw"></form>').username, "alice");
  assert.equal(read('<form id="login"><input type="password" value="pw"></form><form><input value="other"></form><input form="login" value="too-late">').status, "no-username");
  assert.equal(read('<input form="login" value="alice"><form id="login"><input type="password" value="pw"></form>').username, "alice");
  assert.equal(read('<form><input value="alice"><input type="password" value="pw"></form><form><input value="bob"><input type="password" value="pw"></form>').status, "ambiguous");
});

check("username hints take precedence and search fields are never usernames", () => {
  assert.equal(read('<input value="alice" autocomplete="section-login username"><input value="other text"><input type="password" value="pw">').username, "alice");
  assert.equal(read('<input type="search" value="a search"><input type="password" value="pw">').status, "no-username");
  assert.equal(read('<input type="password"><input value="alice"><input type="password" value="pw">').username, "alice");
});

check("sign-up forms with a confirmation that matches are fine; different passwords are refused", () => {
  assert.equal(read('<input type="text" value="alice"><input type="password" value="pw"><input type="password" value="pw">').password, "pw");
  assert.equal(read('<input type="text" value="alice"><input type="password" value="old"><input type="password" value="new"><input type="password" value="new">').status, "ambiguous");
  assert.equal(read('<input type="text" value="alice"><input type="password" value="pw"><input type="password" value="">').password, "pw", "an empty confirmation field is ignored");
});

check("missing pieces are reported, nothing is guessed", () => {
  assert.equal(read("<p>hello</p>").status, "no-form");
  assert.equal(read('<input type="text" value="alice"><input type="password" value="">').status, "empty");
  assert.equal(read('<input type="text" value=""><input type="password" value="pw">').status, "no-username");
  assert.equal(read('<input type="text" value="   "><input type="password" value="pw">').status, "no-username");
});

check("sizes the app would refuse are reported here", () => {
  assert.equal(read(`<input type="text" value="${"u".repeat(257)}"><input type="password" value="pw">`).status, "too-long");
  assert.equal(read(`<input type="text" value="alice"><input type="password" value="${"p".repeat(1025)}">`).status, "too-long");
  assert.equal(read(`<input type="text" value="${"u".repeat(256)}"><input type="password" value="${"p".repeat(1024)}">`).status, "read");
});

check("a page that is not at the origin the worker looked at reads nothing", () => {
  const html = '<input type="text" value="alice"><input type="password" value="pw">';
  const moved = read(html, { url: "https://evil.test/login" });
  assert.deepEqual(moved, { status: "blocked" });
  assert.equal(JSON.stringify(moved).includes("pw"), false);
  assert.equal(read(html, { url: "https://example.com:8443/", expected: "https://example.com" }).status, "blocked");
  assert.equal(read(html, { url: "http://example.com/", expected: "https://example.com" }).status, "blocked");
});

check("it only reads: the page is left exactly as it was, and no network or eval is used", () => {
  assert.equal(/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|eval|Function\(|innerHTML|\.submit\(|\.click\(|dispatchEvent|\.value\s*=[^=])/.test(source), false);
});

console.log(results.join("\n"));
console.log(process.exitCode ? "\nread tests FAILED" : `\nAll ${results.length} read checks passed.`);
