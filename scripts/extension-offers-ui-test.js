// Chromium fixture test: real trusted submit/button events, isolated content world,
// dummy credentials only. Never opens SLV or reads a user's browser profile/vault.
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { app, BrowserWindow } = require("electron");
const { testTempRoot } = require("./testTemp");
const root = fs.mkdtempSync(path.join(testTempRoot(), "offers-ui-"));
app.setPath("userData", root);
const read = file => fs.readFileSync(path.join(__dirname, "../extension", file), "utf8");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
let server;
async function main() {
  await app.whenReady();
  server = http.createServer((_req, res) => {
    if (_req.url === "/icons/icon-32.png") { res.setHeader("Content-Type", "image/png"); res.end(fs.readFileSync(path.join(__dirname, "../extension/icons/icon-32.png"))); return; }
    if (_req.url === "/popup.css") { res.setHeader("Content-Type", "text/css"); res.end(read("popup.css")); return; }
    if (_req.url === "/popup") { res.setHeader("Content-Type", "text/html"); res.end(read("popup.html").replace(/<script[^>]*><\/script>/g, "")); return; }
    res.setHeader("Content-Type", "text/html");
    res.end('<!doctype html><title>SLV dummy login fixture</title><style>body{background:#edf1f5;font:18px system-ui;padding:60px}form{display:grid;gap:16px;width:300px;margin-top:50px}input,button{padding:12px;font:inherit}</style><h1>SLV save-offer check</h1><p>Local dummy credentials. Nothing is submitted.</p><form><label>Username<input autocomplete="username" value="slv-dummy"></label><label>Password<input type="password" value="dummy-only-password"></label><button type="submit">Sign in</button></form><script>document.querySelector("form").addEventListener("submit",e=>e.preventDefault())</script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadURL(url);
  win.show();
  win.focus();
  win.webContents.debugger.attach("1.3");
  const run = code => win.webContents.executeJavaScriptInIsolatedWorld(1000, [{ code }]);
  await run(`
    globalThis.fixture = { calls: [], events: [], mode: "add", serial: 0 };
    for (const type of ["click", "submit"]) document.addEventListener(type, event => fixture.events.push({type, trusted:event.isTrusted, target:event.target.tagName}), true);
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) { fixture.shadow = attach.call(this, options); return fixture.shadow; };
    globalThis.chrome = { runtime: { id: "fixture", onMessage: { addListener(fn) { fixture.receive = fn; } },
      async sendMessage(message) {
        fixture.calls.push({...message});
        if (message.type === "offer-ready") return {enabled: true};
        if (message.type === "offer-capture") return {offer:{token:"fixture-" + ++fixture.serial, origin:location.origin, mode:fixture.mode, expires:Date.now()+120000}};
        return {ok:true,message:"Login saved to SLV."};
      }
    }};
    void 0;
  `);
  await run(read("readFormInPage.js"));
  await run(read("offerContent.js"));
  async function until(code) {
    for (let i = 0; i < 60; i++) { if (await run(code)) return; await sleep(50); }
    throw new Error("Fixture timed out: " + code + "; events=" + JSON.stringify(await run('fixture.events')) + "; messages=" + JSON.stringify(await run('fixture.calls.map(x=>x.type)')));
  }
  async function click(selector, shadow = false) {
    const point = await run(`(() => { const r = ${shadow ? "fixture.shadow" : "document"}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await sleep(100);
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await sleep(100);
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  }
  await until('fixture.calls.some(x=>x.type === "offer-ready")');
  await click("form button");
  await until('fixture.shadow && fixture.shadow.querySelector("h2").textContent.includes("Save these")');
  const captured = await run('fixture.calls.find(x=>x.type === "offer-capture")');
  assert.deepEqual(captured, { type: "offer-capture", username: "slv-dummy", password: "dummy-only-password" });
  assert.equal(await run('fixture.shadow.textContent.includes("dummy-only-password")'), false);
  await sleep(150);
  const screenshot = path.join(root, "save-offer.png");
  fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  await click("button", true);
  await until('fixture.shadow.querySelector("h2").textContent === "Done"');
  const save = await run('fixture.calls.find(x=>x.type === "offer-save")');
  assert.deepEqual(save, { type: "offer-save", token: "fixture-1" });
  await click("button", true);
  await run('fixture.mode = "update"');
  await click("form button");
  await until('fixture.shadow.querySelector("h2").textContent === "Update this password?"');
  await click(".never", true);
  await until('fixture.calls.some(x=>x.type === "offer-never")');
  assert.equal(await run('fixture.shadow.host.isConnected'), false);
  // Separate username and password submits use trusted events, not typing observers.
  await run('document.querySelector("form").innerHTML = \'<input type="email" autocomplete="username" value="step@example.test"><button>Next</button>\'');
  await click("form button");
  await until('fixture.calls.some(x=>x.type === "offer-username")');
  assert.equal(await run('fixture.calls.find(x=>x.type === "offer-username").username'), "step@example.test");
  await run('document.querySelector("form").innerHTML = \'<input type="password" value="step-synthetic-password"><button>Sign in</button>\'');
  await click("form button");
  await until('fixture.calls.some(x=>x.type === "offer-capture" && x.password === "step-synthetic-password")');
  assert.equal(await run('fixture.shadow.textContent.includes("step-synthetic-password")'), false);
  await win.loadURL(url + "/popup");
  win.setSize(360, 800);
  await run(`globalThis.chrome = { tabs: { query(q, cb) { cb([{id:1,url:location.origin}]); } }, runtime: {
    sendMessage(message, cb) { cb(message.type === "get-status" ? {connected:true,title:"Connected",detail:"Synthetic preview",site:{state:"ok",logins:[]}} : {ok:false,needsUsername:true,token:"synthetic-preview",username:"",message:"Confirm your username or email below, then save."}); }
  } }; void 0;`);
  await run(read("popup.js"));
  await click("#save-button");
  await until('!document.querySelector("#save-username-form").hidden');
  assert.equal(await run('document.activeElement.id'), "save-username");
  assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
  await sleep(250);
  fs.writeFileSync(path.join(root, "username-prompt.png"), (await win.webContents.capturePage()).toPNG());
  console.log("Chromium save-offer fixture passed: trusted submit, isolated reading, Save and Never. Screenshot: " + screenshot);
}
main().then(() => { win?.destroy(); server?.close(); app.exit(0); }, error => { console.error(error); win?.destroy(); server?.close(); app.exit(1); });
