const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');

test.after(() => {
  removeTestJobDirectories();
});

const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
const EMPTY_XML = `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <types><pous><pou name="empty" pouType="program"><body><LD></LD></body></pou></pous></types>
</project>`;

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

function starterStripe() {
  const calls = { updates: [] };
  const meta = { manuals_used: '0', plan: 'starter', credit_generation: '0', credit_hold: '' };
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

async function waitJob(base, id) {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`);
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

async function postJob(base, fileName, bytes) {
  const form = new FormData();
  form.set('session_id', 'cs_test_starter');
  form.set('file', new Blob([bytes]), fileName);
  return fetch(`${base}/jobs`, { method: 'POST', body: form });
}

test('a failed run, 415, 422, 503, and a job error never set first_manual_at', async () => {
  const missing = starterStripe();
  await withServer(createApp({ env: env(), stripe: missing.stripe, anthropic: null }), async (base) => {
    const res = await postJob(base, 'line.L5X', L5X);
    assert.equal(res.status, 503);
    assert.equal(missing.calls.updates.length, 0);
    assert.equal(Object.hasOwn(missing.meta, 'first_manual_at'), false);
  });

  const unreadable = starterStripe();
  await withServer(createApp({
    env: env(),
    stripe: unreadable.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF'),
  }), async (base) => {
    const res = await postJob(base, 'line.L5X', Buffer.from('hello'));
    assert.equal(res.status, 415);
    assert.equal(unreadable.calls.updates.length, 0);
    assert.equal(Object.hasOwn(unreadable.meta, 'first_manual_at'), false);
  });

  const empty = starterStripe();
  await withServer(createApp({
    env: env(),
    stripe: empty.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF'),
  }), async (base) => {
    const job = await postJob(base, 'empty.xml', Buffer.from(EMPTY_XML));
    assert.equal(job.status, 422);
    const legacy = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
      body: JSON.stringify({ plcContent: EMPTY_XML }),
    });
    assert.equal(legacy.status, 422);
    assert.equal(empty.calls.updates.length, 0);
    assert.equal(Object.hasOwn(empty.meta, 'first_manual_at'), false);
  });

  const broken = starterStripe();
  await withServer(createApp({
    env: env(),
    stripe: broken.stripe,
    anthropic: anthropic(),
    renderPdf: async () => { throw new Error('render exploded'); },
  }), async (base) => {
    const created = await postJob(base, 'line.L5X', L5X);
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'failed');
    assert.equal(broken.meta.manuals_used, '0');
    assert.equal(Object.hasOwn(broken.meta, 'first_manual_at'), false);
    const legacy = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
    });
    assert.notEqual(legacy.status, 200);
    assert.equal(Object.hasOwn(broken.meta, 'first_manual_at'), false);
  });
});

test('the first downloadable pdf stamps once and a later success keeps that time', async () => {
  const paid = starterStripe();
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%job\n'),
  });
  await withServer(app, async (base) => {
    const first = await postJob(base, 'line.L5X', L5X);
    assert.equal(first.status, 202);
    const done = await waitJob(base, (await first.json()).id);
    assert.equal(done.status, 'succeeded');
    const pdf = await fetch(`${base}/jobs/${done.id}/pdf`);
    assert.equal(pdf.status, 200);
    const stamped = paid.meta.first_manual_at;
    assert.match(stamped, /^\d{4}-\d{2}-\d{2}T/);
    const second = await postJob(base, 'line.L5X', L5X);
    const again = await waitJob(base, (await second.json()).id);
    assert.equal(again.status, 'succeeded');
    assert.equal(paid.meta.first_manual_at, stamped);
    assert.equal(paid.calls.updates.filter((metadata) => metadata.first_manual_at).length, 1);
  });
});

test('a stamp failure does not serve the pdf and refunds the credit', async () => {
  const paid = starterStripe();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map((arg) => String(arg)).join(' '));
  paid.stripe.paymentIntents.update = async (id, params) => {
    paid.calls.updates.push(params.metadata);
    if (params.metadata.first_manual_at) throw new Error('stamp write failed sk_test_secretvalue');
    for (const [key, value] of Object.entries(params.metadata)) {
      if (value === '') delete paid.meta[key];
      else paid.meta[key] = value;
    }
    return { id, metadata: { ...paid.meta } };
  };
  try {
    await withServer(createApp({
      env: env(),
      stripe: paid.stripe,
      anthropic: anthropic(),
      renderPdf: async () => Buffer.from('%PDF-1.4\n%kept\n'),
    }), async (base) => {
      const created = await postJob(base, 'line.L5X', L5X);
      const done = await waitJob(base, (await created.json()).id);
      assert.equal(done.status, 'failed');
      const pdf = await fetch(`${base}/jobs/${done.id}/pdf`);
      assert.equal(pdf.status, 409);
      assert.equal(Object.hasOwn(paid.meta, 'first_manual_at'), false);
      assert.equal(paid.meta.manuals_used, '0');
      assert.equal(Object.hasOwn(paid.meta, 'generation_started_at'), false);
    });
  } finally {
    console.error = original;
  }
  const logged = errors.join('\n');
  assert.match(logged, /First manual delivery stamp failed/);
  assert.match(logged, /starter/);
  assert.match(logged, /stamp write failed \[redacted\]/);
  assert.equal(logged.includes('sk_test_secretvalue'), false);
});

test('pro stamps the current period charge and skips a mismatched period', async () => {
  const charges = {
    ch_current: { id: 'ch_current', metadata: {} },
    ch_old: { id: 'ch_old', metadata: {} },
  };
  const updates = [];
  let invoice = {
    id: 'in_current',
    period_start: 100,
    period_end: 500,
    charge: 'ch_current',
    metadata: {},
  };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_pro',
          metadata: { plan: 'pro' },
          payment_status: 'paid',
          payment_intent: null,
          subscription: {
            id: 'sub_1',
            status: 'active',
            metadata: { plan: 'pro' },
            current_period_start: 100,
            current_period_end: 500,
            latest_invoice: invoice,
          },
        }),
      },
    },
    charges: {
      retrieve: async (id) => charges[id],
      update: async (id, params) => {
        updates.push({ id, metadata: params.metadata });
        charges[id].metadata = { ...charges[id].metadata, ...params.metadata };
        return charges[id];
      },
    },
    paymentIntents: { update: async () => { throw new Error('pro must not stamp a payment intent'); } },
  };
  const app = createApp({
    env: env(),
    stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%pro\n'),
  });
  await withServer(app, async (base) => {
    const form = new FormData();
    form.set('session_id', 'cs_pro');
    form.set('file', new Blob([L5X]), 'line.L5X');
    const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'succeeded');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].id, 'ch_current');
    assert.equal(updates[1].id, 'ch_current');
    assert.match(charges.ch_current.metadata.first_manual_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(charges.ch_old.metadata.first_manual_at, undefined);
    const stamped = charges.ch_current.metadata.first_manual_at;
    const again = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_pro' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
    });
    assert.equal(again.status, 200);
    assert.equal(updates.filter((row) => row.metadata.first_manual_at).length, 1);
    assert.equal(charges.ch_current.metadata.first_manual_at, stamped);

    invoice = {
      id: 'in_previous',
      period_start: 1,
      period_end: 50,
      charge: 'ch_old',
      metadata: {},
    };
    const mismatched = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_pro' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
    });
    assert.equal(mismatched.status, 200);
    assert.equal(updates.filter((row) => row.metadata.first_manual_at).length, 1);
    assert.equal(charges.ch_old.metadata.first_manual_at, undefined);
  });
});
