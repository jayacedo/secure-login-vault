// Entry point the browser launches for native messaging. See hostRelay.js.
const { runHost } = require("./hostRelay");
const { getPipeName } = require("./pipeName");
const { ALLOWED_EXTENSION_IDS } = require("./config");

runHost({
  stdin: process.stdin,
  stdout: process.stdout,
  argv: process.argv.slice(2),
  // SLV_PIPE_USER only changes the user part of the pipe name (the app reads the same
  // variable) so tests can use their own pipe. A browser never sets it.
  pipeName: getPipeName(process.env.SLV_PIPE_USER || undefined),
  allowedExtensionIds: ALLOWED_EXTENSION_IDS,
  exit(code) {
    // Let pending writes flush; a short fallback timer guarantees we do exit.
    process.exitCode = code;
    process.stdin.destroy();
    setTimeout(() => process.exit(code), 1000).unref();
  }
});
