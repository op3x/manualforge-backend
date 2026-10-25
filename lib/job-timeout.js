const MIN_JOB_TIMEOUT_MS = 60 * 1000;
const MAX_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;

const JOB_TIMEOUT_MESSAGE = 'This run took too long and was stopped. Please try again.';
const CREDIT_RETURN_MESSAGE = "This run didn't finish, so your credit is being returned. If it isn't back in your balance, email support@manualos.com and we'll restore it.";

let warned = false;

function warnJobTimeout(requested, clamped) {
  if (warned) return;
  warned = true;
  console.warn(`WARNING: MANUALOS_JOB_TIMEOUT_MS ${requested} is outside 1 to 30 minutes and was adjusted to ${clamped}.`);
}

function jobTimeoutMs(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source.MANUALOS_JOB_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_JOB_TIMEOUT_MS;
  const requested = String(raw).trim();
  const n = Number(requested);
  if (!Number.isFinite(n) || n < MIN_JOB_TIMEOUT_MS || n > MAX_JOB_TIMEOUT_MS) {
    const clamped = !Number.isFinite(n)
      ? DEFAULT_JOB_TIMEOUT_MS
      : Math.min(MAX_JOB_TIMEOUT_MS, Math.max(MIN_JOB_TIMEOUT_MS, n));
    warnJobTimeout(requested, clamped);
    return clamped;
  }
  return n;
}

module.exports = {
  MIN_JOB_TIMEOUT_MS,
  MAX_JOB_TIMEOUT_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  JOB_TIMEOUT_MESSAGE,
  CREDIT_RETURN_MESSAGE,
  jobTimeoutMs,
};
