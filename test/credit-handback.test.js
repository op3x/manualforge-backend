const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { createJobStore, removeTestJobDirectories } = require('../lib/jobs/store');
const { commitStarterCredit, refundStarterCredit } = require('../lib/billing');
const {
  createCreditLedger,
  DEFAULT_RECONCILE_INTERVAL_MS,
  HANDBACK_BACKOFF_MS,
  HOLD_STALE_MARGIN_MS,
  MAX_RECONCILE_INTERVAL_MS,
  MIN_RECONCILE_INTERVAL_MS,
  reconcileIntervalMs,
} = require('../lib/credit-ledger');
const {
  CREDIT_RETURN_MESSAGE,
  DEFAULT_JOB_TIMEOUT_MS,
  JOB_TIMEOUT_MESSAGE,
  MAX_JOB_TIMEOUT_MS,
  MIN_JOB_TIMEOUT_MS,
  jobTimeoutMs,
} = require('../lib/job-timeout');

test.after(() => {
  removeTestJobDirectories();
});

const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
const TOKEN = '0123456789abcdef';
const PI = 'pi_hold';

function env(extra = {}) {
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

function applyMeta(meta, params, decrements) {
  const prev = Number(meta.manuals_used || 0);
  for (const [key, value] of Object.entries(params.metadata || {})) {
    if (value === '') delete meta[key];
    else meta[key] = value;
  }
  if (params.metadata && params.metadata.manuals_used != null && Number(params.metadata.manuals_used) < prev) {
    decrements.count += 1;
  }
}

function holdStripe({ manualsUsed = '1', token = TOKEN, heldAt, generation = '1', throws = 0 } = {}) {
  const meta = {
    manuals_used: String(manualsUsed),
    plan: 'starter',
    credit_generation: String(generation),
    credit_hold: token,
  };
  if (heldAt) meta.credit_hold_at = heldAt;
  const decrements = { count: 0 };
  let failures = throws;
  const stripe = {
    paymentIntents: {
      retrieve: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('stripe down pi_abcdefghijklmnopqrstuv buyer@example.com sk_test_secretvalue');
        }
        return { id: PI, metadata: { ...meta } };
      },
      update: async (id, params) => {
        applyMeta(meta, params, decrements);
        return { id, metadata: { ...meta } };
      },
    },
  };
  return {
    stripe,
    meta,
    decrements,
    setThrows(n) { failures = n; },
  };
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

function starterStripe({ failReadsAfterClear = 0, loseClearResponse = false } = {}) {
  const calls = { updates: [] };
  const meta = { manuals_used: '0', plan: 'starter', credit_generation: '0', credit_hold: '' };
  const decrements = { count: 0 };
  let clearArmed = false;
  let readsLeft = failReadsAfterClear;
  let lostResponse = false;
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
      retrieve: async () => {
        if (clearArmed && readsLeft > 0) {
          readsLeft -= 1;
          throw new Error('confirm read failed');
        }
        return { id: 'pi_1', metadata: { ...meta } };
      },
      update: async (id, params) => {
        calls.updates.push(params.metadata);
        applyMeta(meta, params, decrements);
        if (params.metadata && params.metadata.credit_hold === '') {
          clearArmed = true;
          if (loseClearResponse && !lostResponse) {
            lostResponse = true;
            throw new Error('response lost');
          }
        }
        return { id, metadata: { ...meta } };
      },
    },
  };
  return { stripe, meta, calls, decrements };
}

function proStripe() {
  let touched = false;
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_test_pro',
          metadata: { plan: 'pro', brand: 'manualos' },
          payment_status: 'paid',
          subscription: { id: 'sub_1', status: 'active', metadata: { plan: 'pro', brand: 'manualos' } },
        }),
      },
    },
    paymentIntents: {
      retrieve: async () => {
        touched = true;
        throw new Error('pro touched a payment intent');
      },
      update: async () => {
        touched = true;
        throw new Error('pro touched a payment intent');
      },
    },
  };
  return { stripe, touched: () => touched };
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

