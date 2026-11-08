const assert = require("assert");
const { createLockManager, normalizePolicy } = require("../src/services/lockManager");

// Fake clock: timers fire only when we advance time.
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    pending: () => timers.size
  };
}

function setup(policy) {
  const clock = createClock();
  const locks = [];
  const manager = createLockManager({
    onLock: (reason) => locks.push(reason),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  if (policy) manager.setPolicy(policy);
  return { clock, locks, manager };
}

const SEC = 1000;

// --- policy validation
assert.deepEqual(normalizePolicy({ idleSeconds: 300, backgroundGraceSeconds: null }), {
  idleSeconds: 300,
  backgroundGraceSeconds: null
});
for (const bad of [
  null,
  undefined,
  "x",
  {},
  { idleSeconds: -1, backgroundGraceSeconds: 10 },
  { idleSeconds: 1.5, backgroundGraceSeconds: 10 },
  { idleSeconds: "300", backgroundGraceSeconds: 10 },
  { idleSeconds: 999999, backgroundGraceSeconds: 10 },
  { idleSeconds: 0, backgroundGraceSeconds: -5 },
  { idleSeconds: 0, backgroundGraceSeconds: undefined },
  { idleSeconds: 0, backgroundGraceSeconds: "10" }
]) {
  assert.throws(() => normalizePolicy(bad), undefined, JSON.stringify(bad));
}

// --- inactivity lock fires after the idle time
{
  const { clock, locks, manager } = setup({ idleSeconds: 300, backgroundGraceSeconds: null });
  manager.setUnlocked(true);
  clock.advance(299 * SEC);
  assert.deepEqual(locks, []);
  clock.advance(1 * SEC);
  assert.deepEqual(locks, ["inactivity"]);
}

// --- activity restarts the idle timer
{
  const { clock, locks, manager } = setup({ idleSeconds: 300, backgroundGraceSeconds: null });
  manager.setUnlocked(true);
  clock.advance(200 * SEC);
  manager.noteActivity();
  clock.advance(200 * SEC);
  assert.deepEqual(locks, [], "activity should have reset the timer");
  clock.advance(100 * SEC);
  assert.deepEqual(locks, ["inactivity"]);
}

// --- idle disabled / vault locked => nothing fires
{
  const { clock, locks, manager } = setup({ idleSeconds: 0, backgroundGraceSeconds: null });
  manager.setUnlocked(true);
  clock.advance(10 * 60 * 60 * SEC);
  assert.deepEqual(locks, []);
  assert.equal(clock.pending(), 0);

  manager.setPolicy({ idleSeconds: 300, backgroundGraceSeconds: null });
  manager.setUnlocked(false);
  manager.noteActivity();
  clock.advance(600 * SEC);
  assert.deepEqual(locks, [], "a locked vault is never re-locked");
}

// --- changing the policy while unlocked re-arms the timer
{
  const { clock, locks, manager } = setup({ idleSeconds: 0, backgroundGraceSeconds: null });
  manager.setUnlocked(true);
  manager.setPolicy({ idleSeconds: 300, backgroundGraceSeconds: null });
  clock.advance(300 * SEC);
  assert.deepEqual(locks, ["inactivity"]);
}

// --- background lock: grace period, cancelled by foreground
{
  const { clock, locks, manager } = setup({ idleSeconds: 0, backgroundGraceSeconds: 10 });
  manager.setUnlocked(true);
  manager.windowBackgrounded();
  clock.advance(5 * SEC);
  manager.windowForegrounded();
  clock.advance(60 * SEC);
  assert.deepEqual(locks, [], "returning in time cancels the lock");

  manager.windowBackgrounded();
  clock.advance(10 * SEC);
  assert.deepEqual(locks, ["background"]);
}

// --- background lock: instant, disabled, and locked-vault cases
{
  const { locks, manager } = setup({ idleSeconds: 0, backgroundGraceSeconds: 0 });
  manager.setUnlocked(true);
  manager.windowBackgrounded();
  assert.deepEqual(locks, ["background"]);
  manager.windowBackgrounded();
  assert.deepEqual(locks, ["background"], "already locked, no repeat");
}
{
  const { clock, locks, manager } = setup({ idleSeconds: 0, backgroundGraceSeconds: null });
  manager.setUnlocked(true);
  manager.windowBackgrounded();
  clock.advance(3600 * SEC);
  assert.deepEqual(locks, []);
}

// --- the lock fires only once, and unlocking again re-arms everything
{
  const { clock, locks, manager } = setup({ idleSeconds: 300, backgroundGraceSeconds: 10 });
  manager.setUnlocked(true);
  clock.advance(300 * SEC);
  clock.advance(300 * SEC);
  assert.deepEqual(locks, ["inactivity"]);
  assert.equal(clock.pending(), 0);

  manager.setUnlocked(true);
  clock.advance(300 * SEC);
  assert.deepEqual(locks, ["inactivity", "inactivity"]);
}

// --- dispose stops everything
{
  const { clock, locks, manager } = setup({ idleSeconds: 300, backgroundGraceSeconds: 10 });
  manager.setUnlocked(true);
  manager.windowBackgrounded();
  manager.dispose();
  clock.advance(3600 * SEC);
  assert.deepEqual(locks, []);
  assert.equal(clock.pending(), 0);
}

console.log("lock-manager tests passed");
