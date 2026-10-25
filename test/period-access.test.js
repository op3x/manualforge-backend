const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const { PRO_DISPUTE_LOST_MESSAGE, PRO_REFUNDED_MESSAGE, PRO_SUSPENDED_MESSAGE } = require('../lib/billing');
const { restoresAccess } = require('../lib/dispute-outcome');

test.after(() => {
  removeTestJobDirectories();
});

const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));

function env() {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
  };
}

function notFound() {
  const err = new Error('missing');
  err.statusCode = 404;
  err.code = 'resource_missing';
  return err;
}

function createProStripe() {
  const periodStart = 1700000000;
  const periodEnd = periodStart + (30 * 24 * 60 * 60);
  const subscription = {
    id: 'sub_pro',
    status: 'active',
    customer: 'cus_pro',
    latest_invoice: 'in_current',
    metadata: { plan: 'pro' },
  };
  const customer = { id: 'cus_pro', metadata: {} };
  const invoices = {
    in_current: {
      id: 'in_current',
      status: 'paid',
      subscription: 'sub_pro',
      charge: 'ch_current',
      period_start: periodStart,
      period_end: periodEnd,
      metadata: {},
    },
    in_next: {
      id: 'in_next',
      status: 'paid',
      subscription: 'sub_pro',
      charge: 'ch_next',
      period_start: periodEnd,
      period_end: periodEnd + (30 * 24 * 60 * 60),
      billing_reason: 'subscription_cycle',
      amount_paid: 7900,
      metadata: {},
    },
    in_old: {
      id: 'in_old',
      status: 'paid',
      subscription: 'sub_pro',
      charge: 'ch_old',
      metadata: {},
    },
  };
  const charges = {
    ch_current: { id: 'ch_current', amount: 7900, amount_refunded: 0, refunded: false, invoice: 'in_current', payment_intent: 'pi_pro' },
    ch_next: { id: 'ch_next', amount: 7900, amount_refunded: 0, refunded: false, invoice: 'in_next', payment_intent: 'pi_next' },
    ch_old: { id: 'ch_old', amount: 7900, amount_refunded: 7900, refunded: true, invoice: 'in_old', payment_intent: 'pi_old' },
  };
  const intents = {
    pi_pro: { id: 'pi_pro', metadata: { plan: 'pro' } },
    pi_next: { id: 'pi_next', metadata: { plan: 'pro' } },
    pi_old: { id: 'pi_old', metadata: { plan: 'pro' } },
  };
  const subUpdates = [];
  const cancels = [];
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => ({
          id,
          metadata: { plan: 'pro' },
          payment_status: 'paid',
          payment_intent: null,
          subscription: 'sub_pro',
        }),
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        if (!intents[id]) throw notFound();
        return intents[id];
      },
    },
    charges: {
      retrieve: async (id) => {
        if (!charges[id]) throw notFound();
        return { ...charges[id], metadata: { ...(charges[id].metadata || {}) } };
      },
      update: async (id, params) => {
        if (!charges[id]) throw notFound();
        charges[id].metadata = { ...(charges[id].metadata || {}), ...(params.metadata || {}) };
        return { ...charges[id] };
      },
    },
    invoices: {
      retrieve: async (id) => {
        if (!invoices[id]) throw notFound();
        return { ...invoices[id], metadata: { ...(invoices[id].metadata || {}) } };
      },
      update: async (id, params) => {
        if (!invoices[id]) throw notFound();
        invoices[id].metadata = { ...(invoices[id].metadata || {}), ...(params.metadata || {}) };
        return { ...invoices[id] };
      },
    },
    customers: {
      update: async (id, params) => {
        if (id !== customer.id) throw notFound();
        customer.metadata = { ...(customer.metadata || {}), ...(params.metadata || {}) };
        return { id, metadata: { ...customer.metadata } };
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
        subUpdates.push(JSON.parse(JSON.stringify(params)));
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete subscription.metadata[key];
          else subscription.metadata[key] = value;
        }
        return { id, status: subscription.status, metadata: { ...subscription.metadata } };
      },
      cancel: async (id, params) => {
        cancels.push(params);
        subscription.status = 'canceled';
        return { id, status: 'canceled' };
      },
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') throw new Error('bad signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
  return { stripe, subscription, subUpdates, cancels, invoices, customer, periodEnd };
}

