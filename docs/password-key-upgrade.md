# Password-key compatibility and upgrade

Status: 1.0.52 source and automated synthetic checks only; not packaged into an installer.
No existing installed vault, personal backup or browser profile was accessed.

## New records

New vaults, password changes and recovery resets write auth format version 2.
The encryption cipher remains AES-256-GCM. Scrypt uses `N=131072, r=8, p=1`, a
32-byte random salt and a 32-byte key. Its core memory cost is about 128 MiB per
derivation; the runtime memory ceiling is 192 MiB to leave space for overhead.
This follows the [OWASP scrypt guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
The extra CPU/memory is used while deriving a password key, not continuously.

Version 2 has no independent bcrypt hash. The app derives the key and verifies
the authenticated encrypted check value. A separate, cheaper password verifier
would otherwise let an offline attacker avoid scrypt for each guess.

## Existing vaults and backups

The reader accepts the version 1 format SLV previously wrote: bcrypt at cost 12
and scrypt `N=32768, r=8, p=1`. Missing options on early v1 records mean those
legacy defaults, never the new defaults. Stored settings are validated before
cryptographic work; only supported profiles, key lengths and salts are accepted.
File-controlled memory ceilings and excessive/unknown parameters cannot force
unbounded scrypt work. Version 2 requires the stronger profile.

On a successful v1 unlock, the app:

1. Verifies the password using the saved legacy settings and the encrypted check.
2. Verifies the encrypted database with its existing data key.
3. Derives a new wrapping key with a new salt and the stronger profile.
4. Wraps the existing data key and atomically replaces only the auth record.
5. Opens the unlocked session after successful commit.

The encrypted credential file is not re-encrypted for this upgrade. Existing
recovery-key wrapping is preserved, and the old bcrypt verifier is removed from
the new auth record. A failed auth-file replacement leaves the old auth and
database pair readable; a completed replacement leaves a valid new pair. Locking
during the operation never reopens a canceled session. Later unlocks do not
repeat the migration.

Restore supports both auth versions, including recovery-enabled backups. A
restored v1 vault upgrades on its next successful unlock. Backup verification does
that work in its temporary copy and leaves the source backup unchanged. Existing
backup files retain their original protection and are not rewritten or deleted.

## Compatibility limit

**SLV 1.0.51 and earlier cannot open v2 auth records or backups containing them.**
The version field makes older code reject the format rather than derive a wrong
key with its hard-coded settings. After upgrading, keep using the compatible new
app. There is no automatic downgrade feature. This source change is not yet
installed and does not migrate an installed user's vault by itself.

## Validation

`npm.cmd run test:kdf-compatibility` generates v1 fixtures independently of the
current vault factory, with direct keys, recovery wrappers and omitted options.
It checks old/new backups, a fresh-process unlock, preserved recovery keys,
unchanged encrypted database bytes, failed commits, cancellation, damaged-database
refusal and invalid/oversized KDF metadata. It also independently derives the new
key and checks the v2 encrypted verifier.

The existing authentication, cooldown, password change, recovery, backup
verification and lock/cancellation checks also run against newly generated data.
`npm.cmd run test:kdf-compatibility-app` checks legacy migration and subsequent
unlock through Electron's actual desktop IPC, using a generated profile and
blocked OS clipboard access.
These are compatibility and regression checks, not an independent cryptographic
security audit or protection against a compromised Windows account.
