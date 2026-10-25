// Canadian buyers can check out only when they attest the purchase is for a
// business. The attestation is stored here, not on the Checkout Session.
// MANUALOS_CA_B2B_GATE=0 (the exact string) turns the checkout check, the
// access refusal, and the webhook backstop off together. Any other value,
// including unset, leaves them on.

const fs = require('fs');
const path = require('path');
const { isProduction } = require('./config');

const ATTESTATION_VERSION = 'ca-b2b-v1';
const CA_BUSINESS_CODE = 'ca_business_required';
const CA_BUSINESS_MESSAGE = "Personal (non-business) purchases from Canada are coming soon. If you're buying for a business, tick the box above.";
const ATTESTATION_FILE = 'ca-business-attestations.jsonl';
const REFUND_FILE = 'ca-backstop-refunds.jsonl';
const ISO2 = /^[A-Z]{2}$/;
const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BACKSTOP_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

function caGateEnabled(env) {
  const source = env && typeof env === 'object' ? env : {};
  if (!Object.prototype.hasOwnProperty.call(source, 'MANUALOS_CA_B2B_GATE')) return true;
  return source.MANUALOS_CA_B2B_GATE !== '0';
}

function exposed(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (code) {
    err.code = code;
    err.publicCode = code;
  }
  return err;
}

function hasOwn(body, key) {
  return Boolean(body) && Object.prototype.hasOwnProperty.call(body, key);
}

function parseCaCheckoutFields(body) {
  const request = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  let billingCountry = null;
  if (hasOwn(request, 'billingCountry')) {
    if (typeof request.billingCountry !== 'string' || !ISO2.test(request.billingCountry)) {
      throw exposed(400, 'billingCountry must be a two-letter ISO country code.');
    }
    billingCountry = request.billingCountry;
  }

  let caBusinessAttestation = null;
  if (hasOwn(request, 'caBusinessAttestation')) {
    if (typeof request.caBusinessAttestation !== 'boolean') {
      throw exposed(400, 'caBusinessAttestation must be true or false.');
    }
    caBusinessAttestation = request.caBusinessAttestation;
  }

  if (billingCountry === 'CA' && caBusinessAttestation !== true) {
    throw exposed(400, CA_BUSINESS_MESSAGE, CA_BUSINESS_CODE);
  }

  let attestationVersion = null;
  if (hasOwn(request, 'attestationVersion')) {
    if (request.attestationVersion !== ATTESTATION_VERSION) {
      throw exposed(400, 'attestationVersion is not accepted.');
    }
    attestationVersion = request.attestationVersion;
  }
  if (caBusinessAttestation === true && attestationVersion !== ATTESTATION_VERSION) {
    throw exposed(400, 'attestationVersion is not accepted.');
  }

  return { billingCountry, caBusinessAttestation, attestationVersion };
}

function ensureBillingAddressCollection(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { billing_address_collection: 'required' };
  }
  if (params.billing_address_collection) return params;
  return { ...params, billing_address_collection: 'required' };
}

function supportDir(env) {
  const raw = env && typeof env.SUPPORT_DATA_DIR === 'string' ? env.SUPPORT_DATA_DIR.trim() : '';
  return raw;
}

function caCheckoutStorageReady(env) {
  const source = env && typeof env === 'object' ? env : {};
  if (!isProduction(source)) return true;
  return Boolean(supportDir(source));
}

function stringId(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id.trim();
  return '';
}

function optionalId(value) {
  const id = stringId(value);
  if (!id || id.length > 255) return null;
  if (id.includes('@') || /[\u0000-\u001F\u007F]/.test(id)) return null;
  return id;
}

function sessionIdOf(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  return SESSION_ID.test(id) ? id : '';
}

function maskSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,80}$/.test(value)) return 'unknown';
  return value.slice(-4);
}

function isoStamp(value) {
  if (typeof value === 'string' && STAMP.test(value)) return value;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return new Date().toISOString();
}

function isoAt(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return isoStamp(value);
}

