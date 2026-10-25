const crypto = require('crypto');
const { createAccountStore } = require('./accounts/store');
const {
  INTEGRATION_IDS,
  INTEGRATOR_MONTHLY_CREDITS,
  INTEGRATOR_OVERAGE_AMOUNT_CENTS,
  frontendBase,
} = require('./config');
const { exposed } = require('./errors');

const ACTIVE_SUBSCRIPTION = new Set(['active', 'trialing']);
const NO_GRANT = new Set(['canceled', 'unpaid', 'incomplete_expired', 'paused']);
const TERMINAL = new Set(['canceled', 'unpaid', 'incomplete_expired']);

const creditLocks = new Map();

function withCreditLock(key, fn) {
  const prev = creditLocks.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  creditLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

function parseCount(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return '';
}

function normalizeInterval(interval) {
  const value = String(interval || '').trim().toLowerCase();
  if (value === 'month' || value === 'monthly') return 'month';
  if (value === 'year' || value === 'annual' || value === 'yearly') return 'year';
  return '';
}

function resolveInterval(plan, extra) {
  if (plan === 'integrator_monthly') return 'month';
  if (plan === 'integrator_annual') return 'year';
  if (plan === 'integrator') return normalizeInterval(extra && extra.interval);
  return '';
}

const INTEGRATOR_PRICES = [
  ['month', 'MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY', 'Integrator monthly checkout is temporarily unavailable.'],
  ['year', 'MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL', 'Integrator annual checkout is temporarily unavailable.'],
  ['overage', 'MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE', 'Integrator overage checkout is temporarily unavailable.'],
];

function priceEnvFor(interval) {
  const row = INTEGRATOR_PRICES.find(([key]) => key === interval);
  return row ? row[1] : 'MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY';
}

function configuredPrice(env, name) {
  return String((env && env[name]) || '').trim();
}

function missingIntegratorPrices(env) {
  return INTEGRATOR_PRICES.filter(([, name]) => !configuredPrice(env, name));
}

function assertIntegratorPrices(env, needed) {
  const missing = missingIntegratorPrices(env);
  if (!missing.length) return configuredPrice(env, priceEnvFor(needed));
  const requested = missing.find(([key]) => key === needed);
  const chosen = requested || missing[0];
  const message = requested ? chosen[2] : 'Integrator checkout is temporarily unavailable.';
  throw exposed(503, message, `${chosen[1]} is not set`);
}

function subscriptionPriceId(subscription) {
  const items = subscription && subscription.items && subscription.items.data;
  if (!Array.isArray(items)) return '';
  for (const item of items) {
    if (!item || !item.price) continue;
    if (typeof item.price === 'string') return item.price;
    if (item.price.id) return item.price.id;
  }
  return '';
}

function priceRecurringInterval(subscription) {
  const item = subscription && subscription.items && subscription.items.data && subscription.items.data[0];
  const recurring = item && item.price && item.price.recurring;
  if (recurring && (recurring.interval === 'year' || recurring.interval === 'month')) return recurring.interval;
  return '';
}

function isIntegratorSubscription(subscription, env) {
  if (!subscription) return false;
  if (subscription.metadata && subscription.metadata.plan === 'integrator') return true;
  const priceId = subscriptionPriceId(subscription);
  if (!priceId || !env) return false;
  const monthly = String(env.MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY || '').trim();
  const annual = String(env.MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL || '').trim();
  return Boolean((monthly && priceId === monthly) || (annual && priceId === annual));
}

function integratorInterval(subscription, env) {
  const meta = subscription && subscription.metadata && subscription.metadata.interval;
  if (meta === 'month' || meta === 'year') return meta;
  const fromPrice = priceRecurringInterval(subscription);
  if (fromPrice) return fromPrice;
  const priceId = subscriptionPriceId(subscription);
  const annual = String((env && env.MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL) || '').trim();
  const monthly = String((env && env.MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY) || '').trim();
  if (priceId && annual && priceId === annual) return 'year';
  if (priceId && monthly && priceId === monthly) return 'month';
  return 'month';
}

function periodAnchor(subscription) {
  if (!subscription) return null;
  if (Number.isFinite(subscription.current_period_start)) return subscription.current_period_start;
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  if (item && Number.isFinite(item.current_period_start)) return item.current_period_start;
  if (Number.isFinite(subscription.billing_cycle_anchor)) return subscription.billing_cycle_anchor;
  if (Number.isFinite(subscription.start_date)) return subscription.start_date;
  return null;
}

function monthIndex(anchorSec, nowSec) {
  if (nowSec < anchorSec) return 0;
  const anchor = new Date(anchorSec * 1000);
  const now = new Date(nowSec * 1000);
  let months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  if (now.getUTCDate() < anchor.getUTCDate()) months -= 1;
  else if (now.getUTCDate() === anchor.getUTCDate()) {
    const anchorClock = anchor.getUTCHours() * 3600 + anchor.getUTCMinutes() * 60 + anchor.getUTCSeconds();
    const nowClock = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
    if (nowClock < anchorClock) months -= 1;
  }
  return Math.max(0, months);
}

function creditWindowId(subscription, env, nowMs = Date.now()) {
  const anchor = periodAnchor(subscription);
  if (!Number.isFinite(anchor)) return 'period:unknown';
  const interval = integratorInterval(subscription, env);
  if (interval === 'year') {
    const index = monthIndex(anchor, Math.floor(nowMs / 1000));
    return `month:${anchor}:${index}`;
  }
  return `period:${anchor}`;
}

function customerIdOf(subscription) {
  if (!subscription || !subscription.customer) return null;
  if (typeof subscription.customer === 'string') return subscription.customer;
  return subscription.customer.id || null;
}

function readCreditState(subscription, env, nowMs = Date.now()) {
  const meta = (subscription && subscription.metadata) || {};
  const window = creditWindowId(subscription, env, nowMs);
  const storedWindow = meta.credit_period || '';
  const overageRemaining = parseCount(meta.overage_remaining);
  const periodOpen = storedWindow === window;
  if (!periodOpen) {
    return {
      window,
      periodOpen: false,
      includedUsed: 0,
      includedRemaining: INTEGRATOR_MONTHLY_CREDITS,
      overageRemaining,
    };
  }
  const granted = meta.credits_granted === undefined || meta.credits_granted === ''
    ? INTEGRATOR_MONTHLY_CREDITS
    : parseCount(meta.credits_granted);
  const includedUsed = parseCount(meta.manuals_used);
  return {
    window,
    periodOpen: true,
    includedUsed,
    includedRemaining: Math.max(0, granted - includedUsed),
    overageRemaining,
  };
}

function overageRequiredError() {
  const err = exposed(
    402,
    `Integrator credits are used up. Purchase an extra manual for $${INTEGRATOR_OVERAGE_AMOUNT_CENTS / 100} to continue.`
  );
  err.details = {
    overage: {
      plan: 'integrator_overage',
      amount_cents: INTEGRATOR_OVERAGE_AMOUNT_CENTS,
      currency: 'usd',
    },
  };
  return err;
}

function redirectBase(env) {
  const base = frontendBase(env);
  if (!base) throw exposed(500, 'Checkout is temporarily unavailable.', 'FRONTEND_URL is not set');
  return base;
}

function integratorCheckoutParams(plan, env, extra) {
  const interval = resolveInterval(plan, extra);
  if (!interval) {
    if (missingIntegratorPrices(env).length) {
      throw exposed(503, 'Integrator checkout is temporarily unavailable.', 'Integrator price is not set');
    }
    throw exposed(400, 'interval must be "month" or "year"');
  }
  const price = assertIntegratorPrices(env, interval);
  const base = redirectBase(env);
  return {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/upload.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/#pricing`,
    metadata: { plan: 'integrator', interval },
    subscription_data: {
      metadata: {
        plan: 'integrator',
        interval,
        credits_granted: '0',
        manuals_used: '0',
        overage_remaining: '0',
        credit_generation: '0',
      },
    },
    integration_identifier: interval === 'year' ? INTEGRATION_IDS.integrator_year : INTEGRATION_IDS.integrator_month,
  };
}

function assertOverageConfigured(env) {
  assertIntegratorPrices(env, 'overage');
  redirectBase(env);
}

function overageCheckoutParams(env, { subscriptionId, customerId, sessionId }) {
  const price = assertIntegratorPrices(env, 'overage');
  const base = redirectBase(env);
  const params = {
    mode: 'payment',
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/upload.html?session_id=${encodeURIComponent(sessionId)}`,
    cancel_url: `${base}/#pricing`,
    client_reference_id: subscriptionId,
    metadata: {
      plan: 'integrator_overage',
      kind: 'overage',
      subscription_id: subscriptionId,
      subscription_session_id: sessionId,
    },
    payment_intent_data: {
      metadata: {
        plan: 'integrator_overage',
        kind: 'overage',
        subscription_id: subscriptionId,
      },
    },
    integration_identifier: INTEGRATION_IDS.integrator_overage,
  };
  if (customerId) params.customer = customerId;
  return params;
}

function subscriptionIdFromInvoice(invoice) {
  if (!invoice) return '';
  const direct = idOf(invoice.subscription);
  if (direct) return direct;
  const parent = invoice.parent && invoice.parent.subscription_details;
  const fromParent = parent && idOf(parent.subscription);
  if (fromParent) return fromParent;
  const lines = invoice.lines && invoice.lines.data;
  if (!Array.isArray(lines)) return '';
  for (const line of lines) {
    const fromLine = idOf(line.subscription);
    if (fromLine) return fromLine;
    const details = line.parent && line.parent.subscription_item_details;
    const nested = details && idOf(details.subscription);
    if (nested) return nested;
  }
  return '';
}

async function grantIntegratorPeriod(stripe, subscriptionId, env, nowMs = Date.now()) {
  return withCreditLock(subscriptionId, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await stripe.subscriptions.retrieve(subscriptionId);
      if (!isIntegratorSubscription(current, env)) return { granted: false };
      if (current.status && NO_GRANT.has(current.status)) return { granted: false };
      const meta = current.metadata || {};
      const window = creditWindowId(current, env, nowMs);
      if (meta.credit_period === window && String(meta.credits_granted) === String(INTEGRATOR_MONTHLY_CREDITS)) {
        return { granted: false, window };
      }
      const generation = String(parseCount(meta.credit_generation) + 1);
      const metadata = {
        plan: 'integrator',
        interval: integratorInterval(current, env),
        credit_period: window,
        credits_granted: String(INTEGRATOR_MONTHLY_CREDITS),
        manuals_used: '0',
        overage_remaining: String(parseCount(meta.overage_remaining)),
        credit_generation: generation,
        credit_hold: '',
        credit_bucket: '',
        cancelled: '',
      };
      if (meta.overage_applied) metadata.overage_applied = meta.overage_applied;
      await stripe.subscriptions.update(subscriptionId, { metadata });
      const check = await stripe.subscriptions.retrieve(subscriptionId);
      const confirmed = (check && check.metadata) || {};
      if (
        confirmed.credit_period === window
        && confirmed.credits_granted === String(INTEGRATOR_MONTHLY_CREDITS)
        && confirmed.manuals_used === '0'
        && confirmed.credit_generation === generation
      ) {
        return { granted: true, window };
      }
    }
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Integrator credit grant did not commit');
  });
}

