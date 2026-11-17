# Browser navigation and cancellation hardening

Desktop 1.0.61 and extension 0.6.6, 2026-11-18. Built unpacked for local
testing; no new installer or public release. The latest installer remains
1.0.60 with extension 0.6.5. Firefox 0.6.6 needs Mozilla signing before
permanent installation. No extension permissions were added.

## Findings and changes

The popup previously checked the site's origin when filling, but did not bind
the request to the original document. A synthetic test reproduced a pending
Fill entering credentials into a replacement page on the same origin.

- Popup Fill captures the selected tab when clicked and prepares a one-use,
  expiring token in that document's isolated world before requesting credentials.
- Chromium injection targets the captured document ID. Firefox uses the isolated
  token, exact URL and top-frame checks, including on versions without document-ID
  targeting. Reloads cannot inherit the token.
- The active tab and full URL are rechecked after asynchronous work. Navigation,
  tab closure or switching tabs cancels pending tab-bound operations.
- Forget pairing immediately cancels pending work before its storage operation
  reaches the queue. The operation deadline now cancels the native connection
  instead of only returning a timeout to the popup.
- Locking the desktop or unpairing immediately aborts affected connections.
  Fill approval receives the connection's cancellation signal. Handlers recheck
  authentication, cancellation and pairing after asynchronous reads/approval.
- Inline Fill and save-offer requests also observe cancellation after their
  asynchronous source checks.

## Validation

All inputs are synthetic. Browser API/DOM fixtures simulate Chromium and Firefox;
native transport tests use unique test pipes and in-memory vaults. The desktop
test creates a fresh project-local profile and mocks the clipboard and browser
setup. No installed profile, real accounts, personal browser or clipboard is read.

Relevant commands:

```powershell
npm.cmd run check
npm.cmd run test:navigation
npm.cmd run test:link
npm.cmd run test:getlogin
npm.cmd run test:save
npm.cmd run test:bridge
npm.cmd run test:secure
npm.cmd run test:fill
npm.cmd run test:read
npm.cmd run test:offers
npm.cmd run test:inline
npm.cmd run test:two-step-save
npm.cmd run test:extension
npm.cmd run test:system-lock-app
npm.cmd run test:firefox
```

Navigation regression cases cover normal Fill, same-origin navigation,
same-URL reload, cross-origin navigation, changed active tab, queued clicks,
Forget pairing, timeout and replacement immediately before injection.
Transport regressions cancel pending Fill/Save approvals and desktop connections,
then deliberately accept the late approval: no password is returned or login
written. Existing origin, encryption, rate, locked-vault and form checks remain.
The Firefox reviewer source archive is rebuilt and compared byte for byte with
the generated extension. Unpacked desktop builds use the existing file allowlist,
privacy and Electron fuse gates.

These are automated synthetic checks, not a live personal-browser test or an
independent security audit. A permitted page can read credentials once they are
filled into its fields. Cancellation cannot recall an already delivered password
or undo a save that has already committed. JavaScript strings cannot be reliably
erased from runtime-managed memory.