function missingStripe(err) {
  return Boolean(err) && (err.statusCode === 404 || err.status === 404 || err.code === 'resource_missing');
}

// Same temp file, fsync, rename, then directory fsync as the credit ledgers.
// The previous bytes are kept, so the JSONL is append-only.
function writeDurableFile(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  const dirFd = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    try { fs.closeSync(dirFd); } catch { /* ignore */ }
  }
}

function logBackstop(sessionId, duplicate) {
  const id = maskSessionId(sessionId);
  const text = duplicate
    ? `Canadian business check already refunded ${id}`
    : `Canadian business check refunded ${id}`;
  if (text.length > 240 || /sk_|rk_|whsec_|@/.test(text)) return;
  console.log(text);
}

function countryOf(session) {
  const details = session && session.customer_details;
  const address = details && details.address;
  return address && typeof address.country === 'string' ? address.country : '';
}

function paymentFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ordered = [];
  for (const row of list) {
    if (row && row.status === 'paid') ordered.push(row);
  }
  for (const row of list) {
    if (!row || row.status !== 'paid') ordered.push(row);
  }
  for (const row of ordered) {
    const payment = row && row.payment;
    if (!payment || typeof payment !== 'object') continue;
    const charge = stringId(payment.charge);
    if (charge) return { charge };
    const paymentIntent = stringId(payment.payment_intent);
    if (paymentIntent) return { payment_intent: paymentIntent };
  }
  return null;
}

function paymentFromInvoice(invoice) {
  if (!invoice || typeof invoice !== 'object') return null;
  const paymentIntent = stringId(invoice.payment_intent);
  if (paymentIntent) return { payment_intent: paymentIntent };
  const charge = stringId(invoice.charge);
  if (charge) return { charge };
  const embedded = invoice.payments && Array.isArray(invoice.payments.data) ? invoice.payments.data : null;
  if (!embedded) return null;
  return paymentFromRows(embedded);
}

async function loadInvoice(stripe, invoiceId) {
  if (!invoiceId || !stripe || !stripe.invoices || typeof stripe.invoices.retrieve !== 'function') return null;
  return stripe.invoices.retrieve(invoiceId);
}

async function listInvoicePayments(stripe, invoiceId) {
  const list = stripe && stripe.invoicePayments && stripe.invoicePayments.list;
  if (!invoiceId || typeof list !== 'function') return null;
  const listed = await list.call(stripe.invoicePayments, { invoice: invoiceId, limit: 10 });
  const rows = listed && Array.isArray(listed.data) ? listed.data : [];
  return paymentFromRows(rows);
}

async function resolveInvoice(stripe, invoiceRef) {
  if (invoiceRef && typeof invoiceRef === 'object') {
    const embedded = paymentFromInvoice(invoiceRef);
    if (embedded) return embedded;
    return listInvoicePayments(stripe, stringId(invoiceRef));
  }
  const invoiceId = stringId(invoiceRef);
  if (!invoiceId) return null;
  const invoice = await loadInvoice(stripe, invoiceId);
  const embedded = paymentFromInvoice(invoice);
  if (embedded) return embedded;
  return listInvoicePayments(stripe, invoiceId);
}

async function refundTarget(stripe, session) {
  const direct = stringId(session && session.payment_intent);
  if (direct) return { payment_intent: direct };
  const fromSessionInvoice = await resolveInvoice(stripe, session && session.invoice);
  if (fromSessionInvoice) return fromSessionInvoice;
  const subscriptionId = stringId(session && session.subscription);
  if (!subscriptionId || !stripe || !stripe.subscriptions || typeof stripe.subscriptions.retrieve !== 'function') {
    return null;
  }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const latest = subscription && subscription.latest_invoice;
  const latestId = stringId(latest);
  if (!latestId || latestId === stringId(session && session.invoice)) return null;
  return resolveInvoice(stripe, latest);
}

function alreadyRefunded(err) {
  return Boolean(err && err.code === 'charge_already_refunded');
}

