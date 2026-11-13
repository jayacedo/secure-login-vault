const crypto = require("crypto");
function fail(message) { const error = new Error(message); error.isPublic = true; throw error; }
function decodeSecret(value) {
  if (typeof value !== "string" || value.length > 104) fail("The authenticator setup key is not supported.");
  const text = value.toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(text)) fail("The authenticator setup key is not valid Base32.");
  const unpadded = text.replace(/=+$/, "");
  const remainder = unpadded.length % 8;
  const padding = { 0: 0, 2: 6, 4: 4, 5: 3, 7: 1 }[remainder];
  if (padding === undefined || (text.includes("=") && text.length - unpadded.length !== padding)) fail("The authenticator setup key is not valid Base32.");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let accumulator = 0, bits = 0; const bytes = [];
  for (const char of unpadded) {
    accumulator = (accumulator << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
    accumulator &= (1 << bits) - 1;
  }
  if (accumulator !== 0 || bytes.length < 10 || bytes.length > 64) { bytes.fill(0); fail("The authenticator setup key has an unsupported length or encoding."); }
  const secret = Buffer.from(bytes); bytes.fill(0); return secret;
}
function parseSetupUri(text) {
  if (typeof text !== "string" || text.length > 4096) fail("This QR is not a supported authenticator setup code.");
  let uri; try { uri = new URL(text); } catch { fail("This QR is not an authenticator setup code."); }
  if (uri.protocol !== "otpauth:" || uri.host !== "totp" || uri.username || uri.password || uri.hash) fail("Use a single TOTP authenticator setup QR. Sign-in links, HOTP and migration QR codes are not supported.");
  const allowed = new Set(["secret", "issuer", "algorithm", "digits", "period"]);
  for (const key of uri.searchParams.keys()) if (!allowed.has(key) || uri.searchParams.getAll(key).length !== 1) fail("This authenticator QR uses unsupported or repeated settings.");
  let account; try { account = decodeURIComponent(uri.pathname.slice(1)); } catch { fail("The authenticator account label is not valid."); }
  const issuer = uri.searchParams.get("issuer") || "";
  if (!account || account.length > 256 || issuer.length > 128 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(account + issuer)) fail("The authenticator account label is not supported.");
  const algorithm = (uri.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  const digitsText = uri.searchParams.get("digits") ?? "6", periodText = uri.searchParams.get("period") ?? "30";
  if (!["SHA1", "SHA256", "SHA512"].includes(algorithm) || !["6", "8"].includes(digitsText) || !/^[1-9]\d{1,2}$/.test(periodText) || Number(periodText) < 15 || Number(periodText) > 120) fail("Supported setups use SHA1/SHA256/SHA512, 6 or 8 digits, and a 15–120 second period.");
  return { secret: decodeSecret(uri.searchParams.get("secret")), account, issuer, algorithm, digits: Number(digitsText), period: Number(periodText) };
}
function generateCode(config, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) fail("Check your computer's date and time.");
  const seconds = Math.floor(now / 1000), counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / config.period)));
  const digest = crypto.createHmac(config.algorithm.toLowerCase(), config.secret).update(counter).digest();
  try {
    const offset = digest[digest.length - 1] & 15;
    const number = digest.readUInt32BE(offset) & 0x7fffffff;
    return { code: String(number % (10 ** config.digits)).padStart(config.digits, "0"), period: config.period,
      remaining: config.period - (seconds % config.period), validUntil: (Math.floor(seconds / config.period) + 1) * config.period * 1000 };
  } finally { digest.fill(0); counter.fill(0); }
}
module.exports = { parseSetupUri, generateCode, fail };
