const assert = require("assert/strict");
const fs = require("fs/promises");
const syncFs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const { testTempRoot } = require("./testTemp");
const root = syncFs.mkdtempSync(path.join(testTempRoot(), "hardening-app-"));
app.setPath("userData", root); process.env.SLV_PIPE_USER = `hardening-app-${process.pid}`;
require("../src/main");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(60); } throw Error("Timed out"); }
async function main() {
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  const api = code => win.webContents.executeJavaScript(`window.secureLoginVault.${code}`);
  const pw = "Hardening UI dummy master password";
  assert.equal((await api(`auth.createVault(${JSON.stringify({ masterPassword: pw, confirmPassword: pw })})`)).ok, true);
  const unlock = () => api(`auth.unlockVault({masterPassword:${JSON.stringify(pw)}})`);
  const data = { websiteName: "Dummy", websiteUrl: "https://hardening.test", username: "dummy", password: "Dummy-secret-only" };
  const id = (await api(`credentials.add(${JSON.stringify(data)})`)).result.id;
  const channels = [...new Set([...syncFs.readFileSync(path.join(__dirname, "../src/preload.js"), "utf8").matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(match => match[1]))];
  const probe = path.join(root, "probe.js");
  await fs.writeFile(probe, 'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("probe",channel=>ipcRenderer.invoke(channel));');
  const child = new BrowserWindow({ show: false, webPreferences: { preload: probe, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await child.loadURL("about:blank");
  for (const channel of channels) {
    const result = await child.webContents.executeJavaScript(`window.probe(${JSON.stringify(channel)})`);
    assert.equal(result.ok, false, channel); assert.match(result.message, /Open this action/);
  }
  child.destroy();
  console.log(`PASS all ${channels.length} desktop request channels reject another window before any action`);

  const originalRead = fs.readFile; let entered, release, held = false;
  const reached = new Promise(resolve => { entered = resolve; }), resume = new Promise(resolve => { release = resolve; });
  fs.readFile = async (...args) => {
    const value = await originalRead(...args);
    if (!held && args[0] === path.join(root, "vault/vault-data.slv")) { held = true; entered(); await resume; }
    return value;
  };
  const pending = api(`credentials.getOne(${id})`); await reached;
  await api("auth.lockVault()"); release(); fs.readFile = originalRead;
  const late = await pending;
  assert.equal(late.ok, false); assert.equal(JSON.stringify(late).includes(data.password), false);
  assert.equal((await unlock()).ok, true);

  const output = path.join(root, "dummy-export.csv"), originalDialog = dialog.showSaveDialog;
  let finishDialog; dialog.showSaveDialog = () => new Promise(resolve => { finishDialog = resolve; });
  const pick = api('importExport.pickExportPath({defaultName:"dummy.csv",format:"csv"})');
  await until(() => finishDialog); await api("auth.lockVault()");
  finishDialog({ canceled: false, filePath: output }); assert.equal((await pick).ok, false);
  dialog.showSaveDialog = originalDialog; await unlock();
  assert.equal((await api(`importExport.writeExportFile(${JSON.stringify({ filePath: output, content: "dummy" })})`)).ok, false);
  assert.equal(syncFs.existsSync(output), false);
  console.log("PASS pending credential reads and file dialogs are cancelled on lock; expired sessions cannot grant export access");

  dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
  assert.equal((await api('importExport.pickExportPath({defaultName:"dummy.csv",format:"csv"})')).ok, true);
  dialog.showSaveDialog = originalDialog;
  const originalWrite = fs.writeFile; let staged, resumeWrite;
  const stagedPromise = new Promise(resolve => { staged = resolve; });
  const resumePromise = new Promise(resolve => { resumeWrite = resolve; });
  fs.writeFile = async (...args) => {
    const result = await originalWrite(...args);
    if (typeof args[0] === "string" && args[0].startsWith(output + ".")) { staged(); await resumePromise; }
    return result;
  };
  const exporting = api(`importExport.writeExportFile(${JSON.stringify({ filePath: output, content: data.password })})`);
  await stagedPromise; await api("auth.lockVault()"); resumeWrite(); fs.writeFile = originalWrite;
  assert.equal((await exporting).ok, false);
  assert.equal(syncFs.existsSync(output), false);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith("dummy-export.csv.")), false);
  await unlock();
  console.log("PASS locking before export publication removes the staged plaintext file");

  const secondScript = path.join(root, "second.js");
  await fs.writeFile(secondScript, `const {app}=require("electron");app.setPath("userData",${JSON.stringify(root)});require(${JSON.stringify(path.resolve(__dirname, "../src/main.js"))});setTimeout(()=>app.exit(9),8000);`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const second = spawn(process.execPath, [secondScript], { env, windowsHide: true, stdio: "ignore" });
  const exit = await new Promise((resolve, reject) => { second.on("error", reject); second.on("exit", resolve); });
  assert.equal(exit, 0, "second process exits without becoming another writer");
  assert.equal((await api(`credentials.getOne(${id})`)).result.password, data.password);
  console.log("PASS a second desktop process for the same profile exits while the original vault remains usable");
  app.exit(0);
}
setTimeout(() => { console.error("Local hardening UI timed out"); app.exit(1); }, 60000).unref();
main().catch(error => { console.error(error); app.exit(1); });
