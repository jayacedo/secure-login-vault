const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { testTempRoot } = require("./testTemp");
const { connect, pair, authenticate } = require("./pairingTestClient");
const { getPipeName } = require("../src/native-host/pipeName");
const root = fs.mkdtempSync(path.join(testTempRoot(), "browser-save-app-"));
app.setPath("userData", root);
process.env.SLV_PIPE_USER = `save-ui-${process.pid}`;
process.env.SLV_APPROVAL_TIMEOUT_MS = "2500";
require("../src/main");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await sleep(80); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0], "main window");
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  const api = code => win.webContents.executeJavaScript(`window.secureLoginVault.${code}`);
  const master = "browser organization test master";
  assert.equal((await api(`auth.createVault(${JSON.stringify({masterPassword:master,confirmPassword:master})})`)).ok, true);
  for (const name of ["Client A", "Client B"]) assert.equal((await api(`groups.add(${JSON.stringify(name)})`)).ok,true);
  await api('groups.setActive("Client A")');
  await api('settings.setExtensionBridge({enabled:true})');
  const code = (await api("settings.startExtensionPairing()")).result.code;
  let conn = await connect(getPipeName(process.env.SLV_PIPE_USER));
  const secret = (await pair(conn, code)).secret;
  assert.equal((await authenticate(conn, secret)).finish.ok,true);
  const reconnect = async () => { conn.close(); conn = await connect(getPipeName(process.env.SLV_PIPE_USER)); await authenticate(conn, secret); };
  const save = (username, password="dummy-browser-password") => conn.request({type:"save-login",url:"https://save.example/login",username,password});
  const prompt = () => until(() => {
    const child = BrowserWindow.getAllWindows().find(w => w !== win && w.webContents.getURL().endsWith("save-login.html"));
    return child && child.webContents.executeJavaScript("!document.querySelector('#save-confirm').disabled").then(ready => ready ? child : null).catch(()=>null);
  }, "save prompt");
  const all = async () => (await api("credentials.getAllForExport()")).result;
  const choose = (child,group,category) => child.webContents.executeJavaScript(`document.querySelector('#save-group').value=${JSON.stringify(group)};document.querySelector('#save-category').value=${JSON.stringify(category)};document.querySelector('#save-confirm').click()`);

  let pending = save("chosen");
  let child = await prompt();
  assert.equal(await child.webContents.executeJavaScript("document.querySelector('#save-group').value"),"Client A");
  assert.equal(await child.webContents.executeJavaScript("document.querySelector('#save-category').value"),"Other");
  assert.equal(await child.webContents.executeJavaScript("document.body.textContent.includes('dummy-browser-password')"),false);
  assert.equal(await child.webContents.executeJavaScript("document.activeElement.id"),"save-cancel");
  ipcMain.emit(`slv:save-prompt-response:${child.webContents.id}`, {sender:win.webContents,senderFrame:win.webContents.mainFrame}, {approved:true,groupName:"Client B",category:"Hosting"});
  assert.equal(child.isDestroyed(),false,"another renderer cannot approve the prompt");
  fs.writeFileSync(path.join(root,"save-login.png"),(await child.webContents.capturePage()).toPNG());
  await choose(child,"Client B","Hosting");
  assert.equal((await pending).ok,true);
  let saved=(await all()).find(c=>c.username==="chosen");
  assert.equal(saved.groupName,"Client B");assert.equal(saved.category,"Hosting");
  console.log("PASS actual save prompt defaults, hidden password, selected group and category persisted");

  pending=save("unassigned");child=await prompt();await choose(child,"","Other");assert.equal((await pending).ok,true);
  assert.equal((await all()).find(c=>c.username==="unassigned").groupName,"");
  pending=save("cancelled");child=await prompt();await child.webContents.executeJavaScript("document.querySelector('#save-cancel').click()");assert.equal((await pending).ok,false);
  pending=save("forged");child=await prompt();await child.webContents.executeJavaScript("window.saveLoginPrompt.respond({approved:true,groupName:'invented',category:'Other'})");assert.equal((await pending).ok,false);
  console.log("PASS explicit Unassigned overrides active group; cancellation and invented choices write nothing");

  pending=save("scope-changed");child=await prompt();await api('groups.setActive("Client B")');await choose(child,"Client A","Other");assert.equal((await pending).ok,false);
  await reconnect();
  await api('categories.add("Temporary category")');
  pending=save("category-removed");child=await prompt();await api('categories.remove("Temporary category","Other")');await choose(child,"Client B","Temporary category");assert.equal((await pending).ok,false);
  pending=save("locked");child=await prompt();await api("auth.lockVault()");assert.equal((await pending).ok,false);assert.equal(child.isDestroyed(),true);
  await api(`auth.unlockVault({masterPassword:${JSON.stringify(master)}})`);
  pending=save("disconnected");child=await prompt();pending.catch(()=>{});conn.close();await until(()=>child.isDestroyed(),"disconnect closes prompt");await pending.catch(()=>{});
  await reconnect();
  pending=save("expired");child=await prompt();assert.equal((await pending).ok,false);assert.equal(child.isDestroyed(),true);
  console.log("PASS stale organization choices, lock, disconnect and timeout all refuse saves");

  dialog.showMessageBox=async()=>({response:1});
  const update=await save("chosen","changed-dummy-password");assert.equal(update.ok,true);
  saved=(await all()).find(c=>c.username==="chosen");assert.equal(saved.password,"changed-dummy-password");assert.equal(saved.groupName,"Client B");assert.equal(saved.category,"Hosting");
  assert.equal((await api(`credentials.getPasswordHistory(${saved.id})`)).result[0].password,"dummy-browser-password","real browser save records password history");
  assert.deepEqual((await all()).map(c=>c.username).sort(),["chosen","unassigned"]);
  console.log(`PASS password updates preserve organization; no cancelled records added\nScreenshot: ${path.join(root,"save-login.png")}`);
  conn.close();app.exit(0);
}
setTimeout(()=>{console.error("Browser save app test timed out");app.exit(1);},90000).unref();
main().catch(error=>{console.error(error);app.exit(1);});
