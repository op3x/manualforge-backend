const test = require('node:test');
const assert = require('node:assert/strict');
const { checkoutParams } = require('../lib/billing');
const {
  DESCRIPTIONS,
  PAYMENT_REFUND_MESSAGE,
  SUBSCRIPTION_REFUND_MESSAGE,
  starterDescription,
  withCheckoutPolicy,
} = require('../lib/checkoutPolicy');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');

const PAYMENT_MESSAGE = 'Refundable until your first manual is delivered: within 30 days for Starter, or before the billing period ends for Pro and Integrator. Once a manual is delivered, that purchase is no longer refundable.';
const SUBSCRIPTION_MESSAGE = `${PAYMENT_MESSAGE} Cancel anytime.`;

const STARTER_DESCRIPTION = 'ManualOS Starter: 3 operator and maintenance manuals from your files';
const PRO_MONTHLY = 'ManualOS Pro: unlimited manuals, billed monthly';
const PRO_YEARLY = 'ManualOS Pro: unlimited manuals, billed yearly';
const INTEGRATOR_MONTHLY = 'ManualOS Integrator: 25 manuals per month';
const INTEGRATOR_YEARLY = 'ManualOS Integrator: 25 manuals per month, billed yearly';
const OVERAGE_DESCRIPTION = 'ManualOS Integrator: one extra manual';

const AI_WORD = /\bAI\b/i;

const env = {
  FRONTEND_URL: 'https://manualos.com/',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  STARTER_CREDITS: '3',
};

test.after(() => {
  removeTestJobDirectories();
});

function preserved(result, source) {
  assert.deepEqual(result.metadata, source.metadata);
  assert.deepEqual(result.line_items, source.line_items);
  assert.equal(result.success_url, source.success_url);
  assert.equal(result.cancel_url, source.cancel_url);
  assert.equal(result.mode, source.mode);
  assert.equal(result.integration_identifier, source.integration_identifier);
  assert.equal(result.payment_method_types, undefined);
  assert.equal(result.billing_address_collection, 'required');
  assert.equal(result.custom_text.submit.message, source.mode === 'subscription' ? SUBSCRIPTION_MESSAGE : PAYMENT_MESSAGE);
  assert.equal(result.consent_collection, undefined);
}

function customerCopy(result) {
  return [
    result.custom_text && result.custom_text.submit && result.custom_text.submit.message,
    result.payment_intent_data && result.payment_intent_data.description,
    result.subscription_data && result.subscription_data.description,
  ].filter(Boolean);
}

// Same merge #10's withAttribution uses: session metadata, and subscription_data
// metadata when mode is subscription. Other fields are copied through.
function withAttribution(params, raw) {
  if (raw === undefined) return params;
  const next = {
    ...params,
    metadata: { ...(params.metadata || {}), ...raw },
  };
  if (params.mode === 'subscription') {
    const subscriptionData = params.subscription_data && typeof params.subscription_data === 'object'
      ? params.subscription_data
      : {};
    next.subscription_data = {
      ...subscriptionData,
      metadata: { ...(subscriptionData.metadata || {}), ...raw },
    };
  }
  return next;
}

test('submit message is the refund rule and stays within 1200 characters', () => {
  assert.equal(PAYMENT_REFUND_MESSAGE, PAYMENT_MESSAGE);
  assert.equal(SUBSCRIPTION_REFUND_MESSAGE, SUBSCRIPTION_MESSAGE);
  assert.equal(PAYMENT_MESSAGE.length <= 1200, true);
  assert.equal(SUBSCRIPTION_MESSAGE.length <= 1200, true);
  assert.equal(PAYMENT_MESSAGE.includes('Cancel anytime.'), false);
  assert.equal(SUBSCRIPTION_MESSAGE.endsWith('Cancel anytime.'), true);
  const starter = withCheckoutPolicy(checkoutParams('starter', env), { plan: 'starter', env });
  const pro = withCheckoutPolicy(checkoutParams('pro', env), { plan: 'pro', env });
  assert.equal(starter.custom_text.submit.message, PAYMENT_MESSAGE);
  assert.equal(pro.custom_text.submit.message, SUBSCRIPTION_MESSAGE);
});

