const { withCreditLock } = require('./billing');

// One-time overage credits are Checkout Sessions whose metadata says so
// (`kind`, `purchase`, or `credit` of `overage`, or `overage=true`). A full
// refund or a lost dispute removes one unused credit. An open dispute
// suspends that PaymentIntent until the dispute is won. A used credit is
// logged and left as it is.

const EVENT_ID = /^[A-Za-z0-9_]{1,64}$/;
const OBJECT_ID = /^[A-Za-z0-9_]{1,64}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function idOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return '';
}

function safeId(value) {
  const id = idOf(value);
  return OBJECT_ID.test(id) ? id : '';
}

function notFound(err) {
  return Boolean(err && (err.statusCode === 404 || err.code === 'resource_missing'));
}

function logLine(message) {
  const text = String(message);
  if (text.length > 240 || /sk_|rk_|whsec_|@/.test(text)) return;
  console.log(text);
}

function isOverage(metadata) {
  if (!metadata || typeof metadata !== 'object') return false;
  if (metadata.plan === 'starter') return false;
  if (metadata.kind === 'overage' || metadata.purchase === 'overage' || metadata.credit === 'overage') return true;
  if (metadata.overage === 'true' || metadata.overage === true) return true;
  return false;
}

function eventMemory(existing, eventId) {
  const prior = String(existing || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => EVENT_ID.test(part));
  const trackable = typeof eventId === 'string' && EVENT_ID.test(eventId);
  if (!trackable) return { duplicate: false, stored: prior.join(',') };
  if (prior.includes(eventId)) return { duplicate: true, stored: prior.join(',') };
  const next = prior.concat(eventId);
  while (next.join(',').length > 500 && next.length > 1) next.shift();
  return { duplicate: false, stored: next.join(',') };
}

function isFullRefund(charge) {
  if (!charge || typeof charge !== 'object') return false;
  if (charge.refunded === true) return true;
  const amount = Number(charge.amount);
  const refunded = Number(charge.amount_refunded);
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(refunded) && refunded >= amount;
}

function delivered(metadata) {
  const value = metadata && typeof metadata.first_manual_at === 'string' ? metadata.first_manual_at.trim() : '';
  return Boolean(value && (STAMP.test(value) || value));
}

function creditConsumed(metadata) {
  if (!metadata) return false;
  if (delivered(metadata)) return true;
  const used = parseInt(metadata.manuals_used, 10);
  return Number.isFinite(used) && used > 0;
}

function counterKey(metadata) {
  if (!metadata) return null;
  for (const key of ['credits_remaining', 'overage_credits']) {
    if (metadata[key] == null || metadata[key] === '') continue;
    const n = Number(metadata[key]);
    if (Number.isInteger(n) && n >= 0 && n <= 1000000) return { key, value: n };
  }
  return null;
}

function removal(metadata, reason) {
  if (creditConsumed(metadata)) return { write: false, action: 'already_used', metadata: {} };
  const counter = counterKey(metadata);
  if (counter) {
    if (counter.value <= 0) return { write: false, action: 'already_used', metadata: {} };
    return { write: true, action: 'decremented', metadata: { [counter.key]: String(counter.value - 1) } };
  }
  if (metadata && metadata.credit_status === 'revoked') return { write: false, action: 'already_used', metadata: {} };
  return {
    write: true,
    action: 'revoked',
    metadata: { credit_status: 'revoked', credit_revoke_reason: reason },
  };
}

async function commitPi(stripe, paymentIntentId, eventId, decide) {
  return withCreditLock(paymentIntentId, async () => {
    const current = await stripe.paymentIntents.retrieve(paymentIntentId);
    const meta = (current && current.metadata) || {};
    const memory = eventMemory(meta.credit_events, eventId);
    if (memory.duplicate) return { action: 'duplicate' };
    const decision = decide(meta, memory);
    const metadata = { ...(decision.metadata || {}) };
    if (memory.stored && memory.stored !== String(meta.credit_events || '')) metadata.credit_events = memory.stored;
    if (decision.write || metadata.credit_events) {
      await stripe.paymentIntents.update(paymentIntentId, { metadata });
    }
    return decision.result;
  });
}

async function chargeRecord(stripe, charge) {
  if (!charge) return null;
  if (charge.payment_intent) return charge;
  const id = safeId(charge.id || charge);
  if (!id || !stripe.charges || typeof stripe.charges.retrieve !== 'function') return charge.id ? charge : null;
  try {
    return await stripe.charges.retrieve(id);
  } catch (err) {
    if (notFound(err)) return charge.id ? charge : null;
    throw err;
  }
}

async function paymentIntentIdOf(stripe, charge) {
  const record = await chargeRecord(stripe, charge);
  return safeId(record && record.payment_intent);
}

