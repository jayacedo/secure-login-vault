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

Phase 12 will add Windows packaging and installer verification.

## Browser extension phases

The browser companion uses an independent phase sequence. Connection, pairing,
website matching, and filling are phases 1-4. Phase 5 adds manually requested saving
and password updates with confirmation in the desktop app. See
[Browser extension](browser-extension.md) for current status, setup, and verification.
