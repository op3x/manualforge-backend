const test = require('node:test');
const assert = require('node:assert/strict');
const { checkoutParams } = require('../lib/billing');
const { withCheckoutPolicy, SUBSCRIPTION_REFUND_MESSAGE } = require('../lib/checkoutPolicy');
const {
  MANUALOS_PRODUCT_TAX_CODE,
  TOP_LEVEL_CONFLICTS,
  SUBSCRIPTION_DATA_CONFLICTS,
  PAYMENT_INTENT_DATA_CONFLICTS,
  managedPaymentsEnabled,
  applyManagedPayments,
} = require('../lib/managedPayments');

const env = {
  FRONTEND_URL: 'https://manualos.com/',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  STARTER_CREDITS: '3',
};

function assertNoConflicts(params) {
  for (const key of TOP_LEVEL_CONFLICTS) {
    assert.equal(params[key], undefined, key);
  }
  assert.equal(params.consent_collection && params.consent_collection.terms_of_service, undefined);
  const subscription = params.subscription_data || {};
  for (const key of SUBSCRIPTION_DATA_CONFLICTS) assert.equal(subscription[key], undefined, key);
  const payment = params.payment_intent_data || {};
  for (const key of PAYMENT_INTENT_DATA_CONFLICTS) assert.equal(payment[key], undefined, key);
  assert.equal(params.lookup_key, undefined);
}

test('Managed Payments defaults on and false disables it', () => {
  assert.equal(managedPaymentsEnabled(undefined), true);
  assert.equal(managedPaymentsEnabled({}), true);
  assert.equal(managedPaymentsEnabled({ MANUALOS_MANAGED_PAYMENTS: undefined }), true);
  assert.equal(managedPaymentsEnabled({ MANUALOS_MANAGED_PAYMENTS: '' }), true);
  assert.equal(managedPaymentsEnabled({ MANUALOS_MANAGED_PAYMENTS: 'true' }), true);
  assert.equal(managedPaymentsEnabled({ MANUALOS_MANAGED_PAYMENTS: 'false' }), false);
  assert.equal(managedPaymentsEnabled({ MANUALOS_MANAGED_PAYMENTS: ' FALSE ' }), false);
  assert.equal(managedPaymentsEnabled({ MANUALOS_MANAGED_PAYMENTS: '0' }), false);
  assert.equal(managedPaymentsEnabled({ MANUALOS_MANAGED_PAYMENTS: 'off' }), false);
  assert.equal(managedPaymentsEnabled({ MANUALOS_MANAGED_PAYMENTS: 'no' }), false);
  assert.equal(MANUALOS_PRODUCT_TAX_CODE, 'txcd_10103001');
});

test('Starter and Pro sessions enable Managed Payments and keep plan metadata', () => {
  for (const plan of ['starter', 'pro']) {
    const params = withCheckoutPolicy(checkoutParams(plan, env), { plan, env });
    assert.deepEqual(params.managed_payments, { enabled: true });
    assert.equal(params.metadata.plan, plan);
    assert.equal(params.line_items[0].price, plan === 'starter' ? 'price_starter' : 'price_pro');
    assert.equal(params.payment_method_types, undefined);
    assertNoConflicts(params);
    if (plan === 'starter') {
      assert.equal(params.mode, 'payment');
      assert.deepEqual(params.payment_intent_data.metadata, { plan: 'starter', manuals_used: '0' });
      assert.match(params.payment_intent_data.description, /ManualOS Starter: 3 operator and maintenance manuals/);
    } else {
      assert.equal(params.mode, 'subscription');
      assert.deepEqual(params.subscription_data.metadata, { plan: 'pro' });
      assert.equal(params.subscription_data.description, 'ManualOS Pro: unlimited manuals, billed monthly');
    }
  }

  const offEnv = { ...env, MANUALOS_MANAGED_PAYMENTS: 'false' };
  const starter = withCheckoutPolicy(checkoutParams('starter', offEnv), { plan: 'starter', env: offEnv });
  const pro = withCheckoutPolicy(checkoutParams('pro', offEnv), { plan: 'pro', env: offEnv });
  assert.equal(starter.managed_payments, undefined);
  assert.equal(pro.managed_payments, undefined);
  assert.equal(starter.billing_address_collection, 'required');
  assert.equal(pro.billing_address_collection, 'required');
  assert.match(starter.custom_text.submit.message, /Refundable until your first manual is delivered/);
  assert.equal(starter.custom_text.submit.message.includes('Cancel anytime.'), false);
  assert.equal(pro.custom_text.submit.message, SUBSCRIPTION_REFUND_MESSAGE);
  assert.equal(pro.custom_text.submit.message.endsWith('Cancel anytime.'), true);
});

test('Integrator-shaped sessions follow the same flag', () => {
  const integrator = {
    mode: 'subscription',
    line_items: [{ price: 'price_int_month', quantity: 1 }],
    success_url: 'https://manualos.com/upload.html?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://manualos.com/#pricing',
    metadata: { plan: 'integrator', interval: 'month', brand: 'manualos' },
    subscription_data: {
      metadata: { plan: 'integrator', interval: 'month', brand: 'manualos', manuals_used: '0' },
    },
    integration_identifier: 'manualos_integrator_month_bvkqnwpl',
    custom_text: { submit: { message: 'drop me' } },
    automatic_tax: { enabled: true },
    billing_address_collection: 'required',
    consent_collection: { terms_of_service: 'required', promotions: 'auto' },
  };
  const on = withCheckoutPolicy(integrator, { plan: 'integrator', env });
  assert.deepEqual(on.managed_payments, { enabled: true });
  assert.equal(on.metadata.brand, 'manualos');
  assert.equal(on.subscription_data.metadata.brand, 'manualos');
  assert.equal(on.subscription_data.metadata.manuals_used, '0');
  assert.equal(on.subscription_data.description, 'ManualOS Integrator: 25 manuals per month');
  assert.deepEqual(on.consent_collection, { promotions: 'auto' });
  assert.equal(on.integration_identifier, integrator.integration_identifier);
  assertNoConflicts(on);
  assert.equal(integrator.custom_text.submit.message, 'drop me');

  const off = withCheckoutPolicy(structuredClone(integrator), {
    plan: 'integrator',
    env: { MANUALOS_MANAGED_PAYMENTS: 'false' },
  });
  assert.equal(off.managed_payments, undefined);
  assert.equal(off.billing_address_collection, 'required');
  assert.match(off.custom_text.submit.message, /Cancel anytime\.$/);
  assert.equal(off.metadata.brand, 'manualos');
});

test('applyManagedPayments does not invent a lookup key or drop an existing brand', () => {
  const params = applyManagedPayments({
    mode: 'payment',
    metadata: { plan: 'starter', brand: 'manualos' },
    line_items: [{ price: 'price_starter', quantity: 1 }],
    custom_text: { submit: { message: 'x' } },
    payment_intent_data: {
      metadata: { plan: 'starter', brand: 'manualos' },
      receipt_email: 'buyer@example.com',
    },
  }, {});
  assert.equal(params.metadata.brand, 'manualos');
  assert.equal(params.payment_intent_data.metadata.brand, 'manualos');
  assert.equal(params.payment_intent_data.receipt_email, undefined);
  assert.equal(params.lookup_key, undefined);
  assert.deepEqual(params.managed_payments, { enabled: true });
  assertNoConflicts(params);
});
