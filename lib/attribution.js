// First-party campaign fields for Checkout. Keys are prefixed with attr_ so they
// stay clear of plan, manuals_used, credit_generation, and credit_hold.
// Stripe metadata allows 50 keys, 40-character keys, and 500-character values.
const KEY_PREFIX = 'attr_';
const LATEST_PREFIX = 'attr_latest_';
const VALUE_MAX = 100;
const STRIPE_VALUE_MAX = 500;
const STRIPE_KEY_MAX = 40;
const STRIPE_METADATA_KEYS = 50;
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
const LONG_DIGIT_RUN = /\p{Nd}{9,}/u;
const GCLID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MSCLKID_PATTERN = /^[A-Za-z0-9]+$/;
const CASE_FOLD_KEYS = new Set(['utm_source', 'utm_medium', 'utm_campaign']);
const CASE_FOLD_METADATA = /^attr_(?:latest_)?(?:utm_source|utm_medium|utm_campaign)$/;

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
  const normalized = value.normalize('NFKC');
  if (EMAIL_LIKE.test(normalized)) return true;
  const decoded = decodeOnce(normalized);
  return Boolean(decoded && EMAIL_LIKE.test(decoded.normalize('NFKC')));
}

function digitsOnlySeparatorsRemoved(value) {
  return value.normalize('NFKC').replace(/[^\p{L}\p{Nd}]/gu, '');
}

function hasLongDigitRun(value) {
  if (LONG_DIGIT_RUN.test(digitsOnlySeparatorsRemoved(value))) return true;
  const decoded = decodeOnce(value.normalize('NFKC'));
  if (!decoded) return false;
  return LONG_DIGIT_RUN.test(digitsOnlySeparatorsRemoved(decoded));
}

function isPersonal(value) {
  return looksLikeEmail(value) || hasLongDigitRun(value);
}

function prepareText(value) {
  if (typeof value !== 'string') return '';
  return stripControls(value).trim().normalize('NFKC');
}

function cleanString(value) {
  const stripped = prepareText(value);
  if (!stripped || isPersonal(stripped)) return null;
  const capped = cap(stripped);
  if (!capped || isPersonal(capped)) return null;
  return capped;
}

function normalizeClickId(key, value) {
  const cleaned = prepareText(value);
  if (!cleaned || cleaned.length > STRIPE_VALUE_MAX) return null;
  const pattern = key === 'gclid' ? GCLID_PATTERN : MSCLKID_PATTERN;
  if (!pattern.test(cleaned)) return null;
  return cleaned;
}

function normalizeLandingPath(value) {
  let path = prepareText(value);
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
  if (isPersonal(path)) return null;
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
  const input = prepareText(value);
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
  const cleaned = prepareText(value);
  if (!ISO_TIMESTAMP.test(cleaned)) return null;
  if (!Number.isFinite(Date.parse(cleaned))) return null;
  return cleaned;
}

function foldCampaignValue(value) {
  const folded = value.trim().toLowerCase();
  if (!folded) return null;
  const capped = cap(folded);
  if (!capped || isPersonal(capped)) return null;
  return capped;
}

function fieldValue(key, value) {
  if (typeof value !== 'string') return null;
  if (key === 'gclid' || key === 'msclkid') return normalizeClickId(key, value);
  if (key === 'landing_path') return normalizeLandingPath(value);
  if (key === 'first_seen_at') return normalizeFirstSeen(value);
  if (key === 'referrer_host') return normalizeReferrerHost(value);
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  if (CASE_FOLD_KEYS.has(key)) return foldCampaignValue(cleaned);
  return cleaned;
}

function isTouch(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectTouch(raw, keyPrefix) {
  const fields = {};
  if (!isTouch(raw)) return fields;
  for (const key of ALLOWED_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    let kept = fieldValue(key, raw[key]);
    if (!kept) continue;
    if (CASE_FOLD_KEYS.has(key)) kept = foldCampaignValue(kept);
    if (!kept) continue;
    const metaKey = `${keyPrefix}${key}`;
    if (metaKey.length > STRIPE_KEY_MAX || kept.length > STRIPE_VALUE_MAX) continue;
    fields[metaKey] = kept;
  }
  return fields;
}

function collectAttribution(raw) {
  if (!isTouch(raw)) return {};
  const fields = collectTouch(raw, KEY_PREFIX);
  if (Object.hasOwn(raw, 'latest')) {
    Object.assign(fields, collectTouch(raw.latest, LATEST_PREFIX));
  }
  return fields;
}

function mergeMetadata(existing, fields) {
  const metadata = { ...(existing || {}) };
  for (const [key, value] of Object.entries(fields)) {
    const stored = CASE_FOLD_METADATA.test(key) ? value.trim().toLowerCase() : value;
    if (key.length > STRIPE_KEY_MAX || stored.length > STRIPE_VALUE_MAX) continue;
    if (!Object.hasOwn(metadata, key) && Object.keys(metadata).length >= STRIPE_METADATA_KEYS) continue;
    metadata[key] = stored;
  }
  return metadata;
}

function keptCount(metadata, fields) {
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (metadata && metadata[key] === value) count += 1;
  }
  return count;
}

function withAttribution(params, raw) {
  if (raw === undefined) return params;
  try {
    const fields = collectAttribution(raw);
    if (!params || typeof params !== 'object') {
      console.log('attribution fields kept: 0');
      return params;
    }
    const metadata = mergeMetadata(params.metadata, fields);
    const count = keptCount(metadata, fields);
    console.log(`attribution fields kept: ${count}`);
    if (!count) return params;
    const next = { ...params, metadata };
    if (params.mode === 'subscription') {
      const subscriptionData = params.subscription_data && typeof params.subscription_data === 'object'
        ? params.subscription_data
        : {};
      next.subscription_data = {
        ...subscriptionData,
        metadata: mergeMetadata(subscriptionData.metadata, fields),
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
