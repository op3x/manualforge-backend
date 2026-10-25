// Checkout Session ids are cs_test_… or cs_live_…. Anything else is rejected
// before a Stripe retrieve so a bad query, body, or header cannot amplify lookups.
const SESSION_ID_MAX = 255;
const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]+$/;

function sessionIdOk(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SESSION_ID_MAX
    && SESSION_ID_RE.test(value);
}

function maskSessionId(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= 4) return '****';
  return text.slice(-4);
}

// Invalid ids are not a fixed shape. Drop everything outside [A-Za-z0-9]
// before the last four, so a quote or newline cannot land in the log.
function invalidSessionSuffix(value) {
  const text = typeof value === 'string' ? value : '';
  const cleaned = text.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length <= 4) return '****';
  return cleaned.slice(-4);
}

function invalidSessionId(value) {
  const err = new Error('Session id is invalid.');
  err.status = 400;
  err.expose = true;
  err.publicCode = 'invalid_session_id';
  err.logMessage = `Rejected session id (...${invalidSessionSuffix(value)})`;
  return err;
}

function assertSessionId(value) {
  if (!sessionIdOk(value)) throw invalidSessionId(value);
  return value;
}

module.exports = {
  SESSION_ID_MAX,
  SESSION_ID_RE,
  sessionIdOk,
  maskSessionId,
  invalidSessionSuffix,
  assertSessionId,
};
