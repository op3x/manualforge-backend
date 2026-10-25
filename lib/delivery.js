const { isStripeNotFound, withCreditLock } = require('./billing');

// first_manual_at is set only after a PDF exists and is about to be offered
// for download. Starter stores it on the PaymentIntent (the credit record).
// Pro stores it on the current period's charge, or on the invoice when that
// invoice has no charge. A failed, rejected, or unpaid run must not call
// markFirstManualDelivered.

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const OBJECT_ID = /^[A-Za-z0-9_]{1,80}$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return '';
}

function stampNow(now) {
  if (typeof now === 'string' && STAMP.test(now)) return now;
  const date = now instanceof Date ? now : new Date();
  return date.toISOString();
}

function readStamp(metadata) {
  const value = metadata && typeof metadata.first_manual_at === 'string' ? metadata.first_manual_at.trim() : '';
  if (!value) return { delivered: false, delivered_at: null };
  if (STAMP.test(value)) return { delivered: true, delivered_at: value };
  return { delivered: true, delivered_at: null };
}

function finiteUnix(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function isoFromUnix(seconds) {
  const unix = finiteUnix(seconds);
  if (!unix) return null;
  return new Date(unix * 1000).toISOString();
}

function starterDeadlineIso(createdSeconds) {
  const unix = finiteUnix(createdSeconds);
  if (!unix) return null;
  return new Date(unix * 1000 + THIRTY_DAYS_MS).toISOString();
}

function firstUnix(...values) {
  for (const value of values) {
    const unix = finiteUnix(value);
    if (unix) return unix;
  }
  return null;
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'string' && STAMP.test(now)) return Date.parse(now);
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

function linePeriodEnd(invoice) {
  const lines = invoice && invoice.lines && Array.isArray(invoice.lines.data) ? invoice.lines.data : [];
  for (const line of lines) {
    const end = line && line.period && finiteUnix(line.period.end);
    if (end) return end;
  }
  return null;
}

function subscriptionPeriodEnd(subscription) {
  if (!subscription || typeof subscription !== 'object') return null;
  const legacy = finiteUnix(subscription.current_period_end);
  if (legacy) return legacy;
  const items = subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  for (const item of items) {
    const end = item && finiteUnix(item.current_period_end);
    if (end) return end;
  }
  return null;
}

function subscriptionPeriodStart(subscription) {
  if (!subscription || typeof subscription !== 'object') return null;
  const legacy = finiteUnix(subscription.current_period_start);
  if (legacy) return legacy;
  const items = subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  for (const item of items) {
    const start = item && finiteUnix(item.current_period_start);
    if (start) return start;
  }
  return null;
}

function subscriptionRef(invoice) {
  if (!invoice || typeof invoice !== 'object') return '';
  if (invoice.subscription) return invoice.subscription;
  const details = invoice.parent && invoice.parent.subscription_details;
  if (details && details.subscription) return details.subscription;
  return '';
}

function periodEndUnix(invoice, subscription) {
  const sub = subscription && typeof subscription === 'object'
    ? subscription
    : (subscriptionRef(invoice) && typeof subscriptionRef(invoice) === 'object' ? subscriptionRef(invoice) : null);
  const latest = sub ? idOf(sub.latest_invoice) : '';
  const invoiceId = invoice && invoice.id ? invoice.id : '';
  const isCurrent = Boolean(sub) && (!latest || !invoiceId || latest === invoiceId);
  if (isCurrent) {
    const live = subscriptionPeriodEnd(sub);
    if (live) return live;
  }
  const lineEnd = linePeriodEnd(invoice);
  if (lineEnd) return lineEnd;
  return invoice ? finiteUnix(invoice.period_end) : null;
}

function invoicePeriodStart(invoice) {
  const lines = invoice && invoice.lines && Array.isArray(invoice.lines.data) ? invoice.lines.data : [];
  for (const line of lines) {
    const start = line && line.period && finiteUnix(line.period.start);
    if (start) return start;
  }
  return invoice ? finiteUnix(invoice.period_start) : null;
}

function chargeIdFromInvoice(invoice) {
  const direct = idOf(invoice && invoice.charge);
  if (direct) return direct;
  const payments = invoice && invoice.payments && Array.isArray(invoice.payments.data) ? invoice.payments.data : [];
  for (const row of payments) {
    const charge = row && row.payment && row.payment.charge;
    const chargeId = idOf(charge);
    if (chargeId) return chargeId;
  }
  return '';
}

function eligibility(stamp, deadline, now) {
  const delivered = Boolean(stamp && stamp.delivered);
  const deliveredAt = delivered ? (stamp.delivered_at || null) : null;
  if (delivered) {
    return {
      delivered: true,
      delivered_at: deliveredAt,
      refund_eligible: false,
      deadline: deadline || null,
      reason: deliveredAt ? `delivered at ${deliveredAt}` : 'delivered',
    };
  }
  const deadlineMs = deadline ? Date.parse(deadline) : NaN;
  if (!deadline || !Number.isFinite(deadlineMs)) {
    return {
      delivered: false,
      delivered_at: null,
      refund_eligible: false,
      deadline: null,
      reason: 'past deadline unknown',
    };
  }
  if (nowMs(now) < deadlineMs) {
    return {
      delivered: false,
      delivered_at: null,
      refund_eligible: true,
      deadline,
      reason: `eligible until ${deadline}`,
    };
  }
  return {
    delivered: false,
    delivered_at: null,
    refund_eligible: false,
    deadline,
    reason: `past deadline ${deadline}`,
  };
}

function purchaseRow({ id, kind, plan, stamp, via, customer, deadline, now }) {
  const decision = eligibility(stamp, deadline || null, now);
  const row = {
    id,
    kind,
    plan: plan || null,
    delivered: decision.delivered,
    delivered_at: decision.delivered_at,
    refund_eligible: decision.refund_eligible,
    deadline: decision.deadline,
    reason: decision.reason,
  };
  if (via) row.via = via;
  if (customer && OBJECT_ID.test(customer)) row.customer = customer;
  return row;
}

function found(purchases) {
  return { found: purchases.length > 0, purchases };
}

function missing() {
  return { found: false, purchases: [] };
}

async function retrieve(fn, id) {
  try {
    return await fn(id);
  } catch (err) {
    if (isStripeNotFound(err)) return null;
    throw err;
  }
}

async function stampPaymentIntent(stripe, paymentIntentId, now) {
  return withCreditLock(paymentIntentId, async () => {
    const current = await stripe.paymentIntents.retrieve(paymentIntentId);
    const meta = (current && current.metadata) || {};
    const existing = readStamp(meta);
    if (existing.delivered) return { delivered_at: existing.delivered_at, created: false };
    await stripe.paymentIntents.update(paymentIntentId, { metadata: { first_manual_at: now } });
    return { delivered_at: now, created: true };
  });
}

async function stampObject(stripe, kind, id, now) {
  const resource = kind === 'charge' ? stripe.charges : stripe.invoices;
  return withCreditLock(id, async () => {
    const current = await resource.retrieve(id);
    const existing = readStamp(current && current.metadata);
    if (existing.delivered) return { delivered_at: existing.delivered_at, created: false };
    await resource.update(id, { metadata: { first_manual_at: now } });
    return { delivered_at: now, created: true };
  });
}

async function currentPeriodTarget(stripe, sessionId) {
  if (!sessionId || !stripe.checkout || !stripe.checkout.sessions) return null;
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] });
  const subscriptionRef = session && session.subscription;
  if (!subscriptionRef) return null;
  const subscription = typeof subscriptionRef === 'string'
    ? await stripe.subscriptions.retrieve(subscriptionRef)
    : subscriptionRef;
  if (!subscription) return null;
  let invoice = subscription.latest_invoice;
  if (!invoice) return null;
  if (typeof invoice === 'string') {
    if (!stripe.invoices || typeof stripe.invoices.retrieve !== 'function') return null;
    invoice = await stripe.invoices.retrieve(invoice);
  }
  if (!invoice) return null;
  const periodStart = subscriptionPeriodStart(subscription);
  const invoiceStart = invoicePeriodStart(invoice);
  if (periodStart != null && invoiceStart != null && invoiceStart !== periodStart) return null;
  const plan = subscription.metadata && subscription.metadata.plan === 'integrator' ? 'integrator' : 'pro';
  const chargeId = chargeIdFromInvoice(invoice);
  if (chargeId) return { kind: 'charge', id: chargeId, plan };
  if (invoice.id) return { kind: 'invoice', id: invoice.id, plan };
  return null;
}

