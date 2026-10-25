// Subscription charges, for every plan. A full refund of the current period
// blocks access until a later paid renewal invoice. Open disputes are a
// separate set: access stays suspended while that set is non-empty. Only
// charge.dispute.closed removes an id. Renewals and refunds never touch it.
// A lost dispute sets revoked_dispute_lost on that subscription, cancels it
// with no proration, and does not ban the customer from buying again.
// Partial refunds are logged and do not change access.

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

function notFound(err) {
  return Boolean(err && (err.statusCode === 404 || err.code === 'resource_missing'));
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

function openDisputeState(meta) {
  const list = disputeIds(meta && meta.open_disputes);
  const raw = parseInt(meta && meta.open_dispute_count, 10);
  const count = Number.isInteger(raw) && raw >= 0 && raw <= 100000 ? Math.max(raw, list.length) : list.length;
  return { list, count };
}

function openDisputeCount(meta) {
  return openDisputeState(meta).count;
}

function addOpenDispute(meta, disputeId) {
  if (!disputeId || disputeId === 'unknown') return { changed: false, closed: false, metadata: {} };
  const closed = disputeIds(meta && meta.closed_disputes);
  if (closed.includes(disputeId)) return { changed: false, closed: true, metadata: {} };
  const state = openDisputeState(meta);
  if (state.list.includes(disputeId)) return { changed: false, closed: false, metadata: {} };
  return {
    changed: true,
    closed: false,
    metadata: {
      open_disputes: packDisputeIds(state.list.concat(disputeId)),
      open_dispute_count: String(state.count + 1),
    },
  };
}

function closeOpenDispute(meta, disputeId) {
  const state = openDisputeState(meta);
  const closed = disputeIds(meta && meta.closed_disputes);
  const knownClosed = Boolean(disputeId) && closed.includes(disputeId);
  const inList = Boolean(disputeId) && state.list.includes(disputeId);
  const truncated = state.count > state.list.length;
  let nextCount = state.count;
  if (!knownClosed && (inList || truncated)) nextCount = Math.max(0, state.count - 1);
  return {
    count: nextCount,
    metadata: {
      open_disputes: packDisputeIds(state.list.filter((id) => id !== disputeId)),
      open_dispute_count: String(nextCount),
      closed_disputes: disputeId ? packDisputeIds(closed.concat(disputeId)) : packDisputeIds(closed),
    },
  };
}

function readPeriodAccess(subscription) {
  const meta = subscription && subscription.metadata;
  if (meta && meta.revoked_dispute_lost === 'true') return 'revoked';
  if (openDisputeCount(meta) > 0) return 'suspended';
  const value = meta && meta.period_access;
  if (value === 'revoked' || value === 'suspended') return value;
  return 'active';
}

function readPeriodReason(subscription) {
  const meta = subscription && subscription.metadata;
  if (meta && (meta.revoked_dispute_lost === 'true' || openDisputeCount(meta) > 0 || meta.period_access_reason === 'dispute')) return 'dispute';
  return 'refund';
}

const RENEWAL_REASONS = new Set(['subscription_cycle', 'subscription_create', 'subscription_update']);

function finiteUnix(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function invoicePeriodBound(invoice, which) {
  const lines = invoice && invoice.lines && Array.isArray(invoice.lines.data) ? invoice.lines.data : [];
  for (const line of lines) {
    const value = line && line.period && finiteUnix(line.period[which]);
    if (value) return value;
  }
  if (!invoice) return null;
  return finiteUnix(which === 'start' ? invoice.period_start : invoice.period_end);
}

function renewalReopens(invoice, meta) {
  if (!invoice || !meta) return false;
  if (meta.revoked_dispute_lost === 'true') return false;
  // Refund state is separate from the open-dispute set. A renewal may clear a
  // refund while a dispute is still open; the set keeps access suspended.
  if (meta.period_access !== 'revoked') return false;
  if (meta.period_access_reason === 'dispute') return false;
  if (!RENEWAL_REASONS.has(invoice.billing_reason)) return false;
  const paid = Number(invoice.amount_paid);
  if (!Number.isFinite(paid) || paid <= 0) return false;
  const invoiceId = safeId(invoice.id);
  if (meta.period_invoice && invoiceId && meta.period_invoice === invoiceId) return false;
  const start = invoicePeriodBound(invoice, 'start');
  const boundary = finiteUnix(meta.period_end);
  if (boundary) return Boolean(start) && start >= boundary;
  return true;
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

function currentInvoiceId(subscription, meta) {
  return idOf(subscription && subscription.latest_invoice) || (meta && meta.period_invoice) || '';
}

function subscriptionRef(invoice) {
  if (!invoice || typeof invoice !== 'object') return '';
  if (invoice.subscription) return invoice.subscription;
  const details = invoice.parent && invoice.parent.subscription_details;
  if (details && details.subscription) return details.subscription;
  return '';
}

function lockFor(subscriptionId, fn) {
  return require('./billing').withCreditLock(subscriptionId, fn);
}

async function commitSub(stripe, subscriptionId, eventId, decide) {
  return lockFor(subscriptionId, async () => {
    const current = await stripe.subscriptions.retrieve(subscriptionId);
    const meta = (current && current.metadata) || {};
    const memory = eventMemory(meta.period_events, eventId);
    if (memory.duplicate) return { action: 'duplicate' };
    const decision = decide(current, meta, memory);
    if (!decision.write) return decision.result;
    const metadata = { ...decision.metadata };
    if (memory.stored) metadata.period_events = memory.stored;
    await stripe.subscriptions.update(subscriptionId, { metadata });
    return decision.result;
  });
}

function recordOnly(meta, memory, result) {
  const same = memory.stored === String(meta.period_events || '');
  return { write: Boolean(memory.stored) && !same, metadata: {}, result };
}

async function chargeRecord(stripe, charge) {
  if (!charge) return null;
  if (charge.invoice) return charge;
  const id = safeId(charge.id || charge);
  if (!id || !stripe.charges || typeof stripe.charges.retrieve !== 'function') return charge.id ? charge : null;
  try {
    return await stripe.charges.retrieve(id);
  } catch (err) {
    if (notFound(err)) return charge.id ? charge : null;
    throw err;
  }
}

async function invoiceForCharge(stripe, charge) {
  const record = await chargeRecord(stripe, charge);
  if (!record) return null;
  if (record.invoice && typeof record.invoice === 'object') {
    return { charge: record, invoice: record.invoice };
  }
  const invoiceId = typeof record.invoice === 'string' ? record.invoice : '';
  if (invoiceId && stripe.invoices && typeof stripe.invoices.retrieve === 'function') {
    try {
      const invoice = await stripe.invoices.retrieve(invoiceId);
      return invoice ? { charge: record, invoice } : null;
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }
  const paymentIntentId = safeId(record.payment_intent);
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
  if (typeof chosen.invoice === 'object' && chosen.invoice) return { charge: record, invoice: chosen.invoice };
  if (!stripe.invoices || typeof stripe.invoices.retrieve !== 'function') return null;
  try {
    const invoice = await stripe.invoices.retrieve(chosen.invoice);
    return invoice ? { charge: record, invoice } : null;
  } catch (err) {
    if (notFound(err)) return null;
    throw err;
  }
}

async function targetFromCharge(stripe, charge) {
  const loaded = await invoiceForCharge(stripe, charge);
  if (!loaded) return null;
  const subscriptionId = safeId(subscriptionRef(loaded.invoice));
  const invoiceId = safeId(loaded.invoice.id);
  if (!subscriptionId || !invoiceId) return null;
  return {
    subscriptionId,
    invoiceId,
    chargeId: safeId(loaded.charge.id) || 'unknown',
    periodEnd: invoicePeriodBound(loaded.invoice, 'end'),
  };
}

function blocksCurrentPeriod(subscription, meta, invoiceId) {
  const current = currentInvoiceId(subscription, meta);
  if (!current) return true;
  return current === invoiceId;
}

async function applyChargeRefund(stripe, event) {
  const charge = event.data && event.data.object ? event.data.object : {};
  const target = await targetFromCharge(stripe, charge);
  const chargeId = safeId(charge.id) || 'unknown';
  if (!target) return { action: 'unknown' };
  const full = isFullRefund(charge);
  return commitSub(stripe, target.subscriptionId, event.id, (subscription, meta, memory) => {
    if (!full) {
      logLine(`charge.refunded partial subscription period unchanged ${chargeId} amount_refunded ${amountOf(charge.amount_refunded)} amount ${amountOf(charge.amount)}`);
      return recordOnly(meta, memory, { action: 'partial' });
    }
    if (!blocksCurrentPeriod(subscription, meta, target.invoiceId)) {
      logLine(`charge.refunded full earlier subscription period ignored ${chargeId} ${target.invoiceId}`);
      return recordOnly(meta, memory, { action: 'earlier_period' });
    }
    if (readPeriodAccess({ metadata: meta }) === 'revoked' && meta.period_invoice === target.invoiceId) {
      return recordOnly(meta, memory, { action: 'already_revoked' });
    }
    logLine(`charge.refunded full subscription period revoked ${chargeId} ${target.invoiceId}`);
    const metadata = {
      period_access: 'revoked',
      period_invoice: target.invoiceId,
      period_access_reason: 'refund',
    };
    if (target.periodEnd) metadata.period_end = String(target.periodEnd);
    return { write: true, metadata, result: { action: 'revoked' } };
  });
}

async function disputeCharge(stripe, dispute) {
  if (!dispute) return null;
  if (dispute.charge && typeof dispute.charge === 'object') return dispute.charge;
  return chargeRecord(stripe, { id: dispute.charge });
}

async function applyDisputeOpened(stripe, event) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const disputeId = safeId(dispute.id) || 'unknown';
  const target = await targetFromCharge(stripe, await disputeCharge(stripe, dispute));
  if (!target) return { action: 'unknown' };
  const disputeKey = safeId(dispute.id);
  return commitSub(stripe, target.subscriptionId, event.id, (subscription, meta, memory) => {
    if (meta.revoked_dispute_lost === 'true') {
      return recordOnly(meta, memory, { action: 'already_revoked' });
    }
    const added = addOpenDispute(meta, disputeKey);
    if (added.closed) {
      logLine(`charge.dispute.created subscription dispute already closed ${disputeId}`);
      return recordOnly(meta, memory, { action: 'already_closed' });
    }
    if (!added.changed) return recordOnly(meta, memory, { action: 'already_suspended' });
    logLine(`charge.dispute.created subscription suspended ${disputeId} ${target.invoiceId}`);
    const metadata = { ...added.metadata };
    if (meta.period_access !== 'revoked') {
      metadata.period_access = 'suspended';
      metadata.period_invoice = target.invoiceId;
      metadata.period_access_reason = 'dispute';
    }
    return { write: true, metadata, result: { action: 'suspended' } };
  });
}

async function applyDisputeClosed(stripe, event) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const disputeId = safeId(dispute.id) || 'unknown';
  const closed = typeof dispute.status === 'string' ? dispute.status : '';
  const target = await targetFromCharge(stripe, await disputeCharge(stripe, dispute));
  if (!target) return { action: 'unknown' };
  const disputeKey = safeId(dispute.id);
  const result = await commitSub(stripe, target.subscriptionId, event.id, (subscription, meta, memory) => {
    if (closed === 'warning_closed') {
      logLine(`charge.dispute.closed subscription period unchanged ${disputeId} ${closed}`);
      return recordOnly(meta, memory, { action: 'unchanged' });
    }
    const finished = closeOpenDispute(meta, disputeKey);
    if (closed === 'won' && finished.count === 0 && meta.revoked_dispute_lost !== 'true' && meta.period_access !== 'revoked') {
      logLine(`charge.dispute.closed subscription period restored ${disputeId} won`);
      const metadata = {
        ...finished.metadata,
        period_access: 'active',
        period_access_reason: '',
      };
      if (target.invoiceId) metadata.period_invoice = target.invoiceId;
      return { write: true, metadata, result: { action: 'restored' } };
    }
    if (closed === 'won' || closed === 'charge_refunded') {
      if (finished.count > 0) {
        logLine(`charge.dispute.closed subscription still suspended ${disputeId} ${finished.count}`);
      } else {
        logLine(`charge.dispute.closed subscription period unchanged ${disputeId} ${closed}`);
      }
      return {
        write: true,
        metadata: finished.metadata,
        result: { action: finished.count > 0 ? 'still_suspended' : 'closed' },
      };
    }
    if (closed === 'lost') {
      logLine(`charge.dispute.closed subscription revoked ${disputeId} lost`);
      const metadata = {
        ...finished.metadata,
        period_access: 'revoked',
        period_invoice: target.invoiceId,
        period_access_reason: 'dispute',
        revoked_dispute_lost: 'true',
      };
      if (target.periodEnd) metadata.period_end = String(target.periodEnd);
      if (meta.revoked_dispute_lost === 'true') {
        return { write: true, metadata: finished.metadata, result: { action: 'already_revoked' } };
      }
      return { write: true, metadata, result: { action: 'revoked' } };
    }
    logLine(`charge.dispute.closed subscription period unchanged ${disputeId} ${closed || 'unknown'}`);
    return recordOnly(meta, memory, { action: 'unchanged' });
  });
  if (closed === 'lost') await ensureCancelled(stripe, target.subscriptionId);
  return result;
}

async function ensureCancelled(stripe, subscriptionId) {
  if (!stripe.subscriptions || typeof stripe.subscriptions.cancel !== 'function') {
    throw new Error('Subscription cancel is not available');
  }
  const current = await stripe.subscriptions.retrieve(subscriptionId);
  if (current && current.status === 'canceled') {
    logLine(`subscription already cancelled ${subscriptionId}`);
    return;
  }
  await stripe.subscriptions.cancel(subscriptionId, { prorate: false, invoice_now: false });
  logLine(`subscription cancelled after lost dispute ${subscriptionId}`);
}

async function applyInvoicePaid(stripe, event) {
  const invoice = event.data && event.data.object ? event.data.object : {};
  const invoiceId = safeId(invoice.id);
  const subscriptionId = safeId(subscriptionRef(invoice));
  if (!invoiceId || !subscriptionId) return { action: 'ignored' };
  if (invoice.status && invoice.status !== 'paid') return { action: 'ignored' };
  return commitSub(stripe, subscriptionId, event.id, (subscription, meta, memory) => {
    if (meta.revoked_dispute_lost === 'true' || !renewalReopens(invoice, meta)) {
      if (meta.revoked_dispute_lost === 'true' || openDisputeCount(meta) > 0 || meta.period_access === 'revoked' || meta.period_access === 'suspended') {
        logLine(`invoice.paid subscription still ${readPeriodAccess({ metadata: meta })} ${invoiceId}`);
        return recordOnly(meta, memory, { action: 'still_blocked' });
      }
      return recordOnly(meta, memory, { action: 'already_open' });
    }
    const end = invoicePeriodBound(invoice, 'end');
    logLine(`invoice.paid subscription period open ${invoiceId}`);
    const metadata = {
      period_access: 'active',
      period_invoice: invoiceId,
      period_access_reason: '',
    };
    if (end) metadata.period_end = String(end);
    return { write: true, metadata, result: { action: 'opened' } };
  });
}

async function applyPeriodAccessEvent(stripe, event, starterResult) {
  const starterAction = starterResult && starterResult.action;
  if (starterAction && starterAction !== 'unknown' && starterAction !== 'ignored') {
    return { action: 'skipped' };
  }
  if (!event || typeof event.type !== 'string') return { action: 'ignored' };
  if (event.type === 'invoice.paid') return applyInvoicePaid(stripe, event);
  if (event.type === 'charge.refunded') return applyChargeRefund(stripe, event);
  if (event.type === 'charge.dispute.created') return applyDisputeOpened(stripe, event);
  if (event.type === 'charge.dispute.closed') return applyDisputeClosed(stripe, event);
  return { action: 'ignored' };
}

module.exports = {
  readPeriodAccess,
  readPeriodReason,
  applyPeriodAccessEvent,
};
