const { isStripeNotFound, withCreditLock } = require('./billing');

// Starter credits live on the PaymentIntent metadata written at Checkout
// (`plan`, `manuals_used`). A charge maps back through `payment_intent`, and
// when that metadata has no plan, through the Checkout Session for that
// PaymentIntent. Pro and other plans are left alone.
//
// Partial refunds are logged and do not change credits. Only a full refund
// (`refunded === true`, or `amount_refunded >= amount`) sets `credit_status`
// to `revoked`. A dispute opening sets `suspended`. `charge.dispute.closed`
// with status `won` (the charge stands) restores `active`. Status `lost`
// sets `revoked` permanently, and a later `won` does not restore it.
// Event ids already stored in `credit_events` are not applied again.

const EVENT_ID = /^[A-Za-z0-9_]{1,64}$/;
const OBJECT_ID = /^[A-Za-z0-9_]{1,64}$/;

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

function logLine(message) {
  const text = String(message);
  if (text.length > 240 || /sk_|rk_|whsec_|@/.test(text)) return;
  console.log(text);
}

function amountOf(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100000000) return 'unknown';
  return String(n);
}

function isFullRefund(charge) {
  if (!charge || typeof charge !== 'object') return false;
  if (charge.refunded === true) return true;
  const amount = Number(charge.amount);
  const refunded = Number(charge.amount_refunded);
  return Number.isFinite(amount) && amount > 0 && Number.isFinite(refunded) && refunded >= amount;
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

function statusOf(meta) {
  if (meta.credit_status === 'revoked' || meta.credit_status === 'suspended') return meta.credit_status;
  return 'active';
}

async function retrieveOrNull(retrieve, id) {
  try {
    return await retrieve(id);
  } catch (err) {
    if (isStripeNotFound(err)) return null;
    throw err;
  }
}

async function starterIntent(stripe, paymentIntentRef) {
  const id = safeId(paymentIntentRef);
  if (!id || !stripe || !stripe.paymentIntents || typeof stripe.paymentIntents.retrieve !== 'function') return null;
  const pi = await retrieveOrNull((paymentIntentId) => stripe.paymentIntents.retrieve(paymentIntentId), id);
  if (!pi || !pi.id) return null;
  const plan = pi.metadata && pi.metadata.plan;
  if (plan === 'starter') return pi;
  if (plan) return null;
  const list = stripe.checkout && stripe.checkout.sessions && stripe.checkout.sessions.list;
  if (typeof list !== 'function') return null;
  const listed = await list.call(stripe.checkout.sessions, { payment_intent: id, limit: 10 });
  const sessions = listed && Array.isArray(listed.data) ? listed.data : [];
  const match = sessions.find((session) => session && session.metadata && session.metadata.plan === 'starter');
  return match ? pi : null;
}

async function intentFromCharge(stripe, charge) {
  if (!charge || !charge.payment_intent) return null;
  return starterIntent(stripe, charge.payment_intent);
}

async function intentFromDispute(stripe, dispute) {
  if (!dispute) return null;
  if (dispute.payment_intent) return starterIntent(stripe, dispute.payment_intent);
  const charge = dispute.charge;
  if (charge && typeof charge === 'object') return intentFromCharge(stripe, charge);
  const chargeId = safeId(charge);
  if (!chargeId || !stripe.charges || typeof stripe.charges.retrieve !== 'function') return null;
  const loaded = await retrieveOrNull((id) => stripe.charges.retrieve(id), chargeId);
  return intentFromCharge(stripe, loaded);
}

function planField(meta) {
  if (meta.plan === 'starter') return {};
  return { plan: 'starter' };
}

async function commit(stripe, paymentIntentId, eventId, decide) {
  return withCreditLock(paymentIntentId, async () => {
    const current = await stripe.paymentIntents.retrieve(paymentIntentId);
    const meta = (current && current.metadata) || {};
    if (meta.plan && meta.plan !== 'starter') return { action: 'ignored' };
    const memory = eventMemory(meta.credit_events, eventId);
    if (memory.duplicate) return { action: 'duplicate' };
    const decision = decide(meta, memory);
    if (!decision.write) return decision.result;
    const metadata = { ...planField(meta), ...decision.metadata };
    if (memory.stored) metadata.credit_events = memory.stored;
    await stripe.paymentIntents.update(paymentIntentId, { metadata });
    return decision.result;
  });
}

function recordOnly(meta, memory, result) {
  const same = memory.stored === String(meta.credit_events || '');
  return {
    write: Boolean(memory.stored) && !same,
    metadata: {},
    result,
  };
}

async function applyRefund(stripe, event) {
  const charge = event.data && event.data.object ? event.data.object : {};
  const chargeId = safeId(charge.id) || 'unknown';
  const pi = await intentFromCharge(stripe, charge);
  if (!pi) {
    logLine(`charge.refunded ignored no Starter entitlement ${chargeId}`);
    return { action: 'unknown' };
  }
  const full = isFullRefund(charge);
  return commit(stripe, pi.id, event.id, (meta, memory) => {
    if (!full) {
      // A partial refund keeps every remaining Starter credit. Stripe sends
      // charge.refunded again if later refunds add up to the full amount.
      logLine(`charge.refunded partial Starter credits kept ${chargeId} amount_refunded ${amountOf(charge.amount_refunded)} amount ${amountOf(charge.amount)}`);
      return recordOnly(meta, memory, { action: 'partial' });
    }
    if (statusOf(meta) === 'revoked') {
      return recordOnly(meta, memory, { action: 'already_revoked' });
    }
    logLine(`charge.refunded full Starter credits revoked ${chargeId} ${safeId(pi.id) || 'unknown'}`);
    return {
      write: true,
      metadata: { credit_status: 'revoked', credit_revoke_reason: 'refund' },
      result: { action: 'revoked' },
    };
  });
}

async function applyDisputeCreated(stripe, event) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const disputeId = safeId(dispute.id) || 'unknown';
  const pi = await intentFromDispute(stripe, dispute);
  if (!pi) {
    logLine(`charge.dispute.created ignored no Starter entitlement ${disputeId}`);
    return { action: 'unknown' };
  }
  return commit(stripe, pi.id, event.id, (meta, memory) => {
    const status = statusOf(meta);
    if (status === 'revoked' || status === 'suspended') {
      return recordOnly(meta, memory, { action: status === 'revoked' ? 'already_revoked' : 'already_suspended' });
    }
    logLine(`charge.dispute.created Starter credits suspended ${disputeId} ${safeId(pi.id) || 'unknown'}`);
    const metadata = { credit_status: 'suspended' };
    const disputeKey = safeId(dispute.id);
    if (disputeKey) metadata.credit_dispute = disputeKey;
    return { write: true, metadata, result: { action: 'suspended' } };
  });
}

