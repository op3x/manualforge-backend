const crypto = require('crypto');
const { frontendBase } = require('./config');
const { isStripeNotFound } = require('./billing');
const { requestIp } = require('./client-ip');

// Minimal buyer-access link for cancellation. Open PR #11 emails upload links
// from POST /access-link and opens the portal from a Checkout session id.
// This route emails a portal-only token instead, so the link cannot generate manuals.
// The Stripe account is shared with HTS Atlas. Only a ManualOS brand, price, or
// manualos_* lookup key may receive a cancel email or a portal session.
const PURPOSE = 'billing-portal';
const TOKEN_TTL_MS = 60 * 60 * 1000;
const SESSION_PORTAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_MS = 366 * 24 * 60 * 60 * 1000;
const IP_LIMIT = 10;
const IP_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_LIMIT = 3;
const INVALID_LINK = 'This cancel link is invalid or expired.';
const PORTAL_UNAVAILABLE = 'Cancel links are temporarily unavailable.';
const ONLINE_CANCEL_UNAVAILABLE = 'Online cancellation is temporarily unavailable.';
const ONLINE_CANCEL_LOG = 'ONLINE CANCELLATION UNAVAILABLE: no Billing Portal session can be created and STRIPE_MANAGED_PAYMENTS is off. Email-only cancellation was not offered.';
const SMTP_UNCONFIGURED_WARNING = 'WARNING: SMTP is not configured (set SMTP_HOST and SMTP_FROM). Subscription cancel emails will not be sent.';
const SMTP_SKIP_WARNING = 'WARNING: cancel email skipped: SMTP is not configured (set SMTP_HOST and SMTP_FROM).';
const MP_NO_PORTAL_WARNING = 'WARNING: STRIPE_MANAGED_PAYMENTS is on and no ManualOS Billing Portal configuration is set. Online cancellation will use https://link.com until STRIPE_PORTAL_CONFIGURATION_ID is a ManualOS-only portal configuration.';
const LINK_CANCEL_URL = 'https://link.com';
const LINK_CANCEL_STEPS = [
  'Open https://link.com and sign in with the email on your ManualOS receipt.',
  'Go to Recurring.',
  'Select the subscription. A Sold through Link subscription can be canceled there.',
  'Choose Manage subscription and follow the steps to cancel.',
];

function exposed(status, message, logMessage) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (logMessage) err.logMessage = logMessage;
  return err;
}

function portalSecret(env) {
  if (!env || typeof env !== 'object') return '';
  return String(env.PORTAL_TOKEN_SECRET == null ? '' : env.PORTAL_TOKEN_SECRET).trim();
}

function customerIdOk(value) {
  return typeof value === 'string' && /^cus_[A-Za-z0-9]+$/.test(value);
}

