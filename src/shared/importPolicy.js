// Shared import limits; no file, DOM or vault access. Main process revalidates.
const ImportPolicy = (() => {
  const MAX_BYTES = 16 * 1024 * 1024, MAX_ROWS = 5000, MAX_COLUMNS = 32, MAX_CELL = 100000;
  const limits = Object.freeze({ websiteName: 500, websiteUrl: 4096, category: 200,
    username: 1024, email: 1024, password: 4096, tags: 4000, groupName: 200,
    notes: 100000, qrCode: 12 * 1024 * 1024 });
  const fail = message => { throw Object.assign(new Error(message), { isPublic: true }); };
  function text(content) {
    if (typeof content !== 'string' || content.length > MAX_BYTES || new TextEncoder().encode(content).length > MAX_BYTES) fail('Import files must be 16 MB or smaller. Split the file and try again.');
  }
  function row(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Each imported login must be an object.');
    if (Object.keys(data).some(key => !Object.hasOwn(limits, key) && key !== 'favorite')) fail('Imported logins contain an unsupported field.');
    for (const [key, limit] of Object.entries(limits)) {
      if (data[key] !== undefined && data[key] !== null && (typeof data[key] !== 'string' || data[key].length > limit)) fail(`Imported ${key} must be text up to ${limit} characters.`);
    }
    if (typeof data.websiteName !== 'string' || !data.websiteName.trim() || typeof data.password !== 'string' || !data.password) fail('Every imported login needs a Website Name and Password.');
    if (data.favorite !== undefined && typeof data.favorite !== 'boolean') fail('Imported favorite must be true or false.');
  }
  function rows(values) {
    if (!Array.isArray(values) || !values.length || values.length > MAX_ROWS) fail('Import between 1 and 5,000 logins at a time.');
    let size = 0;
    for (const value of values) {
      row(value);
      // Count all supplied properties too, even those not used by the database.
      size += new TextEncoder().encode(JSON.stringify(value)).length;
      if (size > MAX_BYTES) fail('Imported data must be 16 MB or smaller. Split the file and try again.');
    }
  }
  return { MAX_BYTES, MAX_ROWS, MAX_COLUMNS, MAX_CELL, text, row, rows };
})();
if (typeof module !== 'undefined') module.exports = ImportPolicy;
