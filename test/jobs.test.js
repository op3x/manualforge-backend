const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');

test.after(() => {
  removeTestJobDirectories();
});

const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));

function env(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
    MANUALOS_LEGACY_GENERATE: '1',
    ...extra,
  };
}

function stripeFor(allowanceStart = '0') {
  const calls = { updates: [] };
  const meta = { manuals_used: allowanceStart, plan: 'starter', credit_generation: '0', credit_hold: '' };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_test_starter',
          metadata: { plan: 'starter' },
          payment_status: 'paid',
          payment_intent: { id: 'pi_1', metadata: { ...meta } },
          subscription: null,
        }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_1', metadata: { ...meta } }),
      update: async (id, params) => {
        calls.updates.push(params.metadata);
        for (const [key, value] of Object.entries(params.metadata)) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, metadata: { ...meta } };
      },
    },
    subscriptions: { retrieve: async () => ({ id: 'sub_1', status: 'active' }) },
  };
  return { stripe, meta, calls };
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
              groups: [{ unit_numbers: indexes, title: 'Infeed start', function: 'The infeed runs when start is requested and the guards are closed.', conditions: 'Guards closed', result: 'Infeed runs', housekeeping: false, inferred: true }],
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

async function waitJob(base, id, sessionId = 'cs_test_starter') {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`, { headers: { 'X-Session-Id': sessionId } });
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

test('jobs reserve one credit, return a pdf, and refund when rendering fails', async () => {
  const paid = stripeFor('0');
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%job\n'),
  });
  await withServer(app, async (base) => {
    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    form.set('product_name', 'Infeed Line');
    form.set('file', new Blob([L5X]), 'line.L5X');
    const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(created.status, 202);
    const job = await created.json();
    const done = await waitJob(base, job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.coverage.percent, 100);
    const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /pdf/);
    assert.equal(pdf.headers.get('content-disposition'), `attachment; filename="manual-${job.id.slice(4, 12)}.pdf"`);
    assert.equal(pdf.headers.get('content-disposition').includes('Infeed'), false);
    assert.equal(pdf.headers.get('content-disposition').includes('filename*'), false);
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(pdf.headers.get('deprecation'), null);

    const legacy = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.get('deprecation'), 'true');
  });

  const failing = stripeFor('0');
  const failApp = createApp({
    env: env(),
    stripe: failing.stripe,
    anthropic: anthropic(),
    renderPdf: async () => { throw new Error('render exploded'); },
  });
  await withServer(failApp, async (base) => {
    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    form.set('file', new Blob([L5X]), 'line.L5X');
    const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'failed');
    assert.equal(JSON.stringify(done).includes('render exploded'), false);
    assert.equal(failing.meta.manuals_used, '0');
    assert.equal(failing.meta.credit_hold, undefined);
  });
});

test('a missing model and an unreadable file do not spend a credit', async () => {
  const paid = stripeFor('0');
  const app = createApp({ env: env(), stripe: paid.stripe, anthropic: null, renderPdf: async () => Buffer.from('%PDF') });
  await withServer(app, async (base) => {
    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    form.set('file', new Blob([L5X]), 'line.L5X');
    const res = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(res.status, 503);
    assert.equal(paid.calls.updates.length, 0);
  });
  const bad = stripeFor('0');
  const badApp = createApp({
    env: env(),
    stripe: bad.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF'),
  });
  await withServer(badApp, async (base) => {
    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    form.set('file', new Blob(['hello']), 'line.L5X');
    const res = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(res.status, 415);
    assert.equal(bad.calls.updates.length, 0);
    const body = await res.json();
    assert.equal(JSON.stringify(body).includes('ACD'), false);
  });
});

function stripeWithStaleConfirm(allowanceStart = '0') {
  const paid = stripeFor(allowanceStart);
  let previous = { ...paid.meta };
  let serveStale = false;
  const update = paid.stripe.paymentIntents.update;
  const retrieve = paid.stripe.paymentIntents.retrieve;
  paid.stripe.paymentIntents.update = async (id, params) => {
    previous = { ...paid.meta };
    const result = await update(id, params);
    serveStale = true;
    return result;
  };
  paid.stripe.paymentIntents.retrieve = async (...args) => {
    if (serveStale) {
      serveStale = false;
      return { id: 'pi_1', metadata: { ...previous } };
    }
    return retrieve(...args);
  };
  return paid;
}

async function twoStarterJobs(paid) {
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(app, async (base) => {
    const send = () => {
      const form = new FormData();
      form.set('session_id', 'cs_test_starter');
      form.set('file', new Blob([L5X]), 'line.L5X');
      return fetch(`${base}/jobs`, { method: 'POST', body: form });
    };
    const results = await Promise.all([send(), send()]);
    const accepted = [];
    for (const res of results) {
      if (res.status === 202) {
        accepted.push(await res.json());
        continue;
      }
      const body = await res.json();
      assert.ok(res.status === 402 || res.status === 409, JSON.stringify(body));
    }
    const finished = [];
    for (const job of accepted) finished.push(await waitJob(base, job.id));
    const delivered = finished.filter((job) => job.status === 'succeeded').length;
    const failedJobs = finished.filter((job) => job.status === 'failed').length;
    const refused = results.filter((res) => res.status !== 202).length + failedJobs;
    assert.equal(delivered + refused, 2);
    assert.equal(delivered, 2);
    assert.equal(Number(paid.meta.manuals_used), delivered);
    const verify = await fetch(`${base}/verify-session?session_id=cs_test_starter`);
    assert.equal(verify.status, 200);
    const access = await verify.json();
    assert.equal(access.remaining, 1);
    assert.equal(paid.meta.credit_holds || '', '');
    assert.equal(paid.meta.credit_hold || '', '');
  });
}

test('two concurrent starter jobs on three credits both deliver and leave one credit', async () => {
  await twoStarterJobs(stripeFor('0'));
});

test('two concurrent starter jobs still leave one credit when a confirm read is stale', async () => {
  await twoStarterJobs(stripeWithStaleConfirm('0'));
});

test('concurrent starter reserves cannot both spend the last credit', async () => {
  const paid = stripeFor('0');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered = 0;
  const stripe = paid.stripe;
  const original = stripe.paymentIntents.retrieve;
  stripe.paymentIntents.retrieve = async (...args) => {
    entered += 1;
    if (entered === 1) await gate;
    return original(...args);
  };
  const app = createApp({
    env: env({ STARTER_CREDITS: '1' }),
    stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(app, async (base) => {
    const send = () => {
      const form = new FormData();
      form.set('session_id', 'cs_test_starter');
      form.set('file', new Blob([L5X]), 'line.L5X');
      return fetch(`${base}/jobs`, { method: 'POST', body: form });
    };
    const first = send();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = send();
    release();
    const results = await Promise.all([first, second]);
    const statuses = results.map((res) => res.status).sort();
    assert.deepEqual(statuses, [202, 402]);
    assert.equal(paid.meta.manuals_used, '1');
  });
});
