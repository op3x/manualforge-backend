function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const kept = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
      if (kept.length >= limit) {
        hits.set(key, kept);
        return false;
      }
      kept.push(t);
      hits.set(key, kept);
      return true;
    },
  };
}

module.exports = { createRateLimiter };
