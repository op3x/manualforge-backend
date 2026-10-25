const crypto = require('crypto');
const { frontendBase, starterCreditAllowance } = require('./config');
const { planFromSession, planRecord } = require('./plans');

const creditLocks = new Map();

function withCreditLock(key, fn) {
  const prev = creditLocks.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  creditLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

const ACTIVE_SUBSCRIPTION = new Set(['active', 'trialing']);
const BLOCKED_SUBSCRIPTION = new Set(['unpaid', 'canceled', 'incomplete_expired', 'incomplete', 'paused']);
const PORTAL_STATUSES = new Set(['active', 'trialing', 'past_due', 'canceled']);
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const HOLD_LIMIT = 8;

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
  const record = planRecord(plan);
  if (!record || !record.mode || !record.priceEnv || !record.integrationId) {
    throw exposed(400, 'plan must be "starter" or "pro"');
  }
  const price = env[record.priceEnv];
  if (!price) {
    throw exposed(500, 'Checkout is temporarily unavailable.', `${record.priceEnv} is not set`);
  }
  const base = frontendBase(env);
  if (!base) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'FRONTEND_URL is not set');
  }
  const params = {
    mode: record.mode,
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/upload.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/#pricing`,
    metadata: { plan: record.name },
    integration_identifier: record.integrationId,
  };
  if (record.kind === 'credit') {
    params.payment_intent_data = {
      metadata: { plan: record.name, manuals_used: '0' },
    };
  } else if (record.kind === 'subscription') {
    params.subscription_data = { metadata: { plan: record.name } };
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
  const plan = planFromSession(session);
  if (!plan) {
    return {
      valid: false,
      plan: null,
      remaining: null,
      paymentIntentId: null,
      paymentIssue: false,
      portal: false,
      reason: null,
      kind: null,
    };
  }
  if (plan.kind === 'credit') {
    const paid = session.payment_status === 'paid';
    const used = parseManualsUsed(paymentIntent && paymentIntent.metadata && paymentIntent.metadata.manuals_used);
    const remaining = Math.max(0, starterCreditAllowance(env) - used);
    return {
      valid: Boolean(paid && paymentIntent && paymentIntent.id),
      plan: plan.name,
      remaining: paid ? remaining : null,
      paymentIntentId: paymentIntent && paymentIntent.id ? paymentIntent.id : null,
      paymentIssue: false,
      portal: Boolean(plan.portal && paid),
      reason: null,
      kind: 'credit',
    };
  }
  if (plan.kind === 'subscription') {
    const status = subscription && subscription.status;
    const paymentIssue = status === 'past_due';
    let valid = ACTIVE_SUBSCRIPTION.has(status);
    if (status === 'past_due') valid = pastDueWithinGrace(subscription, now);
    if (BLOCKED_SUBSCRIPTION.has(status)) valid = false;
    let reason = null;
    if (status === 'past_due') reason = 'payment_failed';
    else if (status === 'canceled') reason = 'canceled';
    return {
      valid,
      plan: plan.name,
      remaining: null,
      paymentIntentId: null,
      paymentIssue,
      portal: Boolean(plan.portal && PORTAL_STATUSES.has(status)),
      reason,
      kind: 'subscription',
    };
  }
  return {
    valid: false,
    plan: plan.name,
    remaining: null,
    paymentIntentId: null,
    paymentIssue: false,
    portal: false,
    reason: null,
    kind: plan.kind,
  };
}

async function verifyCheckoutSession(stripe, sessionId, env, now = Date.now()) {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent', 'subscription'],
  });
  const plan = planFromSession(session);
  const paymentIntent = plan && plan.kind === 'credit' ? await loadPaymentIntent(stripe, session.payment_intent) : null;
  const subscription = plan && plan.kind === 'subscription' ? await loadSubscription(stripe, session.subscription) : null;
  return accessFromSession(session, paymentIntent, subscription, env, now);
}

function publicAccess(access) {
  const body = {
    valid: Boolean(access && access.valid),
    access: Boolean(access && access.valid),
    plan: access ? access.plan : null,
    remaining: access ? access.remaining : null,
    portal: Boolean(access && access.portal),
  };
  if (access && access.paymentIssue) body.payment_issue = true;
  if (access && access.reason) body.reason = access.reason;
  return body;
}

function customerIdFrom(session) {
  const customer = session && session.customer;
  if (typeof customer === 'string' && customer) return customer;
  if (customer && typeof customer.id === 'string' && customer.id) return customer.id;
  return null;
}

