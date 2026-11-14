# Secure Login Vault Implementation Plan

This document adapts two separate source prompts for this repository.

## Source Prompt 1: Product Requirements

Source: `Secure_Login_Vault_AI_Development_Prompt (1).md`

Role: defines what Secure Login Vault should become.

Repo adaptation:

- Build a Windows-focused Electron desktop application named Secure Login Vault.
- Keep the app local-first and offline-first.
- Use a security-first architecture with context isolation, no renderer Node access, prepared database access, no plaintext credential logging, and encrypted storage in a later phase.
- Use HTML, CSS, and vanilla JavaScript for the renderer unless a later approved phase changes that direction.
- Add SQLite and SQLCipher or a strong AES-256 envelope encryption approach during the database and authentication phases.
- Preserve the product backlog: authentication, dashboard, live search, credentials, categories, generator, clipboard clearing, import/export, backup/restore, settings, theme, and packaging.

## Source Prompt 2: Workflow Requirements

Source: `AI_Development_Workflow_Phased_Prompt_v2.md`

Role: defines how development should proceed.

Repo adaptation:

- Work in explicit phases and stop after each phase for approval.
- Review the existing project before each phase.
- Preserve working behavior from previous phases.
- Modify only files required for the active phase.
- Provide an end-of-phase report with summary, created files, modified files, unchanged files, run instructions, test checklist, known limitations, and approval status.

## Phase Plan

### Phase 1: Project Initialization

Status: complete in this repo.

Scope:

- Create Electron project metadata.
- Configure a secure main process window.
- Configure a minimal preload bridge.
- Add a renderer shell.
- Add Electron Builder metadata.
- Add README and this implementation plan.

### Phase 2: Authentication

Status: complete in this repo.

Scope:

- Add complete first-launch Create Vault screen.
- Add returning-user Login screen.
- Add show/hide password controls with eye icons.
- Add password strength meter.
- Add live password matching.
- Hash master password with bcrypt.
- Add SQLite integration with `sql.js`.
- Initialize an encrypted SQLite vault file.
- Establish encrypted vault metadata with a scrypt-derived AES-256-GCM verification record.
- Add Electron IPC handlers for vault state, create, unlock, and lock.
- Add session state transitions.
- Add form validation and user-facing error handling.
- Add authentication smoke-test coverage.

### Phase 3: Dashboard UI

Status: complete in this repo.

Scope:

- Add unlocked dashboard workspace.
- Add category navigation with default categories.
- Add favorites access and filter controls.
- Add search field placement.
- Add Add Credential and Settings actions.
- Add summary cards.
- Add credential list structure and empty state.
- Preserve lock control and session transition back to login.

### Phase 4: Database Integration

Status: complete in this repo.

Scope:

- Add encrypted SQLite dashboard read helpers.
- Keep decrypted database access in the main process.
- Add prepared-statement read helpers.
- Add database-backed dashboard IPC.
- Load categories, summary counts, and safe credential list fields from SQLite.
- Block database reads while the vault is locked.
- Extend smoke tests for encrypted database reads.

### Phase 5: Credential Management

Status: complete in this repo.

Scope:

- Add credential create, read, update, and delete operations.
- Add favorite toggling.
- Add category retrieval.
- Add credential modal UI.
- Persist credential changes to the encrypted SQLite vault.

### Phase 6: Live Search

Status: complete in this repo.

Scope:

- Add search IPC and encrypted database query support.
- Search across website, URL, username, email, notes, tags, and category.
- Preserve active category and favorites filters.

### Phase 7: Password Generator

Status: complete in this repo.

Scope:

- Add configurable password generation.
- Add length and character-set controls.
- Add strength feedback.
- Add copy and use-generated-password actions.

### Phase 8: Clipboard Management

Status: complete in this repo.

Scope:

- Add copy actions for username, password, email, and URL.
- Add toast notifications.
- Add configurable password clipboard auto-clear.
- Keep decrypted passwords out of the credential list DOM until copied.

### Phase 9: Import / Export

Status: complete in this repo.

Scope:

- Add CSV, JSON, and KeePass CSV import.
- Add CSV and JSON export.
- Add encrypted backup creation.
- Add encrypted backup restore.

### Phase 10: Settings

