# Clipboard, renderer crash and lock-policy hardening

Desktop source 1.0.60 bundles these changes with 1.0.59 Windows lock/sleep protection. Installer packaging is deferred; 1.0.58 remains the latest installer.

## Confirmed gaps and changes

- Password auto-clear previously ran in the renderer, so a lock-induced reload or renderer crash could cancel the timer. It also unconditionally replaced clipboard text, potentially removing a later unrelated copy. Desktop Copy actions now use a bounded, trusted-window IPC endpoint and a main-process clipboard service. Passwords, generated passwords, password-history values, recovery keys and pairing codes are marked sensitive. Cleanup compares the current clipboard text with the tracked value. A later non-sensitive desktop copy cancels the earlier cleanup.
- Cleanup runs on timeout, vault lock, renderer reload/crash and normal quit. Turning off the timeout still allows cleanup on lock/exit. Writes and cleanup are serialized; session epochs and cancellation generations reject writes that finish after lock. A revision guard prevents an expired timer from clearing a newer copy. No clipboard read API is exposed to the renderer.
- A renderer crash previously cleared authenticator state and backup verification without explicitly locking the vault. Renderer loss/destruction now takes the full main-process lock path, revoking the session and browser access. Reloading afterward requires unlocking again.
- Changing a background timeout previously left the old timer active. Changes now re-arm the timer immediately when backgrounded; zero locks immediately, disabling cancels it, and unchanged settings do not restart it. A newly enabled/changed grace interval starts when applied. Native-dialog pauses remain bounded and are respected. Unlocking while already backgrounded arms the policy too.

## Validation

- `npm run test:sensitive-clipboard`: an in-memory fake clipboard and fake timers cover expiry, replacement, non-sensitive copies, timer-off lock cleanup, locked requests, input limits, lock during an asynchronous write, stale timer callbacks and OS failures.
- `npm run test:system-lock-app`: a fresh synthetic Electron profile and fully mocked clipboard cover actual desktop Copy IPC, Windows lock/sleep events, a deliberately crashed test renderer, session revocation and locked reload recovery.
- `npm run test:lock`: fake-clock policy changes, timer cancellation, unchanged-policy resync and native-dialog grace.
- Existing authentication/permission regression tests, syntax checks, unpacked package inventory and Electron fuses are checked before committing.

Tests never use the installed vault, existing backups, personal browser profiles or the OS clipboard. Synthetic test profiles are removed after checks. No installer is run or published.

All listed checks passed locally on 2026-11-17. The unpacked build contains 128 approved ASAR files and 127 approved outer files, with the expected Electron fuses verified. Task-created synthetic profiles were removed.

## Limits

Clipboard cleanup is best-effort. It compares text, not OS-level ownership: an identical later copy is indistinguishable, and another process can race clipboard operations. It cannot erase Windows clipboard history, clipboard-manager history or data another application already captured. OS clipboard failures, forced process termination and power loss can prevent cleanup. JavaScript strings cannot be guaranteed to be zeroed from memory. This is a focused hardening change, not a claim of protection against malware running as the same Windows user.