async function markFirstManualDelivered(stripe, access, sessionId, options = {}) {
  if (!stripe || !access) return null;
  const now = stampNow(options.now);
  if (access.plan === 'starter' && access.paymentIntentId) {
    return stampPaymentIntent(stripe, access.paymentIntentId, now);
  }
  if (access.plan !== 'pro' && access.plan !== 'integrator') return null;
  const target = await currentPeriodTarget(stripe, sessionId);
  if (!target) return null;
  return stampObject(stripe, target.kind, target.id, now);
}

async function planForInvoice(stripe, invoice) {
  const subscription = subscriptionRef(invoice);
  if (!subscription) return 'pro';
  if (typeof subscription === 'object') {
    return subscription.metadata && subscription.metadata.plan === 'integrator' ? 'integrator' : 'pro';
  }
  if (!stripe.subscriptions || typeof stripe.subscriptions.retrieve !== 'function') return 'pro';
  const loaded = await retrieve((id) => stripe.subscriptions.retrieve(id), subscription);
  if (loaded && loaded.metadata && loaded.metadata.plan === 'integrator') return 'integrator';
  return 'pro';
}

async function invoiceFromPaymentIntent(stripe, paymentIntentId) {
  const list = stripe.invoicePayments && stripe.invoicePayments.list;
  if (!paymentIntentId || typeof list !== 'function') return null;
  const listed = await list.call(stripe.invoicePayments, {
    payment: { type: 'payment_intent', payment_intent: paymentIntentId },
    limit: 10,
  });
  const rows = listed && Array.isArray(listed.data) ? listed.data : [];
  const chosen = rows.find((row) => row && row.status === 'paid' && row.invoice)
    || rows.find((row) => row && row.invoice);
  if (!chosen) return null;
  if (typeof chosen.invoice === 'object' && chosen.invoice) return chosen.invoice;
  const invoiceId = typeof chosen.invoice === 'string' ? chosen.invoice : '';
  if (!invoiceId || !stripe.invoices) return null;
  return retrieve((id) => stripe.invoices.retrieve(id), invoiceId);
}

