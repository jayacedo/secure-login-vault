# General Notes

Desktop 1.0.57 adds **Notes** under **Workspaces**, separate from the notes field
on individual credentials. The workspace is available while the vault is unlocked.
Workspace buttons remain visible in compact windows.

- Use **Add note** (+) to enter a title and plain text, then **Save note**.
- Select a note to read it. **Edit note** opens its editor; **Cancel** discards
  edits after confirmation if text changed. Changing workspace or selecting
  another note also asks before discarding unsaved edits.
- Since 1.0.62, selecting text in the reading pane and copying uses plain text.
  Line breaks are preserved; theme colors, fonts and backgrounds are not copied
  into email editors. Only the selected text is copied. These copies use the
  configured clipboard timeout and are cleared on lock if still unchanged.
- Search titles and text, filter Favorites, or sort by update time or title.
  Results use pages of 50 notes. Search and filters preserve an open draft.
  Since 1.0.77, matching letters, words and phrases are highlighted in result
  titles and visible previews, using the same theme-aware style as Vault search.
  Matching ignores case. Clearing search removes highlights; the reading pane
  and editor retain plain text.
- **Delete note** asks for confirmation and moves the note to **Recently Deleted**
  for 30 days (since 1.0.78). Use the trash icon next to Add note to switch views;
  use the back arrow to return to Notes. Search, favorites and pagination work there too.
  Select a deleted note to read it, restore it, or permanently delete it after a
  separate confirmation. Restore preserves its text, favorite and original dates.
  Deleted notes cannot be edited and are excluded from normal search and counts.
  Expired notes cannot be restored; cleanup runs after unlock, hourly while unlocked
  and on vault writes. Closed or locked apps defer cleanup.
  Notes deleted permanently in older versions cannot be recovered by this feature.
- Locking clears the Notes view and discards unsaved edits without delaying the
  lock. Always save changes you want to keep.

Notes are shared across this local vault's workspaces; credential group filters
do not hide notes. Titles are limited to 120 characters, bodies to 100,000, and
the vault to 10,000 notes including Recently Deleted. Notes have no attachments,
rich text, edit history, cloud sync, or sharing.

## Storage and backups

Notes use the existing AES-256-GCM encrypted SQLite vault and its master
password. They are included in full **Encrypted Backup**, automatic encrypted
backups, and restore, including Recently Deleted notes and their original expiry
dates. **Verify & test backup** reports active and deleted notes separately.
Existing backups retain snapshots even after a note is permanently deleted.
Avoid downgrading below 1.0.78 after using Notes recovery: older versions do not
understand deleted-note status. Older backups without notes remain supported.
Credential CSV/JSON exports do not
include this workspace.

No note content is written to renderer local/session storage or Activity
History, and the browser extension cannot request notes. IPC uses the main
window's sender guard and unlocked-session checks. Mutations use the vault's
operation queue, lock cancellation, and revision checks to reject stale writes.
Plain text is displayed as text, never interpreted as HTML. JavaScript strings
cannot be guaranteed erased from runtime-managed memory.

## Validation

`npm run test:notes` creates fresh synthetic vaults and checks CRUD, input bounds,
search, favorites, paging, stale updates, encryption, lock cancellation, and
old/new encrypted backup compatibility.

`npm run test:notes-app` uses a fresh isolated Electron profile with real
clipboard mocked in memory and browser registration replaced. It checks plain-text
selection copying, partial selections, preserved line breaks, lock cleanup, editing,
discard confirmation, safe text rendering, search highlighting (including literal
punctuation and HTML-like text), deletion, pagination, responsive
layouts, navigation, recovery, permanent-delete confirmation and late responses
after locking. Service checks also cover legacy schema upgrades, retention expiry,
restore/delete races, stale revisions and deleted-note backup round trips.
It never opens an existing user vault or browser profile.

1.0.58 is packaged for local testing only. See the [verified installer record](package-privacy.md#local-1058-installer).
