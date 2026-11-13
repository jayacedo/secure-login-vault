const { PNG } = require("pngjs");
const jsQR = require("jsqr");
const { parseSetupUri, fail } = require("./totp");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_DIMENSION = 1600;
function validateImage(image) {
  if (typeof image !== "string" || image.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) fail("Upload the QR image again using SLV's QR field. A PNG image up to 8 MB is required.");
}
function decodeQr(image) {
  validateImage(image);
  const bytes = Buffer.from(image.slice(image.indexOf(",") + 1), "base64"); let pixels, found;
  try {
    if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") fail("The QR image is not a valid PNG.");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) fail("Crop to one QR code and upload it again (maximum 1600 pixels per side).");
    const png = PNG.sync.read(bytes, { checkCRC: true }); pixels = png.data;
    // Composite transparent input on white before scanning.
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3] / 255;
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c] * alpha + 255 * (1 - alpha));
      pixels[i + 3] = 255;
    }
    const rgba = new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    found = jsQR(rgba, width, height, { inversionAttempts: "attemptBoth" });
    if (!found) fail("No readable QR code found. Upload a clear image cropped around the setup QR.");
    // Reject a sheet containing several QR codes instead of silently choosing one.
    const corners = [found.location.topLeftCorner, found.location.topRightCorner, found.location.bottomLeftCorner, found.location.bottomRightCorner];
    const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x))) - 6), right = Math.min(width, Math.ceil(Math.max(...corners.map(p => p.x))) + 6);
    const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))) - 6), bottom = Math.min(height, Math.ceil(Math.max(...corners.map(p => p.y))) + 6);
    for (let y = top; y < bottom; y++) pixels.fill(255, (y * width + left) * 4, (y * width + right) * 4);
    const another = jsQR(rgba, width, height, { inversionAttempts: "attemptBoth" });
    if (another) { another.binaryData?.fill(0); fail("More than one QR code found. Crop to a single authenticator setup QR."); }
    return parseSetupUri(found.data);
  } catch (error) {
    if (error.isPublic) throw error;
    fail("Could not read this QR image. Try uploading a clear, cropped setup QR.");
  } finally { bytes.fill(0); pixels?.fill(0); found?.binaryData?.fill(0); }
}
module.exports = { decodeQr, validateImage };
