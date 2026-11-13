# Secure Login Vault

A Windows desktop vault for managing passwords and web development client details locally, with an optional Chrome, Edge and Firefox companion extension.

SLV stores vault data in an encrypted SQLite database. The browser extension connects to the running desktop app to fill logins and offer to save new or changed credentials. The app-to-extension connection uses encrypted, authenticated messages; no cloud service is involved in that handoff.

**Current source versions:** desktop **1.0.23**, extension **0.6.1**. The credential table now shows **Website, Username, Password, 2FA and Manage**. Group badges appear beneath website details; categories remain saved and available in Edit, search and filters. Your installed Chrome/Edge and signed Firefox 0.6.1 extensions need no update.

Settings now uses six sections: **General**, **Security**, **Browsers**, **Organization**,
**Backup & Data**, and **About**. Browser pairings appear together under **Browsers**;
installation instructions are tucked into **Installation & troubleshooting**.
The window remembers the last section during the app session and supports arrow-key navigation.

Since desktop **1.0.7**, saving a new login from either browser opens one confirmation
with **Group** and **Category** choices. It defaults to the active group and **Other**
(or the first available category), and supports **Unassigned**. Password updates
keep the existing entry's organization.

[Windows setup](#windows-setup) | [Browser extension](#browser-extension) | [Security](#security) | [Development](#development) | [Documentation](#documentation)

## Local hardening in desktop 1.0.16

- Desktop requests must come from the main app window's expected document and main frame. Vault actions also require the current unlocked session.
- Saves, backups, password changes, recovery and restore share a vault-operation queue. A second desktop process cannot open the same profile as another writer.
- Locking cancels queued work, withholds late results and clears file-picker permissions. A file replacement already committing finishes or rolls back to keep authentication and encrypted data consistent; it does not reopen the vault.
- Restore decrypts and validates the database before replacing files. Failed first restores remove partial files. An interrupted replacement can recover the verified previous database when its authentication record still matches.
- Temporary key buffers and decrypted database buffers are cleared when their operation ends. JavaScript strings and runtime-managed memory cannot be guaranteed erased.

Run `npm run test:hardening` and `npm run test:hardening-app` for deterministic failure-case and Electron request-boundary checks. These are local protections, not cloud sync or an independent security audit.

## Features

### Credential vault

- Store website addresses, usernames, emails, passwords, notes and tags.
- Organize entries with categories, favorites and groups; search across credential fields.
- Generate passwords with configurable length and character options.
- Copy credentials with configurable password clipboard clearing.
- Use auto-lock, change the master password and configure a recovery key.
- Import CSV, JSON and KeePass CSV; export CSV/JSON or create an encrypted backup.
  In the development source (pending the next installer), standard CSV imports
  accept `Website, Login URL, Username, Password, Group, Category`, with older
  `Website Name` and `Website URL` headers also supported. A masked preview shows
  the mapping, blank-field defaults, invalid rows and possible duplicates before
  confirmation. Possible duplicates are skipped by default; existing entries are
  unchanged. Add/Edit Credential and CSV exports now call the address "Login URL".

### Authenticator codes from a setup QR

1. Edit a Credential or Client Vault entry and upload a clear image of its **authenticator setup QR** in **2FA QR Code**. Crop a sheet or screenshot to one QR first.
2. Save the entry to retain its QR. On the credential dashboard, choose **Generate** in its **2FA** column beside Password. Entries without a saved QR show **—**. In Client Vault, choose **Generate 2FA** on the client card; cards without a saved QR omit this action. Both editors also retain **Generate code** beside the thumbnail.
3. Use **Copy code** and paste it into the website's verification field. The view updates with a countdown; Copy generates the current code even at rollover. Check the first code against your existing authenticator before relying on it.

- This works offline with standard `otpauth://totp` setup QR images: SHA1/SHA256/SHA512, 6 or 8 digits and 15–120 second periods. Ordinary sign-in/approval links, HOTP, Steam codes and authenticator migration QR codes are unsupported. An unreadable sheet is rejected; always crop to one setup QR.
- SLV converts uploads to PNG. If an older imported image cannot be read, upload it again. The computer's clock must be correct. Uploading an image does not enable or change 2FA on the website.
- The QR image remains inside the encrypted vault and encrypted backups. **JSON credential exports include QR images and therefore their setup secrets; CSV exports omit them.** A setup QR can recreate the authenticator, so protect it like a password. Keeping password and authenticator together means vault access exposes both; a separate phone authenticator provides more separation.
- QR decoding runs in a worker with image, memory and time limits. The decoded key stays in main-process session memory, is cleared on close/lock/reload, and expires after five minutes. JavaScript/runtime memory cannot be guaranteed erased. No separate seed field or generated-code history is saved.
- The desktop view receives the current code and account label. The browser extension receives neither the setup key nor codes. Copy clears SLV's clipboard text at code expiry or after 30 seconds, preserving unrelated clipboard text. Closing the view leaves the copied code available until that timeout; locking clears it immediately.
- Credential rows and Client Vault cards receive only a saved-QR presence flag. Generate loads the selected entry's QR in the main process, respecting the unlocked session and, for credentials, the current group. Upload, replace and remove remain in Edit. A saved QR indicates availability, not that it has been validated as a supported authenticator setup; Generate reports unsupported images.

Validation: `npm run test:authenticator` (RFC 6238 vectors, QR validation, session and clipboard checks) and `npm run test:authenticator-app` (desktop workflow and lock checks).

### Activity History

Choose **Activity History** on the credential dashboard to review new changes from desktop 1.0.18 onward. It records login additions, edits (including password changes), moves to Recently Deleted, restores and confirmed permanent deletions. Bulk changes such as duplicate cleanup and Replace import also record affected credentials. No-op edits do not add events.

- Events contain only the credential ID, saved login name, saved group, action, desktop/browser source and time. Passwords, usernames, website URLs, notes, QR images and keys are not copied into history.
- Search by login name or group, filter by action/source, and page through 50 events at a time. The active group applies to the group saved with each event; renaming or moving a group does not rewrite older events.
- History is stored in the same encrypted vault and included in encrypted backups, but excluded from CSV/JSON credential exports and browser replies. Restoring a backup restores its history snapshot; it does not reconstruct changes since that backup.
- Events expire after 90 days. Expired events are hidden immediately; physical cleanup runs on vault writes, after unlock, and hourly while unlocked. Older encrypted backups retain their own snapshots.
- This records credential changes, not Client Vault actions, browser Fill, successful website sign-ins or failed authentication attempts. It is not a tamper-proof audit trail, and changes made using older app versions are not recorded.

Validation: `npm run test:activity` and `npm run test:activity-app`.

### Vault Health

Desktop **1.0.10** added **Check vault health** to the credential dashboard. It checks current passwords locally while the vault is unlocked. There is no paid service, network request, saved scan report or automatic password change.

- **Weak:** fewer than 12 Unicode characters, or one of the built-in common, repeating or sequential patterns. This is a limited heuristic, not a comprehensive strength estimate or breach check. No finding does not guarantee a strong password.
- **Reused:** the exact same non-empty password on more than one entry in the current scope. Comparisons are case-sensitive. Counts represent affected entries, so an entry can be both weak and reused.
- The active group filter applies to the entire scan, including reuse counts. Other groups, password history and the separate Client Vault are excluded.
- Results show entry names, usernames and reasons, without password values or fingerprints. Filter by issue, choose **Edit**, then return to a refreshed report after Save or Cancel. **Check again** refreshes the scan; browser saves refresh an open report too.

Change a password on the website first, then update its saved entry in SLV. Editing the vault does not change the website's password.

### Duplicate Login Review

Desktop **1.0.15** adds **Review duplicates** to the credential dashboard. It compares active entries locally using the exact website origin (scheme, hostname and port) and case-sensitive username, falling back to email when username is blank. Outer whitespace is ignored. Paths are ignored; invalid website addresses and blank identities are skipped. HTTP and HTTPS remain separate.

- Compare names, website paths, groups, categories, timestamps, favorites, tags and the presence of notes/QR images side by side. Differing passwords and different groups are flagged, without displaying password values. **Review / Edit** opens the normal credential editor and returns to a fresh report afterward.
- Nothing is selected automatically. Choose one login to keep, select **Review cleanup**, and confirm the listed copies to move to **Recently Deleted**. No fields or histories are merged; the kept entry remains unchanged and removed copies retain their own password history for 30 days.
- These are possible duplicates: different paths or groups may be intentional. Leave those matches alone. The active group applies to both review and cleanup; Trash and Client Vault are excluded.
- The complete matching set is rechecked before an atomic cleanup. Edited, added or deleted entries and scope changes require a new review. Failed writes leave the previous vault intact.

Help now covers browser setup, remembered/session-only pairing, inline fill, save offers, automatic backups, password history, Vault Health, Recently Deleted, duplicate review and appearance previews.

### Recently Deleted

Desktop **1.0.14** adds **Recently Deleted** beside **Check vault health** on the credential dashboard.

- Deleting a login moves its complete entry and password history into encrypted Trash for **30 days**. Replace-imports also retain the entries they displace. Deletions from before this update cannot be recovered here.
- Trashed logins are excluded from browser matching/fill, ordinary search, dashboard counts, Vault Health and CSV/JSON exports. Encrypted backups include Trash snapshots; their original expiry dates still apply after backup restoration.
- **Restore** brings back the entry, including password history, notes, tags, favorite status and QR image. Original group/category names are restored, recreating removed names if needed. Restoration does not merge other matching logins.
- The active group filter applies to the Trash list and its actions. Select all groups to see entries whose original group was removed or renamed.
- **Delete permanently** asks for confirmation. Expired entries cannot be restored; cleanup runs after unlock, hourly while unlocked, and on vault writes. When SLV is closed or locked, cleanup waits. Older backups retain their own snapshots; deletion does not erase those files.
- This version covers credential entries, not the separate Client Vault.

### Password history

Since desktop **1.0.9**, SLV keeps the latest **10 previous passwords per credential**, inside the encrypted vault. Desktop edits and approved browser password updates record the password being replaced. Unchanged passwords and edits to other fields add no history. Existing vaults upgrade automatically; past changes made before this feature cannot be recovered.

Open a credential for editing, expand **Password history**, and use **Show** to reveal an old password or **Use** to select it for the edit form. Click **Update Credential** to save that selection; **Cancel** discards it. This changes the saved vault entry, not the password on the website. The replaced current password is retained in history too.

History respects vault locking and the active group, is included in encrypted backups, and is excluded from ordinary CSV/JSON exports and browser login responses. Deleting a credential moves its history into Recently Deleted along with the entry for 30 days. Permanent deletion and expiry remove that retained copy; older backup files retain their snapshots. This first version covers credential entries, not the separate Client Vault fields.

### Automatic encrypted backups

Since desktop **1.0.8**, open **Settings > Backup & Data**, choose an **Automatic Backup Folder**, then turn **Automatic Backups** on. This creates the first backup immediately. No paid service or internet connection is required.

- Backups run once every 24 hours while SLV is open and unlocked. An overdue backup runs after the next unlock.
- Keep the latest **7** (default), **14**, or **30** automatic copies. Cleanup runs only after a successful backup and only removes tracked automatic copies from this installation; manual backups stay untouched.
- **Back up now** creates another copy when automatic backups are enabled. The last successful backup and any errors appear in Settings.
- Changing the automatic folder turns scheduling off until enabled again; copies in the old folder remain untouched. The manual backup folder is a separate setting.
- Restore a `.slvbackup` file with **Restore from Backup**, using the master password that applied when it was created. Restoring replaces the current vault. Credential data stays encrypted; the file also includes readable timestamps and password-verification metadata.

A folder on the same drive does not protect against that drive failing. Choose an existing separate drive or copy backups elsewhere when possible.

### Client workspace

Keep client infrastructure details in a separate workspace: WordPress, hosting, FTP/SFTP, databases and registrar information, plus domain/SSL expiry dates, notes, quick links and an optional 2FA QR image. Client entries have their own search, favorites and categories.

The credential vault's active group filter does **not** apply to the Client Vault.

### Appearance and settings

Desktop **1.0.12** adds **Settings > General > Appearance > Text size**: **Small**, **Default**, or **Large**. The main SLV window previews the size immediately, using the existing font. **Apply** saves the choice for future launches. Closing Settings, pressing Escape or locking discards an unapplied size. Choose Default and Apply to restore the original size. Native Windows dialogs and the browser extension keep their own text settings.

Since desktop **1.0.11**, accent colors preview live as you move the color picker. **Apply** saves the choice. Closing Settings (including Escape) or locking the vault discards an unapplied preview. **Reset** immediately restores the current theme's default accent.

Choose light, dark or system appearance, and customize the app name, logo and accent color. Branding changes the app's interface; the packaged Windows executable icon remains fixed at build time. Help and FAQ are available inside the app.

## Windows setup

Use a build produced from this source, or build it using the instructions below. Windows x64 builds are written to the local `release/` folder:

| File | Use |
| --- | --- |
| `Secure Login Vault Setup 1.0.23.exe` | Installed desktop app, with browser-extension setup support |
| `Secure Login Vault 1.0.23.exe` | Portable desktop app; browser-helper setup is unavailable |

1. Run the **Setup** installer and open SLV.
2. On first launch, create your vault and master password. On later launches, unlock the existing vault.
3. Add credentials, import existing entries through Settings, or connect the browser extension.

Installed users do not need Node.js, npm or the source repository. The current builds are unsigned. Automated packaged-app checks have passed; installation on a clean Windows machine and the full Chrome/Edge setup still need manual verification.

For updates, close SLV before running the newer Setup installer, then reload the browser extension. Keep an encrypted backup before updating or moving the vault.

## Browser extension

The Setup installer bundles Chrome/Edge and Firefox extensions plus the native helper. Loading an extension and pairing it are manual steps; installing SLV alone does not install the browser extension.

1. Open and unlock SLV, then use **Settings > Browsers > Installation & troubleshooting**. Setup registers the local helper and opens the bundled extension folder.
2. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, select **Load unpacked**, and choose that folder.
3. In SLV, choose **Add browser**. Paste the code into the extension popup and pair.
4. Keep SLV running and unlocked when filling or saving logins.

**Firefox:** use **Open Firefox Folder** in SLV Settings, then `about:debugging#/runtime/this-firefox` > **Load Temporary Add-on** > select `manifest.json`. Temporary installation lasts until Firefox restarts. A permanent add-on needs Mozilla signing; see the [Firefox setup and publishing guide](docs/firefox.md). Chrome, Edge and Firefox can stay paired together. Each browser uses its own secret; Settings lists paired browsers with individual **Unpair** controls.

After an extension update, reload it on the browser's extensions page and refresh open login pages. Desktop 1.0.23 bundles extension 0.6.1 for the inline logo button; the encrypted transport is unchanged and existing 0.6.0 remains compatible. Incompatible protocol versions do not fall back to plaintext communication.

### Fill, save and update

- **Fill:** open the extension on a login page, select a matching saved login and click **Fill**. SLV fills the fields without submitting the form. Manually added vault entries work too when their saved website address matches the page's origin.
- **Inline fill (optional):** enable **Inline fill suggestions** in the popup, approve website access, and reload open login pages. Focus a username or password field, click the small **SLV logo** button, then choose an account. It uses the same matching and desktop approval settings as popup Fill and never submits the form. No vault lookup happens until you click the logo. This first version supports ordinary top-level forms; embedded, shadow-DOM and form-less logins may need popup Fill or manual entry.
- **Manual save:** type the login details on the page, open the extension and click **Save this login**. Confirm Add or Update in SLV.
- **Automatic offers:** enable **Automatic save offers** in the extension popup, approve optional website access, and reload open login pages. Ordinary form submissions can trigger a Save or Update card. Unchanged saved logins stay quiet.
- **Dismissal:** use **Not now** or **Never for this site**. The extension settings let you allow offers on that site again.

Saving always requires desktop confirmation. Confirmation before filling is controlled by **Ask Before Filling** in SLV Settings. HTTPS is required for real websites; local test pages are an exception. Matching uses the exact scheme, hostname and port. Some embedded, form-less or multi-step login flows need manual handling.

See the [browser workflow and troubleshooting notes](docs/browser-extension.md) for development setup, limitations and verification details.

## Security

- Vault data is encrypted at rest with AES-256-GCM; password-based key derivation uses scrypt.
- The app and browser extension verify their pairing on each connection. Credential requests and replies use AES-256-GCM with separate directional session keys, message authentication and replay rejection.
- Locked vaults refuse credential access. The extension requests one selected login for its matching website when filling.
- Desktop pairing storage uses Windows protection through Electron's `safeStorage`. Browser pairing is remembered in the extension profile by default; **Pairing security > Keep pairing only for this browser session** offers memory-only browser storage instead.

Encryption protects stored vault data and the local app-to-extension transfer. Once a password is filled, the website can read its form fields. A compromised browser or computer remains a risk. **CSV and JSON exports contain unencrypted credentials**; use **Encrypted Backup** when you need an encrypted copy. Restoring a backup replaces the current vault contents.

Security and integration tests cover specific behaviors; this project has not undergone an independent security audit. Read the [security design, tests and remaining limits](docs/browser-security.md) before relying on it for sensitive credentials.

## Development

The app uses Electron, HTML, CSS and vanilla JavaScript, with SQLite provided by `sql.js`.

Use Windows with Git, npm and a Node.js version supported by the current dependencies, such as **Node.js 24.15.0 or later in the 24.x series**. These tools are needed for development and builds, not for running the installed app.

```powershell
git clone https://github.com/jayacedo/secure-login-vault.git
cd secure-login-vault
npm.cmd ci
npm.cmd start
```

The `.cmd` commands also work when PowerShell's execution policy blocks `npm.ps1`.

### Checks

Run syntax and shared-transport consistency checks:

```powershell
npm.cmd run check
```

Selected functional and security checks:

```powershell
npm.cmd run test:auth
npm.cmd run test:health
npm.cmd run test:health-app
npm.cmd run test:history
npm.cmd run test:trash
npm.cmd run test:trash-app
npm.cmd run test:duplicates
npm.cmd run test:duplicates-app
npm.cmd run test:history-app
npm.cmd run test:auto-backups
npm.cmd run test:auto-backups-app
npm.cmd run test:secure
npm.cmd run test:multi-pairing
npm.cmd run test:secure-browser
npm.cmd run test:offers
npm.cmd run test:e2e
npm.cmd run test:firefox
npm.cmd run test:firefox-browser
```

The Electron integration tests use temporary test data under `.tmp/`. The browser and security documentation describe test coverage and the manual checks that remain. Additional test scripts are listed in [package.json](package.json).

### Build Windows packages

```powershell
npm.cmd run dist -- --publish never
npm.cmd run test:packaged-browser
npm.cmd run test:packaged-firefox
```

The build creates the Setup installer and portable executable in `release/`. The packaged-browser test extracts the actual installer's files and checks its helper with dummy credentials and simulated registry writes; it does not run the installer wizard.

For only the Setup installer, use `npm.cmd run dist -- --win nsis --publish never`.
Firefox packaging also creates `dist/secure-login-vault-firefox-0.6.1.zip` for Mozilla signing.

After editing the shared transport implementation, regenerate its browser copy before checking or building:

```powershell
npm.cmd run extension:sync-secure
```

## Documentation

- [Browser setup, workflows and verification](docs/browser-extension.md)
- [Browser transport security and limitations](docs/browser-security.md)
- [Firefox setup, testing and signing](docs/firefox.md)
- [Implementation plan and development phase history](docs/implementation-plan.md)

## License

The project is currently marked `UNLICENSED` in [package.json](package.json).
