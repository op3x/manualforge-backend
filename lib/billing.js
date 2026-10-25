const crypto = require('crypto');
const { INTEGRATION_IDS, frontendBase, starterCreditAllowance } = require('./config');
const { BRAND } = require('./stripeBrand');
const { readPeriodAccess, readPeriodReason } = require('./period-access');
const { assertSessionId } = require('./session-id');

const creditLocks = new Map();

function withCreditLock(key, fn) {
  const prev = creditLocks.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  creditLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

// past_due is Stripe's retry window. Access stays on until the subscription
// is unpaid, canceled, or incomplete_expired (or another non-entitled status).
const ENTITLED_SUBSCRIPTION = new Set(['active', 'trialing', 'past_due']);

function exposed(status, message, logMessage, publicCode) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (logMessage) err.logMessage = logMessage;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

const STARTER_REFUNDED_MESSAGE = 'This purchase was refunded, so it can no longer generate manuals. Contact support@manualos.com.';
const STARTER_SUSPENDED_MESSAGE = 'This purchase is suspended because of a payment dispute, so it can no longer generate manuals. Contact support@manualos.com.';
const STARTER_DISPUTE_LOST_MESSAGE = 'This purchase was lost in a payment dispute, so it can no longer generate manuals. Contact support@manualos.com.';
const PRO_REFUNDED_MESSAGE = 'This billing period was refunded, so it can no longer generate manuals until the next paid invoice. Contact support@manualos.com.';
const PRO_SUSPENDED_MESSAGE = 'This billing period is suspended because of a payment dispute, so it can no longer generate manuals. Contact support@manualos.com.';
const PRO_DISPUTE_LOST_MESSAGE = 'This subscription was lost in a payment dispute, so it can no longer generate manuals. Contact support@manualos.com.';

function parseManualsUsed(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function starterCreditStatus(metadata) {
  const value = metadata && metadata.credit_status;
  if (value === 'revoked' || value === 'suspended') return value;
  return 'active';
}

function starterRevokeReason(metadata) {
  if (metadata && metadata.credit_revoke_reason === 'dispute') return 'dispute';
  return 'refund';
}

function starterRevokedMessage(metadata) {
  if (starterRevokeReason(metadata) === 'dispute') return STARTER_DISPUTE_LOST_MESSAGE;
  return STARTER_REFUNDED_MESSAGE;
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
    metadata: { plan, brand: BRAND },
    integration_identifier: INTEGRATION_IDS[plan],
  };
  if (plan === 'starter') {
    params.customer_creation = 'always';
    params.payment_intent_data = {
      metadata: { plan: 'starter', brand: BRAND, manuals_used: '0' },
    };
  } else {
    params.subscription_data = { metadata: { plan: 'pro', brand: BRAND } };
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
  if (typeof subscription === 'string') return stripe.subscriptions.retrieve(subscription);
  return subscription;
}

function stripeObjectId(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value.id === 'string' && value.id) return value.id;
  return null;
}

function accessFromSession(session, paymentIntent, subscription, env) {
  const plan = session.metadata && session.metadata.plan;
  if (plan === 'starter') {
    const paid = session.payment_status === 'paid';
    const used = parseManualsUsed(paymentIntent && paymentIntent.metadata && paymentIntent.metadata.manuals_used);
    const remaining = Math.max(0, starterCreditAllowance(env) - used);
    // Checkout payment_status stays "paid" after a refund. credit_status is
    // what revokes or suspends the remaining manuals. A partial refund does
    // not set it, so those credits stay usable.
    const creditStatus = starterCreditStatus(paymentIntent && paymentIntent.metadata);
    const blocked = creditStatus !== 'active';
    return {
      valid: Boolean(paid && paymentIntent && paymentIntent.id) && !blocked,
      plan: 'starter',
      remaining: paid ? (blocked ? 0 : remaining) : null,
      paymentIntentId: paymentIntent && paymentIntent.id ? paymentIntent.id : null,
      creditStatus,
      creditRevokeReason: creditStatus === 'revoked' ? starterRevokeReason(paymentIntent && paymentIntent.metadata) : null,
      customerId: stripeObjectId(session.customer) || stripeObjectId(paymentIntent && paymentIntent.customer),
      subscriptionId: null,
      billingIssue: false,
    };
  }
  if (plan && plan !== 'starter') {
    const status = subscription && subscription.status;
    const periodAccess = readPeriodAccess(subscription);
    return {
      valid: ENTITLED_SUBSCRIPTION.has(status) && periodAccess === 'active',
      plan,
      remaining: null,
      paymentIntentId: null,
      periodAccess,
      periodRevokeReason: periodAccess === 'revoked' ? readPeriodReason(subscription) : null,
      customerId: stripeObjectId(subscription && subscription.customer) || stripeObjectId(session.customer),
      subscriptionId: stripeObjectId(subscription) || stripeObjectId(session.subscription),
      billingIssue: status === 'past_due',
    };
  }
  return {
    valid: false,
    plan: null,
    remaining: null,
    paymentIntentId: null,
    customerId: null,
    subscriptionId: null,
    billingIssue: false,
  };
}

async function verifyCheckoutSession(stripe, sessionId, env) {
  assertSessionId(sessionId);
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent', 'subscription'],
  });
  const plan = session.metadata && session.metadata.plan;
  const paymentIntent = plan === 'starter' ? await loadPaymentIntent(stripe, session.payment_intent) : null;
  const subscription = plan && plan !== 'starter' ? await loadSubscription(stripe, session.subscription) : null;
  return accessFromSession(session, paymentIntent, subscription, env);
}

