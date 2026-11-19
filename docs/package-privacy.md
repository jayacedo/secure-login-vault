# Package privacy checks

Packaging must not include an existing user's vault, browser profile, private QR
images, exports, backup codes or backups. Tests use synthetic fixtures only.

## Build gates

- Since source 1.0.75, the only allowed file under `browser-addons/` is the reviewed Firefox XPI. Before packaging, its SHA-256, archive inventory, parsed manifest and payload files must match the pinned artifact and generated Firefox source. Packaged-app and final Setup checks also verify the XPI hash. Firefox performs cryptographic signature validation when the user installs the add-on; the build does not claim to validate Mozilla's certificate chain.

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

## Local 1.0.76 installer

Built on 2026-11-19 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.76.exe` (116,972,350 bytes).
- SHA-256: `a4b280c37c91b048c537b5c6072725fcbb1dee1b7fd40e10e4fa7a9e0f01ab3e`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 130 outer payload files and 370 files inside `app.asar`.
- The bundled Firefox 0.6.6 XPI passed source comparison and pinned-hash checks,
  including the copy extracted from the installer.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Syntax, synthetic package privacy and isolated onboarding checks passed before
  packaging. Onboarding coverage includes recovery-screen ordering, steps, focus,
  skip/finish/restart, preference persistence, existing-user opt-in, lock races,
  Ctrl+L, strict style CSP, themes and window resizing.
- Portable: `release/Secure Login Vault 1.0.76.exe` (116,737,723 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup. Use Setup for browser helper installation.

This installer adds the optional getting-started guide. Existing installations can
start it from Settings > General or Help > Restart guide. Superseded 1.0.75 package
files were removed after verification. Installer extraction files were cleaned
automatically.

## Local 1.0.75 installer

Built on 2026-11-19 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.75.exe` (116,969,016 bytes).
- SHA-256: `58467f48499b90f3602d61bd6f0992ca29b3de07556676a60acc9566e4b66b13`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 130 outer payload files and 368 files inside `app.asar`.
- The included Firefox 0.6.6 XPI matches the reviewed hash and generated extension
  source. The extracted installer copy passed the pinned-hash check too.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Syntax and synthetic package privacy tests passed before packaging, including
  rejection of a modified XPI, stale extension code, mismatched manifest version
  and an unexpected add-on file.
