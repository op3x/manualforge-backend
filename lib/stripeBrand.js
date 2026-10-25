// ManualOS shares a Stripe account with HTS Atlas. Checkout stamps brand=manualos
// and prefers prices whose lookup_key starts with manualos_. The webhook runs
// the ManualOS handlers only after this classifier returns "ours".
//
// Money events are classified from the charge and its PaymentIntent (brand,
// otherwise a ManualOS plan). Dispute and early-fraud objects have no usable
// metadata, so the charge is fetched first. Refund metadata is ignored.
// A renewal charge often has neither brand nor plan; those are recognized
// through Invoice Payments, then the invoice, its subscription, the price id,
// a manualos_ lookup key, or the product. Customer metadata is only a last
// resort: under Managed Payments it is empty and must not decide the event.
// "other" is a proven foreign brand or lookup key. "unknown" is not.

const { invoiceForCharge, invoiceForPaymentIntent } = require('./period-access');

const BRAND = 'manualos';
const LOOKUP_PREFIX = 'manualos_';

const LOOKUP_KEYS = Object.freeze({
  starter: 'manualos_starter',
  pro: 'manualos_pro',
});

const HANDLED_EVENT_TYPES = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
  'radar.early_fraud_warning.created',
]);

const MANUALOS_PLANS = new Set(['starter', 'pro', 'integrator', 'overage', 'integrator_overage']);

function exposed(status, message, logMessage) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (logMessage) err.logMessage = logMessage;
  return err;
}

function isChargeFamily(type) {
  return typeof type === 'string' && (
    type.startsWith('charge.')
    || type.startsWith('refund.')
    || type.startsWith('radar.early_fraud_warning.')
  );
}

function isMissingError(err) {
  if (!err) return false;
  return err.statusCode === 404 || err.status === 404 || err.code === 'resource_missing';
}

function readBrand(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const value = metadata.brand;
  if (typeof value !== 'string') return '';
  return value.trim();
}

function readPlan(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const value = metadata.plan;
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isManualosOverage(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  if (metadata.plan === 'starter') return false;
  if (metadata.plan === 'integrator_overage') return true;
  if (metadata.kind === 'overage' || metadata.purchase === 'overage' || metadata.credit === 'overage') return true;
  if (metadata.overage === 'true' || metadata.overage === true) return true;
  return false;
}

function idString(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return '';
}

function freshBag() {
  return { brands: [], plans: [], lookups: [], priceIds: [], overage: false };
}

function addMetadata(bag, metadata) {
  const brand = readBrand(metadata);
  const plan = readPlan(metadata);
  if (brand) bag.brands.push(brand);
  if (plan) bag.plans.push(plan);
  if (isManualosOverage(metadata)) bag.overage = true;
}

function metadataNodes(object) {
  const nodes = [];
  const push = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) nodes.push(value);
  };
  push(object.metadata);
  push(object.subscription_details && object.subscription_details.metadata);
  const parent = object.parent;
  push(parent && parent.subscription_details && parent.subscription_details.metadata);
  if (object.subscription && typeof object.subscription === 'object') push(object.subscription.metadata);
  if (object.payment_intent && typeof object.payment_intent === 'object') push(object.payment_intent.metadata);
  return nodes;
}

function lineItemsOf(object) {
  const lines = [];
  for (const key of ['lines', 'line_items', 'items']) {
    const group = object[key];
    if (group && Array.isArray(group.data)) lines.push(...group.data);
    else if (Array.isArray(group)) lines.push(...group);
  }
  return lines;
}

function priceRefsOf(object) {
  const refs = [];
  const push = (id, lookupKey) => {
    refs.push({
      id: typeof id === 'string' ? id.trim() : '',
      lookupKey: typeof lookupKey === 'string' ? lookupKey.trim() : '',
    });
  };
  for (const line of lineItemsOf(object)) {
    if (!line || typeof line !== 'object') continue;
    if (typeof line.price === 'string') push(line.price, '');
    else if (line.price && typeof line.price === 'object') push(line.price.id, line.price.lookup_key);
    const details = line.pricing && line.pricing.price_details;
    if (details && typeof details.price === 'string') push(details.price, '');
    else if (details && details.price && typeof details.price === 'object') push(details.price.id, details.price.lookup_key);
  }
  if (object.price && typeof object.price === 'object') push(object.price.id, object.price.lookup_key);
  return refs;
}

