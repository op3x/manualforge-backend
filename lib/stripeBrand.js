// ManualOS shares a Stripe account with HTS Atlas. Checkout stamps brand=manualos
// and prefers prices whose lookup_key starts with manualos_. The webhook
// processes only events that classify as ManualOS.

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

function lookupFailed() {
  const err = new Error('brand_lookup_failed');
  err.code = 'brand_lookup_failed';
  return err;
}

function createIdSet(initial) {
  if (initial instanceof Set) return initial;
  const ids = new Set();
  if (Array.isArray(initial)) {
    for (const id of initial) {
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

function isChargeFamily(type) {
  return typeof type === 'string' && (
    type.startsWith('charge.')
    || type.startsWith('refund.')
    || type.startsWith('radar.early_fraud_warning.')
  );
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

function isPaymentId(value) {
  return typeof value === 'string' && (value.startsWith('ch_') || value.startsWith('pi_'));
}

function isCustomerId(value) {
  return typeof value === 'string' && value.startsWith('cus_');
}

function idString(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return '';
}

function paymentIdsOf(object) {
  const ids = [];
  const push = (value) => {
    const id = idString(value);
    if (isPaymentId(id)) ids.push(id);
  };
  if (!object || typeof object !== 'object') return ids;
  push(object.id);
  push(object.charge);
  push(object.payment_intent);
  if (object.charge && typeof object.charge === 'object') push(object.charge.payment_intent);
  return ids;
}

function customerRefOf(object) {
  if (!object || typeof object !== 'object') return null;
  if (object.customer) return object.customer;
  if (object.charge && typeof object.charge === 'object' && object.charge.customer) return object.charge.customer;
  return null;
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
  }
  if (object.price && typeof object.price === 'object') push(object.price.id, object.price.lookup_key);
  return refs;
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

function classifyOwnedObject(object, env) {
  const brands = [];
  const plans = [];
  for (const metadata of metadataNodes(object)) {
    const brand = readBrand(metadata);
    const plan = readPlan(metadata);
    if (brand) brands.push(brand);
    if (plan) plans.push(plan);
  }
  const lookups = [];
  const priceIds = [];
  for (const ref of priceRefsOf(object)) {
    if (ref.lookupKey) lookups.push(ref.lookupKey);
    if (ref.id) priceIds.push(ref.id);
  }

  if (brands.some((brand) => brand !== BRAND)) return 'other';
  if (lookups.some((key) => !key.startsWith(LOOKUP_PREFIX))) return 'other';
  if (brands.some((brand) => brand === BRAND)) return 'ours';
  if (lookups.some((key) => key.startsWith(LOOKUP_PREFIX))) return 'ours';
  const configured = configuredPriceIds(env);
  if (priceIds.some((id) => configured.has(id))) return 'ours';
  if (plans.some((plan) => MANUALOS_PLANS.has(plan))) return 'ours';
  return 'other';
}

// A recorded charge is ours even if the customer was later stamped with another
// brand. Otherwise customer.metadata.brand decides, and an explicit foreign
// brand wins over a customer id this process already knows.
function decideChargeFamily({ chargeKnown, customerBrand, customerId, knownCustomerIds }) {
  if (chargeKnown) return 'ours';
  const knownCustomer = Boolean(customerId && knownCustomerIds && knownCustomerIds.has(customerId));
  if (customerBrand && customerBrand !== BRAND) return 'other';
  if (customerBrand === BRAND) return 'ours';
  if (knownCustomer) return 'other';
  return 'other';
}

async function retrieve(stripe, group, id) {
  const resource = stripe && stripe[group] && stripe[group].retrieve;
  if (typeof resource !== 'function') throw lookupFailed();
  try {
    return await resource.call(stripe[group], id);
  } catch {
    throw lookupFailed();
  }
}

async function resolveCharge(object, stripe) {
  if (object.object === 'charge') return object;
  const charge = object.charge;
  if (!charge) return null;
  if (typeof charge === 'object') return charge;
  if (typeof charge !== 'string') return null;
  return retrieve(stripe, 'charges', charge);
}

async function brandFromCustomer(customer, stripe) {
  if (!customer) return { brand: '', id: '' };
  if (typeof customer === 'object') {
    return { brand: readBrand(customer.metadata), id: idString(customer) };
  }
  if (typeof customer !== 'string') return { brand: '', id: '' };
  const loaded = await retrieve(stripe, 'customers', customer);
  return { brand: readBrand(loaded && loaded.metadata), id: customer };
}

function effectiveBrand(brands) {
  if (brands.some((brand) => brand && brand !== BRAND)) {
    return brands.find((brand) => brand && brand !== BRAND);
  }
  if (brands.includes(BRAND)) return BRAND;
  return '';
}

async function classifyChargeEvent(object, context, knownChargeIds, knownCustomerIds) {
  if (paymentIdsOf(object).some((id) => knownChargeIds.has(id))) return 'ours';

  let charge = null;
  if (object.object === 'charge') charge = object;
  else if (object.charge && typeof object.charge === 'object') charge = object.charge;
  else if (typeof object.charge === 'string') charge = await resolveCharge(object, context.stripe);

  if (charge && charge !== object && paymentIdsOf(charge).some((id) => knownChargeIds.has(id))) return 'ours';

  const visible = [];
  const objectBrand = readBrand(object.metadata);
  const chargeBrand = charge && charge !== object ? readBrand(charge.metadata) : '';
  if (objectBrand) visible.push(objectBrand);
  if (chargeBrand) visible.push(chargeBrand);

  const customer = customerRefOf(charge) || customerRefOf(object);
  if (customer && typeof customer === 'object') {
    const embedded = readBrand(customer.metadata);
    if (embedded) visible.push(embedded);
  }

  // A brand already on the payload is enough. Do not call Stripe for it.
  if (visible.some((brand) => brand !== BRAND)) {
    return decideChargeFamily({
      chargeKnown: false,
      customerBrand: effectiveBrand(visible),
      customerId: idString(customer),
      knownCustomerIds,
    });
  }

  let loadedBrand = '';
  let loadedId = idString(customer);
  if (typeof customer === 'string') {
    const loaded = await brandFromCustomer(customer, context.stripe);
    loadedBrand = loaded.brand;
    loadedId = loaded.id || customer;
  }

  return decideChargeFamily({
    chargeKnown: false,
    customerBrand: effectiveBrand([...visible, loadedBrand]),
    customerId: loadedId,
    knownCustomerIds,
  });
}

async function classifyStripeEvent(event, context = {}) {
  const type = event && event.type;
  const object = event && event.data && event.data.object;
  if (!type || !object || typeof object !== 'object') return 'other';
  const knownChargeIds = context.knownChargeIds || new Set();
  const knownCustomerIds = context.knownCustomerIds || new Set();
  if (isChargeFamily(type)) return classifyChargeEvent(object, context, knownChargeIds, knownCustomerIds);
  return classifyOwnedObject(object, context.env);
}

function rememberManualosPayments(chargeIds, customerIds, event) {
  const object = event && event.data && event.data.object;
  if (!object || typeof object !== 'object') return;
  const visit = (value, depth) => {
    if (!value || depth > 3) return;
    if (typeof value === 'string') {
      if (chargeIds && isPaymentId(value)) chargeIds.add(value);
      if (customerIds && isCustomerId(value)) customerIds.add(value);
      return;
    }
    if (typeof value !== 'object') return;
    visit(value.id, depth + 1);
    visit(value.customer, depth + 1);
    visit(value.charge, depth + 1);
    visit(value.payment_intent, depth + 1);
  };
  visit(object, 0);
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
  if (!stripe || !stripe.customers || typeof stripe.customers.create !== 'function') {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Stripe customer create is unavailable');
  }
  let customer;
  try {
    customer = await stripe.customers.create({ metadata: { brand: BRAND } });
  } catch {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Stripe customer create failed');
  }
  if (!customer || typeof customer.id !== 'string' || !customer.id) {
    throw exposed(500, 'Checkout is temporarily unavailable.', 'Stripe customer create did not return an id');
  }
  next.customer = customer.id;
  next.customer_update = { address: 'auto' };
  return next;
}

module.exports = {
  BRAND,
  LOOKUP_PREFIX,
  LOOKUP_KEYS,
  HANDLED_EVENT_TYPES,
  createIdSet,
  isChargeFamily,
  classifyStripeEvent,
  rememberManualosPayments,
  applyManualosCheckout,
};
