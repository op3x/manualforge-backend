const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const {
  commitStarterCredit,
  readCreditHolds,
  refundStarterCredit,
  reserveStarterCredit,
} = require('../lib/billing');
const { createCreditLedger } = require('../lib/credit-ledger');
const { CREDIT_RETURN_MESSAGE } = require('../lib/job-timeout');
const { restoreStarterCredit } = require('../lib/restore-starter-credit');

test.after(() => {
  removeTestJobDirectories();
});

const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
const PI = 'pi_1';

function env(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
    MANUALOS_AI_RETRIES: '0',
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

function starterStripe() {
  const meta = { manuals_used: '0', plan: 'starter', credit_generation: '0' };
  const decrements = { count: 0 };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_test_starter',
          metadata: { plan: 'starter' },
          payment_status: 'paid',
          payment_intent: { id: PI, metadata: { ...meta } },
          subscription: null,
        }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: PI, metadata: { ...meta } }),
      update: async (id, params) => {
        applyMeta(meta, params, decrements);
        return { id, metadata: { ...meta } };
      },
    },
  };
  return { stripe, meta, decrements };
}

function modelReply(body) {
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
        equipment_kind: 'machine',
        overview: 'The line moves product from the infeed to the outfeed when the guards are closed and start is requested.',
        cycle: 'Close the guards, press start, and the infeed runs until stop.',
        subsystems: [],
      }),
    }],
  };
}

function anthropic() {
  return { messages: { create: async (body) => modelReply(body) } };
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
  for (let i = 0; i < 150; i += 1) {
    const body = await (await fetch(`${base}/jobs/${id}`)).json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

async function waitFor(label, fn) {
  for (let i = 0; i < 200; i += 1) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label);
}

function postNamed(base, name) {
  const form = new FormData();
  form.set('session_id', 'cs_test_starter');
  form.set('product_name', name);
  form.set('file', new Blob([L5X]), 'line.L5X');
  return fetch(`${base}/jobs`, { method: 'POST', body: form });
}

function watchUsed(meta) {
  const seen = { max: 0 };
  const timer = setInterval(() => {
    seen.max = Math.max(seen.max, Number(meta.manuals_used || 0));
  }, 5);
  return {
    seen,
    stop() { clearInterval(timer); },
  };
}

test('two overlapping reserves keep both holds and a failure returns only its own credit', async () => {
  const paid = starterStripe();
  const first = await reserveStarterCredit(paid.stripe, PI, env());
  const second = await reserveStarterCredit(paid.stripe, PI, env());
  assert.notEqual(first.token, second.token);
  assert.equal(paid.meta.manuals_used, '2');
  assert.equal(readCreditHolds(paid.meta).size, 2);
  assert.equal(paid.meta.credit_hold, undefined);
  await refundStarterCredit(paid.stripe, PI, first.token);
  assert.equal(paid.meta.manuals_used, '1');
  assert.equal(paid.decrements.count, 1);
  assert.equal(readCreditHolds(paid.meta).has(first.token), false);
  assert.equal(readCreditHolds(paid.meta).get(second.token), second.heldAt);
  assert.equal(paid.meta.credit_hold, second.token);
  await refundStarterCredit(paid.stripe, PI, first.token);
  assert.equal(paid.meta.manuals_used, '1');
  assert.equal(await commitStarterCredit(paid.stripe, PI, second.token), true);
  assert.equal(paid.meta.manuals_used, '1');
  assert.equal(readCreditHolds(paid.meta).size, 0);
  assert.equal(paid.decrements.count, 1);
});

test('a stale hold is released while a newer hold on the same purchase stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-holds-'));
  const paid = starterStripe();
  const ledger = createCreditLedger({ env: env({ SUPPORT_DATA_DIR: dir }) });
  try {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const oldHold = await reserveStarterCredit(paid.stripe, PI, env(), {
      holds: ledger,
      now: () => now,
    });
    now = new Date('2026-10-25T00:00:00.000Z');
    const fresh = await reserveStarterCredit(paid.stripe, PI, env(), {
      holds: ledger,
      now: () => now,
    });
    ledger.unown(oldHold);
    ledger.unown(fresh);
    await ledger.reconcile(paid.stripe, {
      now: Date.parse('2026-10-25T00:01:00.000Z'),
      timeoutMs: 15 * 60 * 1000,
    });
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(readCreditHolds(paid.meta).has(oldHold.token), false);
    assert.equal(readCreditHolds(paid.meta).has(fresh.token), true);
    assert.equal(paid.decrements.count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a support restore clears one hold and leaves the other job its credit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-restore-'));
  const paid = starterStripe();
  try {
    const first = await reserveStarterCredit(paid.stripe, PI, env());
    const second = await reserveStarterCredit(paid.stripe, PI, env());
    const restored = await restoreStarterCredit(paid.stripe, {
      paymentIntentId: PI,
      ticket: 'T-100',
      apply: true,
      key: 'sk_test_secretvalue',
      env: env({ SUPPORT_DATA_DIR: dir }),
    });
    assert.equal(restored.result, 'applied');
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(readCreditHolds(paid.meta).size, 1);
    await refundStarterCredit(paid.stripe, PI, first.token);
    await refundStarterCredit(paid.stripe, PI, second.token);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.decrements.count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function overlapApp(paid, renderPdf, anthropicClient = anthropic()) {
  return createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropicClient,
    renderPdf,
  });
}

test('double-submit: a render failure returns its credit while the other job keeps one', async () => {
  const paid = starterStripe();
  const app = overlapApp(paid, async (html) => {
    if (String(html).includes('SLOWFAIL')) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      throw new Error('render crash');
    }
    return Buffer.from('%PDF-1.4\n%ok\n');
  });
  await withServer(app, async (base) => {
    const watch = watchUsed(paid.meta);
    try {
      const first = await (await postNamed(base, 'SLOWFAIL job A')).json();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = await (await postNamed(base, 'Good job B')).json();
      const jobB = await waitJob(base, second.id);
      const jobA = await waitJob(base, first.id);
      assert.equal(jobA.status, 'failed');
      assert.equal(jobB.status, 'succeeded');
      assert.equal(paid.meta.manuals_used, '1');
      assert.equal(watch.seen.max, 2);
      assert.equal(paid.decrements.count, 1);
      assert.equal(readCreditHolds(paid.meta).size, 0);
    } finally {
      watch.stop();
    }
  });
});

