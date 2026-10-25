const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const { STARTER_DISPUTE_LOST_MESSAGE, STARTER_REFUNDED_MESSAGE, STARTER_SUSPENDED_MESSAGE } = require('../lib/billing');

test.after(() => {
  removeTestJobDirectories();
});

const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));

function baseEnv() {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
    MANUALOS_LEGACY_GENERATE: '1',
  };
}

function createStripe({ intents: seed, sessions, charges = {}, listed = {} }) {
  const intents = {};
  for (const [id, metadata] of Object.entries(seed)) {
    intents[id] = { id, metadata: { ...metadata } };
  }
  const updates = [];
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          const piId = sessions[id];
          if (!piId || !intents[piId]) {
            const err = new Error('No such checkout.session');
            err.statusCode = 404;
            err.code = 'resource_missing';
            throw err;
          }
          return {
            id,
            metadata: { plan: 'starter' },
            payment_status: 'paid',
            payment_intent: { id: piId, metadata: { ...intents[piId].metadata } },
            subscription: null,
          };
        },
        list: async ({ payment_intent: paymentIntentId }) => ({ data: listed[paymentIntentId] || [] }),
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        if (!intents[id]) {
          const err = new Error('No such payment_intent');
          err.statusCode = 404;
          err.code = 'resource_missing';
          throw err;
        }
        return { id, metadata: { ...intents[id].metadata } };
      },
      update: async (id, params) => {
        updates.push({ id, metadata: { ...params.metadata } });
        const next = { ...intents[id].metadata };
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete next[key];
          else next[key] = value;
        }
        intents[id].metadata = next;
        return { id, metadata: { ...next } };
      },
    },
    charges: {
      retrieve: async (id) => {
        if (!charges[id]) {
          const err = new Error('No such charge');
          err.statusCode = 404;
          err.code = 'resource_missing';
          throw err;
        }
        return { ...charges[id] };
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
  return { stripe, intents, updates };
}

function starterMeta(used) {
  return { plan: 'starter', manuals_used: String(used), credit_generation: '0', credit_hold: '' };
}

function charge({ id, paymentIntent, amount = 3900, refundedAmount = 0, refunded = false }) {
  return {
    id,
    amount,
    amount_refunded: refundedAmount,
    refunded,
    payment_intent: paymentIntent || null,
  };
}

function event(id, type, object) {
  return { id, type, data: { object } };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postWebhook(base, payload, signature = 't=1,v1=ok') {
  return fetch(base + '/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: JSON.stringify(payload),
  });
}

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return await fn(lines);
  } finally {
    console.log = original;
  }
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

