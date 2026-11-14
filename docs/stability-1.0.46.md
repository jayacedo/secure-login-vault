# Desktop 1.0.46 stability pass

## Isolation

Tests create fresh synthetic vaults in repository `.tmp` directories and use
separate Electron user-data paths and unique native-message pipes. Installed
vaults, real accounts, backups and existing browser profiles are not accessed.
Startup registration is tested with mocks; this pass does not change the real
Windows startup entry. Packaged helper tests use a fake registry. No real
browser profile is used for reconnection checks.

## Fixes

- Help now focuses search, traps Tab within visible controls, gives its icon-only
  close button an accessible name, and restores launcher focus on close/Escape.
- Back to top updates when the workspace is replaced, avoiding a stale button
  when moving from a scrolled credential list to Client Vault.
- Help names the Actions menu for group/category changes and includes Favorites
  in its Undo explanation.
- An older pairing test expected capitalized “Unlock”; it now accepts the
  current wording while still checking that the locked request is denied.

## Verification scope

- Combined UI: Ctrl+F/N/L/comma, search Escape, Help search/Tab/Escape and Settings
  return; quick filter, sorting, hidden selections, Favorites review and Undo in
  one sequence; workspace switching and lock/unlock.
- Layout: wide/compact/minimum windows, large text, Coffee/light, pinned controls,
  sticky headings, Back to top and Actions placement.
- Tray: isolated hidden startup, compact unlock/cancel, cancellation during
  verification, close-to-tray, reopening and normal quit.
- Browser link: simulated extension transport, encrypted pairing persistence,
  exact-site matching, lock refusal/unlock recovery, independent pairings and
  targeted revocation. These are isolated integration checks, not tests of the
  user's installed Chrome or Firefox profiles.

Commands: `test:stability-app`, `test:dashboard-layout-app`, `test:desktop`,
`test:desktop-app`, `test:link`, `test:multi-pairing`, `test:pairing-app`.

## Results

All checks above passed, along with `npm run check` and `test:hardening-app`
(all 93 desktop request channels). The combined stability test passed against
both source and the packaged application. Packaged Chromium and Firefox helper
tests passed pairing, authentication, save/fill/update, lock and encrypted
persistence using isolated synthetic data and a fake registry.

Built `Secure Login Vault Setup 1.0.46.exe`. Browser extension version remains
0.6.1. No installed browser profile or real account data was used.
