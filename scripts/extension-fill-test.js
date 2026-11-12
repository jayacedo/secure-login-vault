// The extension's in-page fill (extension/fillInPage.js), generated from the app's own
// form filler. Checks the copy is current and that it behaves safely in a page.
//   npm run test:fill
const assert = require("assert");
const fs = require("fs");
const { JSDOM } = require("jsdom");
const { buildSource, OUTPUT } = require("./sync-extension-fill");
const { fillLoginForm } = require("../src/login/formFill");

const CREDENTIALS = { username: "alice@example.com", password: "S3cret pw! </script>" };
const OPTIONS = { submit: false, layout: false, skipUsernameOnly: false }; // jsdom has no layout

const PAGES = {
  classic: `<form id="f" action="/login" method="post"><input type="text" name="log" autocomplete="username"><input type="password" name="pwd" autocomplete="current-password"><input type="submit" value="Log In"></form>`,
  email: `<form><input type="email" name="email"><input type="password" name="password"><button>Sign in</button></form>`,
  twoStep: `<form><input type="email" name="identifier"><button>Next</button></form>`,
  none: `<h1>Welcome</h1><form><input type="search" name="q"><button>Search</button></form>`,
  honeypot: `<form><input type="text" name="user_trap" style="display:none"><input type="text" name="user" autocomplete="username"><input type="password" name="pw"></form>`,
  signup: `<form><input type="text" name="name"><input type="email" name="email" autocomplete="email"><input type="password" name="new" autocomplete="new-password"><input type="password" name="confirm" autocomplete="new-password"></form>`,
  twoForms: `<form id="newsletter"><input type="email" name="newsletter_email"><button>Subscribe</button></form><form id="login"><input type="text" name="username"><input type="password" name="password"></form>`
};

function openPage(html, url = "https://example.com/login") {
  return new JSDOM(`<!doctype html><title>t</title>${html}`, { url, runScripts: "outside-only", pretendToBeVisual: true });
}

// The extension's function, loaded into the page's own window like executeScript does.
function loadIntoPage(dom) {
  return dom.window.eval(`(${fs.readFileSync(OUTPUT, "utf8").replace(/^\/\/.*\n/gm, "")})`);
}

const values = (dom) => Object.fromEntries(Array.from(dom.window.document.querySelectorAll("input")).map((i) => [i.name, i.value]));