test('starter description uses STARTER_CREDITS and pluralizes', () => {
  const fiveEnv = { ...env, STARTER_CREDITS: '5' };
  const five = withCheckoutPolicy(checkoutParams('starter', fiveEnv), { plan: 'starter', env: fiveEnv });
  assert.equal(five.payment_intent_data.description, 'ManualOS Starter: 5 operator and maintenance manuals from your files');
  assert.equal(five.payment_intent_data.metadata.manuals_used, '0');
  assert.deepEqual(five.line_items, checkoutParams('starter', fiveEnv).line_items);
  assert.equal(five.success_url, checkoutParams('starter', fiveEnv).success_url);

  const oneEnv = { ...env, STARTER_CREDITS: '1' };
  const one = withCheckoutPolicy(checkoutParams('starter', oneEnv), { plan: 'starter', env: oneEnv });
  assert.equal(one.payment_intent_data.description, 'ManualOS Starter: 1 operator and maintenance manual from your files');

  const fallback = withCheckoutPolicy(checkoutParams('starter', env), { plan: 'starter', env: {} });
  assert.equal(fallback.payment_intent_data.description, starterDescription({}));
  assert.equal(fallback.payment_intent_data.description, 'ManualOS Starter: 3 operator and maintenance manuals from your files');
});

test('payment and subscription plans on main keep existing checkout fields', () => {
  const starterIn = checkoutParams('starter', env);
  const starterSnap = structuredClone(starterIn);
  const starter = withCheckoutPolicy(starterIn, { plan: 'starter', env: {} });
  assert.deepEqual(starterIn, starterSnap);
  assert.notEqual(starter, starterIn);
  assert.equal(starter.mode, 'payment');
  preserved(starter, starterIn);
  assert.equal(starter.payment_intent_data.description, STARTER_DESCRIPTION);
  assert.deepEqual(starter.payment_intent_data.metadata, starterIn.payment_intent_data.metadata);
  assert.equal(starter.subscription_data, undefined);
  assert.notEqual(starter.payment_intent_data, starterIn.payment_intent_data);
  assert.notEqual(starter.payment_intent_data.metadata, starterIn.payment_intent_data.metadata);

  const proIn = checkoutParams('pro', env);
  const pro = withCheckoutPolicy(proIn, { plan: 'pro', env: {} });
  assert.equal(pro.mode, 'subscription');
  preserved(pro, proIn);
  assert.equal(pro.subscription_data.description, PRO_MONTHLY);
  assert.deepEqual(pro.subscription_data.metadata, proIn.subscription_data.metadata);
  assert.equal(pro.payment_intent_data, undefined);
});

