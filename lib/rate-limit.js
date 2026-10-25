function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  let lastSweep = 0;

  function evict(t) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [key, stamps] of hits) {
      const kept = stamps.filter((ts) => t - ts < windowMs);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }

  return {
    size() {
      return hits.size;
    },
    allow(key) {
      const t = now();
      evict(t);
      const kept = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
      if (kept.length >= limit) {
        hits.set(key, kept);
        return false;
      }
      if (kept.length === 0) hits.delete(key);
      kept.push(t);
      hits.set(key, kept);
      return true;
    },
  };
}

module.exports = { createRateLimiter };