async function applyDisputeClosed(stripe, event) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const disputeId = safeId(dispute.id) || 'unknown';
  const closed = typeof dispute.status === 'string' ? dispute.status : '';
  const pi = await intentFromDispute(stripe, dispute);
  if (!pi) {
    logLine(`charge.dispute.closed ignored no Starter entitlement ${disputeId}`);
    return { action: 'unknown' };
  }
  return commit(stripe, pi.id, event.id, (meta, memory) => {
    const status = statusOf(meta);
    if (closed === 'won') {
      if (status !== 'suspended') {
        logLine(`charge.dispute.closed Starter credits not restored ${disputeId} ${status}`);
        return recordOnly(meta, memory, { action: status === 'revoked' ? 'already_revoked' : 'not_suspended' });
      }
      logLine(`charge.dispute.closed Starter credits restored ${disputeId} won`);
      return {
        write: true,
        metadata: { credit_status: 'active', credit_dispute: '', credit_revoke_reason: '' },
        result: { action: 'restored' },
      };
    }
    // Stripe `lost` means the charge does not stand. Revoke permanently so a
    // later `won` cannot turn the credits back on. `warning_closed` is not a
    // loss. `charge_refunded` is handled with refunds when that event arrives;
    // if the opening event never arrived, suspend until the refund event does.
    if (closed === 'lost') {
      if (status === 'revoked') {
        logLine(`charge.dispute.closed Starter credits already revoked ${disputeId} lost`);
        return recordOnly(meta, memory, { action: 'already_revoked' });
      }
      logLine(`charge.dispute.closed Starter credits revoked ${disputeId} lost`);
      return {
        write: true,
        metadata: { credit_status: 'revoked', credit_revoke_reason: 'dispute' },
        result: { action: 'revoked' },
      };
    }
    if (closed === 'charge_refunded' && status === 'active') {
      logLine(`charge.dispute.closed Starter credits suspended ${disputeId} ${closed}`);
      const metadata = { credit_status: 'suspended' };
      const disputeKey = safeId(dispute.id);
      if (disputeKey) metadata.credit_dispute = disputeKey;
      return { write: true, metadata, result: { action: 'suspended' } };
    }
    logLine(`charge.dispute.closed Starter credits not restored ${disputeId} ${closed || 'unknown'}`);
    return recordOnly(meta, memory, { action: 'not_restored' });
  });
}

async function applyStarterChargeEvent(stripe, event) {
  if (!event || typeof event.type !== 'string') return { action: 'ignored' };
  if (event.type === 'charge.refunded') return applyRefund(stripe, event);
  if (event.type === 'charge.dispute.created') return applyDisputeCreated(stripe, event);
  if (event.type === 'charge.dispute.closed') return applyDisputeClosed(stripe, event);
  return { action: 'ignored' };
}

module.exports = {
  applyStarterChargeEvent,
  isFullRefund,
};
