const assert = require("assert/strict");
const { createSensitiveClipboard } = require("../src/services/sensitiveClipboard");
function setup() {
  let text = "unrelated synthetic text", unlocked = true, epoch = 0, next = 0;
  const timers = new Map(), calls = [];
  const clipboard = {
    readText: async () => { calls.push("read"); return text; },
    writeText: async value => { calls.push("write"); text = value; },
    clear: async () => { calls.push("clear"); text = ""; }
  };
  const service = createSensitiveClipboard({ clipboard,
    vault: { isUnlocked: () => unlocked, getOperationEpoch: () => epoch },
    setTimer: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimer: id => timers.delete(id) });
  return { service, clipboard, calls, timers, get text() { return text; },
    replace: value => { text = value; }, lock: () => { unlocked = false; epoch++; return service.clear(); },
    expire: async () => { for (const [id, t] of [...timers]) { timers.delete(id); await t.fn(); } } };
}
const secret = { text: "Synthetic password", sensitive: true, delayMs: 30000 };
async function main() {
  let test = setup();
  await test.service.clear(); assert.deepEqual(test.calls, [], "no owned value means no clipboard access");
  await test.service.copy(secret); await test.expire(); assert.equal(test.text, "");
  test = setup(); await test.service.copy(secret); test.replace("later unrelated copy");
  await test.expire(); assert.equal(test.text, "later unrelated copy");
  test = setup(); await test.service.copy(secret);
  await test.service.copy({ text: "synthetic URL", sensitive: false, delayMs: 0 });
  await test.expire(); await test.lock(); assert.equal(test.text, "synthetic URL");
  test = setup(); await test.service.copy({ ...secret, delayMs: 0 });
  assert.equal(test.timers.size, 0); await test.lock(); assert.equal(test.text, "", "lock clears even when timeout is off");
  test = setup(); await test.lock(); await assert.rejects(test.service.copy(secret)); assert.deepEqual(test.calls, []);
  for (const payload of [null, {}, { ...secret, delayMs: -1 }, { ...secret, delayMs: 300001 }, { ...secret, sensitive: 1 }, { ...secret, text: "x".repeat(262145) }]) {
    test = setup(); await assert.rejects(test.service.copy(payload)); assert.deepEqual(test.calls, []);
  }
  test = setup();
  let begin, finish;
  const started = new Promise(resolve => { begin = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  const write = test.clipboard.writeText;
  test.clipboard.writeText = async value => { begin(); await held; await write(value); };
  const pending = test.service.copy(secret); const rejected = assert.rejects(pending);
  await started; const cleanup = test.lock(); finish(); await rejected; await cleanup;
  assert.equal(test.text, "", "late writes cannot survive locking");
  // An old timer can fire while a later async write is still pending. Its queued
  // cleanup must not clear the new value or cancel that value's timer.
  test = setup(); await test.service.copy(secret);
  const oldExpiry = [...test.timers.values()][0].fn;
  let entered, resume;
  const writing = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const nextWrite = test.clipboard.writeText;
  test.clipboard.writeText = async value => { entered(); await gate; await nextWrite(value); };
  const laterCopy = test.service.copy({ ...secret, text: "second synthetic secret" });
  await writing; const oldCleanup = oldExpiry(); resume(); await laterCopy; await oldCleanup;
  assert.equal(test.text, "second synthetic secret"); assert.equal(test.timers.size, 1);
  await test.expire(); assert.equal(test.text, "");
  test = setup();
  await test.service.copy(secret);
  test.clipboard.readText = async () => { throw Error("synthetic OS failure"); };
  await test.service.clear(); assert.equal(test.timers.size, 0, "cleanup failures handled without retaining timer");
  test = setup(); test.clipboard.writeText = async () => { throw Error("synthetic OS failure"); };
  await assert.rejects(test.service.copy(secret), /Could not copy/);
  console.log("PASS synthetic clipboard expiry, replacement, lock, cancellation, validation and OS errors; no OS clipboard accessed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
