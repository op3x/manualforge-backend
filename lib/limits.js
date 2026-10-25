const UPLOAD_BYTES = 50 * 1024 * 1024;
const JOB_TTL_CAP_MS = 24 * 60 * 60 * 1000;

let jobTtlClampLogged = false;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function jobTtlMs(env = process.env) {
  const raw = env && env.MANUALOS_JOB_TTL_MS;
  if (raw == null || String(raw).trim() === '') return JOB_TTL_CAP_MS;
  const requested = Number(String(raw).trim());
  if (Number.isFinite(requested) && requested > 0 && requested <= JOB_TTL_CAP_MS) return requested;
  if (!jobTtlClampLogged) {
    jobTtlClampLogged = true;
    console.warn('MANUALOS_JOB_TTL_MS was clamped to 24 hours.');
  }
  return JOB_TTL_CAP_MS;
}

function limits(env = process.env) {
  return {
    uploadBytes: num(env.MANUALOS_MAX_UPLOAD_BYTES, UPLOAD_BYTES),
    zipMaxFiles: num(env.MANUALOS_ZIP_MAX_FILES, 80),
    zipMaxBytes: num(env.MANUALOS_ZIP_MAX_BYTES, 200 * 1024 * 1024),
    zipMaxDepth: num(env.MANUALOS_ZIP_MAX_DEPTH, 2),
    zipMaxRatio: num(env.MANUALOS_ZIP_MAX_RATIO, 200),
    acdMaxMs: num(env.MANUALOS_ACD_MAX_MS, 2000),
    acdConvertMs: num(env.MANUALOS_ACD_CONVERT_MS, 120000),
    acdMaxGzip: num(env.MANUALOS_ACD_MAX_GZIP, 25),
    aiConcurrency: num(env.MANUALOS_AI_CONCURRENCY, 3),
    aiRetries: num(env.MANUALOS_AI_RETRIES, 2),
    maxPromptTokens: num(env.MANUALOS_MAX_PROMPT_TOKENS, 80000),
    jobTtlMs: jobTtlMs(env),
  };
}

module.exports = { UPLOAD_BYTES, JOB_TTL_CAP_MS, limits };