function event(id, type, object) {
  return { id, type, data: { object } };
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

async function postWebhook(base, payload) {
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
    body: JSON.stringify(payload),
  });
}

async function postJob(base) {
  const form = new FormData();
  form.set('session_id', 'cs_pro');
  form.set('file', new Blob([L5X]), 'line.L5X');
  return fetch(`${base}/jobs`, { method: 'POST', body: form });
}

async function postGenerate(base) {
  return fetch(`${base}/generate-manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_pro' },
    body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
  });
}

function assertMetadataOnly(updates) {
  for (const update of updates) {
    assert.deepEqual(Object.keys(update), ['metadata']);
    assert.equal(update.status, undefined);
    assert.equal(update.cancel_at_period_end, undefined);
  }
}

test('a full pro refund blocks the period until a new paid invoice and does not cancel', async () => {
  const { stripe, subscription, subUpdates, cancels } = createProStripe();
  const app = createApp({
    env: env(),
    stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%pro\n'),
  });
  await withServer(app, async (base) => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const refunded = await postWebhook(base, event('evt_refund', 'charge.refunded', {
        id: 'ch_current',
        amount: 7900,
        amount_refunded: 7900,
        refunded: true,
        invoice: 'in_current',
        payment_intent: 'pi_pro',
      }));
      assert.equal(refunded.status, 200);
      assert.equal((await postWebhook(base, event('evt_refund', 'charge.refunded', {
        id: 'ch_current',
        amount: 7900,
        amount_refunded: 7900,
        refunded: true,
        invoice: 'in_current',
        payment_intent: 'pi_pro',
      }))).status, 200);
    } finally {
      console.log = original;
    }
    assert.equal(subscription.status, 'active');
    assert.equal(subscription.metadata.period_access, 'revoked');
    assert.equal(subscription.metadata.period_invoice, 'in_current');
    assert.equal(subscription.metadata.period_access_reason, 'refund');
    assert.equal(cancels.length, 0);
    assertMetadataOnly(subUpdates);
    assert.equal(subUpdates.length, 1);
    assert.equal(lines.filter((line) => line.includes('subscription period revoked')).length, 1);

    const verified = await fetch(`${base}/verify-session?session_id=cs_pro`);
    assert.deepEqual(await verified.json(), { valid: false, plan: 'pro', remaining: null });
    const job = await postJob(base);
    assert.equal(job.status, 402);
    assert.equal((await job.json()).error, PRO_REFUNDED_MESSAGE);
    const legacy = await postGenerate(base);
    assert.equal(legacy.status, 402);
    assert.equal((await legacy.json()).error, PRO_REFUNDED_MESSAGE);

    assert.equal((await postWebhook(base, event('evt_same', 'invoice.paid', {
      id: 'in_current',
      status: 'paid',
      subscription: 'sub_pro',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, 'revoked');
    assert.equal((await postJob(base)).status, 402);

    assert.equal((await postWebhook(base, event('evt_next', 'invoice.paid', {
      id: 'in_next',
      status: 'paid',
      subscription: 'sub_pro',
      billing_reason: 'subscription_cycle',
      amount_paid: 7900,
      period_start: 1700000000 + (30 * 24 * 60 * 60),
      period_end: 1700000000 + (60 * 24 * 60 * 60),
    }))).status, 200);
    assert.equal(subscription.status, 'active');
    assert.equal(subscription.metadata.period_access, 'active');
    assert.equal(subscription.metadata.period_invoice, 'in_next');
    assert.equal(cancels.length, 0);
    const opened = await fetch(`${base}/verify-session?session_id=cs_pro`);
    assert.deepEqual(await opened.json(), { valid: true, plan: 'pro', remaining: null });
    const generated = await postGenerate(base);
    assert.equal(generated.status, 200);
    assert.equal(Buffer.from(await generated.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  });
});

test('a partial pro refund is logged and does not block generation', async () => {
  const { stripe, subscription, subUpdates, cancels } = createProStripe();
  const app = createApp({
    env: env(),
    stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%partial\n'),
  });
  await withServer(app, async (base) => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      assert.equal((await postWebhook(base, event('evt_partial', 'charge.refunded', {
        id: 'ch_current',
        amount: 7900,
        amount_refunded: 500,
        refunded: false,
        invoice: 'in_current',
        payment_intent: 'pi_pro',
      }))).status, 200);
    } finally {
      console.log = original;
    }
    assert.equal(subscription.metadata.period_access, undefined);
    assert.equal(subscription.status, 'active');
    assert.equal(cancels.length, 0);
    assertMetadataOnly(subUpdates);
    assert.match(lines.find((line) => line.includes('partial subscription period unchanged')) || '', /amount_refunded 500 amount 7900/);
    assert.equal(lines.some((line) => /@|sk_|whsec_/.test(line)), false);
    const verified = await fetch(`${base}/verify-session?session_id=cs_pro`);
    assert.deepEqual(await verified.json(), { valid: true, plan: 'pro', remaining: null });
    assert.equal((await postJob(base)).status, 202);
    assert.equal((await postGenerate(base)).status, 200);
  });
});

test('pro disputes suspend, restore on won, and revoke permanently on lost', async () => {
  const { stripe, subscription, subUpdates, cancels, customer } = createProStripe();
  const app = createApp({ env: env(), stripe, anthropic: anthropic(), renderPdf: async () => Buffer.from('%PDF-1.4\n') });
  await withServer(app, async (base) => {
    assert.equal((await postWebhook(base, event('evt_open', 'charge.dispute.created', {
      id: 'dp_pro',
      charge: 'ch_current',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, 'suspended');
    assert.equal(subscription.status, 'active');
    const suspended = await postJob(base);
    assert.equal(suspended.status, 402);
    assert.equal((await suspended.json()).error, PRO_SUSPENDED_MESSAGE);
    assert.equal((await postGenerate(base)).status, 402);

    assert.equal((await postWebhook(base, event('evt_won', 'charge.dispute.closed', {
      id: 'dp_pro',
      charge: 'ch_current',
      status: 'won',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, 'active');
    assert.equal(subscription.metadata.period_access_reason, undefined);
    const restored = await fetch(`${base}/verify-session?session_id=cs_pro`);
    assert.equal((await restored.json()).valid, true);

    assert.equal((await postWebhook(base, event('evt_open_2', 'charge.dispute.created', {
      id: 'dp_pro_2',
      charge: 'ch_current',
      status: 'needs_response',
    }))).status, 200);
    assert.equal((await postWebhook(base, event('evt_lost', 'charge.dispute.closed', {
      id: 'dp_pro_2',
      charge: 'ch_current',
      status: 'lost',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, 'revoked');
    assert.equal(subscription.metadata.period_access_reason, 'dispute');
    assert.equal(subscription.metadata.revoked_dispute_lost, 'true');
    assert.equal(customer.metadata.revoked_dispute_lost, undefined);
    assert.equal(subscription.status, 'canceled');
    assert.deepEqual(cancels, [{ prorate: false, invoice_now: false }]);
    const lost = await postGenerate(base);
    assert.equal(lost.status, 402);
    assert.equal((await lost.json()).error, PRO_DISPUTE_LOST_MESSAGE);

    assert.equal((await postWebhook(base, event('evt_won_late', 'charge.dispute.closed', {
      id: 'dp_pro_3',
      charge: 'ch_current',
      status: 'won',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, 'revoked');
    assert.equal(subscription.metadata.revoked_dispute_lost, 'true');
    assert.equal((await postWebhook(base, event('evt_same_paid', 'invoice.paid', {
      id: 'in_current',
      status: 'paid',
      subscription: 'sub_pro',
      billing_reason: 'subscription_cycle',
      amount_paid: 7900,
      period_start: 1700000000,
      period_end: 1700000000 + (30 * 24 * 60 * 60),
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, 'revoked');
    assert.equal((await postJob(base)).status, 402);

    assert.equal((await postWebhook(base, event('evt_new_paid', 'invoice.paid', {
      id: 'in_next',
      status: 'paid',
      subscription: 'sub_pro',
      billing_reason: 'subscription_cycle',
      amount_paid: 7900,
      period_start: 1700000000 + (30 * 24 * 60 * 60),
      period_end: 1700000000 + (60 * 24 * 60 * 60),
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, 'revoked');
    assert.equal(subscription.metadata.revoked_dispute_lost, 'true');
    assert.equal(subscription.metadata.period_invoice, 'in_current');
    assert.equal(subscription.status, 'canceled');
    assert.equal(cancels.length, 1);
    assertMetadataOnly(subUpdates);
    assert.equal((await fetch(`${base}/verify-session?session_id=cs_pro`).then((res) => res.json())).valid, false);
  });
});

test('a refund of an earlier period does not block the current one', async () => {
  const { stripe, subscription, cancels } = createProStripe();
  subscription.latest_invoice = 'in_current';
  const app = createApp({ env: env(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await postWebhook(base, event('evt_old', 'charge.refunded', {
      id: 'ch_old',
      amount: 7900,
      amount_refunded: 7900,
      refunded: true,
      invoice: 'in_old',
      payment_intent: 'pi_old',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, undefined);
    assert.equal(subscription.status, 'active');
    assert.equal(cancels.length, 0);
    const verified = await fetch(`${base}/verify-session?session_id=cs_pro`);
    assert.deepEqual(await verified.json(), { valid: true, plan: 'pro', remaining: null });
  });
});

test('restoresAccess is true only for a won dispute', () => {
  assert.equal(restoresAccess('won'), true);
  for (const status of ['warning_closed', 'prevented', 'lost', 'charge_refunded', 'warning_needs_response', 'warning_under_review', 'needs_response', 'under_review', '']) {
    assert.equal(restoresAccess(status), false);
  }
});

test('warning_closed does not suspend and charge_refunded does not suspend by itself', async () => {
  const { stripe, subscription } = createProStripe();
  const app = createApp({ env: env(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await postWebhook(base, event('evt_warn', 'charge.dispute.closed', {
      id: 'dp_warn',
      charge: 'ch_current',
      status: 'warning_closed',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, undefined);
    assert.equal(subscription.metadata.closed_disputes, undefined);
    assert.equal((await postWebhook(base, event('evt_charge_refunded', 'charge.dispute.closed', {
      id: 'dp_charge_refunded',
      charge: 'ch_current',
      status: 'charge_refunded',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, undefined);
    assert.equal(subscription.metadata.open_dispute_count, '0');
    assert.equal(subscription.metadata.closed_disputes, 'dp_charge_refunded');
    assert.equal(subscription.status, 'active');
  });
});

test('a charge without invoice still maps through invoice payments', async () => {
  const { stripe, subscription } = createProStripe();
  stripe.invoicePayments = {
    list: async (params) => {
      assert.equal(params.payment.payment_intent, 'pi_api');
      return {
        data: [{
          status: 'paid',
          invoice: {
            id: 'in_current',
            status: 'paid',
            parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_pro' } },
          },
        }],
      };
    },
  };
  const app = createApp({ env: env(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await postWebhook(base, event('evt_api', 'charge.refunded', {
      id: 'ch_api',
      amount: 7900,
      amount_refunded: 7900,
      refunded: true,
      payment_intent: 'pi_api',
    }))).status, 200);
    assert.equal(subscription.metadata.period_access, 'revoked');
    assert.equal(subscription.metadata.period_invoice, 'in_current');
    assert.equal(subscription.status, 'active');
  });
});

test('a period handler failure returns 500', async () => {
  const { stripe } = createProStripe();
  stripe.subscriptions.retrieve = async () => {
    throw new Error('subscription store unavailable sk_test_secret');
  };
  const app = createApp({ env: env(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    const res = await postWebhook(base, event('evt_fail', 'charge.refunded', {
      id: 'ch_current',
      amount: 7900,
      amount_refunded: 7900,
      refunded: true,
      invoice: 'in_current',
      payment_intent: 'pi_pro',
    }));
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(text.includes('sk_test_secret'), false);
  });
});
