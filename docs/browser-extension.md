# Browser extension

The extension connects Chrome, Edge or Firefox to the running Windows desktop app. The desktop
vault remains the source of saved credentials. Browser phases are separate from the
original desktop implementation plan.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Native messaging helper, desktop bridge, registration, popup | Complete |
| 2 | Pairing and mutual authentication on each connection | Complete |
| 3 | List credentials matching the current website origin | Complete |
| 4 | Fill a selected login without submitting the page | Complete |
| 5 | Save a new login or update a saved password after desktop confirmation | Automated verification and manual Chrome localhost smoke check passed |
| 6 | Bundle browser files and provide setup from the installed app | Implemented in 1.0.1; Settings and relocated-package tests passed |
| 7 | Optional save/update offers after form submission | Implemented in 1.0.2 / extension 0.2.0; automated worker, native, DOM and Chromium fixture checks |
| 8 | Encrypted local transport, replay rejection and optional session-only pairing | Implemented in 1.0.3 / extension 0.3.0; see the security notes |
| 9 | Firefox companion, native registration and packaging | Implemented in 1.0.4 / extension 0.4.0; real Firefox integration tested; Mozilla signing still required for permanent installation |
| 10 | Independent browser pairings and individual revocation | Implemented in 1.0.5 / extension 0.5.0; migration, rotation, selective removal, persistence and real Firefox coexistence tested |
| 11 | Optional inline account chooser beside login fields | Implemented in 1.0.13 / extension 0.6.0; worker boundaries, selected-form fill, trusted clicks and real Firefox/native path tested |

Desktop 1.0.6 reorganizes Settings into sections. Browser setup, preferences and
individual pairings now live under **Browsers**, with installation instructions
collapsed until needed. Extension 0.5.0 is unchanged.

## Setup from the Windows installer (1.0.1 and later)

1. Install the latest **Secure Login Vault Setup** installer, then open and unlock SLV.
2. Open **Settings > Browsers > Installation & troubleshooting** and click **Set Up Browser Extension**.
   This registers the helper for Chrome, Edge and Firefox for your Windows account, turns on
   SLV's browser connection, and opens the bundled extension folder.
3. In `chrome://extensions` or `edge://extensions`, enable Developer mode, click
   **Load unpacked**, and select that folder. Its path is also shown in Settings.
4. Click **Add browser** in SLV and paste the code into the extension popup.

The Setup installer includes the extension and native helper under its `resources`
folder. The helper uses SLV's own executable as its runtime. Users do not need Node.js,
npm, the source repository, or a separate extension download. Chrome/Edge loading and
pairing remain explicit user steps; the installer does not silently install an extension.

After an update, reload the extension from the browser's extensions page. If SLV moves
to another folder, run setup again and load the extension from the new folder. Settings
detects registration pointing at a different SLV installation. Users migrating from a
development extension should replace that unpacked extension with the installed copy
and pair again if needed.

Browser setup is disabled in the portable build because its extracted runtime is
temporary. Use the Setup installer for the desktop-and-browser workflow. The desktop
vault still works in the portable build.

Registration is written only after clicking Set Up Browser Extension, not during
installation or ordinary startup. The helper's launcher and manifest are stored in
`%LOCALAPPDATA%\\SecureLoginVault\\native-host`; registration is per-user HKCU for Chrome
Edge and Firefox. The app checks the bundled extension identity and probes the packaged runtime
before registering it. Repeating setup repairs registration without changing vault data
or the existing pairing secret.

## Firefox

SLV 1.0.13 bundles a generated Firefox add-on. Use **Open Firefox Folder** in Settings
and follow the [Firefox setup and signing guide](firefox.md). Local testing uses a
temporary add-on; permanent installation requires Mozilla signing. Chrome, Edge and Firefox
can stay paired together and share the existing vault. Settings supports individual removal.

## Development setup

Use desktop 1.0.48 with extension 0.6.3: update both, then reload the extension. Existing
remembered pairing remains usable. The extension's **Pairing security** section offers
memory-only pairing for the current browser session. See [Browser security](browser-security.md)
for the encrypted protocol, threat limits, storage tradeoff and tests.

1. Run `npm.cmd install` if dependencies are not installed.
2. Run `npm.cmd start` and unlock the desktop vault.
3. Turn on **Settings > Browsers > Allow Browser Access**.
4. Run `npm.cmd run extension:register` to register the helper for the current Windows user.
5. In `chrome://extensions` or `edge://extensions`, enable Developer mode and load the
   repository's `extension` folder using **Load unpacked**.
6. Use **Settings > Browsers > Add browser** in SLV to generate a code. Paste it into the extension
   popup and pair. The popup should show **Connected** with a verified connection.

After updating the code, restart the desktop app and reload the extension. Re-register
the helper if the repository moves. `npm.cmd run extension:status` checks registration.

## Save and update

Since desktop 1.0.7, new saves use a dedicated confirmation dialog with Group and Category
selectors. The active group is preselected; Unassigned and other existing groups
can be chosen explicitly. Category defaults to Other when available. Choosing a
different group does not change the vault's active group filter. The dialog warns
when the saved entry will be outside that filter. Password updates retain all
existing metadata. No password is sent to the confirmation renderer.

