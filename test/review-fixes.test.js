const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Stripe = require('stripe');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const { checkoutParams, PRO_DISPUTE_LOST_MESSAGE, PRO_SUSPENDED_MESSAGE, STARTER_REFUNDED_MESSAGE, STARTER_SUSPENDED_MESSAGE } = require('../lib/billing');
const { refundCheck } = require('../lib/delivery');
const { readPeriodAccess } = require('../lib/period-access');

test.after(() => {
  removeTestJobDirectories();
});

const sdk = new Stripe('sk_test_123');
const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
const PERIOD_START = 1700000000;
const PERIOD_END = PERIOD_START + (30 * 24 * 60 * 60);
const SECRET = 'whsec_test';

function env() {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: SECRET,
    STARTER_CREDITS: '3',
  };
}

function notFound() {
  const err = new Error('missing');
  err.statusCode = 404;
  err.code = 'resource_missing';
  return err;
}

function anthropic() {
  return {
    messages: {
      create: async (body) => {
        const indexes = [...body.messages[0].content.matchAll(/"index":\s*(\d+)/g)].map((match) => Number(match[1]));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              human_title: 'Infeed start',
              purpose: 'Starts the infeed when the guards are closed.',
              inferred: true,
              operator_steps: [{ action: 'Press Start.', expect: 'The infeed runs.' }],
              groups: [{
                unit_numbers: indexes,
                title: 'Infeed start',
                function: 'The infeed runs when start is requested and the guards are closed.',
                conditions: 'Guards closed',
                result: 'Infeed runs',
                housekeeping: false,
                inferred: true,
              }],
              alarms: [],
              applicable_hazard_ids: [],
              interlocks: [],
              what_operator_sees: 'The running lamp is on.',
            }),
          }],
        };
      },
    },
  };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function signedWebhook(base, event) {
  const payload = JSON.stringify(event);
  const header = sdk.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
}

function stripeEvent(id, type, object) {
  return { id, type, data: { object } };
}

