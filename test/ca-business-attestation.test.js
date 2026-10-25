const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkoutParams, PRO_REFUNDED_MESSAGE, STARTER_REFUNDED_MESSAGE } = require('../lib/billing');
const { withCheckoutPolicy } = require('../lib/checkoutPolicy');
const { applyCheckoutConsent, withManualosBrand } = require('../lib/checkout-consent');
const { applyManualosCheckout } = require('../lib/stripeBrand');
const { createCreditLedger } = require('../lib/credit-ledger');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const {
  ATTESTATION_FILE,
  CA_BUSINESS_MESSAGE,
  REFUND_FILE,
  createCaAttestationStore,
  ensureBillingAddressCollection,
} = require('../lib/ca-business');

const FIXED = Date.parse('2026-10-25T16:00:00.000Z');
const AT = '2026-10-25T16:00:00.000Z';

test.after(() => {
  removeTestJobDirectories();
});

function baseEnv(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_SECRET_KEY: 'sk_test_example',
    STARTER_CREDITS: '3',
    ...extra,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-ca-'));
}

function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

async function withServer(app, fn) {
  const server = await listen(app);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createStripe() {
  const calls = { create: [], refunds: [], cancels: [], piUpdates: [], subUpdates: [] };
  const sessions = {};
  const intents = {};
  const subs = {};
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.create.push(params);
          const id = `cs_created_${calls.create.length}`;
          const plan = params.metadata && params.metadata.plan;
          const paymentIntent = `pi_${id}`;
          const prior = (params.payment_intent_data && params.payment_intent_data.metadata) || {};
          intents[paymentIntent] = {
            metadata: { ...prior, plan, brand: 'manualos', manuals_used: prior.manuals_used || '0' },
          };
          const session = {
            id,
            object: 'checkout.session',
            mode: params.mode,
            metadata: { ...(params.metadata || {}) },
            payment_status: 'paid',
            payment_intent: paymentIntent,
            subscription: null,
          };
          if (params.mode === 'subscription') {
            const subId = `sub_${id}`;
            const subMeta = (params.subscription_data && params.subscription_data.metadata) || {};
            subs[subId] = { id: subId, status: 'active', metadata: { ...subMeta } };
            session.subscription = subId;
          }
          sessions[id] = session;
          return { id, url: `https://checkout.example.test/${id}`, customer: 'cus_created' };
        },
        retrieve: async (id) => {
          if (!sessions[id]) {
            const err = new Error('missing session');
            err.statusCode = 404;
            err.code = 'resource_missing';
            throw err;
          }
          return {
            ...sessions[id],
            payment_intent: sessions[id].payment_intent,
            subscription: sessions[id].subscription,
          };
        },
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        if (!intents[id]) {
          const err = new Error('missing payment');
          err.statusCode = 404;
          err.code = 'resource_missing';
          throw err;
        }
        return { id, metadata: { ...intents[id].metadata } };
      },
      update: async (id, params) => {
        calls.piUpdates.push({ id, metadata: { ...params.metadata } });
        intents[id].metadata = { ...intents[id].metadata, ...params.metadata };
        return { id, metadata: { ...intents[id].metadata } };
      },
    },
    refunds: {
      create: async (params, options) => {
        calls.refunds.push({ params: { ...params }, options: { ...options } });
        return { id: `re_${calls.refunds.length}`, status: 'succeeded' };
      },
    },
    subscriptions: {
      retrieve: async (id) => {
        if (!subs[id]) {
          const err = new Error('missing subscription');
          err.statusCode = 404;
          err.code = 'resource_missing';
          throw err;
        }
        return { id, status: subs[id].status, metadata: { ...subs[id].metadata } };
      },
      update: async (id, params) => {
        calls.subUpdates.push({ id, metadata: { ...params.metadata } });
        subs[id].metadata = { ...subs[id].metadata, ...params.metadata };
        return { id, status: subs[id].status, metadata: { ...subs[id].metadata } };
      },
      cancel: async (id, params, options) => {
        calls.cancels.push({ id, params: { ...params }, options: { ...options } });
        subs[id].status = 'canceled';
        return { id, status: 'canceled', metadata: { ...subs[id].metadata } };
      },
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') {
          throw new Error('bad signature');
        }
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
  return { stripe, calls, sessions, intents, subs };
}

