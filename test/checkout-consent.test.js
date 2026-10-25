const test = require('node:test');
const assert = require('node:assert/strict');
const { checkoutParams } = require('../lib/billing');
const { withCheckoutPolicy } = require('../lib/checkoutPolicy');
const { applyCheckoutConsent } = require('../lib/checkout-consent');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');

const FIXED = Date.parse('2026-10-25T12:00:00.000Z');
const AT = '2026-10-25T12:00:00.000Z';

const env = {
  FRONTEND_URL: 'https://manualos.com',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  STARTER_CREDITS: '3',
};

function proRequest(extra = {}) {
  return {
    plan: 'pro',
    termsAccepted: true,
    renewalConsent: true,
    termsVersion: 'terms-2026-10-25',
    disclosureVersion: 'disclosure-2026-10-25',
    ...extra,
  };
}

function starterRequest(extra = {}) {
  return {
    plan: 'starter',
    termsAccepted: true,
    termsVersion: 'terms-2026-10-25',
    ...extra,
  };
}

test.after(() => {
  removeTestJobDirectories();
});

test('starter requires Terms consent and does not record a renewal', () => {
  const source = checkoutParams('starter', env);
  const snapshot = structuredClone(source);
  assert.throws(
    () => applyCheckoutConsent(source, { plan: 'starter' }, { now: FIXED }),
    (err) => err.status === 400 && err.expose === true && err.message === 'Terms acceptance is required.',
  );
  assert.throws(
    () => applyCheckoutConsent(source, { plan: 'starter', termsAccepted: 'true', termsVersion: 'terms-1' }, { now: FIXED }),
    (err) => err.status === 400 && err.message === 'Terms acceptance is required.',
  );
  assert.throws(
    () => applyCheckoutConsent(source, { plan: 'starter', termsAccepted: true, termsVersion: '   ' }, { now: FIXED }),
    (err) => err.status === 400 && err.message === 'termsVersion is required.',
  );

  const result = applyCheckoutConsent(source, starterRequest({
    renewalConsent: true,
    disclosureVersion: 'disclosure-ignored',
  }), { now: FIXED });
  assert.deepEqual(source, snapshot);
  assert.equal(result.metadata.plan, 'starter');
  assert.equal(result.metadata.terms_version, 'terms-2026-10-25');
  assert.equal(result.metadata.terms_consent_at, AT);
  assert.equal(Object.hasOwn(result.metadata, 'renewal_consent_at'), false);
  assert.equal(Object.hasOwn(result.metadata, 'disclosure_version'), false);
  assert.equal(Object.hasOwn(result.metadata, 'consent_ip'), false);
  assert.equal(result.payment_intent_data.metadata.manuals_used, '0');
  assert.equal(result.payment_intent_data.metadata.terms_version, undefined);
  assert.equal(result.subscription_data, undefined);
  assert.equal(Object.hasOwn(result, 'consent_collection'), false);
  assert.equal(Object.hasOwn(result, 'custom_text'), false);
});

