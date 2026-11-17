# Windows lock and sleep protection

Included in the locally verified [1.0.60 installer](package-privacy.md#local-1060-installer), together with clipboard, renderer-crash and timer fixes.

Desktop 1.0.59 locks the vault on Windows lock and system suspend. Resume locks it again as a fallback if a suspend notification was missed. Returning to Windows never unlocks SLV: the master password is required again.

These events bypass configurable inactivity/background timers and native-dialog grace periods. Locking clears the active vault session, closes login windows and approvals, cancels pairing requests and backup verification, and clears displayed Notes and unsaved Notes edits through the existing lock pathway. Saved content is preserved.

Creating or unlocking a vault is refused while the process knows Windows is locked or the system is suspended. Startup checks the current Windows idle/lock state. In-flight unlock work is invalidated by the vault operation epoch when a lock arrives.

The previous implementation only handled app inactivity/background changes and shutdown. With both timers disabled, a synthetic Windows lock event left the vault unlocked. The new regression test reproduced that failure before the fix.

## Verification

Run `npm run test:system-lock-app`. It uses a new synthetic profile under the project `.tmp` directory, isolates app paths and the browser bridge, mocks browser setup and blocks clipboard access. No installed vault, existing backup or personal browser profile is used.

Coverage includes an already-locked startup, Windows lock/unlock, suspend/resume, resume without a prior suspend event, disabled timers, denied unlock while locked, cleared Notes display, interrupted unlock work, and preservation of saved synthetic Notes.

Events are emitted only within the test process; the test does not actually lock Windows or put the machine to sleep. Real Windows event delivery remains a manual check with a synthetic vault. This is a focused regression check, not a full security audit.

Local validation on 2026-11-17 passed: the system-lock application test, existing authentication/permission application test, lock-manager unit tests, syntax checks, unpacked build privacy checks and packaged Electron fuse verification. Test profiles were removed afterward. No new installer was generated; 1.0.58 remains the latest installer.

The implementation uses Electron's [powerMonitor events and idle-state API](https://www.electronjs.org/docs/latest/api/power-monitor).
