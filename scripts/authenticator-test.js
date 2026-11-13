const assert = require("assert/strict");
const QR = require("qrcode");
const { PNG } = require("pngjs");
const { parseSetupUri, generateCode } = require("../src/services/totp");
const { decodeQr } = require("../src/services/authenticatorQr");
const { createAuthenticator, decodeInWorker, SESSION_MS } = require("../src/services/authenticator");
const uri = "otpauth://totp/Dummy%3Atest?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Dummy";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  // RFC 6238 Appendix B, including the timestamp beyond 32-bit Unix time.
  const vectors = [
    [59, "94287082", "46119246", "90693936"], [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"], [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"], [20000000000, "65353130", "77737706", "47863826"]
  ];
  for (const [time, ...codes] of vectors) for (const [i, algorithm] of ["SHA1", "SHA256", "SHA512"].entries()) {
    const secret = Buffer.from("1234567890".repeat(7).slice(0, [20, 32, 64][i]));
    assert.equal(generateCode({ secret, algorithm, digits: 8, period: 30 }, time * 1000).code, codes[i]); secret.fill(0);
  }
  const config = parseSetupUri(uri);
  assert.equal(config.secret.toString(), "12345678901234567890");
  assert.equal(config.account, "Dummy:test"); assert.equal(config.digits, 6);
  assert.equal(generateCode(config, 1111111109000).code, "081804");
  assert.equal(generateCode(config, 29999).remaining, 1);
  assert.equal(generateCode(config, 30000).remaining, 30);
  assert.notEqual(generateCode(config, 29999).code, generateCode(config, 30000).code);
  const sixty = parseSetupUri(uri + "&period=60&digits=8&algorithm=sha256");
  assert.equal(generateCode(sixty, 59000).remaining, 1); sixty.secret.fill(0);
  for (const bad of ["https://example.test/login", "javascript:alert(1)", uri.replace("totp", "hotp"), uri.replace("otpauth:", "otpauth-migration:"),
    uri + "&secret=OTHER", uri + "&encoder=steam", uri + "&counter=1", uri + "&digits=7", uri + "&digits=", uri + "&period=0", uri + "&period=121", uri + "&algorithm=", uri + "#fragment",
    uri.replace("Dummy%3Atest", "%00bad"), uri.replace(/secret=[^&]+/, "secret=JBSWY3DP"), uri.replace(/secret=[^&]+/, "secret=INVALID!"), uri.replace(/secret=[^&]+/, "secret=AAAAAAAAAAAAAAAAA"),
    uri.replace(/secret=[^&]+/, "secret=AAAAAAAAAAAAAAAA="), uri.replace(/secret=[^&]+/, "secret=AAAAAAAAAAAAAAAAAB")]) {
    assert.throws(() => parseSetupUri(bad), error => error.isPublic && !error.message.includes("secret="));
  }
  assert.throws(() => generateCode(config, -1)); config.secret.fill(0);
  const image = await QR.toDataURL(uri, { width: 340, margin: 4 });
  const decoded = decodeQr(image); assert.equal(decoded.account, "Dummy:test"); decoded.secret.fill(0);
  const workerDecoded = await decodeInWorker(image, new AbortController().signal); assert.equal(workerDecoded.account, "Dummy:test"); workerDecoded.secret.fill(0);
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(decodeInWorker(image, cancelled.signal), /cancelled/);
  for (const value of ["not an image", "data:image/png;base64,YQ==", await QR.toDataURL("https://example.test")]) assert.throws(() => decodeQr(value), error => error.isPublic);
  const oversized = Buffer.from(image.split(",")[1], "base64"); oversized.writeUInt32BE(100000, 16);
  assert.throws(() => decodeQr("data:image/png;base64," + oversized.toString("base64")), /1600/);
  const blank = new PNG({ width: 100, height: 100 }); blank.data.fill(255);
  assert.throws(() => decodeQr("data:image/png;base64," + PNG.sync.write(blank).toString("base64")), /No readable/);
  const one = PNG.sync.read(Buffer.from(image.split(",")[1], "base64")); const sheet = new PNG({ width: one.width * 2, height: one.height });
  PNG.bitblt(one, sheet, 0, 0, one.width, one.height, 0, 0); PNG.bitblt(one, sheet, 0, 0, one.width, one.height, one.width, 0);
  assert.throws(() => decodeQr("data:image/png;base64," + PNG.sync.write(sheet).toString("base64")), /More than one|No readable/);
  let unlocked = true, epoch = 1, time = 59000, clipboardText = "unrelated", lastSecret;
  const vault = { isUnlocked: () => unlocked, getOperationEpoch: () => epoch };
  const clipboard = { readText: () => clipboardText, writeText: value => { clipboardText = value; }, clear: () => { clipboardText = ""; } };
  const manager = createAuthenticator({ vault, clipboard, now: () => time, decode: async () => { const result = parseSetupUri(uri); lastSecret = result.secret; return result; } });
  const first = await manager.start(image); assert.match(first.token, /^[0-9a-f]{48}$/); assert.equal(first.code, "287082");
  assert.equal("secret" in first, false); assert.equal("uri" in first, false);
  time = 60000; assert.equal(manager.copy(first.token).code, generateCode(parseSetupUri(uri), time).code); assert.notEqual(clipboardText, first.code);
  manager.stop(first.token); assert.ok(lastSecret.every(byte => byte === 0)); assert.notEqual(clipboardText, ""); manager.clear(); assert.equal(clipboardText, "");
  const second = await manager.start(image); manager.copy(second.token); clipboardText = "user copied something else"; manager.clear(); assert.equal(clipboardText, "user copied something else");
  const third = await manager.start(image); time += SESSION_MS; assert.throws(() => manager.read(third.token), /expired/); assert.ok(lastSecret.every(byte => byte === 0));
  const fourth = await manager.start(image); epoch++; assert.throws(() => manager.read(fourth.token), /expired/);
  const fifth = await manager.start(image); unlocked = false; assert.throws(() => manager.copy(fifth.token), /Unlock/); assert.ok(lastSecret.every(byte => byte === 0));
  await assert.rejects(manager.start(image), /Unlock/); unlocked = true;
  let finish; const pendingManager = createAuthenticator({ vault, clipboard, decode: () => new Promise(resolve => { finish = resolve; }) });
  const pending = pendingManager.start(image); pendingManager.clear(); const late = parseSetupUri(uri); finish(late);
  await assert.rejects(pending, /session changed/); assert.ok(late.secret.every(byte => byte === 0));
  let finishRead, decodeCalls = 0;
  const savedManager = createAuthenticator({ vault, clipboard, decode: async () => { decodeCalls++; return parseSetupUri(uri); } });
  const pendingRead = savedManager.start(() => new Promise(resolve => { finishRead = resolve; }));
  savedManager.stop(); finishRead(image);
  await assert.rejects(pendingRead, /session changed/); assert.equal(decodeCalls, 0);
  const lockedRead = savedManager.start(() => new Promise(resolve => { finishRead = resolve; }));
  unlocked = false; epoch++; finishRead(image);
  await assert.rejects(lockedRead, /session changed/); assert.equal(decodeCalls, 0); unlocked = true;
  const saved = await savedManager.start(async () => image); assert.match(saved.code, /^\d{6}$/); savedManager.clear();
  time = 59995; const expiring = await manager.start(image); manager.copy(expiring.token); await sleep(30); assert.equal(clipboardText, ""); manager.clear();
  console.log("PASS 18 RFC vectors, URI/QR validation, single-image decoding, worker cancellation, rollover copy, session/lock guards, seed wiping and clipboard expiry/preservation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