async function grantFromInvoice(stripe, invoice, env, nowMs) {
  if (!invoice || invoice.paid === false) return;
  if (invoice.status && invoice.status !== 'paid') return;
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (!subscriptionId) return;
  await grantIntegratorPeriod(stripe, subscriptionId, env, nowMs);
}

const OVERAGE_PI_LIMIT = 500;

function piIds(value) {
  return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function nextPiList(existing, paymentIntentId) {
  const ids = piIds(existing);
  if (paymentIntentId && paymentIntentId.length <= OVERAGE_PI_LIMIT && !ids.includes(paymentIntentId)) {
    ids.push(paymentIntentId);
  }
  const dropped = [];
  while (ids.length > 1 && ids.join(',').length > OVERAGE_PI_LIMIT) dropped.push(ids.shift());
  if (ids.join(',').length > OVERAGE_PI_LIMIT) return { list: '', dropped: ids.concat(dropped) };
  return { list: ids.join(','), dropped };
}

function subscriptionRecordsGrant(meta, grantId, paymentIntentId) {
  const recorded = meta || {};
  if (recorded.overage_grant === grantId) return true;
  if (!paymentIntentId) return false;
  if (recorded.overage_last_pi === paymentIntentId) return true;
  return piIds(recorded.overage_pi).includes(paymentIntentId);
}

async function paymentGrantRecorded(stripe, paymentIntentId) {
  if (!paymentIntentId || !stripe || !stripe.paymentIntents || typeof stripe.paymentIntents.retrieve !== 'function') {
    return false;
  }
  const payment = await stripe.paymentIntents.retrieve(paymentIntentId);
  const meta = (payment && payment.metadata) || {};
  return String(meta.overage_credit_granted || '') === '1';
}

async function stampPaymentGrant(stripe, paymentIntentId) {
  if (!paymentIntentId || !stripe || !stripe.paymentIntents || typeof stripe.paymentIntents.update !== 'function') {
    return;
  }
  await stripe.paymentIntents.update(paymentIntentId, {
    metadata: { overage_credit_granted: '1' },
  });
  if (!(await paymentGrantRecorded(stripe, paymentIntentId))) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Overage grant did not commit');
  }
}