Status: complete in this repo.

Scope:

- Add settings modal.
- Add light, dark, and system theme preference.
- Add auto-lock preference.
- Add clipboard auto-clear preference.
- Add default backup folder preference.
- Add app info and vault path display.
- Add change master password flow.

### Phase 11: UI Polish

Status: complete in this repo.

Scope:

- Normalize visible phase labels.
- Polish focus-visible states.
- Fix settings segmented-control scope.
- Improve dark-mode coverage for current dashboard and modal classes.
- Tighten responsive layout for narrow windows and modals.
- Clean visible UI punctuation artifacts.
- Update project documentation through Phase 11.

### Later Phases

Phase 12 now produces Windows installer and portable builds. Version 1.0.1 adds bundled
browser resources and setup from Settings, with automated Settings and relocated-package
verification. Clean-machine installer verification remains a release check.

Version 1.0.2 adds optional browser save/update offers after ordinary form submissions,
with explicit website permission, duplicate suppression, per-site dismissal, temporary
memory-only candidates, and mandatory desktop confirmation for writes.

Version 1.0.3 adds protocol v2 encryption and message authentication, replay rejection,
bounded serialized processing, and optional browser-session pairing. It preserves
existing remembered pairing while requiring both app and extension to be updated.
See [Browser security](browser-security.md) for test coverage and remaining review.

Version 1.0.4 adds a Firefox companion generated from shared extension source, a
separate Windows native manifest, extension-private pairing persistence, Firefox
setup guidance and an unsigned submission ZIP. Real Firefox tests cover the encrypted
connection, save/fill/update, automatic offers, storage isolation and lock behavior.
Mozilla signing and permanent installation remain a distribution step. See the
[Firefox guide](firefox.md).

Version 1.0.5 supports multiple browser pairings with independent secrets, preserves
the previous pairing on upgrade, and lets Settings revoke one browser or all browsers.
Re-pairing with the existing browser secret rotates only that pairing. Each browser
continues using the same vault. Extensions must be updated to 0.5.0.

## Browser extension phases

Desktop 1.0.14 adds Recently Deleted for credential entries, including entries
displaced by Replace import. Entry metadata and password history are retained in
the encrypted vault for 30 days, excluded from normal reads and browser matching,
and restored together. Permanent deletion requires confirmation. Expiry cleanup
runs after unlock, hourly while unlocked and on vault writes. Trash respects the
active group and is included in encrypted backups, with original expiry dates.
The separate Client Vault is not included. Extension 0.6.0 is unchanged.

`test:trash` covers encrypted storage, metadata-only responses, normal-read
exclusion, group/lock guards, restoration, expiry, backup recovery, failed writes
and concurrent requests. `test:trash-app` covers the desktop controls, confirmation,
sender guards, light/dark narrow layouts and lock cleanup.

Desktop 1.0.15 adds Duplicate Login Review and refreshed searchable Help. Matching
uses the exact website origin plus case-sensitive username (email fallback),
excluding invalid URLs, blank identities, Trash and Client Vault. Cleanup requires
an explicit kept entry and confirmation; the remaining matching entries move to
Recently Deleted with their own histories. Full-row keyed revisions and the active
scope are rechecked inside the serialized write, so stale or concurrent decisions
cannot silently remove changed entries. Nothing is merged into the kept entry.
`test:duplicates` verifies matching, scope, stale/forged choices, atomic failure,
concurrency and recovery. `test:duplicates-app` verifies the comparison, edit return,
confirmation, Help search, lock cleanup and layouts. Extension 0.6.0 is unchanged.

Desktop 1.0.16 adds local hardening: shared sender/document/frame checks across
desktop requests, current-session checks on sensitive replies and file dialogs,
revoked picker grants on lock, serialized vault operations across password changes
and recovery, and one desktop writer per profile. Lock cancels queued work and
uncommitted writes; a replacement already committing finishes or rolls back with
its temporary key, without reopening the session. Restore validates decrypted data
before overwrite, cleans partial first restores, and supports recovery of an
interrupted replacement. Temporary key and database buffers are cleared on exit.
`test:hardening` covers deterministic disk/lock failure cases; `test:hardening-app`
covers all desktop request channels, late reads/dialogs, staged exports and a second
process. Extension 0.6.0 and the local-only product scope remain unchanged.

