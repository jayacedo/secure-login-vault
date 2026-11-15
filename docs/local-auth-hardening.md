# Local unlock and permission hardening

This change adds main-process unlock throttling and explicit Electron permission
policies. The subsequent [password-key upgrade](password-key-upgrade.md) handles
key derivation and auth-format compatibility separately. Neither change has been
packaged into an installer yet; Electron fuses are unchanged.

## Unlock attempts

The first two incorrect passwords allow an immediate retry. From the third failed
attempt, retry delays start at one second and double, capped at five minutes.
The unlock response reports the remaining wait. Correct passwords must also wait
for an active cooldown to end. Successful verification and vault opening reset it.

The store serializes requests and checks the cooldown before password verification. It
atomically reserves each attempt before password verification, so quitting during
an attempt or restarting cannot reset the counter. Interrupted attempts count
toward the limit. Empty input is rejected without consuming an attempt. A clock
rollback cannot create a deadline more than five minutes ahead of the new time.

The separate `vault/unlock-attempts.json` file contains only a format version,
attempt count and retry timestamp. It is local protection metadata, not part of an
exported backup. Existing vaults begin with no recorded attempts. Unreadable,
invalid or unwritable protection state prevents verification instead of silently
disabling the limit. The throttle itself does not rewrite auth records or credentials.

This limits guesses through the app. It cannot stop offline password guessing or
malware with the same user's ability to change the files, clock or application.
New and upgraded auth records use the stronger scrypt-only verification described
in the password-key upgrade. Recovery and backup-password validation are not
rate-limited by this unlock throttle.

## Electron permissions

Both permission checks and permission requests are handled explicitly before the
main page loads. The main session denies permissions except sanitized clipboard
writing from the exact main-window document. That narrow exception preserves
Copy buttons and their existing behavior. Clipboard reading, other windows,
subframes, navigated documents, unknown permissions and device access are denied.
Save-confirmation and embedded login sessions deny all permissions through the
same policy helper. Native main-process clipboard operations are separate from
renderer permissions and are unchanged.

## Validation

Only newly generated synthetic profiles and credentials are used:

- `npm.cmd run test:unlock-protection`: delay growth/cap, process restart,
  reset, queued calls, cancellation, clock rollback, failure to read/write state,
  and unchanged synthetic auth/database bytes.
- `npm.cmd run test:session-permissions`: trusted-document checks and default
  denial in both permission handlers.
- `npm.cmd run test:auth-permissions-app`: actual Electron permission query
  results, desktop unlock IPC and save-dialog policy. OS clipboard operations are
  blocked in the test; no real clipboard contents are read or overwritten.

Authentication, password-change/recovery, backup-verification and package privacy
checks also use generated data. No real vault, backup or browser profile is used.
