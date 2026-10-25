const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { checkoutParams } = require('../lib/billing');
const {
  DESCRIPTIONS,
  starterDescription,
  withCheckoutPolicy,
} = require('../lib/checkoutPolicy');
const {
  CHECKOUT_TOS_VERSION,
  INTEGRATOR_ANNUAL_SUBMIT_MESSAGE,
  INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE,
  INTEGRATOR_MONTHLY_SUBMIT_MESSAGE,
  INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE,
  PRO_SUBMIT_MESSAGE,
  PRO_TERMS_ACCEPTANCE_MESSAGE,
  STARTER_SUBMIT_MESSAGE,
  STARTER_TERMS_ACCEPTANCE_MESSAGE,
  termsAcceptanceMessage,
  stripeSubmitMessage,
  tosLabelSha,
} = require('../lib/checkoutLabels');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');

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
  const plan = source.metadata && source.metadata.plan;
  const terms = plan === 'pro' ? PRO_TERMS_ACCEPTANCE_MESSAGE : STARTER_TERMS_ACCEPTANCE_MESSAGE;
  const submit = plan === 'pro' ? PRO_SUBMIT_MESSAGE : STARTER_SUBMIT_MESSAGE;
  assert.deepEqual(result.metadata, {
    ...source.metadata,
    terms_version: CHECKOUT_TOS_VERSION,
    tos_label_sha: tosLabelSha(terms, submit),
  });
  assert.deepEqual(result.line_items, source.line_items);
  assert.equal(result.success_url, source.success_url);
  assert.equal(result.cancel_url, source.cancel_url);
  assert.equal(result.mode, source.mode);
  assert.equal(result.integration_identifier, source.integration_identifier);
  assert.equal(result.payment_method_types, undefined);
  assert.equal(result.billing_address_collection, 'required');
  assert.equal(result.custom_text.submit.message, submit);
  assert.deepEqual(result.consent_collection, { terms_of_service: 'required' });
  assert.equal(result.custom_text.terms_of_service_acceptance.message, terms);
  assert.equal(result.metadata.plan, plan);
  assert.equal(result.metadata.terms_version, CHECKOUT_TOS_VERSION);
  assert.equal(result.metadata.tos_label_sha, tosLabelSha(terms, submit));
}

