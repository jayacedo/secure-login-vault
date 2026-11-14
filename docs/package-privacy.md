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

## Verified 1.0.50 installer

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