test('descriptions name the plan without calling the product AI', () => {
  const cases = [
    {
      plan: 'starter',
      params: checkoutParams('starter', env),
      description: STARTER_DESCRIPTION,
      slot: 'payment_intent_data',
    },
    {
      plan: 'pro',
      params: checkoutParams('pro', env),
      description: PRO_MONTHLY,
      slot: 'subscription_data',
    },
    {
      plan: 'pro',
      params: {
        ...checkoutParams('pro', env),
        metadata: { plan: 'pro', interval: 'year' },
        subscription_data: { metadata: { plan: 'pro', interval: 'year' } },
      },
      description: PRO_YEARLY,
      slot: 'subscription_data',
    },
    {
      plan: 'integrator',
      params: {
        mode: 'subscription',
        line_items: [{ price: 'price_int_month', quantity: 1 }],
        success_url: 'https://manualos.com/upload.html?session_id={CHECKOUT_SESSION_ID}',
        metadata: { plan: 'integrator', interval: 'month' },
        subscription_data: { metadata: { plan: 'integrator', interval: 'month', manuals_used: '0' } },
      },
      description: INTEGRATOR_MONTHLY,
      slot: 'subscription_data',
    },
    {
      plan: 'integrator',
      params: {
        mode: 'subscription',
        line_items: [{ price: 'price_int_year', quantity: 1 }],
        success_url: 'https://manualos.com/upload.html?session_id={CHECKOUT_SESSION_ID}',
        metadata: { plan: 'integrator', interval: 'year' },
        subscription_data: { metadata: { plan: 'integrator', interval: 'year', credits_granted: '0' } },
      },
      description: INTEGRATOR_YEARLY,
      slot: 'subscription_data',
    },
    {
      plan: 'integrator_annual',
      params: {
        mode: 'subscription',
        line_items: [{ price: 'price_int_year', quantity: 1 }],
        success_url: 'https://manualos.com/upload.html?session_id={CHECKOUT_SESSION_ID}',
        metadata: { plan: 'integrator', interval: 'month' },
        subscription_data: { metadata: { plan: 'integrator', interval: 'month', credits_granted: '0' } },
      },
      description: INTEGRATOR_YEARLY,
      slot: 'subscription_data',
    },
    {
      plan: 'integrator_overage',
      params: {
        mode: 'payment',
        line_items: [{ price: 'price_int_overage', quantity: 1 }],
        success_url: 'https://manualos.com/upload.html?session_id=cs_sub',
        metadata: { plan: 'integrator_overage', subscription_id: 'sub_int' },
        payment_intent_data: { metadata: { plan: 'integrator_overage', subscription_id: 'sub_int' } },
      },
      description: OVERAGE_DESCRIPTION,
      slot: 'payment_intent_data',
    },
  ];

  const seen = [];
  for (const entry of cases) {
    const result = withCheckoutPolicy(entry.params, { plan: entry.plan, env: {} });
    assert.equal(result[entry.slot].description, entry.description);
    assert.deepEqual(result[entry.slot].metadata, entry.params[entry.slot].metadata);
    assert.deepEqual(result.metadata, entry.params.metadata);
    assert.deepEqual(result.line_items, entry.params.line_items);
    assert.equal(result.success_url, entry.params.success_url);
    seen.push(...customerCopy(result));
  }

  seen.push(
    PAYMENT_MESSAGE,
    SUBSCRIPTION_MESSAGE,
    ...Object.values(DESCRIPTIONS.pro),
    ...Object.values(DESCRIPTIONS.integrator),
    DESCRIPTIONS.overage,
    starterDescription({ STARTER_CREDITS: '1' }),
    starterDescription({ STARTER_CREDITS: '3' }),
    starterDescription({ STARTER_CREDITS: '5' }),
  );
  for (const text of seen) {
    assert.equal(AI_WORD.test(text), false, text);
    assert.equal(text.includes('AI-generated'), false, text);
  }
});