test('pro and integrator subscriptions require renewal consent and store it on both metadata objects', () => {
  const source = checkoutParams('pro', env);
  const snapshot = structuredClone(source);
  assert.throws(
    () => applyCheckoutConsent(source, starterRequest({ plan: 'pro' }), { now: FIXED }),
    (err) => err.status === 400 && err.message === 'Auto-renewal consent is required.',
  );
  assert.throws(
    () => applyCheckoutConsent(source, proRequest({ disclosureVersion: '' }), { now: FIXED }),
    (err) => err.status === 400 && err.message === 'disclosureVersion is required.',
  );
  assert.throws(
    () => applyCheckoutConsent(source, proRequest({ termsAccepted: false }), { now: FIXED }),
    (err) => err.status === 400 && err.message === 'Terms acceptance is required.',
  );

  const result = applyCheckoutConsent(source, proRequest({ termsVersion: '  terms-2026-10-25  ' }), {
    now: FIXED,
    ip: ' 198.51.100.40 ',
  });
  assert.deepEqual(source, snapshot);
  assert.equal(result.metadata.plan, 'pro');
  assert.equal(result.metadata.terms_version, 'terms-2026-10-25');
  assert.equal(result.metadata.disclosure_version, 'disclosure-2026-10-25');
  assert.equal(result.metadata.renewal_consent_at, AT);
  assert.equal(result.metadata.consent_ip, '198.51.100.40');
  assert.equal(Object.hasOwn(result.metadata, 'terms_consent_at'), false);
  assert.equal(result.subscription_data.metadata.plan, 'pro');
  assert.equal(result.subscription_data.metadata.terms_version, 'terms-2026-10-25');
  assert.equal(result.subscription_data.metadata.disclosure_version, 'disclosure-2026-10-25');
  assert.equal(result.subscription_data.metadata.renewal_consent_at, AT);
  assert.equal(result.subscription_data.metadata.consent_ip, '198.51.100.40');
  assert.equal(Object.hasOwn(source.subscription_data.metadata, 'terms_version'), false);

  const priced = withCheckoutPolicy(checkoutParams('pro', env), { plan: 'pro', env });
  const wrapped = applyCheckoutConsent(priced, proRequest(), { now: FIXED, ip: '198.51.100.40' });
  assert.equal(wrapped.billing_address_collection, 'required');
  assert.equal(wrapped.custom_text.submit.message, priced.custom_text.submit.message);
  assert.equal(wrapped.consent_collection, undefined);
  assert.equal(wrapped.subscription_data.description, priced.subscription_data.description);
  assert.equal(Object.hasOwn(wrapped, 'consent_collection'), false);

  const bare = {
    mode: 'subscription',
    metadata: { plan: 'integrator' },
    subscription_data: { description: 'keep me', metadata: { plan: 'integrator', manuals_used: '0' } },
  };
  assert.throws(
    () => applyCheckoutConsent(bare, { termsAccepted: true, termsVersion: 'terms-1' }, { now: FIXED }),
    (err) => err.message === 'Auto-renewal consent is required.',
  );
  const integrator = applyCheckoutConsent(bare, {
    termsAccepted: true,
    renewalConsent: true,
    termsVersion: 'terms-1',
    disclosureVersion: 'disclosure-1',
  }, { now: FIXED, ip: '203.0.113.10' });
  assert.equal(Object.hasOwn(integrator, 'custom_text'), false);
  assert.equal(Object.hasOwn(integrator, 'consent_collection'), false);
  assert.equal(integrator.subscription_data.description, 'keep me');
  assert.equal(integrator.subscription_data.metadata.manuals_used, '0');
  assert.equal(integrator.subscription_data.metadata.plan, 'integrator');
  assert.equal(integrator.subscription_data.metadata.renewal_consent_at, AT);
  assert.equal(integrator.metadata.disclosure_version, 'disclosure-1');
  assert.equal(integrator.metadata.consent_ip, '203.0.113.10');

  const overage = applyCheckoutConsent({
    mode: 'payment',
    metadata: { plan: 'integrator_overage' },
    payment_intent_data: { metadata: { plan: 'integrator_overage' } },
  }, { termsAccepted: true, termsVersion: 'terms-1' }, { now: FIXED });
  assert.equal(overage.metadata.terms_version, 'terms-1');
  assert.equal(overage.metadata.terms_consent_at, AT);
  assert.equal(Object.hasOwn(overage.metadata, 'renewal_consent_at'), false);
  assert.equal(overage.subscription_data, undefined);
  assert.equal(overage.payment_intent_data.metadata.plan, 'integrator_overage');
});

