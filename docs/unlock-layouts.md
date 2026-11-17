# Unlock screen layouts — 1.0.64

Settings > General > Appearance offers three layouts:

- **Minimal:** centered branding and a full-width unlock button.
- **Floating card:** a rounded, elevated form beneath the branding row (default).
- **Compact:** a smaller header and adjacent Unlock / Cancel buttons.

Choose a preview card to save immediately on this device. The preference is
`slv_unlock_layout` in the same local renderer preferences as theme and branding;
it is not an account record or part of a vault export. Missing or unknown values
fall back to Floating card. Every style uses the current theme, accent, text size,
app name and logo.

**Preview unlock screen** opens an inactive representation using the same layout
renderer. It does not lock the vault, request passwords or load the saved hint.
The sample recovery/hint controls illustrate placement; the live screen only
shows those controls when a recovery key/hint exists. Escape or Close returns
focus to the preview button. Locking dismisses the preview.

Actual unlock, hint/recovery, password reveal, throttling and tray cancellation
continue through the existing handlers. Cancel remains available only for the
compact tray unlock window. Creation and recovery forms are unchanged. At small
window heights or large text sizes the screen scrolls instead of clipping its
controls. Motion respects the reduced-motion preference.

## Validation

`npm run test:unlock-layouts` uses a newly generated synthetic vault and an
isolated Electron profile. Clipboard, browser registration and file dialogs are
mocked. It checks preference persistence across reload, theme/large-text/narrow
layouts, inactive preview, focus return, hint and reveal controls, a real submit
against the synthetic vault, and preview dismissal on lock. Screenshots are
generated only from this synthetic profile.

No real accounts, notes, vault files, backups, browser profiles or clipboard are
read or copied. The source and unpacked 1.0.64 build include the prior 1.0.63
import protections. No installer is packaged for this change yet; the latest
local installer remains 1.0.62. Extension 0.6.6 is unchanged.
