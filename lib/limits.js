const UPLOAD_BYTES = 50 * 1024 * 1024;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    jobTtlMs: num(env.MANUALOS_JOB_TTL_MS, 24 * 60 * 60 * 1000),
  };
}

module.exports = { UPLOAD_BYTES, limits };
