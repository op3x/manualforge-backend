const crypto = require('crypto');
const { INTEGRATION_IDS, frontendBase, starterCreditAllowance } = require('./config');

const creditLocks = new Map();

function withCreditLock(key, fn) {
  const prev = creditLocks.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  creditLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

const ACTIVE_SUBSCRIPTION = new Set(['active', 'trialing']);
const BLOCKED_SUBSCRIPTION = new Set(['unpaid', 'canceled', 'incomplete_expired', 'incomplete', 'paused']);
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function exposed(status, message, logMessage) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (logMessage) err.logMessage = logMessage;
  return err;
}

function parseManualsUsed(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function isStripeNotFound(err) {
  if (!err) return false;
  return err.statusCode === 404 || err.code === 'resource_missing';
}

function checkoutParams(plan, env) {
  if (plan !== 'starter' && plan !== 'pro') {
    throw exposed(400, 'plan must be "starter" or "pro"');
  }
  const priceEnv = plan === 'starter' ? 'STRIPE_PRICE_STARTER' : 'STRIPE_PRICE_PRO';
  const price = env[priceEnv];
  if (!price) {
    throw exposed(500, 'Checkout is temporarily unavailable.', `${priceEnv} is not set`);
  }
  const base = frontendBase(env);
  if (!base) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'FRONTEND_URL is not set');
  }
  const params = {
    mode: plan === 'starter' ? 'payment' : 'subscription',
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/upload.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/#pricing`,
    metadata: { plan },
    integration_identifier: INTEGRATION_IDS[plan],
  };
  if (plan === 'starter') {
    params.payment_intent_data = {
      metadata: { plan: 'starter', manuals_used: '0' },
    };
  } else {
    params.subscription_data = { metadata: { plan: 'pro' } };
  }
  return params;
}

async function loadPaymentIntent(stripe, paymentIntent) {
  if (!paymentIntent) return null;
  if (typeof paymentIntent === 'string') return stripe.paymentIntents.retrieve(paymentIntent);
  return paymentIntent;
}

async function loadSubscription(stripe, subscription) {
  if (!subscription) return null;
  if (typeof subscription === 'string') {
    return stripe.subscriptions.retrieve(subscription, { expand: ['latest_invoice'] });
  }
  if (subscription.status === 'past_due' && typeof subscription.latest_invoice === 'string') {
    const invoice = await stripe.invoices.retrieve(subscription.latest_invoice);
    return { ...subscription, latest_invoice: invoice };
  }
  return subscription;
}

function unixMs(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function failedInvoicePeriodStartMs(subscription) {
  if (!subscription || typeof subscription !== 'object') return null;
  const invoice = subscription.latest_invoice;
  if (invoice && typeof invoice === 'object') {
    const fromInvoice = unixMs(invoice.period_start);
    if (fromInvoice != null) return fromInvoice;
    const lines = invoice.lines && (Array.isArray(invoice.lines) ? invoice.lines : invoice.lines.data);
    if (Array.isArray(lines)) {
      for (const line of lines) {
        const start = line && line.period && unixMs(line.period.start);
        if (start != null) return start;
      }
    }
  }
  return unixMs(subscription.current_period_start);
}

function pastDueWithinGrace(subscription, now = Date.now()) {
  if (!subscription || subscription.status !== 'past_due') return false;
  const start = failedInvoicePeriodStartMs(subscription);
  if (start == null) return false;
  return now >= start && now < start + GRACE_MS;
}

function accessFromSession(session, paymentIntent, subscription, env, now = Date.now()) {
  const plan = session.metadata && session.metadata.plan;
  if (plan === 'starter') {
    const paid = session.payment_status === 'paid';
    const used = parseManualsUsed(paymentIntent && paymentIntent.metadata && paymentIntent.metadata.manuals_used);
    const remaining = Math.max(0, starterCreditAllowance(env) - used);
    return {
      valid: Boolean(paid && paymentIntent && paymentIntent.id),
      plan: 'starter',
      remaining: paid ? remaining : null,
      paymentIntentId: paymentIntent && paymentIntent.id ? paymentIntent.id : null,
      paymentIssue: false,
    };
  }
  if (plan === 'pro') {
    const status = subscription && subscription.status;
    const paymentIssue = status === 'past_due';
    let valid = ACTIVE_SUBSCRIPTION.has(status);
    if (status === 'past_due') valid = pastDueWithinGrace(subscription, now);
    if (BLOCKED_SUBSCRIPTION.has(status)) valid = false;
    return {
      valid,
      plan: 'pro',
      remaining: null,
      paymentIntentId: null,
      paymentIssue,
    };
  }
  return { valid: false, plan: null, remaining: null, paymentIntentId: null, paymentIssue: false };
}

async function verifyCheckoutSession(stripe, sessionId, env, now = Date.now()) {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent', 'subscription'],
  });
  const plan = session.metadata && session.metadata.plan;
  const paymentIntent = plan === 'starter' ? await loadPaymentIntent(stripe, session.payment_intent) : null;
  const subscription = plan === 'pro' ? await loadSubscription(stripe, session.subscription) : null;
  return accessFromSession(session, paymentIntent, subscription, env, now);
}

