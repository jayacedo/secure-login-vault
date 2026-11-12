# Browser transport security (SLV 1.0.16 / extension 0.6.0)

Desktop 1.0.16 adds shared main-window/document/frame checks for desktop requests,
session-bound operation results, serialized vault operations, and a single-instance
guard for each desktop profile. Lock cancels queued operations and clears file-picker
grants; an already committing replacement finishes safely without reopening the vault.
Restore validates decrypted backup contents before replacing files. These local
changes do not alter the extension protocol or require an extension update.

## What this release protects

Credential requests and replies are encrypted and authenticated between the desktop app
and extension worker. The native helper transports ciphertext and cannot legitimately
decrypt or edit credentials. Handshake messages expose the app version, random nonces
and proofs; envelope IDs, counters, lengths and timing remain visible. No server or
external API participates in this connection.

The existing rules still apply: the vault must be unlocked, Fill selects one login for
an exact origin, real websites require HTTPS, and saving requires desktop confirmation.
An optional Ask Before Filling setting adds a desktop confirmation to Fill.

This is implementation hardening backed by automated tests, not an independent security
audit or a guarantee against malware. Once credentials are filled, the website can read
its form fields. Browser compromise, malicious extensions with page access, same-account
malware, administrator access and a stolen pairing secret remain threats. Encryption
does not hide credentials from either endpoint while it is using them.

## Protocol v2

The app advertises protocol `2`; the extension refuses other versions. Both components
must be updated. The pairing code and stored secret formats are unchanged, so remembered
pairing survives an ordinary upgrade. There is no plaintext application-message fallback.

Pairing uses the existing 128-bit random, single-use code and mutual proofs. For every
subsequent native connection, the extension and app generate independent 128-bit random
nonces, `nonceE` and `nonceA`. Authentication HMAC-SHA-256 proofs use the labels
`auth-v2-app|nonceE|nonceA` and `auth-v2-ext|nonceE|nonceA`. The v2 domain prevents a
captured v1 proof from authenticating a v2 session, even if an intermediary forges ping.

After authentication, two non-extractable AES-256-GCM keys are derived using Web Crypto
HKDF-SHA-256, the pairing secret as input key material, UTF-8 `nonceE + nonceA` as salt,
and these separate information strings:

- Extension to app: `slv-secure-v2:e2a`
- App to extension: `slv-secure-v2:a2e`

Each direction starts its counter at 1. An envelope has exactly `type`, `id`, `session`,
`seq` and `data`; type is `secure`, session is the concatenated lowercase nonce hex,
and data is lowercase hex of ciphertext followed by the 128-bit GCM tag. The 96-bit IV
is eight zero bytes followed by the counter as a big-endian unsigned 32-bit integer.
Counters never repeat under the same key. Keys differ by direction and random session.
The authenticated additional data is UTF-8 JSON encoding of:

```json
["slv-secure-v2", "<session>", "<e2a or a2e>", 1, "<request-id>"]
```

The encrypted body is a JSON object. The receiver requires the exact next counter;
replays, reordered messages, another session, reflected requests and modified headers
or ciphertext fail closed. Limits are 16 KiB of plaintext, one million messages per
direction, IDs of 1–128 characters, and five minutes per session. Normal operations
open and close a fresh native connection. No forward secrecy is claimed: possession
of the long-term pairing secret and recorded handshake nonces permits deriving old
session keys.

A successfully authenticated connection accepts only encrypted messages. Authentication
and pairing cannot be nested inside encrypted requests. An encrypted channel-check
round trip must succeed before the extension reports a verified connection. Each
connection is processed serially, with at most 16 queued requests. Decryption failures
disconnect and destroy the channel; no handler or approval dialog runs for invalid
ciphertext. Revoking or rotating a pairing invalidates only that pairing's sessions and pending writes.
Errors inside a valid channel are encrypted; helper/disconnection errors are generic
and cannot be accepted as valid encrypted replies.

The shared implementation is `src/shared/secureChannel.js`; generate the browser copy
with `npm.cmd run extension:sync-secure`. Tests and the release preflight check equality.
Key references are dropped on closure/failure. JavaScript cannot guarantee physical
erasure of all old strings, buffers, crash dumps or swapped memory.

## Windows pipe and local storage review

The pipe listener explicitly sets `readableAll: false`, `writableAll: false` and
`exclusive: true`. These preserve Node's non-world-writable defaults; they do not install
a custom Windows ACL or exclude administrators/the same Windows account. Windows'
default pipe descriptor can grant read access to other accounts. Naming a pipe after
a user is routing, not an authorization boundary. Authentication and encrypted messages
are required regardless of who can open the pipe. Four connections, bounded frames,
request rate limits, first-message and idle deadlines, and a 45-second authentication
deadline bound resources; ping cannot hold an unauthenticated slot indefinitely.
Local denial of service remains possible.

