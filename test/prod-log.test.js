const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server');
const { verifyCheckoutSession } = require('../lib/billing');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const { shortJobId } = require('../lib/download-name');
const { forgetSessionCredential, revokeAccessToken, signAccessToken } = require('../lib/access-token');

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
    PORTAL_TOKEN_SECRET: 'test-portal-token-secret-32bytes-min',
    MANUALOS_LEGACY_GENERATE: '1',
    ...extra,
  };
}

function notFound() {
  const err = new Error('No such checkout.session');
  err.statusCode = 404;
  err.code = 'resource_missing';
  return err;
}

function proSession(id) {
  return {
    id,
    metadata: { plan: 'pro' },
    payment_status: 'paid',
    subscription: { id: 'sub_1', status: 'active', customer: 'cus_1', metadata: {} },
    customer: 'cus_1',
  };
}

function countingStripe() {
  const calls = { retrieves: 0 };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          calls.retrieves += 1;
          if (id === 'cs_test_missing') throw notFound();
          return proSession(id);
        },
        create: async () => ({ id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' }),
      },
    },
    webhooks: {
      constructEvent: () => ({ id: 'evt_log', type: 'customer.updated', data: { object: { id: 'cus_1' } } }),
    },
  };
  return { stripe, calls };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function capture(method, fn) {
  const lines = [];
  const original = console[method];
  console[method] = (...args) => lines.push(args.map((arg) => String(arg)).join(' '));
  const restore = () => {
    console[method] = original;
  };
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      restore();
      return { lines, value };
    }, (err) => {
      restore();
      throw err;
    })
    .then((result) => ({ ...result, lines }));
}

test('session ids are rejected before Stripe and only the last four characters are logged', async () => {
  const { stripe, calls } = countingStripe();
  const app = createApp({ env: env(), stripe, anthropic: null });
  const { lines } = await capture('error', () => withServer(app, async (base) => {
    const query = await fetch(`${base}/verify-session?session_id=cs_made_up`);
    assert.equal(query.status, 400);
    assert.deepEqual(await query.json(), { error: 'Session id is invalid.', code: 'invalid_session_id' });
    assert.equal(calls.retrieves, 0);

    const header = await fetch(`${base}/verify-session`, { headers: { 'X-Session-Id': 'nope' } });
    assert.equal(header.status, 400);
    assert.equal((await header.json()).code, 'invalid_session_id');

    const mixed = await fetch(`${base}/verify-session?session_id=cs_test_ok`, {
      headers: { 'X-Session-Id': 'not-a-session' },
    });
    assert.equal(mixed.status, 400);
    assert.equal((await mixed.json()).code, 'invalid_session_id');
    assert.equal(calls.retrieves, 0);

    const empty = await fetch(`${base}/verify-session`);
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'session_id is required');

    const ok = await fetch(`${base}/verify-session?session_id=cs_test_ok`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).valid, true);
    assert.equal(calls.retrieves, 1);

    const token = await fetch(`${base}/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'missing' }),
    });
    assert.equal(token.status, 400);
    assert.equal((await token.json()).code, 'invalid_session_id');

    const form = new FormData();
    form.set('session_id', 'cs_made_up');
    const job = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(job.status, 400);
    assert.equal((await job.json()).code, 'invalid_session_id');

    const listed = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_made_up' } });
    assert.equal(listed.status, 400);
    assert.equal((await listed.json()).code, 'invalid_session_id');

    const shaped = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_test_madeup' } });
    assert.equal(shaped.status, 200);
    assert.deepEqual((await shaped.json()).jobs, []);

    const portal = await fetch(`${base}/billing-portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_made_up' }),
    });
    assert.equal(portal.status, 400);
    assert.equal((await portal.json()).code, 'invalid_session_id');

    const portalHeader = await fetch(`${base}/billing-portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_zz' },
      body: JSON.stringify({}),
    });
    assert.equal(portalHeader.status, 400);
    assert.equal((await portalHeader.json()).code, 'invalid_session_id');

    const tooLong = `cs_test_${'a'.repeat(300)}`;
    const longRes = await fetch(`${base}/verify-session?session_id=${encodeURIComponent(tooLong)}`);
    assert.equal(longRes.status, 400);
    assert.equal((await longRes.json()).code, 'invalid_session_id');
    assert.equal(calls.retrieves, 1);

    await assert.rejects(
      () => verifyCheckoutSession(stripe, 'cs_made_up', env()),
      (err) => err.publicCode === 'invalid_session_id' && err.status === 400,
    );
    assert.equal(calls.retrieves, 1);
  }));

  const logged = lines.join('\n');
  assert.match(logged, /Rejected session id \(\.\.\.deup\)/);
  assert.match(logged, /Rejected session id \(\.\.\.\*\*\*\*\)/);
  assert.match(logged, /Rejected session id \(\.\.\.aaaa\)/);
  assert.equal(logged.includes('cs_made_up'), false);
  assert.equal(logged.includes('not-a-session'), false);
  assert.equal(logged.includes('nope'), false);
  assert.equal(logged.includes(`cs_test_${'a'.repeat(20)}`), false);

  const sunset = createApp({
    env: env({ LEGACY_SESSION_ID_SUNSET: '2000-01-01' }),
    stripe,
    anthropic: null,
  });
  await withServer(sunset, async (base) => {
    const before = calls.retrieves;
    const retired = await fetch(`${base}/verify-session?session_id=not-a-session`);
    assert.equal(retired.status, 401);
    assert.equal((await retired.json()).code, 'session_id_retired');
    const portal = await fetch(`${base}/billing-portal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_made_up' }),
    });
    assert.equal(portal.status, 401);
    assert.equal((await portal.json()).code, 'session_id_retired');
    assert.equal(calls.retrieves, before);
  });

  const revokedEnv = env();
  const minted = signAccessToken({ sessionId: 'cs_test_ok' }, revokedEnv);
  assert.equal(revokeAccessToken(minted.token, revokedEnv), true);
  try {
    const revoked = createApp({ env: revokedEnv, stripe, anthropic: null });
    await withServer(revoked, async (base) => {
      const before = calls.retrieves;
      const res = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_test_ok' } });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, 'credential_revoked');
      assert.equal(calls.retrieves, before);
    });
  } finally {
    forgetSessionCredential('cs_test_ok', revokedEnv);
  }
});

