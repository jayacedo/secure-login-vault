# Delete a group and reassign its credentials

Desktop 1.0.65 adds a destination picker to Manage Groups > Delete.

- For an occupied group, explicitly choose an existing group or **Unassigned
  (no group)**. Nothing is selected automatically.
- **Move & delete group** moves every current credential in the source group
  before removing that group, in a single atomic encrypted-file write.
- The credential content, password history, category, favorites and QR image are
  preserved. Only group assignment and update time change.
- Deleting the active group selects the destination as active. Choosing
  Unassigned clears the active filter. Other active-group selections stay intact.
- Empty groups need only confirmation. Even the last group can be removed;
  credentials may be Unassigned. Category deletion still requires a replacement
  category for occupied categories, and at least one category must remain.

The main process checks destination existence, refuses the source as destination,
and rechecks the displayed credential count before writing. A changed count or
deleted destination requires another review. Invalid choices, save failures and
locks before the final atomic write leave the original encrypted file intact.
Cancellation after an atomic write has started is not an undo of that write.

This acts on current credentials, not snapshots in Recently Deleted or backups.
Restoring a deleted credential retains its existing behavior of recreating its
original group/category if needed. Group deletion has no Undo button.

## Validation and delivery

- `npm run test:group-delete`: synthetic vault covering explicit destinations,
  case-insensitive names, invalid/stale choices, field/history preservation,
  active filters, empty/final groups, write failure and lock cancellation.
- `npm run test:group-delete-app`: isolated Electron profile with mocked
  clipboard/browser/file dialogs; selection, Cancel, reassignment, Unassigned,
  active filters, changed counts, and removal of group dialogs on lock.
- Existing synthetic Recently Deleted regression checks cover restoration after
  the original group was removed.

Real accounts, vaults, notes, backups and browser profiles are never accessed by
these tests. Version 1.0.65 is packaged for local testing only; see the
[installer verification record](package-privacy.md#local-1065-installer).
Extension 0.6.6 is unchanged.
