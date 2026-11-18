# Unlock-to-dashboard transition

Source 1.0.70 keeps the compact unlock window in place while authentication and initial dashboard reads finish. The password field is cleared after successful authentication. The window then displays a theme-matched opening state while restoring its dashboard bounds, and reveals the populated dashboard after layout frames complete. No fixed animation delay is added.

The native presentation request is restricted to the trusted main renderer, the unlocked operation epoch and a one-use random token. Invalid colors, old tokens and requests after lock are rejected. Cancel remains available while data loads and locks the vault before hiding the window. Failed or timed-out initial reads relock the vault and show a retry message. Lock during staging keeps the dashboard hidden.

## Validation

`npm run test:unlock-transition-app` creates a fresh isolated profile and twelve dummy credentials. It mocks the system tray, startup integration, browser registration, OS idle state and clipboard; it never opens an existing vault. Frame checks cover dark, light and Forest themes, initial counts/rows, normal and maximized bounds, and full-size unlock without tray support. Slow reads, read failures, wrong passwords, cancellation, locking during staging and stale/invalid presentation requests are exercised.

`npm run test:unlock-layouts` checks the existing unlock variants. `npm run test:hardening-app` checks sender isolation for every exposed desktop request, including the presentation request.

Frame checks inspect rendered DOM visibility and layout. They cannot prove the absence of every compositor or graphics-driver artifact on another computer. The 1.0.70 installer is packaged and verified for local testing only; see the [package record](package-privacy.md#local-1070-installer).
