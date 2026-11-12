// Tests never touch the user's browser registration.
function fakeRegistry() {
  const values = new Map();
  const calls = [];
  return { values, calls, async runReg(args) {
    calls.push(args);
    const [command, key] = args;
    if (command === "add") {
      values.set(key, args[args.indexOf("/d") + 1]);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (command === "query") return { ok: values.has(key), stdout: values.has(key) ? `    (Default)    REG_SZ    ${values.get(key)}\r\n` : "", stderr: "" };
    if (command === "delete") return { ok: values.delete(key), stdout: "", stderr: "" };
    throw new Error("Unexpected registry command");
  } };
}
module.exports = { fakeRegistry };
