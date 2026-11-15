# Package privacy checks

Packaging must not include an existing user's vault, browser profile, private QR
images, exports, backup codes or backups. Tests use synthetic fixtures only.

## Build gates

- `scripts/package-content-allowlist.json` contains explicitly reviewed file paths
  for application source/assets, Chromium/Firefox extensions, native helper,
  production dependency files and the Windows Electron runtime. It is not generated
  during ordinary builds. New files or dependency/runtime updates require review.
- The Firefox builder checks its source tree before reading/copying its files.
- Electron-builder's `beforePack` checks the actual source/resource trees. Unknown
  files, user-data paths and links stop the build before those trees are copied.
  Only the named packaging roots are inspected; the user's database, backups,
  installed app data and browser profiles are not opened.
- `afterPack` checks the output tree and every entry inside `app.asar`, including
  dependency paths. Extra resources, unknown files, ASAR links and unpacked ASAR
  trees fail closed before distributable creation.
- `artifactBuildCompleted` checks the final NSIS Setup EXE by extracting its fixed
  app payload and validating its contents. Neither the installer nor SLV is run.
  The portable target shares the before/afterPack gates; the additional final EXE
  extraction check is currently specific to NSIS Setup.
- Since source 1.0.53, the final Setup gate also verifies the extracted executable's
  [Electron fuse settings](electron-fuses.md). Older installers do not meet this
  new fuse policy; their previously recorded privacy results remain historical.

The gates apply to direct electron-builder calls as well as `npm run dist` through
the hooks in `package.json`. Do not disable these hooks to get a release through.
If a check fails, review the file and its purpose before changing the allowlist.
Do not automatically accept everything in a failing build.

## Verification commands

```powershell
npm.cmd run test:package-privacy
npm.cmd run verify:installer-privacy
```

The second command checks the current version's local Setup installer. To check a
different workspace-local Setup EXE:

```powershell
node scripts/package-privacy.js "path\inside\workspace\Setup.exe"
```

It reports file counts and the installer SHA-256. Archive extraction is confined
to a generated child of `.tmp`, with path/link checks and cleanup. The uploaded
asset must have the same SHA-256 as the checked installer. A check of one binary
does not certify a different binary with the same filename or version.

## Scope and limits

These are file-inclusion checks, not a complete security audit or a guarantee that
approved code/artwork can never contain an embedded secret. Review changes to
approved files as well as allowlist additions. Do not put secrets in source code.
The checks do not inspect the real vault to compare account values. They do not
scan Git history, validate licensing or prove the application is free of bugs.

## Local 1.0.54 installer

Built on 2026-11-15 with `npm run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, backup,
account data or personal browser profile was accessed, read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.54.exe` (116,714,025 bytes).
- SHA-256: `5923826f1d3a26740f45a9a855116117db282d3ba7b3b251f7e0eea4db9cd990`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 124 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Synthetic renderer checks passed for all six themes, Breeze/Forest text and
  status contrast, saved selection, custom accent preview/save/reset, and the
  minimum window size with large text. Strict style CSP checks also passed.
- Portable: `release/Secure Login Vault 1.0.54.exe` (116,479,450 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This update adds Breeze and Forest themes. The extension remains 0.6.4 and does
not need an update. The prior 1.0.53 local packages were left intact.

## Local 1.0.53 installer

Built on 2026-11-15 with `npm run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, backup,
account data or personal browser profile was accessed, read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.53.exe` (116,713,816 bytes).
- SHA-256: `ce8d5a4ffc8849a28816ff6dedde0eb1a6e102cac20402545787146dc055b241`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 124 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Actual Setup payload passed Chromium and Firefox pairing, authentication,
  save, fill, update, lock and encrypted persistence checks using generated
  synthetic vaults, isolated pipes and simulated registry writes.
- Portable: `release/Secure Login Vault 1.0.53.exe` (116,479,220 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This combines runtime fuses, helper launcher environment cleanup and the stricter
desktop style policy. The extension remains 0.6.4. After installation, use
**Settings > Browsers > Set Up Browser Extension** to update the native launcher.
Existing pairings are retained. Older local installer files were left intact.

## Local 1.0.52 installer

Built on 2026-11-15 with `npm run dist -- --publish never` for local testing.
No installer was installed or published. Existing installed vaults, backups and
personal browser profiles were not accessed, read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.52.exe` (116,713,375 bytes).
- SHA-256: `f0e2ebcdfcccdf10c8e753a10510622a3103676c2d9aae7671a84e198aceaebb`.
- Source/resource allowlist, unpacked app inventory and final Setup extraction
  gates passed: 129 outer payload files and 124 files inside `app.asar`.
- Packaged Chromium and Firefox helper checks passed for pairing, authentication,
  save, fill, password update, lock and encrypted persistence. Tests extracted
  Setup into fresh `.tmp` directories, generated dummy vaults, used isolated pipes
  and simulated registry writes. They did not run the installer wizard.
- Portable: `release/Secure Login Vault 1.0.52.exe` (116,478,800 bytes).
  It shares the approved packaged app; the final EXE extraction gate applies to
  Setup only, as described above.

The extension remains 0.6.4. See [password-key compatibility](password-key-upgrade.md):
after a vault upgrades to auth format v2, 1.0.51 and earlier cannot open it.

## Verified 1.0.50 installer

For the previous local-only 1.0.51 build, see the
[Electron 45 upgrade record](electron-45-upgrade.md#local-installer).

The local installer matching the previously published download passed the inventory
check on 2026-11-15: 131 outer payload files and 122 files inside `app.asar`.
Its SHA-256 is
`31c1e6a89301470742a4fe374a9a5c79049237572adfba4eaf4ec425111cea38`.
No vault files, backups, private QR files or browser profiles were found. Its app,
helper, extension and artwork files were also compared with the source assets.
The release was subsequently deleted by the owner, and GitHub's unauthenticated
release API returned 404. This work does not republish or replace that release.

The new gates were also exercised through electron-builder with an isolated
unpacked build and an NSIS Setup build under `.tmp`, with publishing disabled.
All three hooks passed, including extraction of the final throwaway installer.
Synthetic regression checks deliberately inserted fake vaults, exports, private
images, unknown JavaScript/resources, archive links and a filesystem junction;
the checks rejected them. The Firefox package check and reviewer-source rebuild
also passed. The temporary build/extraction files were removed after verification.
