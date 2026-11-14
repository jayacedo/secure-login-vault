const { checkPackagedApp } = require('./package-privacy');
exports.default = async context => {
  const result = checkPackagedApp(context.appOutDir);
  console.log('PASS package privacy: packaged app inventory ' + JSON.stringify(result));
};
