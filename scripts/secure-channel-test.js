const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const { createChannel, TTL_MS, MAX_BYTES } = require("../src/shared/secureChannel");
const { createPairing } = require("../src/services/extensionPairing");
const { createExtensionHandlers } = require("../src/services/extensionHandlers");
const { createExtensionBridge } = require("../src/services/extensionBridge");
const { getPipeName } = require("../src/native-host/pipeName");
const { connect, authenticate } = require("./pairingTestClient");
const { createSecretStorage } = require("../extension/secretStorage");
const secret = Buffer.from("ab".repeat(32), "hex");
const nonceE = "12".repeat(16), nonceA = "34".repeat(16);
const make = role => createChannel({ secret, nonceE, nonceA, role, crypto: crypto.webcrypto });

async function cryptoTests() {
  assert.ok(fs.readFileSync("src/shared/secureChannel.js").equals(fs.readFileSync("extension/secureChannel.js")), "browser crypto copy is current");
  let app = await make("app"), ext = await make("extension");
  const value = { type: "save-login", username: "dummy-user", password: "dummy-secret", url: "https://example.test" };
  const packet = await ext.seal(value, "id-1");
  // Independent native AES-GCM + HKDF implementation verifies exact bytes and transcript.
  const session = nonceE + nonceA;
  const key = crypto.hkdfSync("sha256", secret, Buffer.from(session), "slv-secure-v2:e2a", 32);
  const iv = Buffer.alloc(12); iv.writeUInt32BE(1, 8);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["slv-secure-v2", session, "e2a", 1, "id-1"])));
  assert.equal(packet.data, Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("hex"));
  assert.deepEqual(await app.open(packet), value);
  const reply = await app.seal({ ok: true, password: "dummy-secret" }, "id-1");
  assert.deepEqual(await ext.open(reply), { ok: true, password: "dummy-secret" });
  assert.equal(JSON.stringify([packet, reply]).includes("dummy-secret"), false);
  await assert.rejects(app.open(packet), /Secure channel failed/, "replay closes the channel");
  await assert.rejects(app.seal({ ok: true }, "next"));

  for (const mutate of [
    p => ({ ...p, id: "other-id" }), p => ({ ...p, seq: 2 }),
    p => ({ ...p, session: "56".repeat(32) }), p => ({ ...p, type: "get-login" }),
    p => ({ ...p, data: (p.data[0] === "a" ? "b" : "a") + p.data.slice(1) }),
    p => ({ ...p, data: p.data.slice(0, -2) + (p.data.endsWith("00") ? "01" : "00") }),
    p => ({ ...p, ok: true }), p => ({ ...p, data: "ff".repeat(MAX_BYTES + 17) }),
    p => ({ ...p, seq: Number.MAX_SAFE_INTEGER + 1 }), p => ({ ...p, data: "xyz" })
  ]) {
    app = await make("app");
    await assert.rejects(app.open(mutate(packet)));
    await assert.rejects(app.open(packet), "failure is terminal, even a valid retry fails");
  }
  ext = await make("extension");
  await assert.rejects(ext.open(packet), "request reflected as a response cannot authenticate");
  app = await createChannel({ secret, nonceE, nonceA: "56".repeat(16), role: "app" });
  await assert.rejects(app.open(packet), "messages from another session cannot be replayed");
  let clock = 0;
  app = await createChannel({ secret, nonceE, nonceA, role: "app", now: () => clock });
  clock = TTL_MS;
  await assert.rejects(app.open(packet), "expired session refuses messages");
  ext = await make("extension");
  await assert.rejects(ext.seal({ padding: "x".repeat(MAX_BYTES) }, "oversized"));
}

