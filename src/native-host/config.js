// Browser extensions allowed to start the helper. The browser already enforces
// this through "allowed_origins" in the helper's registration; the helper checks
// again so a wrong registration can't widen access.
//
// Empty means "nobody": the helper refuses every caller. The extension's ID is
// added when the extension itself is created.
const ALLOWED_EXTENSION_IDS = [];

module.exports = { ALLOWED_EXTENSION_IDS };
