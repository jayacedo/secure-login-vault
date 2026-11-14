const { checkInstaller } = require('./package-privacy');
exports.default = async context => {
  if (context.target?.name !== 'nsis' || !context.file?.toLowerCase().endsWith('.exe')) return;
  const result = checkInstaller(context.file);
  console.log('PASS final Setup installer privacy inventory: ' + JSON.stringify(result));
};