function absorbObject(bag, object) {
  if (!object || typeof object !== 'object' || object.deleted === true) return;
  if (object.object === 'refund') return;
  for (const metadata of metadataNodes(object)) addMetadata(bag, metadata);
  for (const ref of priceRefsOf(object)) {
    if (ref.lookupKey) bag.lookups.push(ref.lookupKey);
    if (ref.id) bag.priceIds.push(ref.id);
  }
  for (const line of lineItemsOf(object)) {
    const price = line && line.price;
    const product = price && typeof price === 'object' ? price.product : null;
    if (product && typeof product === 'object') addMetadata(bag, product.metadata);
    const details = line && line.pricing && line.pricing.price_details;
    if (details && details.product && typeof details.product === 'object') addMetadata(bag, details.product.metadata);
  }
}

function configuredPriceIds(env) {
  const ids = new Set();
  if (!env || typeof env !== 'object') return ids;
  for (const [key, value] of Object.entries(env)) {
    if (!/^STRIPE_PRICE_[A-Z0-9_]+$/.test(key)) continue;
    const id = typeof value === 'string' ? value.trim() : '';
    if (id.startsWith('price_')) ids.add(id);
  }
  return ids;
}

function verdict(bag, env) {
  if (bag.brands.some((brand) => brand !== BRAND)) return 'other';
  if (bag.lookups.some((key) => !key.startsWith(LOOKUP_PREFIX))) return 'other';
  if (bag.plans.some((plan) => !MANUALOS_PLANS.has(plan))) return 'other';
  if (bag.brands.includes(BRAND)) return 'ours';
  if (bag.lookups.some((key) => key.startsWith(LOOKUP_PREFIX))) return 'ours';
  const configured = configuredPriceIds(env);
  if (bag.priceIds.some((id) => configured.has(id))) return 'ours';
  // plan=pro alone is shared with other products on this account. It counts
  // only with brand, a configured price, or a manualos_ lookup key, which
  // were already accepted above. plan=starter on a PaymentIntent still counts.
  if (bag.plans.some((plan) => plan !== 'pro' && MANUALOS_PLANS.has(plan))) return 'ours';
  if (bag.overage) return 'ours';
  return 'unknown';
}

async function retrieveOptional(stripe, group, id) {
  const resource = stripe && stripe[group] && stripe[group].retrieve;
  if (typeof resource !== 'function' || typeof id !== 'string' || !id) return null;
  try {
    const value = await resource.call(stripe[group], id);
    if (!value || value.deleted === true) return null;
    return value;
  } catch (err) {
    if (isMissingError(err)) return null;
    throw err;
  }
}

function eventObjectIsCharge(object, type) {
  if (!object || typeof object !== 'object') return false;
  if (object.object === 'charge') return true;
  if (object.object === 'dispute' || object.object === 'refund' || object.object === 'radar.early_fraud_warning') return false;
  if (typeof type !== 'string') return false;
  if (
    type.startsWith('charge.dispute')
    || type.startsWith('charge.refund.')
    || type.startsWith('refund.')
    || type.startsWith('radar.early_fraud_warning.')
  ) return false;
  return type.startsWith('charge.');
}

async function loadCharge(object, stripe, type) {
  if (!object || typeof object !== 'object') return null;
  if (eventObjectIsCharge(object, type)) return object.deleted === true ? null : object;
  const charge = object.charge;
  if (!charge) return null;
  if (typeof charge === 'object') return charge.deleted === true ? null : charge;
  if (typeof charge !== 'string') return null;
  return retrieveOptional(stripe, 'charges', charge);
}

function paymentIntentRef(object, charge) {
  if (charge && charge.payment_intent) return charge.payment_intent;
  if (object && object !== charge && object.payment_intent) return object.payment_intent;
  return null;
}

async function loadPaymentIntent(ref, stripe) {
  if (!ref) return null;
  if (typeof ref === 'object') return ref.deleted === true ? null : ref;
  if (typeof ref !== 'string') return null;
  return retrieveOptional(stripe, 'paymentIntents', ref);
}