test('retry while the first job is stuck returns only the failed credit', async () => {
  const paid = starterStripe();
  const gates = new Map();
  function gateFor(name) {
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    const gate = { entered: false, ready };
    gate.succeed = () => release(true);
    gate.fail = () => release(false);
    gates.set(name, gate);
    return gate;
  }
  const hang = gateFor('HANG');
  const retry = gateFor('RETRY');
  const app = overlapApp(paid, async (html) => {
    const text = String(html);
    const name = [...gates.keys()].find((item) => text.includes(item));
    const gate = gates.get(name);
    if (!gate) return Buffer.from('%PDF-1.4\n%ok\n');
    gate.entered = true;
    if (!await gate.ready) throw new Error('render crash');
    return Buffer.from('%PDF-1.4\n%ok\n');
  });
  await withServer(app, async (base) => {
    const first = await (await postNamed(base, 'HANG job A')).json();
    await waitFor('first render', () => hang.entered);
    assert.equal(paid.meta.manuals_used, '1');
    const second = await (await postNamed(base, 'RETRY job B')).json();
    await waitFor('second render', () => retry.entered);
    assert.equal(paid.meta.manuals_used, '2');
    assert.equal(readCreditHolds(paid.meta).size, 2);
    retry.succeed();
    const jobB = await waitJob(base, second.id);
    assert.equal(jobB.status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '2');
    assert.equal(readCreditHolds(paid.meta).size, 1);
    hang.fail();
    const jobA = await waitJob(base, first.id);
    assert.equal(jobA.status, 'failed');
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(paid.decrements.count, 1);
    assert.equal(readCreditHolds(paid.meta).size, 0);
  });
});