Desktop 1.0.17 bundles extension 0.6.1, which replaces the inline “SLV” text with
the existing vault symbol as a compact teal SVG icon. It adds a hover highlight
and “Fill with Secure Login Vault” tooltip while preserving the accessible name,
focus outline, trusted-click guard and account chooser. No new permissions or
network resources are needed. Inline UI checks cover mouse filling, keyboard
activation and Escape focus return. Firefox 0.6.1 requires a newly signed XPI;
existing 0.6.0 remains compatible with the desktop.

Desktop 1.0.18 adds encrypted Activity History for credential additions, updates,
password changes, deletion, restoration and confirmed permanent deletion. Events
commit with the credential mutation and carry only ID, login name, historical group,
action, desktop/browser source and time. No secret values are copied. Search, action
and source filters, 50-event pages and the active group apply in the desktop modal.
Events expire after 90 days; cleanup runs on writes, after unlock and hourly while
unlocked. Encrypted backups retain their snapshot; CSV/JSON exports and browser
responses exclude history. Older actions and Client Vault are not covered.
Browser password updates now modify only that field in the serialized write.
`test:activity` checks atomicity, source labels, filters, retention and backups;
`test:activity-app` checks the interface, request guards, keyboard access and layouts.
Extension 0.6.1 is unchanged.

Desktop 1.0.19 adds local TOTP generation from the existing encrypted QR field in
Credentials and Client Vault. Explicit Generate code requests decode a bounded PNG
in a worker, accept standard TOTP setup URIs, and reject unsupported QR types. Codes
and account labels cross the guarded desktop IPC boundary; decoded keys stay in the
main process and expire after five minutes or on close, lock or renderer reload.
Copy generates a fresh code and clears its clipboard value at expiry (30 seconds
maximum), without clearing unrelated text. The saved QR is retained in encrypted
backups and JSON credential exports; no new seed column or code history is added.
`test:authenticator` covers RFC 6238 vectors, QR validation and session/clipboard
boundaries; `test:authenticator-app` covers both editors, safe labels, lock/reopen,
keyboard access and narrow layouts. The same UI test can run against the packaged
ASAR using `SLV_TEST_PACKAGED_APP`. Extension 0.6.1 is unchanged.

Desktop 1.0.20 adds a dedicated 2FA column beside Password in the credential table.
Entries with a saved QR show Generate; others show a dash. List/search/dashboard
queries return only QR presence, and the direct action loads the selected image in
the main process through the existing group/session guards. Closing or locking
during that read cancels the pending decode. The table scrolls horizontally within
its panel on narrow windows. QR maintenance stays in Edit; Client Vault keeps its
existing editor action. Authenticator tests cover search, favorites, QR changes,
missing entries, group isolation, cancellation, focus return and table layouts.
Extension 0.6.1 is unchanged.

Desktop 1.0.21 aligns Copy URL and Open Website actions in fixed slots within the
website cell. The lane is capped at 360 pixels and shrinks with the column; long
names and URLs use ellipsis and expose their full text on hover. Hover and keyboard
focus retain the existing actions without shifting their horizontal positions.
No credential data or browser behavior changes. Extension 0.6.1 is unchanged.

Desktop 1.0.22 adds Generate 2FA directly to Client Vault cards with saved QR images.
The action opens the existing code view without opening Edit, and closing returns
focus to the button. Client list/search queries expose QR presence only; the
guarded main-process action loads the chosen client image on demand. The existing
session/cancellation and clipboard protections also apply to this entry point.
Client search, Favorites and QR replacement/removal retain the correct action.
Authenticator UI checks cover card routing, metadata, missing/deleted clients,
locked access, copy/focus and narrow layouts. Extension 0.6.1 is unchanged.

Desktop 1.0.23 removes Category from the credential table and moves group badges
beneath the website details. The five columns are Website, Username, Password,
2FA and Manage. Categories remain stored and available in Edit, search and filters.
The narrower table retains aligned website actions and horizontal scrolling when
needed. Existing UI checks cover the new headers, group placement, category filters,
Edit values and authenticator actions. Extension 0.6.1 is unchanged.

