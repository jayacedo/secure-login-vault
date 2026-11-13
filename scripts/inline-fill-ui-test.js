const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { app, BrowserWindow } = require("electron");
const { testTempRoot } = require("./testTemp");
const root = fs.mkdtempSync(path.join(testTempRoot(), "inline-ui-"));
app.setPath("userData", root);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = name => fs.readFileSync(path.join(__dirname, "../extension", name), "utf8");
let win, server;
async function main() {
  await app.whenReady();
  server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><style>body{font:18px system-ui;padding:40px;background:#eef3f7}main{display:flex;gap:100px}form{display:grid;gap:14px;width:260px}input,button{font:inherit;padding:10px}label{display:grid}</style><h1>SLV inline fill — dummy page</h1><main><form id="first"><h2>Another login</h2><input name="username"><input type="password" name="password"></form><form id="chosen"><h2>Client login</h2><label>Username<input name="username" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Log in</button></form></main><form id="signup"><input autocomplete="new-password" type="password"></form>`);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/login`); win.show(); win.focus();
  win.webContents.debugger.attach("1.3");
  win.webContents.on("console-message", (_event, details) => { if (details?.level === "error") console.error(details.message); });
  const run = code => win.webContents.executeJavaScriptInIsolatedWorld(1000, [{ code }]);
  await run(`globalThis.fixture={calls:[],enabled:true,delay:0,locked:false,submits:0};
    document.addEventListener('submit',e=>{e.preventDefault();fixture.submits++});
    const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(opts){fixture.shadow=attach.call(this,opts);return fixture.shadow};
    globalThis.chrome={runtime:{id:'fixture',onMessage:{addListener(fn){fixture.receive=fn}},async sendMessage(m){
      fixture.calls.push({...m});
      if(m.type==='inline-ready')return {enabled:fixture.enabled};
      if(m.type==='inline-list')return fixture.locked?{ok:false,message:'SLV is locked'}:{ok:true,origin:location.origin,token:'ticket',expires:Date.now()+60000,logins:[{id:4,name:'Client <b>account</b>',username:'dummy-user'}]};
      if(m.type==='inline-fill'){
        await new Promise(r=>setTimeout(r,fixture.delay));
        if(fixture.locked)return {ok:false,message:'Fill not approved'};
        const r=slvFillInPage(location.origin,{username:'dummy-user',password:'dummy-only-secret'},{layout:true,submit:false,inlineToken:m.token});
        return {ok:r.status==='filled',message:r.status};
      }return {};
    }}};void 0;`);
  await run(read("fillInPage.js")); await run(read("inlineContent.js"));
  async function until(code) { for (let i=0;i<100;i++){if(await run(code))return;await sleep(50);}throw Error("Timed out: "+code+" "+JSON.stringify(await run("({calls:fixture.calls,active:document.activeElement?.outerHTML,installed:globalThis.slvInlineInstalled})"))); }
  async function click(selector, shadow=false) {
    const point=await run(`(()=>{const r=${shadow?'fixture.shadow':'document'}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled",{enabled:true});
    await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent",{type:"mouseMoved",...point}); await sleep(100);
    for(const type of ["mousePressed","mouseReleased"]) { await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent",{type,button:"left",clickCount:1,...point}); await sleep(100); }
    await sleep(100);
  }
  await until("fixture.calls.some(x=>x.type==='inline-ready')");
  await click('#chosen input[type=password]'); await until("fixture.shadow?.querySelector('.slv-button')");
  assert.equal(await run("fixture.shadow.querySelector('.slv-button').getAttribute('aria-label')"), "Fill with Secure Login Vault");
  assert.equal(await run("fixture.shadow.querySelector('.slv-button').title"), "Fill with Secure Login Vault");
  fs.writeFileSync(path.join(root,"inline-logo.png"),(await win.webContents.capturePage()).toPNG());
  assert.equal(await run("fixture.calls.some(x=>x.type==='inline-list')"),false);
  await run("fixture.shadow.querySelector('.slv-button').click()");
  assert.equal(await run("fixture.calls.some(x=>x.type==='inline-list')"),false,"synthetic open ignored");
  await click('.slv-button',true); await until("fixture.shadow.querySelector('.account')");
  assert.equal(await run("fixture.shadow.querySelector('.account b')"),null,"names treated as text");
  assert.equal(await run("fixture.shadow.textContent.includes('dummy-only-secret')"),false);
  fs.writeFileSync(path.join(root,"inline-fill.png"),(await win.webContents.capturePage()).toPNG());
  await run("fixture.shadow.querySelector('.account').click()");
  assert.equal(await run("fixture.calls.some(x=>x.type==='inline-fill')"),false,"synthetic fill ignored");
  await click('.account',true); await until("document.querySelector('#chosen input[type=password]').value==='dummy-only-secret'");
  assert.equal(await run("document.querySelector('#first input[type=password]').value"),"");
  assert.equal(await run("fixture.submits"),0);
  assert.equal(await run("globalThis.slvInlineContext"),null);
  console.log("PASS trusted clicks only, safe labels, selected form only, no automatic submit and no password in chooser");
  await click('.close',true);
  await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
  await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await until("fixture.shadow.querySelector('.account')");
  await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  assert.equal(await run("fixture.shadow.querySelector('section')"), null);
  assert.equal(await run("document.activeElement === document.querySelector('#chosen input[type=password]')"), true);
  console.log("PASS accessible icon label, keyboard open and Escape focus return");
  await run("document.querySelector('#chosen input[type=password]').value='';fixture.delay=400");
  await click('.slv-button',true); await click('.account',true);
  await run("history.replaceState({},'', '/changed')"); await sleep(500);
  assert.equal(await run("document.querySelector('#chosen input[type=password]').value"),"","same-origin navigation cancels");
  await click('.close',true); await run("history.replaceState({},'', '/login');fixture.delay=0;fixture.locked=true");
  await click('.slv-button',true); await until("fixture.shadow.querySelector('[role=status]').textContent.includes('locked')");
  assert.equal(await run("fixture.shadow.querySelector('.account')"),null);
  await run("fixture.enabled=false;fixture.receive({type:'slv-inline-refresh'},{id:'fixture'})");
  await until("!fixture.shadow.host.isConnected");
  assert.equal(await run("globalThis.slvInlineContext"),null);
  await run("fixture.enabled=true;fixture.locked=false;fixture.receive({type:'slv-inline-refresh'},{id:'fixture'})");
  await click('#signup input');
  assert.equal(await run("Boolean(fixture.shadow?.host.isConnected)"),false,"new-password fields ignored");
  console.log("PASS page-change cancellation, locked state, disabled cleanup and signup exclusion. Screenshot: "+path.join(root,"inline-fill.png"));
}
setTimeout(()=>{console.error("Inline UI timeout");app.exit(1)},60000).unref();
main().then(()=>{win?.destroy();server?.close();app.exit(0)},e=>{console.error(e);win?.destroy();server?.close();app.exit(1)});