test('two tabs: one failure and one success leave a single credit used', async () => {
  const paid = starterStripe();
  const gates = new Map();
  function gateFor(name) {
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    const gate = { entered: false, ready };
    gate.succeed = () => release(true);
    gate.fail = () => release(false);
    gates.set(name, gate);
    return gate;
  }
  const tabA = gateFor('TABFAIL');
  const tabB = gateFor('TABGOOD');
  const app = overlapApp(paid, async (html) => {
    const text = String(html);
    const name = [...gates.keys()].find((item) => text.includes(item));
    const gate = gates.get(name);
    if (!gate) return Buffer.from('%PDF-1.4\n%ok\n');
    gate.entered = true;
    if (!await gate.ready) throw new Error('render crash');
    return Buffer.from('%PDF-1.4\n%ok\n');
  });
  await withServer(app, async (base) => {
    const [left, right] = await Promise.all([
      postNamed(base, 'TABFAIL tab A'),
      postNamed(base, 'TABGOOD tab B'),
    ]);
    const idA = (await left.json()).id;
    const idB = (await right.json()).id;
    await waitFor('both tabs rendering', () => tabA.entered && tabB.entered);
    assert.equal(paid.meta.manuals_used, '2');
    assert.equal(readCreditHolds(paid.meta).size, 2);
    tabA.fail();
    tabB.succeed();
    const jobA = await waitJob(base, idA);
    const jobB = await waitJob(base, idB);
    assert.equal(jobA.status, 'failed');
    assert.equal(jobB.status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(paid.decrements.count, 1);
    assert.equal(readCreditHolds(paid.meta).size, 0);
  });
});

test('a job whose every model call fails does not succeed or charge', async () => {
  const paid = starterStripe();
  let calls = 0;
  const failing = {
    messages: {
      create: async () => {
        calls += 1;
        const err = new Error('overloaded');
        err.status = 529;
        throw err;
      },
    },
  };
  const app = overlapApp(paid, async () => Buffer.from('%PDF-1.4\n%ok\n'), failing);
  await withServer(app, async (base) => {
    const posted = await postNamed(base, 'All fail');
    assert.equal(posted.status, 202);
    const job = await waitJob(base, (await posted.json()).id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, CREDIT_RETURN_MESSAGE);
    assert.equal(calls > 0, true);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.decrements.count, 1);
    assert.equal(readCreditHolds(paid.meta).size, 0);
  });
});

test('one failed model call still delivers the manual and keeps the credit', async () => {
  const paid = starterStripe();
  let calls = 0;
  const partial = {
    messages: {
      create: async (body) => {
        calls += 1;
        if (calls === 1) throw new Error('one chunk failed');
        return modelReply(body);
      },
    },
  };
  const app = overlapApp(paid, async () => Buffer.from('%PDF-1.4\n%ok\n'), partial);
  await withServer(app, async (base) => {
    const posted = await postNamed(base, 'Partial');
    const job = await waitJob(base, (await posted.json()).id);
    assert.equal(calls > 1, true);
    assert.equal(job.status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(paid.decrements.count, 0);
  });
});

test('a hung model call is stopped by the job timeout and the hold is released', async () => {
  const paid = starterStripe();
  let fire = null;
  let signal = null;
  const hanging = {
    messages: {
      create: async (body, options) => {
        signal = options && options.signal;
        return new Promise(() => {});
      },
    },
  };
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: hanging,
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
    scheduleTimeout(fn) {
      fire = fn;
      return 1;
    },
    cancelTimeout() {},
  });
  await withServer(app, async (base) => {
    const posted = await postNamed(base, 'Hung');
    const id = (await posted.json()).id;
    await waitFor('model call held', () => (
      paid.meta.manuals_used === '1'
      && typeof fire === 'function'
      && signal
      && signal.aborted === false
    ));
    fire();
    const job = await waitJob(base, id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, CREDIT_RETURN_MESSAGE);
    await waitFor('credit returned', () => paid.meta.manuals_used === '0');
    assert.equal(paid.decrements.count, 1);
    assert.equal(readCreditHolds(paid.meta).size, 0);
  });
});