async function waitJob(base, id, ready, sessionId = 'cs_test_starter') {
  for (let i = 0; i < 100; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`, { headers: { 'X-Session-Id': sessionId } });
    const body = await res.json();
    if (ready) {
      if (ready(body)) return body;
    } else if (body.status === 'succeeded' || body.status === 'failed') return body;
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

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holds-'));
}

test('job timeout defaults to 15 minutes and clamps into 1 to 30 with one warning', () => {
  const logs = [];
  const original = console.warn;
  console.warn = (...args) => logs.push(args.map(String).join(' '));
  try {
    assert.equal(jobTimeoutMs({}), DEFAULT_JOB_TIMEOUT_MS);
    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: '' }), DEFAULT_JOB_TIMEOUT_MS);
    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: '   ' }), DEFAULT_JOB_TIMEOUT_MS);
    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: String(MIN_JOB_TIMEOUT_MS) }), MIN_JOB_TIMEOUT_MS);
    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: String(MAX_JOB_TIMEOUT_MS) }), MAX_JOB_TIMEOUT_MS);
    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: '900000' }), 900000);
    assert.equal(logs.filter((line) => line.includes('MANUALOS_JOB_TIMEOUT_MS')).length, 0);

    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: '59999' }), MIN_JOB_TIMEOUT_MS);
    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: '1800001' }), MAX_JOB_TIMEOUT_MS);
    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: 'nope' }), DEFAULT_JOB_TIMEOUT_MS);
    assert.equal(jobTimeoutMs({ MANUALOS_JOB_TIMEOUT_MS: '0' }), MIN_JOB_TIMEOUT_MS);
    const warnings = logs.filter((line) => line.includes('MANUALOS_JOB_TIMEOUT_MS'));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes('59999'), true);
    assert.equal(warnings[0].includes(String(MIN_JOB_TIMEOUT_MS)), true);
    assert.equal(warnings[0].includes('1800001'), false);
    assert.equal(warnings[0].includes('nope'), false);
  } finally {
    console.warn = original;
  }
});

test('a timed-out job hands a Starter credit back once and ignores a late pdf', async () => {
  const paid = starterStripe();
  const armed = [];
  let fire = null;
  let renderSignal = null;
  let aiSignal = null;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let late;
  const latePdf = new Promise((resolve) => { late = resolve; });
  const model = anthropic();
  const original = model.messages.create;
  model.messages.create = async (body, options) => {
    aiSignal = options && options.signal;
    return original(body, options);
  };
  const jobs = createJobStore({ env: env() });
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: model,
    jobs,
    scheduleTimeout(fn, ms) {
      armed.push(ms);
      fire = fn;
      return { unref() {} };
    },
    cancelTimeout() {},
    renderPdf: (html, options) => {
      renderSignal = options && options.signal;
      started();
      return latePdf.then(() => Buffer.from('%PDF-1.4\nlate\n'));
    },
  });
  await withServer(app, async (base) => {
    const created = await postJob(base, 'cs_test_starter');
    assert.equal(created.status, 202);
    const job = await created.json();
    await startedPromise;
    assert.deepEqual(armed, [DEFAULT_JOB_TIMEOUT_MS]);
    const reserve = paid.calls.updates.find((metadata) => metadata.credit_hold && metadata.credit_hold_at);
    assert.ok(reserve);
    assert.match(reserve.credit_hold_at, /^\d{4}-\d{2}-\d{2}T/);
    fire();
    const done = await waitJob(base, job.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, CREDIT_RETURN_MESSAGE);
    assert.equal(done.error.includes('did not use a credit'), false);
    for (let i = 0; i < 50 && paid.meta.manuals_used !== '0'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.decrements.count, 1);
    assert.equal(aiSignal, renderSignal);
    assert.equal(renderSignal.aborted, true);
    late();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal((await after.json()).status, 'failed');
    const anon = await fetch(`${base}/jobs/${job.id}/pdf`);
    assert.equal(anon.status, 401);
    const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal(pdf.status, 409);
    assert.equal(jobs.readPdf(job.id), null);
    assert.equal(paid.decrements.count, 1);
    assert.equal(paid.meta.manuals_used, '0');
  });
  jobs.close();
});

test('a failed hand-back retries and then succeeds', async () => {
  const paid = holdStripe({ throws: 2 });
  const delays = [];
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const ledger = createCreditLedger({
    env: {},
    sleep: async (ms) => { delays.push(ms); },
  });
  try {
    const returned = await ledger.handBack(paid.stripe, PI, TOKEN);
    assert.equal(returned, 0);
    assert.deepEqual(delays, HANDBACK_BACKOFF_MS);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.decrements.count, 1);
    assert.equal(paid.meta.credit_generation, '2');
    const text = logs.join('\n');
    assert.equal(text.includes('pi_abcdefghijklmnopqrstuv'), false);
    assert.equal(text.includes('buyer@example.com'), false);
    assert.equal(text.includes('sk_test_secretvalue'), false);
    assert.match(text, /Starter credit hand-back failed/);
  } finally {
    console.error = original;
  }
});

test('a hand-back that fails three times is queued and a later reconcile returns one credit', async () => {
  const dir = tempDir();
  const paid = holdStripe({ throws: 9 });
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const ledger = createCreditLedger({
    env: { SUPPORT_DATA_DIR: dir },
    sleep: async () => {},
  });
  try {
    const queued = await ledger.handBack(paid.stripe, PI, TOKEN);
    assert.equal(queued, null);
    assert.equal(ledger.pending(), 1);
    assert.equal(paid.decrements.count, 0);
    const file = path.join(dir, 'credit-handbacks.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.length, 1);
    assert.deepEqual(Object.keys(stored[0]).sort(), ['paymentIntentId', 'token']);
    assert.equal(stored[0].paymentIntentId, PI);
    assert.equal(stored[0].token, TOKEN);
    assert.equal(fs.readFileSync(file, 'utf8').includes('buyer@example.com'), false);
    const text = logs.join('\n');
    assert.equal(text.includes('pi_abcdefghijklmnopqrstuv'), false);
    assert.equal(text.includes(PI), false);
    assert.equal(text.includes('buyer@example.com'), false);

    paid.setThrows(0);
    await ledger.reconcile(paid.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.decrements.count, 1);
    assert.equal(ledger.pending(), 0);
    fs.writeFileSync(file, `${JSON.stringify([{ paymentIntentId: PI, token: TOKEN }])}\n`);
    await ledger.reconcile(paid.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.decrements.count, 1);
    assert.equal(paid.meta.credit_generation, '2');
  } finally {
    console.error = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a simulated restart hands back one stale hold and a second reconcile does not', async () => {
  const dir = tempDir();
  const heldAt = new Date(Date.now() - DEFAULT_JOB_TIMEOUT_MS - HOLD_STALE_MARGIN_MS - 5000).toISOString();
  const paid = holdStripe({ heldAt });
  const first = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir } });
  first.note({ paymentIntentId: PI, token: TOKEN, heldAt });
  const restarted = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir } });
  try {
    assert.equal(first.owns(PI, TOKEN), true);
    assert.equal(restarted.owns(PI, TOKEN), false);
    await restarted.reconcile(paid.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.decrements.count, 1);
    await restarted.reconcile(paid.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.decrements.count, 1);
    assert.equal(paid.meta.credit_generation, '2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh hold and an owned hold are left alone', async () => {
  const dir = tempDir();
  const freshAt = new Date().toISOString();
  const fresh = holdStripe({ heldAt: freshAt });
  const writer = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir } });
  writer.note({ paymentIntentId: PI, token: TOKEN, heldAt: freshAt });
  const restarted = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir } });
  await restarted.reconcile(fresh.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
  assert.equal(fresh.meta.manuals_used, '1');
  assert.equal(fresh.meta.credit_hold, TOKEN);
  assert.equal(fresh.decrements.count, 0);

  const staleAt = new Date(Date.now() - DEFAULT_JOB_TIMEOUT_MS - HOLD_STALE_MARGIN_MS - 5000).toISOString();
  const owned = holdStripe({ heldAt: staleAt, token: 'abcdefabcdefabcd' });
  const live = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir } });
  live.note({ paymentIntentId: PI, token: 'abcdefabcdefabcd', heldAt: staleAt });
  await live.reconcile(owned.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
  assert.equal(owned.meta.manuals_used, '1');
  assert.equal(owned.meta.credit_hold, 'abcdefabcdefabcd');
  assert.equal(owned.decrements.count, 0);

  fs.rmSync(dir, { recursive: true, force: true });

  const missingDir = tempDir();
  const missingAt = new Date(Date.now() - DEFAULT_JOB_TIMEOUT_MS - HOLD_STALE_MARGIN_MS - 5000).toISOString();
  const missing = holdStripe({ token: TOKEN });
  delete missing.meta.credit_hold_at;
  const planted = createCreditLedger({ env: { SUPPORT_DATA_DIR: missingDir } });
  planted.note({ paymentIntentId: PI, token: TOKEN, heldAt: missingAt });
  planted.unown({ paymentIntentId: PI, token: TOKEN });
  await planted.reconcile(missing.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
  assert.equal(missing.meta.manuals_used, '1');
  assert.equal(missing.meta.credit_hold, TOKEN);
  assert.equal(missing.decrements.count, 0);
  fs.rmSync(missingDir, { recursive: true, force: true });
});

test('without SUPPORT_DATA_DIR a new ledger cannot see the held credit', async () => {
  const heldAt = new Date(Date.now() - DEFAULT_JOB_TIMEOUT_MS - HOLD_STALE_MARGIN_MS - 5000).toISOString();
  const paid = holdStripe({ heldAt });
  const first = createCreditLedger({ env: {} });
  first.note({ paymentIntentId: PI, token: TOKEN, heldAt });
  const restarted = createCreditLedger({ env: {} });
  await restarted.reconcile(paid.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
  assert.equal(paid.meta.manuals_used, '1');
  assert.equal(paid.decrements.count, 0);
});

test('committing a succeeded hold clears it and a refund cannot return it', async () => {
  const paid = holdStripe({ heldAt: new Date().toISOString() });
  assert.equal(await commitStarterCredit(paid.stripe, PI, TOKEN), true);
  assert.equal(paid.meta.manuals_used, '1');
  assert.equal(paid.meta.credit_hold, undefined);
  assert.equal(paid.meta.credit_hold_at, undefined);
  assert.equal(await commitStarterCredit(paid.stripe, PI, TOKEN), false);
  assert.equal(await refundStarterCredit(paid.stripe, PI, TOKEN), 1);
  assert.equal(paid.meta.manuals_used, '1');
  assert.equal(paid.decrements.count, 0);
});

test('a succeeded job never returns its Starter credit', async () => {
  const dir = tempDir();
  const paid = starterStripe();
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  const app = createApp({
    env: env({ SUPPORT_DATA_DIR: dir }),
    stripe: paid.stripe,
    anthropic: anthropic(),
    creditLedger: ledger,
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
  });
  try {
    await withServer(app, async (base) => {
      const created = await postJob(base, 'cs_test_starter');
      assert.equal(created.status, 202);
      const done = await waitJob(base, (await created.json()).id);
      assert.equal(done.status, 'succeeded');
      assert.equal(paid.meta.manuals_used, '1');
      assert.equal(paid.meta.credit_hold, undefined);
      assert.equal(paid.decrements.count, 0);
      const reserve = paid.calls.updates.find((metadata) => metadata.credit_hold && metadata.credit_hold_at);
      const openFile = path.join(dir, 'open-holds.json');
      const open = fs.existsSync(openFile) ? JSON.parse(fs.readFileSync(openFile, 'utf8')) : [];
      assert.deepEqual(open, []);
      const staleAt = new Date(Date.now() - DEFAULT_JOB_TIMEOUT_MS - HOLD_STALE_MARGIN_MS - 5000).toISOString();
      fs.writeFileSync(openFile, `${JSON.stringify([{
        paymentIntentId: 'pi_1',
        token: reserve.credit_hold,
        heldAt: staleAt,
      }])}\n`);
      await ledger.reconcile(paid.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
      assert.equal(paid.meta.manuals_used, '1');
      assert.equal(paid.decrements.count, 0);
      const pdf = await fetch(`${base}/jobs/${done.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
      assert.equal(pdf.status, 200);
    });
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Pro jobs do not touch Starter credits', async () => {
  const paid = proStripe();
  let fire = null;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  let late;
  const latePdf = new Promise((resolve) => { late = resolve; });
  const hanging = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    scheduleTimeout(fn) {
      fire = fn;
      return { unref() {} };
    },
    cancelTimeout() {},
    renderPdf: () => {
      started();
      return latePdf.then(() => Buffer.from('%PDF-1.4\n%pro\n'));
    },
  });
  await withServer(hanging, async (base) => {
    const created = await postJob(base, 'cs_test_pro');
    assert.equal(created.status, 202);
    const job = await created.json();
    await startedPromise;
    fire();
    const done = await waitJob(base, job.id, null, 'cs_test_pro');
    assert.equal(done.status, 'failed');
    assert.equal(done.error, JOB_TIMEOUT_MESSAGE);
    assert.equal(paid.touched(), false);
    late();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await (await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_test_pro' } })).json()).status, 'failed');
  });

  const again = proStripe();
  const ok = createApp({
    env: env(),
    stripe: again.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%pro\n'),
  });
  await withServer(ok, async (base) => {
    const created = await postJob(base, 'cs_test_pro');
    const done = await waitJob(base, (await created.json()).id, null, 'cs_test_pro');
    assert.equal(done.status, 'succeeded');
    assert.equal(again.touched(), false);
    const failed = proStripe();
    const bad = createApp({
      env: env(),
      stripe: failed.stripe,
      anthropic: anthropic(),
      renderPdf: async () => { throw new Error('render exploded'); },
    });
    await withServer(bad, async (badBase) => {
      const createdJob = await postJob(badBase, 'cs_test_pro');
      const failedJob = await waitJob(badBase, (await createdJob.json()).id, null, 'cs_test_pro');
      assert.equal(failedJob.status, 'failed');
      assert.equal(failed.touched(), false);
    });
  });
});