function blockForAccess(access) {
  if (!access) return null;
  if (access.plan === 'starter' && access.creditStatus === 'revoked') {
    return { status: 402, message: access.creditRevokeReason === 'dispute' ? STARTER_DISPUTE_LOST_MESSAGE : STARTER_REFUNDED_MESSAGE };
  }
  if (access.plan === 'starter' && access.creditStatus === 'suspended') {
    return { status: 402, message: STARTER_SUSPENDED_MESSAGE };
  }
  if (access.plan && access.plan !== 'starter' && access.periodAccess === 'revoked') {
    return { status: 402, message: access.periodRevokeReason === 'dispute' ? PRO_DISPUTE_LOST_MESSAGE : PRO_REFUNDED_MESSAGE };
  }
  if (access.plan && access.plan !== 'starter' && access.periodAccess === 'suspended') {
    return { status: 402, message: PRO_SUSPENDED_MESSAGE };
  }
  return null;
}

async function accessBlock(stripe, sessionId, env) {
  if (!sessionId || !stripe) return null;
  try {
    const access = await verifyCheckoutSession(stripe, sessionId, env);
    return blockForAccess(access);
  } catch (err) {
    if (isStripeNotFound(err)) return { status: 402, message: 'Payment required. This checkout session is not valid.' };
    throw err;
  }
}

function publicAccess(access) {
  return {
    valid: Boolean(access && access.valid),
    plan: access ? access.plan : null,
    remaining: access ? access.remaining : null,
    billingIssue: Boolean(access && access.billingIssue),
  };
}

async function assertCanGenerate(stripe, sessionId, env) {
  if (!sessionId) {
    throw exposed(402, 'Payment required. Provide session_id in the form body or the X-Session-Id header.');
  }
  if (!stripe) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'STRIPE_SECRET_KEY is not set');
  }
  let access;
  try {
    access = await verifyCheckoutSession(stripe, sessionId, env);
  } catch (err) {
    if (isStripeNotFound(err)) {
      throw exposed(404, 'No purchase was found for this session.', null, 'purchase_not_found');
    }
    throw err;
  }
  const blocked = blockForAccess(access);
  if (blocked) throw exposed(blocked.status, blocked.message);
  if (!access.plan) {
    throw exposed(404, 'No purchase was found for this session.', null, 'purchase_not_found');
  }
  if (!access.valid) {
    throw exposed(403, 'This purchase is not active.', null, 'purchase_inactive');
  }
  if (access.plan === 'starter' && !(access.remaining > 0)) {
    throw exposed(402, 'Starter credits are used up.');
  }
  return access;
}

const HOLD_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function holdStamp(now) {
  const date = now instanceof Date ? now : new Date(now);
  const iso = date.toISOString();
  if (!HOLD_STAMP.test(iso)) throw new Error('bad clock');
  return iso;
}

const HOLD_TOKEN = /^[a-f0-9]{16}$/;
const HOLD_VALUE_LIMIT = 500;

