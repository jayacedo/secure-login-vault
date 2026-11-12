const assert = require("assert/strict");
const crypto = require("crypto");
const { createPairing, parseCode } = require("../src/services/extensionPairing");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { createExtensionHandlers } = require("../src/services/extensionHandlers");
const { getPipeName } = require("../src/native-host/pipeName");
const { connect, authenticate } = require("./pairingTestClient");
const browserProofs = require("../extension/pairing");
const mac = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
const idFor = secret => mac(secret, "slv-pairing-id-v1");
const nonce = () => crypto.randomBytes(16).toString("hex");
const derive = (key, salt, info) => Buffer.from(crypto.hkdfSync("sha256", key, salt, info, 32));

function newPair(manager, name, prior, replaceId) {
  const code = parseCode(manager.startPairing().code);
  const nonceE = nonce(), context = {};
  const begin = manager.pairBegin({ nonceE, browserName: name }, context);
  const key = derive(code, "slv-pair-v1", "auth");
  assert.equal(begin.appProof, mac(key, `pair-app|${nonceE}|${begin.nonceA}`));
  const extProof = mac(key, `pair-ext|${nonceE}|${begin.nonceA}`);
  const secret = derive(code, Buffer.from(nonceE + begin.nonceA), "secret");
  const request = { nonceE, nonceA: begin.nonceA, extProof };
  if (prior) Object.assign(request, { replaceId: replaceId || idFor(prior), replaceProof: mac(prior, `slv-repair-v1|${nonceE}|${begin.nonceA}|${extProof}`) });
  return { secret, id: idFor(secret), finish: manager.pairFinish(request, context) };
}
async function auth(manager, secret, legacy = false) {
  const nonceE = nonce(), context = {};
  const begin = manager.authBegin({ nonceE, ...(!legacy && { pairingId: idFor(secret) }) }, context);
  if (begin.error) return { begin, context };
  assert.equal(begin.appProof, mac(secret, `auth-v2-app|${nonceE}|${begin.nonceA}`));
  const finish = await manager.authFinish({ nonceE, nonceA: begin.nonceA, extProof: mac(secret, `auth-v2-ext|${nonceE}|${begin.nonceA}`) }, context);
  return { begin, finish, context };
}
async function main() {
  const oldSecret = crypto.randomBytes(32);
  let disk = { secret: oldSecret.toString("hex") }, fail = false;
  const storage = { load: () => disk, save: value => { if (fail) throw Error("disk failure"); disk = structuredClone(value); }, clear: () => { if (fail) throw Error("disk failure"); disk = null; } };
  let manager = createPairing({ storage });
  assert.equal((await auth(manager, oldSecret, true)).finish.authenticated, true);
  const chrome = newPair(manager, "Google Chrome");
  const firefox = newPair(manager, "Firefox");
  assert.equal(chrome.finish.paired, true); assert.equal(firefox.finish.paired, true);
  assert.equal(disk.version, 2); assert.equal(disk.pairings.length, 3);
  assert.equal((await auth(manager, oldSecret, true)).finish.authenticated, true, "legacy client survives adding browsers");
  manager = createPairing({ storage });
  const chromeAuth = await auth(manager, chrome.secret), firefoxAuth = await auth(manager, firefox.secret);
  assert.equal(chromeAuth.finish.authenticated, true); assert.equal(firefoxAuth.finish.authenticated, true);
  for (const secret of [oldSecret, chrome.secret, firefox.secret]) assert.equal(JSON.stringify(manager.list()).includes(secret.toString("hex")), false);
  assert.equal(await browserProofs.pairingId(chrome.secret), chrome.id, "browser and independent Node ID vectors agree");
  assert.equal(await browserProofs.replaceProof(chrome.secret, "e", "a", "p"), mac(chrome.secret, "slv-repair-v1|e|a|p"));
  console.log("PASS legacy migration, three independent pairings, restart persistence, public metadata and cross-runtime protocol vectors");

  // Starting another pairing cannot invalidate a different browser's in-flight auth.
  const pendingContext = {}, nonceE = nonce();
  const pending = manager.authBegin({ nonceE, pairingId: firefox.id }, pendingContext);
  const attack = newPair(manager, "Microsoft Edge", chrome.secret, firefox.id);
  assert.equal(attack.finish.error, "bad-proof", "knowing one secret cannot rotate another browser");
  const rotated = newPair(manager, "Google Chrome", chrome.secret);
  assert.equal(rotated.finish.paired, true); assert.equal(manager.list().length, 3);
  assert.equal((await auth(manager, chrome.secret)).begin.error, "not-paired");
  assert.equal(chromeAuth.context.isPairingCurrent(), false);
  assert.equal(firefoxAuth.context.isPairingCurrent(), true);
  assert.equal((await manager.authFinish({ nonceE, nonceA: pending.nonceA, extProof: mac(firefox.secret, `auth-v2-ext|${nonceE}|${pending.nonceA}`) }, pendingContext)).authenticated, true);
  assert.equal((await auth(manager, rotated.secret)).finish.authenticated, true);
  console.log("PASS own-key rotation without duplicates, forged replacement rejection, and unaffected active/pending peer sessions");

  fail = true;
  assert.equal(newPair(manager, "Microsoft Edge").finish.error, "storage-failed");
  assert.throws(() => manager.unpair(firefox.id), /disk failure/);
  assert.equal(firefoxAuth.context.isPairingCurrent(), true, "failed revocation leaves persisted and live state consistent");
  fail = false;
  manager.unpair(firefox.id);
  assert.equal(firefoxAuth.context.isPairingCurrent(), false);
  assert.equal((await auth(manager, rotated.secret)).finish.authenticated, true);
  assert.equal(createPairing({ storage }).list().length, 2);
  assert.throws(() => manager.unpair(""), /Invalid/);
  const limited = createPairing({ storage, limits: { maxPairings: 2 } });
  assert.equal(newPair(limited, "Firefox").finish.error, "pairing-limit");
  assert.equal(limited.list().length, 2, "capacity never silently evicts a browser");
  assert.equal(newPair(limited, "Google Chrome", rotated.secret).finish.paired, true, "rotation at capacity is allowed");
  console.log("PASS targeted revocation, atomic storage failures, malformed IDs and capacity limits without eviction");

  // Real encrypted connections: removing A aborts its pending save, while B
  // keeps using the same already-authenticated connection.
  let state;
  manager = createPairing({ storage: { load: () => state, save: v => { state = v; }, clear: () => { state = null; } } });
  const a = newPair(manager, "Google Chrome"), b = newPair(manager, "Firefox");
  let approved, prompted, writes = 0;
  const shown = new Promise(resolve => { prompted = resolve; });
  const bridge = createExtensionBridge({ pipeName: getPipeName("multi-pair-" + process.pid), handlers: createExtensionHandlers({
    getAppVersion: () => "test", pairing: manager, vault: { getCredentials: async () => [], addCredential: async () => { writes++; } },
    approveSave: () => { prompted(); return new Promise(resolve => { approved = resolve; }); }
  }) });
  await bridge.start();
  const first = await connect(getPipeName("multi-pair-" + process.pid)), second = await connect(getPipeName("multi-pair-" + process.pid));
  try {
    assert.equal((await authenticate(first, a.secret)).finish.ok, true);
    assert.equal((await authenticate(second, b.secret)).finish.ok, true);
    const saving = first.request({ type: "save-login", url: "https://example.test", username: "dummy", password: "dummy-password" });
    await shown;
    manager.unpair(a.id); bridge.closeConnections(a.id);
    await first.whenClosed(); approved(true);
    await saving;
    assert.equal((await second.request({ type: "channel-check" })).ok, true);
    assert.equal(writes, 0, "revoked browser cannot commit a pending save");
    manager.unpair(); bridge.closeConnections();
    await second.whenClosed();
    assert.equal(manager.list().length, 0);
  } finally { first.close(); second.close(); await bridge.stop(); }
  console.log("PASS selective live-connection closure, pending save cancellation, unaffected peer and unpair-all");
}
setTimeout(() => { console.error("Multi-pairing test timed out"); process.exit(1); }, 30000).unref();
main().catch(error => { console.error(error); process.exitCode = 1; });
