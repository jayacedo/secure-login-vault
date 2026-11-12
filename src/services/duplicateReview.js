const { resolveLoginUrl } = require("./siteLogin");

function collectDuplicateGroups(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const site = resolveLoginUrl(row.website_url);
    const username = (row.username || "").trim() || (row.email || "").trim();
    if (!username || !(site.ok || site.reason === "insecure") || !site.origin) continue;
    const key = JSON.stringify([site.origin, username]);
    if (!buckets.has(key)) buckets.set(key, { origin: site.origin, username, rows: [] });
    buckets.get(key).rows.push(row);
  }
  return [...buckets.values()].filter(group => group.rows.length > 1)
    .map(group => ({ ...group, rows: group.rows.sort((a, b) => a.id - b.id) }))
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
}

function describeDuplicateGroup(group, revision) {
  return { origin: group.origin, username: group.username, revision,
    passwordsDiffer: new Set(group.rows.map(row => row.password)).size > 1,
    multipleGroups: new Set(group.rows.map(row => (row.group_name || "").toLowerCase())).size > 1,
    entries: group.rows.map(row => ({ id: row.id, websiteName: row.website_name,
      websiteUrl: row.website_url || "", username: row.username || "", email: row.email || "",
      groupName: row.group_name || "", category: row.category || "Other", favorite: row.favorite === 1,
      hasNotes: Boolean(row.notes), hasQrCode: Boolean(row.qr_code), tags: row.tags || "",
      createdAt: row.created_at, updatedAt: row.updated_at })) };
}
module.exports = { collectDuplicateGroups, describeDuplicateGroup };