async function overageTarget(stripe, charge) {
  const paymentIntentId = await paymentIntentIdOf(stripe, charge);
  if (!paymentIntentId) return null;
  const list = stripe.checkout && stripe.checkout.sessions && stripe.checkout.sessions.list;
  if (typeof list !== 'function') return null;
  const listed = await list.call(stripe.checkout.sessions, { payment_intent: paymentIntentId, limit: 10 });
  const sessions = listed && Array.isArray(listed.data) ? listed.data : [];
  const session = sessions.find((row) => row && isOverage(row.metadata));
  if (!session) return null;
  return { paymentIntentId };
}

async function eventCharge(stripe, event) {
  const object = event.data && event.data.object ? event.data.object : {};
  if (event.type === 'charge.refunded') return object;
  if (object.charge && typeof object.charge === 'object') return object.charge;
  return chargeRecord(stripe, { id: object.charge });
}

async function applyOverageRefund(stripe, event) {
  const charge = event.data && event.data.object ? event.data.object : {};
  const target = await overageTarget(stripe, charge);
  if (!target) return { action: 'unknown' };
  const full = isFullRefund(charge);
  return commitPi(stripe, target.paymentIntentId, event.id, (meta) => {
    if (!full) {
      logLine(`charge.refunded partial overage credit unchanged ${target.paymentIntentId}`);
      return { write: false, metadata: {}, result: { action: 'partial' } };
    }
    const next = removal(meta, 'refund');
    if (!next.write) {
      logLine(`overage credit already used ${target.paymentIntentId}`);
      return { write: false, metadata: {}, result: { action: 'already_used' } };
    }
    logLine(`overage credit removed ${target.paymentIntentId} ${next.action}`);
    return { write: true, metadata: next.metadata, result: { action: next.action } };
  });
}

async function applyOverageDisputeOpened(stripe, event) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const target = await overageTarget(stripe, await eventCharge(stripe, event));
  if (!target) return { action: 'unknown' };
  return commitPi(stripe, target.paymentIntentId, event.id, (meta) => {
    if (meta.credit_status === 'revoked' || meta.credit_status === 'suspended') {
      return { write: false, metadata: {}, result: { action: meta.credit_status === 'revoked' ? 'already_revoked' : 'already_suspended' } };
    }
    logLine(`overage credit suspended ${target.paymentIntentId}`);
    return { write: true, metadata: { credit_status: 'suspended' }, result: { action: 'suspended' } };
  });
}

async function applyOverageDisputeClosed(stripe, event) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const closed = typeof dispute.status === 'string' ? dispute.status : '';
  const target = await overageTarget(stripe, await eventCharge(stripe, event));
  if (!target) return { action: 'unknown' };
  return commitPi(stripe, target.paymentIntentId, event.id, (meta) => {
    if (closed === 'won') {
      if (meta.credit_status !== 'suspended') {
        logLine(`overage credit not restored ${target.paymentIntentId}`);
        return { write: false, metadata: {}, result: { action: meta.credit_status === 'revoked' ? 'already_revoked' : 'not_suspended' } };
      }
      logLine(`overage credit restored ${target.paymentIntentId}`);
      return { write: true, metadata: { credit_status: 'active' }, result: { action: 'restored' } };
    }
    if (closed === 'lost') {
      const next = removal(meta, 'dispute');
      if (!next.write) {
        logLine(`overage credit already used ${target.paymentIntentId}`);
        return { write: false, metadata: {}, result: { action: 'already_used' } };
      }
      logLine(`overage credit removed ${target.paymentIntentId} lost`);
      return { write: true, metadata: next.metadata, result: { action: next.action } };
    }
    if (closed === 'charge_refunded' && (!meta.credit_status || meta.credit_status === 'active')) {
      logLine(`overage credit suspended ${target.paymentIntentId}`);
      return { write: true, metadata: { credit_status: 'suspended' }, result: { action: 'suspended' } };
    }
    logLine(`overage credit unchanged ${target.paymentIntentId} ${closed || 'unknown'}`);
    return { write: false, metadata: {}, result: { action: 'unchanged' } };
  });
}

async function applyOverageCreditEvent(stripe, event, starterResult) {
  const starterAction = starterResult && starterResult.action;
  if (starterAction && starterAction !== 'unknown' && starterAction !== 'ignored') {
    return { action: 'skipped' };
  }
  if (!event || typeof event.type !== 'string') return { action: 'ignored' };
  if (event.type === 'charge.refunded') return applyOverageRefund(stripe, event);
  if (event.type === 'charge.dispute.created') return applyOverageDisputeOpened(stripe, event);
  if (event.type === 'charge.dispute.closed') return applyOverageDisputeClosed(stripe, event);
  return { action: 'ignored' };
}

module.exports = {
  isOverage,
  applyOverageCreditEvent,
};