async function wireTests() {
  let writes = 0, prompts = 0;
  let stored = { secret: secret.toString("hex") };
  const pairing = createPairing({ storage: { load: () => stored, save: v => { stored = v; }, clear: () => { stored = null; } } });
  const handlers = createExtensionHandlers({ getAppVersion: () => "test", pairing,
    vault: { getCredentials: async () => [], addCredential: async () => { writes++; } },
    approveSave: async () => { prompts++; return true; }
  });
  const pipeName = getPipeName("secure-test-" + process.pid);
  const bridge = createExtensionBridge({ pipeName, handlers });
  await bridge.start();
  const conns = [];
  async function session() {
    const conn = await connect(pipeName); conns.push(conn);
    const auth = await authenticate(conn, secret);
    assert.equal(auth.finish.ok, true);
    return { conn, channel: await createChannel({ secret, nonceE: auth.nonceE, nonceA: auth.begin.nonceA, role: "extension" }) };
  }
  async function close(conn) { conn.close(); await conn.whenClosed(); await new Promise(r => setTimeout(r, 15)); }
  try {
    const raw = await connect(pipeName); conns.push(raw);
    assert.equal((await raw.request({ type: "save-login", url: "https://example.test", username: "dummy", password: "dummy" })).error, "not-authenticated");
    // v1 proof is rejected even if the attacker lies about a ping's version.
    const begin = await raw.request({ type: "auth-begin", nonceE });
    const oldProof = crypto.createHmac("sha256", secret).update(`auth-ext|${nonceE}|${begin.nonceA}`).digest("hex");
    assert.equal((await raw.request({ type: "auth-finish", nonceE, nonceA: begin.nonceA, extProof: oldProof })).error, "bad-proof");
    await close(raw);

    let { conn, channel } = await session();
    const packet = await channel.seal({ type: "save-login", url: "https://example.test", username: "dummy", password: "wire-secret" }, "save-id");
    const wireReply = await conn.rawRequest(packet);
    assert.equal(JSON.stringify([packet, wireReply]).includes("wire-secret"), false);
    assert.equal((await channel.open(wireReply)).mode, "add");
    assert.equal(writes, 1); assert.equal(prompts, 1);
    assert.equal(await conn.rawRequest(packet), null, "replaying a write disconnects");
    assert.equal(writes, 1); assert.equal(prompts, 1);
    await close(conn);

    ({ conn, channel } = await session());
    const altered = await channel.seal({ type: "save-login", url: "https://example.test", username: "dummy", password: "wire-secret" }, "tampered");
    altered.data = (altered.data[0] === "a" ? "b" : "a") + altered.data.slice(1);
    assert.equal(await conn.rawRequest(altered), null);
    assert.equal(writes, 1); assert.equal(prompts, 1, "tampering never reaches approval");
    await close(conn);

    ({ conn } = await session());
    assert.equal(await conn.rawRequest({ type: "save-login", url: "https://example.test", username: "dummy", password: "plain" }), null, "authenticated connections cannot downgrade to plaintext");
    assert.equal(writes, 1);
    await close(conn);

    ({ conn, channel } = await session());
    pairing.unpair();
    assert.equal(await conn.rawRequest(await channel.seal({ type: "channel-check" }, "revoked")), null, "revocation invalidates existing keys even before socket cleanup");
    await close(conn);
  } finally { conns.forEach(c => c.close()); await bridge.stop(); }
}

async function storageTests() {
  const disk = { slvPairingSecret: secret.toString("hex") }, memory = {};
  const scopes = [];
  const area = (data, label) => ({
    setAccessLevel: async settings => scopes.push([label, settings.accessLevel]),
    get: async key => ({ [key]: data[key] }), set: async values => Object.assign(data, values), remove: async key => { delete data[key]; }
  });
  const chrome = { storage: { local: area(disk, "local"), session: area(memory, "session") } };
  let storage = createSecretStorage(chrome);
  assert.equal(await storage.get(), secret.toString("hex"), "existing pairing survives upgrade");
  assert.deepEqual(scopes, [["local", "TRUSTED_CONTEXTS"], ["session", "TRUSTED_CONTEXTS"]]);
  await storage.setSessionOnly(true);
  assert.equal(disk.slvPairingSecret, undefined);
  assert.equal(memory.slvPairingSecret, secret.toString("hex"));
  storage = createSecretStorage(chrome);
  assert.equal(await storage.get(), secret.toString("hex"), "worker restart preserves browser-session pairing");
  delete memory.slvPairingSecret;
  assert.equal(await storage.get(), null, "browser restart loses session-only pairing");
  await storage.set(secret.toString("hex"));
  assert.equal(disk.slvPairingSecret, undefined, "pairing in session mode never writes the secret to local storage");
  await storage.setSessionOnly(false);
  assert.equal(disk.slvPairingSecret, secret.toString("hex"));
  assert.equal(memory.slvPairingSecret, undefined);
  await storage.clear();
  assert.equal(await storage.get(), null);
  const bad = createSecretStorage({ storage: { local: { ...chrome.storage.local, setAccessLevel: async () => { throw new Error("refused"); } }, session: chrome.storage.session } });
  await assert.rejects(bad.get(), "failure to restrict storage fails closed");
}
(async () => {
  await cryptoTests(); await wireTests(); await storageTests();
  console.log("PASS secure transport: independent AES-GCM/HKDF vector, bidirectional encryption, tampering, replay, reflection, wrong session, expiry, size limits, plaintext downgrade, revocation and pairing storage");
})().catch(error => { console.error(error); process.exit(1); });
