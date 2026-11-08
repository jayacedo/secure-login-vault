// Runs a script inside Electron and passes its exit code through:
//   node scripts/run-electron-test.js scripts/login-window-test.js
// ELECTRON_RUN_AS_NODE (set by some editors and terminals) would make Electron
// behave like plain Node and break tests that need the real runtime, so it is
// removed for the child process.
const { spawnSync } = require("child_process");
const path = require("path");
const electronPath = require("electron");

const script = process.argv[2];
if (!script) {
  console.error("Usage: node scripts/run-electron-test.js <script>");
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronPath, [path.resolve(script)], { stdio: "inherit", env });
process.exit(result.status === null ? 1 : result.status);
