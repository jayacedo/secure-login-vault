// End-to-end test of the "Sign in" window. Run it with:  npm run test:login-window
// It starts small local web servers, opens real (hidden) Electron windows at
// them through the same code the app uses, and checks what the servers receive.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { app } = require("electron");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "slv-login-window-")));

// Electron quits by default when the last window closes, which happens between
// scenarios here (the real app always has its main window open).
app.on("window-all-closed", () => {});

const { createLoginWindows } = require("../src/services/loginWindows");
const { buildLoginTarget } = require("../src/services/siteLogin");

const USER = "admin@client.test";
const PASS = "p@ss w0rd!&=%";

function page(body, head = "") {
  return `<!doctype html><html><head><title>Test page</title>${head}</head><body>${body}</body></html>`;
}

const WP_FORM = (action) => `
  <form method="post" action="${action}" id="loginform">
    <input type="text" name="log" id="user_login" autocomplete="username">
    <input type="password" name="pwd" id="user_pass" autocomplete="current-password">
    <input type="submit" id="wp-submit" value="Log In">
  </form>`;

function startServer(label, handler) {
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const fields = Object.fromEntries(new URLSearchParams(raw));
        posts.push({ path: req.url, fields });
        handler(req, res, { posted: true, fields });
      });
    } else {
      handler(req, res, { posted: false });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ label, server, posts, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function html(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

async function waitFor(predicate, timeoutMs, what) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  await app.whenReady();

  const external = [];
  const manager = createLoginWindows({
    show: false,
    isDevelopment: false,
    openExternal: (url) => external.push(url)
  });

  // Site B is a different origin (different port): the "wrong site" in redirect tests.
  const other = await startServer("other", (req, res) => html(res, page(WP_FORM("/wp-login.php"))));

  const site = await startServer("site", (req, res, ctx) => {
    const url = new URL(req.url, "http://x");

    if (url.pathname === "/wp-login.php") {
      return html(res, ctx.posted ? page("<h1>Dashboard</h1>") : page(WP_FORM("/wp-login.php")));
    }
    if (url.pathname === "/spa") {
      // The login form is drawn late, like a single-page app.
      return html(
        res,
        page(
          `<div id="root">Loading...</div>
           <script>setTimeout(function () {
             document.getElementById("root").innerHTML = ${JSON.stringify(WP_FORM("/spa-post"))};
           }, 1500);</script>`
        )
      );
    }
    if (url.pathname === "/spa-post") return html(res, page("<h1>Welcome</h1>"));
    if (url.pathname === "/step1") {
      if (!ctx.posted) {
        return html(
          res,
          page(`<form method="post" action="/step1"><input type="email" name="identifier" autocomplete="username"><button type="submit">Next</button></form>`)
        );
      }
      return html(
        res,
        page(`<form method="post" action="/step2"><input type="hidden" name="identifier" value="kept"><input type="password" name="pwd" autocomplete="current-password"><button type="submit">Sign in</button></form>`)
      );
    }
    if (url.pathname === "/step2") return html(res, page("<h1>Signed in</h1>"));
    if (url.pathname === "/redirect") {
      res.writeHead(302, { Location: `${other.origin}/wp-login.php` });
      return res.end();
    }
    if (url.pathname === "/wrong-password") {
      // Always rejects: shows the login form again with an error.
      return html(res, page(`<p class="error">Wrong password</p>${WP_FORM("/wrong-password")}`));
    }
    if (url.pathname === "/hooked") {
      return html(
        res,
        page(WP_FORM("/hooked-post"), `<script>
          window.__hookHits = 0;
          var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          Object.defineProperty(HTMLInputElement.prototype, "value", {
            get: function () { return d.get.call(this); },
            set: function (v) { window.__hookHits++; d.set.call(this, v); }
          });
        </script>`)
      );
    }
    if (url.pathname === "/hooked-post") return html(res, page("<h1>ok</h1>"));
    if (url.pathname === "/no-form") return html(res, page("<h1>Just a page</h1>"));
    return html(res, page("not found"), 404);
  });

  const targetFor = (server, pathName, extra = {}) => {
    const target = buildLoginTarget("credential", {
      websiteName: "Test",
      websiteUrl: `${server.origin}${pathName}`,
      username: USER,
      password: PASS
    });
    assert.equal(target.ok, true, `target for ${pathName}`);
    return { ...target, submit: true, ...extra };
  };

  const results = [];
  async function scenario(name, fn) {
    manager.closeAll();
    site.posts.length = 0;
    other.posts.length = 0;
    console.log(`...   ${name}`);
    try {
      await fn();
      results.push(`PASS  ${name}`);
    } catch (error) {
      results.push(`FAIL  ${name}\n      ${error.message}`);
      process.exitCode = 1;
    }
  }

  await scenario("fills and submits a WordPress-style login", async () => {
    manager.open(targetFor(site, "/wp-login.php"));
    await waitFor(() => site.posts.length >= 1, 10000, "the login POST");
    assert.deepEqual(site.posts[0], { path: "/wp-login.php", fields: { log: USER, pwd: PASS } });
  });

  await scenario("waits for a login form that appears late (single-page app)", async () => {
    manager.open(targetFor(site, "/spa"));
    await waitFor(() => site.posts.length >= 1, 12000, "the late form to be filled");
    assert.deepEqual(site.posts[0].fields, { log: USER, pwd: PASS });
  });

  await scenario("handles a two-step login (username, then password)", async () => {
    manager.open(targetFor(site, "/step1"));
    await waitFor(() => site.posts.some((p) => p.path === "/step2"), 12000, "the password step");
    const first = site.posts.find((p) => p.path === "/step1");
    const second = site.posts.find((p) => p.path === "/step2");
    assert.equal(first.fields.identifier, USER);
    assert.equal(second.fields.pwd, PASS);
  });

  await scenario("never fills a different site after a redirect", async () => {
    const { window: win } = manager.open(targetFor(site, "/redirect"));
    await waitFor(() => win.webContents.getURL().startsWith(other.origin), 10000, "the redirect");
    await sleep(3500); // longer than the fill retries that matter
    assert.equal(other.posts.length, 0, "the other site received a login");
    const values = await win.webContents.executeJavaScript(
      `[document.querySelector("[name=log]").value, document.querySelector("[name=pwd]").value]`
    );
    assert.deepEqual(values, ["", ""], "fields on the other site must stay empty");
    assert.ok(win.getTitle().includes(`127.0.0.1:${other.port}`), `title shows the real host: ${win.getTitle()}`);
  });

  await scenario("does not retry a wrong password", async () => {
    manager.open(targetFor(site, "/wrong-password"));
    await waitFor(() => site.posts.length >= 1, 10000, "the first attempt");
    await sleep(4000);
    assert.equal(site.posts.length, 1, `expected exactly one attempt, got ${site.posts.length}`);
  });

  await scenario("page scripts cannot hook the fill", async () => {
    // No auto-submit here, so the page (and its counter) stays around to inspect.
    const { window: win } = manager.open(targetFor(site, "/hooked", { submit: false }));
    const read = (code) => win.webContents.executeJavaScript(code);

    let filled = "";
    await waitFor(
      () => {
        read(`document.querySelector("[name=pwd]").value`).then((value) => (filled = value));
        return filled === PASS;
      },
      10000,
      "the password to be filled"
    );

    assert.equal(await read("window.__hookHits"), 0, "the page's own value setter saw the fill");

    // Control: the hook really does work for the page's own writes.
    await read(`document.querySelector("[name=log]").value = "page-write"`);
    assert.equal(await read("window.__hookHits"), 1, "the test hook is not active");
  });

  await scenario("a page without a login form is left alone", async () => {
    const { window: win } = manager.open(targetFor(site, "/no-form"));
    await sleep(2500);
    assert.equal(site.posts.length, 0);
    assert.equal(win.isDestroyed(), false);
  });

  await scenario("denies permission requests (geolocation)", async () => {
    const { window: win } = manager.open(targetFor(site, "/no-form"));
    await waitFor(() => !win.webContents.isLoading(), 8000, "page load");
    const state = await win.webContents.executeJavaScript(
      `navigator.permissions.query({ name: "geolocation" }).then(function (r) { return r.state; })`
    );
    assert.notEqual(state, "granted");
  });

  await scenario("closeAll closes every window", async () => {
    manager.open(targetFor(site, "/no-form"));
    manager.open(targetFor(site, "/no-form"));
    assert.equal(manager.count(), 2);
    manager.closeAll();
    await waitFor(() => manager.count() === 0, 3000, "windows to close");
  });

  await scenario("limits how many windows can be open", async () => {
    for (let i = 0; i < 8; i += 1) manager.open(targetFor(site, "/no-form"));
    assert.throws(() => manager.open(targetFor(site, "/no-form")), /Too many login windows/);
  });

  manager.closeAll();
  site.server.close();
  other.server.close();

  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nlogin-window tests FAILED" : "\nlogin-window tests passed");
  app.exit(process.exitCode || 0);
}

setTimeout(() => {
  console.error("login-window test timed out");
  app.exit(1);
}, 120000);

run().catch((error) => {
  console.error(error);
  app.exit(1);
});