function seedStarter(mock, id) {
  const paymentIntent = `pi_${id}`;
  mock.intents[paymentIntent] = {
    metadata: { plan: 'starter', brand: 'manualos', manuals_used: '0' },
  };
  mock.sessions[id] = {
    id,
    object: 'checkout.session',
    mode: 'payment',
    metadata: { plan: 'starter', brand: 'manualos' },
    payment_status: 'paid',
    payment_intent: paymentIntent,
    subscription: null,
  };
  return mock.sessions[id];
}

function seedPro(mock, id) {
  const paymentIntent = `pi_${id}`;
  const subId = `sub_${id}`;
  mock.intents[paymentIntent] = { metadata: { plan: 'pro', brand: 'manualos' } };
  mock.subs[subId] = { id: subId, status: 'active', metadata: { plan: 'pro', brand: 'manualos' } };
  mock.sessions[id] = {
    id,
    object: 'checkout.session',
    mode: 'subscription',
    metadata: { plan: 'pro', brand: 'manualos' },
    payment_status: 'paid',
    payment_intent: paymentIntent,
    subscription: subId,
  };
  return mock.sessions[id];
}

function completedEvent(session, country) {
  return {
    id: `evt_${session.id}_${country}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        ...session,
        customer_details: {
          email: 'buyer@example.com',
          address: { country },
        },
      },
    },
  };
}

async function postJson(base, pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postWebhook(base, event) {
  return fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
    body: JSON.stringify(event),
  });
}

async function expectedParams(stripe, plan, env) {
  return withManualosBrand(applyCheckoutConsent(
    await applyManualosCheckout(
      stripe,
      withCheckoutPolicy(checkoutParams(plan, env), { plan, env }),
      plan,
    ),
    { plan },
    { ip: '127.0.0.1', now: FIXED, env },
  ));
}

function readJsonl(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function appFor(env, stripe) {
  return createApp({
    env,
    stripe,
    anthropic: null,
    now: () => FIXED,
    creditLedger: createCreditLedger({ env, intervalMs: 0 }),
  });
}

async function capture(fn) {
  const lines = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  console.error = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return await fn(lines);
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('billing address collection is required only when it is not already set', () => {
  const bare = { mode: 'payment', metadata: { plan: 'starter' } };
  const next = ensureBillingAddressCollection(bare);
  assert.equal(next.billing_address_collection, 'required');
  assert.equal(next.mode, 'payment');
  assert.equal(next.metadata.plan, 'starter');
  assert.equal(bare.billing_address_collection, undefined);
  const auto = { billing_address_collection: 'auto', mode: 'subscription' };
  assert.equal(ensureBillingAddressCollection(auto), auto);
  const required = { billing_address_collection: 'required', metadata: { plan: 'pro' } };
  assert.equal(ensureBillingAddressCollection(required), required);
});

test('an attestation record is fsynced before it is renamed', async () => {
  const dir = tempDir();
  const events = [];
  const origFsync = fs.fsyncSync;
  const origRename = fs.renameSync;
  fs.fsyncSync = (fd) => {
    events.push('fsync');
    return origFsync(fd);
  };
  fs.renameSync = (from, to) => {
    if (String(to).endsWith(ATTESTATION_FILE)) events.push('rename');
    return origRename(from, to);
  };
  try {
    const store = createCaAttestationStore({ env: { SUPPORT_DATA_DIR: dir } });
    await store.record({
      sessionId: 'cs_fsync',
      customerId: 'cus_fsync',
      at: AT,
      billingCountry: 'CA',
      caBusinessAttestation: true,
      attestationVersion: 'ca-b2b-v1',
    });
    await store.record({
      sessionId: 'cs_fsync_2',
      at: AT,
      billingCountry: 'CA',
      caBusinessAttestation: true,
      attestationVersion: 'ca-b2b-v1',
    });
    assert.deepEqual(events, ['fsync', 'rename', 'fsync', 'rename']);
    const rows = readJsonl(dir, ATTESTATION_FILE);
    assert.deepEqual(rows.map((row) => row.sessionId), ['cs_fsync', 'cs_fsync_2']);
  } finally {
    fs.fsyncSync = origFsync;
    fs.renameSync = origRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Canada without a business attestation is rejected and the US request is unchanged', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const starterExpected = await expectedParams(mock.stripe, 'starter', env);
  const proExpected = await expectedParams(mock.stripe, 'pro', env);
  const app = appFor(env, mock.stripe);
  try {
    await capture(async (lines) => {
      await withServer(app, async (base) => {
        const missing = await postJson(base, '/create-checkout-session', { plan: 'starter', billingCountry: 'CA' });
        assert.equal(missing.status, 400);
        assert.deepEqual(await missing.json(), { error: CA_BUSINESS_MESSAGE, code: 'ca_business_required' });

        const declined = await postJson(base, '/create-checkout-session', {
          plan: 'pro',
          billingCountry: 'CA',
          caBusinessAttestation: false,
          attestationVersion: 'ca-b2b-v1',
        });
        assert.equal(declined.status, 400);
        assert.deepEqual(await declined.json(), { error: CA_BUSINESS_MESSAGE, code: 'ca_business_required' });

        const wrongType = await postJson(base, '/create-checkout-session', {
          plan: 'starter',
          billingCountry: 'CA',
          caBusinessAttestation: 'true',
          attestationVersion: 'ca-b2b-v1',
        });
        assert.equal(wrongType.status, 400);
        const wrongTypeBody = await wrongType.json();
        assert.equal(wrongTypeBody.error, 'caBusinessAttestation must be true or false.');
        assert.equal(wrongTypeBody.code, undefined);

        const wrongVersion = await postJson(base, '/create-checkout-session', {
          plan: 'starter',
          billingCountry: 'CA',
          caBusinessAttestation: true,
          attestationVersion: 'ca-b2b-v2',
        });
        assert.equal(wrongVersion.status, 400);
        assert.equal((await wrongVersion.json()).error, 'attestationVersion is not accepted.');

        const lower = await postJson(base, '/create-checkout-session', { plan: 'starter', billingCountry: 'ca' });
        assert.equal(lower.status, 400);
        assert.equal((await lower.json()).error, 'billingCountry must be a two-letter ISO country code.');
        assert.equal(mock.calls.create.length, 0);
        assert.equal(fs.existsSync(path.join(dir, ATTESTATION_FILE)), false);

        const starter = await postJson(base, '/create-checkout-session', { plan: 'starter' });
        assert.equal(starter.status, 200);
        assert.deepEqual(Object.keys(await starter.json()), ['url']);
        assert.deepEqual(mock.calls.create[0], starterExpected);
        assert.equal(mock.calls.create[0].billing_address_collection, 'required');
        assert.equal(JSON.stringify(mock.calls.create[0]).includes('ca-b2b-v1'), false);
        assert.equal(JSON.stringify(mock.calls.create[0]).includes('caBusinessAttestation'), false);

        const pro = await postJson(base, '/create-checkout-session', { plan: 'pro' });
        assert.equal(pro.status, 200);
        assert.deepEqual(mock.calls.create[1], proExpected);
        assert.equal(fs.existsSync(path.join(dir, ATTESTATION_FILE)), false);
      });
      const logged = lines.join('\n');
      assert.equal(logged.includes('sk_test_'), false);
      assert.equal(logged.includes('whsec_'), false);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Canadian business attestation is stored outside the checkout session', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const plain = await expectedParams(mock.stripe, 'starter', env);
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const response = await postJson(base, '/create-checkout-session', {
        plan: 'starter',
        billingCountry: 'CA',
        caBusinessAttestation: true,
        attestationVersion: 'ca-b2b-v1',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(mock.calls.create[0], plain);
      assert.equal(mock.calls.create[0].metadata.caBusinessAttestation, undefined);
      assert.equal(mock.calls.create[0].payment_intent_data.metadata.caBusinessAttestation, undefined);

      const second = await postJson(base, '/create-checkout-session', {
        plan: 'pro',
        billingCountry: 'CA',
        caBusinessAttestation: true,
        attestationVersion: 'ca-b2b-v1',
      });
      assert.equal(second.status, 200);
    });
    const rows = readJsonl(dir, ATTESTATION_FILE);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      sessionId: 'cs_created_1',
      customerId: 'cus_created',
      userId: null,
      at: AT,
      billingCountry: 'CA',
      caBusinessAttestation: true,
      attestationVersion: 'ca-b2b-v1',
    });
    assert.equal(rows[1].sessionId, 'cs_created_2');
    assert.equal(rows[1].caBusinessAttestation, true);
    const raw = fs.readFileSync(path.join(dir, ATTESTATION_FILE), 'utf8');
    assert.equal(raw.includes('@'), false);
    assert.equal(raw.includes('sk_test_'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the backstop refunds an unattested Canadian checkout once and blocks access', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const starter = seedStarter(mock, 'cs_block');
  const pro = seedPro(mock, 'cs_pro_block');
  seedStarter(mock, 'cs_us');
  const app = appFor(env, mock.stripe);
  try {
    await capture(async (lines) => {
      await withServer(app, async (base) => {
        const first = await postWebhook(base, completedEvent(starter, 'CA'));
        assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), { received: true });
        const second = await postWebhook(base, completedEvent(starter, 'CA'));
        assert.equal(second.status, 200);

        assert.equal(mock.calls.refunds.length, 1);
        assert.deepEqual(mock.calls.refunds[0].params, { payment_intent: 'pi_cs_block' });
        assert.equal(Object.hasOwn(mock.calls.refunds[0].params, 'amount'), false);
        assert.equal(mock.calls.refunds[0].options.idempotencyKey, 'ca-b2b-refund-cs_block');
        assert.deepEqual(mock.calls.piUpdates, [{
          id: 'pi_cs_block',
          metadata: { credit_status: 'revoked', credit_revoke_reason: 'refund' },
        }]);
        assert.equal(mock.calls.cancels.length, 0);

        const access = await fetch(`${base}/verify-session?session_id=cs_block`);
        assert.deepEqual(await access.json(), { valid: false, plan: 'starter', remaining: 0 });
        const job = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_block' } });
        assert.equal(job.status, 402);
        assert.equal((await job.json()).error, STARTER_REFUNDED_MESSAGE);

        const health = await fetch(`${base}/health`);
        assert.equal((await health.json()).caBackstopRefunds, 1);

        const unitedStates = await postWebhook(base, completedEvent(mock.sessions.cs_us, 'US'));
        assert.equal(unitedStates.status, 200);
        assert.equal(mock.calls.refunds.length, 1);
        const usAccess = await fetch(`${base}/verify-session?session_id=cs_us`);
        assert.deepEqual(await usAccess.json(), { valid: true, plan: 'starter', remaining: 3 });

        const proHook = await postWebhook(base, completedEvent(pro, 'CA'));
        assert.equal(proHook.status, 200);
        const proAgain = await postWebhook(base, completedEvent(pro, 'CA'));
        assert.equal(proAgain.status, 200);
        assert.equal(mock.calls.refunds.length, 2);
        assert.deepEqual(mock.calls.refunds[1].params, { payment_intent: 'pi_cs_pro_block' });
        assert.deepEqual(mock.calls.cancels, [{
          id: 'sub_cs_pro_block',
          params: { prorate: false, invoice_now: false },
          options: { idempotencyKey: 'ca-b2b-cancel-sub_cs_pro_block' },
        }]);
        assert.deepEqual(mock.calls.subUpdates, [{
          id: 'sub_cs_pro_block',
          metadata: { period_access: 'revoked', period_access_reason: 'refund' },
        }]);
        const proAccess = await fetch(`${base}/verify-session?session_id=cs_pro_block`);
        assert.deepEqual(await proAccess.json(), { valid: false, plan: 'pro', remaining: null });
        const proJob = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_pro_block' } });
        assert.equal(proJob.status, 402);
        assert.equal((await proJob.json()).error, PRO_REFUNDED_MESSAGE);
        assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 2);
      });
      const logged = lines.join('\n');
      assert.match(logged, /Canadian business check refunded cs_block/);
      assert.match(logged, /Canadian business check already refunded cs_block/);
      assert.equal(logged.includes('buyer@example.com'), false);
      assert.equal(logged.includes('sk_test_'), false);
      assert.equal(logged.includes('whsec_'), false);
    });
    const refunds = readJsonl(dir, REFUND_FILE);
    assert.deepEqual(refunds.map((row) => row.sessionId), ['cs_block', 'cs_pro_block']);
    assert.equal(JSON.stringify(refunds).includes('buyer@example.com'), false);
    assert.equal(JSON.stringify(refunds).includes('sk_test_'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Canadian billing country with a valid attestation is granted', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const opened = await postJson(base, '/create-checkout-session', {
        plan: 'starter',
        billingCountry: 'CA',
        caBusinessAttestation: true,
        attestationVersion: 'ca-b2b-v1',
      });
      assert.equal(opened.status, 200);
      const session = mock.sessions.cs_created_1;
      const hook = await postWebhook(base, completedEvent(session, 'CA'));
      assert.equal(hook.status, 200);
      assert.equal(mock.calls.refunds.length, 0);
      assert.equal(mock.calls.piUpdates.length, 0);
      assert.equal(mock.calls.cancels.length, 0);
      const access = await fetch(`${base}/verify-session?session_id=cs_created_1`);
      assert.deepEqual(await access.json(), { valid: true, plan: 'starter', remaining: 3 });
      const job = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_created_1' } });
      assert.equal(job.status, 400);
      assert.equal((await job.json()).error, 'No file or plcContent provided');
      assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 0);

      const pro = await postJson(base, '/create-checkout-session', {
        plan: 'pro',
        billingCountry: 'CA',
        caBusinessAttestation: true,
        attestationVersion: 'ca-b2b-v1',
      });
      assert.equal(pro.status, 200);
      const proHook = await postWebhook(base, completedEvent(mock.sessions.cs_created_2, 'CA'));
      assert.equal(proHook.status, 200);
      assert.equal(mock.calls.refunds.length, 0);
      assert.equal(mock.calls.cancels.length, 0);
      const proAccess = await fetch(`${base}/verify-session?session_id=cs_created_2`);
      assert.deepEqual(await proAccess.json(), { valid: true, plan: 'pro', remaining: null });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a repeated webhook after a restart does not refund again', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const first = createStripe();
  const session = seedStarter(first, 'cs_retry');
  try {
    await withServer(appFor(env, first.stripe), async (base) => {
      const response = await postWebhook(base, completedEvent(session, 'CA'));
      assert.equal(response.status, 200);
      assert.equal(first.calls.refunds.length, 1);
    });
    const second = createStripe();
    seedStarter(second, 'cs_retry');
    await withServer(appFor(env, second.stripe), async (base) => {
      const response = await postWebhook(base, completedEvent(second.sessions.cs_retry, 'CA'));
      assert.equal(response.status, 200);
      assert.equal(second.calls.refunds.length, 0);
      assert.equal(second.calls.piUpdates.length, 0);
      assert.equal(second.calls.cancels.length, 0);
      assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 1);
    });
    assert.equal(readJsonl(dir, REFUND_FILE).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('turning the gate off restores checkout and webhook behavior', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir, MANUALOS_CA_B2B_GATE: '0' });
  const mock = createStripe();
  const expected = await expectedParams(mock.stripe, 'starter', env);
  const session = seedStarter(mock, 'cs_open');
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const opened = await postJson(base, '/create-checkout-session', {
        plan: 'starter',
        billingCountry: 'CA',
        caBusinessAttestation: false,
        attestationVersion: 'nope',
      });
      assert.equal(opened.status, 200);
      assert.deepEqual(mock.calls.create[0], expected);
      assert.equal(fs.existsSync(path.join(dir, ATTESTATION_FILE)), false);

      const hook = await postWebhook(base, completedEvent(session, 'CA'));
      assert.equal(hook.status, 200);
      const again = await postWebhook(base, completedEvent(session, 'CA'));
      assert.equal(again.status, 200);
      assert.equal(mock.calls.refunds.length, 0);
      assert.equal(mock.calls.piUpdates.length, 0);
      assert.equal(mock.calls.cancels.length, 0);
      const access = await fetch(`${base}/verify-session?session_id=cs_open`);
      assert.deepEqual(await access.json(), { valid: true, plan: 'starter', remaining: 3 });
      const job = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_open' } });
      assert.equal(job.status, 400);
      assert.equal((await job.json()).error, 'No file or plcContent provided');
      assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 0);
    });
    assert.equal(fs.existsSync(path.join(dir, REFUND_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('another product on the shared account is not refunded', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const session = {
    id: 'cs_other_product',
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    metadata: { brand: 'htsatlas', plan: 'starter' },
    payment_intent: 'pi_other_product',
    customer_details: { address: { country: 'CA' }, email: 'buyer@example.com' },
  };
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const response = await postWebhook(base, {
        id: 'evt_other_product',
        type: 'checkout.session.completed',
        data: { object: session },
      });
      assert.equal(response.status, 200);
      assert.equal(mock.calls.refunds.length, 0);
      assert.equal(mock.calls.cancels.length, 0);
      assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 0);
    });
    assert.equal(fs.existsSync(path.join(dir, REFUND_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