function customerRefOf(object) {
  if (!object || typeof object !== 'object' || object.object === 'refund') return null;
  if (object.customer) return object.customer;
  if (object.charge && typeof object.charge === 'object' && object.charge.customer) return object.charge.customer;
  return null;
}

function subscriptionRecord(object) {
  if (!object || typeof object !== 'object') return null;
  if (object.object === 'subscription') return object;
  if (object.subscription && typeof object.subscription === 'object') return object.subscription;
  const details = object.parent && object.parent.subscription_details;
  if (details && details.subscription && typeof details.subscription === 'object') return details.subscription;
  return null;
}

function subscriptionIdOf(object) {
  const record = subscriptionRecord(object);
  if (record && typeof record.id === 'string') return record.id;
  if (!object || typeof object !== 'object') return '';
  if (typeof object.subscription === 'string') return object.subscription;
  const details = object.parent && object.parent.subscription_details;
  if (details && typeof details.subscription === 'string') return details.subscription;
  return '';
}

function catalogIds(object) {
  const priceIds = [];
  const productIds = [];
  if (!object || typeof object !== 'object') return { priceIds, productIds };
  for (const ref of priceRefsOf(object)) {
    if (ref.id && !ref.lookupKey) priceIds.push(ref.id);
  }
  for (const line of lineItemsOf(object)) {
    const details = line && line.pricing && line.pricing.price_details;
    if (details && typeof details.product === 'string' && details.product) productIds.push(details.product);
  }
  return { priceIds, productIds };
}

async function enrichCatalog(stripe, object, bag) {
  const { priceIds, productIds } = catalogIds(object);
  const seenPrices = new Set();
  const seenProducts = new Set();
  for (const id of priceIds) {
    if (seenPrices.has(id)) continue;
    seenPrices.add(id);
    const price = await retrieveOptional(stripe, 'prices', id);
    if (!price) continue;
    if (typeof price.lookup_key === 'string' && price.lookup_key.trim()) bag.lookups.push(price.lookup_key.trim());
    if (price.id && !bag.priceIds.includes(price.id)) bag.priceIds.push(price.id);
    if (typeof price.product === 'string' && price.product) productIds.push(price.product);
    else if (price.product && typeof price.product === 'object') addMetadata(bag, price.product.metadata);
  }
  for (const id of productIds) {
    if (seenProducts.has(id)) continue;
    seenProducts.add(id);
    const product = await retrieveOptional(stripe, 'products', id);
    if (product) addMetadata(bag, product.metadata);
  }
}

async function deepen(stripe, object, bag, env) {
  let decision = verdict(bag, env);
  if (decision !== 'unknown') return decision;
  let sub = subscriptionRecord(object);
  const subId = subscriptionIdOf(object);
  if ((!sub || sub === object) && subId && object.object !== 'subscription') {
    const loaded = await retrieveOptional(stripe, 'subscriptions', subId);
    if (loaded) {
      sub = loaded;
      absorbObject(bag, loaded);
    }
  }
  decision = verdict(bag, env);
  if (decision !== 'unknown') return decision;
  await enrichCatalog(stripe, object, bag);
  if (sub && sub !== object) await enrichCatalog(stripe, sub, bag);
  return verdict(bag, env);
}

async function absorbInvoiceChain(stripe, charge, paymentIntentId, bag, env) {
  let invoice = null;
  const chargePi = charge ? idString(charge.payment_intent) : '';
  const effectivePi = paymentIntentId || chargePi;
  if (charge && charge.invoice && typeof charge.invoice === 'object' && charge.invoice.deleted !== true) {
    invoice = charge.invoice;
  } else if (charge && (charge.invoice || effectivePi)) {
    try {
      const loaded = await invoiceForCharge(stripe, charge);
      invoice = loaded && loaded.invoice;
    } catch (err) {
      if (!isMissingError(err)) throw err;
    }
  }
  if ((!invoice || invoice.deleted === true) && paymentIntentId) {
    try {
      invoice = await invoiceForPaymentIntent(stripe, paymentIntentId);
    } catch (err) {
      if (!isMissingError(err)) throw err;
      invoice = null;
    }
  }
  if (!invoice || invoice.deleted === true) return verdict(bag, env);
  absorbObject(bag, invoice);
  return deepen(stripe, invoice, bag, env);
}