async function waitJob(base, id) {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`);
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

function postJob(base, sessionId) {
  const form = new FormData();
  form.set('session_id', sessionId);
  form.set('file', new Blob([L5X]), 'line.L5X');
  return fetch(`${base}/jobs`, { method: 'POST', body: form });
}

function mergeMeta(target, params) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries((params && params.metadata) || {})) {
    if (value === '') delete next[key];
    else next[key] = value;
  }
  return next;
}

function createSubscriptionWorld({ plan = 'pro', cancelFails = 0 } = {}) {
  const subscription = {
    id: 'sub_review',
    status: 'active',
    customer: 'cus_review',
    latest_invoice: 'in_current',
    metadata: { plan },
  };
  const customer = { id: 'cus_review', metadata: {} };
  const invoices = {
    in_current: {
      id: 'in_current',
      status: 'paid',
      subscription: 'sub_review',
      charge: 'ch_current',
      period_start: PERIOD_START,
      period_end: PERIOD_END,
      metadata: {},
    },
    in_old: {
      id: 'in_old',
      status: 'paid',
      subscription: 'sub_review',
      charge: 'ch_old',
      period_start: PERIOD_START - (30 * 24 * 60 * 60),
      period_end: PERIOD_START,
      metadata: {},
    },
  };
  const charges = {
    ch_current: { id: 'ch_current', amount: 7900, amount_refunded: 0, refunded: false, invoice: 'in_current', payment_intent: 'pi_review', metadata: {} },
    ch_old: { id: 'ch_old', amount: 7900, amount_refunded: 0, refunded: false, invoice: 'in_old', payment_intent: 'pi_old', metadata: {} },
  };
  const cancels = [];
  let failsLeft = cancelFails;
  const stripe = {
    webhooks: sdk.webhooks,
    checkout: {
      sessions: {
        retrieve: async (id) => ({
          id,
          metadata: { plan },
          payment_status: 'paid',
          payment_intent: null,
          subscription: 'sub_review',
        }),
      },
    },
    paymentIntents: {
      retrieve: async (id) => ({ id, metadata: { plan } }),
    },
    customers: {
      update: async (id, params) => {
        assert.equal(id, customer.id);
        customer.metadata = mergeMeta(customer.metadata, params);
        return { id, metadata: { ...customer.metadata } };
      },
    },
    charges: {
      retrieve: async (id) => {
        if (!charges[id]) throw notFound();
        return { ...charges[id], metadata: { ...(charges[id].metadata || {}) } };
      },
      update: async (id, params) => {
        charges[id].metadata = mergeMeta(charges[id].metadata, params);
        return { ...charges[id] };
      },
    },
    invoices: {
      retrieve: async (id) => {
        if (!invoices[id]) throw notFound();
        return { ...invoices[id], metadata: { ...(invoices[id].metadata || {}) } };
      },
      update: async (id, params) => {
        invoices[id].metadata = mergeMeta(invoices[id].metadata, params);
        return { ...invoices[id] };
      },
    },
    subscriptions: {
      retrieve: async () => ({
        id: subscription.id,
        status: subscription.status,
        customer: subscription.customer,
        latest_invoice: subscription.latest_invoice,
        metadata: { ...subscription.metadata },
      }),
      update: async (id, params) => {
        assert.deepEqual(Object.keys(params), ['metadata']);
        subscription.metadata = mergeMeta(subscription.metadata, params);
        return { id, status: subscription.status, metadata: { ...subscription.metadata } };
      },
      cancel: async (id, params) => {
        cancels.push(params);
        if (failsLeft > 0) {
          failsLeft -= 1;
          throw new Error('cancel failed');
        }
        subscription.status = 'canceled';
        return { id, status: 'canceled' };
      },
    },
  };
  return { stripe, subscription, customer, cancels, invoices };
}

function renewalInvoice(id, extra = {}) {
  return {
    id,
    status: 'paid',
    subscription: 'sub_review',
    billing_reason: 'subscription_cycle',
    amount_paid: 7900,
    period_start: PERIOD_END,
    period_end: PERIOD_END + (30 * 24 * 60 * 60),
    ...extra,
  };
}

function createStarterWorld(piId, sessionId) {
  const meta = { plan: 'starter', manuals_used: '0', credit_generation: '0', credit_hold: '', created: undefined };
  const intent = { id: piId, created: 1700000000, metadata: meta };
  const stripe = {
    webhooks: sdk.webhooks,
    checkout: {
      sessions: {
        retrieve: async (id) => ({
          id,
          metadata: { plan: 'starter' },
          payment_status: 'paid',
          payment_intent: piId,
          subscription: null,
        }),
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        if (id !== piId) throw notFound();
        return { id, created: intent.created, metadata: { ...intent.metadata } };
      },
      update: async (id, params) => {
        intent.metadata = mergeMeta(intent.metadata, params);
        return { id, created: intent.created, metadata: { ...intent.metadata } };
      },
    },
  };
  return { stripe, intent, sessionId };
}

test('D1 an open dispute stays suspended through a paid renewal', async () => {
  const world = createSubscriptionWorld();
  const app = createApp({ env: env(), stripe: world.stripe, anthropic: null });
  await withServer(app, async (base) => {
    const payload = JSON.stringify(stripeEvent('evt_d1_bad', 'invoice.paid', renewalInvoice('in_ignored')));
    const forged = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: payload,
    });
    assert.equal(forged.status, 400);

    assert.equal((await signedWebhook(base, stripeEvent('evt_d1_open', 'charge.dispute.created', {
      id: 'dp_d1',
      charge: 'ch_current',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'suspended');
    assert.equal((await signedWebhook(base, stripeEvent('evt_d1_paid', 'invoice.paid', renewalInvoice('in_renew')))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'suspended');
    assert.equal(world.subscription.metadata.revoked_dispute_lost, undefined);
    assert.equal(world.subscription.status, 'active');
    assert.equal(world.cancels.length, 0);
    const job = await postJob(base, 'cs_review');
    assert.equal(job.status, 402);
    assert.equal((await job.json()).error, PRO_SUSPENDED_MESSAGE);
  });
});

test('D2 a lost dispute is permanent, cancels without proration, and a retry still cancels', async () => {
  const world = createSubscriptionWorld({ cancelFails: 1 });
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  const app = createApp({ env: env(), stripe: world.stripe, anthropic: null });
  try {
    await withServer(app, async (base) => {
      const lost = stripeEvent('evt_d2_lost', 'charge.dispute.closed', {
        id: 'dp_d2',
        charge: 'ch_current',
        status: 'lost',
      });
      assert.equal((await signedWebhook(base, lost)).status, 500);
      assert.equal(world.subscription.metadata.revoked_dispute_lost, 'true');
      assert.equal(world.customer.metadata.revoked_dispute_lost, undefined);
      assert.equal(world.subscription.status, 'active');
      assert.equal((await signedWebhook(base, lost)).status, 200);
      assert.equal(world.subscription.status, 'canceled');
      assert.deepEqual(world.cancels, [
        { prorate: false, invoice_now: false },
        { prorate: false, invoice_now: false },
      ]);
      assert.equal(world.subscription.metadata.revoked_dispute_lost, 'true');
      assert.equal((await signedWebhook(base, stripeEvent('evt_d2_won', 'charge.dispute.closed', {
        id: 'dp_d2_won',
        charge: 'ch_current',
        status: 'won',
      }))).status, 200);
      assert.equal((await signedWebhook(base, stripeEvent('evt_d2_paid', 'invoice.paid', renewalInvoice('in_after_lost')))).status, 200);
      assert.equal(world.subscription.metadata.period_access, 'revoked');
      assert.equal(world.subscription.metadata.revoked_dispute_lost, 'true');
      assert.equal(world.customer.metadata.revoked_dispute_lost, undefined);
      const job = await postJob(base, 'cs_review');
      assert.equal(job.status, 402);
      assert.equal((await job.json()).error, PRO_DISPUTE_LOST_MESSAGE);
    });
  } finally {
    console.log = original;
  }
  assert.equal(lines.some((line) => line.includes('subscription cancelled after lost dispute sub_review')), true);
  assert.equal(lines.some((line) => line.includes('customer dispute lost flag')), false);
});

test('D3 a dispute on an earlier period blocks access and a refund of that period does not', async () => {
  const world = createSubscriptionWorld();
  const app = createApp({ env: env(), stripe: world.stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await signedWebhook(base, stripeEvent('evt_d3_refund', 'charge.refunded', {
      id: 'ch_old',
      amount: 7900,
      amount_refunded: 7900,
      refunded: true,
      invoice: 'in_old',
      payment_intent: 'pi_old',
    }))).status, 200);
    assert.equal(world.subscription.metadata.period_access, undefined);
    assert.equal((await fetch(`${base}/verify-session?session_id=cs_review`).then((res) => res.json())).valid, true);

    assert.equal((await signedWebhook(base, stripeEvent('evt_d3_open', 'charge.dispute.created', {
      id: 'dp_old',
      charge: 'ch_old',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'suspended');
    assert.equal(world.subscription.metadata.period_invoice, 'in_old');
    const job = await postJob(base, 'cs_review');
    assert.equal(job.status, 402);
    assert.equal((await job.json()).error, PRO_SUSPENDED_MESSAGE);
    assert.equal(world.cancels.length, 0);
  });
});

test('D4 only a paid renewal for a new period reopens a refund', async () => {
  const world = createSubscriptionWorld();
  const app = createApp({
    env: env(),
    stripe: world.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%renewed\n'),
  });
  await withServer(app, async (base) => {
    assert.equal((await signedWebhook(base, stripeEvent('evt_d4_refund', 'charge.refunded', {
      id: 'ch_current',
      amount: 7900,
      amount_refunded: 7900,
      refunded: true,
      invoice: 'in_current',
      payment_intent: 'pi_review',
    }))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'revoked');
    assert.equal(world.subscription.metadata.period_end, String(PERIOD_END));

    const blocked = [
      renewalInvoice('in_zero', { amount_paid: 0 }),
      renewalInvoice('in_manual', { billing_reason: 'manual' }),
      renewalInvoice('in_inside', { billing_reason: 'subscription_update', period_start: PERIOD_START, period_end: PERIOD_END }),
    ];
    for (const invoice of blocked) {
      assert.equal((await signedWebhook(base, stripeEvent(`evt_${invoice.id}`, 'invoice.paid', invoice))).status, 200);
      assert.equal(world.subscription.metadata.period_access, 'revoked');
      assert.equal(world.subscription.metadata.revoked_dispute_lost, undefined);
    }
    assert.equal((await postJob(base, 'cs_review')).status, 402);

    assert.equal((await signedWebhook(base, stripeEvent('evt_d4_open', 'invoice.paid', renewalInvoice('in_renew')))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'active');
    assert.equal(world.subscription.metadata.period_invoice, 'in_renew');
    assert.equal(world.subscription.metadata.revoked_dispute_lost, undefined);
    assert.equal(world.cancels.length, 0);
    assert.equal(world.subscription.status, 'active');
    const generated = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_review' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
    });
    assert.equal(generated.status, 200);
    assert.equal(Buffer.from(await generated.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  });
});

test('D5 a generation in progress is not refund eligible', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { stripe, intent, sessionId } = createStarterWorld('pi_d5', 'cs_d5');
  const app = createApp({
    env: env(),
    stripe,
    anthropic: anthropic(),
    renderPdf: () => gate.then(() => Buffer.from('%PDF-1.4\n%d5\n')),
  });
  await withServer(app, async (base) => {
    const created = await postJob(base, sessionId);
    assert.equal(created.status, 202);
    assert.equal(intent.metadata.manuals_used, '1');
    assert.match(intent.metadata.generation_started_at, /^\d{4}-\d{2}-\d{2}T/);
    const mid = await refundCheck(stripe, 'pi_d5');
    assert.equal(mid.purchases[0].refund_eligible, false);
    assert.equal(
      mid.purchases[0].reason,
      `generation in progress since ${intent.metadata.generation_started_at}; check again after it finishes`,
    );
    release();
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'succeeded');
    const after = await refundCheck(stripe, 'pi_d5');
    assert.equal(after.purchases[0].delivered, true);
    assert.equal(after.purchases[0].refund_eligible, false);
    assert.match(after.purchases[0].reason, /^delivered at /);
  });
});

test('D6 a refund stops an in-flight job and a later download', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const live = createStarterWorld('pi_live', 'cs_live');
  const app = createApp({
    env: env(),
    stripe: live.stripe,
    anthropic: anthropic(),
    renderPdf: () => gate.then(() => Buffer.from('%PDF-1.4\n%live\n')),
  });
  await withServer(app, async (base) => {
    const created = await postJob(base, live.sessionId);
    assert.equal(created.status, 202);
    const job = await created.json();
    assert.equal((await signedWebhook(base, stripeEvent('evt_d6_refund', 'charge.refunded', {
      id: 'ch_live',
      amount: 3900,
      amount_refunded: 3900,
      refunded: true,
      payment_intent: 'pi_live',
    }))).status, 200);
    assert.equal(live.intent.metadata.credit_status, 'revoked');
    release();
    const done = await waitJob(base, job.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, STARTER_REFUNDED_MESSAGE);
    assert.equal((await fetch(`${base}/jobs/${job.id}/pdf`)).status, 409);
    assert.equal(live.intent.metadata.manuals_used, '0');
    assert.equal(live.intent.metadata.credit_status, 'revoked');
  });

  const kept = createStarterWorld('pi_kept', 'cs_kept');
  const keptApp = createApp({
    env: env(),
    stripe: kept.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%kept\n'),
  });
  await withServer(keptApp, async (base) => {
    const created = await postJob(base, kept.sessionId);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'succeeded');
    const first = await fetch(`${base}/jobs/${done.id}/pdf`);
    assert.equal(first.status, 200);
    assert.equal(Buffer.from(await first.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await signedWebhook(base, stripeEvent('evt_d6_open', 'charge.dispute.created', {
      id: 'dp_kept',
      payment_intent: 'pi_kept',
      status: 'needs_response',
    }))).status, 200);
    const blocked = await fetch(`${base}/jobs/${done.id}/pdf`);
    assert.equal(blocked.status, 402);
    assert.equal((await blocked.json()).error, STARTER_SUSPENDED_MESSAGE);
    assert.equal((await signedWebhook(base, stripeEvent('evt_d6_won', 'charge.dispute.closed', {
      id: 'dp_kept',
      payment_intent: 'pi_kept',
      status: 'won',
    }))).status, 200);
    const restored = await fetch(`${base}/jobs/${done.id}/pdf`);
    assert.equal(restored.status, 200);
    assert.equal(Buffer.from(await restored.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  });
});

test('D7 a failed delivery stamp does not serve the manual', async () => {
  const { stripe, intent, sessionId } = createStarterWorld('pi_d7', 'cs_d7');
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map((arg) => String(arg)).join(' '));
  stripe.paymentIntents.update = async (id, params) => {
    if (params.metadata && params.metadata.first_manual_at) throw new Error('stamp write failed sk_test_secretvalue');
    intent.metadata = mergeMeta(intent.metadata, params);
    return { id, metadata: { ...intent.metadata } };
  };
  try {
    await withServer(createApp({
      env: env(),
      stripe,
      anthropic: anthropic(),
      renderPdf: async () => Buffer.from('%PDF-1.4\n%d7\n'),
    }), async (base) => {
      const res = await fetch(`${base}/generate-manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
      });
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(JSON.stringify(body).includes('%PDF'), false);
      assert.equal(JSON.stringify(body).includes('sk_test_'), false);
      assert.equal(intent.metadata.manuals_used, '0');
      assert.equal(Object.hasOwn(intent.metadata, 'first_manual_at'), false);
      assert.equal(Object.hasOwn(intent.metadata, 'generation_started_at'), false);
    });
  } finally {
    console.error = original;
  }
  const logged = errors.join('\n');
  assert.match(logged, /First manual delivery stamp failed/);
  assert.match(logged, /stamp write failed \[redacted\]/);
  assert.equal(logged.includes('sk_test_secretvalue'), false);
});

