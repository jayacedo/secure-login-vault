# Firefox extension (Windows)

Firefox extension 0.6.6 binds popup Fill to the selected document and cancels pending requests on navigation, tab changes, timeout or Forget pairing. It retains the email-first filling fix for pages that keep password fields hidden for a later step. It retains the standard popup and two-step saving support. It uses the same desktop
vault and encrypted native connection as Chrome/Edge. Firefox 140 or later is required.
No credentials need to be imported again. Matching still uses the exact website origin.

## Install permanently (recommended for friends)

SLV builds from **1.0.75** include `secure-login-vault-firefox.xpi` version **0.6.6** in the Firefox extension folder. It is the owner-supplied Mozilla signing artifact, preserved byte-for-byte. The installer still requires you to install the add-on in Firefox yourself.

1. Open the installed SLV app, then **Settings > Browsers > Installation & troubleshooting**. Click **Set Up Browser Extension**, then **Open Firefox Folder**.
2. In Firefox 140 or later, open `about:addons`, choose **Extensions**, then the gear menu > **Install Add-on From File**.
3. Select `secure-login-vault-firefox.xpi` from the folder SLV opened. Confirm Firefox's installation prompts; Firefox checks the signature.
4. In SLV, choose **Add browser**, then enter the new pairing code in the extension. Keep SLV running and unlocked for Save/Fill.

The add-on stays installed after restart. Leave **Keep pairing only for this browser session** unchecked to remember pairing. For updates, repeat Install Add-on From File with the new bundled XPI; a desktop update does not automatically replace the installed Firefox add-on.

## Load temporarily for developer testing

