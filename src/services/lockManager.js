// Enforces auto-lock in the main process. The renderer only reports settings
// and user activity; the timers live here so a hung, throttled or tampered page
// cannot keep the vault unlocked past its policy.

const DEFAULT_POLICY = Object.freeze({
  idleSeconds: 0, // 0 = inactivity lock off
  backgroundGraceSeconds: 10 // null = off, 0 = lock immediately
});

const MAX_IDLE_SECONDS = 24 * 60 * 60;
const MAX_BACKGROUND_SECONDS = 60 * 60;

function isWholeNumberInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// Returns a clean policy object or throws; never trusts the caller's shape.
function normalizePolicy(input) {
  const source = input && typeof input === "object" ? input : null;
  if (!source) {
    throw new Error("Invalid lock policy.");
  }

  const idleSeconds = source.idleSeconds;
  const background = source.backgroundGraceSeconds;

  if (!isWholeNumberInRange(idleSeconds, 0, MAX_IDLE_SECONDS)) {
    throw new Error("Invalid inactivity lock setting.");
  }
  if (background !== null && !isWholeNumberInRange(background, 0, MAX_BACKGROUND_SECONDS)) {
    throw new Error("Invalid background lock setting.");
  }

  return { idleSeconds, backgroundGraceSeconds: background };
}

function createLockManager({ onLock, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let policy = { ...DEFAULT_POLICY };
  let unlocked = false;
  let idleTimer = null;
  let backgroundTimer = null;

  function clearIdle() {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  }

  function clearBackground() {
    if (backgroundTimer !== null) clearTimer(backgroundTimer);
    backgroundTimer = null;
  }

  function lockNow(reason) {
    clearIdle();
    clearBackground();
    if (!unlocked) return;
    unlocked = false;
    onLock(reason);
  }

  function armIdle() {
    clearIdle();
    if (!unlocked || !policy.idleSeconds) return;
    idleTimer = setTimer(() => lockNow("inactivity"), policy.idleSeconds * 1000);
  }

  return {
    getPolicy() {
      return { ...policy };
    },

    setPolicy(next) {
      policy = normalizePolicy(next);
      armIdle();
      if (policy.backgroundGraceSeconds === null) clearBackground();
    },

    // Call when the vault becomes unlocked (true) or locked by any path (false).
    setUnlocked(value) {
      unlocked = Boolean(value);
      clearBackground();
      if (unlocked) {
        armIdle();
      } else {
        clearIdle();
      }
    },

    noteActivity() {
      if (unlocked) armIdle();
    },

    windowBackgrounded() {
      if (!unlocked || policy.backgroundGraceSeconds === null) return;
      clearBackground();
      if (policy.backgroundGraceSeconds === 0) {
        lockNow("background");
      } else {
        backgroundTimer = setTimer(() => lockNow("background"), policy.backgroundGraceSeconds * 1000);
      }
    },

    windowForegrounded() {
      clearBackground();
    },

    dispose() {
      unlocked = false;
      clearIdle();
      clearBackground();
    }
  };
}

module.exports = { createLockManager, normalizePolicy, DEFAULT_POLICY };
