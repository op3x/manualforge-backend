// Pro subscription charges. A full refund or a lost dispute blocks the billing
// period that charge paid for. The subscription itself is not cancelled.
// Access returns when a later invoice is paid, or immediately if a dispute is
// won. Partial refunds are logged and do not change access.
// Integrator billing is not implemented on this branch. Any charge tied to a
// subscription invoice uses this same metadata so a later Integrator check can
// read it. Only Pro sessions enforce the block today.

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

function readPeriodAccess(subscription) {
  const value = subscription && subscription.metadata && subscription.metadata.period_access;
  if (value === 'revoked' || value === 'suspended') return value;
  return 'active';
}

function readPeriodReason(subscription) {
  if (subscription && subscription.metadata && subscription.metadata.period_access_reason === 'dispute') return 'dispute';
  return 'refund';
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
  return { subscriptionId, invoiceId, chargeId: safeId(loaded.charge.id) || 'unknown' };
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
    return {
      write: true,
      metadata: {
        period_access: 'revoked',
        period_invoice: target.invoiceId,
        period_access_reason: 'refund',
      },
      result: { action: 'revoked' },
    };
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
  return commitSub(stripe, target.subscriptionId, event.id, (subscription, meta, memory) => {
    if (!blocksCurrentPeriod(subscription, meta, target.invoiceId)) {
      logLine(`charge.dispute.created earlier subscription period ignored ${disputeId}`);
      return recordOnly(meta, memory, { action: 'earlier_period' });
    }
    const access = readPeriodAccess({ metadata: meta });
    if (access === 'revoked' || access === 'suspended') {
      return recordOnly(meta, memory, { action: access === 'revoked' ? 'already_revoked' : 'already_suspended' });
    }
    logLine(`charge.dispute.created subscription period suspended ${disputeId} ${target.invoiceId}`);
    return {
      write: true,
      metadata: {
        period_access: 'suspended',
        period_invoice: target.invoiceId,
        period_access_reason: 'dispute',
      },
      result: { action: 'suspended' },
    };
  });
}

async function applyDisputeClosed(stripe, event) {
  const dispute = event.data && event.data.object ? event.data.object : {};
  const disputeId = safeId(dispute.id) || 'unknown';
  const closed = typeof dispute.status === 'string' ? dispute.status : '';
  const target = await targetFromCharge(stripe, await disputeCharge(stripe, dispute));
  if (!target) return { action: 'unknown' };
  return commitSub(stripe, target.subscriptionId, event.id, (subscription, meta, memory) => {
    if (!blocksCurrentPeriod(subscription, meta, target.invoiceId)) {
      logLine(`charge.dispute.closed earlier subscription period ignored ${disputeId} ${closed || 'unknown'}`);
      return recordOnly(meta, memory, { action: 'earlier_period' });
    }
    const access = readPeriodAccess({ metadata: meta });
    if (closed === 'won') {
      if (access !== 'suspended') {
        logLine(`charge.dispute.closed subscription period not restored ${disputeId} ${access}`);
        return recordOnly(meta, memory, { action: access === 'revoked' ? 'already_revoked' : 'not_suspended' });
      }
      logLine(`charge.dispute.closed subscription period restored ${disputeId} won`);
      return {
        write: true,
        metadata: { period_access: 'active', period_invoice: target.invoiceId, period_access_reason: '' },
        result: { action: 'restored' },
      };
    }
    if (closed === 'charge_refunded') {
      if (access !== 'active') {
        return recordOnly(meta, memory, { action: access === 'revoked' ? 'already_revoked' : 'already_suspended' });
      }
      logLine(`charge.dispute.closed subscription period suspended ${disputeId} ${closed}`);
      return {
        write: true,
        metadata: {
          period_access: 'suspended',
          period_invoice: target.invoiceId,
          period_access_reason: 'dispute',
        },
        result: { action: 'suspended' },
      };
    }
    if (closed === 'lost') {
      if (access === 'revoked' && meta.period_invoice === target.invoiceId) {
        return recordOnly(meta, memory, { action: 'already_revoked' });
      }
      logLine(`charge.dispute.closed subscription period revoked ${disputeId} lost`);
      return {
        write: true,
        metadata: {
          period_access: 'revoked',
          period_invoice: target.invoiceId,
          period_access_reason: 'dispute',
        },
        result: { action: 'revoked' },
      };
    }
    logLine(`charge.dispute.closed subscription period unchanged ${disputeId} ${closed || 'unknown'}`);
    return recordOnly(meta, memory, { action: 'unchanged' });
  });
}

async function applyInvoicePaid(stripe, event) {
  const invoice = event.data && event.data.object ? event.data.object : {};
  const invoiceId = safeId(invoice.id);
  const subscriptionId = safeId(subscriptionRef(invoice));
  if (!invoiceId || !subscriptionId) return { action: 'ignored' };
  if (invoice.status && invoice.status !== 'paid') return { action: 'ignored' };
  return commitSub(stripe, subscriptionId, event.id, (subscription, meta, memory) => {
    const access = readPeriodAccess({ metadata: meta });
    const sameInvoice = meta.period_invoice === invoiceId;
    if (sameInvoice && (access === 'revoked' || access === 'suspended')) {
      logLine(`invoice.paid same subscription period still ${access} ${invoiceId}`);
      return recordOnly(meta, memory, { action: 'still_blocked' });
    }
    if (sameInvoice && access === 'active') return recordOnly(meta, memory, { action: 'already_open' });
    logLine(`invoice.paid subscription period open ${invoiceId}`);
    return {
      write: true,
      metadata: {
        period_access: 'active',
        period_invoice: invoiceId,
        period_access_reason: '',
      },
      result: { action: 'opened' },
    };
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
