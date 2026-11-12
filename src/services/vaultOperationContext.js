const { AsyncLocalStorage } = require("async_hooks");
const context = new AsyncLocalStorage();
function currentVaultOperation() { return context.getStore(); }
function assertVaultOperationActive() { currentVaultOperation()?.check(); }
function beforeVaultCommit() {
  const operation = currentVaultOperation();
  if (!operation) return;
  // Once replacing a file has begun, finish/roll back the matching auth/database
  // pair even if the UI locks. Never return secrets or restart a session afterward.
  if (!operation.committing) { operation.check(); operation.committing = true; }
}
function trackVaultBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) currentVaultOperation()?.buffers.add(buffer);
  return buffer;
}
module.exports = { currentVaultOperation, assertVaultOperationActive, beforeVaultCommit, trackVaultBuffer,
  runVaultOperation: (operation, fn) => context.run(operation, fn) };