test('policy merges nested checkout data and does not overwrite metadata', () => {
  const starter = checkoutParams('starter', env);
  starter.customer_creation = 'always';
  starter.payment_intent_data.transfer_group = 'grp_starter';
  starter.payment_intent_data.metadata.credit_hold = 'hold_1';
  starter.custom_text = {
    submit: { message: 'old', extra: 'keep' },
    shipping_address: { message: 'Ship to the plant.' },
  };
  const result = withCheckoutPolicy(starter, { plan: 'starter', env: { CHECKOUT_REQUIRE_TOS: '0' } });
  assert.equal(result.customer_creation, 'always');
  assert.equal(result.payment_intent_data.transfer_group, 'grp_starter');
  assert.equal(result.payment_intent_data.description, STARTER_DESCRIPTION);
  assert.deepEqual(result.payment_intent_data.metadata, {
    plan: 'starter',
    brand: 'manualos',
    manuals_used: '0',
    credit_hold: 'hold_1',
  });
  assert.equal(result.custom_text.submit.extra, 'keep');
  assert.deepEqual(result.custom_text.shipping_address, { message: 'Ship to the plant.' });
  assert.equal(result.consent_collection, undefined);

  const pro = checkoutParams('pro', env);
  pro.subscription_data.description = 'replace me';
  pro.subscription_data.trial_period_days = 0;
  pro.consent_collection = { promotions: 'auto' };
  const off = withCheckoutPolicy(pro, { plan: 'pro', env: {} });
  assert.equal(off.subscription_data.description, PRO_MONTHLY);
  assert.equal(off.subscription_data.trial_period_days, 0);
  assert.deepEqual(off.subscription_data.metadata, { plan: 'pro', brand: 'manualos' });
  assert.deepEqual(off.consent_collection, { promotions: 'auto' });

  const on = withCheckoutPolicy(pro, { plan: 'pro', env: { CHECKOUT_REQUIRE_TOS: '1' } });
  assert.deepEqual(on.consent_collection, { promotions: 'auto', terms_of_service: 'required' });
  assert.deepEqual(pro.consent_collection, { promotions: 'auto' });
});

test('terms of service consent is sent only when CHECKOUT_REQUIRE_TOS is 1', () => {
  const starter = checkoutParams('starter', env);
  for (const flag of [undefined, '', '0', 'true', 'yes', '01']) {
    const result = withCheckoutPolicy(starter, { plan: 'starter', env: { CHECKOUT_REQUIRE_TOS: flag } });
    assert.equal(result.consent_collection, undefined, String(flag));
  }
  for (const flag of ['1', ' 1 ', '1\n']) {
    const result = withCheckoutPolicy(starter, { plan: 'starter', env: { CHECKOUT_REQUIRE_TOS: flag } });
    assert.deepEqual(result.consent_collection, { terms_of_service: 'required' });
  }
});

test('checkout policy and attribution compose in either order', () => {
  const attribution = { attr_utm_source: 'newsletter', attr_utm_medium: 'email' };
  for (const plan of ['starter', 'pro']) {
    const base = checkoutParams(plan, env);
    const policyThenAttribution = withAttribution(
      withCheckoutPolicy(base, { plan, env: {} }),
      attribution,
    );
    const attributionThenPolicy = withCheckoutPolicy(
      withAttribution(structuredClone(base), attribution),
      { plan, env: {} },
    );
    assert.deepEqual(policyThenAttribution, attributionThenPolicy);
    assert.equal(policyThenAttribution.metadata.plan, plan);
    assert.equal(policyThenAttribution.metadata.attr_utm_source, 'newsletter');
    assert.equal(policyThenAttribution.billing_address_collection, 'required');
    assert.equal(
      policyThenAttribution.custom_text.submit.message,
      plan === 'pro' ? SUBSCRIPTION_MESSAGE : PAYMENT_MESSAGE,
    );
    assert.deepEqual(policyThenAttribution.line_items, base.line_items);
    assert.equal(policyThenAttribution.success_url, base.success_url);
    if (plan === 'starter') {
      assert.deepEqual(policyThenAttribution.payment_intent_data.metadata, base.payment_intent_data.metadata);
      assert.equal(policyThenAttribution.payment_intent_data.description, STARTER_DESCRIPTION);
    } else {
      assert.equal(policyThenAttribution.subscription_data.metadata.plan, 'pro');
      assert.equal(policyThenAttribution.subscription_data.metadata.attr_utm_medium, 'email');
      assert.equal(policyThenAttribution.subscription_data.description, PRO_MONTHLY);
    }
    for (const text of customerCopy(policyThenAttribution)) {
      assert.equal(AI_WORD.test(text), false);
    }
  }
});