async function settleRecordedGrant(stripe, accounts, customerId, paymentIntentId, grantId) {
  if (grantId) accounts.writeOverageGrant(customerId, grantId, 'done');
  await stampPaymentGrant(stripe, paymentIntentId);
}

async function applyOveragePayment(stripe, session, env) {
  if (!session || session.payment_status !== 'paid') return;
  const subscriptionId = session.metadata && session.metadata.subscription_id;
  const grantId = session.id || idOf(session.payment_intent);
  if (!subscriptionId || !grantId) return;
  const accounts = createAccountStore({ env });
  const paymentIntentId = idOf(session.payment_intent);
  await withCreditLock(subscriptionId, async () => {
    const current = await stripe.subscriptions.retrieve(subscriptionId);
    if (!isIntegratorSubscription(current, env)) return;
    const customerId = customerIdOf(current) || idOf(session.customer);
    if (!customerId) {
      throw exposed(500, 'Checkout is temporarily unavailable.', 'Overage grant is missing a customer');
    }
    const seen = accounts.readOverageGrants(customerId);
    const meta = current.metadata || {};
    const stamped = await paymentGrantRecorded(stripe, paymentIntentId);
    if (stamped || seen[grantId] === 'done' || subscriptionRecordsGrant(meta, grantId, paymentIntentId)) {
      await settleRecordedGrant(stripe, accounts, customerId, paymentIntentId, grantId);
      return;
    }
    const previousGrant = meta.overage_grant || '';
    const previousPi = meta.overage_last_pi || '';
    if (previousGrant && previousGrant !== grantId && seen[previousGrant] !== 'done') {
      accounts.writeOverageGrant(customerId, previousGrant, 'done');
    }
    if (previousPi && previousPi !== paymentIntentId) await stampPaymentGrant(stripe, previousPi);
    const planned = nextPiList(meta.overage_pi, paymentIntentId);
    for (const oldId of planned.dropped) {
      if (oldId !== paymentIntentId) await stampPaymentGrant(stripe, oldId);
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const latest = await stripe.subscriptions.retrieve(subscriptionId);
      if (!isIntegratorSubscription(latest, env)) return;
      const latestMeta = latest.metadata || {};
      if (subscriptionRecordsGrant(latestMeta, grantId, paymentIntentId)) {
        await settleRecordedGrant(stripe, accounts, customerId, paymentIntentId, grantId);
        return;
      }
      const nextRemaining = String(parseCount(latestMeta.overage_remaining) + 1);
      const generation = String(parseCount(latestMeta.credit_generation) + 1);
      const piList = nextPiList(latestMeta.overage_pi, paymentIntentId);
      const metadata = {
        overage_remaining: nextRemaining,
        overage_grant: grantId,
        credit_generation: generation,
      };
      if (paymentIntentId && paymentIntentId.length <= OVERAGE_PI_LIMIT) {
        metadata.overage_last_pi = paymentIntentId;
        if (piList.list) metadata.overage_pi = piList.list;
      }
      await stripe.subscriptions.update(subscriptionId, { metadata });
      const check = await stripe.subscriptions.retrieve(subscriptionId);
      const confirmed = (check && check.metadata) || {};
      const piStored = !paymentIntentId || confirmed.overage_last_pi === paymentIntentId;
      if (confirmed.overage_remaining === nextRemaining && confirmed.overage_grant === grantId && piStored) {
        await stampPaymentGrant(stripe, paymentIntentId);
        accounts.writeOverageGrant(customerId, grantId, 'done');
        return;
      }
    }
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Overage credit grant did not commit');
  });
}

