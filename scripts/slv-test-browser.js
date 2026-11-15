// Launches only a dedicated test browser profile. Never discovers existing profiles.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { openEnvironment, assertPrivateTree } = require('./slv-test-environment');
function browserArguments(environment, port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Start SLV Test first.');
  return [`--user-data-dir=${environment.paths.browser}`, '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--disable-session-crashed-bubble',
    `--disable-extensions-except=${environment.paths.extension}`, `--load-extension=${environment.paths.extension}`,
    '--new-window', `http://127.0.0.1:${port}/`];
}
async function verifyRuntime(environment, port) {
  browserArguments(environment, port);
  await new Promise((resolve, reject) => {
    const request = require('http').request({ host: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: 2000 }, response => {
      const matches = response.statusCode === 200 && response.headers['x-slv-test-id'] === environment.pipeUser;
      response.destroy(); matches ? resolve() : reject(Error('SLV Test is not running.'));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(Error('SLV Test is not running.'))); request.end();
  });
}
async function launch() {
  const environment = openEnvironment(); assertPrivateTree(environment.root);
  const runtime = JSON.parse(fs.readFileSync(path.join(environment.root, 'runtime.json'), 'utf8'));
  const args = browserArguments(environment, runtime.port);
  await verifyRuntime(environment, runtime.port);
  // Only executable locations, never Chrome/Brave/Edge user-data directories.
  const programs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const relative = ['BraveSoftware/Brave-Browser/Application/brave.exe', 'Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'];
  const executable = relative.flatMap(file => programs.map(dir => path.join(dir, file))).find(file => fs.existsSync(file));
  if (!executable) throw Error('A system-installed Brave, Chrome or Edge browser is required.');
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; }); child.unref();
}
module.exports = { browserArguments, verifyRuntime };
if (require.main === module) {
  launch().catch(error => { console.error(error.message); process.exitCode = 1; });
}