function signPortalToken(customerId, env, now) {
  const key = portalSecret(env);
  if (!key || !customerIdOk(customerId)) return '';
  const at = Number(now);
  const body = Buffer.from(JSON.stringify({
    c: customerId,
    e: at + TOKEN_TTL_MS,
    p: PURPOSE,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyPortalToken(token, env, now) {
  const key = portalSecret(env);
  if (!key || typeof token !== 'string') return '';
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
  const expected = crypto.createHmac('sha256', key).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return '';
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return '';
  }
  if (!payload || payload.p !== PURPOSE || !customerIdOk(payload.c)) return '';
  if (typeof payload.e !== 'number' || !Number.isFinite(payload.e) || payload.e <= Number(now)) return '';
  return payload.c;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254) return '';
  if (/[\u0000-\u001F\u007F]/.test(email)) return '';
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return '';
  const domain = email.slice(at + 1);
  if (!domain || domain.startsWith('.') || domain.endsWith('.') || !domain.includes('.')) return '';
  if (domain.includes('..') || email.slice(0, at).length === 0) return '';
  return email;
}

function customerIdFrom(session) {
  const customer = session && session.customer;
  if (customerIdOk(customer)) return customer;
  if (customer && customerIdOk(customer.id)) return customer.id;
  return '';
}

function subscriptionPlan(plan) {
  const value = String(plan || '').trim().toLowerCase();
  if (!value || value === 'starter' || value === 'overage' || value === 'integrator_overage') return false;
  return value === 'pro'
    || value.startsWith('pro_')
    || value === 'integrator'
    || value.startsWith('integrator_');
}

function sessionOpensPortal(session) {
  if (!session) return false;
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (!paid || !customerIdFrom(session)) return false;
  if (session.mode === 'payment') return false;
  if (session.mode === 'subscription') return true;
  return subscriptionPlan(session.metadata && session.metadata.plan);
}

function sessionCreatedMs(session) {
  const created = session && session.created;
  if (typeof created !== 'number' || !Number.isFinite(created) || created <= 0) return null;
  return created > 1e12 ? created : created * 1000;
}

function sessionWithinPortalWindow(session, now) {
  const created = sessionCreatedMs(session);
  if (created == null) return false;
  const age = Number(now) - created;
  return age >= 0 && age <= SESSION_PORTAL_MAX_AGE_MS;
}

function brandOf(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  return String(metadata.brand == null ? '' : metadata.brand).trim().toLowerCase();
}

function manualosPriceIds(env) {
  const ids = new Set();
  if (!env || typeof env !== 'object') return ids;
  for (const [key, value] of Object.entries(env)) {
    if (!/^STRIPE_PRICE_/i.test(key)) continue;
    const id = String(value == null ? '' : value).trim();
    if (id) ids.add(id);
  }
  return ids;
}

function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  return [];
}

function priceRefsFrom(record) {
  const refs = [];
  if (!record || typeof record !== 'object') return refs;
  const push = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text) refs.push(text);
  };
  push(record.integration_identifier);
  push(record.lookup_key);
  if (record.metadata && typeof record.metadata === 'object') {
    push(record.metadata.integration_identifier);
    push(record.metadata.lookup_key);
  }
  const prices = [];
  if (record.price) prices.push(record.price);
  for (const line of [...rowsOf(record.line_items), ...rowsOf(record.items)]) {
    if (!line || typeof line !== 'object') continue;
    push(line.lookup_key);
    if (line.price) prices.push(line.price);
  }
  for (const price of prices) {
    if (typeof price === 'string') push(price);
    else if (price && typeof price === 'object') {
      push(price.id);
      push(price.lookup_key);
    }
  }
  return refs;
}

function refsMatchManualos(refs, priceIds) {
  return refs.some((ref) => priceIds.has(ref) || /^manualos_/i.test(ref));
}

function explicitForeignBrand(session, subscription) {
  const brands = [brandOf(session && session.metadata), brandOf(subscription && subscription.metadata)];
  return brands.some((brand) => brand && brand !== 'manualos');
}

// Positive ManualOS signal only. metadata.plan is not enough: HTS sessions use plan names too.
function isManualosPurchase(session, subscription, customer, env) {
  const priceIds = manualosPriceIds(env);
  const sessionRefs = priceRefsFrom(session);
  if (explicitForeignBrand(session, subscription)) return refsMatchManualos(sessionRefs, priceIds);
  if (brandOf(session && session.metadata) === 'manualos') return true;
  if (brandOf(subscription && subscription.metadata) === 'manualos') return true;
  if (brandOf(customer && customer.metadata) === 'manualos') return true;
  return refsMatchManualos([...sessionRefs, ...priceRefsFrom(subscription), ...priceRefsFrom(customer)], priceIds);
}

function expanded(value) {
  return value && typeof value === 'object' ? value : null;
}

async function manualosCustomerId(stripe, session, env) {
  if (!sessionOpensPortal(session)) return '';
  let subscription = expanded(session.subscription);
  let customer = expanded(session.customer);
  const priceIds = manualosPriceIds(env);
  if (explicitForeignBrand(session, subscription) && !refsMatchManualos(priceRefsFrom(session), priceIds)) return '';
  if (isManualosPurchase(session, subscription, customer, env)) return customerIdFrom(session);

  if (!subscription && typeof session.subscription === 'string' && stripe && stripe.subscriptions && typeof stripe.subscriptions.retrieve === 'function') {
    try {
      subscription = await stripe.subscriptions.retrieve(session.subscription);
    } catch (err) {
      if (isStripeNotFound(err)) return '';
      throw err;
    }
    if (explicitForeignBrand(session, subscription) && !refsMatchManualos(priceRefsFrom(session), priceIds)) return '';
    if (isManualosPurchase(session, subscription, customer, env)) return customerIdFrom(session);
  }
  const id = customerIdFrom(session);
  if (!customer && id && stripe && stripe.customers && typeof stripe.customers.retrieve === 'function') {
    try {
      customer = await stripe.customers.retrieve(id);
    } catch (err) {
      if (isStripeNotFound(err)) return '';
      throw err;
    }
  }
  return isManualosPurchase(session, subscription, customer, env) ? id : '';
}

