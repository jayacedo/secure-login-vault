# Plaintext export protection (desktop 1.0.66)

CSV and JSON exports require a fresh master-password confirmation in Settings > Backup & Data. The dialog warns that the file contains unencrypted passwords and includes all active credentials, regardless of the current group or filter. JSON also carries saved QR data. General Notes, Clients, Trash and password history are not credential exports.

The main process verifies the password using the existing persistent failed-attempt protection shared with unlocking. Verification does not start a new session or rewrite the encrypted vault. It clears the temporary derived key. The renderer clears its password field immediately after submission, on error and on close; JavaScript strings cannot be guaranteed erased from runtime-managed memory.

After verification, main issues a random in-memory approval with a two-minute monotonic deadline. It binds approval to the current vault epoch, CSV or JSON, and the native save dialog's selected path. Writing consumes it once, before loading credentials. Main generates the file content; renderer-supplied content is ignored. Approval is rechecked before staging and publication. Failed or cancelled staging is removed through the existing atomic-export cleanup.

Cancel, lock, renderer loss, shutdown, restoration and master-password changes invalidate approval. Expiry includes time spent choosing the destination. A new attempt needs a new password confirmation. A publication already committing to disk may finish; cancellation is not a secure deletion mechanism for previously exported files.

Manual encrypted backups use a separate destination grant. Automatic encrypted backups keep their existing schedule and do not require this prompt.

## Scope

This prevents the normal CSV/JSON export flow from proceeding just because the desktop was left unlocked. It is not protection against a compromised renderer, browser or operating system: other authorized credential-viewing APIs still exist. Once exported, plaintext files are outside vault encryption. This change does not remove existing exports or claim secure deletion.

## Verification

- `npm run test:export-protection`: format/path/session binding, expiry, one-use approval, cancellation and concurrency; persisted password cooldown shared with unlock; unchanged synthetic vault.
- `npm run test:export-protection-app`: real Electron IPC with newly generated synthetic data, mocked clipboard and file dialogs; bypass/replay rejection, CSV/JSON fidelity, backup separation, cancellation and lock races, warning and password-field cleanup.
- `npm run test:hardening-app`: sender isolation, late read/dialog rejection and removal of staged plaintext after lock.

Tests use fresh workspace `.tmp` profiles. They never discover or read installed vaults, real account data, browser profiles or the real clipboard.