1. Install an SLV Setup build, open it and unlock your vault. The owner removed
   the public v1.0.50 release on 2026-11-15; a replacement download is pending.
   Check the [Releases page](https://github.com/jayacedo/secure-login-vault/releases)
   or build from source. Reviewers should use a fresh synthetic test vault.
2. In **Settings > Browsers > Installation & troubleshooting**, click **Set Up Browser Extension**. This registers the Windows
   helper for Chrome, Edge and Firefox. Then click **Open Firefox Folder**.
3. In Firefox, open `about:debugging#/runtime/this-firefox` and click
   **Load Temporary Add-on**. Select `manifest.json` in the Firefox folder.
4. In SLV, click **Add browser**. Enter that code in the Firefox extension popup.
5. Open a login page, click the extension icon, then **Fill** next to the saved login.
   Manual Save and optional automatic Save/Update offers work through the same vault.

Temporary add-ons are removed when Firefox restarts. Load the add-on again and pair
again if requested. **Browsers now stay paired independently.** Use a separate code for each browser.
SLV Settings lists the pairings and lets you unpair one without disconnecting the others.
Re-pairing a browser that still holds its secret rotates only that browser's key.
Pairings already replaced by older SLV versions must be paired once again.

## Build from source

```powershell
npm.cmd run extension:build-firefox
```

This generates `dist/firefox/` for temporary loading and
`dist/secure-login-vault-firefox-0.6.6.zip` for Mozilla submission. The package is
generated from shared extension source; do not edit `dist/firefox` directly.
`npm.cmd start` and the Windows build regenerate the Firefox package automatically.
Developer helper registration is `npm.cmd run extension:register`.

The Setup installer bundles `resources/extension-firefox` as well as the existing
`resources/extension`. Installing SLV does not silently install either browser add-on.

## Permanent installation and signing

For a public AMO listing, use the prepared [listing and readiness notes](mozilla-listing.md),
[privacy explanation](extension-privacy.md) and [reviewer instructions](mozilla-reviewer-notes.md).
These materials do not publish the add-on; outstanding download, license-field and
interactive verification steps are recorded in the readiness notes.

The ZIP is **unsigned**, not a permanent installable Firefox add-on. Mozilla signing
is required for release Firefox. Submit the ZIP through the
[Mozilla Developer Hub](https://addons.mozilla.org/developers/) and choose either a
public listing or self-distribution (unlisted). After approval, download the signed
XPI. For self-distribution, users can install that XPI through Firefox's
**Add-ons and themes > gear menu > Install Add-on From File**.

For future extension updates, use **Upload a New Version** on the existing Secure Login Vault add-on. Upload the new generated ZIP; if source is requested, generate its source archive with `node scripts/build-firefox-source.js`. The source archive includes rebuild instructions and is checked against the submitted package. The owner supplied the signed 0.6.6 XPI on 2026-11-19. Earlier signed versions do not include the new document-binding and cancellation protections. Updating the desktop alone does not replace that signed add-on.

After installing the signed 0.6.6 XPI, reload the login page. On an email-first step, click **Fill**, click the site's **Next**, then click **Fill** again when the password step appears. SLV does not click Next or submit the form. Hidden password fields stay empty; visible signup fields and ambiguous email inputs still block the username-only fallback. Synthetic tests cover these cases, including inline fill and zero-sized hidden fields. The reported live Google page has not been accessed or verified. On a password-only step, **Save this login** recognizes a supported selected-account label or asks you to confirm the username in the popup. See [two-step saving](browser-extension.md#separate-username-and-password-steps-extension-062).

Desktop 1.0.61 adds immediate connection cancellation on lock/unpair and cancellation-aware Fill approval. These protections are included in later desktop builds. Install the bundled signed 0.6.6 XPI using the permanent steps above. See [validation and boundaries](browser-navigation-hardening.md).

### Bundled XPI verification

The reviewed artifact is stored at `browser-addons/secure-login-vault-firefox.xpi`.
SHA-256: `3f6df50323213cf7f337ddbc7d3b5ac1f1f454e02981ab100584c1af1b7ccb4a`.

Before packaging, `scripts/verify-firefox-xpi.js` checks the pinned hash, exact archive inventory, manifest equality and every code/image file against the generated Firefox build. It reads the archive without extracting it. A stale extension or changed artifact fails the build. Packaged-app and installer checks also verify the shipped XPI hash. Signature files are present; these build checks do not validate Mozilla's certificate chain. Firefox performs that validation at installation. For future updates, review the new Mozilla artifact and update the pinned hash only after comparing it with the new generated source. Never rezip or edit a signed XPI.

Keep the add-on ID `secure-login-vault@jayacedo`: the Windows helper allows only this
Firefox identity. Do not disable Firefox signature checking. No submission or
publication is performed by the build script.

The manifest declares authentication and browsing-activity data because usernames,
passwords and website origins are transferred to the local desktop vault. These
declarations do not mean data is uploaded: SLV does not send these details to a remote
service. Explain this local workflow in the submission's privacy and reviewer notes.

See Mozilla's [signing guide](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
and [data consent guide](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

## Storage and boundaries

Firefox does not provide Chrome's `storage.local.setAccessLevel`. Persistent pairing
is kept in IndexedDB belonging to the extension origin instead, inaccessible to
website content scripts. Session-only pairing uses Firefox's background-only
`storage.session`. Neither persistent browser storage is OS-encrypted; the desktop
copy is protected with Windows DPAPI. Site passwords are not persisted by the extension.

Save offers and inline suggestions remain optional. The background checks the browser's sender ID, top-level
frame and current tab origin; website scripts cannot call pairing, Fill or manual Save.
Inline content scripts have a separate metadata-only chooser protocol with one-use tokens and document/form checks.
Firefox versions before 153 do not supply `MessageSender.documentId`, so that optional
metadata is not required on Firefox. Origin and frame checks remain mandatory.

## Verification

`npm.cmd run test:firefox` checks package identity, native caller rejection and
registration. `npm.cmd run test:firefox-browser` uses installed Firefox with a fresh
headless profile, dummy vault and temporary native-helper registry key. It never opens
the user's profile or production vault. Set `SLV_FIREFOX_PATH` if Firefox is elsewhere.
The temporary registry key is removed afterward. This test requires permission to
write that per-user key.

Verified with Firefox 159.0.1 on Windows: pairing, encrypted native messaging, manual
save/fill/update, automatic offers after trusted form submission, inline account selection and immediate disable, session-only pairing,
content-script storage isolation, remembered pairing after event-page restart, and
locked-vault refusals. The test supplies consent and active-tab permission in its own
profile and exercises the save-approval callback; interactive Firefox permission
prompts and the signed permanent-install workflow still need manual verification.
`test:packaged-firefox` also verifies the helper extracted from Setup with no Node.js
on its PATH. The existing Chrome simulation/real Electron end-to-end suite passes.
