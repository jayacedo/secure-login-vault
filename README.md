# Secure Login Vault

A Windows desktop vault for managing passwords and web development client details locally, with an optional Chrome, Edge and Firefox companion extension.

SLV stores vault data in an encrypted SQLite database. The browser extension connects to the running desktop app to fill logins and offer to save new or changed credentials. The app-to-extension connection uses encrypted, authenticated messages; no cloud service is involved in that handoff.

**Current source versions:** desktop **1.0.47**, extension **0.6.2**. This release supports saving from separate username/password steps: a selected Google account can be recognized, and the extension asks for a missing username instead of blocking Save. Reload Chrome/Edge's unpacked extension. Firefox needs the new Mozilla-signed 0.6.2 XPI; updating the desktop alone does not update an installed Firefox add-on.

**Available in 1.0.26:** Settings > General adds opt-in Windows startup
and system tray controls. Sign-in can start SLV quietly, locked in the tray.
Opening the tray icon shows a compact unlock window; entering the master password
opens the dashboard. Cancel returns to the tray still locked. Close to tray locks
immediately, and the tray menu includes Open SLV, Lock Vault and Quit. Start with
Windows requires an installed Windows build; these settings default to off.

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
- Select multiple credentials and move them to an existing group or Ungrouped after reviewing the list.
- Change the category of selected credentials after review, preserving groups and login details.
- Generate passwords with configurable length and character options.
- Copy credentials with configurable password clipboard clearing.
- Use auto-lock, change the master password and configure a recovery key.
- Import CSV, JSON and KeePass CSV; export CSV/JSON or create an encrypted backup.
  Starting with desktop 1.0.24, standard CSV imports
  accept `Website, Login URL, Username, Password, Group, Category`, with older
  `Website Name` and `Website URL` headers also supported. A masked preview shows
  the mapping, blank-field defaults, invalid rows and possible duplicates before
  confirmation. Possible duplicates are skipped by default; existing entries are
  unchanged. Add/Edit Credential and CSV exports now call the address "Login URL".

### View credential details

Click a website name to open its details panel on the right. Copy the Login URL,
username or email, see Group and Category together, and read notes and tags.
Use **Edit** when you want to change the saved entry.

- The initial details request excludes passwords and QR image bytes. Password
  **Reveal** and **Copy** fetch the current entry only after the action is clicked.
  Reveal hides again after 30 seconds or when SLV loses focus. Copy uses the
  existing sensitive clipboard-clearing preference.
- **Generate code** uses the existing authenticator flow when a QR image is saved.
  **Password history** starts collapsed and loads previous passwords on demand,
  masked by default. It offers Show and Copy; changing a saved password still
  requires Edit. Merely viewing details does not change the entry or its history.
- Close or Escape returns focus to the website name. Closing, locking, hiding the
  app or refreshing the list clears the panel; late requests cannot reopen it.
  Losing focus also clears revealed password/history content. Group scoping and
  the current unlocked session apply to all reads.

Validation: `npm run test:details-app`, with synthetic entries, a dummy QR and a
mocked clipboard. No real account or clipboard contents are read by this test.

### Quick filters

The credential list scrolls inside the dashboard, keeping search, filters and
bulk controls visible. Column headings stay at the top of the list. Back to top
returns the list to its first entry and focuses search. The list is keyboard
focusable, toolbar controls wrap in smaller windows, and Actions opens upward
when there is not enough room below. Client Vault and unlock retain their own
layouts. Validation: `npm run test:dashboard-layout-app`, using synthetic entries
at wide, compact and minimum window sizes, including large text and light/Coffee
themes. No real accounts are used.

Use the menu beside sorting to show **Has 2FA**, **No login URL**, or
**Uncategorized**. Has 2FA means a QR image is saved; it does not verify that
the site has 2FA enabled or that the QR is a supported authenticator setup.
Uncategorized includes the default **Other** category and blank categories.
No login URL matches empty addresses, not invalid or unreachable sites.

