/* Shared by the renderer and import tests; contains no vault or DOM access. */
const CsvImport = (() => {
  const fields = [
    ['websiteName', 'Website Name', ['website name', 'website_name', 'website', 'name']],
    ['websiteUrl', 'Login URL', ['login url', 'login_url', 'website url', 'website_url', 'url']],
    ['username', 'Username', ['username']], ['password', 'Password', ['password']],
    ['groupName', 'Group', ['group']], ['category', 'Category', ['category']],
    ['email', 'Email', ['email']], ['tags', 'Tags', ['tags']],
    ['notes', 'Notes', ['notes']], ['favorite', 'Favorite', ['favorite']]
  ];

  function parseRows(content) {
    const rows = []; let row = [], field = '', quoted = false, closed = false;
    const text = content.replace(/^\uFEFF/, '');
    const endField = () => { row.push(field); field = ''; closed = false; };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; closed = true; }
        } else field += ch;
      } else if (ch === ',') endField();
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        endField(); rows.push(row); row = [];
      } else if (ch === '"' && !field && !closed) quoted = true;
      else {
        if (closed || ch === '"') throw Error('Invalid CSV quoting. Save the sheet as CSV and try again.');
        field += ch;
      }
    }
    if (quoted) throw Error('The CSV contains an unclosed quoted field.');
    if (field || row.length || closed) { endField(); rows.push(row); }
    return rows;
  }

  function mapRecord(record) {
    const result = {};
    for (const [key, , aliases] of fields) result[key] = aliases.map(alias => record[alias]).find(value => value !== undefined && value !== '') || '';
    result.category ||= 'Other';
    result.favorite = ['1', 'true', 'yes'].includes(result.favorite.toLowerCase());
    return result;
  }

  function read(content) {
    const rows = parseRows(content);
    if (!rows.length) throw Error('The CSV is empty.');
    const headers = rows[0].map(value => value.trim().toLowerCase());
    const mapping = fields.map(([key, label, aliases]) => {
      const indices = headers.flatMap((header, index) => aliases.includes(header) ? [index] : []);
      if (indices.length > 1) throw Error(`More than one column maps to ${label}. Keep one column for that field.`);
      return { key, label, index: indices[0] ?? -1 };
    });
    for (const key of ['websiteName', 'password']) {
      if (mapping.find(field => field.key === key).index < 0) throw Error(`Missing ${key === 'password' ? 'Password' : 'Website / Website Name'} column.`);
    }
    const entries = rows.slice(1).flatMap((cells, index) => {
      if (cells.every(cell => !cell.trim())) return [];
      const record = Object.create(null);
      headers.forEach((header, column) => { record[header] = header === 'password' ? (cells[column] || '') : (cells[column] || '').trim(); });
      return [{ row: index + 2, data: mapRecord(record), categoryMissing: !record.category,
        issue: cells.length !== headers.length ? 'Column count does not match the header' : '' }];
    });
    return { mapping: mapping.filter(field => field.index >= 0).map(field => ({ ...field, source: rows[0][field.index].trim() })), entries };
  }

  function identity(data) {
    let site = data.websiteUrl.trim();
    if (site) {
      try { const url = new URL(site); url.hash = ''; site = url.href.replace(/\/$/, ''); } catch { /* Invalid rows are reported separately. */ }
    } else site = data.websiteName.trim().toLowerCase();
    return JSON.stringify([data.groupName.trim().toLowerCase(), site, data.username.trim()]);
  }

  function review(entries, existing, defaults = {}, skipDuplicates = true) {
    const seen = new Set(existing.map(identity));
    return entries.map(entry => {
      const data = { ...entry.data, groupName: entry.data.groupName || defaults.groupName || '',
        category: entry.categoryMissing ? (defaults.category || 'Other') : entry.data.category };
      let issue = entry.issue;
      if (!data.websiteName) issue ||= 'Website Name is required';
      if (!data.password) issue ||= 'Password is required';
      if (data.websiteUrl) {
        try { const url = new URL(data.websiteUrl); if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error(); }
        catch { issue ||= 'Login URL must be an HTTP or HTTPS address without embedded credentials'; }
      }
      const key = identity(data), duplicate = !issue && seen.has(key);
      if (!issue) seen.add(key);
      return { ...entry, data, issue, duplicate, include: !issue && !(duplicate && skipDuplicates) };
    });
  }
  return { parseRows, mapRecord, read, review };
})();
if (typeof module !== 'undefined') module.exports = CsvImport;
