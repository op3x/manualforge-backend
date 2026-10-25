// First-party campaign fields for Checkout. Keys are prefixed with attr_ so they
// stay clear of plan, manuals_used, credit_generation, and credit_hold.
// Stripe allows 40-character keys and 500-character values; we store at most 100.
const KEY_PREFIX = 'attr_';
const VALUE_MAX = 100;
const ALLOWED_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'landing_path',
  'first_seen_at',
  'referrer_host',
  'gclid',
  'msclkid',
];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+/;
const LONG_DIGIT_RUN = /\d{9,}/;

function stripControls(value) {
  return value.replace(/\p{Cc}/gu, '');
}

function cap(value) {
  if (value.length <= VALUE_MAX) return value;
  let end = VALUE_MAX;
  const tail = value.charCodeAt(end - 1);
  if (tail >= 0xD800 && tail <= 0xDBFF) end -= 1;
  return value.slice(0, end);
}

function decodeOnce(value) {
  if (!value.includes('%')) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? null : decoded;
  } catch {
    return null;
  }
}

function looksLikeEmail(value) {
  const normalized = value.replace(/\uFF20/g, '@');
  if (EMAIL_LIKE.test(normalized)) return true;
  const decoded = decodeOnce(normalized);
  return Boolean(decoded && EMAIL_LIKE.test(decoded.replace(/\uFF20/g, '@')));
}

function hasLongDigitRun(value) {
  if (LONG_DIGIT_RUN.test(value)) return true;
  const compact = value.replace(/[\s().+-]/g, '');
  if (/^\d{9,}$/.test(compact)) return true;
  const decoded = decodeOnce(value);
  if (!decoded) return false;
  if (LONG_DIGIT_RUN.test(decoded)) return true;
  return /^\d{9,}$/.test(decoded.replace(/[\s().+-]/g, ''));
}

function isPersonal(value) {
  return looksLikeEmail(value) || hasLongDigitRun(value);
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const stripped = stripControls(value).trim();
  if (!stripped || isPersonal(stripped)) return null;
  const capped = cap(stripped);
  if (!capped || isPersonal(capped)) return null;
  return capped;
}

function normalizeLandingPath(value) {
  let path = stripControls(value).trim();
  if (!path) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
    try {
      const url = new URL(path.startsWith('//') ? `https:${path}` : path);
      if (url.username || url.password) return null;
      path = url.pathname || '/';
    } catch {
      return null;
    }
  } else {
    const hash = path.indexOf('#');
    if (hash !== -1) path = path.slice(0, hash);
    const query = path.indexOf('?');
    if (query !== -1) path = path.slice(0, query);
    path = path.trim();
    if (!path.startsWith('/')) {
      const slash = path.indexOf('/');
      if (slash <= 0) return null;
      const head = path.slice(0, slash);
      if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(head) || !head.includes('.')) return null;
      path = path.slice(slash);
    }
  }
  if (!path.startsWith('/') || /[\\?#@]/.test(path) || path.includes('://')) return null;
  path = cap(path);
  if (!path.startsWith('/') || isPersonal(path)) return null;
  return path;
}

function isPlausibleHost(host) {
  if (!host || host.length > VALUE_MAX) return false;
  if (host === 'localhost') return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':') && /^[0-9a-f:]+$/i.test(host)) return true;
  return /^[a-z0-9.-]+$/i.test(host)
    && host.includes('.')
    && !host.startsWith('.')
    && !host.endsWith('.')
    && !host.includes('..');
}

function normalizeReferrerHost(value) {
  const input = stripControls(value).trim();
  if (!input) return null;
  if (!input.includes('://') && !input.startsWith('//') && looksLikeEmail(input)) return null;
  try {
    let toParse = input;
    if (toParse.startsWith('//')) toParse = `https:${toParse}`;
    else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(toParse)) toParse = `http://${toParse}`;
    const url = new URL(toParse);
    if (url.username || url.password) return null;
    const host = url.hostname;
    if (!isPlausibleHost(host) || hasLongDigitRun(host)) return null;
    return host;
  } catch {
    return null;
  }
}

function normalizeFirstSeen(value) {
  const cleaned = stripControls(value).trim();
  if (!ISO_TIMESTAMP.test(cleaned)) return null;
  if (!Number.isFinite(Date.parse(cleaned))) return null;
  return cleaned;
}

function fieldValue(key, value) {
  if (typeof value !== 'string') return null;
  if (key === 'landing_path') return normalizeLandingPath(value);
  if (key === 'first_seen_at') return normalizeFirstSeen(value);
  if (key === 'referrer_host') return normalizeReferrerHost(value);
  return cleanString(value);
}

function collectAttribution(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const fields = {};
  for (const key of ALLOWED_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const kept = fieldValue(key, raw[key]);
    if (!kept) continue;
    const metaKey = `${KEY_PREFIX}${key}`;
    if (metaKey.length > 40 || kept.length > VALUE_MAX) continue;
    fields[metaKey] = kept;
  }
  return fields;
}

function withAttribution(params, raw) {
  if (raw === undefined) return params;
  try {
    const fields = collectAttribution(raw);
    const count = Object.keys(fields).length;
    console.log(`attribution fields kept: ${count}`);
    if (!count || !params || typeof params !== 'object') return params;
    const next = {
      ...params,
      metadata: { ...(params.metadata || {}), ...fields },
    };
    if (params.mode === 'subscription') {
      const subscriptionData = params.subscription_data && typeof params.subscription_data === 'object'
        ? params.subscription_data
        : {};
      next.subscription_data = {
        ...subscriptionData,
        metadata: { ...(subscriptionData.metadata || {}), ...fields },
      };
    }
    return next;
  } catch {
    console.log('attribution fields kept: 0');
    return params;
  }
}

module.exports = {
  ALLOWED_KEYS,
  KEY_PREFIX,
  VALUE_MAX,
  withAttribution,
};
