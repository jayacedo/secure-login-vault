// Deliberately small, explainable offline checks. No network, persistence,
// logging, password fingerprints or password values in the returned report.
function weakReasons(password) {
  if (!password) return ["No password saved"];
  const reasons = [];
  if (Array.from(password).length < 12) reasons.push("Fewer than 12 characters");
  const normalized = password.toLowerCase().replace(/[@]/g, "a").replace(/[$]/g, "s");
  if (/^[^a-z]*(password|passw[o0]rd|qwerty|letmein|welcome|admin|changeme|iloveyou)[^a-z]*$/.test(normalized)) {
    reasons.push("Common word or keyboard pattern");
  }
  if (/^(.{1,4})\1+$/u.test(password)) reasons.push("Repeating characters or short pattern");
  if (/^(?:0123456789|1234567890|abcdefghijklmnopqrstuvwxyz|qwertyuiop)+$/i.test(password)) {
    reasons.push("Predictable sequence");
  }
  return reasons;
}

function buildVaultHealth(credentials, activeGroup = "") {
  const counts = new Map();
  try {
    for (const item of credentials) {
      if (item.password) counts.set(item.password, (counts.get(item.password) || 0) + 1);
    }
    let weak = 0;
    let reused = 0;
    const entries = [];
    for (const item of credentials) {
      const reasons = weakReasons(item.password || "");
      const reuseCount = item.password ? counts.get(item.password) : 0;
      const isWeak = reasons.length > 0;
      const isReused = reuseCount > 1;
      if (isWeak) weak++;
      if (isReused) reused++;
      if (isWeak || isReused) entries.push({
        id: item.id, websiteName: item.website_name || "Untitled entry",
        username: item.username || "", groupName: item.group_name || "",
        weak: isWeak, reused: isReused, reasons,
        reusedWith: isReused ? reuseCount - 1 : 0
      });
    }
    entries.sort((a, b) => Number(b.reused) - Number(a.reused) || Number(b.weak) - Number(a.weak) || a.websiteName.localeCompare(b.websiteName));
    return { checkedAt: new Date().toISOString(), activeGroup, total: credentials.length,
      weak, reused, affected: entries.length, entries };
  } finally { counts.clear(); }
}
module.exports = { buildVaultHealth, weakReasons };
