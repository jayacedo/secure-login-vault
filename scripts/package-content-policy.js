// File-name allowlist, not a scanner of the user's vault. Never enumerate the
// project root: only the explicitly packaged application/resource directories.
const fs = require('fs');
const path = require('path');
const policy = require('./package-content-allowlist.json');

function fail(message) { throw new Error(`Package privacy check: ${message}`); }

function validateName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') ||
      name.startsWith('/') || name.includes(':') ||
      name.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('invalid relative package path');
  }
  if (/(^|\/)(database|\.tmp|\.slv-test|\.git|work|userdata|user-data|profiles?|backups?)(\/|$)/i.test(name) ||
      /\.(db|db3|sqlite|sqlite3|slv|slvbackup|kdbx|csv)(?:-|$)/i.test(name) ||
      /(^|\/)(vault-auth\.json|backup-codes\.txt|firefox-qr\.png|github-2fa\.png|Cookies|Login Data|Local State|Preferences)$/i.test(name)) {
    fail(`user-data path is forbidden: ${name}`);
  }
}

function allowedDirectories(files) {
  const dirs = new Set();
  for (const name of files) {
    validateName(name);
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return dirs;
}

function assertEntry(name, directory, allowed, dirs) {
  validateName(name);
  if (!(directory ? dirs : allowed).has(name)) fail(`unexpected ${directory ? 'directory' : 'file'}: ${name}`);
}

function assertNoLinkedParents(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) fail(`linked path: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function assertTree(root, files) {
  assertNoLinkedParents(root);
  const allowed = new Set(files), dirs = allowedDirectories(files), found = [];
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) fail(`linked entry: ${name}`);
      if (!entry.isFile() && !entry.isDirectory()) fail(`unsupported entry: ${name}`);
      assertEntry(name, entry.isDirectory(), allowed, dirs);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), name + '/');
      else found.push(name);
    }
  }
  walk(root);
  return found;
}

function assertExtensionSource(root) {
  return assertTree(path.join(root, 'extension'), policy.extension);
}

function assertSources(root) {
  for (const prefix of ['src/', 'assets/']) {
    assertTree(path.join(root, prefix), [...policy.app, ...policy.sourceOnly].filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length)));
  }
  assertExtensionSource(root);
  assertTree(path.join(root, 'dist/firefox'), policy.extension);
  for (const file of ['package.json', 'LICENSE.md']) assertNoLinkedParents(path.join(root, file));
}

function assertArchiveHeader(header) {
  const files = [...policy.app, ...policy.dependencies];
  const allowed = new Set(files), dirs = allowedDirectories(files), found = [];
  function walk(entries, prefix = '') {
    for (const [key, value] of Object.entries(entries)) {
      const name = prefix + key;
      if (Object.hasOwn(value, 'link')) fail(`linked archive entry: ${name}`);
      const directory = Boolean(value.files);
      assertEntry(name, directory, allowed, dirs);
      if (directory) walk(value.files, name + '/');
      else found.push(name);
    }
  }
  if (!header || !header.files) fail('missing ASAR header');
  walk(header.files);
  for (const file of ['package.json', 'src/main.js']) {
    if (!found.includes(file)) fail(`missing application file: ${file}`);
  }
  return found;
}

function packagedFiles() {
  return [...policy.windowsRuntime, 'resources/app.asar', 'resources/app-update.yml', 'resources/elevate.exe',
    ...policy.extension.map(p => 'resources/extension/' + p),
    ...policy.extension.map(p => 'resources/extension-firefox/' + p),
    ...policy.nativeHost.map(p => 'resources/native-host/' + p)];
}

module.exports = { policy, validateName, assertNoLinkedParents, assertTree,
  assertExtensionSource, assertSources, assertArchiveHeader, packagedFiles };