async function absorbSessions(stripe, paymentIntentId, bag) {
  const list = stripe && stripe.checkout && stripe.checkout.sessions && stripe.checkout.sessions.list;
  if (!paymentIntentId || typeof list !== 'function') return;
  let listed;
  try {
    listed = await list.call(stripe.checkout.sessions, { payment_intent: paymentIntentId, limit: 10 });
  } catch (err) {
    if (isMissingError(err)) return;
    throw err;
  }
  const sessions = listed && Array.isArray(listed.data) ? listed.data : [];
  for (const session of sessions) absorbObject(bag, session);
}

async function absorbCustomer(stripe, customer, bag) {
  if (!customer) return;
  if (typeof customer === 'object') {
    if (customer.deleted === true) return;
    addMetadata(bag, customer.metadata);
    return;
  }
  if (typeof customer !== 'string') return;
  const loaded = await retrieveOptional(stripe, 'customers', customer);
  if (loaded) addMetadata(bag, loaded.metadata);
}

async function classifyChargeEvent(object, stripe, env, type) {
  const bag = freshBag();
  const charge = await loadCharge(object, stripe, type);
  if (charge) absorbObject(bag, charge);
  let decision = verdict(bag, env);
  if (decision !== 'unknown') return decision;

  const piRef = paymentIntentRef(object, charge);
  const pi = await loadPaymentIntent(piRef, stripe);
  if (pi) absorbObject(bag, pi);
  decision = verdict(bag, env);
  if (decision !== 'unknown') return decision;

  const piId = idString(pi) || (typeof piRef === 'string' ? piRef : '');
  decision = await absorbInvoiceChain(stripe, charge, piId, bag, env);
  if (decision !== 'unknown') return decision;

  await absorbSessions(stripe, piId, bag);
  decision = verdict(bag, env);
  if (decision !== 'unknown') return decision;

  const customer = customerRefOf(charge) || customerRefOf(object);
  await absorbCustomer(stripe, customer, bag);
  return verdict(bag, env);
}

async function classifyDirectObject(object, stripe, env) {
  const bag = freshBag();
  absorbObject(bag, object);
  const needsLookup = object.object === 'invoice'
    || object.object === 'subscription'
    || Boolean(object.subscription)
    || Boolean(object.parent && object.parent.subscription_details)
    || Boolean(object.lines || object.items);
  if (!needsLookup) return verdict(bag, env);
  return deepen(stripe, object, bag, env);
}

async function classifyStripeEvent(event, context = {}) {
  const type = event && event.type;
  const object = event && event.data && event.data.object;
  if (!type || !object || typeof object !== 'object') return 'other';
  const stripe = context.stripe;
  const env = context.env;
  if (isChargeFamily(type)) return classifyChargeEvent(object, stripe, env, type);
  return classifyDirectObject(object, stripe, env);
}

async function applyManualosCheckout(stripe, params, plan) {
  const next = { ...params };
  const lookupKey = LOOKUP_KEYS[plan];
  if (lookupKey && stripe && stripe.prices && typeof stripe.prices.list === 'function') {
    try {
      const listed = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      const match = listed && Array.isArray(listed.data)
        ? listed.data.find((price) => price && price.lookup_key === lookupKey && typeof price.id === 'string' && price.id)
        : null;
      if (match) {
        const quantity = params.line_items && params.line_items[0] && params.line_items[0].quantity
          ? params.line_items[0].quantity
          : 1;
        next.line_items = [{ price: match.id, quantity }];
      }
    } catch {
      console.error('Price lookup key search failed; using the configured price id');
    }
  }
  delete next.customer_update;
  const customer = typeof next.customer === 'string' ? next.customer.trim() : '';
  if (customer) next.customer = customer;
  else delete next.customer;
  return next;
}

module.exports = {
  BRAND,
  LOOKUP_PREFIX,
  LOOKUP_KEYS,
  HANDLED_EVENT_TYPES,
  isChargeFamily,
  classifyStripeEvent,
  applyManualosCheckout,
};
