# Import and restore hardening

Desktop 1.0.63, 2026-11-18. Initially built unpacked; included in the verified
local 1.0.64 installer. Extension 0.6.6 is unchanged by this phase.

## File and import limits

- CSV, KeePass CSV and JSON input files: at most 16 MB (16 MiB).
- At most 5,000 credential rows per import. CSV allows a header plus 5,000
  rows, at most 32 columns, and 100,000 characters in a cell. Blank CSV rows
  also count toward the parsing limit. Split larger files before importing.
- Normalized imported data is also limited to 16 MB. Main-process validation
  applies even if the renderer preview is bypassed.
- Text limits per imported credential: website name 500; login URL 4,096;
  username/email 1,024; password 4,096; group/category 200; tags 4,000;
  notes 100,000; optional QR data 12 MiB of characters. Password whitespace
  is preserved. Unsupported fields/types are refused at the batch boundary.
- Restore now uses the same 256 MB (256 MiB) file limit as backup verification.
  An oversized backup is rejected; it is not truncated or replaced. Do not
  discard it: a larger recovery path would need separate review.

Reads use one open handle, check that it is a regular file and within the size
limit before allocating, read in bounded chunks, and check EOF and file metadata
again. Growth, shrinkage or a detected rewrite aborts the operation. Session
cancellation is checked between chunks and before returning data. Temporary byte
buffers are wiped on failure and after text conversion; JavaScript strings are
still runtime-managed and cannot be reliably erased.

## Import writes

CSV preview keeps its existing invalid-row and duplicate choices. JSON and
KeePass parsing rejects malformed rows rather than silently dropping them before
Replace. KeePass uses the same strict quoted-field parser as ordinary CSV.

Both import flows now send the confirmed rows in one guarded IPC request. The
main process validates the entire batch before opening the working database.
Replace derives its target groups from the validated rows and the current group;
the preview records the active group and refuses a changed group at commit time.
Other groups are untouched. Displaced entries still go to Recently Deleted.

All inserts and Replace's trash moves happen in the same in-memory database
copy. The encrypted file is written once, after every row succeeds. Validation
errors, staging failures and locks before the final write leave the original
encrypted file unchanged. If the final atomic replacement has already begun,
it finishes consistently; cancellation is not an undo of a committed import.

Restore still authenticates the password and validates the decrypted database
before replacing files, using the existing rollback/recovery protection. This
phase does not change the backup format or read existing personal data.

## Verification

All tests create synthetic data under project `.tmp`. No installed user profile,
real vault, notes, backups, browser profile or OS clipboard is accessed. The
Electron import test redirects its profile paths and uses mocked clipboard,
browser registration and file dialogs that return only generated test files.

- `npm run test:import-hardening`: bounded/oversized/changing reads; cancellation;
  row, column, byte and field limits; failed and interrupted batch/restore byte
  preservation; successful Replace, untouched groups, Trash and backup restore.
- `npm run test:csv-import` and `npm run test:csv-import-app`: CSV mapping, exact
  passwords, JSON/KeePass validation, oversized file refusal, main-process batch
  rejection, preview/cancel, duplicates, group changes and responsive UI.
- `npm run test:backup-check`: verification, damaged backups, old password,
  concurrency, cancellation, timeouts and temporary-copy cleanup.
- `npm run test:hardening`, `npm run test:safety` and `npm run test:ipc`: session
  races, restore rollback/recovery, data safety and trusted IPC boundaries.

The unpacked build runs the source/resource allowlist and packaged-content gates.
Only `src/shared/importPolicy.js` was added to the reviewed application allowlist.
These bounds reduce resource exhaustion; they do not prove all allowed-size
inputs cheap to parse or provide a complete independent security audit.
