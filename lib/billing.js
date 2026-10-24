const { INTEGRATION_IDS, frontendBase, starterCreditAllowance } = require('./config');

const ACTIVE_SUBSCRIPTION = new Set(['active', 'trialing']);

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
  if (typeof subscription === 'string') return stripe.subscriptions.retrieve(subscription);
  return subscription;
}

function accessFromSession(session, paymentIntent, subscription, env) {
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
    };
  }
  if (plan === 'pro') {
    const status = subscription && subscription.status;
    return {
      valid: ACTIVE_SUBSCRIPTION.has(status),
      plan: 'pro',
      remaining: null,
      paymentIntentId: null,
    };
  }
  return { valid: false, plan: null, remaining: null, paymentIntentId: null };
}

async function verifyCheckoutSession(stripe, sessionId, env) {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent', 'subscription'],
  });
  const plan = session.metadata && session.metadata.plan;
  const paymentIntent = plan === 'starter' ? await loadPaymentIntent(stripe, session.payment_intent) : null;
  const subscription = plan === 'pro' ? await loadSubscription(stripe, session.subscription) : null;
  return accessFromSession(session, paymentIntent, subscription, env);
}

function publicAccess(access) {
  return {
    valid: Boolean(access.valid),
    plan: access.plan,
    remaining: access.remaining,
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
  const current = await stripe.paymentIntents.retrieve(paymentIntentId);
  const used = parseManualsUsed(current.metadata && current.metadata.manuals_used);
  const next = used + 1;
  await stripe.paymentIntents.update(paymentIntentId, {
    metadata: { manuals_used: String(next) },
  });
  return next;
}

module.exports = {
  parseManualsUsed,
  isStripeNotFound,
  checkoutParams,
  accessFromSession,
  verifyCheckoutSession,
  publicAccess,
  assertCanGenerate,
  recordStarterManual,
};
