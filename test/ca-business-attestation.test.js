const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkoutParams } = require('../lib/billing');
const { withCheckoutPolicy } = require('../lib/checkoutPolicy');
const { applyCheckoutConsent, withManualosBrand } = require('../lib/checkout-consent');
const { applyManualosCheckout } = require('../lib/stripeBrand');
const { createCreditLedger } = require('../lib/credit-ledger');
const { createApp } = require('../server');
const { createJobStore, removeTestJobDirectories } = require('../lib/jobs/store');
const {
  ATTESTATION_FILE,
  CA_BUSINESS_CODE,
  CA_BUSINESS_MESSAGE,
  REFUND_FILE,
  caCheckoutStorageReady,
  caGateEnabled,
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
  const calls = {
    create: [],
    refunds: [],
    cancels: [],
    piUpdates: [],
    subUpdates: [],
    expires: [],
    invoicePaymentLists: [],
  };
  const sessions = {};
  const intents = {};
  const subs = {};
  const invoices = {};
  const listedPayments = {};
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.create.push(params);
          const id = `cs_created_${calls.create.length}`;
          const plan = params.metadata && params.metadata.plan;
          const prior = (params.payment_intent_data && params.payment_intent_data.metadata) || {};
          const session = {
            id,
            object: 'checkout.session',
            mode: params.mode,
            metadata: { ...(params.metadata || {}) },
            payment_status: 'paid',
            payment_intent: null,
            subscription: null,
            invoice: null,
          };
          if (params.mode === 'subscription') {
            const subId = `sub_${id}`;
            const invoiceId = `in_${id}`;
            const paymentIntent = `pi_${id}`;
            const subMeta = (params.subscription_data && params.subscription_data.metadata) || {};
            intents[paymentIntent] = { metadata: { ...subMeta, plan, brand: 'manualos' } };
            invoices[invoiceId] = {
              id: invoiceId,
              payments: {
                data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: paymentIntent } }],
              },
            };
            subs[subId] = {
              id: subId,
              status: 'active',
              metadata: { ...subMeta },
              latest_invoice: invoiceId,
            };
            session.subscription = subId;
            session.invoice = invoiceId;
          } else {
            const paymentIntent = `pi_${id}`;
            intents[paymentIntent] = {
              metadata: { ...prior, plan, brand: 'manualos', manuals_used: prior.manuals_used || '0' },
            };
            session.payment_intent = paymentIntent;
          }
          sessions[id] = session;
          return { id, url: `https://checkout.example.test/${id}`, customer: 'cus_created' };
        },
        expire: async (id) => {
          calls.expires.push(id);
          if (sessions[id]) sessions[id].status = 'expired';
          return { id, status: 'expired' };
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
        return {
          id,
          status: subs[id].status,
          metadata: { ...subs[id].metadata },
          latest_invoice: subs[id].latest_invoice || null,
        };
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
    invoices: {
      retrieve: async (id) => {
        if (!invoices[id]) {
          const err = new Error('missing invoice');
          err.statusCode = 404;
          err.code = 'resource_missing';
          throw err;
        }
        return invoices[id];
      },
    },
    invoicePayments: {
      list: async (params) => {
        calls.invoicePaymentLists.push(params);
        const id = params && typeof params.invoice === 'string' ? params.invoice : '';
        if (Object.prototype.hasOwnProperty.call(listedPayments, id)) {
          return { object: 'list', data: listedPayments[id] };
        }
        const invoice = invoices[id];
        const data = invoice && invoice.payments && Array.isArray(invoice.payments.data) ? invoice.payments.data : [];
        return { object: 'list', data };
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
  return { stripe, calls, sessions, intents, subs, invoices, listedPayments };
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
  const invoiceId = `in_${id}`;
  mock.intents[paymentIntent] = { metadata: { plan: 'pro', brand: 'manualos' } };
  mock.invoices[invoiceId] = {
    id: invoiceId,
    payments: {
      data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: paymentIntent } }],
    },
  };
  mock.subs[subId] = {
    id: subId,
    status: 'active',
    metadata: { plan: 'pro', brand: 'manualos' },
    latest_invoice: invoiceId,
  };
  mock.sessions[id] = {
    id,
    object: 'checkout.session',
    mode: 'subscription',
    metadata: { plan: 'pro', brand: 'manualos' },
    payment_status: 'paid',
    payment_intent: null,
    invoice: invoiceId,
    subscription: subId,
  };
  return mock.sessions[id];
}