async function customerOwnsManualos(stripe, customerId, env) {
  let customer = null;
  if (stripe && stripe.customers && typeof stripe.customers.retrieve === 'function') {
    try {
      customer = await stripe.customers.retrieve(customerId);
    } catch (err) {
      if (isStripeNotFound(err)) return false;
      throw err;
    }
  }
  let listed = null;
  if (stripe && stripe.subscriptions && typeof stripe.subscriptions.list === 'function') {
    const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
    listed = page && Array.isArray(page.data) ? page.data : [];
  }
  if (listed && listed.some((sub) => isManualosPurchase(null, sub, null, env))) return true;
  if (listed && listed.length) return false;
  return brandOf(customer && customer.metadata) === 'manualos';
}

function managedPaymentsOn(env) {
  if (!env || typeof env !== 'object') return false;
  return String(env.STRIPE_MANAGED_PAYMENTS == null ? '' : env.STRIPE_MANAGED_PAYMENTS).trim() === '1';
}

function portalConfigurationValue(env) {
  return String((env && env.STRIPE_PORTAL_CONFIGURATION_ID) || '').trim();
}

function portalConfigurationId(env) {
  const id = portalConfigurationValue(env);
  if (!id || !/^bpc_[A-Za-z0-9]+$/.test(id)) return '';
  return id;
}

function portalConfigurationInvalid(env) {
  const id = portalConfigurationValue(env);
  return Boolean(id) && !/^bpc_[A-Za-z0-9]+$/.test(id);
}

function linkCancelOffer() {
  return {
    method: 'link',
    url: LINK_CANCEL_URL,
    steps: LINK_CANCEL_STEPS.slice(),
    backup: 'email',
  };
}

function renderCancelOffer(offer) {
  if (!offer || typeof offer !== 'object') return '';
  if (offer.method === 'portal') {
    return [
      'Cancel your ManualOS subscription online:',
      '',
      offer.url,
      '',
      'Open that link. It opens the customer portal where you can cancel.',
    ].join('\n');
  }
  if (offer.method === 'link') {
    const steps = (offer.steps || []).map((step, index) => `${index + 1}. ${step}`);
    return [
      'Cancel your ManualOS subscription online:',
      '',
      offer.url,
      '',
      ...steps,
      '',
      'Email is only a backup. If you cannot open the link, reply to this email and ask us to cancel. You do not have to email us when you use the link above.',
    ].join('\n');
  }
  return '';
}

function warnIfManagedPaymentsWithoutPortal(env) {
  if (!managedPaymentsOn(env) || portalConfigurationId(env)) return false;
  console.warn(MP_NO_PORTAL_WARNING);
  return true;
}

async function openCancelPath(stripe, customer, env) {
  if (portalConfigurationInvalid(env)) {
    console.error('STRIPE_PORTAL_CONFIGURATION_ID is not a portal configuration id');
  }
  const configuration = portalConfigurationId(env);
  if (configuration) {
    const base = frontendBase(env);
    if (!base) {
      console.error('FRONTEND_URL is not set');
    } else {
      let portal = null;
      try {
        portal = await stripe.billingPortal.sessions.create({
          customer,
          return_url: `${base}/cancel`,
          configuration,
        });
      } catch (err) {
        console.error('Billing Portal session was not created', err && err.code ? String(err.code) : 'error');
        portal = null;
      }
      if (portal && portal.url) return { method: 'portal', url: portal.url };
      if (portal) console.error('Stripe Billing Portal session did not include a URL');
    }
  }
  if (managedPaymentsOn(env)) {
    const offer = linkCancelOffer();
    return { ...offer, text: renderCancelOffer(offer) };
  }
  throw exposed(503, ONLINE_CANCEL_UNAVAILABLE, ONLINE_CANCEL_LOG);
}

