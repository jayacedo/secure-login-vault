# Secure Login Vault - reviewer notes

Submission target: Firefox extension 0.6.4; Windows desktop companion 1.0.50.
Status: prepared notes; installer URL and interactive clean-install check pending.

## Prerequisites

- Windows with Firefox 140 or later. Android, Linux and macOS are not supported
  by the current desktop companion.
- Add-on ID: `secure-login-vault@jayacedo`.
- Native messaging host: `com.securelogin.vault`.
- Desktop installer URL: **INSERT VERIFIED DOWNLOAD URL BEFORE SUBMISSION**.
- Local `Secure Login Vault Setup 1.0.50.exe` SHA-256:
  `31c1e6a89301470742a4fe374a9a5c79049237572adfba4eaf4ec425111cea38`.
  Verify the published download has this hash; update it if the installer changes.
- Source: https://github.com/jayacedo/secure-login-vault
- Desktop and extension license:
  https://github.com/jayacedo/secure-login-vault/blob/main/LICENSE.md
  Free personal/internal business use; includes permission for reviewer builds and tests.

No service account, subscription or real website credentials are needed. Use a
fresh Windows test account or VM and a fresh Firefox profile. Create a new test
vault with a disposable master password. Never open an existing personal vault
or import real credentials. The current Windows installer is unsigned by a
Windows code-signing certificate; Firefox add-on signing is a separate process.

## Setup

1. Install the companion using its Setup installer (not the portable executable).
2. Create and unlock the new test vault.
3. Open Settings > Browsers > Installation & troubleshooting and choose
   Set Up Browser Extension. This registers the helper for the current Windows
   account and enables browser access. Install the submitted Firefox add-on in
   the test profile, accepting its declared data permissions.
4. Choose Add browser in SLV. Paste the one-time code into the extension and pair.
   The popup should report Connected with a verified desktop connection.

## Local synthetic login fixture

The repository includes `docs/review-fixtures/login.html`. Serve that directory
on loopback only; for example, with Python installed, from the repository root:

```powershell
python -m http.server 8765 --bind 127.0.0.1 --directory docs/review-fixtures
```

Open `http://127.0.0.1:8765/login.html` in the test Firefox profile. Python is only
a convenience for this fixture, not an SLV runtime dependency. Any loopback-only
static server can be used. The form prevents submission and has no external
resources or network requests. Stop the server after testing.

## Functional checks

1. Enter username `slv-reviewer` and password `SLV-Dummy-Only-42!`. Open the
   extension and choose Save this login. Confirm Save login in the desktop
   dialog; select a test group/category if desired.
2. Clear fields on the fixture. Reopen the popup and choose Fill for the saved
   test entry. Approve in the desktop app if Ask Before Filling is enabled.
   Both fields should fill and the form should not be submitted.
3. Replace the password with `SLV-Dummy-Changed-43!`. Choose Save this login and
   approve the desktop update. Clear and Fill again to verify the updated value.
4. Repeat with a different dummy password but decline the desktop confirmation.
   The previously saved value must remain unchanged.
5. Lock SLV. Reopen the popup. It must report a locked vault and refuse Save/Fill.
6. Unlock SLV. With session-only pairing off, fully close and restart Firefox;
   the extension should reconnect. With session-only pairing on, a new browser
   session should require pairing again.
7. Optionally enable inline suggestions and grant website access. Reload the
   fixture, focus its username field, click the SLV button, then select the test
   login. It should fill without submission. Disable the feature afterward.
8. Optionally enable automatic save offers, grant website access and reload.
   Enter a new dummy username/password and press Simulate sign-in. The page
   prevents navigation while allowing a trusted submit event. Accept the offer
   and confirm in the desktop app. Declining must not save a new entry.

The add-on cannot fill browser-internal pages. Matching is by exact origin.
Some embedded forms, shadow DOM and custom login flows are outside current support.

## Privacy and permissions

`nativeMessaging` connects only to the local helper. `storage` holds extension
preferences and pairing state. `activeTab` and `scripting` support user-initiated
form reading/filling. Optional HTTPS/localhost host permissions enable inline
suggestions and automatic save offers. These features start disabled.

The Firefox manifest declares required `authenticationInfo` and `browsingActivity`
because credentials and origins cross the browser boundary to the local desktop
app. It does not mean a remote upload. A browser-family label is also sent during
pairing. No website password is persisted in extension storage. See
[the privacy explanation](extension-privacy.md) for capture timing and retention.

## Source reproduction

Upload `dist/secure-login-vault-firefox-0.6.4-source.zip` as reviewer source.
It contains readable original files and instructions for rebuilding generated
Firefox manifest/background declarations and the shared fill/transport files.
No npm install, credentials or network access are required for that extension
rebuild. Compare extracted file bytes, not ZIP timestamps or signature files.

Desktop source is in the repository. Extension source submission alone does not
include the desktop installer, private configuration, vaults or browser profiles.
