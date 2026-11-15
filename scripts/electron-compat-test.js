// Synthetic objects only: no real clipboard, vault, browser profile or account files.
const assert = require('assert/strict');
const { createAuthenticator } = require('../src/services/authenticator');
const { createPairingStorage } = require('../src/services/pairingStorage');
const { createPairing, parseCode, protocol } = require('../src/services/extensionPairing');
const QR = require('qrcode');
const { parseSetupUri } = require('../src/services/totp');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function main() {
  const uri = 'otpauth://totp/Synthetic:test?secret=JBSWY3DPEHPK3PXP&issuer=Synthetic';
  const image = await QR.toDataURL(uri);
  let text = '', unlocked = true, epoch = 1, writeGate, wrote;
  const clipboard = {
    async readText() { return text; },
    async writeText(value) { wrote?.resolve(); if (writeGate) await writeGate.promise; text = value; },
    async clear() { text = ''; }
  };
  const vault = { isUnlocked: () => unlocked, getOperationEpoch: () => epoch };
  const manager = createAuthenticator({ vault, clipboard, decode: async () => parseSetupUri(uri) });
  let session = await manager.start(image);
  await manager.copy(session.token); assert.match(text, /^\d{6}$/);
  await manager.clear(); assert.equal(text, '');
  session = await manager.start(image); await manager.copy(session.token);
  text = 'unrelated synthetic clipboard'; await manager.clear(); assert.equal(text, 'unrelated synthetic clipboard');
  session = await manager.start(image); writeGate = deferred(); wrote = deferred();
  const copying = manager.copy(session.token);
  const rejected = assert.rejects(copying, /expired/);
  await wrote.promise; unlocked = false; epoch++;
  const clearing = manager.clear(); writeGate.resolve();
  await rejected; await clearing; assert.equal(text, '', 'lock during async write removes the just-written code');
  unlocked = true; writeGate = null; wrote = null;
  session = await manager.start(image);
  clipboard.writeText = async () => { throw Error('Synthetic clipboard unavailable'); };
  await assert.rejects(manager.copy(session.token), /unavailable/);
  await manager.clear();
  console.log('PASS asynchronous clipboard copy, cleanup, unrelated text preservation, lock-during-write and rejection');

  // Fake filesystem contains only ciphertext produced from synthetic pairing data.
  const files = new Map(); let encryptGate, encryptStarted, available = true;
  const fileSystem = {
    readFileSync(name) { if (!files.has(name)) throw Error('missing'); return files.get(name); },
    writeFileSync(name, bytes) { files.set(name, bytes); }, mkdirSync() {},
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
    rmSync(name) { files.delete(name); }
  };
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return available; },
    async encryptStringAsync(value) { encryptStarted?.resolve(); if (encryptGate) await encryptGate.promise; return Buffer.from(value); },
    async decryptStringAsync(bytes) { return { result: bytes.toString(), shouldReEncrypt: false, isTemporarilyUnavailable: false }; }
  };
  const storage = createPairingStorage({ filePath: 'synthetic-pairing', safeStorage, fileSystem });
  const pairing = await createPairing({ storage });
  function finish(name) {
    const code = parseCode(pairing.startPairing().code), context = {};
    const nonceE = 'a'.repeat(32), begin = pairing.pairBegin({ nonceE, browserName: name }, context);
    const extProof = protocol.extProof(protocol.pairingAuthKey(code), 'pair', nonceE, begin.nonceA);
    return pairing.pairFinish({ nonceE, nonceA: begin.nonceA, extProof }, context);
  }
  assert.equal((await finish('Google Chrome')).paired, true);
  assert.equal((await createPairing({ storage })).list().length, 1);
  encryptGate = deferred(); encryptStarted = deferred();
  const pending = finish('Firefox'); await encryptStarted.promise;
  pairing.cancelPairing(); encryptGate.resolve();
  assert.equal((await pending).error, 'storage-failed');
  assert.equal((await createPairing({ storage })).list().length, 1, 'cancelled async encryption cannot commit');
  encryptGate = null; encryptStarted = null;
  assert.equal((await finish('Firefox')).paired, true);
  await Promise.all(pairing.list().map(({ id }) => pairing.unpair(id)));
  assert.equal(pairing.list().length, 0); assert.equal(files.size, 0, 'serialized revocations do not resurrect another pairing');
  available = false; await assert.rejects(storage.save({ synthetic: true }), /not available/);
  assert.equal(files.size, 0, 'no plaintext fallback');
  available = true;
  safeStorage.decryptStringAsync = async () => ({ isTemporarilyUnavailable: true });
  files.set('synthetic-pairing', Buffer.from('synthetic'));
  assert.equal(await storage.load(), null); assert.equal(files.size, 1, 'temporary unavailability does not erase storage');
  console.log('PASS asynchronous pairing persistence, cancellation, concurrent revocation, unavailable encryption and fail-closed load');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
