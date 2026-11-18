# Manual authenticator setup (desktop 1.0.67)

In Add/Edit Credential, choose **Enter setup key manually** under **2FA Authenticator**. The same controls are available in Client Vault.

1. Enter the site's authenticator setup secret, not its temporary verification code. The field starts masked; Show/Hide is available. Spaces and line breaks in grouped Base32 keys are accepted.
2. Defaults are SHA1, six digits and a 30-second interval. Advanced settings support SHA1/SHA256/SHA512, six or eight digits, and a 15–120 second integer interval. Match the site's settings; SLV cannot infer nonstandard settings from a bare secret.
3. Click **Use setup key**. SLV validates and converts the key to a PNG QR locally. Existing setups require **Replace setup** confirmation; **Keep existing** preserves the current setup. Image uploads also request confirmation when replacing a setup.
4. Save/Update the entry. Closing the editor without saving leaves the stored entry unchanged. The existing **Generate** action generates codes from the saved QR.

The QR uses a generic “Manual setup” label and contains the secret and selected TOTP parameters. The input is cleared after submission and on cancellation/close/lock. Late conversions cannot update a closed or replaced editor. An unapplied key, pending conversion or replacement decision prevents saving the entry silently without that setup.

## Storage and security

No database schema change is needed. The generated image uses the existing encrypted QR field, so the Has 2FA filter, Generate, encrypted backups, restore and JSON credential exports keep working. CSV continues to omit QR data. JSON exports contain the setup secret encoded in the QR and must be treated as sensitive plaintext exports. The browser extension receives neither the setup key nor authenticator codes.

Conversion runs in the main process through the existing trusted-window and unlocked-session IPC guard. Key input and parameters are bounded and validated with the same Base32 parser used by uploaded QR images. Invalid input produces a public error without echoing the secret. The temporary decoded key buffer is zeroed; JavaScript strings and runtime-managed copies cannot be guaranteed erased. Conversion does not contact the site or enable 2FA there; complete the site's verification step yourself.

The existing `qrcode` 1.5.4 dependency is now included at runtime for local conversion. Its runtime dependency paths are explicitly included in the package allowlist. No installer is produced by this implementation step; 1.0.66 remains the latest local Setup package until packaging is requested.

## Checks

- `npm run test:manual-authenticator`: grouped/lowercase keys, rejection of temporary codes and malformed input, advanced settings, RFC code, encrypted synthetic storage and backup/restore.
- `npm run test:manual-authenticator-app`: isolated Electron UI/IPC, locked requests, masking, explicit apply/save, image/key replacement confirmation, cancellation, saved Generate/list integration and late-response/lock cleanup.
- Existing authenticator vectors, worker cancellation, clipboard/session tests and IPC hardening checks.
- `node scripts/packaged-manual-authenticator-test.js`: shipped dependencies generate and decode a synthetic QR in the unpacked executable's Node mode, without starting the desktop or opening a vault.

The unpacked 1.0.67 build passed the source/resource and archive privacy gates
(127 outer files, 367 ASAR files) and Electron fuse checks. The packager relocated
six dependency packages; 54 code/license files were compared byte-for-byte with
their installed sources and six runtime manifests were checked before allowing
the relocated paths. `npm audit --omit=dev` reported zero vulnerabilities at the
time of this build. This is not a full security audit.

All vault tests use newly generated synthetic profiles. Real account data and browser profiles are not accessed.
