const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CHECKOUT_TOS_VERSION } = require('./checkoutLabels');

const CHECKOUT_TOS_FILE = 'checkout-tos.jsonl';
const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;
let missingDirWarned = false;
let unwritableWarned = false;

function maskCheckoutSessionId(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (value.length <= 4) return 'cs_…';
  const tail = value.slice(-4).replace(/[^A-Za-z0-9]/g, '');
  return tail ? `cs_…${tail}` : 'cs_…';
}

function termsAccepted(session) {
  return Boolean(session && session.consent && session.consent.terms_of_service === 'accepted');
}

function consentRequired(session) {
  return Boolean(session && session.consent_collection && session.consent_collection.terms_of_service === 'required');
}

function metadataTermsVersion(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return '';
  const value = meta.terms_version;
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 80) return '';
  if (/[\u0000-\u001F\u007F]/.test(text)) return '';
  return text;
}

function metadataLabelSha(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const value = meta.tos_label_sha;
  if (typeof value !== 'string' || !/^[a-f0-9]{12}$/.test(value)) return null;
  return value;
}

// Grant when Stripe recorded acceptance, when this session never required the
// checkbox (pre-deploy and Managed Payments), or when metadata.terms_version
// is already set. Deny only a session that required consent and has neither.
function termsAllowAccess(session, paymentIntent, subscription) {
  if (termsAccepted(session)) return true;
  if (metadataTermsVersion(session && session.metadata)) return true;
  if (metadataTermsVersion(paymentIntent && paymentIntent.metadata)) return true;
  if (metadataTermsVersion(subscription && subscription.metadata)) return true;
  return !consentRequired(session);
}

function isTermsUrlConfigError(err) {
  if (!err || typeof err !== 'object') return false;
  const param = typeof err.param === 'string' ? err.param : '';
  const message = typeof err.message === 'string' ? err.message : '';
  const aboutTerms = /terms_of_service/i.test(param) || /terms of service/i.test(message);
  const aboutConfig = /terms_of_service/i.test(param) || /url|public details|account settings|business profile/i.test(message);
  return aboutTerms && aboutConfig;
}

function stringEnv(env, name) {
  if (!env || typeof env !== 'object') return '';
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function defaultDirectory(env) {
  const dedicated = stringEnv(env, 'CHECKOUT_CONSENT_DIR');
  if (dedicated) return dedicated;
  const support = stringEnv(env, 'SUPPORT_DATA_DIR');
  if (support) return support;
  if (String(env && env.NODE_ENV || '').toLowerCase() === 'test') {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-checkout-tos-'));
  }
  if (!missingDirWarned) {
    missingDirWarned = true;
    console.warn('WARNING: CHECKOUT_CONSENT_DIR and SUPPORT_DATA_DIR are not set. Checkout terms records live on disk that Railway wipes on redeploy. Mount a volume and set SUPPORT_DATA_DIR.');
  }
  return path.join(os.tmpdir(), 'manualos-checkout-tos');
}

function planOf(session) {
  const plan = session && session.metadata && session.metadata.plan;
  if (typeof plan !== 'string') return null;
  const value = plan.trim();
  if (!/^[a-z0-9_-]{1,40}$/i.test(value)) return null;
  return value;
}

function sessionKey(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id) || id.length < 16 || id.length > 255) return null;
  return {
    sessionIdHash: crypto.createHash('sha256').update(id, 'utf8').digest('hex'),
    sessionIdLast4: id.slice(-4),
  };
}

function readRows(file) {
  try {
    if (!fs.existsSync(file)) return [];
  } catch {
    return [];
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      // One bad line must not drop the rest of the consent log.
    }
  }
  return rows;
}

function createCheckoutTosStore({ directory, env = process.env, now = () => Date.now() } = {}) {
  const dir = directory || defaultDirectory(env);
  let writable = true;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    writable = false;
    if (!unwritableWarned) {
      unwritableWarned = true;
      const code = err && err.code ? err.code : 'error';
      console.warn(`WARNING: checkout terms directory is not writable (${code})`);
    }
  }
  const file = path.join(dir, CHECKOUT_TOS_FILE);

  function timestampOrNow(timestamp) {
    if (typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return timestamp;
    return new Date(now()).toISOString();
  }

  function recordAccepted(session, timestamp) {
    if (!termsAccepted(session)) return { recorded: false, duplicate: false, plan: null, row: null };
    if (!writable) {
      const err = new Error('Checkout terms directory is not writable');
      err.code = 'consent_dir_unwritable';
      throw err;
    }
    const key = sessionKey(session && session.id);
    if (!key) return { recorded: false, duplicate: false, invalid: true, plan: null, row: null };
    const existing = readRows(file).find((row) => row && (row.sessionIdHash === key.sessionIdHash || row.sessionId === session.id));
    if (existing) {
      return { recorded: false, duplicate: true, plan: existing.plan || null, row: existing };
    }
    const plan = planOf(session);
    const row = {
      consent: { terms_of_service: 'accepted' },
      labelVersion: CHECKOUT_TOS_VERSION,
      plan,
      terms_version: metadataTermsVersion(session.metadata) || null,
      tos_label_sha: metadataLabelSha(session.metadata),
      timestamp: timestampOrNow(timestamp),
      sessionIdHash: key.sessionIdHash,
      sessionIdLast4: key.sessionIdLast4,
    };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // The record is already written. A chmod failure must not drop it.
    }
    return { recorded: true, duplicate: false, plan, row };
  }

  function list() {
    return readRows(file).map((row) => ({ ...row, consent: row.consent ? { ...row.consent } : row.consent }));
  }

  return { recordAccepted, list, directory: dir, filePath: () => file, writable };
}

function eventTimestamp(event, now) {
  const created = event && event.created;
  if (typeof created === 'number' && Number.isFinite(created)) return new Date(created * 1000).toISOString();
  return new Date(now()).toISOString();
}

function consentLabel(value) {
  if (value == null || value === '') return 'missing';
  const shown = String(value).replace(/[^\w.-]/g, '').slice(0, 32);
  return shown || 'missing';
}

function recordCheckoutTos(event, store, now = () => Date.now()) {
  if (!event || event.type !== 'checkout.session.completed') return { status: 'ignored' };
  const session = event.data && event.data.object && typeof event.data.object === 'object' ? event.data.object : {};
  const masked = maskCheckoutSessionId(session.id);
  if (!termsAccepted(session)) {
    if (consentRequired(session) && !metadataTermsVersion(session.metadata)) {
      const value = session.consent && typeof session.consent === 'object' ? session.consent.terms_of_service : undefined;
      console.log(`checkout.session.completed terms_of_service=${consentLabel(value)} session=${masked}; access not granted; left for support`);
      return { status: 'denied' };
    }
    return { status: 'not_required' };
  }
  const result = store.recordAccepted(session, eventTimestamp(event, now));
  if (result.invalid) {
    console.log(`checkout.session.completed terms record skipped session=${masked} reason=session_id`);
    return { status: 'invalid_id' };
  }
  console.log(`checkout.session.completed terms_of_service=accepted session=${masked} plan=${result.plan || 'unknown'} labelVersion=${CHECKOUT_TOS_VERSION}`);
  return { status: 'accepted', row: result.row };
}

module.exports = {
  CHECKOUT_TOS_FILE,
  maskCheckoutSessionId,
  termsAccepted,
  consentRequired,
  termsAllowAccess,
  isTermsUrlConfigError,
  createCheckoutTosStore,
  recordCheckoutTos,
};
