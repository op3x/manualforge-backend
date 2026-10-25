const MIN_JOB_TIMEOUT_MS = 60 * 1000;
const MAX_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;

const JOB_TIMEOUT_MESSAGE = 'This run took too long and was stopped. It did not use a credit. Please try again.';

let warned = false;

function warnJobTimeout() {
  if (warned) return;
  warned = true;
  console.warn('WARNING: MANUALOS_JOB_TIMEOUT_MS is outside 1 to 30 minutes and was adjusted.');
}

function jobTimeoutMs(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source.MANUALOS_JOB_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_JOB_TIMEOUT_MS;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < MIN_JOB_TIMEOUT_MS || n > MAX_JOB_TIMEOUT_MS) {
    warnJobTimeout();
    if (!Number.isFinite(n)) return DEFAULT_JOB_TIMEOUT_MS;
    return Math.min(MAX_JOB_TIMEOUT_MS, Math.max(MIN_JOB_TIMEOUT_MS, n));
  }
  return n;
}

module.exports = {
  MIN_JOB_TIMEOUT_MS,
  MAX_JOB_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  JOB_TIMEOUT_MESSAGE,
  jobTimeoutMs,
};