test('D8 starter checkout creates a customer and email lookup searches sessions', async () => {
  const params = checkoutParams('starter', env());
  assert.equal(params.customer_creation, 'always');
  assert.equal(checkoutParams('pro', env()).customer_creation, undefined);
  const seen = [];
  const stripe = {
    customers: { list: async () => ({ data: [] }) },
    checkout: {
      sessions: {
        list: async (query) => {
          seen.push(query);
          assert.deepEqual(query.customer_details, { email: 'buyer@example.com' });
          return {
            data: [{
              id: 'cs_mail',
              created: 1700000000,
              metadata: { plan: 'starter' },
              payment_intent: 'pi_mail',
            }],
          };
        },
      },
    },
    paymentIntents: {
      retrieve: async () => ({
        id: 'pi_mail',
        created: 1700000000,
        metadata: { plan: 'starter', manuals_used: '0' },
      }),
    },
  };
  const result = await refundCheck(stripe, 'buyer@example.com', { now: new Date((1700000000 + (10 * 24 * 60 * 60)) * 1000) });
  assert.equal(seen.length, 1);
  assert.equal(result.found, true);
  assert.equal(result.purchases[0].id, 'pi_mail');
  assert.equal(result.purchases[0].plan, 'starter');
  assert.equal(result.purchases[0].refund_eligible, true);
  assert.equal(JSON.stringify(result).includes('@'), false);
});

