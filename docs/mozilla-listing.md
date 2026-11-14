# Mozilla public listing preparation

Prepared 2026-11-15 for desktop 1.0.50 / Firefox extension 0.6.4.
These are submission materials, not a record of public listing approval.
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

## License decision

The owner wants free use while retaining code ownership. `package.json` currently
says `UNLICENSED`; public source availability does not grant an open-source license.
Do not select MIT, GPL or another open-source license without a new owner decision.

Proposed custom AMO license text for owner review:

> Copyright (c) 2026 Jay Acedo. All rights reserved.
> Permission is granted to install and use official, unmodified Secure Login Vault
> extension releases free of charge for personal and internal business use.
> This permission does not grant rights to modify, redistribute, sublicense or sell
> the extension or its source code. Mozilla may sign and distribute submitted
> releases under the author's agreement with Mozilla. The software is provided
> as is, without warranties, to the extent permitted by applicable law.

This is a proposed extension license, not a change to the repository or desktop
license. Finalize the rights-holder name and license before submitting. Users and
reviewers also need permission to use the desktop companion; resolve its terms
alongside the installer download.

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
2. Publish or otherwise provide an accessible Windows installer download, and
   insert its exact URL and SHA-256 in the reviewer notes. The local Setup file is
   not accessible to Mozilla. The unauthenticated GitHub API confirmed that the
   repository is public and Issues are enabled, but returned no public releases
   on 2026-11-15. A public installer download is still needed.
3. Finalize the custom extension license and desktop-use terms. Check that the
   GitHub repository, setup guide, privacy page and Issues link are publicly accessible.
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
