const assert = require("assert/strict"), fs = require("fs"), path = require("path");
const asyncFs = require("fs/promises");
const { app, BrowserWindow, clipboard, dialog, powerMonitor } = require("electron");
const { testTempRoot } = require("./testTemp");
const root = fs.mkdtempSync(path.join(testTempRoot(), "system-lock-app-"));
for (const name of ["userData", "sessionData", "temp", "logs"]) {
  const dir = path.join(root, name); fs.mkdirSync(dir); app.setPath(name, dir);
}
app.setPath("appData", root); process.env.APPDATA = root; process.env.LOCALAPPDATA = root;
process.env.SLV_PIPE_USER = `system-lock-${process.pid}`;
// Entire clipboard is an in-memory mock; never call any original OS method.
let syntheticClipboard = "";
clipboard.readText = async () => syntheticClipboard;
clipboard.writeText = async value => { syntheticClipboard = value; };
clipboard.clear = async () => { syntheticClipboard = ""; };
dialog.showOpenDialog = dialog.showSaveDialog = async () => ({ canceled: true });
powerMonitor.getSystemIdleState = () => "locked";
let lastUnlock, testStore;
const vaultModule = require("../src/services/vaultStore"), originalCreateStore = vaultModule.createVaultStore;
vaultModule.createVaultStore = (...args) => {
  const store = originalCreateStore(...args), unlock = store.unlockVault;
  testStore = store;
  store.unlockVault = (...params) => (lastUnlock = unlock(...params));
  return store;
};
require("../src/services/browserSetup").createBrowserSetup = () => ({ status: async () => ({ supported: false, ready: false }) });
require("../src/main");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 180; i++) { if (await fn()) return; await sleep(50); } throw Error("Synthetic system-lock test timed out"); }
async function main() {
  await app.whenReady(); await until(() => BrowserWindow.getAllWindows().length);
  const win = BrowserWindow.getAllWindows()[0]; win.webContents.setBackgroundThrottling(false); win.show();
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  const run = code => win.webContents.executeJavaScript(code);
  const api = code => run(`window.secureLoginVault.${code}`);
  const password = "Synthetic system-lock passphrase only";
  const unlockArgs = JSON.stringify({ masterPassword: password });
  assert.equal((await api(`auth.createVault(${JSON.stringify({ masterPassword: password, confirmPassword: password })})`)).ok, false, "startup detects an already locked Windows session");
  powerMonitor.emit("unlock-screen");
  assert.equal((await api(`auth.createVault(${JSON.stringify({ masterPassword: password, confirmPassword: password })})`)).ok, true);
  await run("setPref(PREF_BACKGROUND_LOCK,'off');initAuth()");
  await until(() => run("!!document.querySelector('#open-notes-btn')"));
  // These events are emitted into this test process only. Windows is never locked or suspended.
  await api("settings.setLockPolicy({idleSeconds:0,backgroundGraceSeconds:null})");
  await run('copyToClipboard("synthetic copied secret", "Copied", null, true)');
  assert.equal(syntheticClipboard, "synthetic copied secret");
  const note = (await api('notes.add({title:"Synthetic note",body:"Synthetic private note text"})')).result;
  await run(`renderNotesWorkspace(_lastAuthState);openNote(${note.id})`);
  await until(() => run("!!document.querySelector('#note-heading')"));
  powerMonitor.emit("lock-screen");
  await sleep(250);
  assert.equal((await api("auth.getState()")).isUnlocked, false, "Windows locking must lock the vault even with timers off");
  await until(() => syntheticClipboard === "");
  assert.equal((await api('clipboard.copy({text:"denied",sensitive:true,delayMs:0})')).ok, false);
  await until(() => run("!!document.querySelector('#master-password')"));
  assert.equal(await run("notesView===null && !document.body.textContent.includes('Synthetic private note text')"), true);
  assert.equal((await api(`notes.getOne(${note.id})`)).ok, false);
  assert.equal((await api(`auth.unlockVault(${unlockArgs})`)).ok, false, "cannot unlock while Windows remains locked");
  powerMonitor.emit("unlock-screen");
  assert.equal((await api("auth.getState()")).isUnlocked, false, "Windows unlock never unlocks SLV");
  async function unlock() {
    assert.equal((await api(`auth.unlockVault(${unlockArgs})`)).ok, true);
    await run("initAuth()"); await until(() => run("!!document.querySelector('#open-notes-btn')"));
    await api("settings.setLockPolicy({idleSeconds:0,backgroundGraceSeconds:null})");
  }
  await unlock();
  powerMonitor.emit("suspend");
  await until(() => run("!!document.querySelector('#master-password')"));
  assert.equal((await api("auth.getState()")).isUnlocked, false);
  assert.equal((await api(`auth.unlockVault(${unlockArgs})`)).ok, false, "cannot unlock while suspended");
  powerMonitor.emit("resume");
  await sleep(200); await until(() => run("!!document.querySelector('#master-password')"));
  assert.equal((await api("auth.getState()")).isUnlocked, false, "resume stays locked");
  await unlock();
  powerMonitor.emit("resume"); // fallback even if suspend was missed
  await until(() => run("!!document.querySelector('#master-password')"));
  assert.equal((await api("auth.getState()")).isUnlocked, false);
  // Interrupt password verification; the completed request must not reopen the vault.
  const originalRead = asyncFs.readFile;
  const syntheticAuth = path.join(root, "userData", "vault", "vault-auth.json");
  let entered, release, held = false;
  const reached = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  asyncFs.readFile = async (...args) => {
    if (!held && args[0] === syntheticAuth) { held = true; entered(); await resume; }
    return originalRead(...args);
  };
  try {
    await run(`window.pendingSyntheticUnlock=window.secureLoginVault.auth.unlockVault(${unlockArgs});void 0`);
    await reached;
    powerMonitor.emit("lock-screen");
    const pendingResult = assert.rejects(lastUnlock);
    release();
    await pendingResult;
  } finally { release(); asyncFs.readFile = originalRead; }
  await until(() => run("!!document.querySelector('#master-password')"));
  assert.equal((await api("auth.getState()")).isUnlocked, false, "late password verification cannot undo system lock");
  powerMonitor.emit("unlock-screen");
  await unlock();
  assert.equal((await api(`notes.getOne(${note.id})`)).result.body, "Synthetic private note text", "saved synthetic note survives locking");
  assert.equal((await api('clipboard.copy({text:"synthetic crash secret",sensitive:true,delayMs:0})')).ok, true);
  const crashed = new Promise(resolve => win.webContents.once("render-process-gone", resolve));
  win.webContents.forcefullyCrashRenderer();
  await crashed;
  assert.equal(testStore.isUnlocked(), false, "actual synthetic renderer crash locks main-process vault");
  await until(() => syntheticClipboard === "");
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload(); await loaded;
  assert.equal((await api("auth.getState()")).isUnlocked, false, "renderer recovery cannot reopen vault");
  assert.equal((await api(`notes.getOne(${note.id})`)).ok, false);
  assert.equal((await api('clipboard.copy({text:"denied",sensitive:true,delayMs:0})')).ok, false);
  console.log("PASS mocked clipboard lock cleanup, actual isolated renderer crash, locked IPC and renderer recovery");
  console.log(`PASS system lock/suspend/resume, disabled timers, blocked unlock, cleared Notes and pending-unlock cancellation. Synthetic profile: ${root}`);
  app.exit(0);
}
setTimeout(() => { console.error("System lock test timeout"); app.exit(1); }, 60000).unref();
main().catch(error => { console.error(error); app.exit(1); });