async function refundPayment(stripe, session, sessionId) {
  const target = await refundTarget(stripe, session);
  if (!target) throw new Error('Payment for the Canadian business check was not found');
  if (!stripe.refunds || typeof stripe.refunds.create !== 'function') {
    throw new Error('Refund is not available');
  }
  try {
    await stripe.refunds.create(target, { idempotencyKey: `ca-b2b-refund-${sessionId}` });
  } catch (err) {
    if (!alreadyRefunded(err)) throw err;
  }
}

async function revokeStarter(stripe, session) {
  if (!session || !session.metadata || session.metadata.plan !== 'starter') return;
  const paymentIntentId = stringId(session.payment_intent);
  if (!paymentIntentId) return;
  if (!stripe.paymentIntents || typeof stripe.paymentIntents.update !== 'function') {
    throw new Error('Payment update is not available');
  }
  await stripe.paymentIntents.update(paymentIntentId, {
    metadata: { credit_status: 'revoked', credit_revoke_reason: 'refund' },
  });
}

async function cancelSubscription(stripe, subscriptionId) {
  if (!stripe.subscriptions || typeof stripe.subscriptions.cancel !== 'function') {
    throw new Error('Subscription cancel is not available');
  }
  let current = null;
  if (typeof stripe.subscriptions.retrieve === 'function') {
    current = await stripe.subscriptions.retrieve(subscriptionId);
  }
  if (current && current.status === 'canceled') return;
  await stripe.subscriptions.cancel(
    subscriptionId,
    { prorate: false, invoice_now: false },
    { idempotencyKey: `ca-b2b-cancel-${subscriptionId}` },
  );
}

async function revokeSubscription(stripe, session) {
  const subscriptionId = stringId(session && session.subscription);
  if (!subscriptionId) return;
  if (stripe.subscriptions && typeof stripe.subscriptions.update === 'function') {
    await stripe.subscriptions.update(subscriptionId, {
      metadata: { period_access: 'revoked', period_access_reason: 'refund' },
    });
  }
  await cancelSubscription(stripe, subscriptionId);
}

async function blockPurchase(stripe, session, sessionId) {
  await refundPayment(stripe, session, sessionId);
  await revokeStarter(stripe, session);
  await revokeSubscription(stripe, session);
}

function createCaAttestationStore({ env = {} } = {}) {
  const dir = supportDir(env);
  const memory = { [ATTESTATION_FILE]: [], [REFUND_FILE]: [] };
  let chain = Promise.resolve();

  function exclusive(fn) {
    const run = chain.then(() => fn(), () => fn());
    chain = run.then(() => {}, () => {});
    return run;
  }

  function readJsonl(name) {
    if (!dir) return memory[name].slice();
    const file = path.join(dir, name);
    let text;
    try {
      if (!fs.existsSync(file)) return [];
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      const wrapped = new Error('Attestation record could not be read');
      wrapped.cause = err;
      throw wrapped;
    }
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
      } catch {
        // One bad line must not hide the rest of the record.
      }
    }
    return rows;
  }

  function appendJsonl(name, record) {
    const line = `${JSON.stringify(record)}\n`;
    if (!dir) {
      memory[name].push(record);
      return;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    let prior = '';
    try {
      if (fs.existsSync(file)) prior = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        const wrapped = new Error('Attestation record could not be saved');
        wrapped.cause = err;
        throw wrapped;
      }
    }
    if (prior && !prior.endsWith('\n')) prior += '\n';
    try {
      writeDurableFile(file, prior + line);
    } catch (err) {
      const wrapped = new Error('Attestation record could not be saved');
      wrapped.cause = err;
      throw wrapped;
    }
  }

  function attested(sessionId) {
    return readJsonl(ATTESTATION_FILE).some((row) => row
      && row.sessionId === sessionId
      && row.billingCountry === 'CA'
      && row.caBusinessAttestation === true
      && row.attestationVersion === ATTESTATION_VERSION);
  }

  function refunded(sessionId) {
    return readJsonl(REFUND_FILE).some((row) => row && row.sessionId === sessionId);
  }

  async function record(entry) {
    const sessionId = sessionIdOf(entry && entry.sessionId);
    if (!sessionId) throw new Error('Attestation record could not be saved');
    const country = typeof entry.billingCountry === 'string' && ISO2.test(entry.billingCountry)
      ? entry.billingCountry
      : null;
    const stored = {
      sessionId,
      customerId: optionalId(entry.customerId),
      userId: optionalId(entry.userId),
      at: isoStamp(entry.at),
      billingCountry: country,
      caBusinessAttestation: true,
      attestationVersion: ATTESTATION_VERSION,
    };
    await exclusive(async () => {
      appendJsonl(ATTESTATION_FILE, stored);
    });
    return stored;
  }

  function refundCount() {
    const ids = new Set();
    for (const row of readJsonl(REFUND_FILE)) {
      if (row && typeof row.sessionId === 'string' && row.sessionId) ids.add(row.sessionId);
    }
    return ids.size;
  }

  function allows(sessionId) {
    const id = sessionIdOf(sessionId);
    if (!id) return false;
    return attested(id);
  }

  async function blockOnce(sessionId, work, now) {
    return exclusive(async () => {
      if (attested(sessionId)) return { action: 'attested', blocked: false };
      if (refunded(sessionId)) return { action: 'duplicate', blocked: true };
      await work();
      appendJsonl(REFUND_FILE, { sessionId, at: isoAt(now) });
      return { action: 'refunded', blocked: true };
    });
  }

  return {
    record,
    refundCount,
    allows,
    blockOnce,
    attestationFile: ATTESTATION_FILE,
    refundFile: REFUND_FILE,
  };
}

