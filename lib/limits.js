const UPLOAD_BYTES = 25 * 1024 * 1024;
const ZIP_UNPACKED_BYTES = 100 * 1024 * 1024;
const JOB_TTL_CAP_MS = 24 * 60 * 60 * 1000;
const MODEL_CALL_TIMEOUT_MS = 2 * 60 * 1000;

let jobTtlClampLogged = false;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function whole(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function nonNegative(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function flagOn(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function switchOn(value) {
  if (value == null) return false;
  const raw = String(value).trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

function formatByteSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 bytes';
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n % 1024 === 0) return `${n / 1024} KB`;
  return `${n} bytes`;
}

function uploadTooLargeMessage(bytes) {
  return `This file is too large. The maximum upload is ${formatByteSize(bytes)}.`;
}

function unpackedTooLargeMessage(bytes) {
  return `The archive expands too far and was rejected. The maximum unpacked size is ${formatByteSize(bytes)}.`;
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
    zipMaxBytes: num(env.MANUALOS_ZIP_MAX_BYTES, ZIP_UNPACKED_BYTES),
    zipMaxDepth: num(env.MANUALOS_ZIP_MAX_DEPTH, 2),
    zipMaxRatio: num(env.MANUALOS_ZIP_MAX_RATIO, 200),
    acdMaxMs: num(env.MANUALOS_ACD_MAX_MS, 2000),
    acdConvertMs: num(env.MANUALOS_ACD_CONVERT_MS, 120000),
    acdMaxGzip: num(env.MANUALOS_ACD_MAX_GZIP, 25),
    aiConcurrency: num(env.MANUALOS_AI_CONCURRENCY, 3),
    aiRetries: whole(env.MANUALOS_AI_RETRIES, 2),
    maxPromptTokens: num(env.MANUALOS_MAX_PROMPT_TOKENS, 80000),
    jobMaxCalls: num(env.MANUALOS_JOB_MAX_CALLS, 60),
    jobMaxTokens: num(env.MANUALOS_JOB_MAX_TOKENS, 1500000),
    modelCallTimeoutMs: num(env.MANUALOS_MODEL_CALL_TIMEOUT_MS, MODEL_CALL_TIMEOUT_MS),
    aiMonthlyBudgetUsd: nonNegative(env.MANUALOS_AI_MONTHLY_BUDGET_USD, 20),
    aiInputUsdPerMtok: nonNegative(env.MANUALOS_AI_INPUT_USD_PER_MTOK, 0.1),
    aiOutputUsdPerMtok: nonNegative(env.MANUALOS_AI_OUTPUT_USD_PER_MTOK, 0.5),
    checkoutPaused: switchOn(env.MANUALOS_CHECKOUT_DISABLED),
    generationPaused: switchOn(env.MANUALOS_GENERATION_DISABLED),
    jobTtlMs: jobTtlMs(env),
  };
}

module.exports = {
  UPLOAD_BYTES,
  ZIP_UNPACKED_BYTES,
  JOB_TTL_CAP_MS,
  MODEL_CALL_TIMEOUT_MS,
  limits,
  flagOn,
  switchOn,
  formatByteSize,
  uploadTooLargeMessage,
  unpackedTooLargeMessage,
};
