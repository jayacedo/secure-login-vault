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

The browser companion uses an independent phase sequence. Connection, pairing,
website matching, and filling are phases 1-4. Phase 5 adds manually requested saving
and password updates with confirmation in the desktop app. See
[Browser extension](browser-extension.md) for current status, setup, and verification.