Quick filters narrow your current search, Favorites, category and active group.
The count shows matching entries out of those current results. **Clear filter**
returns to All logins while keeping those other choices. Sorting and the details
panel work with the filtered list. Changing a quick filter clears bulk selection;
Find logins still preserves selections within the chosen filter. Refresh retains
the quick filter during the unlock session; locking or restarting resets it.
Filtering does not change entries or record activity. Tests use synthetic vaults.

Validation: `npm run test:filters-app` checks filter combinations, counts, empty
states, selection, sorting, details, refresh, lock reset and unchanged entries.

### Sort credentials

Click the **Website** or **Username** column heading to toggle A–Z and Z–A.
The sort menu beside the item count also offers **Recently added** and
**Recently updated**, both newest first. Recently updated is the default.
The chosen order is remembered on this device across locks and restarts.

Sorting applies to the current dashboard results, including search, category,
group and Favorites filters. Bulk selections and the Find logins search stay
intact when sorting. Username uses the displayed email fallback when needed;
blank usernames stay last. Names sort without case distinctions and with natural
number ordering, such as Site 2 before Site 10. Sorting does not edit credentials,
timestamps or activity history. Only the sort option is saved as a local preference.

Validation: `npm run test:sort-app`, using a new synthetic vault only.

### Move selected credentials to a group

The selection bar groups **Move to group**, **Change category**, **Add to
Favorites** and **Remove from Favorites** in the **Actions** menu. It stays
disabled until entries are selected. Find logins, Show selected and Cancel remain
directly accessible. Use Tab/arrows to navigate the menu and Escape to close it.

For bulk Favorites, review the selected names and changed/unchanged counts, then
confirm. Existing matching Favorites states are skipped. Only Favorites status
and update time change, and Updated activity is recorded. **Undo** restores the
previous flags for changed entries only; the same latest-action, unlock-session
and stale-entry protections used for group/category Undo apply. Removing items
from the Favorites view hides them; Undo refreshes that view. A successful no-op
replaces the previous Undo opportunity. Tests: `npm run test:bulk-favorites` and
`npm run test:bulk-favorites-app`, using synthetic vaults only.

**Show selected** in the selection bar displays all selected entries together,
including those hidden by Find logins. It pauses that search without deleting the
search text; turning it off restores your search. Sorting still applies. Uncheck
an entry to remove it from the selection and view. If none remain, turn off Show
selected to choose more entries. Keyboard focus moves to the next remaining
checkbox or back to the toggle. The header checkbox can clear the shown selection.

The existing group, category and quick-filter boundaries still apply. Cancel,
dashboard filter changes, refresh and lock reset the selection and toggle.
Group/category review uses exactly the remaining selected IDs. Merely selecting,
reviewing or cancelling does not edit entries. Validation:
`npm run test:show-selected-app`, using an isolated synthetic vault only.

Choose the **Select credentials** checkbox icon in the Credentials toolbar. Select
individual rows or use the header checkbox to select all shown entries (up to 500).
Choose **Actions > Move to group**, select an existing destination or **Ungrouped**, then
**Review move** and **Confirm move**. Create new groups in Settings > Organization.

- Only the group assignment and update timestamp change. Passwords, notes, tags,
  categories, favorites, QR images and password history stay intact. Entries are
  not merged or deleted. Each changed entry records an Updated activity event.
- Entries already in the destination are skipped. Moves are saved together;
  changed entries, a changed active group or a new unlock session invalidate an
  earlier review. Review again before applying.
- **Find logins** in the selection bar searches names, URLs, usernames, email and
  groups within the current dashboard results. Select entries, search again and
  keep selecting; earlier selections remain. The count shows how many selected
  entries are hidden. The header checkbox affects only matching rows. Clear this
  search to see all current results again; review includes every selected entry.
- Refreshing, changing the main dashboard search/filters or locking clears
  selection. Entries moved out of the active group disappear from that
  filtered view; use Show all or select the destination group to see them.

Validation uses new synthetic vaults only: `npm run test:bulk-move` and
`npm run test:bulk-move-app`.

### Change category for selected credentials