// One PaymentIntent can have several jobs in flight. Each job's token is its
// own hold. credit_hold mirrors the token only while exactly one hold is open,
// so a second reserve cannot erase the first.
function readCreditHolds(meta) {
  const holds = new Map();
  const raw = meta && typeof meta.credit_holds === 'string' ? meta.credit_holds.trim() : '';
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [token, stamp] of Object.entries(parsed)) {
          if (!HOLD_TOKEN.test(token)) continue;
          holds.set(token, typeof stamp === 'string' && HOLD_STAMP.test(stamp) ? stamp : '');
        }
      }
    } catch {
      // A damaged list falls back to the single credit_hold field.
    }
  }
  const legacy = meta && typeof meta.credit_hold === 'string' ? meta.credit_hold : '';
  if (HOLD_TOKEN.test(legacy) && !holds.has(legacy)) {
    const stamp = meta && typeof meta.credit_hold_at === 'string' ? meta.credit_hold_at : '';
    holds.set(legacy, HOLD_STAMP.test(stamp) ? stamp : '');
  }
  return holds;
}

function holdFields(holds) {
  const body = {};
  for (const [token, stamp] of holds) {
    if (!HOLD_TOKEN.test(token)) continue;
    body[token] = typeof stamp === 'string' && HOLD_STAMP.test(stamp) ? stamp : '';
  }
  const entries = Object.entries(body);
  const encoded = entries.length ? JSON.stringify(body) : '';
  const metadata = {
    credit_holds: encoded,
    credit_hold: '',
    credit_hold_at: '',
  };
  if (entries.length === 1) {
    metadata.credit_hold = entries[0][0];
    metadata.credit_hold_at = entries[0][1];
  }
  return metadata;
}

function holdsTooWide(holds) {
  const encoded = holdFields(holds).credit_holds;
  return Boolean(encoded) && encoded.length > HOLD_VALUE_LIMIT;
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

async function reserveStarterCredit(stripe, paymentIntentId, env, options = {}) {
  const allowance = starterCreditAllowance(env);
  const holds = options && options.holds;
  const now = options && typeof options.now === 'function' ? options.now : () => new Date();
  return withCreditLock(paymentIntentId, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await stripe.paymentIntents.retrieve(paymentIntentId);
      const meta = (current && current.metadata) || {};
      const creditStatus = starterCreditStatus(meta);
      if (creditStatus === 'revoked') throw exposed(402, starterRevokedMessage(meta));
      if (creditStatus === 'suspended') throw exposed(402, STARTER_SUSPENDED_MESSAGE);
      const used = parseManualsUsed(meta.manuals_used);
      if (used >= allowance) throw exposed(402, 'Starter credits are used up.');
      const generation = parseManualsUsed(meta.credit_generation);
      const next = used + 1;
      const nextGen = String(generation + 1);
      const token = crypto.randomBytes(8).toString('hex');
      const heldAt = holdStamp(now());
      const open = readCreditHolds(meta);
      open.set(token, heldAt);
      if (holdsTooWide(open)) {
        throw exposed(409, 'Could not reserve a Starter credit. Please retry.');
      }
      if (holds) holds.note({ paymentIntentId, token, heldAt });
      try {
        await stripe.paymentIntents.update(paymentIntentId, {
          metadata: {
            manuals_used: String(next),
            credit_generation: nextGen,
            ...holdFields(open),
          },
        });
        const check = await stripe.paymentIntents.retrieve(paymentIntentId);
        const confirmed = (check && check.metadata) || {};
        const confirmedHolds = readCreditHolds(confirmed);
        const stuck = confirmedHolds.has(token);
        const match = confirmedHolds.get(token) === heldAt
          && confirmed.manuals_used === String(next)
          && confirmed.credit_generation === nextGen;
        if (match || stuck) {
          return {
            paymentIntentId,
            token,
            heldAt: confirmedHolds.get(token) || heldAt,
            manualsUsed: parseManualsUsed(confirmed.manuals_used),
          };
        }
      } catch (err) {
        try {
          await refundStarterCreditUnlocked(stripe, paymentIntentId, token);
          if (holds) holds.drop({ paymentIntentId, token });
        } catch {
          // Keep the open-hold record, but this request is no longer running it.
          if (holds && holds.unown) holds.unown({ paymentIntentId, token });
        }
        throw err;
      }
      if (holds) holds.drop({ paymentIntentId, token });
    }
    throw exposed(409, 'Could not reserve a Starter credit. Please retry.');
  });
}

