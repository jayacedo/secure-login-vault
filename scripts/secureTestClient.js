// Independent Node crypto reference implementation for wire tests (not production Web Crypto).
const crypto = require("crypto");
function secureClient(conn, secret, ne, na) {
  const raw = conn.request.bind(conn);
  const session = ne + na;
  const key = direction => Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.from(session), "slv-secure-v2:" + direction, 32));
  let sent = 0, received = 0;
  conn.rawRequest = raw;
  conn.request = async (message, timeout) => {
    const id = crypto.randomUUID();
    const seq = ++sent;
    const iv = Buffer.alloc(12); iv.writeUInt32BE(seq, 8);
    const cipher = crypto.createCipheriv("aes-256-gcm", key("e2a"), iv);
    cipher.setAAD(Buffer.from(JSON.stringify(["slv-secure-v2", session, "e2a", seq, id])));
    const data = Buffer.concat([cipher.update(JSON.stringify(message), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("hex");
    const reply = await raw({ type: "secure", id, session, seq, data }, timeout);
    if (!reply || reply.type !== "secure") return reply;
    if (reply.session !== session || reply.id !== id || reply.seq !== received + 1) throw new Error("Bad secure response");
    const responseIV = Buffer.alloc(12); responseIV.writeUInt32BE(reply.seq, 8);
    const bytes = Buffer.from(reply.data, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key("a2e"), responseIV);
    decipher.setAAD(Buffer.from(JSON.stringify(["slv-secure-v2", session, "a2e", reply.seq, id])));
    decipher.setAuthTag(bytes.subarray(-16));
    const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8"));
    received = reply.seq;
    return value;
  };
}
module.exports = { secureClient };
