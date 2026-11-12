// Browser extensions allowed to start the helper. The browser already enforces
// this through "allowed_origins" in the helper's registration; the helper checks
// again so a wrong registration can't widen access.
//
// An extension's ID comes from the public key in extension/manifest.json (see
// scripts/extension-key.js). Add another ID here only for another build of the
// extension, for example a store-published one, which gets its own ID.
const ALLOWED_EXTENSION_IDS = ["nofnmddlckpmcngliaanefkffdkfacpc"];
const FIREFOX_EXTENSION_ID = "secure-login-vault@jayacedo";
const ALLOWED_FIREFOX_IDS = [FIREFOX_EXTENSION_ID];

module.exports = { ALLOWED_EXTENSION_IDS, ALLOWED_FIREFOX_IDS, FIREFOX_EXTENSION_ID };