async function waitJob(base, id, sessionId) {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`, { headers: { 'X-Session-Id': sessionId } });
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

async function postJob(base, sessionId) {
  const form = new FormData();
  form.set('session_id', sessionId);
  form.set('file', new Blob([L5X]), 'line.L5X');
  return fetch(`${base}/jobs`, { method: 'POST', body: form });
}

test('full refund revokes starter credits and a duplicate event does not write again', async () => {
  const { stripe, intents, updates } = createStripe({
    intents: { pi_full: starterMeta(1) },
    sessions: { cs_test_full: 'pi_full' },
  });
  const app = createApp({ env: baseEnv(), stripe, anthropic: anthropic(), renderPdf: async () => Buffer.from('%PDF-1.4\n') });
  const payload = event('evt_full', 'charge.refunded', charge({
    id: 'ch_full',
    paymentIntent: 'pi_full',
    refundedAmount: 3900,
    refunded: true,
  }));
  await withServer(app, async (base) => {
    const lines = await captureLogs(async (logged) => {
      const first = await postWebhook(base, payload);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { received: true });
      const second = await postWebhook(base, payload);
      assert.equal(second.status, 200);
      const parallel = await Promise.all([postWebhook(base, payload), postWebhook(base, payload)]);
      assert.deepEqual(parallel.map((res) => res.status), [200, 200]);
      return logged;
    });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].metadata.credit_status, 'revoked');
    assert.equal(updates[0].metadata.manuals_used, undefined);
    assert.equal(intents.pi_full.metadata.credit_status, 'revoked');
    assert.equal(intents.pi_full.metadata.manuals_used, '1');
    assert.equal(lines.filter((line) => line.includes('Starter credits revoked')).length, 1);
    assert.equal(lines.some((line) => /sk_|whsec_|@/.test(line)), false);

    const verified = await fetch(base + '/verify-session?session_id=cs_test_full');
    assert.deepEqual(await verified.json(), { valid: false, plan: 'starter', remaining: 0, billingIssue: false });

    const job = await postJob(base, 'cs_test_full');
    assert.equal(job.status, 402);
    const jobBody = await job.json();
    assert.equal(jobBody.error, STARTER_REFUNDED_MESSAGE);
    assert.equal(Object.hasOwn(jobBody, 'stack'), false);

    const legacy = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_full' },
      body: JSON.stringify({ plcContent: '<xml/>' }),
    });
    assert.equal(legacy.status, 402);
    assert.equal((await legacy.json()).error, STARTER_REFUNDED_MESSAGE);
    assert.equal(intents.pi_full.metadata.manuals_used, '1');

    const before = updates.length;
    const bad = await postWebhook(base, payload, 'nope');
    assert.equal(bad.status, 400);
    assert.equal((await bad.text()).includes('bad signature'), false);
    assert.equal(updates.length, before);
  });
});

test('partial refund is logged and starter credits still generate', async () => {
  const { stripe, intents, updates } = createStripe({
    intents: { pi_partial: starterMeta(1) },
    sessions: { cs_test_partial: 'pi_partial' },
  });
  const app = createApp({
    env: baseEnv(),
    stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%partial\n'),
  });
  const payload = event('evt_partial', 'charge.refunded', charge({
    id: 'ch_partial',
    paymentIntent: 'pi_partial',
    refundedAmount: 500,
    refunded: false,
  }));
  await withServer(app, async (base) => {
    const lines = await captureLogs(async (logged) => {
      assert.equal((await postWebhook(base, payload)).status, 200);
      assert.equal((await postWebhook(base, payload)).status, 200);
      return logged;
    });
    const kept = lines.filter((line) => line.includes('partial Starter credits kept'));
    assert.equal(kept.length, 1);
    assert.match(kept[0], /amount_refunded 500 amount 3900/);
    assert.equal(lines.some((line) => /sk_|whsec_|@|billing_details|receipt_email/.test(line)), false);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].metadata.credit_status, undefined);
    assert.equal(intents.pi_partial.metadata.credit_status, undefined);
    assert.equal(intents.pi_partial.metadata.manuals_used, '1');

    const verified = await fetch(base + '/verify-session?session_id=cs_test_partial');
    assert.deepEqual(await verified.json(), { valid: true, plan: 'starter', remaining: 2, billingIssue: false });

    const created = await postJob(base, 'cs_test_partial');
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id, 'cs_test_partial');
    assert.equal(done.status, 'succeeded');
    assert.equal(intents.pi_partial.metadata.manuals_used, '2');
    assert.equal(intents.pi_partial.metadata.credit_status, undefined);
  });
});

test('a dispute suspends starter credits, a loss revokes them, and a win restores them', async () => {
  const { stripe, intents, updates } = createStripe({
    intents: {
      pi_lost: starterMeta(0),
      pi_won: starterMeta(1),
    },
    sessions: { cs_test_lost: 'pi_lost', cs_test_won: 'pi_won' },
    charges: {
      ch_lost: { id: 'ch_lost', payment_intent: 'pi_lost', amount: 3900, amount_refunded: 0, refunded: false },
    },
  });
  const app = createApp({
    env: baseEnv(),
    stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%won\n'),
  });
  await withServer(app, async (base) => {
    const opened = event('evt_lost_open', 'charge.dispute.created', {
      id: 'dp_lost',
      charge: 'ch_lost',
      status: 'needs_response',
    });
    assert.equal((await postWebhook(base, opened)).status, 200);
    assert.equal((await postWebhook(base, opened)).status, 200);
    assert.equal(intents.pi_lost.metadata.credit_status, 'suspended');
    const openWrites = updates.filter((update) => update.id === 'pi_lost' && update.metadata.credit_status === 'suspended');
    assert.equal(openWrites.length, 1);
    const whileOpen = await postJob(base, 'cs_test_lost');
    assert.equal(whileOpen.status, 402);
    assert.equal((await whileOpen.json()).error, STARTER_SUSPENDED_MESSAGE);

    const lost = event('evt_lost_close', 'charge.dispute.closed', {
      id: 'dp_lost',
      charge: 'ch_lost',
      status: 'lost',
    });
    assert.equal((await postWebhook(base, lost)).status, 200);
    assert.equal((await postWebhook(base, lost)).status, 200);
    assert.equal(intents.pi_lost.metadata.credit_status, 'revoked');
    assert.equal(intents.pi_lost.metadata.credit_revoke_reason, 'dispute');
    assert.equal(intents.pi_lost.metadata.manuals_used, '0');
    const lostWrites = updates.filter((update) => update.id === 'pi_lost' && update.metadata.credit_status === 'revoked');
    assert.equal(lostWrites.length, 1);

    const blocked = await postJob(base, 'cs_test_lost');
    assert.equal(blocked.status, 402);
    assert.equal((await blocked.json()).error, STARTER_DISPUTE_LOST_MESSAGE);
    const legacy = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_lost' },
      body: JSON.stringify({}),
    });
    assert.equal(legacy.status, 402);
    assert.equal((await legacy.json()).error, STARTER_DISPUTE_LOST_MESSAGE);

    const lostThenWon = event('evt_lost_then_won', 'charge.dispute.closed', {
      id: 'dp_lost',
      charge: 'ch_lost',
      status: 'won',
    });
    assert.equal((await postWebhook(base, lostThenWon)).status, 200);
    assert.equal(intents.pi_lost.metadata.credit_status, 'revoked');
    const stillBlocked = await postJob(base, 'cs_test_lost');
    assert.equal(stillBlocked.status, 402);
    assert.equal((await stillBlocked.json()).error, STARTER_DISPUTE_LOST_MESSAGE);

    const wonOpen = event('evt_won_open', 'charge.dispute.created', {
      id: 'dp_won',
      payment_intent: 'pi_won',
      status: 'needs_response',
    });
    const wonClose = event('evt_won_close', 'charge.dispute.closed', {
      id: 'dp_won',
      payment_intent: 'pi_won',
      status: 'won',
    });
    assert.equal((await postWebhook(base, wonOpen)).status, 200);
    assert.equal(intents.pi_won.metadata.credit_status, 'suspended');
    assert.deepEqual(await (await fetch(base + '/verify-session?session_id=cs_test_won')).json(), {
      valid: false,
      plan: 'starter',
      remaining: 0,
      billingIssue: false,
    });
    assert.equal((await postWebhook(base, wonClose)).status, 200);
    assert.equal((await postWebhook(base, wonClose)).status, 200);
    assert.equal(intents.pi_won.metadata.credit_status, 'active');
    assert.equal(intents.pi_won.metadata.manuals_used, '1');
    const restoreWrites = updates.filter((update) => update.id === 'pi_won' && update.metadata.credit_status === 'active');
    assert.equal(restoreWrites.length, 1);
    assert.deepEqual(await (await fetch(base + '/verify-session?session_id=cs_test_won')).json(), {
      valid: true,
      plan: 'starter',
      remaining: 2,
      billingIssue: false,
    });
    const created = await postJob(base, 'cs_test_won');
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id, 'cs_test_won');
    assert.equal(done.status, 'succeeded');
    assert.equal(intents.pi_won.metadata.manuals_used, '2');
  });
});

test('unknown charge is acknowledged and does not change credits', async () => {
  const { stripe, intents, updates } = createStripe({
    intents: {
      pi_pro: { plan: 'pro', brand: 'manualos', manuals_used: '0' },
      pi_starter: starterMeta(0),
    },
    sessions: { cs_test_starter: 'pi_starter' },
    listed: {
      pi_other: [{ id: 'cs_test_other', metadata: { plan: 'pro', brand: 'manualos' } }],
    },
  });
  intents.pi_other = { id: 'pi_other', metadata: {} };
  const app = createApp({ env: baseEnv(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    const lines = await captureLogs(async (logged) => {
      const missing = event('evt_unknown', 'charge.refunded', charge({
        id: 'ch_unknown',
        refundedAmount: 3900,
        refunded: true,
      }));
      const other = event('evt_other', 'charge.refunded', charge({
        id: 'ch_other',
        paymentIntent: 'pi_other',
        refundedAmount: 3900,
        refunded: true,
      }));
      const pro = event('evt_pro', 'charge.refunded', charge({
        id: 'ch_pro',
        paymentIntent: 'pi_pro',
        refundedAmount: 7900,
        refunded: true,
      }));
      assert.equal((await postWebhook(base, missing)).status, 200);
      assert.equal((await postWebhook(base, other)).status, 200);
      assert.equal((await postWebhook(base, pro)).status, 200);
      assert.equal((await postWebhook(base, missing)).status, 200);
      return logged;
    });
    assert.equal(updates.length, 0);
    assert.equal(intents.pi_starter.metadata.credit_status, undefined);
    assert.equal(intents.pi_pro.metadata.credit_status, undefined);
    // A charge with no PaymentIntent is unknown, so the brand gate does not hand it to the Starter handler.
    assert.equal(lines.filter((line) => line.includes('ignored no Starter entitlement')).length, 2);
    const verified = await fetch(base + '/verify-session?session_id=cs_test_starter');
    assert.deepEqual(await verified.json(), { valid: true, plan: 'starter', remaining: 3, billingIssue: false });
  });
});

test('full refund maps a charge through the checkout session when the payment intent has no plan', async () => {
  const { stripe, intents, updates } = createStripe({
    intents: { pi_session: { manuals_used: '0' } },
    sessions: { cs_test_session: 'pi_session' },
    listed: {
      pi_session: [{ id: 'cs_test_session', metadata: { plan: 'starter' } }],
    },
  });
  const app = createApp({ env: baseEnv(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    const payload = event('evt_session', 'charge.refunded', charge({
      id: 'ch_session',
      paymentIntent: 'pi_session',
      refundedAmount: 3900,
      refunded: true,
    }));
    assert.equal((await postWebhook(base, payload)).status, 200);
    assert.equal(updates.length, 1);
    assert.equal(intents.pi_session.metadata.plan, 'starter');
    assert.equal(intents.pi_session.metadata.credit_status, 'revoked');
    const blocked = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_session' },
      body: JSON.stringify({ plcContent: '<xml/>' }),
    });
    assert.equal(blocked.status, 402);
    assert.equal((await blocked.json()).error, STARTER_REFUNDED_MESSAGE);
  });
});

test('a won dispute does not restore credits a full refund already revoked', async () => {
  const { stripe, intents } = createStripe({
    intents: { pi_sticky: starterMeta(0) },
    sessions: { cs_test_sticky: 'pi_sticky' },
  });
  const app = createApp({ env: baseEnv(), stripe, anthropic: null });
  await withServer(app, async (base) => {
    assert.equal((await postWebhook(base, event('evt_sticky_open', 'charge.dispute.created', {
      id: 'dp_sticky',
      payment_intent: 'pi_sticky',
      status: 'needs_response',
    }))).status, 200);
    assert.equal(intents.pi_sticky.metadata.credit_status, 'suspended');
    assert.equal((await postWebhook(base, event('evt_sticky_refund', 'charge.refunded', charge({
      id: 'ch_sticky',
      paymentIntent: 'pi_sticky',
      refundedAmount: 3900,
      refunded: true,
    })))).status, 200);
    assert.equal(intents.pi_sticky.metadata.credit_status, 'revoked');
    assert.equal((await postWebhook(base, event('evt_sticky_won', 'charge.dispute.closed', {
      id: 'dp_sticky',
      payment_intent: 'pi_sticky',
      status: 'won',
    }))).status, 200);
    assert.equal(intents.pi_sticky.metadata.credit_status, 'revoked');
    const blocked = await postJob(base, 'cs_test_sticky');
    assert.equal(blocked.status, 402);
    assert.equal((await blocked.json()).error, STARTER_REFUNDED_MESSAGE);
  });
});

test('a job that already started does not publish after a full refund', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { stripe, intents } = createStripe({
    intents: { pi_live: starterMeta(0) },
    sessions: { cs_live_id: 'pi_live' },
  });
  const app = createApp({
    env: baseEnv(),
    stripe,
    anthropic: anthropic(),
    renderPdf: () => gate.then(() => Buffer.from('%PDF-1.4\n%live\n')),
  });
  await withServer(app, async (base) => {
    const created = await postJob(base, 'cs_live_id');
    assert.equal(created.status, 202);
    const job = await created.json();
    assert.equal(intents.pi_live.metadata.manuals_used, '1');
    const hook = await postWebhook(base, event('evt_live', 'charge.refunded', charge({
      id: 'ch_live',
      paymentIntent: 'pi_live',
      refundedAmount: 3900,
      refunded: true,
    })));
    assert.equal(hook.status, 200);
    assert.equal(intents.pi_live.metadata.credit_status, 'revoked');
    release();
    const done = await waitJob(base, job.id, 'cs_live_id');
    assert.equal(done.status, 'failed');
    const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_live_id' } });
    assert.equal(pdf.status, 409);
    const blocked = await postJob(base, 'cs_live_id');
    assert.equal(blocked.status, 402);
    assert.equal((await blocked.json()).error, STARTER_REFUNDED_MESSAGE);
    assert.equal(intents.pi_live.metadata.credit_status, 'revoked');
    assert.equal(intents.pi_live.metadata.manuals_used, '0');
  });
});