The desktop pairing secret remains protected with Windows DPAPI through Electron
safeStorage. Chrome/Edge local and session storage are restricted to trusted extension
contexts before use. Content scripts have separate save-offer and inline-fill protocols;
privileged popup Fill, pairing, storage settings and manual Save routes remain inaccessible.

Existing installations keep remembered pairing in Chrome's local extension storage.
This is not OS-encrypted secret storage. The new **Pairing security > Keep pairing
only for this browser session** option moves the browser secret to `chrome.storage.session` and
removes its current local-storage entry. It survives worker suspension but is lost on
browser restart or extension reload/update/disable. Re-pairing is then required. Turning
the option off explicitly restores persistence. Moving a previously stored secret does
not securely erase historical filesystem copies or backups. The desktop's DPAPI-protected
copy remains until unpaired in SLV.

Firefox has no `storage.local.setAccessLevel`. Its pairing secret and persistence mode
use extension-origin IndexedDB; content scripts use the website origin and cannot
access that database. Firefox session-only pairing uses its background-only
`storage.session`. Ordinary save-offer preferences (enabled/blocked sites) remain in
local extension storage; they contain no credential or pairing secret. See the
[Firefox guide](firefox.md).

## Inline fill boundary

Inline suggestions are off by default and need optional website permission. The isolated top-frame script does not query the vault until a trusted click on SLV. The worker lists only matching account IDs, names and usernames, with bounded lengths and counts. It derives the site from the browser sender and active tab, never from a page-supplied address.

A random, memory-only token expires after 60 seconds and authorizes one selected ID for the same tab, full URL and document. The worker rechecks active-tab access after desktop approval. Chromium targets the original document ID; both browsers also require the isolated script's token and live field/form references immediately before injection. The form action must remain same-origin. Disabled access, dismissal, navigation or replaced targets cancels filling. Only a status returns to the chooser; passwords use the existing authenticated helper and isolated fill path.

The closed shadow root keeps UI styles separate; it is not a security boundary against a compromised browser. Page scripts cannot use synthetic clicks to select an account through this UI, but can alter their own page and read fields after a user fills them. These controls do not make an infected site safe.

## Independent browser pairings

SLV 1.0.5 stores a versioned list of up to 32 pairing records inside the same
DPAPI-encrypted file. A previous single secret is preserved as an existing-browser
record, including compatibility with its old client until that extension is updated.
The extension derives a public selector with HMAC-SHA-256(secret, `slv-pairing-id-v1`)
and sends it with auth-begin. The selector is not an authorization credential: the
mutual proof and encrypted channel remain required. Unknown IDs are refused.

A new pairing adds a record. To rotate an existing record, the client must prove
knowledge of the old secret as well as the new one-time code. The rotation HMAC binds
the old secret to both new nonces and the new pairing proof, under a separate label.
An untrusted browser-name claim never evicts another pairing; names are display labels,
not authenticated browser identities. A revoked or forgotten secret cannot rotate an
old entry; an explicit new code can create another pairing instead. Stale entries can
be removed in Settings.

Each authenticated connection is bound to its own record. Individual Unpair requires
an unlocked vault, atomically persists removal, cancels that browser's connections
and blocks its pending writes. Other records and sessions remain valid. Unpair all
revokes every record and cancels any active code. Storage failures leave the prior
live and persisted state intact and are reported to the user.

## Verification and remaining review

`test:multi-pairing` checks migration, independent sessions, persistence, rotation,
forged replacement proofs, atomic failures, limits and revocation during a pending
save. The real Settings test exercises per-browser controls and DPAPI persistence;
the real Firefox test verifies coexistence with another protocol client.

`test:secure` checks ciphertext against an independent Node AES-GCM/HKDF implementation,
bidirectional exchange, changed ciphertext/tags/IDs/counters, replay, reflection,
cross-session messages, expiry, oversized data, downgrade rejection, revocation and
session-only storage. Its real-pipe checks confirm invalid/replayed saves cannot trigger
another write or approval. `test:secure-browser` checks actual Chromium Web Crypto against
the desktop implementation. `test:link` records real helper traffic and asserts dummy
passwords are absent in both directions. Existing Save, Fill, pairing, matching and
Electron end-to-end tests exercise the encrypted connection. The packaged test checks
the actual installer payload and runs its helper without Node.js on the helper PATH.

Still required before claiming independent assurance: external protocol/code review,
hostile multi-account Windows testing, and manual Chrome/Edge upgrade/reconnect checks.

Primary references: [Web Crypto AES-GCM](https://www.w3.org/TR/webcrypto-1/#aes-gcm),
[Node IPC listen options](https://nodejs.org/api/net.html#serverlistenoptions-callback),
[Windows named-pipe permissions](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights),
[Chrome session storage](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session).