test('D9 integrator subscriptions use the same refund and dispute block', async () => {
  const world = createSubscriptionWorld({ plan: 'integrator' });
  const app = createApp({ env: env(), stripe: world.stripe, anthropic: null });
  await withServer(app, async (base) => {
    const before = await fetch(`${base}/verify-session?session_id=cs_integrator`);
    assert.deepEqual(await before.json(), { valid: true, plan: 'integrator', remaining: null });
    assert.equal((await signedWebhook(base, stripeEvent('evt_d9_open', 'charge.dispute.created', {
      id: 'dp_integrator',
      charge: 'ch_current',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(world.subscription.metadata.plan, 'integrator');
    assert.equal(world.subscription.metadata.period_access, 'suspended');
    const job = await postJob(base, 'cs_integrator');
    assert.equal(job.status, 402);
    assert.equal((await job.json()).error, PRO_SUSPENDED_MESSAGE);
    assert.equal(world.cancels.length, 0);
  });
});

test('D10 an overage credit is removed only when it is still unused', async () => {
  const intents = {
    pi_unused: { metadata: { credits_remaining: '1', manuals_used: '0' } },
    pi_used: { metadata: { credits_remaining: '1', manuals_used: '1' } },
    pi_cycle: { metadata: { credits_remaining: '1', manuals_used: '0' } },
  };
  const sessions = {
    pi_unused: [{ id: 'cs_unused', metadata: { kind: 'overage' } }],
    pi_used: [{ id: 'cs_used', metadata: { purchase: 'overage' } }],
    pi_cycle: [{ id: 'cs_cycle', metadata: { overage: 'true' } }],
  };
  const lines = [];
  const stripe = {
    webhooks: sdk.webhooks,
    checkout: {
      sessions: {
        list: async ({ payment_intent: paymentIntentId }) => ({ data: sessions[paymentIntentId] || [] }),
      },
    },
    paymentIntents: {
      retrieve: async (id) => ({ id, created: 1700000000, metadata: { ...intents[id].metadata } }),
      update: async (id, params) => {
        intents[id].metadata = mergeMeta(intents[id].metadata, params);
        return { id, metadata: { ...intents[id].metadata } };
      },
    },
  };
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await withServer(createApp({ env: env(), stripe, anthropic: null }), async (base) => {
      const before = await refundCheck(stripe, 'pi_unused');
      assert.equal(before.purchases[0].plan, 'overage');
      assert.equal(before.purchases[0].refund_eligible, true);
      assert.equal(before.purchases[0].deadline, null);
      assert.equal(before.purchases[0].reason, 'eligible until the overage credit is used');

      assert.equal((await signedWebhook(base, stripeEvent('evt_d10_refund', 'charge.refunded', {
        id: 'ch_unused',
        amount: 900,
        amount_refunded: 900,
        refunded: true,
        payment_intent: 'pi_unused',
      }))).status, 200);
      assert.equal(intents.pi_unused.metadata.credits_remaining, '0');

      assert.equal((await signedWebhook(base, stripeEvent('evt_d10_used', 'charge.refunded', {
        id: 'ch_used',
        amount: 900,
        amount_refunded: 900,
        refunded: true,
        payment_intent: 'pi_used',
      }))).status, 200);
      assert.equal(intents.pi_used.metadata.credits_remaining, '1');

      assert.equal((await signedWebhook(base, stripeEvent('evt_d10_open', 'charge.dispute.created', {
        id: 'dp_cycle',
        charge: { id: 'ch_cycle', payment_intent: 'pi_cycle' },
        status: 'needs_response',
      }))).status, 200);
      assert.equal(intents.pi_cycle.metadata.credit_status, 'suspended');
      assert.equal(intents.pi_cycle.metadata.credits_remaining, '1');
      assert.equal((await signedWebhook(base, stripeEvent('evt_d10_won', 'charge.dispute.closed', {
        id: 'dp_cycle',
        charge: { id: 'ch_cycle', payment_intent: 'pi_cycle' },
        status: 'won',
      }))).status, 200);
      assert.equal(intents.pi_cycle.metadata.credit_status, 'active');
      assert.equal((await signedWebhook(base, stripeEvent('evt_d10_lost', 'charge.dispute.closed', {
        id: 'dp_cycle_lost',
        charge: { id: 'ch_cycle', payment_intent: 'pi_cycle' },
        status: 'lost',
      }))).status, 200);
      assert.equal(intents.pi_cycle.metadata.credits_remaining, '0');
      const used = await refundCheck(stripe, 'pi_cycle');
      assert.equal(used.purchases[0].plan, 'overage');
      assert.equal(used.purchases[0].refund_eligible, false);
      assert.equal(used.purchases[0].reason, 'overage credit already used');
      const spent = await refundCheck(stripe, 'pi_used');
      assert.equal(spent.purchases[0].plan, 'overage');
      assert.equal(spent.purchases[0].refund_eligible, false);
      assert.equal(spent.purchases[0].reason, 'overage credit already used');
    });
  } finally {
    console.log = original;
  }
  assert.equal(lines.some((line) => line.includes('overage credit already used pi_used')), true);
});

test('an open dispute count keeps access suspended when the id list was truncated', () => {
  assert.equal(readPeriodAccess({ metadata: { open_dispute_count: '1', open_disputes: '' } }), 'suspended');
});

test('N1a one won dispute does not clear another open dispute', async () => {
  const world = createSubscriptionWorld();
  const app = createApp({ env: env(), stripe: world.stripe, anthropic: null });
  await withServer(app, async (base) => {
    for (const id of ['dp_n1a_1', 'dp_n1a_2']) {
      assert.equal((await signedWebhook(base, stripeEvent(`evt_${id}_open`, 'charge.dispute.created', {
        id,
        charge: 'ch_current',
        status: 'needs_response',
      }))).status, 200);
    }
    assert.equal(world.subscription.metadata.open_dispute_count, '2');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n1a_won', 'charge.dispute.closed', {
      id: 'dp_n1a_1',
      charge: 'ch_current',
      status: 'won',
    }))).status, 200);
    assert.equal(world.subscription.metadata.open_dispute_count, '1');
    assert.equal(readPeriodAccess(world.subscription), 'suspended');
    const still = await postJob(base, 'cs_review');
    assert.equal(still.status, 402);
    assert.equal((await still.json()).error, PRO_SUSPENDED_MESSAGE);
    assert.equal((await signedWebhook(base, stripeEvent('evt_n1a_won_2', 'charge.dispute.closed', {
      id: 'dp_n1a_2',
      charge: 'ch_current',
      status: 'won',
    }))).status, 200);
    assert.equal(world.subscription.metadata.open_dispute_count, '0');
    assert.equal(world.subscription.metadata.period_access, 'active');
    assert.equal((await fetch(`${base}/verify-session?session_id=cs_review`).then((res) => res.json())).valid, true);
  });
});

