# Electron runtime hardening (1.0.53)

Status: 1.0.53 Setup built and verified for local testing only; not installed or
published. See the [package verification record](package-privacy.md#local-1053-installer). All tests use generated
fixtures under project `.tmp`; no real vault, backup or browser profile is read.

## Packaged settings

| Fuse | Setting | Purpose |
| --- | --- | --- |
| RunAsNode | Enabled | Required by the current browser native helper |
| EnableNodeOptionsEnvironmentVariable | Disabled | Blocks inherited Node options in desktop mode |
| EnableNodeCliInspectArguments | Disabled | Blocks Node inspector CLI flags in desktop mode |
| EnableEmbeddedAsarIntegrityValidation | Enabled | Rejects modified application archive contents |
| OnlyLoadAppFromAsar | Enabled | Excludes unpacked application-directory fallback |

Electron-builder applies the configuration before signing. The binary is checked
with `@electron/fuses`, using expectations independent of the build configuration.
Final Setup verification now also reads and checks the executable's fuse bits
after extracting its approved payload. Historical installers without these fuses
do not satisfy the new fuse check, even if their privacy inventory passed earlier.

Cookie encryption and file-protocol privileges are unchanged. The desktop still
uses `file://` pages. The style policy below is included in the same local 1.0.53
release.

## Desktop style policy

The main renderer now uses `style-src 'self'; style-src-attr 'none'` without
`unsafe-inline`. Static spacing/width/wrapping rules are in `styles.css`, and
messages, the active-group banner and help filtering use the `hidden` property.
The stylesheet explicitly preserves hidden state even for flex/grid elements.

Trusted renderer code still sets individual style properties for validated accent
colors and numeric password-strength widths. CSP permits those CSSOM operations;
it blocks injected style attributes and inline style elements. This does not
protect against arbitrary JavaScript that already executes in the renderer.
The existing script policy, sandbox, context isolation and IPC guards remain in
place. Website pages opened through the browser helper are unaffected.

`node scripts/run-electron-test.js scripts/style-csp-app-test.js` passed in a fresh
synthetic profile: all six Settings tabs, light/dark/coffee/system themes, live
accent preview and cancellation, text sizing, hidden banner/status messages,
credential validation and strength display, help filtering, category/group status,
and restore/backup-check dialog layout. Normal workflows emitted no CSP violations;
deliberately injected style attributes and style elements were blocked. Settled
screenshots of Settings and Add Credential were also checked. No real vault or
backup was used; the test generated its own dummy credential and encrypted backup.

Reference: [MDN style-src-attr](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr).

## Browser helper compatibility and limits

The browser helper uses `ELECTRON_RUN_AS_NODE=1`. The synthetic probe found that
Node mode can still accept `--inspect` despite the desktop inspector fuse. Do not
claim that the fuses remove every Node execution/debugging path.

The helper launcher now clears `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS` before
starting the fixed helper script. Browser arguments follow the script path, so
they are script arguments rather than Node runtime options. A test with an
injected preload and inspector argument confirms that the generated launcher
does not run the preload or open an inspector.

After installing 1.0.53, run **Settings > Browsers > Set Up Browser
Extension** once to replace the old launcher. The existing status check detects
its old contents and reports that setup is needed. This does not erase pairings;
the browser extension remains 0.6.4. No real registration was changed during tests.

RunAsNode remains available to someone who invokes the executable directly.
Disabling it requires redesigning the native helper. ASAR integrity covers the
application archive in desktop mode, not every external helper/extension resource.
An unsigned executable is not a defense against an attacker who can replace it.
These changes are defense in depth, not a complete security audit or malware defense.

## Verification

```powershell
node scripts/electron-fuses-test.js
npm.cmd run dist -- --dir --publish never
node scripts/check-electron-fuses.js
node scripts/packaged-browser-test.js --unpacked
node scripts/packaged-browser-test.js --unpacked --firefox
node scripts/extension-register-test.js
node scripts/browser-setup-test.js
node scripts/package-privacy-test.js
```

The generated minimal Electron probe verifies normal startup, ignored desktop
Node options/inspector flags, helper launcher compatibility, rejection of an ASAR
whose code was modified, and exclusion of an unpacked `resources/app` override.
It also proves that the fuse reader rejects a deliberately weakened executable.
The actual SLV build passed Chromium/Firefox pairing, save, fill, update, lock and
encrypted persistence checks with synthetic vaults, isolated pipes and simulated
registry writes. The final Setup inventory and fuse gates passed, and both helper
checks passed again using the payload extracted from the actual 1.0.53 installer.

References: [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses),
[ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity),
[electron-builder v26 fuses](https://www.electron.build/v26/docs/tutorials/adding-electron-fuses/).
