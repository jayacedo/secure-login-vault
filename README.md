# Secure Login Vault

Secure Login Vault is a Windows desktop application for storing and managing credentials — and, alongside that, a separate workspace for managing web development clients — entirely locally. The app is built with Electron, HTML, CSS, and vanilla JavaScript, backed by an encrypted SQLite vault with no plaintext credential logging.

## Current Phase

Phase 1 is complete: project initialization.

Phase 2 is complete: authentication.

The app now supports first-launch vault creation, returning-user login, show/hide password controls, live password matching, a password strength meter, bcrypt master-password hashing, encrypted SQLite vault initialization, Electron IPC auth handlers, form validation, error handling, and an in-memory unlocked session.

Phase 3 is complete: dashboard UI.

After unlock, the app now opens a desktop vault workspace with category navigation, favorites access, search field, add/settings actions, summary cards, credential list structure, empty state, and lock control.

Phase 4 is complete: database integration.

Dashboard categories, counts, and credential-list data are now read from the encrypted SQLite vault through main-process IPC after unlock.

Phase 5 is complete: credential management.

Credentials can be added, edited, deleted, favorited, categorized, and stored in the encrypted SQLite vault.

Phase 6 is complete: live search.

The dashboard can search credentials across website, URL, username, email, notes, tags, and category while preserving active filters.

Phase 7 is complete: password generator.

The credential modal includes configurable password generation with strength feedback and "use password" workflow.

Phase 8 is complete: clipboard management.

Username, password, email, and URL copy actions show toast feedback and copied passwords can auto-clear after the configured delay.

Phase 9 is complete: import, export, backup, and restore.

The settings modal supports CSV, JSON, KeePass CSV import, CSV/JSON export, encrypted backup creation, and encrypted restore.

Phase 10 is complete: settings.

Theme, auto-lock, clipboard clear timeout, backup folder preference, app info, and master-password change are available in settings.

Phase 11 is complete: UI polish.

Visual consistency, dark-mode coverage, focus states, responsive modal behavior, and phase documentation have been tightened.

Phase 12 (packaging) is configured but not yet verified.

Electron Builder is set up to produce an NSIS installer and a portable build for Windows x64 (`npm run dist`), but installer verification hasn't been signed off yet.

### Since Phase 11: Client Vault, Groups, and Branding

Development continued past the original phase plan to add a second workspace and some cross-cutting features. These aren't part of the numbered phase list above, but are fully built and in daily use:

**Client Vault** — a separate workspace from the credential dashboard, for web developers or agencies tracking their clients' sites. One record per client holds:

- WordPress admin URL, username, and password
- Hosting provider, hosting portal URL, username, and password
- FTP/SFTP host, port, username, and password
- Database host, name, username, and password, plus a phpMyAdmin URL
- Registrar, domain expiry date, and SSL expiry date
- Free-form notes
- Auto-generated Quick Links (e.g. a "WP Admin" button) built from whichever URLs are filled in
- An optional 2FA QR code image, stored for re-scanning onto a new device later
- Favorites and categories, with its own search across name, domain, and hosting provider

The Client Vault has its own summary stats (Total, Favorites, SSL Due) and is switched to from the sidebar Workspaces list, independent of the credential dashboard's categories/groups.

**Groups** — an axis independent of categories, answering "whose data is this" rather than "what kind of data is this." From Settings, the vault can be locked to one active group; credentials belonging to every other group are hidden from the list entirely (useful if a screen-recording or time-tracking tool might be capturing your screen). Groups can be added, renamed, and deleted from Settings, and the lock persists across restarts until cleared. This currently applies to the credential dashboard only — the Client Vault is intentionally independent of groups.

**White-Label Branding** — Settings > Branding lets a deployment rename the app, replace its logo, and recolor its accent, all applied instantly across the sidebar, login screen, About modal, and window title:

- **App Name** — replaces "Secure Login Vault" everywhere in the UI and in the OS window title bar
- **Logo** — a custom image replacing the default mark, auto-resized and kept transparent so it works on light and dark themes alike
- **Accent Color** — a single color pick that re-themes buttons, links, and highlights throughout the app

Branding is stored locally per install; it doesn't change the packaged app icon, which is still fixed at build time.

**Also included:** an in-app Help & FAQ modal, an About modal, and full category/group management (add, rename, delete, with credential reassignment) from Settings.

## Requirements

- Node.js LTS
- npm
- Electron dependencies installed with `npm install`

## Install

```powershell
npm install
```

If PowerShell blocks `npm.ps1` because of the local execution policy, use:

```powershell
npm.cmd install
```

## Run

```powershell
npm start
```

Execution-policy workaround:

```powershell
npm.cmd start
```

## Verify

```powershell
npm run check
```

Execution-policy workaround:

```powershell
npm.cmd run check
```

Run the authentication smoke test:
This also verifies encrypted SQLite dashboard reads.

```powershell
npm.cmd run test:auth
```

## Build Installer

```powershell
npm run dist
```

The Windows installer output will be written to `release/`.

## Development Phases

1. Project Initialization
2. Authentication
3. Dashboard UI
4. Database Integration
5. Credential Management
6. Live Search
7. Password Generator
8. Clipboard Management
9. Import / Export
10. Settings
11. UI Polish
12. Packaging

Client Vault, Groups, and White-Label Branding were added after Phase 11 and sit outside this numbered plan — see "Since Phase 11" above.

See `docs/implementation-plan.md` for the adapted product and workflow guidance.