test('health reports only the pending hand-back count', async () => {
  const dir = tempDir();
  const paid = holdStripe({ throws: 9 });
  const ledger = createCreditLedger({
    env: { SUPPORT_DATA_DIR: dir },
    sleep: async () => {},
    intervalMs: 0,
  });
  try {
    assert.equal(await ledger.handBack(paid.stripe, PI, TOKEN), null);
    const app = createApp({
      env: env({ SUPPORT_DATA_DIR: dir }),
      stripe: paid.stripe,
      anthropic: null,
      creditLedger: ledger,
    });
    await withServer(app, async (base) => {
      const health = await fetch(`${base}/health`);
      const body = await health.json();
      assert.equal(health.status, 200);
      assert.equal(body.creditHandbacksPending, 1);
      assert.equal(typeof body.creditHandbacksPending, 'number');
      assert.equal(body.creditHandbacksDead, 0);
      assert.equal(body.creditHandbacksRejected, 0);
      assert.equal(body.creditLedgerOk, true);
      assert.equal(body.supportDataDirOk, true);
      assert.equal(typeof body.portalTokens, 'boolean');
      const text = JSON.stringify(body);
      assert.equal(text.includes('pi_'), false);
      assert.equal(text.includes(TOKEN), false);
      assert.equal(text.includes('@'), false);
    });
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a confirm read that fails after the hold clear still lets the job succeed once', async () => {
  const paid = starterStripe({ failReadsAfterClear: 1 });
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
  });
  await withServer(app, async (base) => {
    const created = await postJob(base, 'cs_test_starter');
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.decrements.count, 0);
    const pdf = await fetch(`${base}/jobs/${done.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal(pdf.status, 200);
  });
});

test('an unreadable hand-back file is not reported as zero', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'credit-handbacks.json'), '{', { mode: 0o600 });
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    const app = createApp({
      env: env({ SUPPORT_DATA_DIR: dir }),
      stripe: holdStripe().stripe,
      anthropic: null,
      creditLedger: ledger,
    });
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/health`)).json();
      assert.equal(body.creditHandbacksPending, null);
      assert.equal(body.creditHandbacksDead, null);
      assert.equal(body.creditHandbacksRejected, null);
      assert.equal(body.creditLedgerOk, false);
      assert.equal(logs.some((line) => line.includes('Credit hand-back queue could not be read')), true);
      assert.equal(JSON.stringify(body).includes('pi_'), false);
    });
  } finally {
    console.error = original;
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a queued hand-back for a missing payment intent is dead-lettered once', async () => {
  const dir = tempDir();
  const missing = {
    paymentIntents: {
      retrieve: async () => {
        const err = new Error('No such payment_intent');
        err.code = 'resource_missing';
        err.statusCode = 404;
        throw err;
      },
      update: async () => {
        throw new Error('should not update a missing payment intent');
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'credit-handbacks.json'), `${JSON.stringify([{ paymentIntentId: 'pi_missing', token: TOKEN }])}\n`);
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  try {
    await ledger.reconcile(missing, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    await ledger.reconcile(missing, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    const pending = JSON.parse(fs.readFileSync(path.join(dir, 'credit-handbacks.json'), 'utf8'));
    const dead = JSON.parse(fs.readFileSync(path.join(dir, 'credit-handbacks-dead.json'), 'utf8'));
    assert.deepEqual(pending, []);
    assert.deepEqual(dead, [{ paymentIntentId: 'pi_missing', token: TOKEN }]);
    const app = createApp({
      env: env({ SUPPORT_DATA_DIR: dir }),
      stripe: missing,
      anthropic: null,
      creditLedger: ledger,
    });
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/health`)).json();
      assert.equal(body.creditHandbacksPending, 0);
      assert.equal(body.creditHandbacksDead, 1);
      assert.equal(body.creditHandbacksRejected, 0);
      assert.equal(body.creditLedgerOk, true);
      assert.equal(JSON.stringify(body).includes('pi_'), false);
      assert.equal(JSON.stringify(body).includes(TOKEN), false);
    });
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a credit record is fsynced before it is renamed', () => {
  const dir = tempDir();
  const events = [];
  const origFsync = fs.fsyncSync;
  const origRename = fs.renameSync;
  fs.fsyncSync = (fd) => {
    events.push('fsync');
    return origFsync(fd);
  };
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('open-holds.json')) events.push('rename');
    return origRename(from, to);
  };
  try {
    const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
    ledger.note({ paymentIntentId: PI, token: TOKEN, heldAt: '2026-01-01T00:00:00.000Z' });
    ledger.close();
    assert.deepEqual(events, ['fsync', 'rename', 'fsync']);
  } finally {
    fs.fsyncSync = origFsync;
    fs.renameSync = origRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hold-clear write that lands and loses its response stays committed', async () => {
  const meta = {
    manuals_used: '1',
    plan: 'starter',
    credit_generation: '1',
    credit_hold: TOKEN,
    credit_hold_at: '2026-01-01T00:00:00.000Z',
  };
  const decrements = { count: 0 };
  let lost = false;
  const stripe = {
    paymentIntents: {
      retrieve: async () => ({ id: PI, metadata: { ...meta } }),
      update: async (id, params) => {
        applyMeta(meta, params, decrements);
        if (!lost && params.metadata && params.metadata.credit_hold === '') {
          lost = true;
          throw new Error('response lost');
        }
        return { id, metadata: { ...meta } };
      },
    },
  };
  assert.equal(await commitStarterCredit(stripe, PI, TOKEN), true);
  assert.equal(meta.manuals_used, '1');
  assert.equal(meta.credit_hold, undefined);
  assert.equal(meta.credit_hold_at, undefined);
  assert.equal(decrements.count, 0);
  assert.equal(await refundStarterCredit(stripe, PI, TOKEN), 1);
  assert.equal(meta.manuals_used, '1');
  assert.equal(decrements.count, 0);
});

test('a failed job is marked failed before the hand-back while Stripe stays down', async () => {
  const meta = { manuals_used: '0', plan: 'starter', credit_generation: '0', credit_hold: '' };
  const decrements = { count: 0 };
  let phase = 'up';
  let releaseGate = () => {};
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let held = false;
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
      retrieve: async () => {
        if (phase === 'down') {
          if (!held) {
            held = true;
            await gate;
          }
          throw new Error('stripe down');
        }
        return { id: 'pi_1', metadata: { ...meta } };
      },
      update: async (id, params) => {
        if (phase === 'down') throw new Error('stripe down');
        applyMeta(meta, params, decrements);
        return { id, metadata: { ...meta } };
      },
    },
  };
  const dir = tempDir();
  const ledger = createCreditLedger({
    env: { SUPPORT_DATA_DIR: dir },
    sleep: async () => {},
    intervalMs: 0,
  });
  const app = createApp({
    env: env({ SUPPORT_DATA_DIR: dir }),
    stripe,
    anthropic: anthropic(),
    creditLedger: ledger,
    scheduleTimeout() { return { unref() {} }; },
    cancelTimeout() {},
    renderPdf: () => {
      phase = 'down';
      throw new Error('render exploded');
    },
  });
  try {
    await withServer(app, async (base) => {
      const created = await postJob(base, 'cs_test_starter');
      assert.equal(created.status, 202);
      const done = await waitJob(base, (await created.json()).id);
      assert.equal(done.status, 'failed');
      assert.equal(done.error, CREDIT_RETURN_MESSAGE);
      assert.equal(done.error.includes('did not use a credit'), false);
      assert.equal(ledger.pending(), 0);
      assert.equal(meta.manuals_used, '1');
      releaseGate();
      for (let i = 0; i < 50 && ledger.pending() !== 1; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(ledger.pending(), 1);
      assert.equal(meta.manuals_used, '1');
      assert.equal(decrements.count, 0);
      assert.match(meta.credit_hold, /^[a-f0-9]{16}$/);
    });
  } finally {
    releaseGate();
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable open-hold file fails the ledger check', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'open-holds.json'), '{', { mode: 0o600 });
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  try {
    assert.throws(() => ledger.note({ paymentIntentId: PI, token: TOKEN, heldAt: '2026-01-01T00:00:00.000Z' }));
    const paid = starterStripe();
    const app = createApp({
      env: env({ SUPPORT_DATA_DIR: dir }),
      stripe: paid.stripe,
      anthropic: anthropic(),
      creditLedger: ledger,
    });
    await withServer(app, async (base) => {
      const posted = await postJob(base, 'cs_test_starter');
      assert.equal(posted.status, 500);
      assert.equal(paid.meta.manuals_used, '0');
      const body = await (await fetch(`${base}/health`)).json();
      assert.equal(body.creditLedgerOk, false);
      assert.equal(body.creditHandbacksPending, null);
      assert.equal(body.creditHandbacksDead, null);
      assert.equal(body.creditHandbacksRejected, null);
      assert.equal(logs.some((line) => line.includes('Open credit hold record could not be read')), true);
      assert.equal(logs.some((line) => line.includes('Credit ledger could not be read')), true);
    });
  } finally {
    console.error = original;
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hand-back id that is not a PaymentIntent is counted and only its last 4 characters are logged', async () => {
  const dir = tempDir();
  const bad = 'ch_not_a_payment_intentABCD';
  fs.writeFileSync(path.join(dir, 'credit-handbacks.json'), `${JSON.stringify([
    { paymentIntentId: bad, token: TOKEN },
    { paymentIntentId: PI, token: TOKEN },
  ])}\n`);
  const logs = [];
  const original = console.warn;
  console.warn = (...args) => logs.push(args.map(String).join(' '));
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  try {
    const first = ledger.health();
    const second = ledger.health();
    assert.equal(first.ok, true);
    assert.equal(first.pending, 1);
    assert.equal(first.rejected, 1);
    assert.equal(second.rejected, 1);
    const warnings = logs.filter((line) => line.includes('not a PaymentIntent'));
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes('ABCD'), true);
    assert.equal(warnings[0].includes(bad), false);
    assert.equal(warnings[0].includes('ch_not'), false);
    const app = createApp({
      env: env({ SUPPORT_DATA_DIR: dir }),
      stripe: {
        paymentIntents: {
          retrieve: async () => { throw new Error('stripe down'); },
          update: async () => { throw new Error('stripe down'); },
        },
      },
      anthropic: null,
      creditLedger: ledger,
    });
    await withServer(app, async (base) => {
      const body = await (await fetch(`${base}/health`)).json();
      assert.equal(body.creditHandbacksPending, 1);
      assert.equal(body.creditHandbacksRejected, 1);
      assert.equal(body.creditLedgerOk, true);
      assert.equal(JSON.stringify(body).includes(bad), false);
      assert.equal(JSON.stringify(body).includes('ABCD'), false);
    });
  } finally {
    console.warn = original;
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcile interval clamps into 1 minute to 1 hour and intervalMs 0 stays off', () => {
  const logs = [];
  const original = console.warn;
  console.warn = (...args) => logs.push(args.map(String).join(' '));
  const origInterval = global.setInterval;
  const seen = [];
  global.setInterval = (fn, ms, ...rest) => {
    seen.push(ms);
    return origInterval(fn, ms, ...rest);
  };
  try {
    assert.equal(reconcileIntervalMs({}), DEFAULT_RECONCILE_INTERVAL_MS);
    assert.equal(reconcileIntervalMs({ MANUALOS_RECONCILE_INTERVAL_MS: '' }), DEFAULT_RECONCILE_INTERVAL_MS);
    assert.equal(reconcileIntervalMs({ MANUALOS_RECONCILE_INTERVAL_MS: String(MIN_RECONCILE_INTERVAL_MS) }), MIN_RECONCILE_INTERVAL_MS);
    assert.equal(reconcileIntervalMs({ MANUALOS_RECONCILE_INTERVAL_MS: String(MAX_RECONCILE_INTERVAL_MS) }), MAX_RECONCILE_INTERVAL_MS);
    assert.equal(logs.length, 0);
    assert.equal(reconcileIntervalMs({ MANUALOS_RECONCILE_INTERVAL_MS: '1000' }), MIN_RECONCILE_INTERVAL_MS);
    assert.equal(reconcileIntervalMs({ MANUALOS_RECONCILE_INTERVAL_MS: '99999999' }), MAX_RECONCILE_INTERVAL_MS);
    assert.equal(reconcileIntervalMs({ MANUALOS_RECONCILE_INTERVAL_MS: 'nope' }), DEFAULT_RECONCILE_INTERVAL_MS);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].includes('1000'), true);
    assert.equal(logs[0].includes(String(MIN_RECONCILE_INTERVAL_MS)), true);
    assert.equal(logs[0].includes('99999999'), false);
    const quiet = { paymentIntents: { retrieve: async () => ({ metadata: {} }) } };
    const off = createCreditLedger({ env: { MANUALOS_RECONCILE_INTERVAL_MS: '1000' }, intervalMs: 0 });
    off.attach(quiet);
    assert.deepEqual(seen, []);
    off.close();
    const on = createCreditLedger({ env: { MANUALOS_RECONCILE_INTERVAL_MS: '120000' } });
    on.attach(quiet);
    assert.deepEqual(seen, [120000]);
    on.close();
  } finally {
    console.warn = original;
    global.setInterval = origInterval;
  }
});

test('reconcile clears a generation marker older than this process and leaves a fresh one', async () => {
  const dir = tempDir();
  const stalePi = 'pi_stalehold';
  const freshPi = 'pi_freshhold';
  const freshToken = 'abcdef0123456789';
  const heldAt = new Date().toISOString();
  const staleStart = new Date(Date.now() - 120000).toISOString();
  const freshStart = new Date().toISOString();
  const metas = {
    [stalePi]: {
      manuals_used: '1',
      plan: 'starter',
      credit_generation: '1',
      credit_hold: TOKEN,
      credit_hold_at: heldAt,
      generation_started_at: staleStart,
      generation_in_progress: '1',
    },
    [freshPi]: {
      manuals_used: '1',
      plan: 'starter',
      credit_generation: '1',
      credit_hold: freshToken,
      credit_hold_at: heldAt,
      generation_started_at: freshStart,
      generation_in_progress: '2',
    },
  };
  const updates = [];
  const stripe = {
    paymentIntents: {
      retrieve: async (id) => ({ id, metadata: { ...metas[id] } }),
      update: async (id, params) => {
        updates.push({ id, metadata: { ...params.metadata } });
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete metas[id][key];
          else metas[id][key] = value;
        }
        return { id, metadata: { ...metas[id] } };
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'open-holds.json'), `${JSON.stringify([
    { paymentIntentId: stalePi, token: TOKEN, heldAt },
    { paymentIntentId: freshPi, token: freshToken, heldAt },
  ])}\n`);
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  try {
    await ledger.reconcile(stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    assert.equal(metas[stalePi].generation_started_at, undefined);
    assert.equal(metas[stalePi].generation_in_progress, undefined);
    assert.equal(metas[stalePi].manuals_used, '1');
    assert.equal(metas[stalePi].credit_hold, TOKEN);
    assert.equal(metas[freshPi].generation_started_at, freshStart);
    assert.equal(metas[freshPi].generation_in_progress, '2');
    assert.equal(metas[freshPi].manuals_used, '1');
    assert.equal(metas[freshPi].credit_hold, freshToken);
    const staleUpdate = updates.find((row) => row.id === stalePi);
    assert.deepEqual(Object.keys(staleUpdate.metadata).sort(), ['generation_in_progress', 'generation_started_at']);
    assert.equal(updates.some((row) => row.id === freshPi), false);
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lost hold-clear response followed by failed confirm reads still delivers the manual', async () => {
  const meta = {
    manuals_used: '1',
    plan: 'starter',
    credit_generation: '1',
    credit_hold: TOKEN,
    credit_hold_at: '2026-01-01T00:00:00.000Z',
  };
  const decrements = { count: 0 };
  let lost = false;
  let failedReads = 0;
  const stripe = {
    paymentIntents: {
      retrieve: async () => {
        if (lost) {
          failedReads += 1;
          throw new Error('confirm read failed');
        }
        return { id: PI, metadata: { ...meta } };
      },
      update: async (id, params) => {
        applyMeta(meta, params, decrements);
        lost = true;
        throw new Error('response lost');
      },
    },
  };
  assert.equal(await commitStarterCredit(stripe, PI, TOKEN), true);
  assert.ok(failedReads >= 2);
  assert.equal(meta.manuals_used, '1');
  assert.equal(meta.credit_hold, undefined);
  assert.equal(decrements.count, 0);

  const paid = starterStripe({ loseClearResponse: true, failReadsAfterClear: 8 });
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
  });
  await withServer(app, async (base) => {
    const created = await postJob(base, 'cs_test_starter');
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.error == null, true);
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.decrements.count, 0);
    assert.equal((await fetch(`${base}/jobs/${done.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } })).status, 200);
    assert.equal(JSON.stringify(done).includes('credit is being returned'), false);
  });
});

