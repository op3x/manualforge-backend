const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkoutParams } = require('../lib/billing');
const { withCheckoutPolicy } = require('../lib/checkoutPolicy');
const { applyCheckoutConsent } = require('../lib/checkout-consent');
const {
  PRO_SUBMIT_MESSAGE,
  PRO_TERMS_ACCEPTANCE_MESSAGE,
  STARTER_SUBMIT_MESSAGE,
  STARTER_TERMS_ACCEPTANCE_MESSAGE,
} = require('../lib/checkoutLabels');
const { createCheckoutTosStore, maskCheckoutSessionId } = require('../lib/checkout-tos');
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

function enforced(extra = {}) {
  return { now: FIXED, env: { CHECKOUT_REQUIRE_CONSENT: '1' }, ...extra };
}

test('starter requires Terms consent and does not record a renewal', () => {
  const source = checkoutParams('starter', env);
  const snapshot = structuredClone(source);
  assert.equal(applyCheckoutConsent(source, { plan: 'starter' }, { now: FIXED }), source);
  assert.throws(
    () => applyCheckoutConsent(source, { plan: 'starter' }, enforced()),
    (err) => err.status === 400 && err.expose === true && err.message === 'Terms acceptance is required.',
  );
  assert.throws(
    () => applyCheckoutConsent(source, { plan: 'starter', termsAccepted: 'true', termsVersion: 'terms-1' }, enforced()),
    (err) => err.status === 400 && err.message === 'Terms acceptance is required.',
  );
  assert.throws(
    () => applyCheckoutConsent(source, { plan: 'starter', termsAccepted: true, termsVersion: '   ' }, enforced()),
    (err) => err.status === 400 && err.message === 'termsVersion is required.',
  );

  const result = applyCheckoutConsent(source, starterRequest({
    renewalConsent: true,
    disclosureVersion: 'disclosure-ignored',
  }), { now: FIXED, ip: '198.51.100.40' });
  assert.deepEqual(source, snapshot);
  assert.equal(result.metadata.plan, 'starter');
  assert.equal(result.metadata.terms_version, 'terms-2026-10-25');
  assert.equal(result.metadata.terms_consent_at, AT);
  assert.equal(result.metadata.consent_ip, '198.51.100.40');
  assert.equal(Object.hasOwn(result.metadata, 'renewal_consent_at'), false);
  assert.equal(Object.hasOwn(result.metadata, 'disclosure_version'), false);
  assert.equal(result.payment_intent_data.metadata.manuals_used, '0');
  assert.equal(result.payment_intent_data.metadata.plan, 'starter');
  assert.equal(result.payment_intent_data.metadata.terms_version, 'terms-2026-10-25');
  assert.equal(result.payment_intent_data.metadata.terms_consent_at, AT);
  assert.equal(result.payment_intent_data.metadata.consent_ip, '198.51.100.40');
  assert.equal(Object.hasOwn(result.payment_intent_data.metadata, 'renewal_consent_at'), false);
  assert.equal(Object.hasOwn(result.payment_intent_data.metadata, 'disclosure_version'), false);
  assert.equal(result.subscription_data, undefined);
  assert.equal(Object.hasOwn(result, 'consent_collection'), false);
  assert.equal(Object.hasOwn(result, 'custom_text'), false);
});

