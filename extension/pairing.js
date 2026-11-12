// The extension's side of pairing and authentication with the desktop app, using the
// browser's built-in WebCrypto. It must agree, byte for byte, with the app's side
// (src/services/extensionPairing.js); scripts/extension-link-test.js checks that.
//
// The pairing code is 128 random bits shown in the app. It is typed or pasted here,
// used only to compute proofs, and never sent anywhere. See the app's file for the
// whole protocol and why it is built this way.
(function (root) {
  var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0 or 1
  var CODE_LENGTH = 26; // 128 bits in groups of 5 bits
  var NONCE_HEX = /^[0-9a-f]{32}$/;
  var PROOF_HEX = /^[0-9a-f]{64}$/;
  var SECRET_HEX = /^[0-9a-f]{64}$/;

  function subtle() {
    return root.crypto.subtle;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  function toHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 1) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  function fromHex(hex) {
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }

  // What a person may type or paste (any case, spaces, dashes) -> 16 bytes, or null.
  function parseCode(text) {
    if (typeof text !== "string" || text.length > 100) return null;
    var clean = text.toUpperCase().replace(/[\s-]/g, "");
    if (clean.length !== CODE_LENGTH) return null;

    var bits = 0;
    var value = 0;
    var bytes = [];
    for (var i = 0; i < clean.length; i += 1) {
      var index = ALPHABET.indexOf(clean.charAt(i));
      if (index < 0) return null;
      value = (value << 5) | index;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
      value &= (1 << bits) - 1;
    }
    if (value !== 0) return null; // the unused trailing bits must be zero
    return new Uint8Array(bytes);
  }

  function randomNonce() {
    return toHex(root.crypto.getRandomValues(new Uint8Array(16)));
  }

  // HKDF-SHA-256 -> 32 bytes
  function hkdf(ikm, salt, info) {
    return subtle()
      .importKey("raw", ikm, "HKDF", false, ["deriveBits"])
      .then(function (key) {
        return subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: utf8(info) }, key, 256);
      })
      .then(function (bits) {
        return new Uint8Array(bits);
      });
  }

  function hmacHex(keyBytes, text) {
    return subtle()
      .importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      .then(function (key) {
        return subtle().sign("HMAC", key, utf8(text));
      })
      .then(function (signature) {
        return toHex(new Uint8Array(signature));
      });
  }

  // Compares two strings without stopping at the first difference.
  function equalHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    var difference = 0;
    for (var i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
  }

  var api = {
    pairingId: function (secret) { return hmacHex(secret, "slv-pairing-id-v1"); },
    replaceProof: function (secret, nonceE, nonceA, proof) { return hmacHex(secret, "slv-repair-v1|" + nonceE + "|" + nonceA + "|" + proof); },
    parseCode: parseCode,
    randomNonce: randomNonce,
    toHex: toHex,
    fromHex: fromHex,
    equalHex: equalHex,
    isNonce: function (value) {
      return typeof value === "string" && NONCE_HEX.test(value);
    },
    isProof: function (value) {
      return typeof value === "string" && PROOF_HEX.test(value);
    },
    isSecretHex: function (value) {
      return typeof value === "string" && SECRET_HEX.test(value);
    },
    // Key that proves knowledge of the pairing code.
    pairingAuthKey: function (codeBytes) {
      return hkdf(codeBytes, utf8("slv-pair-v1"), "auth");
    },
    // The long-term secret both sides derive once pairing succeeds.
    pairingSecret: function (codeBytes, nonceE, nonceA) {
      return hkdf(codeBytes, utf8(nonceE + nonceA), "secret");
    },
    // label is "pair" while pairing, "auth" on every connection after that.
    appProof: function (keyBytes, label, nonceE, nonceA) {
      return hmacHex(keyBytes, label + "-app|" + nonceE + "|" + nonceA);
    },
    extProof: function (keyBytes, label, nonceE, nonceA) {
      return hmacHex(keyBytes, label + "-ext|" + nonceE + "|" + nonceA);
    }
  };

  root.SLVPairing = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