function customerCopy(result) {
  return [
    result.custom_text && result.custom_text.submit && result.custom_text.submit.message,
    result.custom_text && result.custom_text.terms_of_service_acceptance && result.custom_text.terms_of_service_acceptance.message,
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

test('each plan has its own submit text and terms label, all under 1200 characters', () => {
  const renewal = 'Pro renews automatically every month at $79 (USD, plus applicable taxes) until you cancel. Cancel anytime online with the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Pro until the end of the period you\'ve paid for.';
  const keepIntegrator = 'Cancel anytime online with the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Integrator until the end of the period you\'ve paid for.';
  const monthlyRefund = 'Each monthly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise.';
  const yearlyRefund = 'Each yearly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise.';
  assert.equal(STARTER_SUBMIT_MESSAGE, 'Full refund within 30 days of purchase, as long as no manual from that purchase has been delivered, except where the law requires otherwise.');
  assert.equal(PRO_SUBMIT_MESSAGE, `${renewal} ${monthlyRefund}`);
  assert.equal(INTEGRATOR_MONTHLY_SUBMIT_MESSAGE, `Integrator renews automatically every month at $249 (USD, plus applicable taxes) until you cancel. ${keepIntegrator} ${monthlyRefund}`);
  assert.equal(INTEGRATOR_ANNUAL_SUBMIT_MESSAGE, `Integrator renews automatically every year at $2,490 (USD, plus applicable taxes) until you cancel. ${keepIntegrator} ${yearlyRefund}`);
  assert.equal(INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE, 'I agree to the [ManualOS Terms](https://manualos.com/terms.html) and authorize Op3x LLC to charge my card $249/month (USD, plus applicable taxes), renewing automatically each month until I cancel.');
  assert.equal(INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE, 'I agree to the [ManualOS Terms](https://manualos.com/terms.html) and authorize Op3x LLC to charge my card $2,490/year (USD, plus applicable taxes), renewing automatically each year until I cancel.');
  for (const text of [
    STARTER_SUBMIT_MESSAGE,
    PRO_SUBMIT_MESSAGE,
    INTEGRATOR_MONTHLY_SUBMIT_MESSAGE,
    INTEGRATOR_ANNUAL_SUBMIT_MESSAGE,
    STARTER_TERMS_ACCEPTANCE_MESSAGE,
    PRO_TERMS_ACCEPTANCE_MESSAGE,
    INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE,
    INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE,
  ]) {
    assert.equal(text.length > 0 && text.length <= 1200, true, String(text.length));
  }
  assert.equal(PRO_SUBMIT_MESSAGE.includes('$249'), false);
  assert.equal(INTEGRATOR_MONTHLY_SUBMIT_MESSAGE.includes('$79'), false);
  assert.equal(INTEGRATOR_ANNUAL_SUBMIT_MESSAGE.includes('$79'), false);
  assert.equal(stripeSubmitMessage('integrator_monthly'), INTEGRATOR_MONTHLY_SUBMIT_MESSAGE);
  assert.throws(() => stripeSubmitMessage('integrator'), (err) => err.status === 400 && err.message === 'plan_unavailable');
  assert.throws(() => termsAcceptanceMessage('pro_annual'), (err) => err.status === 400 && err.message === 'plan_unavailable');
  assert.throws(() => termsAcceptanceMessage(''), (err) => err.message === 'plan_unavailable');
  const policySource = fs.readFileSync(path.join(__dirname, '../lib/checkoutPolicy.js'), 'utf8');
  const labelSource = fs.readFileSync(path.join(__dirname, '../lib/checkoutLabels.js'), 'utf8');
  assert.equal(policySource.includes('Refundable until your first manual'), false);
  assert.equal(labelSource.includes('Refundable until your first manual'), false);

  const plans = [
    ['starter', checkoutParams('starter', env), STARTER_TERMS_ACCEPTANCE_MESSAGE, STARTER_SUBMIT_MESSAGE, 'payment_intent_data'],
    ['pro', checkoutParams('pro', env), PRO_TERMS_ACCEPTANCE_MESSAGE, PRO_SUBMIT_MESSAGE, 'subscription_data'],
    ['integrator', {
      mode: 'subscription',
      metadata: { plan: 'integrator', interval: 'month' },
      subscription_data: { metadata: { plan: 'integrator', interval: 'month' } },
    }, INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE, INTEGRATOR_MONTHLY_SUBMIT_MESSAGE, 'subscription_data'],
    ['integrator_annual', {
      mode: 'subscription',
      metadata: { plan: 'integrator', interval: 'year' },
      subscription_data: { metadata: { plan: 'integrator', interval: 'year' } },
    }, INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE, INTEGRATOR_ANNUAL_SUBMIT_MESSAGE, 'subscription_data'],
  ];
  for (const [plan, params, terms, submit, slot] of plans) {
    const result = withCheckoutPolicy(params, { plan, env });
    const legal = plan === 'integrator' ? 'integrator_monthly' : plan;
    const sha = crypto.createHash('sha256').update(`${terms}${submit}`, 'utf8').digest('hex').slice(0, 12);
    assert.equal(result.custom_text.terms_of_service_acceptance.message, terms, plan);
    assert.equal(result.custom_text.submit.message, submit, plan);
    assert.equal(result.consent_collection.terms_of_service, 'required', plan);
    assert.equal(result.metadata.plan, legal, plan);
    assert.equal(result.metadata.terms_version, 'checkout-tos-v2', plan);
    assert.equal(result.metadata.tos_label_sha, sha, plan);
    assert.equal(result.metadata.tos_label_sha, tosLabelSha(terms, submit), plan);
    assert.equal(result[slot].metadata.plan, legal, plan);
    assert.equal(result[slot].metadata.terms_version, 'checkout-tos-v2', plan);
    assert.equal(result[slot].metadata.tos_label_sha, sha, plan);
    assert.equal(submit.includes('[manualos.com/cancel]'), false, plan);
  }
  assert.throws(
    () => withCheckoutPolicy(checkoutParams('pro', env), { plan: 'pro_annual', env }),
    (err) => err.status === 400 && err.message === 'plan_unavailable',
  );
  assert.throws(
    () => withCheckoutPolicy({ mode: 'payment', metadata: { plan: 'integrator_overage' } }, { plan: 'integrator_overage', env }),
    (err) => err.status === 400 && err.message === 'plan_unavailable',
  );
  assert.throws(
    () => withCheckoutPolicy({ mode: 'payment', metadata: { plan: 'enterprise' } }, { plan: 'enterprise', env }),
    (err) => err.status === 400 && err.message === 'plan_unavailable',
  );
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
  assert.deepEqual(starter.payment_intent_data.metadata, {
    ...starterIn.payment_intent_data.metadata,
    terms_version: CHECKOUT_TOS_VERSION,
    tos_label_sha: tosLabelSha(STARTER_TERMS_ACCEPTANCE_MESSAGE, STARTER_SUBMIT_MESSAGE),
  });
  assert.equal(starter.subscription_data, undefined);
  assert.notEqual(starter.payment_intent_data, starterIn.payment_intent_data);
  assert.notEqual(starter.payment_intent_data.metadata, starterIn.payment_intent_data.metadata);

  const proIn = checkoutParams('pro', env);
  const pro = withCheckoutPolicy(proIn, { plan: 'pro', env: {} });
  assert.equal(pro.mode, 'subscription');
  preserved(pro, proIn);
  assert.equal(pro.subscription_data.description, PRO_MONTHLY);
  assert.deepEqual(pro.subscription_data.metadata, {
    ...proIn.subscription_data.metadata,
    terms_version: CHECKOUT_TOS_VERSION,
    tos_label_sha: tosLabelSha(PRO_TERMS_ACCEPTANCE_MESSAGE, PRO_SUBMIT_MESSAGE),
  });
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
      plan: 'integrator',
      legal: 'integrator_monthly',
      terms: INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE,
      submit: INTEGRATOR_MONTHLY_SUBMIT_MESSAGE,
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
      legal: 'integrator_annual',
      terms: INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE,
      submit: INTEGRATOR_ANNUAL_SUBMIT_MESSAGE,
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
      legal: 'integrator_annual',
      terms: INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE,
      submit: INTEGRATOR_ANNUAL_SUBMIT_MESSAGE,
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
  ];

  const seen = [];
  for (const entry of cases) {
    const legal = entry.legal || entry.plan;
    const terms = entry.terms || (entry.plan === 'pro' ? PRO_TERMS_ACCEPTANCE_MESSAGE : STARTER_TERMS_ACCEPTANCE_MESSAGE);
    const submit = entry.submit || (entry.plan === 'pro' ? PRO_SUBMIT_MESSAGE : STARTER_SUBMIT_MESSAGE);
    const result = withCheckoutPolicy(entry.params, { plan: entry.plan, env: {} });
    const sha = tosLabelSha(terms, submit);
    assert.equal(result[entry.slot].description, entry.description);
    assert.deepEqual(result[entry.slot].metadata, {
      ...entry.params[entry.slot].metadata,
      plan: legal,
      terms_version: CHECKOUT_TOS_VERSION,
      tos_label_sha: sha,
    });
    assert.deepEqual(result.metadata, {
      ...entry.params.metadata,
      plan: legal,
      terms_version: CHECKOUT_TOS_VERSION,
      tos_label_sha: sha,
    });
    assert.deepEqual(result.line_items, entry.params.line_items);
    assert.equal(result.success_url, entry.params.success_url);
    seen.push(...customerCopy(result));
  }
  assert.throws(
    () => withCheckoutPolicy({
      ...checkoutParams('pro', env),
      metadata: { plan: 'pro', interval: 'year' },
      subscription_data: { metadata: { plan: 'pro', interval: 'year' } },
    }, { plan: 'pro', env: {} }),
    (err) => err.status === 400 && err.message === 'plan_unavailable',
  );
  assert.throws(
    () => withCheckoutPolicy({
      mode: 'payment',
      metadata: { plan: 'integrator_overage' },
      payment_intent_data: { metadata: { plan: 'integrator_overage' } },
    }, { plan: 'integrator_overage', env: {} }),
    (err) => err.status === 400 && err.message === 'plan_unavailable',
  );

  seen.push(
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
  const result = withCheckoutPolicy(starter, { plan: 'starter', env: {} });
  assert.equal(result.customer_creation, 'always');
  assert.equal(result.payment_intent_data.transfer_group, 'grp_starter');
  assert.equal(result.payment_intent_data.description, STARTER_DESCRIPTION);
  assert.deepEqual(result.payment_intent_data.metadata, {
    plan: 'starter',
    brand: 'manualos',
    manuals_used: '0',
    credit_hold: 'hold_1',
    terms_version: CHECKOUT_TOS_VERSION,
    tos_label_sha: tosLabelSha(STARTER_TERMS_ACCEPTANCE_MESSAGE, STARTER_SUBMIT_MESSAGE),
  });
  assert.equal(result.custom_text.submit.extra, 'keep');
  assert.equal(result.custom_text.submit.message, STARTER_SUBMIT_MESSAGE);
  assert.equal(result.custom_text.terms_of_service_acceptance.message, STARTER_TERMS_ACCEPTANCE_MESSAGE);
  assert.deepEqual(result.custom_text.shipping_address, { message: 'Ship to the plant.' });
  assert.equal(result.consent_collection.terms_of_service, 'required');

  const pro = checkoutParams('pro', env);
  pro.subscription_data.description = 'replace me';
  pro.subscription_data.trial_period_days = 0;
  pro.consent_collection = { promotions: 'auto' };
  const off = withCheckoutPolicy(pro, { plan: 'pro', env: {} });
  assert.equal(off.subscription_data.description, PRO_MONTHLY);
  assert.equal(off.subscription_data.trial_period_days, 0);
  assert.deepEqual(off.subscription_data.metadata, {
    plan: 'pro',
    brand: 'manualos',
    terms_version: CHECKOUT_TOS_VERSION,
    tos_label_sha: tosLabelSha(PRO_TERMS_ACCEPTANCE_MESSAGE, PRO_SUBMIT_MESSAGE),
  });
  assert.equal(off.custom_text.submit.message, PRO_SUBMIT_MESSAGE);
  assert.deepEqual(off.consent_collection, { promotions: 'auto', terms_of_service: 'required' });

  const on = withCheckoutPolicy(pro, { plan: 'pro', env: { CHECKOUT_REQUIRE_TOS: '1' } });
  assert.deepEqual(on.consent_collection, { promotions: 'auto', terms_of_service: 'required' });
  assert.deepEqual(pro.consent_collection, { promotions: 'auto' });
});

test('every approved plan requires terms consent, and the kill switch fails closed', () => {
  for (const plan of ['starter', 'pro']) {
    for (const flag of [undefined, '', 'true', 'yes', '01', '1', ' 1 ', '1\n']) {
      const result = withCheckoutPolicy(checkoutParams(plan, env), { plan, env: { CHECKOUT_REQUIRE_TOS: flag } });
      assert.equal(result.consent_collection.terms_of_service, 'required', `${plan} ${String(flag)}`);
    }
    assert.throws(
      () => withCheckoutPolicy(checkoutParams(plan, env), { plan, env: { CHECKOUT_REQUIRE_TOS: '0' } }),
      (err) => err.status === 503 && err.message === 'Checkout is temporarily unavailable.',
    );
  }
  const integrator = {
    mode: 'subscription',
    line_items: [{ price: 'price_int', quantity: 1 }],
    metadata: { plan: 'integrator' },
    subscription_data: { metadata: { plan: 'integrator' } },
  };
  const month = withCheckoutPolicy(integrator, { plan: 'integrator', env: {} });
  assert.equal(month.consent_collection.terms_of_service, 'required');
  assert.equal(month.custom_text.submit.message, INTEGRATOR_MONTHLY_SUBMIT_MESSAGE);
  assert.equal(month.custom_text.terms_of_service_acceptance.message, INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE);
  for (const mode of ['off', 'OFF', ' Off ']) {
    assert.throws(
      () => withCheckoutPolicy(checkoutParams('starter', env), { plan: 'starter', env: { CHECKOUT_TOS_MODE: mode } }),
      (err) => err.status === 503 && err.message === 'Checkout is temporarily unavailable.',
      mode,
    );
  }
  assert.throws(
    () => withCheckoutPolicy(checkoutParams('pro', env), {
      plan: 'pro',
      env: { CHECKOUT_TOS_MODE: 'stripe', CHECKOUT_REQUIRE_TOS: '0' },
    }),
    (err) => err.status === 503 && err.message === 'Checkout is temporarily unavailable.',
  );
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
      plan === 'pro' ? PRO_SUBMIT_MESSAGE : STARTER_SUBMIT_MESSAGE,
    );
    assert.equal(
      policyThenAttribution.custom_text.terms_of_service_acceptance.message,
      plan === 'pro' ? PRO_TERMS_ACCEPTANCE_MESSAGE : STARTER_TERMS_ACCEPTANCE_MESSAGE,
    );
    assert.equal(policyThenAttribution.consent_collection.terms_of_service, 'required');
    assert.deepEqual(policyThenAttribution.line_items, base.line_items);
    assert.equal(policyThenAttribution.success_url, base.success_url);
    if (plan === 'starter') {
      assert.equal(policyThenAttribution.payment_intent_data.metadata.manuals_used, '0');
      assert.equal(policyThenAttribution.payment_intent_data.metadata.plan, 'starter');
      assert.equal(policyThenAttribution.payment_intent_data.metadata.terms_version, CHECKOUT_TOS_VERSION);
      assert.equal(
        policyThenAttribution.payment_intent_data.metadata.tos_label_sha,
        tosLabelSha(STARTER_TERMS_ACCEPTANCE_MESSAGE, STARTER_SUBMIT_MESSAGE),
      );
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
      legal: 'integrator_monthly',
      source: integratorCheckout('month'),
      slot: 'subscription_data',
      description: INTEGRATOR_MONTHLY,
      terms: INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE,
      message: INTEGRATOR_MONTHLY_SUBMIT_MESSAGE,
    },
    {
      plan: 'integrator_annual',
      legal: 'integrator_annual',
      source: integratorCheckout('year'),
      slot: 'subscription_data',
      description: INTEGRATOR_YEARLY,
      terms: INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE,
      message: INTEGRATOR_ANNUAL_SUBMIT_MESSAGE,
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
    const sha = tosLabelSha(entry.terms, entry.message);
    const result = withCheckoutPolicy(entry.source, { plan: entry.plan, env });
    const expected = structuredClone(entry.source);
    expected.billing_address_collection = 'required';
    expected.custom_text = {
      submit: { message: entry.message },
      terms_of_service_acceptance: { message: entry.terms },
    };
    expected.consent_collection = { terms_of_service: 'required' };
    expected.metadata = {
      ...expected.metadata,
      plan: entry.legal,
      terms_version: CHECKOUT_TOS_VERSION,
      tos_label_sha: sha,
    };
    expected[entry.slot] = {
      ...expected[entry.slot],
      description: entry.description,
      metadata: {
        ...expected[entry.slot].metadata,
        plan: entry.legal,
        terms_version: CHECKOUT_TOS_VERSION,
        tos_label_sha: sha,
      },
    };
    assert.deepEqual(result, expected);
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
    assert.equal(composed.metadata.plan, entry.legal);
    assert.equal(composed.metadata.terms_version, CHECKOUT_TOS_VERSION);
    assert.equal(composed.metadata.tos_label_sha, sha);
    assert.deepEqual(composed.line_items, entry.source.line_items);
    assert.equal(composed.success_url, entry.source.success_url);
    assert.equal(composed.cancel_url, entry.source.cancel_url);
    assert.equal(composed.integration_identifier, entry.source.integration_identifier);
    assert.equal(composed.client_reference_id, entry.source.client_reference_id);
    assert.equal(composed.customer, entry.source.customer);
    assert.equal(composed[entry.slot].description, entry.description);
    assert.deepEqual(composed[entry.slot].metadata, {
      ...entry.source[entry.slot].metadata,
      ...attribution,
      plan: entry.legal,
      terms_version: CHECKOUT_TOS_VERSION,
      tos_label_sha: sha,
    });
  }
  assert.throws(
    () => withCheckoutPolicy(overageCheckout(), { plan: 'integrator_overage', env }),
    (err) => err.status === 400 && err.message === 'plan_unavailable',
  );
});

test('create-checkout-session sends the policy and does not call Stripe for a bad plan', async () => {
  const calls = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          return { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' };
        },
      },
    },
  };
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
    for (const plan of ['enterprise', 'pro_annual', 'pro_yearly', 'integrator', 'integrator_annual', 'integrator_overage']) {
      const bad = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      assert.equal(bad.status, 400, plan);
      assert.deepEqual(await bad.json(), { error: 'plan_unavailable' });
    }
    assert.equal(calls.length, 0);

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
    assert.deepEqual(calls[0], withCheckoutPolicy(checkoutParams('starter', appEnv), { plan: 'starter', env: appEnv }));
    assert.deepEqual(calls[1], withCheckoutPolicy(checkoutParams('pro', appEnv), { plan: 'pro', env: appEnv }));
    assert.equal(calls[0].consent_collection.terms_of_service, 'required');
    assert.equal(calls[1].consent_collection.terms_of_service, 'required');
    assert.equal(calls[0].custom_text.terms_of_service_acceptance.message, STARTER_TERMS_ACCEPTANCE_MESSAGE);
    assert.equal(calls[1].custom_text.terms_of_service_acceptance.message, PRO_TERMS_ACCEPTANCE_MESSAGE);
    assert.equal(calls[0].custom_text.submit.message, STARTER_SUBMIT_MESSAGE);
    assert.equal(calls[1].custom_text.submit.message, PRO_SUBMIT_MESSAGE);
    assert.equal(calls[0].metadata.plan, 'starter');
    assert.equal(calls[0].metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[0].metadata.tos_label_sha, tosLabelSha(STARTER_TERMS_ACCEPTANCE_MESSAGE, STARTER_SUBMIT_MESSAGE));
    assert.equal(calls[0].payment_intent_data.metadata.plan, 'starter');
    assert.equal(calls[0].payment_intent_data.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[0].payment_intent_data.metadata.tos_label_sha, calls[0].metadata.tos_label_sha);
    assert.equal(calls[1].metadata.plan, 'pro');
    assert.equal(calls[1].metadata.tos_label_sha, tosLabelSha(PRO_TERMS_ACCEPTANCE_MESSAGE, PRO_SUBMIT_MESSAGE));
    assert.equal(calls[1].subscription_data.metadata.plan, 'pro');
    assert.equal(calls[1].subscription_data.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[1].subscription_data.metadata.tos_label_sha, calls[1].metadata.tos_label_sha);
    for (const params of calls) {
      for (const text of customerCopy(params)) assert.equal(AI_WORD.test(text), false);
    }

    const tosCalls = [];
    const tosEnv = { ...appEnv, CHECKOUT_REQUIRE_TOS: '1' };
    const tosApp = createApp({
      env: tosEnv,
      stripe: {
        checkout: {
          sessions: {
            create: async (params) => {
              tosCalls.push(params);
              return { id: 'cs_tos', url: 'https://checkout.stripe.com/c/pay/cs_tos' };
            },
          },
        },
      },
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

      const blockedCalls = [];
      const blockedApp = createApp({
        env: { ...appEnv, CHECKOUT_TOS_MODE: 'off', CHECKOUT_REQUIRE_TOS: '0' },
        stripe: {
          checkout: {
            sessions: {
              create: async (params) => {
                blockedCalls.push(params);
                return { id: 'cs_blocked', url: 'https://checkout.stripe.com/c/pay/cs_blocked' };
              },
            },
          },
        },
        anthropic: { messages: { create: async () => { throw new Error('model unused'); } } },
      });
      const blockedServer = blockedApp.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => {
        blockedServer.once('listening', resolve);
        blockedServer.once('error', reject);
      });
      try {
        const blockedBase = `http://127.0.0.1:${blockedServer.address().port}`;
        const blocked = await fetch(blockedBase + '/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 'pro' }),
        });
        assert.equal(blocked.status, 503);
        assert.deepEqual(await blocked.json(), { error: 'Checkout is temporarily unavailable.' });
        assert.equal(blockedCalls.length, 0);
      } finally {
        await new Promise((resolve) => blockedServer.close(resolve));
      }
    } finally {
      await new Promise((resolve) => tosServer.close(resolve));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