test('body parser failures and unexpected errors return a code and no stack', async () => {
  const { stripe } = countingStripe();
  const app = createApp({ env: env(), stripe, anthropic: null });
  const parsed = await capture('error', () => withServer(app, async (base) => {
    const bad = await fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"plan":',
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_json', code: 'invalid_json' });

    const marker = 'BODYMARKER_SHOULD_NOT_LEAK';
    const huge = await fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"plan":"${marker}${'z'.repeat((1024 * 1024) + 64)}"}`,
    });
    assert.equal(huge.status, 413);
    const hugeBody = await huge.json();
    assert.deepEqual(hugeBody, { error: 'Request body is too large.', code: 'payload_too_large' });
    assert.equal(JSON.stringify(hugeBody).includes(marker), false);
    assert.equal(Object.hasOwn(hugeBody, 'stack'), false);

    stripe.checkout.sessions.retrieve = async () => {
      throw new Error('SUPER_SECRET_STACK_DETAIL');
    };
    const boom = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_boom' },
      body: JSON.stringify({ plcContent: 'x' }),
    });
    assert.equal(boom.status, 500);
    const boomBody = await boom.json();
    assert.deepEqual(boomBody, { error: 'Internal server error', code: 'internal_error' });
    assert.equal(JSON.stringify(boomBody).includes('SUPER_SECRET_STACK_DETAIL'), false);
    assert.equal(JSON.stringify(boomBody).includes('stack'), false);
  }));
  const logged = parsed.lines.join('\n');
  assert.match(logged, /Invalid request body/);
  assert.match(logged, /entity\.parse\.failed/);
  assert.match(logged, /length=/);
  assert.match(logged, /Request body too large \(payload_too_large\)/);
  assert.match(logged, /Request failed \(internal_error\)/);
  assert.equal(logged.includes('{"plan":'), false);
  assert.equal(logged.includes('BODYMARKER_SHOULD_NOT_LEAK'), false);
  assert.equal(logged.includes('SUPER_SECRET_STACK_DETAIL'), false);
  assert.equal(logged.includes('\n    at '), false);

  const debugStripe = countingStripe().stripe;
  debugStripe.checkout.sessions.create = async () => {
    throw new Error('SUPER_SECRET_STACK_DETAIL');
  };
  const debugApp = createApp({ env: env({ DEBUG: '1' }), stripe: debugStripe, anthropic: null });
  const debug = await capture('error', () => withServer(debugApp, async (base) => {
    const boom = await fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'starter', termsAccepted: true, termsVersion: 'terms-2026-10-25' }),
    });
    assert.equal(boom.status, 500);
    const body = await boom.json();
    assert.deepEqual(body, { error: 'Internal server error', code: 'internal_error' });
    assert.equal(JSON.stringify(body).includes('SUPER_SECRET_STACK_DETAIL'), false);
  }));
  assert.equal(debug.lines[0], 'Request failed (internal_error)');
  assert.equal(debug.lines.some((line) => line.includes('SUPER_SECRET_STACK_DETAIL')), true);
});

function starterStripe() {
  const meta = { manuals_used: '0', plan: 'starter', credit_generation: '0', credit_hold: '' };
  const calls = { model: 0 };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_test_joblog',
          metadata: { plan: 'starter' },
          payment_status: 'paid',
          payment_intent: { id: 'pi_joblog', metadata: { ...meta } },
          subscription: null,
        }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_joblog', metadata: { ...meta } }),
      update: async (id, params) => {
        for (const [key, value] of Object.entries(params.metadata)) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, metadata: { ...meta } };
      },
    },
  };
  const anthropic = {
    messages: {
      create: async (body) => {
        calls.model += 1;
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
  return { stripe, anthropic, calls };
}

async function postJob(base, sessionId) {
  const form = new FormData();
  form.set('session_id', sessionId);
  form.set('product_name', 'Secret Pump Name');
  form.set('file', new Blob([L5X]), 'customer-line.L5X');
  const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
  assert.equal(created.status, 202);
  return created.json();
}

async function waitJob(base, id, sessionId) {
  for (let i = 0; i < 100; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`, { headers: { 'X-Session-Id': sessionId } });
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

function jobEvents(lines) {
  return lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed && (parsed.event === 'job_done' || parsed.event === 'job_failed') ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

test('a finished job logs one structured line without customer content', async () => {
  const sessionId = 'cs_test_joblog';
  const paid = starterStripe();
  const pdf = Buffer.from('%PDF-1.4\n<< /Type /Pages >>\n<< /Type /Page >>\n');
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: paid.anthropic,
    renderPdf: async () => pdf,
  });
  const doneLog = await capture('log', () => withServer(app, async (base) => {
    const job = await postJob(base, sessionId);
    const finished = await waitJob(base, job.id, sessionId);
    assert.equal(finished.status, 'succeeded');
    return job.id;
  }));
  const done = jobEvents(doneLog.lines);
  assert.equal(done.length, 1);
  assert.equal(done[0].event, 'job_done');
  assert.equal(done[0].jobId, shortJobId(doneLog.value));
  assert.equal(done[0].jobId.length, 8);
  assert.equal(done[0].plan, 'starter');
  assert.equal(done[0].format, 'l5x');
  assert.equal(typeof done[0].ms, 'number');
  assert.ok(done[0].ms >= 0);
  assert.equal(done[0].pages, 1);
  assert.equal(done[0].modelCalls, paid.calls.model);
  assert.ok(done[0].modelCalls >= 1);
  assert.equal(done[0].errorCode, null);
  const serialized = JSON.stringify(done[0]);
  assert.equal(serialized.includes('Secret Pump'), false);
  assert.equal(serialized.includes('customer-line'), false);
  assert.equal(serialized.includes('.L5X'), false);
  assert.equal(serialized.includes(sessionId), false);
  assert.equal(serialized.includes('pi_joblog'), false);

  const failing = starterStripe();
  const failApp = createApp({
    env: env(),
    stripe: failing.stripe,
    anthropic: failing.anthropic,
    renderPdf: async () => {
      throw new Error('render exploded customer-line.L5X');
    },
  });
  const failLog = await capture('log', () => withServer(failApp, async (base) => {
    const job = await postJob(base, sessionId);
    const finished = await waitJob(base, job.id, sessionId);
    assert.equal(finished.status, 'failed');
    assert.equal(JSON.stringify(finished).includes('customer-line'), false);
  }));
  const failed = jobEvents(failLog.lines);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].event, 'job_failed');
  assert.equal(failed[0].errorCode, 'generation_failed');
  assert.equal(failed[0].pages, 0);
  assert.equal(failed[0].plan, 'starter');
  assert.equal(failed[0].format, 'l5x');
  assert.equal(JSON.stringify(failed[0]).includes('render exploded'), false);
  assert.equal(JSON.stringify(failed[0]).includes('customer-line'), false);

  const slow = starterStripe();
  const timeoutApp = createApp({
    env: env(),
    stripe: slow.stripe,
    anthropic: slow.anthropic,
    scheduleTimeout: (fn) => setTimeout(fn, 30),
    renderPdf: (html, options = {}) => new Promise((resolve, reject) => {
      const signal = options.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('stopped');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      }
    }),
  });
  const timeoutLog = await capture('log', () => withServer(timeoutApp, async (base) => {
    const job = await postJob(base, sessionId);
    const finished = await waitJob(base, job.id, sessionId);
    assert.equal(finished.status, 'failed');
  }));
  const timedOut = jobEvents(timeoutLog.lines);
  assert.equal(timedOut.length, 1);
  assert.equal(timedOut[0].event, 'job_failed');
  assert.equal(timedOut[0].errorCode, 'job_timeout');
  assert.equal(JSON.stringify(timedOut[0]).includes('Secret Pump'), false);
});

