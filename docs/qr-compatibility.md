# QR compatibility (desktop source 1.0.69)

## Extra QR settings

A decoded QR with unrecognized extra query fields can now offer **Try standard
TOTP**. SLV validates the secret, algorithm, digits and interval first, then shows
those standard settings and the number of extra fields. No code is generated or
copied until the user explicitly chooses to try standard TOTP. Extra field names
and values are not returned to the UI or logged.

This is a compatibility choice, not a claim that every extra field is harmless.
Unknown fields could describe behavior SLV does not implement. Compare the result
with the site or an existing authenticator. The choice lasts only for the current
code view, expires with that view and does not modify the saved QR. Reopening
requires another choice. Locking, closing and session changes invalidate it.

The standard fields follow the [Key URI format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format).
Known code-generation extensions (`encoder`, `counter`, `type`), unsupported URI
types, malformed standard fields and conflicting repeated fields remain rejected;
the compatibility choice cannot bypass those checks. The parser remains strict
by default; the QR path opts into returning an extra-field count for confirmation.

The existing **Enter setup key manually** option is also available. Copy and paste
the long setup key supplied by the site, not a temporary six-digit code. It does
not extract printed text from screenshots. No real QR or setup key was inspected
to implement or test this change.

## Image scanning

SLV first scans the image normally, then retries global and local contrast,
2x scaling for images at most 600 pixels per side, and overlapping crops for
larger screenshots. Both normal and inverted colors are tried. Crop coordinates
are mapped back to the source image for the second-QR check. The stored image
is not altered by these scan retries.

The setup parser now accepts case-insensitive parameter names, grouped/lowercase
Base32 secrets, SHA-1/SHA-256/SHA-512 spellings, and repeated parameters only when
their normalized values agree. Base32 padding and unused bits remain validated.
Recognized display-only fields (`image`, `icon`, `logo`, `color`, `background`)
are ignored; their contents are never fetched or rendered. Other unknown
parameters require the explicit compatibility choice described above.

Conflicting secrets, issuers, algorithms, digit counts or periods are rejected.
SLV does not guess which conflicting value a site intended. TOTP still requires
SHA1/SHA256/SHA512, six or eight digits, and a 15–120 second period. HOTP, migration
QRs and proprietary code formats remain unsupported. Errors distinguish an
unreadable image from a decoded but unsupported or conflicting setup, without
including the secret or full URI.

## Limits and safety

- PNG input remains limited to 8 MB and 1600 pixels per side, with CRC checks.
- URI input remains limited to 4096 characters; at most 32 query parameters.
- Scan attempts are finite and run inside the existing five-second worker limit.
  Very noisy input may reach that limit and require a cropped image.
- The same retries check for another readable QR after masking the first.
  Multiple detected QR codes are rejected. This is best-effort detection;
  upload one setup QR, not a sheet of account codes.
- Temporary image and key buffers are wiped on completion. JavaScript strings
  and library/runtime-managed copies cannot be guaranteed erased.
- No network lookup, database migration, or change to stored account data.

If the source screenshot is blurry or its QR is too small, retries cannot
reconstruct missing detail. Use a clearer crop or the site's manual setup key
with its correct settings. Do not send real setup QRs or secrets for debugging.

## Validation

`npm run test:qr-compatibility` creates synthetic QR images in memory from a
public RFC test key. It covers a faint image that fails the previous single
scan, inversion, rotation, transparency, off-center screenshots, small images,
metadata and repeated settings, conflicting/unknown settings, two-code sheets
with mixed contrast, maximum-size blank input and bounded noisy input.

The suite also checks extra-field confirmation, withholding codes and clipboard
writes before approval, rejection of incompatible settings, no unknown-field
disclosure and expiry/epoch/lock/close handling. `npm run test:qr-compatibility-app`
checks the actual prompt and protected IPC in a new synthetic Electron profile,
including narrow layout, reopening, lock and untrusted-window rejection.

Existing authenticator tests cover RFC vectors, worker cancellation, session
and lock checks, clipboard expiry and secret-buffer wiping. Manual setup tests
use new synthetic vaults for encrypted storage and backup/restore. The unpacked
runtime test checks shipped QR dependencies without launching the desktop or
opening a vault. No real account data or QR images are used.

The 1.0.68 unpacked build passed the source/resource privacy gate and packaged
inventory checks (127 outer files, 368 ASAR files), Electron fuse checks, and a
shipped-worker faint-QR regression check. Syntax checks, the compatibility
suite, existing authenticator suite and manual setup/storage/backup suite passed.
The 1.0.68 installer is now packaged and verified for local testing only; see
the [package verification record](package-privacy.md#local-1068-installer).

The 1.0.69 unpacked build passed syntax, synthetic compatibility, authenticator
and manual setup/storage/backup tests, plus the isolated UI/IPC checks above.
Its shipped worker passed faint-image decoding and explicit standard-TOTP
confirmation tests. Source/package privacy gates (127 outer files, 368 ASAR files)
and Electron fuse checks passed. No 1.0.69 installer has been packaged yet.