function publicAccess(access) {
  const body = {
    valid: Boolean(access.valid),
    plan: access.plan,
    remaining: access.remaining,
  };
  if (access && access.paymentIssue) body.payment_issue = true;
  return body;
}

function customerIdFrom(session) {
  const customer = session && session.customer;
  if (typeof customer === 'string' && customer) return customer;
  if (customer && typeof customer.id === 'string' && customer.id) return customer.id;
  return null;
}

function billingPortalParams(session, env) {
  const plan = session && session.metadata && session.metadata.plan;
  if (plan === 'starter') {
    throw exposed(400, 'Billing portal is available for Pro subscriptions.');
  }
  const customer = customerIdFrom(session);
  const paid = session && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
  if (plan !== 'pro' || !customer || !paid || !session.id) {
    throw exposed(402, 'Payment required. This checkout session is not valid.');
  }
  const base = frontendBase(env);
  if (!base) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'FRONTEND_URL is not set');
  }
  return {
    customer,
    return_url: `${base}/upload.html?session_id=${encodeURIComponent(session.id)}`,
  };
}

async function assertCanGenerate(stripe, sessionId, env, now = Date.now()) {
  if (!sessionId) {
    throw exposed(402, 'Payment required. Provide session_id in the form body or the X-Session-Id header.');
  }
  if (!stripe) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'STRIPE_SECRET_KEY is not set');
  }
  let access;
  try {
    access = await verifyCheckoutSession(stripe, sessionId, env, now);
  } catch (err) {
    if (isStripeNotFound(err)) {
      throw exposed(402, 'Payment required. This checkout session is not valid.');
    }
    throw err;
  }
  if (!access.valid) {
    throw exposed(402, 'Payment required. This checkout session is not an active paid plan.');
  }
  if (access.plan === 'starter' && !(access.remaining > 0)) {
    throw exposed(402, 'Starter credits are used up.');
  }
  return access;
}

async function recordStarterManual(stripe, paymentIntentId) {
  return withCreditLock(paymentIntentId, async () => {
    const current = await stripe.paymentIntents.retrieve(paymentIntentId);
    const used = parseManualsUsed(current.metadata && current.metadata.manuals_used);
    const next = used + 1;
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: { manuals_used: String(next) },
    });
    return next;
  });
}

async function reserveStarterCredit(stripe, paymentIntentId, env) {
  const allowance = starterCreditAllowance(env);
  return withCreditLock(paymentIntentId, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await stripe.paymentIntents.retrieve(paymentIntentId);
      const meta = (current && current.metadata) || {};
      const used = parseManualsUsed(meta.manuals_used);
      if (used >= allowance) throw exposed(402, 'Starter credits are used up.');
      const generation = parseManualsUsed(meta.credit_generation);
      const next = used + 1;
      const nextGen = String(generation + 1);
      const token = crypto.randomBytes(8).toString('hex');
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: {
          manuals_used: String(next),
          credit_generation: nextGen,
          credit_hold: token,
        },
      });
      const check = await stripe.paymentIntents.retrieve(paymentIntentId);
      const confirmed = (check && check.metadata) || {};
      if (confirmed.credit_hold === token && confirmed.manuals_used === String(next) && confirmed.credit_generation === nextGen) {
        return { paymentIntentId, token, manualsUsed: next };
      }
    }
    throw exposed(409, 'Could not reserve a Starter credit. Please retry.');
  });
}

async function refundStarterCredit(stripe, paymentIntentId, token) {
  if (!paymentIntentId || !token) return null;
  return withCreditLock(paymentIntentId, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await stripe.paymentIntents.retrieve(paymentIntentId);
      const meta = (current && current.metadata) || {};
      if (meta.credit_hold !== token) return parseManualsUsed(meta.manuals_used);
      const used = parseManualsUsed(meta.manuals_used);
      const next = Math.max(0, used - 1);
      const nextGen = String(parseManualsUsed(meta.credit_generation) + 1);
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: {
          manuals_used: String(next),
          credit_generation: nextGen,
          credit_hold: '',
        },
      });
      const check = await stripe.paymentIntents.retrieve(paymentIntentId);
      const confirmed = (check && check.metadata) || {};
      if (confirmed.manuals_used === String(next) && confirmed.credit_hold !== token) return next;
    }
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Starter credit refund did not commit');
  });
}

module.exports = {
  GRACE_MS,
  parseManualsUsed,
  isStripeNotFound,
  checkoutParams,
  failedInvoicePeriodStartMs,
  pastDueWithinGrace,
  accessFromSession,
  verifyCheckoutSession,
  publicAccess,
  billingPortalParams,
  assertCanGenerate,
  recordStarterManual,
  reserveStarterCredit,
  refundStarterCredit,
  withCreditLock,
};