async function assertCaPurchaseAllowed({ stripe, sessionId, env, store } = {}) {
  if (!caGateEnabled(env)) return;
  const id = sessionIdOf(typeof sessionId === 'string' ? sessionId : '');
  if (!id) return;
  const retrieve = stripe && stripe.checkout && stripe.checkout.sessions && stripe.checkout.sessions.retrieve;
  if (typeof retrieve !== 'function') return;
  let session;
  try {
    session = await retrieve.call(stripe.checkout.sessions, id);
  } catch (err) {
    if (missingStripe(err)) return;
    throw err;
  }
  if (countryOf(session) !== 'CA') return;
  if (store && typeof store.allows === 'function' && store.allows(id)) return;
  throw exposed(400, CA_BUSINESS_MESSAGE, CA_BUSINESS_CODE);
}

async function applyCaBusinessBackstop({ stripe, event, env, store, now } = {}) {
  if (!caGateEnabled(env)) return { action: 'disabled', blocked: false };
  if (!event || !BACKSTOP_TYPES.has(event.type)) return { action: 'ignored', blocked: false };
  const session = event.data && event.data.object;
  if (countryOf(session) !== 'CA') return { action: 'ignored', blocked: false };
  if (event.type === 'checkout.session.completed' && session && session.payment_status === 'unpaid') {
    return { action: 'deferred', blocked: false };
  }
  const sessionId = sessionIdOf(session && session.id);
  if (!sessionId) throw new Error('Checkout session id is missing');
  if (!store || typeof store.blockOnce !== 'function') throw new Error('Attestation record could not be read');
  const outcome = await store.blockOnce(sessionId, () => blockPurchase(stripe, session, sessionId), now);
  if (outcome.blocked) logBackstop(sessionId, outcome.action === 'duplicate');
  return outcome;
}

module.exports = {
  ATTESTATION_VERSION,
  CA_BUSINESS_CODE,
  CA_BUSINESS_MESSAGE,
  ATTESTATION_FILE,
  REFUND_FILE,
  caGateEnabled,
  caCheckoutStorageReady,
  parseCaCheckoutFields,
  ensureBillingAddressCollection,
  createCaAttestationStore,
  assertCaPurchaseAllowed,
  applyCaBusinessBackstop,
  maskSessionId,
};