Desktop 1.0.24: Help, Settings, Add Credential and Lock use
consistent 44-pixel icon-only buttons. Tooltips appear on hover and focus, and
accessible labels preserve their names. Add Credential keeps its accent background;
Settings uses a gear symbol. The compact header retains horizontal actions on narrow
windows. Vault Health, Recently Deleted, Review Duplicates and Activity History
also use labeled icon-only controls. All eight actions share a subtle raised,
tilted hover/focus effect and a pressed state; reduced-motion settings disable
the movement. Credential tools stay grouped as the header wraps on narrow windows.
The controls are verified in development at wide and narrow window sizes.

Also in 1.0.24: Add/Edit Credential and CSV exports use "Login URL".
CSV import accepts Login URL, Website URL and URL, with Website/Website Name,
Username, Password, Group and Category mapping. Standard CSV imports show a
masked, paginated review before saving, offer defaults for blank group/category
cells, and skip invalid rows and possible duplicates by default. Existing records
remain unchanged; explicitly including duplicates adds separate entries. Password
whitespace, commas, quotes and newlines are preserved. Cancel/lock clears the
review, and a changed active group requires a fresh review. JSON and KeePass retain
their existing Merge/Replace choices. Verified with parser and Electron UI tests.
The 1.0.24 Windows Setup package is built and its extracted payload matches the
current renderer, including both CSV review modules. Packaged Chromium and Firefox
checks pass for pairing, save, fill, update, locking and encrypted persistence.
Extension 0.6.1 is unchanged.

Desktop 1.0.25: disabled CSV Previous/Next controls use a normal arrow
cursor instead of the generic busy cursor. Page-boundary behavior is unchanged.
The Windows Setup installer is built; extracted-source checks and packaged
Chromium/Firefox pairing, save, fill, update and lock checks pass.

Desktop 1.0.26: Settings > General includes Start with Windows,
Start in system tray and Close to tray, all off by default. Windows sign-in can
start an existing vault quietly in the tray, always locked; a direct launch opens
the window. Tray Open SLV shows a compact, branded unlock form, and successful
unlock restores the dashboard size. Cancel, Escape and the unlock window's close
button return to the tray, clearing input and invalidating pending unlock attempts.
Closing the dashboard with Close to tray enabled locks immediately. The tray menu
provides Open SLV, Lock Vault and Quit; quitting and Windows shutdown bypass the
hide-on-close behavior. First-vault setup and unavailable-tray cases stay visible.
Startup registration is available only in installed Windows builds and respects
Windows Startup Apps disabling it. Development tests use mock startup registration
and isolated vaults; no real startup preference is enabled by these checks.
The 1.0.26 Windows Setup installer is built. CSV parser and Electron import tests
pass; extracted-source checks and packaged Chromium/Firefox pairing, save, fill,
update, lock and encrypted persistence checks pass. Extension 0.6.1 is unchanged.

Desktop 1.0.27 fixes Windows startup registration verification for executable paths
containing spaces. Reads and writes now use the same quoted executable path;
previously the launch-item lookup could truncate it and roll back a valid setting.
Settings errors distinguish unsupported installations, Windows registration and
preference-file failures. A native Windows regression test reproduces the original
failure and verifies enable, OS disable, re-enable and removal using a unique
temporary registry entry pointing to a nonexistent executable. That entry is
removed after testing; the user's SLV startup registration is not changed.
Tray/unlock integration checks also pass. The 1.0.27 Windows Setup installer is
built; extracted-source and packaged Chromium/Firefox checks pass for pairing,
save, fill, update, lock and encrypted persistence. Extension 0.6.1 is unchanged.

Desktop 1.0.28 uses a normal arrow cursor for disabled desktop buttons instead of
the shared busy cursor. This covers both Activity History and CSV import pagination
and removes the need for a CSV-only override. Explicit loading styles remain
separate. Activity History and CSV import app checks pass, including pagination.
The 1.0.28 Windows Setup installer is built; extracted-source and packaged
Chromium/Firefox checks pass. Extension 0.6.1 is unchanged.