async function loadInvoice(stripe, charge) {
  if (charge.invoice && typeof charge.invoice === 'object') return charge.invoice;
  if (typeof charge.invoice === 'string' && stripe.invoices) {
    return retrieve((id) => stripe.invoices.retrieve(id), charge.invoice);
  }
  const paymentIntentId = idOf(charge.payment_intent);
  if (!paymentIntentId) return null;
  return invoiceFromPaymentIntent(stripe, paymentIntentId);
}

async function loadSubscription(stripe, invoice) {
  const ref = subscriptionRef(invoice);
  if (!ref) return null;
  if (typeof ref === 'object') return ref;
  if (!stripe.subscriptions || typeof stripe.subscriptions.retrieve !== 'function') return null;
  return retrieve((id) => stripe.subscriptions.retrieve(id), ref);
}

async function rowFromCharge(stripe, charge, extra = {}) {
  let stamp = readStamp(charge.metadata);
  let plan = 'pro';
  let pi = null;
  const piId = idOf(charge.payment_intent);
  if (piId && stripe.paymentIntents) {
    pi = typeof charge.payment_intent === 'object'
      ? charge.payment_intent
      : await retrieve((id) => stripe.paymentIntents.retrieve(id), piId);
    if (pi && pi.metadata && pi.metadata.plan === 'starter') {
      plan = 'starter';
      if (!stamp.delivered) stamp = readStamp(pi.metadata);
    }
  }
  let invoice = null;
  if (plan !== 'starter') {
    invoice = await loadInvoice(stripe, charge);
    if (!stamp.delivered && invoice) stamp = readStamp(invoice.metadata);
    plan = await planForInvoice(stripe, invoice || {});
  }
  const created = firstUnix(pi && pi.created, charge.created, extra.created);
  let deadline = null;
  if (plan === 'starter') deadline = starterDeadlineIso(created);
  else deadline = isoFromUnix(periodEndUnix(invoice, await loadSubscription(stripe, invoice)));
  return purchaseRow({
    id: charge.id,
    kind: 'charge',
    plan,
    stamp,
    via: extra.via,
    customer: extra.customer || idOf(charge.customer),
    deadline,
    now: extra.now,
  });
}

async function rowFromPaymentIntent(stripe, pi, extra = {}) {
  const metaPlan = pi.metadata && pi.metadata.plan;
  if (metaPlan !== 'starter' && pi.latest_charge && stripe.charges) {
    const charge = typeof pi.latest_charge === 'object'
      ? pi.latest_charge
      : await retrieve((id) => stripe.charges.retrieve(id), idOf(pi.latest_charge));
    if (charge) return rowFromCharge(stripe, charge, extra);
  }
  const stamp = readStamp(pi.metadata);
  const created = firstUnix(pi.created, extra.created);
  const deadline = metaPlan === 'starter' || !metaPlan ? starterDeadlineIso(created) : null;
  return purchaseRow({
    id: pi.id,
    kind: 'payment_intent',
    plan: metaPlan || null,
    stamp,
    via: extra.via,
    customer: extra.customer || idOf(pi.customer),
    deadline,
    now: extra.now,
  });
}