test('N1b a renewal after a refund does not clear an open dispute', async () => {
  const world = createSubscriptionWorld();
  const app = createApp({ env: env(), stripe: world.stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await signedWebhook(base, stripeEvent('evt_n1b_refund', 'charge.refunded', {
      id: 'ch_current',
      amount: 7900,
      amount_refunded: 7900,
      refunded: true,
      invoice: 'in_current',
      payment_intent: 'pi_review',
    }))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'revoked');
    assert.equal(world.subscription.metadata.period_access_reason, 'refund');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n1b_open', 'charge.dispute.created', {
      id: 'dp_n1b',
      charge: 'ch_current',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'revoked');
    assert.equal(world.subscription.metadata.period_access_reason, 'refund');
    assert.equal(world.subscription.metadata.open_dispute_count, '1');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n1b_paid', 'invoice.paid', renewalInvoice('in_n1b')))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'active');
    assert.equal(world.subscription.metadata.period_access_reason, undefined);
    assert.equal(world.subscription.metadata.open_dispute_count, '1');
    assert.equal(readPeriodAccess(world.subscription), 'suspended');
    const job = await postJob(base, 'cs_review');
    assert.equal(job.status, 402);
    assert.equal((await job.json()).error, PRO_SUSPENDED_MESSAGE);
  });
});

test('N1c a renewal after a dispute and a refund does not clear the dispute', async () => {
  const world = createSubscriptionWorld();
  const app = createApp({ env: env(), stripe: world.stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await signedWebhook(base, stripeEvent('evt_n1c_open', 'charge.dispute.created', {
      id: 'dp_n1c',
      charge: 'ch_current',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'suspended');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n1c_refund', 'charge.refunded', {
      id: 'ch_current',
      amount: 7900,
      amount_refunded: 7900,
      refunded: true,
      invoice: 'in_current',
      payment_intent: 'pi_review',
    }))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'revoked');
    assert.equal(world.subscription.metadata.period_access_reason, 'refund');
    assert.equal(world.subscription.metadata.open_dispute_count, '1');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n1c_paid', 'invoice.paid', renewalInvoice('in_n1c')))).status, 200);
    assert.equal(world.subscription.metadata.period_access, 'active');
    assert.equal(world.subscription.metadata.open_dispute_count, '1');
    assert.equal(readPeriodAccess(world.subscription), 'suspended');
    const job = await postJob(base, 'cs_review');
    assert.equal(job.status, 402);
    assert.equal((await job.json()).error, PRO_SUSPENDED_MESSAGE);
  });
});

function overageCheckoutParams(env, { subscriptionId, customerId, sessionId }) {
  const price = env.MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE;
  const base = env.FRONTEND_URL;
  const params = {
    mode: 'payment',
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/upload.html?session_id=${encodeURIComponent(sessionId)}`,
    cancel_url: `${base}/#pricing`,
    client_reference_id: subscriptionId,
    metadata: {
      plan: 'integrator_overage',
      subscription_id: subscriptionId,
      subscription_session_id: sessionId,
    },
    payment_intent_data: {
      metadata: {
        plan: 'integrator_overage',
        subscription_id: subscriptionId,
      },
    },
  };
  if (customerId) params.customer = customerId;
  return params;
}

test('N2 integrator overage uses plan integrator_overage and overage_remaining', async () => {
  const checkoutEnv = {
    ...env(),
    MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: 'price_integrator_overage',
  };
  const params = overageCheckoutParams(checkoutEnv, {
    subscriptionId: 'sub_over',
    customerId: 'cus_over',
    sessionId: 'cs_integrator',
  });
  const subscription = {
    id: 'sub_over',
    status: 'active',
    metadata: { plan: 'integrator', overage_remaining: '1', manuals_used: '2' },
  };
  const intent = { metadata: { ...params.payment_intent_data.metadata } };
  const intents = {
    pi_over: intent,
    pi_over_lost: { metadata: { ...params.payment_intent_data.metadata } },
  };
  const stripe = {
    webhooks: sdk.webhooks,
    checkout: {
      sessions: {
        list: async ({ payment_intent: paymentIntentId }) => ({
          data: intents[paymentIntentId] ? [{ id: 'cs_over', metadata: params.metadata }] : [],
        }),
      },
    },
    paymentIntents: {
      retrieve: async (id) => ({ id, created: 1700000000, metadata: { ...(intents[id] ? intents[id].metadata : {}) } }),
      update: async (id, update) => {
        intents[id].metadata = mergeMeta(intents[id].metadata, update);
        return { id, metadata: { ...intents[id].metadata } };
      },
    },
    subscriptions: {
      retrieve: async (id) => {
        assert.equal(id, subscription.id);
        return { id, status: subscription.status, metadata: { ...subscription.metadata } };
      },
      update: async (id, update) => {
        assert.equal(id, subscription.id);
        assert.deepEqual(Object.keys(update), ['metadata']);
        subscription.metadata = mergeMeta(subscription.metadata, update);
        return { id, metadata: { ...subscription.metadata } };
      },
    },
  };
  const app = createApp({ env: env(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    const before = await refundCheck(stripe, 'pi_over');
    assert.equal(before.purchases[0].plan, 'overage');
    assert.equal(before.purchases[0].refund_eligible, true);
    assert.equal(before.purchases[0].deadline, null);
    assert.equal(before.purchases[0].reason, 'eligible until the overage credit is used');

    const refund = (id) => stripeEvent(id, 'charge.refunded', {
      id: 'ch_over',
      amount: 900,
      amount_refunded: 900,
      refunded: true,
      payment_intent: 'pi_over',
    });
    assert.equal((await signedWebhook(base, refund('evt_n2_refund'))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '0');
    assert.equal(subscription.metadata.manuals_used, '2');
    assert.equal(intent.metadata.credits_remaining, undefined);
    assert.equal((await signedWebhook(base, refund('evt_n2_refund_again'))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '0');
    const spent = await refundCheck(stripe, 'pi_over');
    assert.equal(spent.purchases[0].plan, 'overage');
    assert.equal(spent.purchases[0].refund_eligible, false);
    assert.equal(spent.purchases[0].reason, 'overage credit already used');

    subscription.metadata.overage_remaining = '1';
    assert.equal((await signedWebhook(base, stripeEvent('evt_n2_open', 'charge.dispute.created', {
      id: 'dp_n2',
      charge: { id: 'ch_over', payment_intent: 'pi_over' },
      status: 'needs_response',
    }))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '1');
    assert.equal(subscription.metadata.overage_suspended, 'true');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n2_won', 'charge.dispute.closed', {
      id: 'dp_n2',
      charge: { id: 'ch_over', payment_intent: 'pi_over' },
      status: 'won',
    }))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '1');
    assert.equal(subscription.metadata.overage_suspended, undefined);
    assert.equal((await signedWebhook(base, stripeEvent('evt_n2_lost', 'charge.dispute.closed', {
      id: 'dp_n2_lost',
      charge: { id: 'ch_over_lost', payment_intent: 'pi_over_lost' },
      status: 'lost',
    }))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '0');
    assert.equal(subscription.metadata.manuals_used, '2');
    const afterLost = await refundCheck(stripe, 'pi_over');
    assert.equal(afterLost.purchases[0].refund_eligible, false);
    assert.equal(afterLost.purchases[0].reason, 'overage credit already used');

    subscription.metadata.overage_remaining = '1';
    assert.equal((await signedWebhook(base, stripeEvent('evt_n2_early_won', 'charge.dispute.closed', {
      id: 'dp_n2_early',
      charge: { id: 'ch_over', payment_intent: 'pi_over' },
      status: 'won',
    }))).status, 200);
    assert.equal(subscription.metadata.overage_suspended, undefined);
    assert.equal(subscription.metadata.overage_remaining, '1');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n2_early_open', 'charge.dispute.created', {
      id: 'dp_n2_early',
      charge: { id: 'ch_over', payment_intent: 'pi_over' },
      status: 'needs_response',
    }))).status, 200);
    assert.equal(subscription.metadata.overage_suspended, undefined);
    assert.equal(subscription.metadata.overage_remaining, '1');
  });
});

