const { withCreditLock } = require('./billing');
const { restoresAccess } = require('./dispute-outcome');

// One-time overage credits are Checkout Sessions whose metadata says so
// (`kind`, `purchase`, or `credit` of `overage`, or `overage=true`).
// Integrator overage from the other plan uses `plan: integrator_overage`
// and stores the count on the subscription as `overage_remaining`.
// A full refund or a lost dispute removes one unused credit, once per
// purchase. The PaymentIntent is marked `overage_removed=pending` before
// the subscription count changes, then `overage_removed=1` after that
// decrement is stored. A retry that still sees `pending` decrements only
// when this PaymentIntent is not already in `overage_removed_intents`.
// `1` means the credit is already removed, including after the capped id
// list has rolled off.
// An open dispute suspends that credit until the dispute is won. A closed
// id that arrives before the opening event does not suspend. A used credit
// is logged and left as it is. Access is restored only for `won`.
// `warning_closed` and `prevented` do not restore access.

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
  if (metadata.plan === 'integrator_overage') return true;
  if (metadata.plan === 'starter') return false;
  if (metadata.kind === 'overage' || metadata.purchase === 'overage' || metadata.credit === 'overage') return true;
  if (metadata.overage === 'true' || metadata.overage === true) return true;
  return false;
}

function isIntegratorOverage(metadata) {
  return Boolean(metadata && metadata.plan === 'integrator_overage');
}

function disputeIds(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z0-9_]{1,64}$/.test(part));
}

function packDisputeIds(ids) {
  const unique = [];
  for (const id of ids) {
    if (id && !unique.includes(id)) unique.push(id);
  }
  while (unique.join(',').length > 500 && unique.length > 1) unique.shift();
  const packed = unique.join(',');
  return packed.length > 500 ? '' : packed;
}

function rememberClosed(meta, key, disputeId) {
  if (!disputeId) return {};
  return { [key]: packDisputeIds(disputeIds(meta && meta[key]).concat(disputeId)) };
}

function alreadyClosed(meta, key, disputeId) {
  return Boolean(disputeId) && disputeIds(meta && meta[key]).includes(disputeId);
}

function overageOpenState(meta) {
  const list = disputeIds(meta && meta.overage_open_disputes);
  const raw = parseInt(meta && meta.overage_open_count, 10);
  const count = Number.isInteger(raw) && raw >= 0 && raw <= 100000 ? Math.max(raw, list.length) : list.length;
  return { list, count };
}

function addOverageOpen(meta, disputeId) {
  if (!disputeId) return { changed: false, closed: false, metadata: {} };
  if (alreadyClosed(meta, 'overage_closed_disputes', disputeId)) return { changed: false, closed: true, metadata: {} };
  const state = overageOpenState(meta);
  if (state.list.includes(disputeId)) return { changed: false, closed: false, metadata: {} };
  return {
    changed: true,
    closed: false,
    metadata: {
      overage_open_disputes: packDisputeIds(state.list.concat(disputeId)),
      overage_open_count: String(state.count + 1),
    },
  };
}

function closeOverageOpen(meta, disputeId) {
  const state = overageOpenState(meta);
  const closed = disputeIds(meta && meta.overage_closed_disputes);
  const knownClosed = Boolean(disputeId) && closed.includes(disputeId);
  const inList = Boolean(disputeId) && state.list.includes(disputeId);
  const truncated = state.count > state.list.length;
  let nextCount = state.count;
  if (!knownClosed && (inList || truncated)) nextCount = Math.max(0, state.count - 1);
  return {
    count: nextCount,
    metadata: {
      overage_open_disputes: packDisputeIds(state.list.filter((id) => id !== disputeId)),
      overage_open_count: String(nextCount),
      overage_closed_disputes: disputeId ? packDisputeIds(closed.concat(disputeId)) : packDisputeIds(closed),
    },
  };
}

