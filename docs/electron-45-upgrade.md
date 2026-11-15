# Electron 45 compatibility update

Desktop 1.0.51 updates Electron from 42.5.0 to 45.3.2. The browser extension
remains 0.6.4. This build is for local testing; no public release is published.

## Changes

- Authenticator code copying awaits clipboard writes and reads. Clipboard work
  is serialized, preserves unrelated clipboard text, and removes a code written
  while its request was cancelled, the vault locked, or the code expired.
- Normal shutdown allows clipboard cleanup to finish, with a two-second limit
  so an unavailable OS clipboard cannot prevent quitting indefinitely.
- Pairing storage uses asynchronous `safeStorage` encryption/decryption.
  Startup awaits loading; saved access changes only after persistence succeeds.
  Pairing writes and revocations are serialized. Cancellation, expiry and
  connection closure are checked before an encrypted pairing file is committed.
  The vault session is rechecked after encryption availability resolves, before
  a pairing code can be started.
- The packaging allowlist reflects the reviewed Electron 45 Windows runtime:
  removed `dxil.dll`, `libEGL.dll` and `libGLESv2.dll`; allowed `electron_wer.dll`.
  Application, dependency and extension file restrictions remain enforced.

## Validation and privacy boundary

All validation uses newly generated synthetic data, isolated project `.tmp`
profiles, unique test pipes, and fake clipboards/registries where needed. Real
vaults, accounts, backups, private QR files and browser profiles are not inputs.

Passed checks include:

- Syntax and package privacy regression tests.
- Asynchronous clipboard success/failure, lock during a pending write, unrelated
  text preservation, normal shutdown cleanup, and cancelled pairing persistence.
- Pairing protocol, multiple browsers, encrypted transport, exact site matching,
  Save/Fill, two-step form capture and local hardening regressions.
- Electron 45 integration: synthetic legacy-format pairing ciphertext remains
  readable, asynchronous Windows encryption round trip, restart reload and
  targeted unpairing.
- Synthetic app UI: authenticator, browser save confirmation, automatic backups,
  IPC boundaries, tray/compact unlock, and dashboard stability.
- Packaged ASAR authenticator worker and UI; Chromium and Firefox native helper
  transport from the extracted installer, with fake registration and dummy vaults.

## Local installer

`release/Secure Login Vault Setup 1.0.51.exe` passed all three build privacy gates.
The final installer contains 129 outer payload files and 123 files in `app.asar`.
SHA-256:

```text
318d3483d6e7c4f43605a1e40e718a9e6b61622e054bbd9bf300e2fe007acc60
```

The installer was inspected and its extracted helper tested; it was not installed
over the user's existing app. No GitHub release was created or uploaded.

## Repeating focused checks

Commands for the new focused checks:

```powershell
npm run test:electron-compat
npm run test:electron-storage-app
```

On 2026-11-15, `npm audit` no longer flagged Electron. Twelve findings remain
in other dependencies (six moderate, six high); this update does not claim to
resolve those. These tests and the packaging inventory are not an independent
security audit. Interactive testing of the installed build is still recommended
in a separate Windows test account with synthetic entries.

References:

- [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)
- [Clipboard API](https://www.electronjs.org/docs/latest/api/clipboard)
- [safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage)
