# Electron runtime hardening (1.0.53)

Status: local unpacked app built and verified; no 1.0.53 Setup installer created,
installed or published. Installed 1.0.52 is unchanged. All tests use generated
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
uses `file://` pages. The main page's inline-style CSP allowance is also unchanged;
that needs a separate styling compatibility pass.

## Browser helper compatibility and limits

The browser helper uses `ELECTRON_RUN_AS_NODE=1`. The synthetic probe found that
Node mode can still accept `--inspect` despite the desktop inspector fuse. Do not
claim that the fuses remove every Node execution/debugging path.

The helper launcher now clears `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS` before
starting the fixed helper script. Browser arguments follow the script path, so
they are script arguments rather than Node runtime options. A test with an
injected preload and inspector argument confirms that the generated launcher
does not run the preload or open an inspector.

After a future 1.0.53 installation, run **Settings > Browsers > Set Up Browser
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
registry writes. The installer gate itself will run when Setup is next built.

References: [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses),
[ASAR integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity),
[electron-builder v26 fuses](https://www.electron.build/v26/docs/tutorials/adding-electron-fuses/).
