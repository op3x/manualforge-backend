const { exposed } = require('./errors');

const JOB_TOO_LARGE_MESSAGE = 'This project is too large for one manual. Split it into smaller uploads (for example one area or machine at a time) and try again. Your credit was not used.';
const GENERATION_PAUSED_MESSAGE = 'Manual generation is paused for a short while. Your credit was not used. Please try again later or email support@manualos.com.';
const CHECKOUT_PAUSED_MESSAGE = 'Checkout is paused for a short while. Please try again later or email support@manualos.com.';

function jobTooLargeError() {
  const err = exposed(422, JOB_TOO_LARGE_MESSAGE);
  err.code = 'job_too_large';
  return err;
}

function generationPausedError() {
  const err = exposed(503, GENERATION_PAUSED_MESSAGE);
  err.code = 'generation_paused';
  return err;
}

function stopsTheJob(err) {
  return Boolean(err && (
    err.code === 'job_too_large'
    || err.code === 'generation_paused'
    || err.code === 'model_call_timeout'
    || err.budgetFatal
    || err.modelCallTimeout
  ));
}

module.exports = {
  JOB_TOO_LARGE_MESSAGE,
  GENERATION_PAUSED_MESSAGE,
  CHECKOUT_PAUSED_MESSAGE,
  jobTooLargeError,
  generationPausedError,
  stopsTheJob,
};
