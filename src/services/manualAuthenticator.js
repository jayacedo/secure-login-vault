const QR = require('qrcode');
const { parseSetupUri, fail } = require('./totp');

async function createSetupQr(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('Enter an authenticator setup key.');
  const { secret, algorithm = 'SHA1', digits = '6', period = '30' } = options;
  if (typeof secret !== 'string' || secret.length > 256) fail('Enter a valid authenticator setup key.');
  // Sites commonly display Base32 in groups. Do not silently strip punctuation.
  const normalized = secret.replace(/[ \t\r\n]/g, '').toUpperCase();
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm) || !['6', '8'].includes(digits)
      || typeof period !== 'string' || !/^[1-9]\d{1,2}$/.test(period) || Number(period) < 15 || Number(period) > 120) {
    fail('Use SHA1/SHA256/SHA512, 6 or 8 digits, and a 15–120 second interval.');
  }
  const uri = new URL('otpauth://totp/Manual%20setup');
  uri.search = new URLSearchParams({ secret: normalized, algorithm, digits, period }).toString();
  const parsed = parseSetupUri(uri.href); // Same strict Base32 rules as uploaded QR codes.
  parsed.secret.fill(0);
  return { image: await QR.toDataURL(uri.href, { width: 420, margin: 4, errorCorrectionLevel: 'M' }) };
}
module.exports = { createSetupQr };