test('verify-session reuses a session result for about 10 seconds', async () => {
  let now = 1_000_000;
  let retrieves = 0;
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          retrieves += 1;
          return proSession(id);
        },
      },
    },
    webhooks: {
      constructEvent: () => ({ id: 'evt_cache', type: 'customer.updated', data: { object: { id: 'cus_1' } } }),
    },
  };
  const app = createApp({ env: env(), stripe, anthropic: null, now: () => now });
  await withServer(app, async (base) => {
    for (let i = 0; i < 7; i += 1) {
      const res = await fetch(`${base}/verify-session?session_id=cs_test_cache`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).valid, true);
    }
    const other = await fetch(`${base}/verify-session?session_id=cs_test_cachetwo`);
    assert.equal(other.status, 200);
    const repeat = await fetch(`${base}/verify-session?session_id=cs_test_cache`);
    assert.equal(repeat.status, 200);
    assert.equal(retrieves, 2);
    now += 10000;
    const expired = await fetch(`${base}/verify-session?session_id=cs_test_cache`);
    assert.equal(expired.status, 200);
    assert.equal(retrieves, 3);
  });

  retrieves = 0;
  let status = 'active';
  const fresh = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          retrieves += 1;
          const session = proSession(id);
          session.subscription.status = status;
          return session;
        },
      },
    },
    webhooks: stripe.webhooks,
  };
  const second = createApp({ env: env(), stripe: fresh, anthropic: null, now: () => now });
  await withServer(second, async (base) => {
    const first = await fetch(`${base}/verify-session?session_id=cs_test_cache`);
    assert.equal((await first.json()).valid, true);
    assert.equal(retrieves, 1);
    const hook = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({ id: 'evt_cache', type: 'customer.updated' }),
    });
    assert.equal(hook.status, 200);
    status = 'canceled';
    const after = await fetch(`${base}/verify-session?session_id=cs_test_cache`);
    assert.equal((await after.json()).valid, false);
    assert.equal(retrieves, 2);
  });
});

