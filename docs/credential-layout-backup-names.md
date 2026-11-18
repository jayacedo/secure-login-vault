# Credential layout and readable backup names

Source 1.0.71 reorganizes Add/Edit Credential around the everyday fields. Website
Name and Login URL span the form. Username/Email and Group/Category share rows.
Generate beside Password opens the generator on demand; Use fills the password
and closes the generator without changing its reveal state. Options and generated
drafts survive collapse. No password is generated just by opening the form.

Two-factor authentication and Notes & tags are collapsed for new entries. Editing
an entry opens the sections with saved QR/setup data, notes or tags. Collapsing
does not discard values. An unapplied manual setup blocks Save and reopens the
2FA section. Password history remains available in Edit. Cancel and lock clear
the draft through the existing modal cleanup. The footer remains visible while
the form body scrolls when necessary.

## New automatic backup names

New files use this shape:

```text
slv-auto-2026-11-19_14-30-05.123_UTC+0800-<installation-id>-<random-id>.slvbackup
```

The leading date/time is local to the computer at creation, in 24-hour format.
Milliseconds and the explicit UTC offset preserve the precise instant, including
across timezone changes. The installation ID and random suffix remain in place
for ownership checks and uniqueness. Windows-invalid filename characters are
avoided. Backup encryption and contents are unchanged.

Existing backup files are not renamed. Both the previous numeric-timestamp names
and the new names work with latest-backup verification and normal retention.
Retention still deletes only recorded backups owned by this installation, after
a successful new backup; manual backups and other installations' files are kept.
No existing backup directory is inspected or modified during development/testing.

## Validation

- `test:credential-form-layout-app`: fresh synthetic vault, complete save/edit,
  generator draft/use, collapsed-value preservation, pending setup guard,
  cancellation/lock cleanup, themes and minimum-window footer visibility.
- `test:manual-authenticator-app`: manual setup, replacement and late-response
  guards in the reorganized form, using dummy setup keys only.
- `test:backup-names`: legacy/current filename parsing, explicit offset and
  millisecond preservation, same-instant uniqueness and mixed-format retention.
- `test:auto-backups`: encrypted synthetic backups, actual restore, retention,
  failure preservation and locked-vault behavior.
- `test:auto-backups-app`: isolated Settings folder selection, enabling,
  Backup now, persistence and locked guards.

The 1.0.71 installer is packaged and verified for local testing only; see the
[package record](package-privacy.md#local-1071-installer).
