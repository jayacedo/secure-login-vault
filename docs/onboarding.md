# Getting-started guide

Source 1.0.76 adds a five-step balloon tour: welcome, Add Login, browser setup,
encrypted backups, and Help. Next and Back navigate the explanation only. Controls
behind the guide are inactive; no login, browser registration, pairing, folder
selection or backup configuration is performed by the guide.

The first automatic offer is queued by successful first-time vault creation,
after recovery-key acknowledgement when requested. Existing profiles without the
new preference remain opted out. Settings > General > Getting started provides
an on/off checkbox and Restart guide; Help also provides Restart guide. Turning
the checkbox on starts the guide immediately. Skip, Escape and Finish turn off
automatic display. Locking closes it without marking it finished, so an interrupted
guide restarts from the beginning on the next unlock.

Only `slv_getting_started_v1` is stored in the existing device-local UI preferences
(`pending`, `off` or `done`). This is not vault data and is not included in encrypted
backups. There is no database migration or extension update.

The guide navigates the existing Settings panels to point at the real controls.
It does not inspect account fields. The rest of the interface is inert while the
guide is open; keyboard focus stays in the balloon. Ctrl+L still locks the vault.
The target and balloon reposition on scrolling/resizing. When there is no visible
target or insufficient room, the balloon uses a centered fallback. Theme and text
size follow the app, with no looping animation. CSS positioning uses numeric DOM
style properties under the existing strict style CSP.

## Validation

`npm.cmd run test:onboarding-app` uses a newly generated profile under `.tmp`, an
empty synthetic vault, blocked clipboard/file dialogs and a fake browser helper.
It covers recovery-screen ordering, all steps, Back, focus trapping, completion,
Skip/Escape, Help restart, Settings controls, preference persistence, existing-user
opt-in, lock during asynchronous navigation, themes and window resizing. The guide
must leave the synthetic vault empty and never invoke browser setup. Screenshots
show synthetic content only.

Built unpacked for review. The latest local Setup installer remains 1.0.75 until
1.0.76 is explicitly packaged.
