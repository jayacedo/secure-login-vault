// Generated public RFC test keys only. No vault, browser, files or clipboard reads.
const assert = require('assert/strict');
const QR = require('qrcode');
const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const { parseSetupUri, generateCode } = require('../src/services/totp');
const { decodeInWorker: decode } = require('../src/services/authenticator');
const decodeInWorker = image => decode(image, new AbortController().signal);
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const uri = `otpauth://totp/Synthetic:test?secret=${secret}&issuer=Synthetic`;
function checkCode(config) {
  try { assert.equal(generateCode(config, 59000).code, '287082'); }
  finally { config.secret.fill(0); }
}
function canvas(width, height, shade = 255) {
  const png = new PNG({ width, height }); png.data.fill(shade);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return png;
}
function paste(target, source, x, y) {
  for (let row = 0; row < source.height; row++) source.data.copy(target.data,
    ((y + row) * target.width + x) * 4, row * source.width * 4, (row + 1) * source.width * 4);
}
function image(png) { return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64'); }
async function main() {
  for (const suffix of [
    '&image=https%3A%2F%2Fexample.invalid%2Ficon&logo=ignored&color=blue&background=white&icon=ignored',
    `&SECRET=${secret.toLowerCase()}&algorithm=SHA-1&Algorithm=sha1&digits=6&digits=6&period=30&period=30&issuer=Synthetic`,
    `&secret=${secret.match(/.{1,4}/g).join('%20')}`
  ]) checkCode(parseSetupUri(uri + suffix));
  // Correct Base32 padding and unpadded representations are equivalent.
  const padded = 'JBSWY3DPEHPK3PXPAA======';
  const config = parseSetupUri(`otpauth://totp/test?secret=${padded}&SECRET=${padded.replace(/=+$/, '')}`);
  config.secret.fill(0);
  for (const suffix of [
    '&secret=JBSWY3DPEHPK3PXP', '&issuer=Different', '&algorithm=SHA1&algorithm=SHA256',
    '&digits=6&digits=8', '&period=30&period=60', '&encoder=steam', '&counter=1',
    '&algorithm=MD5', '&digits=7', '&period=0', '&secret=BAD', '&unknown=value',
    '&image=x'.repeat(33)
  ]) assert.throws(() => parseSetupUri(uri + suffix), error => error.isPublic && !error.message.includes(secret));
  const standard = PNG.sync.read(await QR.toBuffer(uri, { width: 340, margin: 4 }));
  const low = PNG.sync.read(PNG.sync.write(standard));
  for (let i = 0; i < low.data.length; i += 4) low.data[i] = low.data[i+1] = low.data[i+2] = low.data[i] < 128 ? 120 : 128;
  assert.equal(jsQR(new Uint8ClampedArray(low.data), low.width, low.height, { inversionAttempts: 'attemptBoth' }), null,
    'Regression fixture must fail the previous single-pass scanner');
  const inverted = PNG.sync.read(PNG.sync.write(standard));
  for (let i = 0; i < inverted.data.length; i += 4) for (let c = 0; c < 3; c++) inverted.data[i+c] = 255 - inverted.data[i+c];
  const rotated = canvas(standard.height, standard.width);
  for (let y = 0; y < standard.height; y++) for (let x = 0; x < standard.width; x++)
    standard.data.copy(rotated.data, (x * rotated.width + standard.height - 1 - y) * 4, (y * standard.width + x) * 4, (y * standard.width + x) * 4 + 4);
  const transparent = PNG.sync.read(PNG.sync.write(standard));
  for (let i = 0; i < transparent.data.length; i += 4) if (transparent.data[i] === 255) transparent.data[i+3] = 0;
  const screenshot = canvas(1200, 900, 200); paste(screenshot, standard, 800, 500);
  const faintScreenshot = canvas(1000, 700); paste(faintScreenshot, low, 600, 300);
  for (const [name, png] of Object.entries({ standard, low, inverted, rotated, transparent, screenshot, faintScreenshot })) {
    checkCode(await decodeInWorker(image(png)));
    console.log(`PASS synthetic ${name} QR`);
  }
  const small = await QR.toDataURL(uri, { scale: 2, margin: 4 });
  checkCode(await decodeInWorker(small));
  checkCode(await decodeInWorker(await QR.toDataURL(uri, { width: 1600 })));
  checkCode(await decodeInWorker(await QR.toDataURL(uri + '&image=https%3A%2F%2Fexample.invalid%2Ficon&algorithm=SHA-1&algorithm=sha1', { width: 420 })));
  for (const second of [standard, low]) {
    const sheet = canvas(800, 400); paste(sheet, standard, 10, 20); paste(sheet, second, 440, 20);
    await assert.rejects(decodeInWorker(image(sheet)), /More than one QR/);
  }
  const started = Date.now();
  await assert.rejects(decodeInWorker(image(canvas(1600, 1600))), /No readable QR/);
  console.log(`PASS maximum-size blank scan completes within worker deadline (${Date.now() - started} ms)`);
  const noisy = canvas(1600, 1600); let seed = 123456789;
  for (let i = 0; i < noisy.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    noisy.data[i] = noisy.data[i+1] = noisy.data[i+2] = seed >>> 31 ? 255 : 0;
  }
  // Pathological noise may hit the existing five-second worker deadline.
  // It must never return a setup or keep scanning without that bound.
  await assert.rejects(decodeInWorker(image(noisy)), /No readable QR|Reading the QR took too long/);
  console.log('PASS metadata, equivalent duplicates, conflicting/unknown settings, small QR, mixed-contrast multi-QR rejection and bounded noise scan');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
