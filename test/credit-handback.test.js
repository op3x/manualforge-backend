const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const { commitStarterCredit, refundStarterCredit } = require('../lib/billing');
const {
  createCreditLedger,
  HANDBACK_BACKOFF_MS,
  HOLD_STALE_MARGIN_MS,
} = require('../lib/credit-ledger');
const {
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

function starterStripe() {
  const calls = { updates: [] };
  const meta = { manuals_used: '0', plan: 'starter', credit_generation: '0', credit_hold: '' };
  const decrements = { count: 0 };
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
        applyMeta(meta, params, decrements);
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
          id: 'cs_pro',
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

async function waitJob(base, id, ready) {
  for (let i = 0; i < 100; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`);
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
    assert.equal(warnings[0].includes('59999'), false);
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
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: model,
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
    assert.equal(done.error, JOB_TIMEOUT_MESSAGE);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.decrements.count, 1);
    assert.equal(aiSignal, renderSignal);
    assert.equal(renderSignal.aborted, true);
    late();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await fetch(`${base}/jobs/${job.id}`);
    assert.equal((await after.json()).status, 'failed');
    assert.equal((await fetch(`${base}/jobs/${job.id}/pdf`)).status, 409);
    assert.equal(paid.decrements.count, 1);
    assert.equal(paid.meta.manuals_used, '0');
  });
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
      const pdf = await fetch(`${base}/jobs/${done.id}/pdf`);
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
    const created = await postJob(base, 'cs_pro');
    assert.equal(created.status, 202);
    const job = await created.json();
    await startedPromise;
    fire();
    const done = await waitJob(base, job.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, JOB_TIMEOUT_MESSAGE);
    assert.equal(paid.touched(), false);
    late();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await (await fetch(`${base}/jobs/${job.id}`)).json()).status, 'failed');
  });

  const again = proStripe();
  const ok = createApp({
    env: env(),
    stripe: again.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%pro\n'),
  });
  await withServer(ok, async (base) => {
    const created = await postJob(base, 'cs_pro');
    const done = await waitJob(base, (await created.json()).id);
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
      const createdJob = await postJob(badBase, 'cs_pro');
      const failedJob = await waitJob(badBase, (await createdJob.json()).id);
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
      assert.equal(body.supportDataDirOk, true);
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
