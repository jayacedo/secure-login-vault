# Secure Login Vault browser extension privacy

Prepared: 2026-11-15. Describes extension 0.6.4 with desktop 1.0.50.

## Purpose and destination of data

The extension connects your browser to the Secure Login Vault Windows application
on your computer. It handles usernames (which may be email addresses), passwords
and website origins to find, fill, save and update logins. An origin consists of
the scheme, hostname and port. The extension also checks page URLs locally to
prevent an operation from continuing after the page changes.

The extension exchanges credentials with the paired desktop application through
native messaging using an encrypted, authenticated local channel. Pairing also
uses a browser-family label and pairing identifiers to identify the connection.
The extension does not send credentials or browsing activity to a developer
server, advertising service or analytics service. There is no extension cloud sync.
Firefox and Mozilla operate their own installation and update services separately.

## When information is handled

- Opening the popup on a supported page requests matching logins for its origin.
- Choosing Fill retrieves the selected credential and writes it into the page's
  login fields. It does not submit the form. The website can read filled fields.
- Choosing Save reads the login form. A desktop confirmation is required before
  a new credential or changed password is saved in the vault.
- Optional inline suggestions show matching accounts after you click the inline
  button. Optional automatic save offers inspect supported submitted login forms
  and compare their credentials with the local vault to decide whether to offer
  Save or Update. Comparison can happen before you accept an offer; saving still
  requires desktop confirmation. Both features require your enabling them and
  granting website access.
- On supported multi-step logins, the extension may remember the username briefly
  or ask you to confirm it. It cannot retrieve a password from a signed-in session.

## Storage and retention

The extension does not persist website passwords in browser storage. Pending save
candidates and multi-step usernames are held temporarily in memory, normally for
at most two minutes, and may be cleared earlier on cancellation, navigation,
disconnection or background shutdown. This is not a guarantee of forensic memory
erasure. Credentials saved after confirmation remain in the desktop vault.

The extension stores feature preferences and website origins for which you chose
Never for this site. It remembers a pairing secret in the extension's browser
profile by default. In Firefox this uses extension-origin IndexedDB; session-only
pairing uses browser session storage. The browser-side pairing secret is not
OS-encrypted by SLV. The desktop pairing copy uses Windows-protected storage.

Desktop vault data and backups have separate lifetimes. Deleting a credential may
retain it in Recently Deleted and existing backups. Removing the extension or
forgetting pairing does not delete saved desktop credentials or backups.

## Your controls

You can disable automatic save offers or inline suggestions, revoke website
permissions in the browser, select session-only pairing, or choose Forget pairing.
SLV Settings also lets you revoke an individual paired browser. Locking the vault
prevents credential retrieval and saving. Uninstalling the extension removes its
browser-managed storage; it does not uninstall the desktop companion.

## Contact and changes

Questions can be raised at
[GitHub Issues](https://github.com/jayacedo/secure-login-vault/issues).
Issues are public: never post passwords, pairing codes, vaults, backups, QR setup
keys or screenshots containing private account information. Information you
choose to post there is handled by GitHub under its own policies.

This document will be updated when extension data handling changes. Local storage
and encrypted transport do not protect against every compromised website, browser
or computer. SLV has not undergone an independent security audit.
