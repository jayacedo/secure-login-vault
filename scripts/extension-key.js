// Helpers for the browser extension's fixed ID.
//
// Chrome derives an extension's ID from its public key. Putting that public key in
// manifest.json ("key") gives the extension the same ID on every computer, so the
// browser helper can allow exactly that extension. Only the PUBLIC key is needed
// for an unpacked extension; the private key is never stored.
//
//   node scripts/extension-key.js id        show the ID the current manifest produces
//   node scripts/extension-key.js generate  make a NEW key pair (changes the ID!)
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Chrome's algorithm: SHA-256 of the DER public key, first 16 bytes, each hex digit
// written as a letter a-p.
function extensionIdFromPublicKey(base64Key) {
  const der = Buffer.from(base64Key, "base64");
  const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode("a".charCodeAt(0) + parseInt(digit, 16))).join("");
}

function generateKey() {
  const { publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" }
  });
  // The private key is dropped on purpose; see the note at the top of this file.
  const key = publicKey.toString("base64");
  return { key, id: extensionIdFromPublicKey(key) };
}

const manifestPath = path.join(__dirname, "..", "extension", "manifest.json");

if (require.main === module) {
  const command = process.argv[2];
  if (command === "generate") {
    const { key, id } = generateKey();
    console.log(JSON.stringify({ key, id }, null, 2));
  } else if (command === "id") {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    console.log(extensionIdFromPublicKey(manifest.key));
  } else {
    console.error("Usage: node scripts/extension-key.js id | generate");
    process.exit(2);
  }
}

module.exports = { extensionIdFromPublicKey, generateKey, manifestPath };
