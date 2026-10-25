// Managed Payments is opt-in on each Checkout Session. The account setting
// does not turn it on. Docs:
// https://docs.stripe.com/payments/managed-payments/set-up
// https://docs.stripe.com/payments/managed-payments/update-checkout
// https://docs.stripe.com/payments/managed-payments/eligibility
//
// API version 2025-03-31.basil or later. No preview header. stripe@23 pins
// 2026-09-30.endive, which already includes managed_payments.enabled.
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
  'billing_address_collection',
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
  if (!Object.hasOwn(source, 'MANUALOS_MANAGED_PAYMENTS')) return true;
  const raw = source.MANUALOS_MANAGED_PAYMENTS;
  if (raw === undefined || raw === null) return true;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return true;
  return value !== 'false' && value !== '0' && value !== 'off' && value !== 'no';
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

  if (isRecord(next.consent_collection)) {
    const consent = { ...next.consent_collection };
    delete consent.terms_of_service;
    if (Object.keys(consent).length === 0) delete next.consent_collection;
    else next.consent_collection = consent;
  }

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
  applyManagedPayments,
};
