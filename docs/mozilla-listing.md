# Mozilla public listing preparation

Prepared 2026-11-15 for desktop 1.0.50 / Firefox extension 0.6.4.
These are submission materials, not a record of public listing approval.
**Hold submission:** the public desktop release was deleted by the owner on
2026-11-15. A verified replacement download is required before submitting.
The owner chose free use with retained code ownership and GitHub Issues for support.

## Listing fields

**Name:** Secure Login Vault

**Summary:** Save and fill logins with your local Secure Login Vault Windows desktop app.

**Description (paste into AMO):**

Secure Login Vault connects Firefox to your local SLV desktop vault.

Requires the Secure Login Vault Windows desktop app and its browser helper.
This extension does not work as a standalone password manager and does not support
Firefox for Android, macOS or Linux with the current desktop companion.

- Fill a matching saved login without submitting the website's form.
- Save a new login or update a saved password after confirming in the desktop app.
- Choose a group and category when saving a new login.
- Optionally show an account chooser beside supported login fields.
- Optionally offer to save or update credentials after a supported form submission.
- Remember pairing between browser sessions, or choose session-only pairing.

Credentials move between the extension and the paired desktop app over an
encrypted, authenticated local connection. SLV does not upload these credentials
to a developer-operated cloud service. The vault must be open and unlocked to
fill or save. Each browser is paired separately.

Firefox requests authentication-information and browsing-activity consent because
usernames, passwords and website origins are exchanged with the desktop companion.
Optional inline suggestions and automatic save offers also require website access.

Matching uses the exact website origin. Some embedded or unusual login forms are
not supported. SLV cannot recover passwords from an already signed-in session.
Once a password is filled, the destination website can read its own form fields.

Install and setup instructions:
https://github.com/jayacedo/secure-login-vault/blob/main/docs/firefox.md

Windows desktop download: insert the verified replacement release URL before submitting.

Support:
https://github.com/jayacedo/secure-login-vault/issues

**Category suggestion:** Privacy & Security; optionally Other if offered and appropriate.

**Homepage:** https://github.com/jayacedo/secure-login-vault

**Support website:** https://github.com/jayacedo/secure-login-vault/issues

**Privacy policy:** https://github.com/jayacedo/secure-login-vault/blob/main/docs/extension-privacy.md

**Platform:** Firefox desktop on Windows; minimum Firefox 140. Do not select Android.

**Icon:** `extension/icons/icon-128.png`.

**Suggested screenshots:** connected popup with a synthetic login; optional inline
chooser on the local reviewer fixture; desktop save confirmation using dummy data.
Do not use the owner's real-account screenshots from chat.

## License

The owner approved free personal/internal business use while retaining code
ownership. The [SLV Free-Use License](../LICENSE.md) now covers both the desktop
application and browser extension, with exceptions for third-party licenses,
GitHub platform rights and authorized distribution/reviewer testing.

Use AMO's custom license option and paste the full text from `LICENSE.md`. Do not
select MIT, GPL or another open-source license. Public license URL:
https://github.com/jayacedo/secure-login-vault/blob/main/LICENSE.md

Include this in the replacement GitHub release:

> Free for personal and internal business use under the
> [SLV Free-Use License](https://github.com/jayacedo/secure-login-vault/blob/main/LICENSE.md).
> Third-party components retain their own licenses.

Attach `LICENSE.md` alongside the installer so the terms can be downloaded
with it. The withdrawn installer and current Firefox archives were not rebuilt for the
documentation/license update; their embedded metadata may still say `UNLICENSED`.
The external license explicitly grants use of desktop 1.0.50 and extension 0.6.4.

## Review materials

- Add-on package: `dist/secure-login-vault-firefox-0.6.4.zip`.
- Reproducible source: `dist/secure-login-vault-firefox-0.6.4-source.zip`.
- Reviewer notes: [mozilla-reviewer-notes.md](mozilla-reviewer-notes.md).
- Privacy text: [extension-privacy.md](extension-privacy.md).
- No network submission is performed by building these artifacts.

## Remaining work before submitting

1. Confirm the existing add-on's distribution channel in Developer Hub. Use that
   existing add-on and keep `secure-login-vault@jayacedo`; do not create a new ID.
   Earlier approval alone does not establish that it is publicly listed.
2. Provide a verified replacement installer download. The owner removed v1.0.50
   after its download/hash checks; GitHub now returns 404 for that release.
   Run the package privacy gates and verify the uploaded binary's SHA-256, then
   update the reviewer notes. Do not reuse a checksum from a different build.
3. Include the finalized free-use terms in the AMO license field.
   Check that the setup guide, privacy page and license links are publicly accessible.
4. Check the Firefox consent declaration against all data flows. The manifest
   already requires `authenticationInfo` and `browsingActivity`. Login emails are
   used as authentication identifiers, and a browser-family label is sent during
   pairing. Confirm whether Mozilla requires any additional classification for
   these fields; do not claim that nothing leaves the browser or blindly declare
   optional technical data while sending it unconditionally.
5. Complete an interactive check with a fresh Windows test account/VM and a
   separate Firefox profile: consent prompts, installed helper, pairing, Save,
   Fill, Update, locked refusal and restart persistence. Use only synthetic data.
6. Add screenshots if desired, paste listing/privacy/reviewer text, and resolve
   AMO validator findings. If 0.6.4 cannot be reused or code changes are needed,
   increment the extension version and regenerate both archives before upload.

## Preparation checks (2026-11-15)

- GitHub v1.0.50 was initially published, not a draft or pre-release. Its installer was
  downloaded without authentication; SHA-256 matches the release notes and local
  build. Its attached license text matched `LICENSE.md`. No installer was run.
  The owner subsequently removed the release; the public release API returned 404.
- `node scripts/firefox-test.js`: passed package/ZIP contents, identity, native
  caller allowlist and simulated per-user registration checks. No real registry
  registration or production vault access was used by this test.
- `node scripts/build-firefox-source.js`: passed a byte-for-byte rebuild of every
  shipped extension file from the source archive.
- `git diff --check`: passed.
- These checks do not replace AMO validation or interactive signed-add-on and
  fresh Windows installation testing.

## References

- [Mozilla submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
- [Source submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)
- [Data consent and taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- [Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
