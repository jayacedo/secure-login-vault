const { assertSources } = require('./package-content-policy');
exports.default = async context => {
  assertSources(context.packager.projectDir);
  const path = require('path');
  const { filename, verifyFirefoxXpi } = require('./verify-firefox-xpi');
  verifyFirefoxXpi(path.join(context.packager.projectDir, 'browser-addons', filename), path.join(context.packager.projectDir, 'dist/firefox'));
  console.log('PASS package privacy: approved source/resource paths only');
};
