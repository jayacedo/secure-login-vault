const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const asar = require('@electron/asar');
const { assertNoLinkedParents, assertTree, assertArchiveHeader, packagedFiles } = require('./package-content-policy');

function checkPackagedApp(appOutDir) {
  const outer = assertTree(appOutDir, packagedFiles());
  const archive = path.join(appOutDir, 'resources/app.asar');
  const inner = assertArchiveHeader(asar.getRawHeader(archive).header);
  // Also reject unpacked ASAR files: this app currently has no native modules.
  // An intentional new native dependency requires a reviewed policy update.
  return { outerFiles: outer.length, archiveFiles: inner.length };
}

async function checkInstaller(installer, workspace = path.resolve(__dirname, '..')) {
  const root = fs.realpathSync(workspace);
  const input = path.resolve(installer);
  if (!input.toLowerCase().startsWith((root + path.sep).toLowerCase()) || path.extname(input).toLowerCase() !== '.exe') {
    throw new Error('Installer verification requires an EXE inside the workspace');
  }
  assertNoLinkedParents(input);
  const tmp = path.join(root, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  assertNoLinkedParents(tmp);
  const stage = fs.mkdtempSync(path.join(tmp, 'package-privacy-'));
  const zip = path.join(root, 'node_modules/electron-winstaller/vendor/7z.exe');
  try {
    // Do not run the installer or the packaged app. Only extract the fixed app payload.
    const list = execFileSync(zip, ['l', '-slt', input], { encoding: 'utf8', windowsHide: true });
    if (/^(Symbolic Link|Hard Link) = /m.test(list) || /^Attributes = .*\bl[rwx-]{9}/m.test(list)) {
      throw new Error('Linked installer wrapper entry');
    }
    const entries = list.split(/\r?\n/).filter(l => l.startsWith('Path = ')).slice(1).map(l => l.slice(7));
    const installerFiles = new Set(['$PLUGINSDIR/System.dll', '$PLUGINSDIR/UAC.dll', '$PLUGINSDIR/StdUtils.dll',
      '$PLUGINSDIR/nsDialogs.dll', '$PLUGINSDIR/modern-wizard.bmp', '$PLUGINSDIR/nsExec.dll',
      '$PLUGINSDIR/app-64.7z', '$PLUGINSDIR/nsis7z.dll', '$R0/Uninstall Secure Login Vault.exe', '$PLUGINSDIR/WinShell.dll']);
    for (const item of entries) {
      if (!installerFiles.has(item.replaceAll('\\', '/'))) throw new Error('Unexpected installer wrapper entry: ' + item);
    }
    execFileSync(zip, ['e', input, '$PLUGINSDIR\\app-64.7z', '-o' + stage, '-y'], { stdio: 'pipe', windowsHide: true });
    const payloadArchive = path.join(stage, 'app-64.7z');
    // Check paths before extracting, including traversal, unknown and private paths.
    const payloadList = execFileSync(zip, ['l', '-slt', payloadArchive], { encoding: 'utf8', windowsHide: true });
    if (/^(Symbolic Link|Hard Link) = /m.test(payloadList) || /^Attributes = .*\bl[rwx-]{9}/m.test(payloadList)) {
      throw new Error('Linked installer payload entry');
    }
    const allowed = new Set(packagedFiles());
    const payloadPaths = payloadList.split(/\r?\n/).filter(l => l.startsWith('Path = ')).slice(1).map(l => l.slice(7).replaceAll('\\', '/'));
    for (const item of payloadPaths) {
      if (!allowed.has(item) && ![...allowed].some(f => f.startsWith(item + '/'))) {
        throw new Error('Unexpected installer payload entry: ' + item);
      }
    }
    const payload = path.join(stage, 'payload');
    execFileSync(zip, ['x', payloadArchive, '-o' + payload, '-y'], { stdio: 'pipe', windowsHide: true });
    const counts = checkPackagedApp(payload);
    const fuses = await require('./check-electron-fuses').checkElectronFuses(path.join(payload, 'Secure Login Vault.exe'));
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
    return { ...counts, sha256, fuses };
  } finally {
    // Only this generated directory; reject links before any recursive removal.
    const resolved = fs.realpathSync(stage);
    if (!resolved.startsWith(tmp + path.sep)) throw new Error('Unsafe audit cleanup path');
    function noLinks(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('Refusing linked audit cleanup');
        if (entry.isDirectory()) noLinks(path.join(dir, entry.name));
      }
    }
    assertNoLinkedParents(stage);
    noLinks(stage);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  (async () => {
    try {
      const version = require('../package.json').version;
      const installer = process.argv[2] || path.resolve(__dirname, '../release', `Secure Login Vault Setup ${version}.exe`);
      const result = await checkInstaller(installer);
      console.log('PASS installer privacy inventory (installer was not executed): ' + JSON.stringify(result));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  })();
}
module.exports = { checkPackagedApp, checkInstaller };