Desktop 1.0.29 adds a floating Back to top arrow to the vault workspace after
scrolling 320 pixels. It uses the dashboard icon hover effect and a tooltip above
the button, returns focus to the search field, and respects reduced-motion
preferences. It is hidden near the top, during open modals and on locked screens.
Light/dark previews and scroll, focus, modal, lock and reduced-motion behavior
were checked in an isolated dummy vault. Existing app integration checks pass.
The 1.0.29 Windows Setup installer is built; extracted-source and packaged
Chromium/Firefox checks pass. Extension 0.6.1 is unchanged.

Desktop 1.0.30 adds Coffee under Settings > General > Appearance alongside Light,
Dark and System. It layers an espresso/cream/caramel palette over dark component
styles, with theme-aware highlights and readable text on accent-filled controls.
Saved custom accents are retained; Accent Color > Reset restores Coffee's caramel.
Theme changes persist immediately and theme buttons expose their pressed state.
Dashboard, Settings, Add Credential and unlock previews were inspected, including
narrow layouts and large text. Reload persistence, custom accent preview/cancel/
save/reset and System theme changes were checked with isolated dummy data.
Existing app integration checks pass. The 1.0.30 Windows Setup installer is built;
extracted-source and packaged Chromium/Firefox checks pass. Extension 0.6.1 is unchanged.

Desktop 1.0.31 groups the unlock help links in a centered stack: Forgot password,
then Show password hint, with compact spacing. The group also handles vaults with
only one of these options. Hint text stays hidden until requested, and the toggle
identifies its controlled hint element. Compact Coffee and large-text layouts,
hint reveal/hide and recovery navigation were checked with dummy data. Existing
hint and desktop tray/unlock checks pass. The 1.0.31 Windows Setup installer is
built; extracted-source and packaged Chromium/Firefox checks pass. Extension 0.6.1
is unchanged.

Desktop 1.0.37 adds credential selection and reviewed bulk group moves. The
toolbar reveals row checkboxes and Select all shown (maximum 500); selection
clears on refresh, filter changes and lock. The destination must be an existing
group or Ungrouped. Preview and confirmation are bound to the selected records,
destination, active group and unlock session. Only group assignment and updated
time change, preserving other fields and password history; normal Updated
activity events record changes. One encrypted save publishes the batch.
Synthetic unit and Electron tests cover scope, stale reviews, failed persistence,
field/QR/history preservation, select-shown, cancel, keyboard and lock behavior.
The Setup installer is built. Packaged bulk-move UI, Chromium/Firefox helper,
existing app integration and all 87 request-boundary checks pass. No production
vault or account data is used. Extension 0.6.1 is unchanged.

Desktop 1.0.38 extends selection with reviewed bulk category changes and Find
logins in the selection bar. Find filters the current dashboard results locally
and retains selected IDs across terms, reporting hidden selections. Select shown
affects only matching rows; both reviews include hidden selected entries.
Category changes preserve groups and other credential fields, skip no-ops,
record Updated activity and save atomically. Review signatures bind the action
type, selected records, destination, active group and unlock session. Synthetic
tests cover category changes and failed writes, retained search selections,
review/cancel, category filtering, existing group moves and lock behavior.
The 1.0.38 Setup installer is built; packaged UI, Chromium/Firefox helper,
existing app integration and all 89 desktop request-boundary checks pass.
Production accounts are never used for development or tests.

Desktop 1.0.39 adds session-only Undo for the latest successful bulk group or
category change. A persistent notification offers Undo and Dismiss. The desktop
retains assignment metadata and keyed post-change fingerprints, never full
credential copies. Undo verifies affected rows, their latest activity IDs and
original group/category identities before one atomic save. Later edits, deleted
records, changed original destinations and replayed/expired tokens are rejected.
No-op rows are excluded; an all-no-op batch clears the previous Undo. Lock/new
session clears the record, and the renderer clears the notification on lock.
Synthetic tests cover group/category restores, field/history preservation,
activity, failure/retry, stale/replay/deletion/catalog guards and UI filter refresh.
The 1.0.39 Setup installer is built. Packaged Undo UI, Chromium/Firefox helper,
existing app integration and all 90 desktop request-boundary checks pass using
synthetic accounts only.

The browser companion uses an independent phase sequence. Connection, pairing,
website matching, and filling are phases 1-4. Phase 5 adds manually requested saving
and password updates with confirmation in the desktop app. See
[Browser extension](browser-extension.md) for current status, setup, and verification.
