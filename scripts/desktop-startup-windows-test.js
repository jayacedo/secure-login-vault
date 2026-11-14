// Opt-in native Windows regression: uses a unique registry value and a nonexistent
// test executable, then removes only that value. Never changes SLV's startup entry.
const assert = require('assert/strict');
const { app } = require('electron');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { testTempRoot } = require('./testTemp');
const { createDesktopIntegration } = require('../src/services/desktopIntegration');

async function main() {
  assert.equal(process.platform, 'win32');
  const name = `SLV-startup-test-${randomUUID()}`;
  app.setAppUserModelId(name);
  await app.whenReady();
  const root = await fs.mkdtemp(path.join(testTempRoot(), 'desktop-startup-'));
  const executable = path.join(root, 'Path With Spaces', 'Secure Login Vault.exe');
  const args = ['--slv-startup'];
  const quotedPath = `"${executable}"`;
  let service;
  try {
    app.setLoginItemSettings({ name, path: executable, args, openAtLogin: true, enabled: true });
    const raw = app.getLoginItemSettings({ path: executable, args });
    const quoted = app.getLoginItemSettings({ path: quotedPath, args });
    assert.equal(raw.openAtLogin, true);
    assert.equal(raw.executableWillLaunchAtLogin, false, 'reproduce Electron path-with-spaces lookup mismatch');
    assert.equal(quoted.executableWillLaunchAtLogin, true);
    console.log('PASS reproduced unquoted startup path mismatch with the real Windows API');
    app.setLoginItemSettings({ name, path: quotedPath, args, openAtLogin: false });
    service = createDesktopIntegration({
      app: { isPackaged: true, getLoginItemSettings: options => app.getLoginItemSettings(options),
        setLoginItemSettings: options => app.setLoginItemSettings({ ...options, name }) },
      Tray: class { on() {} setToolTip() {} setContextMenu() {} destroy() {} },
      Menu: { buildFromTemplate: items => items },
      configPath: path.join(root, 'preferences.json'), iconPath: '', executable, portable: false,
      getWindow: () => ({ isVisible: () => true }), isUnlocked: () => false,
      lockVault() {}, openWindow() {}
    });
    await service.load();
    assert.equal(service.status().startWithWindows, false);
    await service.configure({ startWithWindows: true, startInTray: true, closeToTray: false });
    assert.equal(service.status().startWithWindows, true);
    const state = app.getLoginItemSettings({ path: quotedPath, args });
    const entry = state.launchItems.find(item => item.name === name);
    assert.equal(entry.path, executable);
    assert.equal(state.openAtLogin, true, 'registration matches the requested startup arguments');
    // Electron launchItems.args excludes command-line switches; inspect only our
    // isolated Run value to verify the startup flag is actually persisted.
    const command = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name], { windowsHide: true, encoding: 'utf8' });
    assert.equal(command.status, 0);
    assert.ok(command.stdout.includes(quotedPath));
    assert.ok(command.stdout.includes('--slv-startup'));
    // Simulate the user disabling startup in Windows, without removing registration.
    app.setLoginItemSettings({ name, path: quotedPath, args, openAtLogin: true, enabled: false });
    assert.equal(service.status().startWithWindows, false);
    await service.configure({ startWithWindows: true, startInTray: true, closeToTray: false });
    assert.equal(service.status().startWithWindows, true);
    await service.configure({ startWithWindows: false, startInTray: false, closeToTray: false });
    assert.equal(service.status().startWithWindows, false);
    console.log('PASS native Windows enable, quoted executable/arguments, disabled override, re-enable and removal');
  } finally {
    service?.dispose();
    app.setLoginItemSettings({ name, path: quotedPath, args, openAtLogin: false });
    // Also remove a StartupApproved value if the runtime leaves one behind.
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
    const query = () => spawnSync('reg.exe', ['query', key, '/v', name], { windowsHide: true, encoding: 'utf8' });
    if (query().status === 0) {
      const removed = spawnSync('reg.exe', ['delete', key, '/v', name, '/f'], { windowsHide: true, encoding: 'utf8' });
      assert.equal(removed.status, 0, 'remove the isolated startup approval value');
    }
    assert.equal(query().status, 1, 'no isolated startup approval value remains');
    assert.equal(app.getLoginItemSettings({ path: quotedPath, args }).openAtLogin, false);
    console.log(`PASS isolated startup registry entry removed. Test files: ${root}`);
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