async function fulfillCheckout(stripe, session, env, nowMs) {
  if (!session || session.payment_status !== 'paid') return;
  const plan = session.metadata && session.metadata.plan;
  if (plan === 'integrator') {
    const subscriptionId = idOf(session.subscription);
    if (!subscriptionId) return;
    await grantIntegratorPeriod(stripe, subscriptionId, env, nowMs);
    return;
  }
  if (plan === 'integrator_overage') await applyOveragePayment(stripe, session, env);
}

async function markIntegratorCancelled(stripe, subscription, env) {
  if (!isIntegratorSubscription(subscription, env)) return;
  if (!subscription.id) return;
  await stripe.subscriptions.update(subscription.id, {
    metadata: {
      cancelled: 'true',
      credits_granted: '0',
      manuals_used: '0',
      credit_hold: '',
      credit_bucket: '',
    },
  });
}

async function applyWebhookEvent(stripe, event, env, options = {}) {
  const nowMs = options.now === undefined ? Date.now() : options.now;
  const object = event && event.data && event.data.object ? event.data.object : {};
  if (!event || !event.type) return;
  if (event.type === 'invoice.paid') {
    await grantFromInvoice(stripe, object, env, nowMs);
    return;
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    await fulfillCheckout(stripe, object, env, nowMs);
    return;
  }
  if (event.type === 'customer.subscription.deleted') {
    await markIntegratorCancelled(stripe, object, env);
    return;
  }
  if (event.type === 'customer.subscription.updated') {
    if (object.status && TERMINAL.has(object.status)) await markIntegratorCancelled(stripe, object, env);
  }
}

