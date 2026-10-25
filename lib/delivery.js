const { isStripeNotFound, withCreditLock } = require('./billing');
const { isOverage } = require('./overage-credit');

// first_manual_at is set only after a PDF exists and is about to be offered
// for download. Starter stores it on the PaymentIntent (the credit record).
// Pro stores it on the current period's charge, or on the invoice when that
// invoice has no charge. A failed, rejected, or unpaid run must not call
// markFirstManualDelivered.

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const OBJECT_ID = /^[A-Za-z0-9_]{1,80}$/;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const GENERATION_STALE_MS = 15 * 60 * 1000;
const CLEAR_ATTEMPTS = 3;

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

function readInProgress(metadata, now) {
  const value = metadata && typeof metadata.generation_started_at === 'string' ? metadata.generation_started_at.trim() : '';
  if (!STAMP.test(value)) return null;
  const startedMs = Date.parse(value);
  if (!Number.isFinite(startedMs)) return null;
  if (nowMs(now) - startedMs > GENERATION_STALE_MS) return null;
  return value;
}

function redactSecrets(value) {
  return String(value || '').replace(/sk_(live|test)_[A-Za-z0-9]+|rk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g, '[redacted]');
}

function inProgressCount(metadata) {
  const raw = parseInt(metadata && metadata.generation_in_progress, 10);
  if (Number.isInteger(raw) && raw >= 0 && raw <= 100000) return raw;
  return readInProgress(metadata) ? 1 : 0;
}

async function integratorOverageUnused(stripe, metadata) {
  const subscriptionId = metadata && typeof metadata.subscription_id === 'string' ? metadata.subscription_id : '';
  if (!OBJECT_ID.test(subscriptionId) || !stripe || !stripe.subscriptions || typeof stripe.subscriptions.retrieve !== 'function') {
    return false;
  }
  const subscription = await retrieve((id) => stripe.subscriptions.retrieve(id), subscriptionId);
  const raw = subscription && subscription.metadata ? subscription.metadata.overage_remaining : undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 1000000;
}

function overageCreditUnused(metadata) {
  if (!metadata) return true;
  if (readStamp(metadata).delivered) return false;
  const used = parseInt(metadata.manuals_used, 10);
  if (Number.isFinite(used) && used > 0) return false;
  for (const key of ['credits_remaining', 'overage_credits']) {
    if (metadata[key] == null || metadata[key] === '') continue;
    const n = Number(metadata[key]);
    if (!Number.isFinite(n)) continue;
    return n > 0;
  }
  if (metadata.credit_status === 'revoked') return false;
  return true;
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

function eligibility(stamp, deadline, now, flags = {}) {
  const delivered = Boolean(stamp && stamp.delivered);
  const deliveredAt = delivered ? (stamp.delivered_at || null) : null;
  if (delivered) {
    return {
      delivered: true,
      delivered_at: deliveredAt,
      refund_eligible: false,
      deadline: flags.overage ? null : (deadline || null),
      reason: deliveredAt ? `delivered at ${deliveredAt}` : 'delivered',
    };
  }
  if (flags.inProgress) {
    return {
      delivered: false,
      delivered_at: null,
      refund_eligible: false,
      deadline: flags.overage ? null : (deadline || null),
      reason: `generation in progress since ${flags.inProgress}; check again after it finishes`,
    };
  }
  if (flags.overage) {
    return {
      delivered: false,
      delivered_at: null,
      refund_eligible: Boolean(flags.overageUnused),
      deadline: null,
      reason: flags.overageUnused ? 'eligible until the overage credit is used' : 'overage credit already used',
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

function purchaseRow({ id, kind, plan, stamp, via, customer, deadline, now, inProgress, overage, overageUnused }) {
  const decision = eligibility(stamp, deadline || null, now, {
    inProgress: inProgress || null,
    overage: Boolean(overage),
    overageUnused: Boolean(overageUnused),
  });
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
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: { first_manual_at: now, generation_started_at: '', generation_in_progress: '' },
    });
    return { delivered_at: now, created: true };
  });
}