- Portable: `release/Secure Login Vault 1.0.75.exe` (116,734,386 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup. Use Setup for browser helper installation.

This installer includes the signed Firefox XPI and clearer browser setup instructions
in Settings, Help and the shareable guide. Firefox installation remains a manual
Install Add-on From File step. Superseded 1.0.73 package files were removed after
verification. Installer extraction files were cleaned automatically.

## Local 1.0.73 installer

Built on 2026-11-19 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.73.exe` (116,894,328 bytes).
- SHA-256: `49ab1c18df15d3e1a2af5875cf2e4a9def1785c14b11db2ceb21a5e47d679237`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 368 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Before packaging, syntax and isolated synthetic Login/Client form checks passed:
  collapsed-field save/edit preservation, populated-section expansion, pending 2FA
  visibility, cancel/lock cleanup, and footer fit across themes and window sizes.
- Portable: `release/Secure Login Vault 1.0.73.exe` (116,659,734 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer adds the streamlined Add/Edit Client layout with expandable optional
sections. Extension 0.6.6 is unchanged; no extension update is required.
Superseded 1.0.72 package files were removed after verification. Installer
extraction files were cleaned automatically.

## Local 1.0.72 installer

Built on 2026-11-19 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.72.exe` (116,893,860 bytes).
- SHA-256: `96451bedf6e1c46c4f42c2cb3933239ac42dd598c5244923f6ed0cd2d5c159ab`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 368 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Before packaging, syntax, synthetic CSV import and isolated Add/Edit form checks
  passed. The form checks covered save/edit, optional sections, generator behavior,
  pending 2FA, cancel/lock cleanup and themed window sizes.
- Portable: `release/Secure Login Vault 1.0.72.exe` (116,659,222 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer uses Login consistently throughout desktop labels and related Help.
Internal APIs and export formats are unchanged. Extension 0.6.6 is unchanged;
no extension update is required. Superseded 1.0.71 package files were removed
after verification. Installer extraction files were cleaned automatically.

## Local 1.0.71 installer

Built on 2026-11-19 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.71.exe` (116,893,818 bytes).
- SHA-256: `64c29794c4e0aca5d858094b818116ab3400952478a94a66a2c90c6f96c406d4`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 368 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Before packaging, synthetic credential layout, manual authenticator, backup
  names, automatic encrypted backup/restore and backup Settings checks passed,
  along with syntax checks. See [validation](credential-layout-backup-names.md#validation).
- Portable: `release/Secure Login Vault 1.0.71.exe` (116,659,263 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer includes the cleaner credential form and readable local timestamps
for new automatic backup filenames. Existing backup names remain supported and
are not renamed. Extension 0.6.6 is unchanged; no extension update is required.
Superseded 1.0.70 package files were removed after verification. Installer
extraction files were cleaned automatically.

## Local 1.0.70 installer

Built on 2026-11-19 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.70.exe` (116,893,296 bytes).
- SHA-256: `5f04c476f0451168b0be30a4d859cf6ed0194d23e2cf7565fa4a0e699d726972`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 368 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Before packaging, synthetic unlock transition, unlock layout and trusted-renderer
  hardening tests passed, along with syntax checks. See [unlock transition validation](unlock-transition.md#validation).
- Portable: `release/Secure Login Vault 1.0.70.exe` (116,658,720 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer prepares the populated dashboard before expanding the unlock
window. Extension 0.6.6 is unchanged; no extension update is required.
Superseded 1.0.69 package files were removed after verification. Installer
extraction files were cleaned automatically.

## Local 1.0.69 installer

Built on 2026-11-18 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.69.exe` (116,892,348 bytes).
- SHA-256: `114dd2a42f02335020c776f058eff9d12070ddf19369b3cd906f348d5b31dd29`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 368 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Before packaging, synthetic QR compatibility, authenticator, manual setup and
  isolated UI/IPC checks passed. The freshly packaged runtime passed generated
  QR decoding, faint-image retries, withheld codes/copy before standard-TOTP
  confirmation, and RFC code generation after confirmation. See
  [QR compatibility checks](qr-compatibility.md#validation).
- Portable: `release/Secure Login Vault 1.0.69.exe` (116,657,758 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer adds an explicit compatibility choice for decoded QRs with extra
settings. Known unsupported formats, invalid parameters and conflicting settings
remain rejected. Extension 0.6.6 is unchanged; no extension update is required.

Superseded 1.0.68 package files were removed after verification. Installer
extraction files were cleaned automatically, and the newly generated synthetic
runtime directory was removed.

## Local 1.0.68 installer

Built on 2026-11-18 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.68.exe` (116,891,771 bytes).
- SHA-256: `76d79ed0fa6932e0656447ec5a09aca73490ad4358e23ecb5a75a0e00a58e62f`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 368 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Before packaging, synthetic QR compatibility, authenticator-vector and manual
  setup/storage/backup tests passed. The packaged runtime generated a synthetic
  QR and its worker decoded a faint version using shipped dependencies.
  See [QR compatibility checks](qr-compatibility.md#validation).
- Portable: `release/Secure Login Vault 1.0.68.exe` (116,657,146 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer improves QR scanning and compatible TOTP settings while retaining
conflict rejection and bounded worker execution. Extension 0.6.6 is unchanged;
no extension update is needed for this desktop QR change.

Superseded 1.0.67 package files were removed after verification. Installer
extraction files were cleaned automatically, and the newly generated synthetic
runtime directory was removed.

## Local 1.0.67 installer

Built on 2026-11-18 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.67.exe` (116,890,522 bytes).
- SHA-256: `6b9144e6812985e0afd804b40d1522fd8a607e6343fa7041a08f92919e3111e4`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 367 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Before packaging, synthetic manual-key, authenticator-vector and isolated UI/IPC
  tests passed, including encryption/backup restore, validation, replacement
  confirmation, cancellation and lock handling. The unpacked runtime generated
  and decoded a synthetic QR using its shipped dependencies. See the
  [manual authenticator checks](manual-authenticator.md#checks).
- Portable: `release/Secure Login Vault 1.0.67.exe` (116,655,901 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer adds manual authenticator setup-key entry alongside QR upload,
using the existing encrypted QR storage and Generate flow. Extension 0.6.6 is
unchanged. Desktop installation does not replace a signed Firefox add-on.

Superseded 1.0.66 package files were removed after verification. Installer
extraction files were cleaned automatically. Synthetic profiles from the
implementation phase were already removed.

## Local 1.0.66 installer

Built on 2026-11-18 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.66.exe` (116,728,199 bytes).
- SHA-256: `71eb2e8f39a824f40d99cc40e21b4ba091bb0fe300765f2ffd0469af1acdb8a0`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 134 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Before packaging, synthetic export tests passed for fresh password verification,
  persisted cooldown, single-use format/path/session binding, expiry, cancellation,
  lock races, reload/password-change revocation, warning and password-field cleanup.
  CSV compatibility and existing IPC/lock hardening regressions also passed.
- Portable: `release/Secure Login Vault 1.0.66.exe` (116,493,563 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer adds [plaintext export protection](plaintext-export-protection.md).
Encrypted backup behavior and extension 0.6.6 are unchanged. Desktop installation
does not replace a signed Firefox add-on.

Superseded 1.0.65 package files were removed after verification. Installer
extraction files were cleaned automatically. Synthetic profiles from the
implementation phase were already removed.

## Local 1.0.65 installer

Built on 2026-11-18 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.65.exe` (116,726,752 bytes).
- SHA-256: `e7dbde357314052f651fb288074f8293fea36728c4fc2ad4afda2ec263f5c113`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 131 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Synthetic group deletion tests passed before packaging: explicit destinations,
  Unassigned, active filter changes, content/history preservation, invalid/stale
  choices, empty/final groups, atomic save failure and lock cancellation.
- Isolated UI tests passed for selection, Cancel, reassignment, Unassigned,
  changed counts and group-dialog cleanup on lock. The synthetic Recently Deleted
  regression also passed, including recreation of removed groups on restore.
- Portable: `release/Secure Login Vault 1.0.65.exe` (116,492,165 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer adds [group deletion with reassignment](group-deletion.md), and
includes the prior unlock layouts and import/restore protections. Extension 0.6.6
is unchanged. Desktop installation does not replace a signed Firefox add-on.

Superseded 1.0.64 package files were removed after verification. Installer
extraction files were cleaned automatically. Synthetic profiles from the
implementation phase were also removed.

## Local 1.0.64 installer

Built on 2026-11-18 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.64.exe` (116,725,972 bytes).
- SHA-256: `e102d168a558b2d9f9ea0acb5ec175709645a6dbf3bfe552494f876d10b30744`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 131 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Synthetic import/restore checks passed before packaging: bounded reads, malformed
  input, interrupted writes, atomic replacement, group scope and lock cancellation.
- Synthetic unlock-layout checks passed before packaging: saved preferences,
  themes, large text, narrow windows, inactive preview, focus return, hint/reveal,
  actual synthetic unlock and preview dismissal on lock. Rendered screens inspected.
- Portable: `release/Secure Login Vault 1.0.64.exe` (116,491,350 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer combines [unlock layout choices](unlock-layouts.md) and
[import/restore protections](import-restore-hardening.md). Extension 0.6.6 is
unchanged; an existing 0.6.6 installation needs no update for these desktop changes.
Desktop installation does not replace a signed Firefox add-on.

Superseded 1.0.62 package files were removed after verification. Installer
extraction files were cleaned automatically. Synthetic profiles from the
implementation phases were also removed.

## Local 1.0.62 installer

Built on 2026-11-18 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, notes,
backup, account data, personal browser profile or OS clipboard was accessed,
read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.62.exe` (116,722,621 bytes).
- SHA-256: `4c6235df64871435dea6c40758cf9f2b75704fa0b6578136aa05feaa34996425`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 128 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Synthetic Notes tests passed for plain-text full/partial selection copying,
  preserved line breaks, unaffected search-field copying, clipboard cleanup on
  lock, editing, pagination, resizing and lock races. Browser navigation,
  cancellation, native transport and isolated desktop tests passed before packaging.
- Portable: `release/Secure Login Vault 1.0.62.exe` (116,488,042 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer combines the [Notes plain-text copy fix](notes.md) and
[browser navigation/cancellation hardening](browser-navigation-hardening.md).
It bundles extension 0.6.6. Reload the Chromium extension to use the extension
changes; Firefox needs a newly signed 0.6.6 XPI installed separately. Desktop
installation does not replace a signed Firefox add-on.

Superseded 1.0.60 package files were removed after verification. Installer
extraction files were cleaned automatically. Synthetic test profiles from the
implementation phases were also removed.

## Local 1.0.60 installer

Built on 2026-11-17 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, backup,
account data, personal browser profile or OS clipboard was accessed, read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.60.exe` (116,720,658 bytes).
- SHA-256: `e2c503c241645e5b79bf7062e290fbc22713ab0072d257dcde312fdc0a1835f2`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 128 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Synthetic clipboard, actual isolated renderer-crash, Windows lock/sleep event,
  background-lock policy and authentication/permission checks passed before packaging.
- Portable: `release/Secure Login Vault 1.0.60.exe` (116,486,065 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This installer combines [Windows lock/sleep protection](system-lock.md) and
[clipboard, crash and timer fixes](clipboard-crash-hardening.md). Extension 0.6.5
is unchanged and does not need an update. Superseded 1.0.58 package files were
removed after verification. Installer extraction files were cleaned automatically.

## Local 1.0.58 installer

Built on 2026-11-17 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, backup,
account data or personal browser profile was accessed, read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.58.exe` (116,719,999 bytes).
- SHA-256: `400841f0c6062afc704552c3dcd7c7eabf254e1bcb224093a5c1b6c1977add82`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 127 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Synthetic Notes UI checks passed before packaging, covering CRUD, safe text,
  unsaved edits, pagination, navigation, window resizing and lock races.
- Portable: `release/Secure Login Vault 1.0.58.exe` (116,485,372 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This update aligns the Notes sort dropdown with its neighboring toolbar controls.
The extension remains 0.6.5 and does not need an update. Obsolete 1.0.57 package
files were removed after verification; installer extraction files were cleaned
automatically.

## Local 1.0.57 installer

Built on 2026-11-16 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, backup,
account data or personal browser profile was accessed, read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.57.exe` (116,719,503 bytes).
- SHA-256: `6b9177e9a2f8d97e0be15a9a79bf9c0ef107c8168eb836d6255dbe5eae340ea0`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 127 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- The Notes source build passed synthetic CRUD, search, paging, stale-write,
  encryption, backup compatibility, lock-race and responsive UI checks. Existing
  dashboard layout and backup verification checks also passed.
- Portable: `release/Secure Login Vault 1.0.57.exe` (116,484,925 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This update adds the [General Notes workspace](notes.md). The extension remains
0.6.5 and does not need an update. Obsolete 1.0.56 package files were removed after
verification. Installer-check extraction files were cleaned automatically.

## Local 1.0.56 installer

Built on 2026-11-15 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, backup,
account data or personal browser profile was accessed, read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.56.exe` (116,714,373 bytes).
- SHA-256: `0b94f1c67170691133433f50f12f6b241ccbede9463caa725d8fc5ec1ff393ee`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 124 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Synthetic resize checks passed for dropdown selections across the dashboard,
  Activity History, all Settings sections, Client Vault and add dialogs. Tests
  covered 980–1600 pixel window widths in both directions and large text.
- Portable: `release/Secure Login Vault 1.0.56.exe` (116,479,794 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

Wrapped dashboard filters now align left and action icons right. The extension
remains 0.6.5. Obsolete 1.0.55 packages were removed after verification; synthetic
inspection folders were cleaned after the UI checks.

## Local 1.0.55 installer

Built on 2026-11-15 with `npm.cmd run dist -- --publish never` for local testing only.
The installer was not executed, installed or published. No real vault, backup,
account data or personal browser profile was accessed, read or copied.

- Setup: `release/Secure Login Vault Setup 1.0.55.exe` (116,714,439 bytes).
- SHA-256: `9bc021babf1be3629816f4f8b51af0c0e5e051b91293700c033ccd222a813a1e`.
- Source/resource allowlist and packaged app checks passed. Final Setup extraction
  passed with 129 outer payload files and 124 files inside `app.asar`.
- Extracted executable fuse checks passed: Node options and Node inspector CLI
  flags disabled, ASAR integrity and ASAR-only app loading enabled. RunAsNode
  remains enabled for native helper compatibility; see the [limits](electron-fuses.md).
- Synthetic renderer checks passed for the credential title/count alignment,
  filtered controls, wide and minimum windows, large text, scrolling and menus.
  Add Client reuses the existing dashboard icon button and tooltip styles.
- Portable: `release/Secure Login Vault 1.0.55.exe` (116,479,813 bytes).
  It shares the approved packaged app; final EXE extraction verification applies
  specifically to Setup.

This update includes the dashboard layout fixes and extension 0.6.5's email-first
fill detection fix. Desktop installation does not replace a signed Firefox add-on.
Obsolete 1.0.54 package files were removed after the current installer passed its
checks. Generated synthetic layout-test folders were also cleaned up.

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