function setCountry(session, country) {
  session.customer_details = {
    email: 'buyer@example.com',
    address: { country },
  };
  return session;
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

function appFor(env, stripe, extra = {}) {
  return createApp({
    env,
    stripe,
    anthropic: null,
    now: () => FIXED,
    creditLedger: createCreditLedger({ env, intervalMs: 0 }),
    ...extra,
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
    assert.deepEqual(events, ['fsync', 'rename', 'fsync', 'fsync', 'rename', 'fsync']);
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
  const starter = setCountry(seedStarter(mock, 'cs_block'), 'CA');
  const pro = setCountry(seedPro(mock, 'cs_pro_block'), 'CA');
  setCountry(seedStarter(mock, 'cs_us'), 'US');
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
        assert.equal(access.status, 400);
        assert.deepEqual(await access.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });
        const job = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_block' } });
        assert.equal(job.status, 400);
        assert.deepEqual(await job.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });

        const health = await fetch(`${base}/health`);
        assert.equal((await health.json()).caBackstopRefunds, 1);

        const unitedStates = await postWebhook(base, completedEvent(mock.sessions.cs_us, 'US'));
        assert.equal(unitedStates.status, 200);
        assert.equal(mock.calls.refunds.length, 1);
        const usAccess = await fetch(`${base}/verify-session?session_id=cs_us`);
        assert.deepEqual(await usAccess.json(), { valid: true, plan: 'starter', remaining: 3, billingIssue: false });

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
        assert.equal(pro.payment_intent, null);
        assert.equal(mock.invoices.in_cs_pro_block.payment_intent, undefined);
        assert.equal(mock.invoices.in_cs_pro_block.charge, undefined);
        const proAccess = await fetch(`${base}/verify-session?session_id=cs_pro_block`);
        assert.equal(proAccess.status, 400);
        assert.deepEqual(await proAccess.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });
        const proJob = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_pro_block' } });
        assert.equal(proJob.status, 400);
        assert.deepEqual(await proJob.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });
        assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 2);
      });
      const logged = lines.join('\n');
      assert.match(logged, /Canadian business check refunded lock/);
      assert.match(logged, /Canadian business check already refunded lock/);
      assert.equal(logged.includes('cs_block'), false);
      assert.equal(logged.includes('cs_pro_block'), false);
      assert.equal(logged.includes('cs_us'), false);
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
      const session = setCountry(mock.sessions.cs_created_1, 'CA');
      const hook = await postWebhook(base, completedEvent(session, 'CA'));
      assert.equal(hook.status, 200);
      assert.equal(mock.calls.refunds.length, 0);
      assert.equal(mock.calls.piUpdates.length, 0);
      assert.equal(mock.calls.cancels.length, 0);
      const access = await fetch(`${base}/verify-session?session_id=cs_created_1`);
      assert.deepEqual(await access.json(), { valid: true, plan: 'starter', remaining: 3, billingIssue: false });
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
      const proSession = setCountry(mock.sessions.cs_created_2, 'CA');
      assert.equal(proSession.payment_intent, null);
      const proHook = await postWebhook(base, completedEvent(proSession, 'CA'));
      assert.equal(proHook.status, 200);
      assert.equal(mock.calls.refunds.length, 0);
      assert.equal(mock.calls.cancels.length, 0);
      const proAccess = await fetch(`${base}/verify-session?session_id=cs_created_2`);
      assert.deepEqual(await proAccess.json(), { valid: true, plan: 'pro', remaining: null, billingIssue: false });
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
  const session = setCountry(seedStarter(mock, 'cs_open'), 'CA');
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
      assert.deepEqual(await access.json(), { valid: true, plan: 'starter', remaining: 3, billingIssue: false });
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