function createHitLimiter({ limit, windowMs, maxKeys = 5000, now }) {
  const hits = new Map();
  return function tooMany(key) {
    const id = key || 'unknown';
    const at = now();
    for (const [existing, stamps] of hits) {
      const recent = stamps.filter((ts) => at - ts < windowMs);
      if (!recent.length) hits.delete(existing);
      else if (recent.length !== stamps.length) hits.set(existing, recent);
    }
    const recent = hits.get(id) || [];
    if (recent.length >= limit) {
      hits.set(id, recent);
      return true;
    }
    if (!hits.has(id) && hits.size >= maxKeys) return true;
    recent.push(at);
    hits.set(id, recent);
    return false;
  };
}

async function customersForEmail(stripe, email, now, env) {
  const listed = await stripe.checkout.sessions.list({
    limit: 10,
    status: 'complete',
    customer_details: { email },
    created: { gte: Math.floor((Number(now) - LOOKBACK_MS) / 1000) },
    expand: ['data.line_items', 'data.subscription', 'data.customer'],
  });
  const rows = listed && Array.isArray(listed.data) ? listed.data : [];
  const ids = [];
  const seen = new Set();
  for (const session of rows) {
    const customer = await manualosCustomerId(stripe, session, env);
    if (!customer || seen.has(customer)) continue;
    seen.add(customer);
    ids.push(customer);
  }
  return ids;
}

function cancelLinks(env, customers, now) {
  const base = frontendBase(env);
  if (!base) return [];
  const links = [];
  for (const customer of customers) {
    const token = signPortalToken(customer, env, now);
    if (!token) continue;
    links.push(`${base}/cancel?token=${encodeURIComponent(token)}`);
  }
  return links;
}

function portalMailText(links) {
  return [
    'Use a link below to manage or cancel your ManualOS subscription. Each link expires in one hour.',
    '',
    ...links,
    '',
    'If you did not ask for this, you can ignore this email.',
  ].join('\n');
}

function warnIfSmtpUnconfigured(env) {
  const host = env && String(env.SMTP_HOST || '').trim();
  const from = env && String(env.SMTP_FROM || '').trim();
  if (host && from) return false;
  console.warn(SMTP_UNCONFIGURED_WARNING);
  return true;
}

async function emailPortalLinks({ stripe, env, mailer, email, now }) {
  if (!stripe) {
    console.error('portal link skipped: STRIPE_SECRET_KEY is not set');
    return;
  }
  if (!portalSecret(env)) return;
  const configuration = portalConfigurationId(env);
  const managed = managedPaymentsOn(env);
  if (!configuration && !managed) {
    console.error(ONLINE_CANCEL_LOG);
    return;
  }
  if (configuration && !frontendBase(env) && !managed) {
    console.error('portal link skipped: FRONTEND_URL is not set');
    return;
  }
  const customers = await customersForEmail(stripe, email, now, env);
  if (!customers.length) return;
  if (configuration && frontendBase(env)) {
    const links = cancelLinks(env, customers, now);
    if (!links.length) return;
    if (!mailer) {
      console.warn(SMTP_SKIP_WARNING);
      return;
    }
    await mailer.sendMail({
      to: email,
      subject: 'Manage your ManualOS subscription',
      text: portalMailText(links),
    });
    return;
  }
  if (!mailer) {
    console.warn(SMTP_SKIP_WARNING);
    return;
  }
  await mailer.sendMail({
    to: email,
    subject: 'Cancel your ManualOS subscription',
    text: renderCancelOffer(linkCancelOffer()),
  });
}

async function customerFromSession(stripe, sessionId, env, now) {
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'subscription', 'customer'],
    });
  } catch (err) {
    if (isStripeNotFound(err)) throw exposed(400, INVALID_LINK);
    throw err;
  }
  if (!sessionWithinPortalWindow(session, now)) throw exposed(400, INVALID_LINK);
  const customer = await manualosCustomerId(stripe, session, env);
  if (!customer) throw exposed(400, INVALID_LINK);
  return customer;
}

