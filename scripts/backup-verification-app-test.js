const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog } = require("electron");
const { testTempRoot } = require("./testTemp");
// Always a new isolated profile. Never open a developer's installed vault.
const root = fs.mkdtempSync(path.join(testTempRoot(), "backup-check-app-"));
const backup = path.join(root, "synthetic.slvbackup");
app.setPath("userData", root);
process.env.SLV_PIPE_USER = `backup-check-test-${process.pid}`;
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backup] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: backup });
require(path.join(process.env.SLV_TEST_CODE_ROOT || path.join(__dirname, ".."), "src/main"));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(50); }
  throw Error(`Timed out: ${label}`);
}
async function main() {
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().length, "window");
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
  win.webContents.setBackgroundThrottling(false);
  if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  const run = code => win.webContents.executeJavaScript(code).catch(error => { console.error("Failed test expression:", code); throw error; });
  const api = code => run(`window.secureLoginVault.${code}`);
  const workerStarted = () => fs.readdirSync(path.join(root, "backup-checks"))
    .some(name => fs.existsSync(path.join(root, "backup-checks", name, "snapshot.slvbackup")));
  const password = "synthetic backup UI test passphrase";
  const args = JSON.stringify({ filePath: backup, masterPassword: password });
  assert.equal((await api("importExport.pickBackupCheckFile()")).ok, false, "locked check refused");
  assert.equal((await api(`auth.createVault(${JSON.stringify({ masterPassword: password, confirmPassword: password })})`)).ok, true);
  await api('credentials.add({websiteName:"Synthetic only",password:"synthetic-secret-only"})');
  await api('importExport.pickExportPath({defaultName:"synthetic.slvbackup",format:"backup"})');
  assert.equal((await api(`importExport.createBackup({filePath:${JSON.stringify(backup)}})`)).ok, true);
  assert.equal((await api(`importExport.verifyBackup(${args})`)).ok, false, "export grant cannot authorize verification");
  await api("importExport.pickBackupCheckFile()");
  assert.equal((await api(`importExport.restoreBackup(${args})`)).ok, false, "check grant cannot authorize destructive restore");
  const before = fs.readFileSync(path.join(root, "vault/vault-data.slv"));
  const source = fs.readFileSync(backup);
  await run("initAuth()");
  await run("openSettingsModal()");
  await run("document.querySelector('#settings-tab-data').click();document.querySelector('#settings-backup-check-btn').click()");
  await until(() => run("Boolean(document.querySelector('#backup-check-input'))"), "password prompt");
  await run("document.querySelector('#backup-check-input').value='wrong';document.querySelector('#backup-check-run').click()");
  await until(() => run("!document.querySelector('#backup-check-run').disabled"), "wrong password result");
  assert.match(await run("document.querySelector('#backup-check-status').textContent"), /password|incorrect/i);
  assert.equal(await run("document.querySelector('#backup-check-input').value"), "");
  await run(`document.querySelector('#backup-check-input').value=${JSON.stringify(password)};document.querySelector('#backup-check-run').click()`);
  await until(() => run("document.querySelector('#backup-check-status').textContent.includes('Backup check passed')"), "successful rehearsal");
  assert.match(await run("document.querySelector('#backup-check-status').textContent"), /1 credential/);
  assert.equal(await run("Boolean(document.querySelector('#backup-check-run'))"), false);
  assert.equal(await run("document.querySelector('#backup-check-overlay').textContent.includes('synthetic-secret-only')"), false);
  assert.deepEqual(fs.readFileSync(path.join(root, "vault/vault-data.slv")), before);
  assert.deepEqual(fs.readFileSync(backup), source);
  assert.deepEqual(fs.readdirSync(path.join(root, "backup-checks")), []);
  fs.writeFileSync(path.join(root, "backup-check.png"), (await win.webContents.capturePage()).toPNG());
  await run("document.querySelector('#backup-check-cancel').click();document.querySelector('#settings-backup-check-btn').click()");
  await until(() => run("Boolean(document.querySelector('#backup-check-input'))"), "cancel prompt");
  await run(`document.querySelector('#backup-check-input').value=${JSON.stringify(password)};document.querySelector('#backup-check-run').click()`);
  await until(workerStarted, "worker started before cancel");
  await run("document.querySelector('#backup-check-cancel').click()");
  await until(() => fs.readdirSync(path.join(root, "backup-checks")).length === 0, "cancel cleanup");
  await sleep(100);
  assert.equal(await run("Boolean(document.querySelector('#backup-check-overlay'))"), false);
  assert.equal((await api(`importExport.verifyBackup(${args})`)).ok, false, "cancel revokes chosen path");
  await api("importExport.pickBackupCheckFile()");
  const pending = api(`importExport.verifyBackup(${args})`);
  await until(workerStarted, "worker started before lock");
  await api("auth.lockVault()");
  assert.equal((await pending).ok, false, "lock cancels pending check");
  await until(() => fs.readdirSync(path.join(root, "backup-checks")).length === 0, "lock cleanup");
  console.log(`PASS backup Settings UI, retry, grant isolation, cancellation and lock cleanup; synthetic data only\nScreenshot: ${path.join(root, "backup-check.png")}`);
  app.exit(0);
}
setTimeout(() => { console.error("Backup check app test timeout"); app.exit(1); }, 60000).unref();
main().catch(error => { console.error(error); app.exit(1); });