Cancel, close, timeout, vault lock or browser disconnect declines a pending save.
Group/category choices are validated again when writing to the vault. A change to
the active group or removal of the selected group/category requires a new save.
The save dialog is a desktop feature. Inline fill suggestions require extension 0.6.0, including a newly signed Firefox package.

1. Enter the username/email and password on the website, before submitting the form.
2. Open the extension and click **Save this login**.
3. Confirm **Add** or **Update** in the desktop app within 30 seconds.

A new entry uses the site's host as its name and stores only the origin (scheme, host,
and port), without the URL path or query. A matching origin and username updates the
existing entry's password while preserving its other fields. Repeating the same password
does not write or prompt. Both the popup list and desktop dashboard refresh after success.

The active group filter still applies. New entries default to the active group when one
is selected. Saving does not search hidden groups or modify their credentials.

Manual saving reads the page only after Save is clicked. It reads the top frame in an
isolated script world and checks the origin again inside the page. Passwords travel
through the verified native connection; they are not included in popup responses or
confirmation text. Save always needs desktop confirmation. Closing, declining, timing
out, or losing the connection cancels a pending confirmation. A locked vault refuses
saves. A conflicting password change during confirmation requires retrying.

## Separate username and password steps (extension 0.6.2)

Manual Save recognizes a single visible selected-account marker on the exact
`https://accounts.google.com` origin. It does not search arbitrary page text for
email addresses. If the username is missing, the extension popup asks you to enter
or confirm it, then **Continue saving**. Desktop confirmation is still required.
The popup never receives the password. Continue reads it fresh from the same
document and URL with a one-use token valid for two minutes; navigation, reload,
tab changes or expiry require starting Save again.

With automatic offers enabled, a trusted submit of a recognizable username-only
form remembers that username for at most two minutes in worker memory, scoped to
the exact origin and tab. A subsequent password submit can use it. It is cleared
on capture/save, cancellation, tab closure, cross-origin navigation, disabling
offers, permission removal or forgetting pairing. Nothing is written to browser
storage. Worker shutdown can discard it earlier. For manual-only use, pressing
Save on a username-only step remembers it; the next password-step Save asks you
to confirm it. A fresh username detected on the password page takes precedence.

Custom JavaScript navigation without a trusted form submit may not trigger an
automatic offer. Use manual Save and its username prompt. The extension cannot
recover passwords from already signed-in sessions.

Verified using synthetic documents, mocked Chromium/Firefox APIs, trusted local
Chromium submits and the native helper connected to a fresh synthetic vault.
No real account or installed browser profile is used by these checks.

## Inline fill suggestions (extension 0.6.0+, logo button in 0.6.1, optional)

1. Open the extension popup and expand **Inline fill suggestions**.
2. Enable it and approve optional website access. It shares the existing HTTPS/localhost permission with save offers; each feature has its own toggle.
3. Reload any login pages already open, then focus a username or password field.
4. Click the **SLV logo** beside the field (text ?SLV? in 0.6.0) and choose a matching account. Confirm in the desktop app if **Ask Before Filling** is on. Nothing is submitted.

No account lookup runs on page load or field focus. Account names and usernames appear only after a click; passwords are never returned through chooser messages. A choice expires after 60 seconds and is bound to the active tab, full page URL, document and selected form. Navigation, dismissal, a replaced form, disabled access or a locked vault prevents filling. The selected form alone is filled.

The first version supports ordinary top-level forms, including recognizable username-only steps. It excludes sign-up/password-change forms with multiple or new-password fields, cross-origin form actions, iframes and shadow-DOM fields. Use popup Fill or manual entry for unsupported forms. A website can still read credentials filled into its own fields.

Disable the toggle to remove inline controls from open pages. Popup Fill remains available. The account list shows up to 20 matches.

Tests: `test:inline`, `test:inline-ui`, `test:fill` and `test:firefox-browser` cover request boundaries, trusted clicks, selected-form filling, stale targets, navigation, disable and the real Firefox/native-helper path.

## Automatic save offers (optional)

1. Update and restart SLV, then **Reload** the extension on `chrome://extensions`.
2. Open the extension popup, expand **Automatic save offers**, and enable
   **Offer to save submitted logins**. Approve Chrome's optional website-access request.
3. Reload any already-open login pages once. Keep SLV running and paired.
4. Submit a normal login form. A small SLV card offers **Save** for a new login or
   **Update** for a changed password. An unchanged login produces no card.
5. Click Save/Update and approve the change in SLV. **Not now** discards the candidate.
   **Never for this site** disables offers for that exact origin; the extension settings
   let you allow that site again. The global toggle disables offers everywhere.

The feature starts off and uses dynamically registered isolated, top-frame content
scripts only after permission is granted (HTTPS and localhost/127.0.0.1 for development).
It reads only a submitted form following a trusted click/key press in that form; it
does not record input values as they are typed. It never submits or blocks the form.
The offer means a form was submitted, not that the site accepted the login.

