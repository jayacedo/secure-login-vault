// Exercise Windows encryption only on newly generated synthetic pairing data.
// Never start SLV or read the user's existing app/profile files.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const { testTempRoot } = require('./testTemp');
const { createPairingStorage } = require('../src/services/pairingStorage');
const { createPairing } = require('../src/services/extensionPairing');
const root = fs.mkdtempSync(path.join(testTempRoot(), 'electron-storage-synthetic-'));
app.setPath('userData', root);
app.setPath('sessionData', path.join(root, 'session'));
app.whenReady().then(async () => {
  assert.equal(process.versions.electron, '45.3.2');
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true);
  const secret = crypto.randomBytes(32).toString('hex');
  const filePath = path.join(root, 'synthetic-pairing.bin');
  // Old API used solely to generate a fresh legacy-format test fixture.
  fs.writeFileSync(filePath, safeStorage.encryptString(JSON.stringify({ secret })));
  const storage = createPairingStorage({ filePath, safeStorage });
  const restored = await createPairing({ storage });
  assert.equal(restored.list().length, 1, 'new API reads synthetic old-format encryption');
  await storage.save({ version: 2, pairings: [{ secret, name: 'Firefox', createdAt: 1 }] });
  assert.equal(fs.readFileSync(filePath).includes(Buffer.from(secret)), false);
  const reloaded = await createPairing({ storage });
  assert.equal(reloaded.list()[0].name, 'Firefox');
  await reloaded.unpair(); assert.equal(fs.existsSync(filePath), false);
  console.log('PASS Electron 45 runtime, synthetic legacy ciphertext compatibility, async DPAPI save/reload and revocation');
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
