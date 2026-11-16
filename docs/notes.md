# General Notes

Desktop 1.0.57 adds **Notes** under **Workspaces**, separate from the notes field
on individual credentials. The workspace is available while the vault is unlocked.
Workspace buttons remain visible in compact windows.

- Use **Add note** (+) to enter a title and plain text, then **Save note**.
- Select a note to read it. **Edit note** opens its editor; **Cancel** discards
  edits after confirmation if text changed. Changing workspace or selecting
  another note also asks before discarding unsaved edits.
- Search titles and text, filter Favorites, or sort by update time or title.
  Results use pages of 50 notes. Search and filters preserve an open draft.
- **Delete note** asks for confirmation and permanently removes that note.
  General notes do not use credential Recently Deleted or password history.
- Locking clears the Notes view and discards unsaved edits without delaying the
  lock. Always save changes you want to keep.

Notes are shared across this local vault's workspaces; credential group filters
do not hide notes. Titles are limited to 120 characters, bodies to 100,000, and
the vault to 10,000 notes. This first version has no attachments, rich text,
note history, cloud sync, or sharing.

## Storage and backups

Notes use the existing AES-256-GCM encrypted SQLite vault and its master
password. They are included in full **Encrypted Backup**, automatic encrypted
backups, and restore. **Verify & test backup** includes a note count. Older
backups without notes remain supported. Credential CSV/JSON exports do not
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
clipboard access blocked and browser registration replaced. It checks editing,
discard confirmation, safe text rendering, deletion, pagination, responsive
layouts, navigation and late responses after locking. It never opens an existing
user vault or browser profile.

1.0.57 is packaged for local testing only. See the [verified installer record](package-privacy.md#local-1057-installer).
