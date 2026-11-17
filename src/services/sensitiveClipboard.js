// Main-process clipboard lifecycle. No clipboard contents are returned to the UI.
function createSensitiveClipboard({ clipboard, vault, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let work = Promise.resolve(), copied = null, timer = null, generation = 0, revision = 0;
  const fail = () => Object.assign(new Error("Could not copy. Unlock the vault and try again."), { isPublic: true });
  function queue(operation) {
    const result = work.then(operation);
    work = result.catch(() => {});
    return result;
  }
  function cancelTimer() { if (timer !== null) clearTimer(timer); timer = null; }
  async function clearCopied() {
    cancelTimer();
    revision++;
    try {
      // Preserve subsequent clipboard text copied by the user or another app.
      if (copied !== null && await clipboard.readText() === copied) await clipboard.clear();
    } finally { copied = null; }
  }
  function clear() {
    generation++;
    return queue(clearCopied).catch(() => {});
  }
  async function copy(payload) {
    if (!payload || typeof payload.text !== "string" || payload.text.length > 262144 ||
        typeof payload.sensitive !== "boolean" || !Number.isInteger(payload.delayMs) ||
        payload.delayMs < 0 || payload.delayMs > 300000) throw fail();
    const { text, sensitive, delayMs } = payload;
    const epoch = vault.getOperationEpoch(), request = generation;
    const active = () => vault.isUnlocked() && epoch === vault.getOperationEpoch() && request === generation;
    return queue(async () => {
      if (!active()) throw fail();
      try {
        await clipboard.writeText(text);
        cancelTimer(); copied = sensitive ? text : null;
        const copyRevision = ++revision;
        if (!active()) {
          // Even a non-sensitive write must not finish after its session ended.
          copied = text; await clearCopied(); throw fail();
        }
        if (sensitive && delayMs > 0) {
          timer = setTimer(() => queue(() => {
            if (revision === copyRevision) return clearCopied();
          }).catch(() => {}), delayMs);
          timer?.unref?.();
        }
        return { copied: true };
      } catch { throw fail(); }
    });
  }
  return { copy, clear };
}
module.exports = { createSensitiveClipboard };