test('an unattested Canadian session is refused before any credit or Pro access', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir, MANUALOS_LEGACY_GENERATE: '1' });
  const mock = createStripe();
  const starter = setCountry(seedStarter(mock, 'cs_window'), 'CA');
  const pro = setCountry(seedPro(mock, 'cs_window_pro'), 'CA');
  setCountry(seedStarter(mock, 'cs_window_us'), 'US');
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const verify = await fetch(`${base}/verify-session?session_id=cs_window`);
      assert.equal(verify.status, 400);
      assert.deepEqual(await verify.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });

      const job = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_window' } });
      assert.equal(job.status, 400);
      assert.deepEqual(await job.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });

      const legacy = await fetch(`${base}/generate-manual`, { method: 'POST', headers: { 'X-Session-Id': 'cs_window' } });
      assert.equal(legacy.status, 400);
      assert.deepEqual(await legacy.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });

      const proVerify = await fetch(`${base}/verify-session?session_id=cs_window_pro`);
      assert.equal(proVerify.status, 400);
      assert.deepEqual(await proVerify.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });
      const proJob = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_window_pro' } });
      assert.equal(proJob.status, 400);
      assert.deepEqual(await proJob.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });

      const unitedStates = await fetch(`${base}/verify-session?session_id=cs_window_us`);
      assert.equal(unitedStates.status, 200);
      assert.deepEqual(await unitedStates.json(), { valid: true, plan: 'starter', remaining: 3, billingIssue: false });
    });
    assert.equal(mock.intents[starter.payment_intent].metadata.manuals_used, '0');
    assert.equal(mock.calls.piUpdates.length, 0);
    assert.equal(mock.calls.refunds.length, 0);
    assert.equal(mock.calls.cancels.length, 0);
    assert.equal(mock.subs[pro.subscription].status, 'active');
    assert.equal(pro.payment_intent, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a subscription refund uses invoice payments and is not counted when none exist', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const listed = setCountry(seedPro(mock, 'cs_list_pay'), 'CA');
  mock.invoices[listed.invoice] = { id: listed.invoice };
  mock.listedPayments[listed.invoice] = [{
    status: 'paid',
    payment: { type: 'charge', charge: 'ch_list_pay' },
  }];
  const missing = setCountry(seedPro(mock, 'cs_no_payment'), 'CA');
  mock.invoices[missing.invoice] = { id: missing.invoice };
  mock.listedPayments[missing.invoice] = [];
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const paid = await postWebhook(base, completedEvent(listed, 'CA'));
      assert.equal(paid.status, 200);
      assert.equal(listed.payment_intent, null);
      assert.deepEqual(mock.calls.invoicePaymentLists[0], { invoice: listed.invoice, limit: 10 });
      assert.deepEqual(mock.calls.refunds[0].params, { charge: 'ch_list_pay' });
      assert.equal(Object.hasOwn(mock.calls.refunds[0].params, 'amount'), false);
      assert.equal(mock.calls.cancels.length, 1);
      assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 1);

      const unpaid = await postWebhook(base, completedEvent(missing, 'CA'));
      assert.equal(unpaid.status, 500);
      assert.equal(mock.calls.refunds.length, 1);
      assert.equal(mock.calls.cancels.length, 1);
      assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 1);
    });
    assert.deepEqual(readJsonl(dir, REFUND_FILE).map((row) => row.sessionId), ['cs_list_pay']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unpaid completed session waits for async payment success', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const session = setCountry(seedStarter(mock, 'cs_delay'), 'CA');
  session.payment_status = 'unpaid';
  const app = appFor(env, mock.stripe);
  try {
    await capture(async (lines) => {
      await withServer(app, async (base) => {
        const waiting = await postWebhook(base, completedEvent(session, 'CA'));
        assert.equal(waiting.status, 200);
        assert.equal(mock.calls.refunds.length, 0);
        assert.equal(mock.calls.piUpdates.length, 0);
        assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 0);
        assert.equal(fs.existsSync(path.join(dir, REFUND_FILE)), false);

        session.payment_status = 'paid';
        const asyncEvent = {
          id: 'evt_async_delay',
          type: 'checkout.session.async_payment_succeeded',
          data: { object: { ...session, payment_status: 'paid' } },
        };
        const succeeded = await postWebhook(base, asyncEvent);
        assert.equal(succeeded.status, 200);
        assert.equal(mock.calls.refunds.length, 1);
        assert.deepEqual(mock.calls.refunds[0].params, { payment_intent: 'pi_cs_delay' });
        const again = await postWebhook(base, asyncEvent);
        assert.equal(again.status, 200);
        assert.equal(mock.calls.refunds.length, 1);
        assert.equal((await (await fetch(`${base}/health`)).json()).caBackstopRefunds, 1);
      });
      const logged = lines.join('\n');
      assert.equal(logged.includes('cs_delay'), false);
      assert.match(logged, /Canadian business check refunded elay/);
    });
    assert.equal(readJsonl(dir, REFUND_FILE).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a United States attestation does not satisfy a Canadian payment', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const opened = await postJson(base, '/create-checkout-session', {
        plan: 'starter',
        billingCountry: 'US',
        caBusinessAttestation: true,
        attestationVersion: 'ca-b2b-v1',
      });
      assert.equal(opened.status, 200);
      const session = setCountry(mock.sessions.cs_created_1, 'CA');
      const hook = await postWebhook(base, completedEvent(session, 'CA'));
      assert.equal(hook.status, 200);
      assert.equal(mock.calls.refunds.length, 1);
      assert.deepEqual(mock.calls.refunds[0].params, { payment_intent: 'pi_cs_created_1' });
      const access = await fetch(`${base}/verify-session?session_id=cs_created_1`);
      assert.equal(access.status, 400);
      assert.deepEqual(await access.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });
      const job = await fetch(`${base}/jobs`, { method: 'POST', headers: { 'X-Session-Id': 'cs_created_1' } });
      assert.equal(job.status, 400);
      assert.deepEqual(await job.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });
    });
    const rows = readJsonl(dir, ATTESTATION_FILE);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].billingCountry, 'US');
    assert.equal(rows[0].caBusinessAttestation, true);
    assert.deepEqual(readJsonl(dir, REFUND_FILE).map((row) => row.sessionId), ['cs_created_1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable attestation directory expires the checkout session', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, ATTESTATION_FILE));
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const response = await postJson(base, '/create-checkout-session', {
        plan: 'starter',
        billingCountry: 'CA',
        caBusinessAttestation: true,
        attestationVersion: 'ca-b2b-v1',
      });
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.error, 'Internal server error');
      assert.equal(body.url, undefined);
      assert.equal(mock.calls.create.length, 1);
      assert.deepEqual(mock.calls.expires, ['cs_created_1']);
      assert.equal(mock.sessions.cs_created_1.status, 'expired');
    });
    assert.equal(fs.existsSync(path.join(dir, REFUND_FILE)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production without a support directory does not open a Canadian business checkout', async () => {
  const dir = tempDir();
  assert.equal(caCheckoutStorageReady({ NODE_ENV: 'production' }), false);
  assert.equal(caCheckoutStorageReady({ RAILWAY_ENVIRONMENT: 'production' }), false);
  assert.equal(caCheckoutStorageReady({ NODE_ENV: 'production', SUPPORT_DATA_DIR: dir }), true);
  assert.equal(caCheckoutStorageReady({ NODE_ENV: 'test' }), true);
  const cases = [
    baseEnv({ NODE_ENV: 'production' }),
    baseEnv({ RAILWAY_ENVIRONMENT: 'production' }),
  ];
  try {
    for (const env of cases) {
      const mock = createStripe();
      const app = appFor(env, mock.stripe);
      await withServer(app, async (base) => {
        const canadian = await postJson(base, '/create-checkout-session', {
          plan: 'starter',
          billingCountry: 'CA',
          caBusinessAttestation: true,
          attestationVersion: 'ca-b2b-v1',
        });
        assert.equal(canadian.status, 500);
        assert.deepEqual(await canadian.json(), { error: 'Checkout is temporarily unavailable.' });
        assert.equal(mock.calls.create.length, 0);
        assert.equal(mock.calls.expires.length, 0);

        const unitedStates = await postJson(base, '/create-checkout-session', { plan: 'starter' });
        assert.equal(unitedStates.status, 200);
        assert.deepEqual(Object.keys(await unitedStates.json()), ['url']);
        assert.equal(mock.calls.create.length, 1);
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only the exact string 0 turns the Canadian gate off', async () => {
  assert.equal(caGateEnabled({}), true);
  assert.equal(caGateEnabled({ MANUALOS_CA_B2B_GATE: '0' }), false);
  assert.equal(caGateEnabled({ MANUALOS_CA_B2B_GATE: ' 0 ' }), true);
  assert.equal(caGateEnabled({ MANUALOS_CA_B2B_GATE: '0\n' }), true);
  assert.equal(caGateEnabled({ MANUALOS_CA_B2B_GATE: 'false' }), true);
  assert.equal(caGateEnabled({ MANUALOS_CA_B2B_GATE: null }), true);
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir, MANUALOS_CA_B2B_GATE: ' 0 ' });
  const mock = createStripe();
  const app = appFor(env, mock.stripe);
  try {
    await withServer(app, async (base) => {
      const response = await postJson(base, '/create-checkout-session', {
        plan: 'starter',
        billingCountry: 'CA',
        caBusinessAttestation: false,
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });
      assert.equal(mock.calls.create.length, 0);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('job and PDF reads require the buyer credential and still refuse an unattested Canadian PDF', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  const starter = setCountry(seedStarter(mock, 'cs_pdf'), 'CA');
  setCountry(seedStarter(mock, 'cs_pdf_other'), 'US');
  const store = createJobStore({
    env,
    directory: path.join(dir, 'jobs'),
    now: () => FIXED,
  });
  const job = store.create({ sessionId: 'cs_pdf' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n%ca\n'));
  job.status = 'succeeded';
  store.persist(job);
  const app = appFor(env, mock.stripe, { jobs: store });
  try {
    await withServer(app, async (base) => {
      const missing = await fetch(`${base}/jobs/${job.id}`);
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).code, 'authorization_required');
      const missingPdf = await fetch(`${base}/jobs/${job.id}/pdf`);
      assert.equal(missingPdf.status, 401);
      assert.equal((await missingPdf.json()).code, 'authorization_required');
      const missingList = await fetch(`${base}/jobs`);
      assert.equal(missingList.status, 401);
      assert.equal((await missingList.json()).code, 'authorization_required');

      const otherPdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_pdf_other' } });
      assert.equal(otherPdf.status, 403);
      assert.equal((await otherPdf.json()).code, 'forbidden');
      const otherStatus = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_pdf_other' } });
      assert.equal(otherStatus.status, 403);
      assert.equal((await otherStatus.json()).code, 'forbidden');

      const denied = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_pdf' } });
      assert.equal(denied.status, 400);
      assert.deepEqual(await denied.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });
      assert.equal(String(denied.headers.get('content-type') || '').includes('application/pdf'), false);
      assert.equal(mock.intents[starter.payment_intent].metadata.manuals_used, '0');
      assert.equal(mock.calls.refunds.length, 0);
      assert.equal(mock.calls.piUpdates.length, 0);

      const status = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_pdf' } });
      assert.equal(status.status, 200);
      const statusBody = await status.json();
      assert.equal(statusBody.status, 'succeeded');
      assert.equal(JSON.stringify(statusBody).includes('cs_pdf'), false);
      const listed = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_pdf' } });
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json()).jobs.map((item) => item.id), [job.id]);

      const verify = await fetch(`${base}/verify-session?session_id=cs_pdf`);
      assert.equal(verify.status, 400);
      assert.deepEqual(await verify.json(), { error: CA_BUSINESS_MESSAGE, code: CA_BUSINESS_CODE });

      const attestations = createCaAttestationStore({ env });
      await attestations.record({
        sessionId: 'cs_pdf',
        billingCountry: 'CA',
        at: AT,
      });

      const granted = await fetch(`${base}/verify-session?session_id=cs_pdf`);
      assert.equal(granted.status, 200);
      assert.deepEqual(await granted.json(), { valid: true, plan: 'starter', remaining: 3, billingIssue: false });

      const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_pdf' } });
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
      assert.equal(mock.intents[starter.payment_intent].metadata.manuals_used, '0');
      assert.equal(mock.calls.refunds.length, 0);
      assert.equal(mock.calls.piUpdates.length, 0);

      const stillMissing = await fetch(`${base}/jobs/${job.id}/pdf`);
      assert.equal(stillMissing.status, 401);
      assert.equal((await stillMissing.json()).code, 'authorization_required');
      const stillOther = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_pdf_other' } });
      assert.equal(stillOther.status, 403);
      assert.equal((await stillOther.json()).code, 'forbidden');
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkout parses the Canadian fields once', async () => {
  const dir = tempDir();
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const mock = createStripe();
  let parses = 0;
  const app = appFor(env, mock.stripe, {
    parseCaCheckoutFields(body) {
      parses += 1;
      return require('../lib/ca-business').parseCaCheckoutFields(body);
    },
  });
  try {
    await withServer(app, async (base) => {
      const rejected = await postJson(base, '/create-checkout-session', { plan: 'starter', billingCountry: 'CA' });
      assert.equal(rejected.status, 400);
      assert.equal(parses, 1);
      assert.equal(mock.calls.create.length, 0);

      const opened = await postJson(base, '/create-checkout-session', {
        plan: 'starter',
        billingCountry: 'CA',
        caBusinessAttestation: true,
        attestationVersion: 'ca-b2b-v1',
      });
      assert.equal(opened.status, 200);
      assert.equal(parses, 2);
      assert.equal(mock.calls.create.length, 1);
    });
    assert.equal(readJsonl(dir, ATTESTATION_FILE).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