async function reserveIntegratorCredit(stripe, subscriptionId, env, nowMs = Date.now()) {
  return withCreditLock(subscriptionId, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await stripe.subscriptions.retrieve(subscriptionId);
      if (!current || !ACTIVE_SUBSCRIPTION.has(current.status)) {
        throw exposed(402, 'Payment required. This checkout session is not an active paid plan.');
      }
      const state = readCreditState(current, env, nowMs);
      const meta = current.metadata || {};
      const generation = String(parseCount(meta.credit_generation) + 1);
      const token = crypto.randomBytes(8).toString('hex');
      let manualsUsed = state.periodOpen ? state.includedUsed : 0;
      let overageRemaining = state.overageRemaining;
      let bucket;
      if (manualsUsed < INTEGRATOR_MONTHLY_CREDITS) {
        manualsUsed += 1;
        bucket = 'included';
      } else if (overageRemaining > 0) {
        overageRemaining -= 1;
        bucket = 'overage';
      } else {
        throw overageRequiredError();
      }
      const metadata = {
        plan: 'integrator',
        interval: integratorInterval(current, env),
        credit_period: state.window,
        credits_granted: String(INTEGRATOR_MONTHLY_CREDITS),
        manuals_used: String(manualsUsed),
        overage_remaining: String(overageRemaining),
        credit_generation: generation,
        credit_hold: token,
        credit_bucket: bucket,
      };
      if (meta.overage_applied) metadata.overage_applied = meta.overage_applied;
      await stripe.subscriptions.update(subscriptionId, { metadata });
      const check = await stripe.subscriptions.retrieve(subscriptionId);
      const confirmed = (check && check.metadata) || {};
      if (confirmed.credit_hold === token && confirmed.credit_generation === generation) {
        return {
          kind: 'integrator',
          subscriptionId,
          token,
          bucket,
          manualsUsed,
          overageRemaining,
        };
      }
    }
    throw exposed(409, 'Could not reserve an Integrator credit. Please retry.');
  });
}

async function refundIntegratorCredit(stripe, subscriptionId, token) {
  if (!subscriptionId || !token) return null;
  return withCreditLock(subscriptionId, async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await stripe.subscriptions.retrieve(subscriptionId);
      const meta = (current && current.metadata) || {};
      if (meta.credit_hold !== token) return parseCount(meta.manuals_used);
      const bucket = meta.credit_bucket;
      let manualsUsed = parseCount(meta.manuals_used);
      let overageRemaining = parseCount(meta.overage_remaining);
      if (bucket === 'overage') overageRemaining += 1;
      else manualsUsed = Math.max(0, manualsUsed - 1);
      const generation = String(parseCount(meta.credit_generation) + 1);
      await stripe.subscriptions.update(subscriptionId, {
        metadata: {
          manuals_used: String(manualsUsed),
          overage_remaining: String(overageRemaining),
          credit_generation: generation,
          credit_hold: '',
          credit_bucket: '',
        },
      });
      const check = await stripe.subscriptions.retrieve(subscriptionId);
      const confirmed = (check && check.metadata) || {};
      if (confirmed.credit_hold !== token && confirmed.credit_generation === generation) {
        return { manualsUsed, overageRemaining };
      }
    }
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Integrator credit refund did not commit');
  });
}

module.exports = {
  normalizeInterval,
  isIntegratorSubscription,
  integratorInterval,
  creditWindowId,
  readCreditState,
  customerIdOf,
  overageRequiredError,
  integratorCheckoutParams,
  assertOverageConfigured,
  overageCheckoutParams,
  subscriptionIdFromInvoice,
  grantIntegratorPeriod,
  applyWebhookEvent,
  reserveIntegratorCredit,
  refundIntegratorCredit,
  ACTIVE_SUBSCRIPTION,
};
