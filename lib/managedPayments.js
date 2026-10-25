// Managed Payments is opt-in on each Checkout Session. The account setting
// does not turn it on. Docs:
// https://docs.stripe.com/payments/managed-payments/set-up
// https://docs.stripe.com/payments/managed-payments/update-checkout
// https://docs.stripe.com/payments/managed-payments/eligibility
//
// API version 2025-03-31.basil or later. No preview header. stripe@23 pins
// 2026-09-30.endive, which already includes managed_payments.enabled.
//
// MANUALOS_MANAGED_PAYMENTS is off unless the value is exactly "1".
// billing_address_collection and consent_collection.terms_of_service stay.
// payment_intent_data.statement_descriptor_suffix is rejected by Managed
// Payments and is removed. customer_update is on the update-guide remove
// list and is removed when it is already on the params.
//
// Product tax code txcd_10103001 is "Software as a service (SaaS) - business
// use": cloud software, not downloaded, not customized per buyer. Starter,
// Pro, and Integrator are that same generator at different entitlements.
// txcd_10504003 is prewritten electronic software documentation, which is
// not what these products are. txcd_10105002 (AIaaS, business use) is also
// eligible; memo 03 treats the sale as SaaS, so every ManualOS product uses
// the one SaaS code.

const MANUALOS_PRODUCT_TAX_CODE = 'txcd_10103001';

// Parameters the update-checkout guide says to remove, plus custom_text
// (hard error in the HTS test-mode sessions) and billing_address_collection
// (Managed Payments collects the name and billing address itself).
const TOP_LEVEL_CONFLICTS = [
  'custom_text',
  'automatic_tax',
  'tax_id_collection',
  'adaptive_pricing',
  'payment_method_types',
  'payment_method_configuration',
  'excluded_payment_method_types',
  'customer_update',
  'shipping_address_collection',
  'shipping_options',
  'invoice_creation',
];

const SUBSCRIPTION_DATA_CONFLICTS = [
  'default_tax_rates',
  'invoice_settings',
  'application_fee_percent',
  'on_behalf_of',
  'transfer_data',
];

const PAYMENT_INTENT_DATA_CONFLICTS = [
  'application_fee_amount',
  'on_behalf_of',
  'transfer_data',
  'transfer_group',
  'shipping',
  'statement_descriptor',
  'statement_descriptor_suffix',
  'receipt_email',
];

function managedPaymentsEnabled(env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source.MANUALOS_MANAGED_PAYMENTS;
  if (raw === undefined || raw === null) return false;
  return String(raw).trim() === '1';
}

function taxCodePresent(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (isRecord(value) && typeof value.id === 'string') return value.id.trim() !== '';
  return false;
}

function priceIdOf(price) {
  if (typeof price === 'string') return price.trim();
  if (isRecord(price) && typeof price.id === 'string') return price.id.trim();
  return '';
}

async function lineItemsMissingTaxCode(stripe, params) {
  const items = params && Array.isArray(params.line_items) ? params.line_items : [];
  const missing = [];
  if (!items.length) {
    missing.push('no line items');
    return missing;
  }
  if (!stripe || !stripe.prices || typeof stripe.prices.retrieve !== 'function') {
    missing.push('price retrieve is unavailable');
    return missing;
  }
  for (const item of items) {
    const priceId = priceIdOf(item && item.price);
    if (!priceId) {
      missing.push('line item has no price id');
      continue;
    }
    let price;
    try {
      price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    } catch {
      missing.push(`price ${priceId} could not be read`);
      continue;
    }
    const product = price && price.product;
    if (!isRecord(product)) {
      missing.push(`price ${priceId} did not include a product`);
      continue;
    }
    if (!taxCodePresent(product.tax_code)) missing.push(product.id || priceId);
  }
  return missing;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function omitKeys(source, keys) {
  const next = { ...source };
  for (const key of keys) delete next[key];
  if (isRecord(source.metadata)) next.metadata = { ...source.metadata };
  return next;
}

function applyManagedPayments(params, env) {
  const source = isRecord(params) ? params : {};
  const next = { ...source };
  if (isRecord(source.metadata)) next.metadata = { ...source.metadata };

  if (!managedPaymentsEnabled(env)) {
    delete next.managed_payments;
    return next;
  }

  for (const key of TOP_LEVEL_CONFLICTS) delete next[key];

  if (isRecord(next.subscription_data)) {
    next.subscription_data = omitKeys(next.subscription_data, SUBSCRIPTION_DATA_CONFLICTS);
  }
  if (isRecord(next.payment_intent_data)) {
    next.payment_intent_data = omitKeys(next.payment_intent_data, PAYMENT_INTENT_DATA_CONFLICTS);
  }

  next.managed_payments = { enabled: true };
  return next;
}

module.exports = {
  MANUALOS_PRODUCT_TAX_CODE,
  TOP_LEVEL_CONFLICTS,
  SUBSCRIPTION_DATA_CONFLICTS,
  PAYMENT_INTENT_DATA_CONFLICTS,
  managedPaymentsEnabled,
  lineItemsMissingTaxCode,
  applyManagedPayments,
};
