# Browser extension

The extension connects Chrome or Edge to the running Windows desktop app. The desktop
vault remains the source of saved credentials. Browser phases are separate from the
original desktop implementation plan.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Native messaging helper, desktop bridge, registration, popup | Complete |
| 2 | Pairing and mutual authentication on each connection | Complete |
| 3 | List credentials matching the current website origin | Complete |
| 4 | Fill a selected login without submitting the page | Complete |
| 5 | Save a new login or update a saved password after desktop confirmation | Implemented; automated verification complete |

## Development setup

1. Run `npm.cmd install` if dependencies are not installed.
2. Run `npm.cmd start` and unlock the desktop vault.
3. Turn on **Settings > Security > Browser Extension**.
4. Run `npm.cmd run extension:register` to register the helper for the current Windows user.
5. In `chrome://extensions` or `edge://extensions`, enable Developer mode and load the
   repository's `extension` folder using **Load unpacked**.
6. Use **Settings > Pair Browser** in SLV to generate a code. Paste it into the extension
   popup and pair. The popup should show **Connected** with a verified connection.

After updating the code, restart the desktop app and reload the extension. Re-register
the helper if the repository moves. `npm.cmd run extension:status` checks registration.

## Save and update

1. Enter the username/email and password on the website, before submitting the form.
2. Open the extension and click **Save this login**.
3. Confirm **Add** or **Update** in the desktop app within 30 seconds.

A new entry uses the site's host as its name and stores only the origin (scheme, host,
and port), without the URL path or query. A matching origin and username updates the
existing entry's password while preserving its other fields. Repeating the same password
does not write or prompt. Both the popup list and desktop dashboard refresh after success.

The active group filter still applies. New entries default to the active group when one
is selected. Saving does not search hidden groups or modify their credentials.

The extension reads the page only after Save is clicked. It reads the top frame in an
isolated script world and checks the origin again inside the page. Passwords travel
through the verified native connection; they are not included in popup responses or
confirmation text. Save always needs desktop confirmation. Closing, declining, timing
out, or losing the connection cancels a pending confirmation. A locked vault refuses
saves. A conflicting password change during confirmation requires retrying.

## Current limits

- HTTPS pages are supported; HTTP is allowed only for localhost/loopback development.
- Matching is exact: subdomains, schemes, and non-default ports are distinct.
- Saving is manual, before form submission; there is no automatic submission monitoring.
- The username and password must be available together in the top-level page. Embedded
  frames, shadow-root fields, and separate username/password pages are not read together.
- Passwords from multiple forms or conflicting old/new passwords are refused. Fill the
  desired credentials in an ordinary login form or edit the entry in SLV instead.
- This phase does not package or publish a browser-store extension or sign off the
  Windows installer.

## Verification

Validated on Windows on 2026-11-11:

```powershell
npm.cmd run check
npm.cmd run test:read
npm.cmd run test:save
npm.cmd run test:link
npm.cmd run test:host
npm.cmd run test:bridge
npm.cmd run test:fill
npm.cmd run test:getlogin
npm.cmd run test:extension
npm.cmd run test:e2e
```

Regression coverage includes form boundaries, username hints, exact origins, locked
vaults, rejected saves, changed passwords during confirmation, disconnection, rate
limits, preservation of existing fields, and passwords staying out of popup traffic.
The end-to-end test exercises the real Electron app, encrypted vault, native launcher,
helper, and named pipe. It includes a delayed confirmation longer than the former
transport deadlines, desktop refresh, and persistence across lock/unlock.

The automated browser side uses simulated Chrome APIs and DOM pages; the native dialog
answer is simulated. A manual Chrome/Edge check on a real site remains a release check,
not something these tests establish. Tests use isolated vaults and pipes under `.tmp`
and do not change the real browser's registry registration or the user's vault.
