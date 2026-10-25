const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, prepareListen } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');

test.after(() => {
  removeTestJobDirectories();
});

const L5X = `<?xml version="1.0" encoding="UTF-8"?>
<RSLogix5000Content>
  <Controller Name="Line1">
    <Programs>
      <Program Name="MainProgram">
        <Routines>
          <Routine Name="MainRoutine" Type="RLL"><Rung Number="0"><Text><![CDATA[XIC(Start)OTE(Run);]]></Text></Rung></Routine>
          <Routine Name="FaultRoutine" Type="RLL"><Rung Number="0"><Text><![CDATA[OTE(FaultLamp);]]></Text></Rung></Routine>
        </Routines>
      </Program>
    </Programs>
  </Controller>
</RSLogix5000Content>`;

function baseEnv(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
    ...extra,
  };
}

function starterSession(used) {
  return {
    id: 'cs_test_starter',
    metadata: { plan: 'starter' },
    payment_status: 'paid',
    payment_intent: { id: 'pi_1', metadata: { manuals_used: String(used), plan: 'starter' } },
    subscription: null,
  };
}

function fakePdf() {
  return async () => Buffer.from('%PDF-1.4\n%manualos\n');
}

function createHarness() {
  const calls = { create: [], updates: [], modelCalls: 0 };
  let used = 0;
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.create.push(params);
          return { id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' };
        },
        retrieve: async (id) => {
          if (id === 'missing') {
            const err = new Error('No such checkout.session');
            err.statusCode = 404;
            err.code = 'resource_missing';
            throw err;
          }
          if (id === 'cs_test_pro') {
            return {
              id,
              metadata: { plan: 'pro' },
              payment_status: 'paid',
              payment_intent: null,
              subscription: 'sub_1',
            };
          }
          if (id === 'cs_test_unpaid') {
            return {
              id,
              metadata: { plan: 'starter' },
              payment_status: 'unpaid',
              payment_intent: { id: 'pi_1', metadata: { manuals_used: '0' } },
              subscription: null,
            };
          }
          return starterSession(used);
        },
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: String(used) } }),
      update: async (id, params) => {
        calls.updates.push({ id, params });
        used = Number(params.metadata.manuals_used);
        return { id, metadata: params.metadata };
      },
    },
    subscriptions: {
      retrieve: async () => ({ id: 'sub_1', status: 'trialing' }),
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') {
          throw new Error('SUPER_SECRET_SIGNATURE_DETAIL');
        }
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
  const anthropic = {
    messages: {
      create: async (body) => {
        calls.modelCalls += 1;
        calls.lastModelBody = body;
        if (body.messages[0].content.includes('FaultRoutine') && calls.failSecond) {
          throw new Error('model exploded with SUPER_SECRET_MODEL_DETAIL');
        }
        const name = body.messages[0].content.includes('FaultRoutine') ? 'FaultRoutine' : 'MainRoutine';
        return {
          content: [
            { type: 'thinking', thinking: 'hidden chain' },
            { type: 'text', text: `###ROUTINE### ${name}\n####DETAIL#### Summary: Described ${name}.` },
          ],
        };
      },
    },
  };
  return { calls, stripe, anthropic, get used() { return used; } };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health, checkout, verify, and webhook', async () => {
  const harness = createHarness();
  const app = createApp({ env: baseEnv(), stripe: harness.stripe, anthropic: harness.anthropic });
  await withServer(app, async (base) => {
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).aiEnabled, true);

    const badPlan = await fetch(base + '/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'enterprise' }),
    });
    assert.equal(badPlan.status, 400);
    assert.equal(harness.calls.create.length, 0);
    const badBody = await badPlan.json();
    assert.equal(Object.hasOwn(badBody, 'stack'), false);

    const checkout = await fetch(base + '/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://manualos.com' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.headers.get('access-control-allow-origin'), 'https://manualos.com');
    const checkoutBody = await checkout.json();
    assert.deepEqual(Object.keys(checkoutBody), ['url']);
    assert.equal(harness.calls.create[0].mode, 'subscription');
    assert.equal(harness.calls.create[0].metadata.plan, 'pro');
    assert.equal(harness.calls.create[0].payment_method_types, undefined);

    const missingId = await fetch(base + '/verify-session');
    assert.equal(missingId.status, 400);

    const pro = await fetch(base + '/verify-session?session_id=cs_test_pro');
    assert.deepEqual(await pro.json(), { valid: true, plan: 'pro', remaining: null });

    const unpaid = await fetch(base + '/verify-session?session_id=cs_test_unpaid');
    assert.deepEqual(await unpaid.json(), { valid: false, plan: 'starter', remaining: null });

    const missing = await fetch(base + '/verify-session?session_id=missing');
    assert.deepEqual(await missing.json(), { valid: false, plan: null, remaining: null });

    const www = await fetch(base + '/health', { headers: { Origin: 'https://www.manualos.com' } });
    assert.equal(www.headers.get('access-control-allow-origin'), 'https://www.manualos.com');
    const evil = await fetch(base + '/health', { headers: { Origin: 'https://evil.example' } });
    assert.notEqual(evil.headers.get('access-control-allow-origin'), 'https://evil.example');

    const webhook = await fetch(base + '/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_1',
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', status: 'active' } },
      }),
    });
    assert.equal(webhook.status, 200);
    assert.deepEqual(await webhook.json(), { received: true });

    const badHook = await fetch(base + '/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'nope' },
      body: JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1' } } }),
    });
    assert.equal(badHook.status, 400);
    const badHookText = await badHook.text();
    assert.equal(badHookText.includes('SUPER_SECRET_SIGNATURE_DETAIL'), false);
    assert.equal(badHookText.includes('stack'), false);
  });
});

