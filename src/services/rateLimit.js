// A sliding-window counter: at most `max` takes within any `windowMs`.
// Used to keep a misbehaving (or stolen-secret) caller from pulling passwords out in bulk.
function createRateLimiter({ max, windowMs, now = Date.now }) {
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new Error("A positive max and windowMs are required.");
  }
  let times = [];

  return {
    // True when the call may go ahead (and is counted); false when over the limit.
    take() {
      const time = now();
      times = times.filter((t) => time - t < windowMs);
      if (times.length >= max) return false;
      times.push(time);
      return true;
    }
  };
}

module.exports = { createRateLimiter };
