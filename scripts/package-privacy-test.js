// Synthetic files only. Never opens a vault, browser profile or installed app.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { policy, assertTree, assertSources, assertExtensionSource, assertArchiveHeader, assertNoLinkedParents } = require('./package-content-policy');
const { checkPackagedApp } = require('./package-privacy');

async function main() {
  const tmp = path.resolve(__dirname, '../.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  assertNoLinkedParents(tmp);
  const stage = fs.mkdtempSync(path.join(tmp, 'privacy-test-'));
  const file = (name, content = 'synthetic fixture only') => {
    const target = path.join(stage, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  try {
    for (const name of [...policy.app, ...policy.sourceOnly]) file('source/' + name);
    for (const name of policy.extension) {
      file('source/extension/' + name);
      file('source/dist/firefox/' + name);
    }
    assertSources(path.join(stage, 'source'));
    const probes = ['source/src/vault-data.slv', 'source/assets/github-2fa.png',
      'source/extension/icons/private-image.png', 'source/extension/personal.js',
      'source/dist/firefox/backup-codes.txt', 'source/assets/export.csv'];
    for (const probe of probes) {
      const target = file(probe);
      assert.throws(() => assertSources(path.join(stage, 'source')), /Package privacy check:/, probe);
      fs.unlinkSync(target);
    }
    // An unrecognized directory is rejected before its contents are traversed.
    const hidden = file('source/extension/work/account.txt');
    assert.throws(() => assertExtensionSource(path.join(stage, 'source')), /forbidden|unexpected/);
    fs.unlinkSync(hidden);
    fs.rmdirSync(path.dirname(hidden));

    const safeHeader = { files: { 'package.json': { size: 1 }, src: { files: { 'main.js': { size: 1 } } } } };
    assertArchiveHeader(safeHeader);
    for (const [name, entry] of [
      ['vault-auth.json', { size: 1 }], ['credentials.sqlite', { size: 1 }],
      ['notes.txt', { size: 1 }], ['../escape', { size: 1 }],
      ['C:/private', { size: 1 }], ['assets\\private.png', { size: 1 }],
      ['LICENSE.md', { link: 'private' }]
    ]) {
      assert.throws(() => assertArchiveHeader({ files: { ...safeHeader.files, [name]: entry } }), /Package privacy check:/);
    }
    assert.throws(() => assertArchiveHeader({ files: { ...safeHeader.files,
      node_modules: { files: { sql: { files: { 'vault.db': { size: 1 } } } } }
    } }), /Package privacy check:/);

    // Real ASAR and real packaged-tree checks with harmless generated content.
    file('app-source/package.json', '{}');
    file('app-source/src/main.js', '// synthetic');
    const out = path.join(stage, 'packaged');
    fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
    await asar.createPackage(path.join(stage, 'app-source'), path.join(out, 'resources/app.asar'));
    assert.equal(checkPackagedApp(out).archiveFiles, 2);
    const leaked = file('packaged/resources/extension/personal-backup.slvbackup');
    assert.throws(() => checkPackagedApp(out), /Package privacy check:/);
    fs.unlinkSync(leaked);
    const extra = file('packaged/credentials.json', '{}');
    assert.throws(() => checkPackagedApp(out), /unexpected file/);
    fs.unlinkSync(extra);

    const link = path.join(stage, 'source/extension/icons-link');
    fs.symlinkSync(path.join(stage, 'app-source'), link, 'junction');
    try { assert.throws(() => assertTree(path.join(stage, 'source/extension'), policy.extension), /linked entry/); }
    finally { fs.unlinkSync(link); }

    const config = require('../package.json').build;
    assert.equal(config.beforePack, './scripts/before-pack-privacy.js');
    assert.equal(config.afterPack, './scripts/after-pack-privacy.js');
    assert.equal(config.artifactBuildCompleted, './scripts/after-artifact-privacy.js');
    await require('./before-pack-privacy').default({ packager: { projectDir: path.join(stage, 'source') } });
    await require('./after-pack-privacy').default({ appOutDir: out });
    console.log('PASS synthetic leakage rejection: source, extension, dependencies, ASAR, payload, paths, junctions and build hooks');
  } finally {
    // Fixed generated child of .tmp; never delete a linked tree.
    assertNoLinkedParents(stage);
    if (!fs.realpathSync(stage).startsWith(tmp + path.sep)) throw Error('Unsafe test cleanup');
    function noLinks(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw Error('Refusing linked cleanup');
        if (entry.isDirectory()) noLinks(path.join(dir, entry.name));
      }
    }
    noLinks(stage);
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