test('generate requires payment, spends one starter credit after success, and hides model errors', async () => {
  const harness = createHarness();
  const app = createApp({ env: baseEnv(), stripe: harness.stripe, anthropic: harness.anthropic, renderPdf: fakePdf() });
  await withServer(app, async (base) => {
    const unpaid = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plcContent: L5X }),
    });
    assert.equal(unpaid.status, 402);
    const unpaidBody = await unpaid.json();
    assert.match(unpaidBody.error, /session_id/);
    assert.equal(harness.calls.modelCalls, 0);
    assert.equal(harness.calls.updates.length, 0);

    const headerOnly = await fetch(base + '/verify-session?session_id=cs_test_starter');
    assert.deepEqual(await headerOnly.json(), { valid: true, plan: 'starter', remaining: 3 });

    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    form.set('brand', 'Acme');
    form.set('file', new Blob([L5X], { type: 'application/xml' }), 'line.L5X');
    const ok = await fetch(base + '/generate-manual', { method: 'POST', body: form });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /application\/pdf/);
    const pdf = Buffer.from(await ok.arrayBuffer());
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.equal(harness.calls.updates.length, 1);
    assert.equal(harness.calls.updates[0].params.metadata.manuals_used, '1');
    assert.equal(harness.calls.lastModelBody.model, 'claude-haiku-5-5');
    assert.equal(harness.calls.lastModelBody.thinking.type, 'disabled');
    assert.equal(harness.calls.lastModelBody.output_config.effort, 'low');
    assert.equal(harness.used, 1);

    const after = await fetch(base + '/verify-session?session_id=cs_test_starter');
    assert.deepEqual(await after.json(), { valid: true, plan: 'starter', remaining: 2 });

    harness.calls.failSecond = true;
    const viaHeader = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
      body: JSON.stringify({ plcContent: L5X, brand: 'Acme' }),
    });
    assert.equal(viaHeader.status, 200);
    const failedPdf = Buffer.from(await viaHeader.arrayBuffer());
    assert.equal(failedPdf.subarray(0, 4).toString(), '%PDF');
    assert.equal(failedPdf.includes(Buffer.from('SUPER_SECRET_MODEL_DETAIL')), false);
    assert.equal(harness.calls.updates.length, 2);
    assert.equal(harness.calls.updates[1].params.metadata.manuals_used, '2');
  });
});

test('pro generation does not touch the starter counter and checkout failures stay generic', async () => {
  const harness = createHarness();
  harness.stripe.checkout.sessions.create = async () => {
    throw new Error('SUPER_SECRET_DB_PASSWORD');
  };
  const app = createApp({ env: baseEnv(), stripe: harness.stripe, anthropic: harness.anthropic, renderPdf: fakePdf() });
  await withServer(app, async (base) => {
    const boom = await fetch(base + '/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'starter' }),
    });
    assert.equal(boom.status, 500);
    const boomBody = await boom.json();
    assert.equal(boomBody.error, 'Internal server error');
    assert.equal(JSON.stringify(boomBody).includes('SUPER_SECRET_DB_PASSWORD'), false);

    const pro = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_pro' },
      body: JSON.stringify({ plcContent: L5X }),
    });
    assert.equal(pro.status, 200);
    assert.equal(harness.calls.updates.length, 0);

    const exhausted = createApp({
      env: baseEnv({ STARTER_CREDITS: '0' }),
      stripe: harness.stripe,
      anthropic: {
        messages: { create: async () => { throw new Error('should not be called'); } },
      },
      renderPdf: fakePdf(),
    });
    await withServer(exhausted, async (exhaustedBase) => {
      const res = await fetch(exhaustedBase + '/generate-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
        body: JSON.stringify({ plcContent: L5X }),
      });
      assert.equal(res.status, 402);
      assert.match((await res.json()).error, /credits/i);
    });
  });
});

test('generation reports unavailable when the model key is missing and does not spend a credit', async () => {
  const harness = createHarness();
  const app = createApp({ env: baseEnv(), stripe: harness.stripe, anthropic: null });
  await withServer(app, async (base) => {
    const res = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
      body: JSON.stringify({ plcContent: L5X }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'Manual generation is temporarily unavailable.');
    assert.equal(Object.hasOwn(body, 'stack'), false);
    assert.equal(harness.calls.updates.length, 0);
    const health = await fetch(base + '/health');
    assert.equal((await health.json()).aiEnabled, false);
  });
});

test('production refuses to boot without FRONTEND_URL', () => {
  let code = null;
  const stopped = prepareListen({ NODE_ENV: 'production' }, (status) => { code = status; });
  assert.equal(stopped, false);
  assert.equal(code, 1);

  let railwayCode = null;
  const railwayStopped = prepareListen({ RAILWAY_ENVIRONMENT: 'production' }, (status) => { railwayCode = status; });
  assert.equal(railwayStopped, false);
  assert.equal(railwayCode, 1);

  const dev = prepareListen({ NODE_ENV: 'development' }, () => { throw new Error('exit'); });
  assert.equal(dev, true);
  const ready = prepareListen({ NODE_ENV: 'production', FRONTEND_URL: 'https://manualos.com' }, () => {
    throw new Error('exit');
  });
  assert.equal(ready, true);
});