Captured candidates stay only in worker memory, for at most two minutes while the
worker runs. Browser/worker restarts can expire offers earlier. They are discarded on
dismissal, save completion, tab closure, cross-origin navigation, disabling offers or
permission removal; they are never written to browser local/sync/session storage.
Same-origin redirects can recover a still-live offer. If an offer expires, use manual Save.
If SLV is locked, the card asks you to unlock it before saving. Disconnected/unpaired
apps produce no automatic offer. A new desktop version is required for inspection;
older apps retain manual Save support.

The pairing secret and preferences are restricted to trusted extension contexts.
Content scripts cannot invoke privileged popup pairing, fill, manual-save or settings routes. The separate inline protocol permits scoped choices and one-use fill requests. Candidate
origins come from Chrome sender/tab metadata; pages receive only a short-lived token and
offer mode, never stored credentials. Inspection is authenticated and rate-limited and
returns only add/update/unchanged, without writing or displaying a desktop dialog.
Saving still uses the existing mandatory desktop confirmation and conflict checks.

## Current limits

- HTTPS pages are supported; HTTP is allowed only for localhost/loopback development.
- Matching is exact: subdomains, schemes, and non-default ports are distinct.
- Automatic offers cover ordinary form submissions. Formless JavaScript flows,
  cross-origin form actions, embedded forms and some multi-step sign-ins need manual Save.
- The username and password must be available together in the top-level page. Embedded
  frames, shadow-root fields, and separate username/password pages are not read together.
- Passwords from multiple forms or conflicting old/new passwords are refused. Fill the
  desired credentials in an ordinary login form or edit the entry in SLV instead.
- This phase does not package or publish a browser-store extension or sign off the
  Windows installer on a clean machine. The installer bundles an unpacked extension.

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
npm.cmd run test:offers
npm.cmd run test:offers-ui
npm.cmd run test:secure
npm.cmd run test:secure-browser
npm.cmd run test:e2e
```

Regression coverage includes form boundaries, username hints, exact origins, locked
vaults, rejected saves, changed passwords during confirmation, disconnection, rate
limits, preservation of existing fields, and passwords staying out of popup traffic.
The end-to-end test exercises the real Electron app, encrypted vault, native launcher,
helper, and named pipe. It includes a delayed confirmation longer than the former
transport deadlines, desktop refresh, and persistence across lock/unlock.

The transport end-to-end test uses simulated Chrome APIs and real app/native transport;
the native dialog answer is simulated. The offer UI fixture separately uses Chromium's
isolated world and trusted input events on a local dummy page, checks Save/Never, and
captures the rendered card. Actual Chrome/Edge extension reload, permission prompts,
service-worker suspension and navigation on third-party sites still need manual checks.
Automated tests use isolated vaults and pipes under `.tmp`
and do not change the real browser's registry registration or the user's vault.

### Manual Chrome check (2026-11-11)

The user performed these checks in Chrome with the running desktop app, using the local
test page at `http://127.0.0.1:56703/` and the dummy account `slv-browser-test`:

- The extension showed a connected, verified desktop app.
- Save opened an Add confirmation; the user approved it and the entry appeared in SLV.
- After clearing the page fields, Fill restored both fields (confirmed by the user).
- Saving a changed dummy password opened an Update confirmation. The desktop editor
  subsequently showed the expected changed password on the saved entry.
- After locking SLV and refreshing the popup, saved logins and Fill were hidden.
- Save while locked reported that SLV must be unlocked before retrying.

Screenshots supplied by the user confirmed the UI results above, except the fill result,
which the user confirmed in text. The dummy entry was added to the user's existing vault.
No cleanup of that entry has been performed. This check does not establish Edge behavior,
public HTTPS-site compatibility, or a fresh-install/packaged release result; those remain
release checks.

### Packaging verification (1.0.3)

```powershell
npm.cmd run test:browser-setup
npm.cmd run test:browser-setup-app
npm.cmd run dist -- --publish never
npm.cmd run test:packaged-browser
```

The setup tests cover bundle identity, missing files, per-user registration, repair
after relocation, preflight failures, unsupported portable setup, locked-vault guards,
the Settings controls, connection enablement and pairing. The packaged test extracts
the actual Setup installer's application payload to a separate folder with spaces and runs its shipped native
helper using its shipped executable. It exercises pairing, authentication, inspection, save, fill,
update, locked reads/writes and encrypted persistence with Node.js removed from the
helper's PATH. Test registry writes are simulated; the user's browser registration and
vault are untouched. This does not execute the installer wizard or replace a clean-machine
installer/Chrome/Edge check. The generated executables are not digitally signed.

Packaging follows [Electron Builder's extraResources configuration](https://www.electron.build/v26/docs/configuration/).
The helper relies on [Electron's ELECTRON_RUN_AS_NODE support](https://www.electronjs.org/docs/latest/api/environment-variables);
the packaged smoke test verifies that the runtime supports it.