test('an unbranded checkout event logs only the last 4 characters of the session id', async () => {
  const oursId = 'cs_test_nobrandq7n4';
  const unknownId = 'cs_live_blankm3k8';
  const stripe = {
    webhooks: {
      constructEvent(body) {
        return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
      },
    },
  };
  const app = createApp({ env: env(), stripe, anthropic: null });
  const seen = await capture('log', () => capture('error', () => withServer(app, async (base) => {
    const branded = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_nobrand',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: oursId,
            object: 'checkout.session',
            payment_status: 'paid',
            metadata: { plan: 'starter' },
          },
        },
      }),
    });
    assert.equal(branded.status, 200);
    const blank = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_blank_checkout',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: unknownId,
            object: 'checkout.session',
            payment_status: 'unpaid',
            metadata: {},
          },
        },
      }),
    });
    assert.equal(blank.status, 200);
    assert.deepEqual(await blank.json(), { received: true });
  })));
  const logs = seen.lines.join('\n');
  const errors = seen.value.lines.join('\n');
  const combined = `${logs}\n${errors}`;
  assert.match(logs, /checkout\.session\.completed q7n4 paid/);
  assert.match(errors, /Webhook brand unknown checkout\.session\.completed evt_blank_checkout m3k8/);
  assert.equal(combined.includes(oursId), false);
  assert.equal(combined.includes(unknownId), false);
  assert.equal(combined.includes('nobrand'), false);
  assert.equal(combined.includes('blankm'), false);
});