test('checkout rejects missing consent and records present consent without Stripe consent fields', async () => {
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
  const app = createApp({
    env: {
      NODE_ENV: 'test',
      ...env,
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
    },
    stripe,
    anthropic: { messages: { create: async () => { throw new Error('model unused'); } } },
    now: () => FIXED,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.9, 198.51.100.40',
    };
    async function post(body) {
      return fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }

    const missingPro = await post({ plan: 'pro' });
    assert.equal(missingPro.status, 400);
    assert.equal((await missingPro.json()).error, 'Terms acceptance is required.');
    const renewalOnly = await post({
      plan: 'pro',
      renewalConsent: true,
      disclosureVersion: 'disclosure-2026-10-25',
      termsVersion: 'terms-2026-10-25',
    });
    assert.equal(renewalOnly.status, 400);
    assert.equal((await renewalOnly.json()).error, 'Terms acceptance is required.');
    const termsOnly = await post({
      plan: 'pro',
      termsAccepted: true,
      termsVersion: 'terms-2026-10-25',
    });
    assert.equal(termsOnly.status, 400);
    assert.equal((await termsOnly.json()).error, 'Auto-renewal consent is required.');
    const missingDisclosure = await post({
      plan: 'pro',
      termsAccepted: true,
      renewalConsent: true,
      termsVersion: 'terms-2026-10-25',
    });
    assert.equal(missingDisclosure.status, 400);
    assert.equal((await missingDisclosure.json()).error, 'disclosureVersion is required.');
    const missingStarter = await post({ plan: 'starter', renewalConsent: true, disclosureVersion: 'disclosure-2026-10-25' });
    assert.equal(missingStarter.status, 400);
    assert.equal((await missingStarter.json()).error, 'Terms acceptance is required.');
    assert.equal(calls.length, 0);

    const starter = await post(starterRequest());
    assert.equal(starter.status, 200);
    assert.deepEqual(Object.keys(await starter.json()), ['url']);
    assert.equal(calls[0].mode, 'payment');
    assert.equal(calls[0].metadata.plan, 'starter');
    assert.equal(calls[0].metadata.terms_version, 'terms-2026-10-25');
    assert.equal(calls[0].metadata.terms_consent_at, AT);
    assert.equal(calls[0].metadata.consent_ip, '198.51.100.40');
    assert.equal(Object.hasOwn(calls[0].metadata, 'renewal_consent_at'), false);
    assert.equal(Object.hasOwn(calls[0].metadata, 'disclosure_version'), false);
    assert.equal(calls[0].consent_collection, undefined);
    assert.equal(calls[0].billing_address_collection, 'required');
    assert.match(calls[0].custom_text.submit.message, /Refundable until your first manual/);
    assert.equal(calls[0].custom_text.submit.message.includes('Cancel anytime.'), false);

    const pro = await post(proRequest());
    assert.equal(pro.status, 200);
    const proParams = calls[1];
    assert.equal(proParams.mode, 'subscription');
    assert.equal(proParams.metadata.plan, 'pro');
    assert.equal(proParams.metadata.terms_version, 'terms-2026-10-25');
    assert.equal(proParams.metadata.disclosure_version, 'disclosure-2026-10-25');
    assert.equal(proParams.metadata.renewal_consent_at, AT);
    assert.equal(proParams.metadata.consent_ip, '198.51.100.40');
    assert.equal(proParams.subscription_data.metadata.plan, 'pro');
    assert.equal(proParams.subscription_data.metadata.terms_version, 'terms-2026-10-25');
    assert.equal(proParams.subscription_data.metadata.disclosure_version, 'disclosure-2026-10-25');
    assert.equal(proParams.subscription_data.metadata.renewal_consent_at, AT);
    assert.equal(proParams.subscription_data.metadata.consent_ip, '198.51.100.40');
    assert.equal(proParams.consent_collection, undefined);
    assert.equal(proParams.billing_address_collection, 'required');
    assert.match(proParams.custom_text.submit.message, /Cancel anytime\.$/);
    assert.equal(proParams.subscription_data.description, 'ManualOS Pro: unlimited manuals, billed monthly');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
