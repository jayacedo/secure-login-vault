// Message framing shared by the browser <-> helper link (Chrome's native messaging
// format) and the helper <-> app link (same format, so there is one parser to trust):
//
//   [4-byte little-endian length][UTF-8 JSON of that length]
//
// The reader is a streaming parser: bytes can arrive in any chunking, several
// messages can arrive at once, and anything malformed or oversized stops the
// stream instead of being guessed at.

// Chrome itself refuses messages from a native host larger than 1 MiB, so we use
// the same ceiling in both directions.
const MAX_MESSAGE_BYTES = 1024 * 1024;

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new RangeError("Message is too large.");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// onMessage(value) is called once per complete message. onError(error) is called
// at most once; after it, the reader ignores all further input.
function createMessageReader({ onMessage, onError, maxBytes = MAX_MESSAGE_BYTES }) {
  let buffered = Buffer.alloc(0);
  let failed = false;

  function fail(error) {
    failed = true;
    buffered = Buffer.alloc(0);
    onError(error);
  }

  return {
    push(chunk) {
      if (failed) return;
      buffered = buffered.length > 0 ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);

      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);

        if (length === 0) return fail(new RangeError("Empty message."));
        if (length > maxBytes) return fail(new RangeError("Message is too large."));
        if (buffered.length < 4 + length) return; // wait for the rest

        const body = buffered.subarray(4, 4 + length);
        buffered = buffered.subarray(4 + length);

        let value;
        try {
          value = JSON.parse(body.toString("utf8"));
        } catch {
          return fail(new SyntaxError("Message is not valid JSON."));
        }

        onMessage(value);
        if (failed) return;
      }
    },

    get failed() {
      return failed;
    }
  };
}

module.exports = { MAX_MESSAGE_BYTES, encodeMessage, createMessageReader };
