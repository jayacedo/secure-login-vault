# SLV Test on the same Windows account

This is a development launcher for synthetic testing, separate from the installed
SLV app. It runs the project's code with its own persistent `.slv-test` directory.
No reinstall or Windows user switching is needed.

From the project folder, `npm.cmd run start:test` starts the test app and
`npm.cmd run start:test-browser` opens its browser. The local shortcuts run those
same launchers; shortcuts themselves are not checked into Git.

## Start

1. Open **SLV Test.lnk** in the project folder. Look for the yellow **SLV TEST**
   banner and window title. On first launch, create a test-only master password.
2. Add dummy entries only. This test vault persists between test launches.
3. For browser tests, use **SLV Test Browser.lnk**, with SLV Test already open.
   It opens a separate Chromium profile and a local dummy login form. Never sign
   into a personal browser account or import/sync browser data in that profile.
4. In SLV Test, use Settings > Browsers > Set Up Browser Extension. This registers
   a test-only helper name, not the regular installed helper.
5. If the browser does not load the test extension automatically, open its
   Extensions page, enable Developer mode and Load unpacked from
   `.slv-test/extension`. Its name is **SLV TEST — Dummy logins only**.
6. Pair that test extension with SLV Test, then use the local dummy form for
   Save, Fill, Update and lock/restart checks. Do not pair your regular extension.

The browser launcher selects a system-installed Brave, Chrome or Edge, in that
order, and always supplies an explicit test profile. This launcher currently does
not set up Firefox; the separate Windows test account remains available for that.

## Boundaries

- Test user data, renderer storage, logs, caches and pairing storage have separate
  paths; the test pipe, extension ID and native helper name are different too.
- The launcher requires its own environment marker and rejects linked paths and
  hard-linked files. Failure stops launch; there is no production-profile fallback.
- The test app refuses a vault path outside its configured test profile.
- File imports/restores and native file pickers are disabled. File-input selection
  and drag/drop are blocked. Use generated test fixtures, never real backups or QR
  codes. External-site launching and Windows startup changes are disabled.
- Copy buttons use an in-memory test clipboard. They do not read or overwrite
  the real Windows clipboard, so normal cross-application paste is not exercised.
- Browser profile data and test artifacts are git-ignored and excluded from the
  installer. Preparing the browser bundle copies approved extension source only.
- These are application-level separation measures, not a VM or a security
  boundary against malware or another process running as the same Windows user.

The shortcuts point to the project and its Electron runtime. Keep that folder in
place. Close the test app/browser before updating the development runtime.

## Validation

`npm run test:test-environment` checks identities, separate fake registration,
helper communication, rejection of the normal extension, explicit browser profile,
and refusal of unmarked/linked test roots.

`npm run test:test-environment-app` launches a newly generated synthetic environment,
checks the TEST banner and empty vault, adds a dummy entry, locks/unlocks, checks
blocked imports/startup and verifies no reads/writes to a separate synthetic prior
profile. It does not access the real installed vault or any real browser profile.