// Caller must already hold the payment-intent lock. A matching hold is the
// only thing that decrements manuals_used. credit_generation moves on that
// same write so a lost update is retried, and a second call sees the hold
// already cleared and returns the credit unchanged.
async function refundStarterCreditUnlocked(stripe, paymentIntentId, token) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await stripe.paymentIntents.retrieve(paymentIntentId);
    const meta = (current && current.metadata) || {};
    const open = readCreditHolds(meta);
    if (!open.has(token)) return parseManualsUsed(meta.manuals_used);
    open.delete(token);
    const used = parseManualsUsed(meta.manuals_used);
    const next = Math.max(0, used - 1);
    const nextGen = String(parseManualsUsed(meta.credit_generation) + 1);
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: {
        manuals_used: String(next),
        credit_generation: nextGen,
        ...holdFields(open),
      },
    });
    const check = await stripe.paymentIntents.retrieve(paymentIntentId);
    const confirmed = (check && check.metadata) || {};
    if (confirmed.manuals_used === String(next) && !readCreditHolds(confirmed).has(token)) {
      return next;
    }
  }
  throw exposed(500, 'Checkout is temporarily unavailable.', 'Starter credit refund did not commit');
}

async function refundStarterCredit(stripe, paymentIntentId, token) {
  if (!paymentIntentId || !token) return null;
  return withCreditLock(paymentIntentId, () => refundStarterCreditUnlocked(stripe, paymentIntentId, token));
}

// Success keeps manuals_used and clears the hold. A later hand-back no longer
// matches the token, so it cannot return the credit. A confirm read that fails
// after that clear write is retried. Once the clear has landed, a later read
// that still shows the same manuals_used is committed, so a single failed read
// cannot fail the job and leave the credit used. If the clear write's response
// is lost, maybeWritten stays set: later reads that also fail are treated as
// committed so the manual is still delivered instead of a hand-back that finds
// no hold.
async function commitStarterCredit(stripe, paymentIntentId, token) {
  if (!paymentIntentId || !token) return false;
  return withCreditLock(paymentIntentId, async () => {
    let reservedUsed = null;
    let clearWritten = false;
    let maybeWritten = false;
    let confirmUnread = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let current;
      try {
        current = await stripe.paymentIntents.retrieve(paymentIntentId);
      } catch (err) {
        if (!clearWritten && !maybeWritten) throw err;
        confirmUnread = true;
        continue;
      }
      confirmUnread = false;
      const meta = (current && current.metadata) || {};
      const open = readCreditHolds(meta);
      if (!open.has(token)) {
        if (!clearWritten && !maybeWritten && reservedUsed == null) return false;
        return parseManualsUsed(meta.manuals_used) === reservedUsed;
      }
      const used = parseManualsUsed(meta.manuals_used);
      reservedUsed = used;
      const nextGen = String(parseManualsUsed(meta.credit_generation) + 1);
      open.delete(token);
      try {
        await stripe.paymentIntents.update(paymentIntentId, {
          metadata: {
            credit_generation: nextGen,
            ...holdFields(open),
          },
        });
      } catch {
        maybeWritten = true;
        let landed;
        try {
          landed = await stripe.paymentIntents.retrieve(paymentIntentId);
        } catch {
          confirmUnread = true;
          continue;
        }
        const after = (landed && landed.metadata) || {};
        if (!readCreditHolds(after).has(token) && parseManualsUsed(after.manuals_used) === used) {
          return true;
        }
        continue;
      }
      clearWritten = true;
      let check;
      try {
        check = await stripe.paymentIntents.retrieve(paymentIntentId);
      } catch {
        confirmUnread = true;
        continue;
      }
      confirmUnread = false;
      const confirmed = (check && check.metadata) || {};
      if (
        !readCreditHolds(confirmed).has(token)
        && parseManualsUsed(confirmed.manuals_used) === used
        && confirmed.credit_generation === nextGen
      ) {
        return true;
      }
    }
    if ((clearWritten || maybeWritten) && confirmUnread) return true;
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Starter credit hold was not cleared');
  });
}

module.exports = {
  STARTER_REFUNDED_MESSAGE,
  STARTER_SUSPENDED_MESSAGE,
  STARTER_DISPUTE_LOST_MESSAGE,
  PRO_REFUNDED_MESSAGE,
  PRO_SUSPENDED_MESSAGE,
  PRO_DISPUTE_LOST_MESSAGE,
  parseManualsUsed,
  starterCreditStatus,
  isStripeNotFound,
  checkoutParams,
  accessFromSession,
  verifyCheckoutSession,
  publicAccess,
  blockForAccess,
  accessBlock,
  assertCanGenerate,
  recordStarterManual,
  reserveStarterCredit,
  refundStarterCredit,
  commitStarterCredit,
  readCreditHolds,
  holdFields,
  withCreditLock,
};