function withUtm(metadata) {
  return {
    ...metadata,
    utm_source: 'newsletter',
    utm_medium: 'email',
    utm_campaign: 'october',
    utm_term: 'plc',
    utm_content: 'hero',
    attr_utm_source: 'newsletter',
    attr_utm_medium: 'email',
    attr_utm_campaign: 'october',
  };
}

function integratorCheckout(interval) {
  return {
    mode: 'subscription',
    line_items: [{ price: interval === 'year' ? 'price_int_year' : 'price_int_month', quantity: 1 }],
    success_url: 'https://manualos.com/upload.html?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://manualos.com/#pricing',
    metadata: withUtm({ plan: 'integrator', interval }),
    subscription_data: {
      metadata: withUtm({
        plan: 'integrator',
        interval,
        credits_granted: '0',
        manuals_used: '0',
        overage_remaining: '0',
        credit_generation: '0',
      }),
    },
    integration_identifier: interval === 'year'
      ? 'manualos_integrator_year_hxqpdmct'
      : 'manualos_integrator_month_bvkqnwpl',
  };
}

function overageCheckout() {
  return {
    mode: 'payment',
    line_items: [{ price: 'price_int_overage', quantity: 1 }],
    success_url: 'https://manualos.com/upload.html?session_id=cs_parent',
    cancel_url: 'https://manualos.com/#pricing',
    client_reference_id: 'sub_int',
    customer: 'cus_test',
    metadata: withUtm({
      plan: 'integrator_overage',
      subscription_id: 'sub_int',
      subscription_session_id: 'cs_parent',
    }),
    payment_intent_data: {
      metadata: withUtm({
        plan: 'integrator_overage',
        subscription_id: 'sub_int',
      }),
    },
    integration_identifier: 'manualos_integrator_overage_rlnwvkqb',
  };
}

test('utm metadata and integrator checkout shapes survive aside from policy fields', () => {
  const cases = [
    {
      plan: 'integrator',
      source: integratorCheckout('month'),
      slot: 'subscription_data',
      description: INTEGRATOR_MONTHLY,
      message: SUBSCRIPTION_MESSAGE,
    },
    {
      plan: 'integrator_annual',
      source: integratorCheckout('year'),
      slot: 'subscription_data',
      description: INTEGRATOR_YEARLY,
      message: SUBSCRIPTION_MESSAGE,
    },
    {
      plan: 'integrator_overage',
      source: overageCheckout(),
      slot: 'payment_intent_data',
      description: OVERAGE_DESCRIPTION,
      message: PAYMENT_MESSAGE,
    },
  ];
  const attribution = {
    attr_utm_source: 'newsletter',
    attr_utm_medium: 'email',
    attr_utm_campaign: 'october',
    attr_utm_term: 'plc',
    attr_utm_content: 'hero',
  };
  for (const entry of cases) {
    const result = withCheckoutPolicy(entry.source, { plan: entry.plan, env });
    const expected = structuredClone(entry.source);
    expected.billing_address_collection = 'required';
    expected.custom_text = { submit: { message: entry.message } };
    expected[entry.slot] = { ...expected[entry.slot], description: entry.description };
    assert.deepEqual(result, expected);
    assert.equal(result.consent_collection, undefined);
    assert.equal(result.custom_text.submit.message.includes('Cancel anytime.'), entry.source.mode === 'subscription');
    for (const key of Object.keys(entry.source.metadata)) {
      if (!key.includes('utm_')) continue;
      assert.equal(result.metadata[key], entry.source.metadata[key], key);
      assert.equal(result[entry.slot].metadata[key], entry.source[entry.slot].metadata[key], key);
    }

    const composed = withCheckoutPolicy(withAttribution(structuredClone(entry.source), attribution), {
      plan: entry.plan,
      env,
    });
    for (const [key, value] of Object.entries(attribution)) {
      assert.equal(composed.metadata[key], value, key);
    }
    assert.equal(composed.metadata.plan, entry.source.metadata.plan);
    assert.deepEqual(composed.line_items, entry.source.line_items);
    assert.equal(composed.success_url, entry.source.success_url);
    assert.equal(composed.cancel_url, entry.source.cancel_url);
    assert.equal(composed.integration_identifier, entry.source.integration_identifier);
    assert.equal(composed.client_reference_id, entry.source.client_reference_id);
    assert.equal(composed.customer, entry.source.customer);
    assert.equal(composed[entry.slot].description, entry.description);
    const nestedMetadata = entry.source.mode === 'subscription'
      ? { ...entry.source[entry.slot].metadata, ...attribution }
      : entry.source[entry.slot].metadata;
    assert.deepEqual(composed[entry.slot].metadata, nestedMetadata);
  }
});