test('R1 a refund and a lost dispute on the same overage purchase decrement once', async () => {
  const checkoutEnv = {
    ...env(),
    MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: 'price_integrator_overage',
  };
  const params = overageCheckoutParams(checkoutEnv, {
    subscriptionId: 'sub_r1',
    customerId: 'cus_r1',
    sessionId: 'cs_r1',
  });
  const subscription = {
    id: 'sub_r1',
    status: 'active',
    metadata: { plan: 'integrator', overage_remaining: '2' },
  };
  const intents = {
    pi_a: { metadata: { ...params.payment_intent_data.metadata } },
    pi_b: { metadata: { ...params.payment_intent_data.metadata } },
    pi_pool: { metadata: { credits_remaining: '2', manuals_used: '0' } },
  };
  const stripe = {
    webhooks: sdk.webhooks,
    checkout: {
      sessions: {
        list: async ({ payment_intent: paymentIntentId }) => {
          if (paymentIntentId === 'pi_pool') return { data: [{ id: 'cs_pool', metadata: { kind: 'overage' } }] };
          if (!intents[paymentIntentId] || paymentIntentId === 'pi_pool') return { data: [] };
          return { data: [{ id: `cs_${paymentIntentId}`, metadata: params.metadata }] };
        },
      },
    },
    paymentIntents: {
      retrieve: async (id) => ({ id, created: 1700000000, metadata: { ...intents[id].metadata } }),
      update: async (id, update) => {
        intents[id].metadata = mergeMeta(intents[id].metadata, update);
        return { id, metadata: { ...intents[id].metadata } };
      },
    },
    subscriptions: {
      retrieve: async () => ({ id: subscription.id, status: subscription.status, metadata: { ...subscription.metadata } }),
      update: async (id, update) => {
        assert.equal(id, subscription.id);
        subscription.metadata = mergeMeta(subscription.metadata, update);
        return { id, metadata: { ...subscription.metadata } };
      },
    },
  };
  const refund = (id, paymentIntentId, chargeId) => stripeEvent(id, 'charge.refunded', {
    id: chargeId,
    amount: 900,
    amount_refunded: 900,
    refunded: true,
    payment_intent: paymentIntentId,
  });
  const lost = (id, paymentIntentId, chargeId, disputeId) => stripeEvent(id, 'charge.dispute.closed', {
    id: disputeId,
    charge: { id: chargeId, payment_intent: paymentIntentId },
    status: 'lost',
  });
  await withServer(createApp({ env: env(), stripe, anthropic: null }), async (base) => {
    assert.equal((await signedWebhook(base, refund('evt_r1_refund', 'pi_a', 'ch_a'))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '1');
    assert.equal(intents.pi_a.metadata.overage_removed, '1');
    assert.equal((await signedWebhook(base, lost('evt_r1_lost', 'pi_a', 'ch_a', 'dp_r1'))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '1');
    assert.equal((await signedWebhook(base, refund('evt_r1_refund_again', 'pi_a', 'ch_a'))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '1');
    assert.equal((await signedWebhook(base, refund('evt_r1_other', 'pi_b', 'ch_b'))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, '0');
    assert.equal(intents.pi_b.metadata.overage_removed, '1');

    assert.equal((await signedWebhook(base, refund('evt_r1_pool_refund', 'pi_pool', 'ch_pool'))).status, 200);
    assert.equal(intents.pi_pool.metadata.credits_remaining, '1');
    assert.equal(intents.pi_pool.metadata.overage_removed, '1');
    assert.equal((await signedWebhook(base, lost('evt_r1_pool_lost', 'pi_pool', 'ch_pool', 'dp_pool'))).status, 200);
    assert.equal(intents.pi_pool.metadata.credits_remaining, '1');
  });
});

test('R1j the removal marker is written before the decrement and a rolled list does not decrement again', async () => {
  const checkoutEnv = {
    ...env(),
    MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: 'price_integrator_overage',
  };
  const params = overageCheckoutParams(checkoutEnv, {
    subscriptionId: 'sub_r1j',
    customerId: 'cus_r1j',
    sessionId: 'cs_r1j',
  });
  const subscription = {
    id: 'sub_r1j',
    status: 'active',
    metadata: { plan: 'integrator', overage_remaining: '40' },
  };
  const intents = {};
  const original = `pi_${'A'.repeat(40)}`;
  intents[original] = { metadata: { ...params.payment_intent_data.metadata } };
  const stripe = {
    webhooks: sdk.webhooks,
    checkout: {
      sessions: {
        list: async ({ payment_intent: paymentIntentId }) => {
          if (!intents[paymentIntentId]) return { data: [] };
          return { data: [{ id: `cs_${paymentIntentId}`, metadata: params.metadata }] };
        },
      },
    },
    paymentIntents: {
      retrieve: async (id) => ({ id, created: 1700000000, metadata: { ...intents[id].metadata } }),
      update: async (id, update) => {
        intents[id].metadata = mergeMeta(intents[id].metadata, update);
        return { id, metadata: { ...intents[id].metadata } };
      },
    },
    subscriptions: {
      retrieve: async () => ({ id: subscription.id, status: subscription.status, metadata: { ...subscription.metadata } }),
      update: async (id, update) => {
        assert.equal(id, subscription.id);
        const noted = update.metadata && update.metadata.overage_removed_intents;
        const nextCount = update.metadata && update.metadata.overage_remaining;
        if (noted && nextCount) {
          const newest = String(noted).split(',').filter(Boolean).pop();
          assert.equal(intents[newest].metadata.overage_removed, '1');
        }
        subscription.metadata = mergeMeta(subscription.metadata, update);
        return { id, metadata: { ...subscription.metadata } };
      },
    },
  };
  const write = stripe.paymentIntents.update;
  let failed = 0;
  stripe.paymentIntents.update = async (id, update) => {
    if (id === original && update.metadata && update.metadata.overage_removed && failed === 0) {
      failed += 1;
      throw new Error('api_connection_error');
    }
    return write(id, update);
  };
  const refund = (n, paymentIntentId) => stripeEvent(`evt_r1j_${n}`, 'charge.refunded', {
    id: `ch_${paymentIntentId}`,
    amount: 900,
    amount_refunded: 900,
    refunded: true,
    payment_intent: paymentIntentId,
  });
  await withServer(createApp({ env: env(), stripe, anthropic: null }), async (base) => {
    assert.equal((await signedWebhook(base, refund(0, original))).status, 200);
    assert.equal(failed, 1);
    assert.equal(intents[original].metadata.overage_removed, '1');
    assert.equal(subscription.metadata.overage_remaining, '39');
    for (let i = 0; i < 25; i += 1) {
      const id = `pi_${String.fromCharCode(66 + (i % 20))}${'B'.repeat(20)}${i}`;
      intents[id] = { metadata: { ...params.payment_intent_data.metadata } };
      assert.equal((await signedWebhook(base, refund(i + 1, id))).status, 200);
    }
    assert.equal(String(subscription.metadata.overage_removed_intents || '').includes(original), false);
    const before = subscription.metadata.overage_remaining;
    assert.equal(before, '14');
    assert.equal((await signedWebhook(base, stripeEvent('evt_r1j_lost', 'charge.dispute.closed', {
      id: 'dp_r1j',
      charge: { id: `ch_${original}`, payment_intent: original },
      status: 'lost',
    }))).status, 200);
    assert.equal(subscription.metadata.overage_remaining, before);
    assert.equal(intents[original].metadata.overage_removed, '1');
  });
});

test('a removal marker that never writes does not decrement the overage pool', async () => {
  const checkoutEnv = {
    ...env(),
    MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: 'price_integrator_overage',
  };
  const params = overageCheckoutParams(checkoutEnv, {
    subscriptionId: 'sub_r1j_fail',
    customerId: 'cus_r1j_fail',
    sessionId: 'cs_r1j_fail',
  });
  const subscription = {
    id: 'sub_r1j_fail',
    status: 'active',
    metadata: { plan: 'integrator', overage_remaining: '40' },
  };
  const intent = { metadata: { ...params.payment_intent_data.metadata } };
  let writes = 0;
  const stripe = {
    webhooks: sdk.webhooks,
    checkout: {
      sessions: {
        list: async () => ({ data: [{ id: 'cs_r1j_fail_pi', metadata: params.metadata }] }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_r1j_fail', created: 1700000000, metadata: { ...intent.metadata } }),
      update: async () => {
        writes += 1;
        throw new Error('api_connection_error');
      },
    },
    subscriptions: {
      retrieve: async () => ({ id: subscription.id, status: subscription.status, metadata: { ...subscription.metadata } }),
      update: async () => {
        throw new Error('subscription should not change');
      },
    },
  };
  await withServer(createApp({ env: env(), stripe, anthropic: null }), async (base) => {
    const res = await signedWebhook(base, stripeEvent('evt_r1j_fail', 'charge.refunded', {
      id: 'ch_r1j_fail',
      amount: 900,
      amount_refunded: 900,
      refunded: true,
      payment_intent: 'pi_r1j_fail',
    }));
    assert.equal(res.status, 500);
    assert.equal(writes, 3);
    assert.equal(subscription.metadata.overage_remaining, '40');
    assert.equal(intent.metadata.overage_removed, undefined);
  });
});

test('N3 a dispute closed before it opens does not suspend the buyer', async () => {
  const world = createSubscriptionWorld();
  const { stripe, intent, sessionId } = createStarterWorld('pi_n3', 'cs_n3');
  const app = createApp({ env: env(), stripe: world.stripe, anthropic: null });
  const starterApp = createApp({ env: env(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await signedWebhook(base, stripeEvent('evt_n3_won', 'charge.dispute.closed', {
      id: 'dp_n3',
      charge: 'ch_current',
      status: 'won',
    }))).status, 200);
    assert.equal(world.subscription.metadata.closed_disputes, 'dp_n3');
    assert.equal(world.subscription.metadata.open_dispute_count, '0');
    assert.equal(readPeriodAccess(world.subscription), 'active');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n3_open', 'charge.dispute.created', {
      id: 'dp_n3',
      charge: 'ch_current',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(world.subscription.metadata.open_dispute_count, '0');
    assert.equal(readPeriodAccess(world.subscription), 'active');
    assert.equal((await fetch(`${base}/verify-session?session_id=cs_review`).then((res) => res.json())).valid, true);
  });
  await withServer(starterApp, async (base) => {
    assert.equal((await signedWebhook(base, stripeEvent('evt_n3s_won', 'charge.dispute.closed', {
      id: 'dp_n3s',
      payment_intent: 'pi_n3',
      status: 'won',
    }))).status, 200);
    assert.equal(intent.metadata.credit_status, undefined);
    assert.equal(intent.metadata.credit_closed_disputes, 'dp_n3s');
    assert.equal((await signedWebhook(base, stripeEvent('evt_n3s_open', 'charge.dispute.created', {
      id: 'dp_n3s',
      payment_intent: 'pi_n3',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(intent.metadata.credit_status, undefined);
    assert.equal((await fetch(`${base}/verify-session?session_id=${sessionId}`).then((res) => res.json())).valid, true);
  });
});

test('N5 a lost dispute revokes only that purchase and a new checkout stays active', async () => {
  const customer = { id: 'cus_same', metadata: {} };
  const customerUpdates = [];
  const subscriptions = {
    sub_a: { id: 'sub_a', status: 'active', customer: customer.id, latest_invoice: 'in_a', metadata: { plan: 'pro' } },
    sub_b: { id: 'sub_b', status: 'active', customer: customer.id, latest_invoice: 'in_b', metadata: { plan: 'integrator' } },
  };
  const intents = {
    pi_a: { metadata: { plan: 'starter', manuals_used: '0' } },
    pi_b: { metadata: { plan: 'starter', manuals_used: '0' } },
  };
  const invoices = {
    in_a: { id: 'in_a', status: 'paid', subscription: 'sub_a', charge: 'ch_a', metadata: {} },
  };
  const charges = {
    ch_a: { id: 'ch_a', invoice: 'in_a', payment_intent: 'pi_sub_a', amount: 7900, amount_refunded: 0, refunded: false, metadata: {} },
  };
  const stripe = {
    webhooks: sdk.webhooks,
    customers: {
      update: async (id, params) => {
        customerUpdates.push({ id, metadata: params.metadata });
        customer.metadata = mergeMeta(customer.metadata, params);
        return { id, metadata: { ...customer.metadata } };
      },
    },
    checkout: {
      sessions: {
        retrieve: async (id) => {
          const rows = {
            cs_a: { metadata: { plan: 'pro' }, payment_intent: null, subscription: 'sub_a' },
            cs_b: { metadata: { plan: 'integrator' }, payment_intent: null, subscription: 'sub_b' },
            cs_starter_a: { metadata: { plan: 'starter' }, payment_intent: 'pi_a', subscription: null },
            cs_starter_b: { metadata: { plan: 'starter' }, payment_intent: 'pi_b', subscription: null },
          };
          if (!rows[id]) throw notFound();
          return { id, payment_status: 'paid', ...rows[id] };
        },
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        if (!intents[id]) throw notFound();
        return { id, metadata: { ...intents[id].metadata } };
      },
      update: async (id, params) => {
        intents[id].metadata = mergeMeta(intents[id].metadata, params);
        return { id, metadata: { ...intents[id].metadata } };
      },
    },
    charges: {
      retrieve: async (id) => {
        if (!charges[id]) throw notFound();
        return { ...charges[id] };
      },
    },
    invoices: {
      retrieve: async (id) => {
        if (!invoices[id]) throw notFound();
        return { ...invoices[id] };
      },
    },
    subscriptions: {
      retrieve: async (id) => {
        if (!subscriptions[id]) throw notFound();
        const row = subscriptions[id];
        return { id, status: row.status, customer: row.customer, latest_invoice: row.latest_invoice, metadata: { ...row.metadata } };
      },
      update: async (id, params) => {
        assert.deepEqual(Object.keys(params), ['metadata']);
        subscriptions[id].metadata = mergeMeta(subscriptions[id].metadata, params);
        return { id, metadata: { ...subscriptions[id].metadata } };
      },
      cancel: async (id, params) => {
        assert.deepEqual(params, { prorate: false, invoice_now: false });
        subscriptions[id].status = 'canceled';
        return { id, status: 'canceled' };
      },
    },
  };
  const app = createApp({ env: env(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await signedWebhook(base, stripeEvent('evt_n5_sub', 'charge.dispute.closed', {
      id: 'dp_n5_sub',
      charge: 'ch_a',
      status: 'lost',
    }))).status, 200);
    assert.equal(subscriptions.sub_a.metadata.revoked_dispute_lost, 'true');
    assert.equal(subscriptions.sub_a.metadata.period_access, 'revoked');
    assert.equal(subscriptions.sub_a.status, 'canceled');
    assert.equal(subscriptions.sub_b.metadata.revoked_dispute_lost, undefined);
    assert.equal(subscriptions.sub_b.status, 'active');
    assert.equal((await fetch(`${base}/verify-session?session_id=cs_a`).then((res) => res.json())).valid, false);
    const fresh = await fetch(`${base}/verify-session?session_id=cs_b`).then((res) => res.json());
    assert.deepEqual(fresh, { valid: true, plan: 'integrator', remaining: null });

    assert.equal((await signedWebhook(base, stripeEvent('evt_n5_starter', 'charge.dispute.closed', {
      id: 'dp_n5_starter',
      payment_intent: 'pi_a',
      status: 'lost',
    }))).status, 200);
    assert.equal(intents.pi_a.metadata.credit_status, 'revoked');
    assert.equal(intents.pi_a.metadata.credit_revoke_reason, 'dispute');
    assert.equal(intents.pi_b.metadata.credit_status, undefined);
    assert.equal((await fetch(`${base}/verify-session?session_id=cs_starter_a`).then((res) => res.json())).valid, false);
    const starterFresh = await fetch(`${base}/verify-session?session_id=cs_starter_b`).then((res) => res.json());
    assert.deepEqual(starterFresh, { valid: true, plan: 'starter', remaining: 3 });
    assert.deepEqual(customer.metadata, {});
    assert.equal(customerUpdates.length, 0);
  });
});

test('N6 a generate-manual failure after the stamp does not leave the purchase delivered', async () => {
  const intent = { metadata: { plan: 'starter', manuals_used: '0' } };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => ({
          id,
          metadata: { plan: 'starter' },
          payment_status: 'paid',
          payment_intent: 'pi_n6',
          subscription: null,
        }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_n6', metadata: { ...intent.metadata } }),
      update: async (id, params) => {
        if (params.metadata && params.metadata.manuals_used) {
          const err = new Error('record failed sk_test_should_not_leak');
          throw err;
        }
        intent.metadata = mergeMeta(intent.metadata, params);
        return { id, metadata: { ...intent.metadata } };
      },
    },
  };
  const app = createApp({
    env: env(),
    stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%n6\n'),
  });
  await withServer(app, async (base) => {
    const failed = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_n6' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
    });
    const body = await failed.text();
    assert.equal(failed.status, 500);
    assert.equal(body.includes('%PDF'), false);
    assert.equal(body.includes('sk_test_'), false);
    assert.equal(intent.metadata.first_manual_at, undefined);
    assert.equal(intent.metadata.manuals_used, '0');
    assert.equal(intent.metadata.generation_started_at, undefined);

    intent.metadata.first_manual_at = '2026-01-01T00:00:00.000Z';
    const again = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_n6' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
    });
    assert.equal(again.status, 500);
    assert.equal(intent.metadata.first_manual_at, '2026-01-01T00:00:00.000Z');
  });
});

test('a malformed support query prints usage and exits 1', () => {
  const result = spawnSync(process.execPath, ['scripts/support-refund-check.js', 'not-a-query'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, STRIPE_SECRET_KEY: 'sk_test_should_not_be_called' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: npm run support:refund-check/);
  assert.equal(String(result.stdout || '').includes('sk_test_'), false);
});
