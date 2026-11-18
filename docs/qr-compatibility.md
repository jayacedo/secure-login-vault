# QR compatibility (desktop 1.0.68)

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
parameters remain rejected because they could change code generation.

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