test('pro and integrator subscriptions require renewal consent and store it on both metadata objects', () => {
  const source = checkoutParams('pro', env);
  const snapshot = structuredClone(source);
  assert.equal(applyCheckoutConsent(source, starterRequest({ plan: 'pro' }), { now: FIXED }), source);
  assert.throws(
    () => applyCheckoutConsent(source, starterRequest({ plan: 'pro' }), enforced()),
    (err) => err.status === 400 && err.message === 'Auto-renewal consent is required.',
  );
  assert.throws(
    () => applyCheckoutConsent(source, proRequest({ disclosureVersion: '' }), enforced()),
    (err) => err.status === 400 && err.message === 'disclosureVersion is required.',
  );
  assert.throws(
    () => applyCheckoutConsent(source, proRequest({ termsAccepted: false }), enforced()),
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
  assert.equal(result.payment_intent_data, undefined);

  const priced = withCheckoutPolicy(checkoutParams('pro', env), { plan: 'pro', env });
  const wrapped = applyCheckoutConsent(priced, proRequest(), { now: FIXED, ip: '198.51.100.40' });
  assert.equal(wrapped.billing_address_collection, 'required');
  assert.equal(wrapped.custom_text.submit.message, priced.custom_text.submit.message);
  assert.equal(wrapped.custom_text.submit.message, PRO_SUBMIT_MESSAGE);
  assert.equal(wrapped.consent_collection.terms_of_service, 'required');
  assert.equal(wrapped.metadata.terms_version, 'checkout-tos-v2');
  assert.equal(wrapped.metadata.site_terms_version, 'terms-2026-10-25');
  assert.equal(wrapped.subscription_data.metadata.terms_version, 'checkout-tos-v2');
  assert.equal(wrapped.subscription_data.metadata.site_terms_version, 'terms-2026-10-25');
  assert.equal(wrapped.subscription_data.metadata.tos_label_sha, priced.metadata.tos_label_sha);
  assert.equal(wrapped.subscription_data.description, priced.subscription_data.description);

  const bare = {
    mode: 'subscription',
    metadata: { plan: 'integrator' },
    subscription_data: { description: 'keep me', metadata: { plan: 'integrator', manuals_used: '0' } },
  };
  assert.equal(applyCheckoutConsent(bare, { termsAccepted: true, termsVersion: 'terms-1' }, { now: FIXED }), bare);
  assert.throws(
    () => applyCheckoutConsent(bare, { termsAccepted: true, termsVersion: 'terms-1' }, enforced()),
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
  assert.equal(overage.payment_intent_data.metadata.terms_version, 'terms-1');
  assert.equal(overage.payment_intent_data.metadata.terms_consent_at, AT);
  assert.equal(Object.hasOwn(overage.payment_intent_data.metadata, 'renewal_consent_at'), false);
});

test('checkout rejects missing website consent and keeps checkout-tos-v2 on the Stripe session', async () => {
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
      CHECKOUT_REQUIRE_CONSENT: '1',
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
    assert.equal(calls[0].metadata.brand, 'manualos');
    assert.equal(calls[0].metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[0].metadata.site_terms_version, 'terms-2026-10-25');
    assert.equal(calls[0].metadata.terms_consent_at, AT);
    assert.equal(calls[0].metadata.consent_ip, '198.51.100.40');
    assert.equal(Object.hasOwn(calls[0].metadata, 'renewal_consent_at'), false);
    assert.equal(Object.hasOwn(calls[0].metadata, 'disclosure_version'), false);
    assert.equal(calls[0].payment_intent_data.metadata.manuals_used, '0');
    assert.equal(calls[0].payment_intent_data.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[0].payment_intent_data.metadata.site_terms_version, 'terms-2026-10-25');
    assert.equal(calls[0].payment_intent_data.metadata.terms_consent_at, AT);
    assert.equal(calls[0].payment_intent_data.metadata.consent_ip, '198.51.100.40');
    assert.equal(calls[0].payment_intent_data.metadata.brand, 'manualos');
    assert.equal(Object.hasOwn(calls[0].payment_intent_data.metadata, 'renewal_consent_at'), false);
    assert.equal(calls[0].consent_collection.terms_of_service, 'required');
    assert.equal(calls[0].custom_text.terms_of_service_acceptance.message, STARTER_TERMS_ACCEPTANCE_MESSAGE);
    assert.equal(calls[0].custom_text.submit.message, STARTER_SUBMIT_MESSAGE);
    assert.equal(calls[0].custom_text.submit.message.includes('Refundable until your first manual'), false);
    assert.equal(calls[0].billing_address_collection, 'required');

    const pro = await post(proRequest());
    assert.equal(pro.status, 200);
    const proParams = calls[1];
    assert.equal(proParams.mode, 'subscription');
    assert.equal(proParams.metadata.plan, 'pro');
    assert.equal(proParams.metadata.brand, 'manualos');
    assert.equal(proParams.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(proParams.metadata.site_terms_version, 'terms-2026-10-25');
    assert.equal(proParams.metadata.disclosure_version, 'disclosure-2026-10-25');
    assert.equal(proParams.metadata.renewal_consent_at, AT);
    assert.equal(proParams.metadata.consent_ip, '198.51.100.40');
    assert.equal(proParams.subscription_data.metadata.plan, 'pro');
    assert.equal(proParams.subscription_data.metadata.brand, 'manualos');
    assert.equal(proParams.subscription_data.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(proParams.subscription_data.metadata.site_terms_version, 'terms-2026-10-25');
    assert.equal(proParams.subscription_data.metadata.disclosure_version, 'disclosure-2026-10-25');
    assert.equal(proParams.subscription_data.metadata.renewal_consent_at, AT);
    assert.equal(proParams.subscription_data.metadata.consent_ip, '198.51.100.40');
    assert.equal(proParams.consent_collection.terms_of_service, 'required');
    assert.equal(proParams.custom_text.terms_of_service_acceptance.message, PRO_TERMS_ACCEPTANCE_MESSAGE);
    assert.equal(proParams.custom_text.submit.message, PRO_SUBMIT_MESSAGE);
    assert.equal(proParams.custom_text.submit.message.includes('Refundable until your first manual'), false);
    assert.equal(proParams.billing_address_collection, 'required');
    assert.equal(proParams.subscription_data.description, 'ManualOS Pro: unlimited manuals, billed monthly');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('missing consent is allowed until CHECKOUT_REQUIRE_CONSENT is 1, and present consent is still stored', async () => {
  const calls = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          return { id: 'cs_test_open', url: 'https://checkout.stripe.com/c/pay/cs_test_open' };
        },
      },
    },
  };
  const app = createApp({
    env: { NODE_ENV: 'test', ...env, STRIPE_WEBHOOK_SECRET: 'whsec_test' },
    stripe,
    anthropic: null,
    now: () => FIXED,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    async function post(body) {
      return fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    const missing = await post({ plan: 'pro' });
    assert.equal(missing.status, 200);
    assert.equal(calls[0].metadata.brand, 'manualos');
    assert.equal(calls[0].subscription_data.metadata.brand, 'manualos');
    assert.equal(calls[0].metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[0].subscription_data.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(Object.hasOwn(calls[0].metadata, 'site_terms_version'), false);
    assert.equal(Object.hasOwn(calls[0].metadata, 'renewal_consent_at'), false);
    assert.equal(Object.hasOwn(calls[0].subscription_data.metadata, 'renewal_consent_at'), false);

    const partial = await post({ plan: 'pro', termsAccepted: true });
    assert.equal(partial.status, 200);
    assert.equal(calls[1].metadata.terms_version, 'checkout-tos-v2');
    assert.equal(Object.hasOwn(calls[1].metadata, 'site_terms_version'), false);

    const present = await post(proRequest());
    assert.equal(present.status, 200);
    assert.equal(calls[2].metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[2].metadata.site_terms_version, 'terms-2026-10-25');
    assert.equal(calls[2].subscription_data.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[2].subscription_data.metadata.site_terms_version, 'terms-2026-10-25');
    assert.equal(calls[2].metadata.disclosure_version, 'disclosure-2026-10-25');
    assert.equal(calls[2].metadata.renewal_consent_at, AT);
    assert.equal(calls[2].metadata.brand, 'manualos');
    assert.equal(calls[2].subscription_data.metadata.brand, 'manualos');
    assert.equal(calls[2].subscription_data.metadata.renewal_consent_at, AT);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const ACCEPTED_ID = 'cs_test_9f3a2c1b7e04';
const DENIED_ID = 'cs_test_d0e1f2a3b4c5';
const PAID_ID = 'cs_test_b19c0d4e8a77';
const BUYER_EMAIL = 'buyer@example.com';
const BUYER_NAME = 'Pat Buyer';
const EVENT_CREATED = 1761417600;
const LABEL_SHA = 'abc123def456';

const webhookEnv = {
  NODE_ENV: 'test',
  FRONTEND_URL: 'https://manualos.com/',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STARTER_CREDITS: '3',
  MANUALOS_LEGACY_GENERATE: '1',
};

function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

let consoleLock = Promise.resolve();

async function captureConsole(fn) {
  const previous = consoleLock;
  let release;
  consoleLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const lines = [];
  const log = console.log;
  const error = console.error;
  const warn = console.warn;
  const capture = (...args) => lines.push(args.map(String).join(' '));
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    await fn();
    return lines;
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
    release();
  }
}

function webhookStripe(extra = {}) {
  return {
    checkout: {
      sessions: {
        create: async (params) => {
          if (extra.calls) extra.calls.push(params);
          return { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' };
        },
        retrieve: async (id) => {
          if (id === PAID_ID) {
            return {
              id,
              metadata: { plan: 'starter', brand: 'manualos' },
              payment_status: 'paid',
              consent: { terms_of_service: 'accepted' },
              payment_intent: { id: 'pi_paid', metadata: { manuals_used: '0', plan: 'starter' } },
              subscription: null,
            };
          }
          if (id === DENIED_ID) {
            return {
              id,
              metadata: { plan: 'starter', brand: 'manualos' },
              payment_status: 'paid',
              consent_collection: { terms_of_service: 'required' },
              consent: null,
              payment_intent: { id: 'pi_denied', metadata: { manuals_used: '0', plan: 'starter' } },
              subscription: null,
            };
          }
          const err = new Error('No such checkout.session');
          err.statusCode = 404;
          err.code = 'resource_missing';
          throw err;
        },
      },
    },
    paymentIntents: {
      retrieve: async (id) => ({ id, metadata: { manuals_used: '0', plan: 'starter' } }),
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') throw new Error('bad signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
}

test('a posted website termsVersion is stored as site_terms_version and checkout-tos-v2 survives', async () => {
  const calls = [];
  const app = createApp({
    env: webhookEnv,
    stripe: webhookStripe({ calls }),
    anthropic: null,
  });
  const server = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: 'starter',
        termsAccepted: true,
        termsVersion: 'terms-rev-a-m2',
      }),
    });
    assert.equal(response.status, 200);
    const pro = await fetch(`http://127.0.0.1:${server.address().port}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: 'pro',
        termsAccepted: true,
        renewalConsent: true,
        termsVersion: 'terms-rev-a-m2',
        disclosureVersion: 'pro-renew-b2-direct',
      }),
    });
    assert.equal(pro.status, 200);
    assert.equal(calls[0].metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[0].metadata.site_terms_version, 'terms-rev-a-m2');
    assert.equal(calls[0].payment_intent_data.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[0].payment_intent_data.metadata.site_terms_version, 'terms-rev-a-m2');
    assert.equal(calls[1].metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[1].metadata.site_terms_version, 'terms-rev-a-m2');
    assert.equal(calls[1].subscription_data.metadata.terms_version, 'checkout-tos-v2');
    assert.equal(calls[1].subscription_data.metadata.site_terms_version, 'terms-rev-a-m2');
    assert.equal(calls[0].metadata.terms_version.includes('terms-rev-a-m2'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('masked checkout logs drop non-alphanumeric characters from the last 4', () => {
  assert.equal(maskCheckoutSessionId('cs_test_abcd12!@'), 'cs_…12');
  assert.equal(maskCheckoutSessionId('cs_test_9f3a2c1b7e04'), 'cs_…7e04');
  assert.equal(maskCheckoutSessionId('cs_test_abcd!!!!'), 'cs_…');
});

test('completed webhook records ManualOS terms and skips an HTS Atlas session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-tos-test-'));
  const consents = createCheckoutTosStore({ directory: dir });
  const calls = [];
  const app = createApp({
    env: { ...webhookEnv, CHECKOUT_REQUIRE_CONSENT: '1' },
    stripe: webhookStripe({ calls }),
    checkoutConsents: consents,
    anthropic: { messages: { create: async () => { throw new Error('model unused'); } } },
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    async function postEvent(event) {
      return fetch(base + '/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
        body: JSON.stringify(event),
      });
    }

    const oldLines = await captureConsole(async () => {
      const old = await postEvent({
        id: 'evt_old',
        type: 'checkout.session.completed',
        created: EVENT_CREATED,
        data: {
          object: {
            id: 'cs_test_01dflow000aa',
            metadata: { plan: 'starter', brand: 'manualos' },
            payment_status: 'paid',
            consent: null,
          },
        },
      });
      assert.equal(old.status, 200);
    });
    assert.equal(oldLines.join('\n').includes('access not granted'), false);
    assert.equal(consents.list().length, 0);

    const deniedLines = await captureConsole(async () => {
      const denied = await postEvent({
        id: 'evt_denied',
        type: 'checkout.session.completed',
        created: EVENT_CREATED,
        data: {
          object: {
            id: DENIED_ID,
            metadata: { plan: 'starter', brand: 'manualos' },
            payment_status: 'paid',
            consent_collection: { terms_of_service: 'required' },
            customer: 'cus_123',
            customer_email: BUYER_EMAIL,
            customer_details: { email: BUYER_EMAIL, name: BUYER_NAME },
          },
        },
      });
      assert.equal(denied.status, 200);
    });
    const deniedLog = deniedLines.join('\n');
    assert.equal(consents.list().length, 0);
    assert.match(deniedLog, /terms_of_service=missing session=cs_…b4c5; access not granted; left for support/);
    assert.equal(deniedLog.includes(DENIED_ID), false);
    assert.equal(deniedLog.includes(BUYER_EMAIL), false);

    const acceptedLines = await captureConsole(async () => {
      const accepted = await postEvent({
        id: 'evt_accepted',
        type: 'checkout.session.completed',
        created: EVENT_CREATED,
        data: {
          object: {
            id: ACCEPTED_ID,
            metadata: {
              plan: 'pro',
              brand: 'manualos',
              terms_version: 'checkout-tos-v2',
              tos_label_sha: LABEL_SHA,
            },
            payment_status: 'paid',
            consent: { terms_of_service: 'accepted' },
            customer_email: BUYER_EMAIL,
            customer_details: { email: BUYER_EMAIL, name: BUYER_NAME },
          },
        },
      });
      assert.equal(accepted.status, 200);
    });
    const rows = consents.list();
    assert.equal(rows.length, 1);
    const sessionIdHash = crypto.createHash('sha256').update(ACCEPTED_ID, 'utf8').digest('hex');
    assert.equal(rows[0].terms_version, 'checkout-tos-v2');
    assert.equal(rows[0].tos_label_sha, LABEL_SHA);
    assert.equal(rows[0].labelVersion, 'checkout-tos-v2');
    assert.equal(rows[0].plan, 'pro');
    assert.equal(rows[0].sessionIdHash, sessionIdHash);
    assert.equal(rows[0].sessionIdLast4, '7e04');
    assert.equal(rows[0].sessionId, undefined);
    const raw = fs.readFileSync(consents.filePath(), 'utf8');
    assert.equal(raw.includes(ACCEPTED_ID), false);
    assert.equal(raw.includes(BUYER_EMAIL), false);
    assert.match(acceptedLines.join('\n'), /terms_of_service=accepted session=cs_…7e04 plan=pro labelVersion=checkout-tos-v2/);

    const atlasLines = await captureConsole(async () => {
      const atlas = await postEvent({
        id: 'evt_atlas',
        type: 'checkout.session.completed',
        created: EVENT_CREATED,
        data: {
          object: {
            id: 'cs_test_htsatlas9911',
            metadata: { plan: 'starter', brand: 'htsatlas' },
            payment_status: 'paid',
            consent: { terms_of_service: 'accepted' },
            customer_email: 'atlas@example.com',
          },
        },
      });
      assert.equal(atlas.status, 200);
    });
    assert.equal(consents.list().length, 1);
    assert.equal(atlasLines.join('\n').includes('terms_of_service=accepted'), false);
    assert.equal(atlasLines.join('\n').includes('cs_test_htsatlas9911'), false);

    const paid = await fetch(`${base}/verify-session?session_id=${PAID_ID}`);
    assert.deepEqual(await paid.json(), { valid: true, plan: 'starter', remaining: 3, billingIssue: false });
    const blocked = await fetch(`${base}/verify-session?session_id=${DENIED_ID}`);
    assert.deepEqual(await blocked.json(), { valid: false, plan: 'starter', remaining: null, billingIssue: false });
    const generate = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': DENIED_ID },
      body: JSON.stringify({ plcContent: '<xml/>' }),
    });
    assert.equal(generate.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed consent write does not grant the webhook or leak the session id', async () => {
  const app = createApp({
    env: webhookEnv,
    stripe: webhookStripe(),
    checkoutConsents: {
      recordAccepted() {
        const err = new Error('disk full SUPER_SECRET_PATH');
        err.code = 'ENOSPC';
        throw err;
      },
    },
    anthropic: null,
  });
  const server = await listen(app);
  try {
    const lines = await captureConsole(async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
        body: JSON.stringify({
          id: 'evt_fail',
          type: 'checkout.session.completed',
          created: EVENT_CREATED,
          data: {
            object: {
              id: ACCEPTED_ID,
              metadata: { plan: 'starter', brand: 'manualos' },
              consent: { terms_of_service: 'accepted' },
              customer_email: BUYER_EMAIL,
            },
          },
        }),
      });
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error, 'Could not record checkout consent');
      assert.equal(JSON.stringify(body).includes(ACCEPTED_ID), false);
      assert.equal(JSON.stringify(body).includes('SUPER_SECRET_PATH'), false);
      assert.equal(JSON.stringify(body).includes(BUYER_EMAIL), false);
    });
    const log = lines.join('\n');
    assert.match(log, /checkout terms record failed cs_…7e04 ENOSPC/);
    assert.equal(log.includes(ACCEPTED_ID), false);
    assert.equal(log.includes('SUPER_SECRET_PATH'), false);
    assert.equal(log.includes(BUYER_EMAIL), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an unwritable consent directory does not crash startup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-tos-block-'));
  const blocker = path.join(dir, 'not-a-directory');
  fs.writeFileSync(blocker, 'file');
  const nested = path.join(blocker, 'nested');
  try {
    const lines = await captureConsole(async () => {
      const store = createCheckoutTosStore({ directory: nested });
      assert.equal(store.writable, false);
      assert.throws(
        () => store.recordAccepted({
          id: ACCEPTED_ID,
          consent: { terms_of_service: 'accepted' },
          metadata: { plan: 'pro' },
        }),
        (err) => err && err.code === 'consent_dir_unwritable',
      );
      const app = createApp({
        env: { ...webhookEnv, CHECKOUT_CONSENT_DIR: nested },
        stripe: webhookStripe(),
        anthropic: null,
      });
      const server = await listen(app);
      try {
        const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
        assert.equal(health.status, 200);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
    assert.match(lines.join('\n'), /WARNING: checkout terms directory is not writable \(ENOTDIR\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing terms URL is a 503 and other checkout errors stay 500', async () => {
  const secret = 'sk_test_SUPER_SECRET_KEY';
  const fullId = 'cs_test_should_not_log_9f3a';
  let mode = 'terms';
  const stripe = {
    checkout: {
      sessions: {
        create: async () => {
          if (mode === 'terms') {
            const err = new Error(`You must save a terms of service URL in public details before using ${secret} ${fullId}`);
            err.param = 'consent_collection[terms_of_service]';
            throw err;
          }
          const err = new Error('No such price: price_missing');
          throw err;
        },
      },
    },
  };
  const app = createApp({
    env: webhookEnv,
    stripe,
    anthropic: null,
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const termsLines = await captureConsole(async () => {
      const blocked = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'starter' }),
      });
      assert.equal(blocked.status, 503);
      assert.deepEqual(await blocked.json(), { error: 'Checkout is temporarily unavailable.' });
    });
    const termsLog = termsLines.join('\n');
    assert.match(termsLog, /checkout_tos_config_error terms_url_missing/);
    assert.equal(termsLog.includes(secret), false);
    assert.equal(termsLog.includes(fullId), false);
    assert.equal(termsLog.includes('public details'), false);

    mode = 'other';
    const otherLines = await captureConsole(async () => {
      const other = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      });
      assert.equal(other.status, 500);
      const body = await other.json();
      assert.equal(body.error, 'Internal server error');
      assert.equal(JSON.stringify(body).includes('price_missing'), false);
    });
    assert.equal(otherLines.join('\n').includes('checkout_tos_config_error'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
