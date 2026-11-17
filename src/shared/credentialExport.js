// Pure formatters shared by main-process export and synthetic format tests.
const CredentialExport = (() => {
// Includes every field (via ...rest), so the qrCode data URI rides along
// automatically — JSON has no practical size limit for it.
function buildJsonExport(credentials) {
  const payload = {
    format: "secure-login-vault-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    credentials: credentials.map(({ id, ...rest }) => rest)
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// CSV deliberately excludes qrCode (unlike JSON above): a QR data URI can
// run past Excel/Sheets' per-cell character limit, and would make an
// already-plain-text CSV export even riskier to casually open. Use JSON
// (or the encrypted backup) to carry 2FA QR codes between vaults.

function buildCsvExport(credentials) {
  const headers = [
    "Website Name", "Login URL", "Category", "Username",
    "Email", "Password", "Tags", "Group", "Notes", "Favorite"
  ];
  const lines = [headers.map(csvEscape).join(",")];

  for (const c of credentials) {
    lines.push(
      [
        c.websiteName, c.websiteUrl, c.category, c.username,
        c.email, c.password, c.tags, c.groupName, c.notes, c.favorite ? "true" : "false"
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  return `${lines.join("\r\n")}\r\n`;
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

return { buildJsonExport, buildCsvExport };
})();
if (typeof module !== "undefined") module.exports = CredentialExport;