async function main() {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`PASS  ${name}`);
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${error.stack || error.message}`);
      process.exitCode = 1;
    }
  };

  await check("the generated file is current (run: npm run extension:sync-fill)", () => {
    assert.equal(fs.readFileSync(OUTPUT, "utf8"), buildSource());
  });

  await check("it contains no code of its own that talks to anything", () => {
    const source = fs.readFileSync(OUTPUT, "utf8");
    for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /chrome\./, /\bimport\b/, /\beval\s*\(/, /new Function/, /localStorage/, /document\.cookie/]) {
      assert.equal(pattern.test(source), false, `must not contain ${pattern}`);
    }
  });

  await check("it fills a login form on the expected origin and reports only a status", () => {
    const dom = openPage(PAGES.classic);
    const submitted = [];
    dom.window.document.getElementById("f").addEventListener("submit", () => submitted.push(1));
    const result = loadIntoPage(dom)("https://example.com", CREDENTIALS, OPTIONS);

    assert.equal(result.status, "filled");
    assert.deepEqual(values(dom), { log: "alice@example.com", pwd: "S3cret pw! </script>", "": "Log In" });
    assert.equal(JSON.stringify(result).includes("S3cret"), false, "the result never contains the password");
    assert.equal(JSON.stringify(result).includes("alice"), false, "nor the username");
    assert.deepEqual(submitted, [], "nothing is submitted");
    assert.equal(result.submitted, false);
  });

  await check("inline fills only its selected form and consumes its context", () => {
    const dom = openPage('<form><input name="firstUser"><input type="password" name="firstPass"></form><form><input name="secondUser"><input type="password" name="secondPass"></form>');
    const target = dom.window.document.querySelector('[name="secondPass"]');
    dom.window.slvInlineContext = { token: "chosen", expires: Date.now() + 60000, target, form: target.form, url: dom.window.location.href };
    const fill = loadIntoPage(dom);
    assert.equal(fill("https://example.com", CREDENTIALS, { ...OPTIONS, inlineToken: "chosen" }).status, "filled");
    assert.deepEqual(values(dom), { firstUser: "", firstPass: "", secondUser: CREDENTIALS.username, secondPass: CREDENTIALS.password });
    assert.equal(dom.window.slvInlineContext, null);
    assert.equal(fill("https://example.com", CREDENTIALS, { ...OPTIONS, inlineToken: "chosen" }).status, "blocked");
    dom.window.close();
  });

  await check("inline rejects expired, replaced, moved or redirected targets", () => {
    for (const scenario of ["expired", "token", "removed", "replaced", "moved", "action", "navigation", "hidden"]) {
      const dom = openPage(PAGES.classic + '<form id="other"></form>');
      const target = dom.window.document.querySelector('[type="password"]');
      const context = { token: "chosen", expires: Date.now() + 60000, target, form: target.form, url: dom.window.location.href };
      dom.window.slvInlineContext = context;
      if (scenario === "expired") context.expires = 0;
      if (scenario === "token") context.token = "other";
      if (scenario === "removed") target.remove();
      if (scenario === "replaced") target.replaceWith(target.cloneNode());
      if (scenario === "moved") dom.window.document.querySelector("#other").append(target);
      if (scenario === "action") context.form.action = "https://evil.test/";
      if (scenario === "navigation") dom.window.history.replaceState({}, "", "/other");
      if (scenario === "hidden") target.hidden = true;
      assert.equal(loadIntoPage(dom)("https://example.com", CREDENTIALS, { ...OPTIONS, inlineToken: "chosen" }).status, "blocked", scenario);
      assert.equal(target.value, "");
      dom.window.close();
    }
  });

  await check("a page that is not the expected origin is never touched", () => {
    for (const [pageUrl, expected] of [
      ["https://evil.test/login", "https://example.com"],
      ["https://example.com.evil.test/", "https://example.com"],
      ["https://www.example.com/", "https://example.com"],
      ["https://example.com:8443/", "https://example.com"],
      ["http://example.com/", "https://example.com"],
      ["https://example.com/", "https://example.com:8443"]
    ]) {
      const dom = openPage(PAGES.classic, pageUrl);
      const result = loadIntoPage(dom)(expected, CREDENTIALS, OPTIONS);
      assert.deepEqual(result, { status: "blocked" }, `${pageUrl} vs ${expected}`);
      assert.deepEqual(values(dom), { log: "", pwd: "", "": "Log In" });
    }
    for (const bad of [undefined, null, 5, {}, "", ["https://example.com"]]) {
      const dom = openPage(PAGES.classic);
      assert.deepEqual(loadIntoPage(dom)(bad, CREDENTIALS, OPTIONS), { status: "blocked" }, String(JSON.stringify(bad)));
      assert.equal(values(dom).pwd, "");
    }
  });

  await check("two-step logins, missing forms, honeypots, search boxes and sign-up forms", () => {
    const run = (name) => {
      const dom = openPage(PAGES[name]);
      return { dom, result: loadIntoPage(dom)("https://example.com", CREDENTIALS, OPTIONS) };
    };
    assert.equal(run("twoStep").result.status, "username-only");
    assert.equal(run("twoStep").dom.window.document.querySelector("input").value, "alice@example.com");

    const none = run("none");
    assert.equal(none.result.status, "no-form");
    assert.equal(none.dom.window.document.querySelector("input").value, "", "a search box is never filled");

    const honeypot = run("honeypot");
    assert.equal(honeypot.result.status, "filled");
    assert.equal(honeypot.dom.window.document.querySelector("[name=user_trap]").value, "", "a hidden field is left alone");
    assert.equal(honeypot.dom.window.document.querySelector("[name=user]").value, "alice@example.com");

    const signup = run("signup");
    assert.equal(signup.dom.window.document.querySelector("[name=new]").value, "", "a new-password field is not a login");

    const forms = run("twoForms");
    assert.equal(forms.dom.window.document.querySelector("[name=newsletter_email]").value, "", "the newsletter box is skipped");
    assert.equal(forms.dom.window.document.querySelector("[name=username]").value, "alice@example.com");
  });

  await check("it behaves exactly like the app's own filler on the same pages", () => {
    for (const name of Object.keys(PAGES)) {
      const mine = openPage(PAGES[name]);
      const theirs = openPage(PAGES[name]);
      const a = loadIntoPage(mine)("https://example.com", CREDENTIALS, OPTIONS);
      const b = fillLoginForm(theirs.window.document, CREDENTIALS, OPTIONS);
      assert.deepEqual(a, b, name);
      assert.deepEqual(values(mine), values(theirs), name);
    }
  });

  await check("junk credentials fill nothing and throw nothing", () => {
    for (const bad of [undefined, null, 5, "x", {}, { username: 5, password: {} }]) {
      const dom = openPage(PAGES.classic);
      const result = loadIntoPage(dom)("https://example.com", bad, OPTIONS);
      assert.ok(["filled", "username-only", "no-form"].includes(result.status), JSON.stringify(bad));
      assert.equal(values(dom).pwd, "");
    }
  });

  await check("options cannot turn on submitting by accident: the extension never asks for it", () => {
    const source = fs.readFileSync("extension/background.js", "utf8");
    assert.match(source, /FILL_OPTIONS = \{ submit: false, layout: true, skipUsernameOnly: false \}/);
  });

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nextension fill tests FAILED" : "\nextension fill tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