async function customerFromPortalRequest(body, env, stripe, now) {
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const token = typeof request.token === 'string' ? request.token.trim() : '';
  const sessionId = typeof request.session_id === 'string' ? request.session_id.trim() : '';
  if (token && !portalSecret(env)) throw exposed(503, PORTAL_UNAVAILABLE, 'PORTAL_TOKEN_SECRET is not set');
  if (!token && !sessionId) throw exposed(400, 'A cancel link is required.');
  if (token && sessionId) throw exposed(400, 'A cancel link is required.');
  let customer = '';
  if (token) {
    customer = verifyPortalToken(token, env, now);
    if (!customer) throw exposed(400, INVALID_LINK);
    if (!(await customerOwnsManualos(stripe, customer, env))) throw exposed(400, INVALID_LINK);
  } else {
    customer = await customerFromSession(stripe, sessionId, env, now);
  }
  const requested = typeof request.customer === 'string' ? request.customer.trim() : '';
  if (requested && requested !== customer) throw exposed(400, INVALID_LINK);
  return customer;
}

function mountBillingPortal(app, { env, stripe, mailer, now, sendError }) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  const pending = new Set();
  function track(work) {
    const run = Promise.resolve().then(work).catch((err) => {
      console.error('portal link failed', err && err.code ? String(err.code) : 'error');
    });
    pending.add(run);
    run.finally(() => pending.delete(run));
  }
  app.settle = () => Promise.all(Array.from(pending));
  const tooManyIp = createHitLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS, now: clock });
  const tooManyEmail = createHitLimiter({ limit: EMAIL_LIMIT, windowMs: IP_WINDOW_MS, now: clock });
  const tooManyPortal = createHitLimiter({ limit: IP_LIMIT, windowMs: IP_WINDOW_MS, now: clock });

  function privateResponse(res) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
  }

  app.post('/access-link', (req, res) => {
    privateResponse(res);
    if (!portalSecret(env)) {
      console.error('PORTAL_TOKEN_SECRET is not set');
      res.status(503).json({ error: PORTAL_UNAVAILABLE });
      return;
    }
    if (tooManyIp(requestIp(req))) {
      res.status(429).json({ error: 'Too many requests. Try again later.' });
      return;
    }
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) {
      res.status(400).json({ error: 'A valid email is required.' });
      return;
    }
    if (tooManyEmail(email)) {
      res.status(429).json({ error: 'Too many requests. Try again later.' });
      return;
    }
    res.status(202).json({ ok: true });
    const at = clock();
    track(() => emailPortalLinks({ stripe, env, mailer, email, now: at }));
  });

  app.post('/billing-portal', async (req, res) => {
    privateResponse(res);
    try {
      if (tooManyPortal(requestIp(req))) {
        return res.status(429).json({ error: 'Too many requests. Try again later.' });
      }
      const request = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const presentedToken = typeof request.token === 'string' ? request.token.trim() : '';
      if (presentedToken && !portalSecret(env)) {
        console.error('PORTAL_TOKEN_SECRET is not set');
        return res.status(503).json({ error: PORTAL_UNAVAILABLE });
      }
      if (!stripe) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      const customer = await customerFromPortalRequest(req.body, env, stripe, clock());
      const offer = await openCancelPath(stripe, customer, env);
      return res.json(offer);
    } catch (err) {
      return sendError(res, err);
    }
  });
}

module.exports = {
  PURPOSE,
  TOKEN_TTL_MS,
  SESSION_PORTAL_MAX_AGE_MS,
  IP_LIMIT,
  EMAIL_LIMIT,
  INVALID_LINK,
  PORTAL_UNAVAILABLE,
  ONLINE_CANCEL_UNAVAILABLE,
  ONLINE_CANCEL_LOG,
  SMTP_UNCONFIGURED_WARNING,
  SMTP_SKIP_WARNING,
  MP_NO_PORTAL_WARNING,
  LINK_CANCEL_URL,
  LINK_CANCEL_STEPS,
  signPortalToken,
  verifyPortalToken,
  normalizeEmail,
  sessionOpensPortal,
  sessionWithinPortalWindow,
  isManualosPurchase,
  customerOwnsManualos,
  managedPaymentsOn,
  linkCancelOffer,
  renderCancelOffer,
  portalMailText,
  warnIfSmtpUnconfigured,
  warnIfManagedPaymentsWithoutPortal,
  mountBillingPortal,
};
