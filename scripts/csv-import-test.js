const assert = require('assert/strict');
const csv = require('../src/renderer/csvImport');
const header = 'Website,Login URL,Username,Password,Group,Category\r\n';
const sample = csv.read('\uFEFF' + header + 'Example,https://example.com/login,demo,"  a,b""c\nsecret  ",Team A,WordPress\r\n');
assert.equal(sample.entries[0].data.websiteUrl, 'https://example.com/login');
assert.equal(sample.entries[0].data.password, '  a,b"c\nsecret  ');
assert.equal(sample.entries[0].data.groupName, 'Team A');
assert.equal(sample.entries[0].data.category, 'WordPress');
assert.equal(sample.mapping.find(f => f.key === 'websiteUrl').label, 'Login URL');
for (const alias of ['Website URL', 'website_url', 'URL', 'Login URL', 'login_url']) {
 assert.equal(csv.read(`Website Name,${alias},Password\nExample,https://example.com,pass`).entries[0].data.websiteUrl, 'https://example.com');
}
assert.throws(() => csv.read('Website,Password,Login URL,Website URL\nA,p,https://a.test,https://b.test'), /More than one/);
assert.throws(() => csv.read('Website,Username\nA,demo'), /Missing Password/);
assert.throws(() => csv.read('Website,Password\nA,"broken'), /unclosed/);
assert.throws(() => csv.read('Website,Password\nA,"a"tail'), /Invalid CSV/);
const rows = csv.read(header + [
 'Example,https://example.com/login,demo,new-password,Team A,WordPress',
 'Example,https://example.com/login,demo,other-password,Team B,WordPress',
 'Blank defaults,https://other.test,user,password,,',
 'Blank defaults,https://other.test,user,password,,',
 ',https://missing.test,demo,password,,',
 'No password,https://missing.test,demo,,,',
 'Bad link,javascript:alert(1),demo,password,,',
 'Bad shape,https://shape.test,demo,password,,,extra'
].join('\n')).entries;
const result = csv.review(rows, [sample.entries[0].data], { groupName: 'Default group', category: 'Hosting' });
assert.deepEqual(result.map(row => row.include), [false, true, true, false, false, false, false, false]);
assert.equal(result[0].duplicate, true, 'changed passwords are flagged, not overwritten');
assert.equal(result[1].duplicate, false, 'groups remain independent');
assert.equal(result[2].data.category, 'Hosting');
assert.equal(result[2].data.groupName, 'Default group');
assert.equal(result[1].data.category, 'WordPress', 'explicit values survive defaults');
assert.equal(csv.review(rows, [sample.entries[0].data], {}, false).filter(row => row.include).length, 4);
assert.equal(csv.read(header).entries.length, 0);
assert.equal(csv.read('Website,Password\rA,p\r').entries.length, 1);
assert.equal(csv.read(header + 'A,https://example.com,u,  spaces  ,,').entries[0].data.password, '  spaces  ');
console.log('PASS CSV aliases, organization, exact password preservation, quoted fields/BOM, invalid rows, and duplicate choices.');
