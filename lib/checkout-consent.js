// Records the buyer's Terms and auto-renew checkboxes on Checkout metadata.
// Stripe's consent_collection and custom_text are left untouched: a Managed
// Payments session drops those fields, and the legal record has to stand without them.
// CHECKOUT_REQUIRE_CONSENT defaults off so this can deploy before the frontend checkbox.

const VERSION_MAX = 80;

function exposed(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function versionOf(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > VERSION_MAX) return '';
  if (/[\u0000-\u001F\u007F]/.test(text)) return '';
  return text;
}

function consentIp(value) {
  if (typeof value !== 'string') return '';
  const ip = value.trim();
  if (!ip) return '';
  return ip.slice(0, 64);
}

function renewalRequired(params) {
  return Boolean(params && params.mode === 'subscription');
}

function consentEnforced(env) {
  if (!env || typeof env !== 'object') return false;
  return String(env.CHECKOUT_REQUIRE_CONSENT == null ? '' : env.CHECKOUT_REQUIRE_CONSENT).trim() === '1';
}

function readConsent(request, renewing) {
  if (request.termsAccepted !== true) return { error: 'Terms acceptance is required.' };
  const termsVersion = versionOf(request.termsVersion);
  if (!termsVersion) return { error: 'termsVersion is required.' };
  if (!renewing) return { termsVersion };
  if (request.renewalConsent !== true) return { error: 'Auto-renewal consent is required.' };
  const disclosureVersion = versionOf(request.disclosureVersion);
  if (!disclosureVersion) return { error: 'disclosureVersion is required.' };
  return { termsVersion, disclosureVersion };
}

function applyCheckoutConsent(params, body, context) {
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const renewing = renewalRequired(source);
  const parsed = readConsent(request, renewing);
  if (parsed.error) {
    if (consentEnforced(ctx.env)) throw exposed(400, parsed.error);
    return source;
  }

  const when = ctx.now == null ? Date.now() : ctx.now;
  const at = new Date(when).toISOString();
  const ip = consentIp(ctx.ip);
  const next = { ...source };
  next.metadata = { ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}) };
  next.metadata.terms_version = parsed.termsVersion;
  if (ip) next.metadata.consent_ip = ip;

  if (renewing) {
    next.metadata.disclosure_version = parsed.disclosureVersion;
    next.metadata.renewal_consent_at = at;
    const existing = source.subscription_data && typeof source.subscription_data === 'object' && !Array.isArray(source.subscription_data)
      ? source.subscription_data
      : {};
    const prior = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? existing.metadata
      : {};
    const plan = prior.plan || next.metadata.plan || '';
    const subscription = { ...existing };
    subscription.metadata = {
      ...prior,
      terms_version: parsed.termsVersion,
      disclosure_version: parsed.disclosureVersion,
      renewal_consent_at: at,
    };
    if (plan) subscription.metadata.plan = plan;
    if (ip) subscription.metadata.consent_ip = ip;
    next.subscription_data = subscription;
  } else {
    next.metadata.terms_consent_at = at;
    const existing = source.payment_intent_data && typeof source.payment_intent_data === 'object' && !Array.isArray(source.payment_intent_data)
      ? source.payment_intent_data
      : {};
    const prior = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? existing.metadata
      : {};
    const plan = prior.plan || next.metadata.plan || '';
    const payment = { ...existing };
    payment.metadata = {
      ...prior,
      terms_version: parsed.termsVersion,
      terms_consent_at: at,
    };
    if (plan) payment.metadata.plan = plan;
    if (ip) payment.metadata.consent_ip = ip;
    next.payment_intent_data = payment;
  }

  return next;
}

// Shared Stripe account with HTS Atlas. New sessions carry this brand so the
// cancel routes can ignore every other product on the customer.
function withManualosBrand(params) {
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const next = { ...source };
  next.metadata = { ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}), brand: 'manualos' };
  if (source.subscription_data && typeof source.subscription_data === 'object' && !Array.isArray(source.subscription_data)) {
    const prior = source.subscription_data.metadata && typeof source.subscription_data.metadata === 'object'
      ? source.subscription_data.metadata
      : {};
    next.subscription_data = { ...source.subscription_data, metadata: { ...prior, brand: 'manualos' } };
  }
  if (source.payment_intent_data && typeof source.payment_intent_data === 'object' && !Array.isArray(source.payment_intent_data)) {
    const prior = source.payment_intent_data.metadata && typeof source.payment_intent_data.metadata === 'object'
      ? source.payment_intent_data.metadata
      : {};
    next.payment_intent_data = { ...source.payment_intent_data, metadata: { ...prior, brand: 'manualos' } };
  }
  return next;
}

module.exports = {
  VERSION_MAX,
  renewalRequired,
  consentEnforced,
  applyCheckoutConsent,
  withManualosBrand,
};
