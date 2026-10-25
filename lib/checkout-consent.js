// Records the buyer's Terms and auto-renew checkboxes on Checkout metadata.
// Stripe's consent_collection and custom_text are left untouched: a Managed
// Payments session drops those fields, and the legal record has to stand without them.

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

function applyCheckoutConsent(params, body, context) {
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const ctx = context && typeof context === 'object' ? context : {};
  if (request.termsAccepted !== true) throw exposed(400, 'Terms acceptance is required.');
  const termsVersion = versionOf(request.termsVersion);
  if (!termsVersion) throw exposed(400, 'termsVersion is required.');

  const renewing = renewalRequired(source);
  let disclosureVersion = '';
  if (renewing) {
    if (request.renewalConsent !== true) throw exposed(400, 'Auto-renewal consent is required.');
    disclosureVersion = versionOf(request.disclosureVersion);
    if (!disclosureVersion) throw exposed(400, 'disclosureVersion is required.');
  }

  const when = ctx.now == null ? Date.now() : ctx.now;
  const at = new Date(when).toISOString();
  const ip = consentIp(ctx.ip);
  const next = { ...source };
  next.metadata = { ...(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}) };
  next.metadata.terms_version = termsVersion;
  if (ip) next.metadata.consent_ip = ip;

  if (renewing) {
    next.metadata.disclosure_version = disclosureVersion;
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
      terms_version: termsVersion,
      disclosure_version: disclosureVersion,
      renewal_consent_at: at,
    };
    if (plan) subscription.metadata.plan = plan;
    if (ip) subscription.metadata.consent_ip = ip;
    next.subscription_data = subscription;
  } else {
    next.metadata.terms_consent_at = at;
  }

  return next;
}

module.exports = {
  VERSION_MAX,
  renewalRequired,
  applyCheckoutConsent,
};