function billingPortalParams(session, env) {
  const plan = planFromSession(session);
  if (plan && !plan.portal) {
    throw exposed(400, 'Billing portal is available for Pro subscriptions.');
  }
  const customer = customerIdFrom(session);
  const paid = session && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
  if (!plan || !plan.portal || !customer || !paid || !session.id) {
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
  if (access.kind === 'credit' && !(access.remaining > 0)) {
    throw exposed(402, access.plan === 'starter' ? 'Starter credits are used up.' : 'Credits are used up.');
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

function parseHolds(value) {
  const holds = new Map();
  if (typeof value !== 'string' || !value) return holds;
  for (const part of value.split(',')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const jobId = part.slice(0, idx);
    const token = part.slice(idx + 1);
    if (!jobId || !token || jobId.includes(':')) continue;
    holds.set(jobId, token);
  }
  return holds;
}

function formatHolds(holds) {
  return [...holds.entries()].map(([jobId, token]) => `${jobId}:${token}`).join(',');
}

function holdMatch(meta, jobId, token) {
  const holds = parseHolds(meta && meta.credit_holds);
  const inMap = Boolean(jobId && holds.get(jobId) === token);
  const legacy = Boolean(meta && meta.credit_hold === token);
  return { holds, inMap, legacy };
}

async function reserveStarterCredit(stripe, paymentIntentId, env, jobId) {
  if (!jobId || String(jobId).includes(':') || String(jobId).includes(',')) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Starter credit reserve is missing a job id');
  }
  const allowance = starterCreditAllowance(env);
  return withCreditLock(paymentIntentId, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await stripe.paymentIntents.retrieve(paymentIntentId);
      const meta = (current && current.metadata) || {};
      const used = parseManualsUsed(meta.manuals_used);
      if (used >= allowance) throw exposed(402, 'Starter credits are used up.');
      const holds = parseHolds(meta.credit_holds);
      if (!holds.has(jobId) && holds.size >= HOLD_LIMIT) {
        throw exposed(409, 'Could not reserve a Starter credit. Please retry.');
      }
      const generation = parseManualsUsed(meta.credit_generation);
      const next = used + 1;
      const nextGen = String(generation + 1);
      const token = crypto.randomBytes(8).toString('hex');
      holds.set(jobId, token);
      await stripe.paymentIntents.update(paymentIntentId, {
        metadata: {
          manuals_used: String(next),
          credit_generation: nextGen,
          credit_holds: formatHolds(holds),
        },
      });
      const check = await stripe.paymentIntents.retrieve(paymentIntentId);
      const confirmed = (check && check.metadata) || {};
      const confirmedHolds = parseHolds(confirmed.credit_holds);
      if (
        confirmedHolds.get(jobId) === token
        && confirmed.manuals_used === String(next)
        && confirmed.credit_generation === nextGen
      ) {
        return { paymentIntentId, token, jobId, manualsUsed: next };
      }
    }
    throw exposed(409, 'Could not reserve a Starter credit. Please retry.');
  });
}

async function refundStarterCredit(stripe, paymentIntentId, token, jobId) {
  if (!paymentIntentId || !token) return null;
  return withCreditLock(paymentIntentId, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await stripe.paymentIntents.retrieve(paymentIntentId);
      const meta = (current && current.metadata) || {};
      const match = holdMatch(meta, jobId, token);
      if (!match.inMap && !match.legacy) return parseManualsUsed(meta.manuals_used);
      if (match.inMap) match.holds.delete(jobId);
      const used = parseManualsUsed(meta.manuals_used);
      const next = Math.max(0, used - 1);
      const nextGen = String(parseManualsUsed(meta.credit_generation) + 1);
      const metadata = {
        manuals_used: String(next),
        credit_generation: nextGen,
        credit_holds: formatHolds(match.holds),
      };
      if (match.legacy || !meta.credit_hold) metadata.credit_hold = '';
      await stripe.paymentIntents.update(paymentIntentId, { metadata });
      const check = await stripe.paymentIntents.retrieve(paymentIntentId);
      const confirmed = (check && check.metadata) || {};
      const confirmedMatch = holdMatch(confirmed, jobId, token);
      if (
        confirmed.manuals_used === String(next)
        && !confirmedMatch.inMap
        && !confirmedMatch.legacy
      ) return next;
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
