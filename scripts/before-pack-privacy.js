const { assertSources } = require('./package-content-policy');
exports.default = async context => {
  assertSources(context.packager.projectDir);
  console.log('PASS package privacy: approved source/resource paths only');
};