async function stampObject(stripe, kind, id, now) {
  const resource = kind === 'charge' ? stripe.charges : stripe.invoices;
  return withCreditLock(id, async () => {
    const current = await resource.retrieve(id);
    const existing = readStamp(current && current.metadata);
    if (existing.delivered) return { delivered_at: existing.delivered_at, created: false };
    await resource.update(id, { metadata: { first_manual_at: now, generation_started_at: '', generation_in_progress: '' } });
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
  const metaPlan = subscription.metadata && subscription.metadata.plan;
  const plan = typeof metaPlan === 'string' && metaPlan && metaPlan !== 'starter' ? metaPlan : 'pro';
  const chargeId = chargeIdFromInvoice(invoice);
  if (chargeId) return { kind: 'charge', id: chargeId, plan };
  if (invoice.id) return { kind: 'invoice', id: invoice.id, plan };
  return null;
}

async function progressTarget(stripe, access, sessionId) {
  if (!stripe || !access) return null;
  if (access.plan === 'starter' && access.paymentIntentId) {
    return { kind: 'payment_intent', id: access.paymentIntentId };
  }
  if (!access.plan || access.plan === 'starter') return null;
  return currentPeriodTarget(stripe, sessionId);
}

async function markGenerationStarted(stripe, access, sessionId, options = {}) {
  const target = await progressTarget(stripe, access, sessionId);
  if (!target) return null;
  const now = stampNow(options.now);
  const resource = target.kind === 'payment_intent'
    ? stripe.paymentIntents
    : (target.kind === 'charge' ? stripe.charges : stripe.invoices);
  if (!resource || typeof resource.retrieve !== 'function' || typeof resource.update !== 'function') return null;
  return withCreditLock(target.id, async () => {
    const current = await resource.retrieve(target.id);
    const meta = (current && current.metadata) || {};
    if (readStamp(meta).delivered) return null;
    const freshStart = readInProgress(meta, now);
    // A start older than 15 minutes is not a live run. resetOrphans is set
    // when this process has no generation still running for the purchase, so
    // a crash or redeploy does not add another count on top of the leftover.
    if (!freshStart || options.resetOrphans) {
      await resource.update(target.id, {
        metadata: {
          generation_started_at: now,
          generation_in_progress: '1',
        },
      });
      return now;
    }
    const count = inProgressCount(meta);
    await resource.update(target.id, {
      metadata: {
        generation_started_at: freshStart,
        generation_in_progress: String(count + 1),
      },
    });
    return freshStart;
  });
}

async function clearGenerationOnce(stripe, access, sessionId) {
  const target = await progressTarget(stripe, access, sessionId);
  if (!target) return;
  const resource = target.kind === 'payment_intent'
    ? stripe.paymentIntents
    : (target.kind === 'charge' ? stripe.charges : stripe.invoices);
  if (!resource || typeof resource.retrieve !== 'function' || typeof resource.update !== 'function') return;
  await withCreditLock(target.id, async () => {
    const current = await resource.retrieve(target.id);
    const meta = (current && current.metadata) || {};
    const count = inProgressCount(meta);
    if (count <= 0) return;
    const next = count - 1;
    const metadata = { generation_in_progress: next === 0 ? '' : String(next) };
    if (next === 0) metadata.generation_started_at = '';
    await resource.update(target.id, { metadata });
  });
}

async function clearGenerationStarted(stripe, access, sessionId) {
  let lastError;
  for (let attempt = 1; attempt <= CLEAR_ATTEMPTS; attempt += 1) {
    try {
      await clearGenerationOnce(stripe, access, sessionId);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  const plan = access && access.plan ? access.plan : 'unknown';
  const detail = redactSecrets(lastError && lastError.message ? lastError.message : lastError);
  console.error(`Generation progress clear failed after ${CLEAR_ATTEMPTS} attempts`, plan, detail);
}

async function rollbackFirstManual(stripe, access, sessionId, deliveredAt) {
  if (!deliveredAt) return;
  try {
    const target = await progressTarget(stripe, access, sessionId);
    if (!target) return;
    const resource = target.kind === 'payment_intent'
      ? stripe.paymentIntents
      : (target.kind === 'charge' ? stripe.charges : stripe.invoices);
    if (!resource || typeof resource.retrieve !== 'function' || typeof resource.update !== 'function') return;
    await withCreditLock(target.id, async () => {
      const current = await resource.retrieve(target.id);
      const meta = (current && current.metadata) || {};
      if (meta.first_manual_at !== deliveredAt) return;
      await resource.update(target.id, { metadata: { first_manual_at: '' } });
    });
  } catch (err) {
    console.error('First manual delivery stamp rollback failed', access && access.plan ? access.plan : 'unknown');
  }
}

async function markFirstManualDelivered(stripe, access, sessionId, options = {}) {
  if (!stripe || !access) return null;
  const now = stampNow(options.now);
  if (access.plan === 'starter' && access.paymentIntentId) {
    return stampPaymentIntent(stripe, access.paymentIntentId, now);
  }
  if (!access.plan || access.plan === 'starter') return null;
  const target = await currentPeriodTarget(stripe, sessionId);
  if (!target) return null;
  return stampObject(stripe, target.kind, target.id, now);
}

function namedPlan(metadata) {
  const plan = metadata && metadata.plan;
  if (typeof plan === 'string' && plan && plan !== 'starter') return plan;
  return 'pro';
}

async function planForInvoice(stripe, invoice) {
  const subscription = subscriptionRef(invoice);
  if (!subscription) return 'pro';
  if (typeof subscription === 'object') return namedPlan(subscription.metadata);
  if (!stripe.subscriptions || typeof stripe.subscriptions.retrieve !== 'function') return 'pro';
  const loaded = await retrieve((id) => stripe.subscriptions.retrieve(id), subscription);
  const metaPlan = loaded && loaded.metadata && loaded.metadata.plan;
  if (typeof metaPlan === 'string' && metaPlan && metaPlan !== 'starter') return metaPlan;
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
  const overageMeta = plan === 'starter'
    ? null
    : await overageMetadata(stripe, piId, [pi && pi.metadata, charge.metadata, extra.sessionMetadata]);
  if (overageMeta) plan = 'overage';
  const inProgress = readInProgress(pi && pi.metadata, extra.now) || readInProgress(charge.metadata, extra.now) || readInProgress(invoice && invoice.metadata, extra.now);
  const creditMeta = (pi && pi.metadata) || charge.metadata || {};
  let deadline = null;
  if (plan === 'overage') deadline = null;
  else if (plan === 'starter') deadline = starterDeadlineIso(created);
  else deadline = isoFromUnix(periodEndUnix(invoice, await loadSubscription(stripe, invoice)));
  const overageUnused = plan !== 'overage'
    ? false
    : (overageMeta && overageMeta.plan === 'integrator_overage'
      ? await integratorOverageUnused(stripe, overageMeta)
      : overageCreditUnused(creditMeta));
  return purchaseRow({
    id: charge.id,
    kind: 'charge',
    plan,
    stamp,
    via: extra.via,
    customer: extra.customer || idOf(charge.customer),
    deadline,
    now: extra.now,
    inProgress,
    overage: plan === 'overage',
    overageUnused,
  });
}

async function overageMetadata(stripe, paymentIntentId, candidates) {
  const found = (candidates || []).find((meta) => isOverage(meta));
  if (found) return found;
  if (!paymentIntentId) return null;
  const list = stripe.checkout && stripe.checkout.sessions && stripe.checkout.sessions.list;
  if (typeof list !== 'function') return null;
  const listed = await list.call(stripe.checkout.sessions, { payment_intent: paymentIntentId, limit: 10 });
  const sessions = listed && Array.isArray(listed.data) ? listed.data : [];
  const session = sessions.find((row) => row && isOverage(row.metadata));
  return session ? session.metadata : null;
}

async function rowFromPaymentIntent(stripe, pi, extra = {}) {
  const metaPlan = pi.metadata && pi.metadata.plan;
  const overageOnIntent = metaPlan !== 'starter'
    ? await overageMetadata(stripe, pi.id, [pi.metadata, extra.sessionMetadata])
    : null;
  if (overageOnIntent && !(pi.latest_charge && stripe.charges)) {
    const overageUnused = overageOnIntent.plan === 'integrator_overage'
      ? await integratorOverageUnused(stripe, overageOnIntent)
      : overageCreditUnused(pi.metadata);
    return purchaseRow({
      id: pi.id,
      kind: 'payment_intent',
      plan: 'overage',
      stamp: readStamp(pi.metadata),
      via: extra.via,
      customer: extra.customer || idOf(pi.customer),
      deadline: null,
      now: extra.now,
      inProgress: readInProgress(pi.metadata, extra.now),
      overage: true,
      overageUnused,
    });
  }
  if (metaPlan !== 'starter' && pi.latest_charge && stripe.charges) {
    const charge = typeof pi.latest_charge === 'object'
      ? pi.latest_charge
      : await retrieve((id) => stripe.charges.retrieve(id), idOf(pi.latest_charge));
    if (charge) return rowFromCharge(stripe, charge, extra);
  }
  const stamp = readStamp(pi.metadata);
  const created = firstUnix(pi.created, extra.created);
  const overageMeta = overageOnIntent || (isOverage(extra.sessionMetadata) ? extra.sessionMetadata : null);
  const overage = Boolean(overageMeta);
  const deadline = overage ? null : (metaPlan === 'starter' || !metaPlan ? starterDeadlineIso(created) : null);
  const overageUnused = !overage
    ? false
    : (overageMeta.plan === 'integrator_overage'
      ? await integratorOverageUnused(stripe, overageMeta)
      : overageCreditUnused(pi.metadata));
  return purchaseRow({
    id: pi.id,
    kind: 'payment_intent',
    plan: overage ? 'overage' : (metaPlan || null),
    stamp,
    via: extra.via,
    customer: extra.customer || idOf(pi.customer),
    deadline,
    now: extra.now,
    inProgress: readInProgress(pi.metadata, extra.now),
    overage,
    overageUnused,
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
    inProgress: readInProgress(invoice.metadata, extra.now),
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
  const extra = {
    via: id,
    created: session.created,
    now,
    customer: idOf(session.customer),
    sessionMetadata: session.metadata,
  };
  if (isOverage(session.metadata) || plan === 'starter' || (!session.invoice && !session.subscription)) {
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

function remember(purchases, seen, row) {
  if (!row || !row.id || seen.has(row.id)) return;
  seen.add(row.id);
  purchases.push(row);
}

async function rowFromSession(stripe, session, now) {
  if (!session) return null;
  const plan = session.metadata && session.metadata.plan;
  const extra = {
    via: session.id,
    created: session.created,
    now,
    customer: idOf(session.customer),
    sessionMetadata: session.metadata,
  };
  if (isOverage(session.metadata) || plan === 'starter' || (!session.invoice && !session.subscription)) {
    const pi = typeof session.payment_intent === 'object'
      ? session.payment_intent
      : await retrieve((paymentIntentId) => stripe.paymentIntents.retrieve(paymentIntentId), idOf(session.payment_intent));
    if (!pi) return null;
    return rowFromPaymentIntent(stripe, pi, extra);
  }
  if (!session.invoice) return null;
  const invoice = typeof session.invoice === 'object'
    ? session.invoice
    : await retrieve((invoiceId) => stripe.invoices.retrieve(invoiceId), idOf(session.invoice));
  if (!invoice) return null;
  return rowFromInvoice(stripe, invoice, extra);
}

async function checkEmail(stripe, email, now) {
  const purchases = [];
  const seen = new Set();
  if (stripe.customers && typeof stripe.customers.list === 'function') {
    const listed = await stripe.customers.list({ email, limit: 10 });
    const customers = listed && Array.isArray(listed.data) ? listed.data : [];
    for (const customer of customers) {
      if (!customer || !customer.id || !stripe.charges || typeof stripe.charges.list !== 'function') continue;
      const charges = await stripe.charges.list({ customer: customer.id, limit: 20 });
      const rows = charges && Array.isArray(charges.data) ? charges.data : [];
      for (const charge of rows) {
        if (!charge || !charge.id) continue;
        remember(purchases, seen, await rowFromCharge(stripe, charge, { customer: customer.id, now }));
      }
    }
  }
  const listSessions = stripe.checkout && stripe.checkout.sessions && stripe.checkout.sessions.list;
  if (typeof listSessions === 'function') {
    const listed = await listSessions.call(stripe.checkout.sessions, { customer_details: { email }, limit: 10 });
    const sessions = listed && Array.isArray(listed.data) ? listed.data : [];
    for (const session of sessions) {
      remember(purchases, seen, await rowFromSession(stripe, session, now));
    }
  }
  if (!purchases.length) return missing();
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
  rollbackFirstManual,
  markGenerationStarted,
  clearGenerationStarted,
  refundCheck,
};
