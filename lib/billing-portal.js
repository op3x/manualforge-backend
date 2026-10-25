const crypto = require('crypto');
const { frontendBase } = require('./config');
const { isStripeNotFound } = require('./billing');
const { requestIp } = require('./client-ip');

// Minimal buyer-access link for cancellation. Open PR #11 emails upload links
// from POST /access-link and opens the portal from a Checkout session id.
// This route emails a portal-only token instead, so the link cannot generate manuals.
const PURPOSE = 'billing-portal';
const TOKEN_TTL_MS = 60 * 60 * 1000;
const LOOKBACK_MS = 366 * 24 * 60 * 60 * 1000;
const IP_LIMIT = 10;
const IP_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_LIMIT = 3;
const INVALID_LINK = 'This cancel link is invalid or expired.';

function exposed(status, message, logMessage) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (logMessage) err.logMessage = logMessage;
  return err;
}

function tokenKey(env) {
  const dedicated = env && String(env.PORTAL_TOKEN_SECRET || '').trim();
  if (dedicated) return dedicated;
  return env && String(env.STRIPE_WEBHOOK_SECRET || '').trim();
}

function customerIdOk(value) {
  return typeof value === 'string' && /^cus_[A-Za-z0-9]+$/.test(value);
}

function signPortalToken(customerId, env, now) {
  const key = tokenKey(env);
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
  const key = tokenKey(env);
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

function portalConfiguration(env) {
  const id = String((env && env.STRIPE_PORTAL_CONFIGURATION_ID) || '').trim();
  if (!id) return '';
  if (!/^bpc_[A-Za-z0-9]+$/.test(id)) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'STRIPE_PORTAL_CONFIGURATION_ID is not a portal configuration id');
  }
  return id;
}

function portalParams(customer, env) {
  const base = frontendBase(env);
  if (!base) throw exposed(500, 'Checkout is temporarily unavailable.', 'FRONTEND_URL is not set');
  const params = {
    customer,
    return_url: `${base}/cancel`,
  };
  const configuration = portalConfiguration(env);
  if (configuration) params.configuration = configuration;
  return params;
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

async function customersForEmail(stripe, email, now) {
  const listed = await stripe.checkout.sessions.list({
    limit: 10,
    status: 'complete',
    customer_details: { email },
    created: { gte: Math.floor((Number(now) - LOOKBACK_MS) / 1000) },
  });
  const rows = listed && Array.isArray(listed.data) ? listed.data : [];
  const ids = [];
  const seen = new Set();
  for (const session of rows) {
    if (!sessionOpensPortal(session)) continue;
    const customer = customerIdFrom(session);
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

async function emailPortalLinks({ stripe, env, mailer, email, now }) {
  if (!mailer) {
    console.log('portal link skipped: SMTP not configured');
    return;
  }
  if (!stripe) {
    console.error('portal link skipped: STRIPE_SECRET_KEY is not set');
    return;
  }
  if (!tokenKey(env)) {
    console.error('portal link skipped: PORTAL_TOKEN_SECRET is not set');
    return;
  }
  if (!frontendBase(env)) {
    console.error('portal link skipped: FRONTEND_URL is not set');
    return;
  }
  const customers = await customersForEmail(stripe, email, now);
  const links = cancelLinks(env, customers, now);
  if (!links.length) return;
  await mailer.sendMail({
    to: email,
    subject: 'Manage your ManualOS subscription',
    text: portalMailText(links),
  });
}

async function customerFromSession(stripe, sessionId) {
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (isStripeNotFound(err)) throw exposed(400, INVALID_LINK);
    throw err;
  }
  if (!sessionOpensPortal(session)) throw exposed(400, INVALID_LINK);
  return customerIdFrom(session);
}

async function customerFromPortalRequest(body, env, stripe, now) {
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const token = typeof request.token === 'string' ? request.token.trim() : '';
  const sessionId = typeof request.session_id === 'string' ? request.session_id.trim() : '';
  if (!token && !sessionId) throw exposed(400, 'A cancel link is required.');
  if (token && sessionId) throw exposed(400, 'A cancel link is required.');
  const customer = token
    ? verifyPortalToken(token, env, now)
    : await customerFromSession(stripe, sessionId);
  if (!customer) throw exposed(400, INVALID_LINK);
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
      if (!stripe) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      const customer = await customerFromPortalRequest(req.body, env, stripe, clock());
      const params = portalParams(customer, env);
      let portal;
      try {
        portal = await stripe.billingPortal.sessions.create(params);
      } catch (err) {
        if (isStripeNotFound(err)) throw exposed(400, INVALID_LINK);
        throw err;
      }
      if (!portal || !portal.url) {
        console.error('Stripe Billing Portal session did not include a URL');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      return res.json({ url: portal.url });
    } catch (err) {
      return sendError(res, err);
    }
  });
}

module.exports = {
  PURPOSE,
  TOKEN_TTL_MS,
  IP_LIMIT,
  EMAIL_LIMIT,
  INVALID_LINK,
  signPortalToken,
  verifyPortalToken,
  normalizeEmail,
  sessionOpensPortal,
  mountBillingPortal,
};
