const crypto = require('crypto');
const path = require('path');
const { performance } = require('perf_hooks');
const fail = () => Object.assign(new Error('Export approval expired or was cancelled. Confirm your master password again.'), { isPublic: true });
function createExportApproval(now = () => performance.now(), lifetime = 120000) {
  let generation = 0, pending = null;
  const clear = () => { generation++; pending = null; };
  function assertLive(record, epoch) {
    if (!record || record.generation !== generation || record.epoch !== epoch || now() >= record.expiresAt) throw fail();
  }
  function validate(token, format, epoch) {
    assertLive(pending, epoch);
    if (typeof token !== 'string' || pending.token !== token || pending.format !== format) throw fail();
    return pending;
  }
  return {
    clear,
    begin() { clear(); return generation; },
    approve(started, format, epoch) {
      if (started !== generation || !['csv', 'json'].includes(format)) throw fail();
      pending = { token: crypto.randomBytes(32).toString('hex'), format, epoch, generation, expiresAt: now() + lifetime, filePath: null };
      return pending.token;
    },
    validate,
    bind(token, format, epoch, filePath) {
      const record = validate(token, format, epoch);
      if (record.filePath || typeof filePath !== 'string' || !filePath) throw fail();
      record.filePath = path.resolve(filePath);
    },
    consume(token, format, epoch, filePath) {
      try {
        const record = validate(token, format, epoch);
        if (typeof filePath !== 'string' || !record.filePath || record.filePath !== path.resolve(filePath)) throw fail();
        return { ...record };
      } finally { pending = null; }
    },
    assertLive
  };
}
module.exports = { createExportApproval };
