# Browser setup for private testing

Use your own fresh vault and dummy logins for initial testing. Never share a vault, backup, master password, pairing code or authenticator setup key with another tester.

## What do I need before setting up a browser extension?

Use the Windows Setup installer; browser setup is unavailable in the portable build. Open SLV and create your own vault with a master password, or unlock your existing vault. The installer includes the browser helper and Chrome/Edge/Brave extension folder. No Node.js, npm or source code is needed. The signed Firefox .xpi is included too: use Open Firefox Folder to find it. Installing the desktop app does not automatically install the browser extension.

## How do I set up Chrome step by step?

Start with the installed SLV desktop app open and unlocked.

1. In SLV, open Settings > Browsers > Installation & troubleshooting. Click Set Up Browser Extension. This registers the local helper and opens the bundled extension folder. Its path is also shown in Settings.
2. In Chrome's address bar, enter chrome://extensions and press Enter. Turn on Developer mode.
3. Click Load unpacked and select the Chrome / Edge extension folder shown by SLV. Select the folder containing manifest.json, not the file itself. Do not choose the Firefox folder.
4. Open Chrome's Extensions menu (puzzle-piece icon), find Secure Login Vault and pin it if desired. Click the SLV extension to open its popup.
5. Back in SLV Settings > Browsers, click Add browser. Copy the pairing code into the Chrome extension and complete pairing.
6. Check that the popup says Connected with a verified connection. Keep SLV running and unlocked for Save and Fill. Try a dummy login first.

Edge uses the same folder: open edge://extensions instead. Brave uses brave://extensions and the same folder. Pair each browser separately with a new code. Leave the installed extension folder in place.

## How do I set up Firefox permanently, step by step?

Use Firefox 140 or later. SLV builds from 1.0.75 include secure-login-vault-firefox.xpi for permanent installation. Use that XPI, not manifest.json or the unsigned submission ZIP.

1. Open and unlock the installed SLV desktop app. Go to Settings > Browsers > Installation & troubleshooting and click Set Up Browser Extension. This registers the Firefox helper too. Click Open Firefox Folder to find the bundled secure-login-vault-firefox.xpi.
2. In Firefox's address bar, enter about:addons and press Enter. Select Extensions.
3. Open the gear menu and choose Install Add-on From File. Select secure-login-vault-firefox.xpi from the folder SLV opened, then review and confirm Firefox's installation prompts.
4. Open Firefox's Extensions menu (puzzle-piece icon), then open Secure Login Vault. Pin it to the toolbar if desired.
5. In SLV Settings > Browsers, click Add browser. Copy the new pairing code into the Firefox extension and complete pairing.
6. Check that the popup says Connected with a verified connection. For remembered pairing, expand Pairing security and leave Keep pairing only for this browser session unchecked.

The signed add-on stays installed after Firefox restarts. Session-only pairing is a separate setting: enabling it means pairing again after a restart. Keep SLV running and unlocked for Save and Fill. Do not disable Firefox signature checking.

## How do I temporarily test Firefox without a signed XPI?

This is a testing option only; Firefox removes temporary add-ons when it restarts.

1. In the installed, unlocked SLV app, open Settings > Browsers > Installation & troubleshooting. Click Set Up Browser Extension, then Open Firefox Folder.
2. In Firefox, open about:debugging#/runtime/this-firefox. Click Load Temporary Add-on and select manifest.json inside that Firefox folder.
3. In SLV, click Add browser and enter the new code in the Firefox extension. Check for Connected. After restarting Firefox, load the add-on again and pair if requested.

For everyday testing with friends, use the permanent signed-XPI steps above when a signed file is available.

## How do I check that setup worked, or update the extension?

Use a normal website login form with dummy details for your first test. Browser settings pages, the extensions manager and new-tab pages cannot be filled. Save this login asks you to confirm in the desktop app; Fill uses a matching saved login and may ask for approval according to Ask Before Filling. After a desktop update that changes the extension, Chrome/Edge/Brave need Reload on their extensions page. For Firefox, use Open Firefox Folder and install the updated bundled XPI through Install Add-on From File. A desktop update does not automatically replace the Firefox add-on. If the app moved, run Set Up Browser Extension again and load the new folder for Chromium browsers.

Browser installation steps checked against [Chrome documentation](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) and [Firefox Help](https://support.mozilla.org/en-US/kb/find-and-install-add-ons-add-features-to-firefox).