Use the same selection bar and choose **Change category**. Choose an existing
category, then **Review changes** and **Confirm changes**. The review shows each
selected login and its current category, including entries hidden by Find logins.
Create new categories in Settings > Organization first.

Only category and update time change. Groups, login details, QR images and
password history stay intact; already assigned entries are skipped. Changes
are saved as one batch and recorded as Updated activity events. A changed entry,
destination, active group or unlock session requires another review. Entries
outside the current category filter disappear from that filtered view after
applying; choose All categories to see them again.

Validation: `npm run test:bulk-category` and `npm run test:bulk-move-app`, using
synthetic vaults only.

### Undo a bulk group or category change

After applying, choose **Undo** in the notification to restore the previous
assignments. The notification stays until dismissed, replaced by another bulk
action, or the vault locks. Undo supports only the latest successful bulk action
in the current unlocked session; even an all-already-assigned batch clears the
previous Undo. Closing SLV, locking or restarting ends its availability. There is
no undo stack or redo, and this does not undo individual edits, imports or deletions.

- Undo restores only assignments actually changed by that batch. It leaves login
  details, QR images and password history intact and records Updated activity
  events with a new update time. Changing a dashboard filter does not prevent Undo.
- If any affected entry was edited or deleted, or an original group/category was
  renamed or removed, the whole Undo is rejected without overwriting later work.
  Edits to unrelated entries do not block it. A failed save changes nothing and
  can be retried while Undo remains available.
- The temporary record stays in desktop memory and contains only assignment
  metadata and keyed fingerprints, not passwords, QR images or full credential
  copies. It is not included in exports or backups.

Validation: `npm run test:bulk-undo` and `npm run test:bulk-move-app`, using only
new synthetic vaults.

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

### Verify a backup without replacing the current vault

In **Settings > Backup & Data**, click **Verify latest automatic backup** to select the newest successful automatic backup recorded by this installation, or **Choose another backup** to pick a `.slvbackup` file yourself. Enter the master password used when it was created. SLV takes an encrypted snapshot, runs the real restore and unlock flow in a separate temporary vault, and checks SQLite integrity, references and essential schema fields. The result shows record counts and the backup creation date; saved passwords are never displayed.

The latest-backup button is disabled until an automatic backup is recorded. It still works for existing backups when scheduling is off. If the latest file or its drive is unavailable, SLV explains the problem rather than selecting an older copy. This action authorizes a backup check only; it does not restore over the current vault or create a new backup.

The current vault and source backup are not modified. Temporary files remain encrypted and are removed before success is reported. Closing the check or locking SLV stops it; leftover rehearsal folders after an unexpected exit are cleaned on next startup. Checks run in a worker, allow files up to 256 MB, and time out after 60 seconds. A passing check applies to that snapshot at check time; it does not validate website logins, QR codes or the future reliability of the storage device.

Since **1.0.33**, **Last backup check** keeps the latest completed check across restarts. The local settings record contains only its filename, Passed/Failed result, check date and verified backup creation date; it does not store passwords, account data, record counts or full paths. Cancelled checks leave the prior result intact. A wrong backup password can produce Failed without indicating a damaged file. Existing 1.0.32 checks cannot be reconstructed; run a new check to start the summary.

When Settings refreshes, SLV compares the checked backup's creation date with the latest automatic backup recorded by this installation. A newer automatic backup gets a reminder to verify that copy. This is a historical summary, not continuous file monitoring: manual backups elsewhere, moved/deleted files and later file changes are not scanned. The summary is local to this installation and is not part of encrypted vault backups.

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
| `Secure Login Vault Setup 1.0.36.exe` | Installed desktop app, with browser-extension setup support |
| `Secure Login Vault 1.0.36.exe` | Optional portable build; browser-helper setup is unavailable |

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

After an extension update, reload it on the browser's extensions page and refresh open login pages. Desktop 1.0.36 bundles extension 0.6.1 for the inline logo button; the encrypted transport is unchanged and existing 0.6.0 remains compatible. Incompatible protocol versions do not fall back to plaintext communication.

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
npm.cmd run test:backup-check
npm.cmd run test:backup-check-app
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
