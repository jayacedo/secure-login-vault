const fs = require("fs");
const path = require("path");
const source = path.join(__dirname, "../src/shared/secureChannel.js");
const target = path.join(__dirname, "../extension/secureChannel.js");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(target) || !fs.readFileSync(source).equals(fs.readFileSync(target))) throw new Error("Run node scripts/sync-secure-channel.js");
} else fs.copyFileSync(source, target);