async function checkPaymentIntent(stripe, id, now) {
  const pi = await retrieve((paymentIntentId) => stripe.paymentIntents.retrieve(paymentIntentId), id);
  if (!pi) return missing();
  return found([await rowFromPaymentIntent(stripe, pi, { now })]);
}

async function checkCharge(stripe, id, now) {
  const charge = await retrieve((chargeId) => stripe.charges.retrieve(chargeId), id);
  if (!charge) return missing();
  return found([await rowFromCharge(stripe, charge, { now })]);
}

async function rowFromInvoice(stripe, invoice, extra = {}) {
  const chargeId = chargeIdFromInvoice(invoice);
  if (chargeId && stripe.charges) {
    const charge = await retrieve((id) => stripe.charges.retrieve(id), chargeId);
    if (charge) return rowFromCharge(stripe, { ...charge, invoice }, extra);
  }
  const plan = await planForInvoice(stripe, invoice);
  const deadline = plan === 'starter'
    ? null
    : isoFromUnix(periodEndUnix(invoice, await loadSubscription(stripe, invoice)));
  return purchaseRow({
    id: invoice.id,
    kind: 'invoice',
    plan,
    stamp: readStamp(invoice.metadata),
    via: extra.via,
    customer: extra.customer || idOf(invoice.customer),
    deadline,
    now: extra.now,
  });
}

async function checkInvoice(stripe, id, now) {
  const invoice = await retrieve((invoiceId) => stripe.invoices.retrieve(invoiceId), id);
  if (!invoice) return missing();
  return found([await rowFromInvoice(stripe, invoice, { now })]);
}

async function checkSession(stripe, id, now) {
  const session = await retrieve(
    (sessionId) => stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent', 'invoice'] }),
    id,
  );
  if (!session) return missing();
  const plan = session.metadata && session.metadata.plan;
  const extra = { via: id, created: session.created, now, customer: idOf(session.customer) };
  if (plan === 'starter' || (!session.invoice && !session.subscription)) {
    const pi = typeof session.payment_intent === 'object'
      ? session.payment_intent
      : await retrieve((paymentIntentId) => stripe.paymentIntents.retrieve(paymentIntentId), idOf(session.payment_intent));
    if (!pi) return missing();
    return found([await rowFromPaymentIntent(stripe, pi, extra)]);
  }
  if (!session.invoice) return missing();
  const invoice = typeof session.invoice === 'object'
    ? session.invoice
    : await retrieve((invoiceId) => stripe.invoices.retrieve(invoiceId), idOf(session.invoice));
  if (!invoice) return missing();
  return found([await rowFromInvoice(stripe, invoice, extra)]);
}

async function checkEmail(stripe, email, now) {
  if (!stripe.customers || typeof stripe.customers.list !== 'function') return missing();
  const listed = await stripe.customers.list({ email, limit: 10 });
  const customers = listed && Array.isArray(listed.data) ? listed.data : [];
  if (!customers.length) return missing();
  const purchases = [];
  const seen = new Set();
  for (const customer of customers) {
    if (!customer || !customer.id || !stripe.charges || typeof stripe.charges.list !== 'function') continue;
    const charges = await stripe.charges.list({ customer: customer.id, limit: 20 });
    const rows = charges && Array.isArray(charges.data) ? charges.data : [];
    for (const charge of rows) {
      if (!charge || !charge.id || seen.has(charge.id)) continue;
      seen.add(charge.id);
      purchases.push(await rowFromCharge(stripe, charge, { customer: customer.id, now }));
    }
  }
  purchases.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return found(purchases);
}

async function refundCheck(stripe, query, options = {}) {
  const now = options.now;
  const text = String(query || '').trim();
  if (!text || !stripe) return missing();
  if (text.startsWith('pi_')) return checkPaymentIntent(stripe, text, now);
  if (text.startsWith('ch_')) return checkCharge(stripe, text, now);
  if (text.startsWith('cs_')) return checkSession(stripe, text, now);
  if (text.startsWith('in_')) return checkInvoice(stripe, text, now);
  if (text.includes('@') && !/\s/.test(text)) return checkEmail(stripe, text, now);
  return missing();
}

module.exports = {
  markFirstManualDelivered,
  refundCheck,
};