function checkoutStripe(calls, customerCalls, priceLists) {
  let customers = 0;
  return {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          return { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' };
        },
      },
    },
    customers: {
      create: async (params) => {
        customerCalls.push(params);
        customers += 1;
        return { id: `cus_${customers}` };
      },
    },
    prices: {
      list: async (params) => {
        priceLists.push(params);
        return { data: [] };
      },
    },
  };
}

test('create-checkout-session sends the policy and does not call Stripe for a bad plan', async () => {
  const calls = [];
  const customerCalls = [];
  const priceLists = [];
  const stripe = checkoutStripe(calls, customerCalls, priceLists);
  const appEnv = {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
  };
  const app = createApp({
    env: appEnv,
    stripe,
    anthropic: { messages: { create: async () => { throw new Error('model unused'); } } },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const bad = await fetch(base + '/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'enterprise' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 0);
    assert.equal(customerCalls.length, 0);
    assert.equal(priceLists.length, 0);

    for (const plan of ['starter', 'pro']) {
      const response = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ['url']);
    }
    const starterExpected = withCheckoutPolicy(checkoutParams('starter', appEnv), { plan: 'starter', env: appEnv });
    starterExpected.customer = 'cus_1';
    starterExpected.customer_update = { address: 'auto' };
    const proExpected = withCheckoutPolicy(checkoutParams('pro', appEnv), { plan: 'pro', env: appEnv });
    proExpected.customer = 'cus_2';
    proExpected.customer_update = { address: 'auto' };
    assert.deepEqual(calls[0], starterExpected);
    assert.deepEqual(calls[1], proExpected);
    assert.deepEqual(customerCalls, [{ metadata: { brand: 'manualos' } }, { metadata: { brand: 'manualos' } }]);
    assert.deepEqual(priceLists[0], { lookup_keys: ['manualos_starter'], active: true, limit: 1 });
    assert.deepEqual(priceLists[1], { lookup_keys: ['manualos_pro'], active: true, limit: 1 });
    assert.equal(calls[0].consent_collection, undefined);
    assert.equal(calls[1].consent_collection, undefined);
    for (const params of calls) {
      for (const text of customerCopy(params)) assert.equal(AI_WORD.test(text), false);
    }

    const tosCalls = [];
    const tosEnv = { ...appEnv, CHECKOUT_REQUIRE_TOS: '1' };
    const tosApp = createApp({
      env: tosEnv,
      stripe: checkoutStripe(tosCalls, [], []),
      anthropic: { messages: { create: async () => { throw new Error('model unused'); } } },
    });
    const tosServer = tosApp.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      tosServer.once('listening', resolve);
      tosServer.once('error', reject);
    });
    try {
      const tosBase = `http://127.0.0.1:${tosServer.address().port}`;
      const paid = await fetch(tosBase + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'starter' }),
      });
      assert.equal(paid.status, 200);
      assert.equal(tosCalls[0].consent_collection.terms_of_service, 'required');
      assert.equal(tosCalls[0].payment_intent_data.metadata.manuals_used, '0');
      assert.equal(String(process.env.CHECKOUT_REQUIRE_TOS || '').trim() === '1', false);
    } finally {
      await new Promise((resolve) => tosServer.close(resolve));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