test('queued hand-backs are retried when open holds cannot be read', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'open-holds.json'), '{', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'credit-handbacks.json'), `${JSON.stringify([{ paymentIntentId: PI, token: TOKEN }])}\n`);
  const paid = holdStripe();
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  try {
    await assert.rejects(() => ledger.reconcile(paid.stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS }));
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.decrements.count, 1);
    assert.equal(paid.meta.credit_hold, undefined);
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rewriting the hand-back queue keeps the rejected payment id count', () => {
  const dir = tempDir();
  const bad = 'ch_not_a_payment_intentABCD';
  fs.writeFileSync(path.join(dir, 'credit-handbacks.json'), `${JSON.stringify([
    { paymentIntentId: bad, token: TOKEN },
    { paymentIntentId: PI, token: TOKEN },
  ])}\n`);
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  try {
    assert.equal(ledger.health().rejected, 1);
    ledger.drop({ paymentIntentId: PI, token: TOKEN });
    assert.equal(ledger.health().rejected, 1);
    assert.equal(ledger.pending(), 0);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'credit-handbacks.json'), 'utf8'));
    assert.equal(stored.some((row) => row.paymentIntentId === bad), true);
    assert.equal(stored.some((row) => row.paymentIntentId === PI), false);
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a payment id of 4 characters or fewer is masked completely', () => {
  const dir = tempDir();
  const short = 'ch_1';
  fs.writeFileSync(path.join(dir, 'credit-handbacks.json'), `${JSON.stringify([{ paymentIntentId: short, token: TOKEN }])}\n`);
  const logs = [];
  const original = console.warn;
  console.warn = (...args) => logs.push(args.map(String).join(' '));
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  try {
    assert.equal(ledger.health().rejected, 1);
    const warning = logs.find((line) => line.includes('not a PaymentIntent'));
    assert.ok(warning);
    assert.equal(warning.includes(short), false);
    assert.equal(warning.includes('****'), true);
  } finally {
    console.warn = original;
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generation markers are swept once and not on later reconciles', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'credit-handbacks.json'), `${JSON.stringify([{ paymentIntentId: PI, token: TOKEN }])}\n`);
  let reads = 0;
  const stripe = {
    paymentIntents: {
      retrieve: async () => {
        reads += 1;
        throw new Error('stripe down');
      },
      update: async () => {
        throw new Error('stripe down');
      },
    },
  };
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
  try {
    await ledger.reconcile(stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    const first = reads;
    await ledger.reconcile(stripe, { now: Date.now(), timeoutMs: DEFAULT_JOB_TIMEOUT_MS });
    assert.equal(first, 2);
    assert.equal(reads, first + 1);
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory sync failure after rename still keeps the credit record', () => {
  const dir = tempDir();
  const origFsync = fs.fsyncSync;
  let calls = 0;
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  fs.fsyncSync = (fd) => {
    calls += 1;
    if (calls >= 2) throw new Error('dir sync failed /secret/path');
    return origFsync(fd);
  };
  try {
    const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: dir }, intervalMs: 0 });
    ledger.note({ paymentIntentId: PI, token: TOKEN, heldAt: '2026-01-01T00:00:00.000Z' });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'open-holds.json'), 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].token, TOKEN);
    const text = logs.join('\n');
    assert.equal(text.includes('Credit record directory sync failed'), true);
    assert.equal(text.includes('/secret/path'), false);
    ledger.close();
  } finally {
    fs.fsyncSync = origFsync;
    console.error = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