function decrementRemaining(meta) {
  const n = Number(meta && meta.overage_remaining);
  if (!Number.isInteger(n) || n <= 0 || n > 1000000) return null;
  return String(n - 1);
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

function purchaseRemoved(metadata) {
  return Boolean(metadata && String(metadata.overage_removed) === '1');
}

function removalPending(metadata) {
  return Boolean(metadata && String(metadata.overage_removed) === 'pending');
}

function removedIntentIds(meta) {
  return disputeIds(meta && meta.overage_removed_intents);
}

function rememberRemovedIntent(meta, paymentIntentId) {
  return packDisputeIds(removedIntentIds(meta).concat(paymentIntentId));
}

function removal(metadata, reason) {
  if (purchaseRemoved(metadata)) return { write: false, action: 'already_removed', metadata: {} };
  if (creditConsumed(metadata)) return { write: false, action: 'already_used', metadata: {} };
  const counter = counterKey(metadata);
  if (counter) {
    if (counter.value <= 0) return { write: false, action: 'already_used', metadata: {} };
    return {
      write: true,
      action: 'decremented',
      metadata: { [counter.key]: String(counter.value - 1), overage_removed: '1' },
    };
  }
  if (metadata && metadata.credit_status === 'revoked') return { write: false, action: 'already_used', metadata: {} };
  return {
    write: true,
    action: 'revoked',
    metadata: { credit_status: 'revoked', credit_revoke_reason: reason, overage_removed: '1' },
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
  if (!stripe || !id || !stripe.charges || typeof stripe.charges.retrieve !== 'function') return charge.id ? charge : null;
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
  if (isIntegratorOverage(session.metadata)) {
    const subscriptionId = safeId(session.metadata.subscription_id);
    if (!subscriptionId) return null;
    return { kind: 'integrator', subscriptionId, paymentIntentId };
  }
  return { kind: 'pi', paymentIntentId };
}

async function commitSub(stripe, subscriptionId, eventId, decide) {
  return withCreditLock(subscriptionId, async () => {
    const current = await stripe.subscriptions.retrieve(subscriptionId);
    const meta = (current && current.metadata) || {};
    const memory = eventMemory(meta.overage_events, eventId);
    if (memory.duplicate) return { action: 'duplicate' };
    const decision = await decide(meta, memory);
    const metadata = { ...(decision.metadata || {}) };
    if (memory.stored && memory.stored !== String(meta.overage_events || '')) metadata.overage_events = memory.stored;
    if (decision.write || metadata.overage_events) {
      await stripe.subscriptions.update(subscriptionId, { metadata });
    }
    if (typeof decision.after === 'function') await decision.after();
    return decision.result;
  });
}

async function withPurchase(stripe, target, eventId, decide) {
  return withCreditLock(target.paymentIntentId, async () => {
    const result = await commitSub(stripe, target.subscriptionId, eventId, decide);
    // A crash after the subscription write and before the marker becomes 1
    // stores the event id, so the retry is a duplicate and would otherwise
    // leave `pending` in place. Finalize only. Do not decrement again.
    if (result && result.action === 'duplicate') await finalizePendingRemoval(stripe, target);
    return result;
  });
}

async function writeRemovalState(stripe, paymentIntentId, value) {
  if (!stripe.paymentIntents || typeof stripe.paymentIntents.update !== 'function') {
    throw new Error('PaymentIntent update is not available');
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await stripe.paymentIntents.update(paymentIntentId, { metadata: { overage_removed: value } });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function finalizePendingRemoval(stripe, target) {
  const current = await stripe.paymentIntents.retrieve(target.paymentIntentId);
  const piMeta = (current && current.metadata) || {};
  if (!removalPending(piMeta)) return;
  const subscription = await stripe.subscriptions.retrieve(target.subscriptionId);
  const meta = (subscription && subscription.metadata) || {};
  if (!removedIntentIds(meta).includes(target.paymentIntentId)) return;
  await writeRemovalState(stripe, target.paymentIntentId, '1');
}

async function takeIntegratorCredit(stripe, target, meta) {
  const current = await stripe.paymentIntents.retrieve(target.paymentIntentId);
  const piMeta = (current && current.metadata) || {};
  const listed = removedIntentIds(meta).includes(target.paymentIntentId);
  if (purchaseRemoved(piMeta)) return { action: 'already_removed' };
  // `pending` plus this PaymentIntent already in the list means step 2
  // finished and step 3 did not. Close the marker and do not decrement.
  if (listed) {
    await writeRemovalState(stripe, target.paymentIntentId, '1');
    return { action: 'already_removed' };
  }
  const next = decrementRemaining(meta);
  if (next == null) return { action: 'already_used' };
  if (!removalPending(piMeta)) await writeRemovalState(stripe, target.paymentIntentId, 'pending');
  return {
    action: 'decremented',
    metadata: {
      overage_remaining: next,
      overage_removed_intents: rememberRemovedIntent(meta, target.paymentIntentId),
    },
    after: () => writeRemovalState(stripe, target.paymentIntentId, '1'),
  };
}

async function applyIntegratorRefund(stripe, event, target) {
  const charge = event.data && event.data.object ? event.data.object : {};
  const full = isFullRefund(charge);
  return withPurchase(stripe, target, event.id, async (meta) => {
    if (!full) {
      logLine(`charge.refunded partial integrator overage unchanged ${target.subscriptionId}`);
      return { write: false, metadata: {}, result: { action: 'partial' } };
    }
    const taken = await takeIntegratorCredit(stripe, target, meta);
    if (taken.action !== 'decremented') {
      logLine(`overage credit ${taken.action === 'already_removed' ? 'already removed' : 'already used'} ${target.subscriptionId}`);
      return { write: false, metadata: {}, result: { action: taken.action } };
    }
    logLine(`overage credit removed ${target.subscriptionId} decremented`);
    return { write: true, metadata: taken.metadata, after: taken.after, result: { action: 'decremented' } };
  });
}

async function applyIntegratorDisputeOpened(stripe, event, target) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const disputeKey = safeId(dispute.id);
  return commitSub(stripe, target.subscriptionId, event.id, (meta) => {
    const added = addOverageOpen(meta, disputeKey);
    if (added.closed) {
      logLine(`integrator overage dispute already closed ${target.subscriptionId}`);
      return { write: false, metadata: {}, result: { action: 'already_closed' } };
    }
    if (!added.changed) return { write: false, metadata: {}, result: { action: 'already_suspended' } };
    logLine(`integrator overage suspended ${target.subscriptionId}`);
    return {
      write: true,
      metadata: { ...added.metadata, overage_suspended: 'true' },
      result: { action: 'suspended' },
    };
  });
}

async function applyIntegratorDisputeClosed(stripe, event, target) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const closed = typeof dispute.status === 'string' ? dispute.status : '';
  const disputeKey = safeId(dispute.id);
  return withPurchase(stripe, target, event.id, async (meta) => {
    if (!restoresAccess(closed) && closed !== 'lost') {
      logLine(`integrator overage unchanged ${target.subscriptionId} ${closed || 'unknown'}`);
      return { write: false, metadata: {}, result: { action: 'unchanged' } };
    }
    const finished = closeOverageOpen(meta, disputeKey);
    const metadata = { ...finished.metadata };
    if (finished.count === 0) metadata.overage_suspended = '';
    if (closed === 'lost') {
      const taken = await takeIntegratorCredit(stripe, target, meta);
      if (taken.action !== 'decremented') {
        logLine(`overage credit ${taken.action === 'already_removed' ? 'already removed' : 'already used'} ${target.subscriptionId}`);
        return { write: true, metadata, result: { action: taken.action } };
      }
      Object.assign(metadata, taken.metadata);
      logLine(`overage credit removed ${target.subscriptionId} lost`);
      return { write: true, metadata, after: taken.after, result: { action: 'decremented' } };
    }
    const restored = restoresAccess(closed) && finished.count === 0;
    logLine(`integrator overage ${restored ? 'restored' : 'unchanged'} ${target.subscriptionId}`);
    return {
      write: true,
      metadata,
      result: { action: restored ? 'restored' : 'closed' },
    };
  });
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
  if (target.kind === 'integrator') return applyIntegratorRefund(stripe, event, target);
  const full = isFullRefund(charge);
  return commitPi(stripe, target.paymentIntentId, event.id, (meta) => {
    if (!full) {
      logLine(`charge.refunded partial overage credit unchanged ${target.paymentIntentId}`);
      return { write: false, metadata: {}, result: { action: 'partial' } };
    }
    const next = removal(meta, 'refund');
    if (!next.write) {
      logLine(`overage credit ${next.action === 'already_removed' ? 'already removed' : 'already used'} ${target.paymentIntentId}`);
      return { write: false, metadata: {}, result: { action: next.action } };
    }
    logLine(`overage credit removed ${target.paymentIntentId} ${next.action}`);
    return { write: true, metadata: next.metadata, result: { action: next.action } };
  });
}

async function applyOverageDisputeOpened(stripe, event) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const target = await overageTarget(stripe, await eventCharge(stripe, event));
  if (!target) return { action: 'unknown' };
  if (target.kind === 'integrator') return applyIntegratorDisputeOpened(stripe, event, target);
  const disputeKey = safeId(dispute.id);
  return commitPi(stripe, target.paymentIntentId, event.id, (meta) => {
    if (alreadyClosed(meta, 'credit_closed_disputes', disputeKey)) {
      return { write: false, metadata: {}, result: { action: 'already_closed' } };
    }
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
  if (target.kind === 'integrator') return applyIntegratorDisputeClosed(stripe, event, target);
  const disputeKey = safeId(dispute.id);
  return commitPi(stripe, target.paymentIntentId, event.id, (meta) => {
    if (!restoresAccess(closed) && closed !== 'lost') {
      logLine(`overage credit unchanged ${target.paymentIntentId} ${closed || 'unknown'}`);
      return { write: false, metadata: {}, result: { action: 'unchanged' } };
    }
    const closedMeta = rememberClosed(meta, 'credit_closed_disputes', disputeKey);
    if (restoresAccess(closed)) {
      if (meta.credit_status !== 'suspended') {
        logLine(`overage credit not restored ${target.paymentIntentId}`);
        return {
          write: true,
          metadata: closedMeta,
          result: { action: meta.credit_status === 'revoked' ? 'already_revoked' : 'not_suspended' },
        };
      }
      logLine(`overage credit restored ${target.paymentIntentId}`);
      return { write: true, metadata: { ...closedMeta, credit_status: 'active' }, result: { action: 'restored' } };
    }
    if (closed === 'lost') {
      const next = removal(meta, 'dispute');
      if (!next.write) {
        logLine(`overage credit ${next.action === 'already_removed' ? 'already removed' : 'already used'} ${target.paymentIntentId}`);
        return { write: true, metadata: closedMeta, result: { action: next.action } };
      }
      logLine(`overage credit removed ${target.paymentIntentId} lost`);
      return { write: true, metadata: { ...closedMeta, ...next.metadata }, result: { action: next.action } };
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
