const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { createApp } = require('../server');
const { limits, UPLOAD_BYTES, ZIP_UNPACKED_BYTES, MODEL_CALL_TIMEOUT_MS, JOB_TTL_CAP_MS } = require('../lib/limits');
const { estimateModelCalls } = require('../lib/ai');
const { parseUploads } = require('../lib/parsers');
const { createAiSpend, monthKey, removeTestSpendDirectories } = require('../lib/ai-spend');
const { createJobStore, removeTestJobDirectories } = require('../lib/jobs/store');
const { Readable } = require('stream');
const {
  JOB_TOO_LARGE_MESSAGE,
  GENERATION_PAUSED_MESSAGE,
  CHECKOUT_PAUSED_MESSAGE,
} = require('../lib/ai-budget');
const { fileTooLargeMessage } = require('../lib/upload-errors');
const { readMultipart } = require('../lib/uploads');
const { createCreditLedger } = require('../lib/credit-ledger');
const { CREDIT_RETURN_MESSAGE } = require('../lib/job-timeout');

const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
const dirs = [];

test.after(() => {
  removeTestJobDirectories();
  removeTestSpendDirectories();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-budget-'));
  dirs.push(dir);
  return dir;
}

function env(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
    DATA_DIR: tempDir(),
    ...extra,
  };
}

function stripeFor(usedStart = '0') {
  const calls = { updates: [] };
  const meta = {
    manuals_used: String(usedStart),
    plan: 'starter',
    credit_generation: '0',
  };
  const stripe = {
    checkout: {
      sessions: {
        create: async () => {
          throw new Error('Checkout called Stripe');
        },
        retrieve: async (id) => {
          if (id === 'cs_test_pro') {
            return {
              id,
              metadata: { plan: 'pro' },
              payment_status: 'paid',
              payment_intent: null,
              subscription: { id: 'sub_1', status: 'active', metadata: { plan: 'pro' } },
            };
          }
          return {
            id: 'cs_test_starter',
            metadata: { plan: 'starter' },
            payment_status: 'paid',
            payment_intent: { id: 'pi_1', metadata: { ...meta } },
            subscription: null,
          };
        },
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_1', created: 1700000000, metadata: { ...meta } }),
      update: async (id, params) => {
        calls.updates.push({ ...params.metadata });
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, metadata: { ...meta } };
      },
    },
    subscriptions: {
      retrieve: async () => ({ id: 'sub_1', status: 'active', metadata: { plan: 'pro' } }),
    },
    webhooks: {
      constructEvent(body, signature) {
        if (signature !== 't=1,v1=ok') throw new Error('bad signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
  return { stripe, meta, calls };
}

function modelMessage(body, usage) {
  const indexes = [...String(body.messages[0].content).matchAll(/"index":\s*(\d+)/g)].map((match) => Number(match[1]));
  return {
    usage: usage || { input_tokens: 20, output_tokens: 10 },
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
        product_name: 'Case erector',
        overview: 'The machine forms a case and moves it onward when the guards are closed and start is pressed.',
        cycle: 'The operator presses start, the case is formed, and the discharge runs.',
        subsystems: [],
      }),
    }],
  };
}

function anthropic(create) {
  return { messages: { create: create || (async (body) => modelMessage(body)) } };
}

function hold() {
  let release;
  let opened;
  const started = new Promise((resolve) => { opened = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    started,
    release: () => release(),
    beforeGenerate: async () => {
      opened();
      await gate;
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

async function postJob(base, bytes = L5X, name = 'line.L5X', fields = {}) {
  const form = new FormData();
  form.set('session_id', 'cs_test_starter');
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set('file', new Blob([bytes]), name);
  return fetch(`${base}/jobs`, { method: 'POST', body: form });
}

async function waitJob(base, id) {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

test('limits default to a 25 MB upload, a 100 MB zip, and the per-job caps', () => {
  const cap = limits({});
  assert.equal(cap.uploadBytes, 25 * 1024 * 1024);
  assert.equal(UPLOAD_BYTES, 25 * 1024 * 1024);
  assert.equal(cap.zipMaxBytes, 100 * 1024 * 1024);
  assert.equal(ZIP_UNPACKED_BYTES, 100 * 1024 * 1024);
  assert.equal(cap.zipMaxFiles, 80);
  assert.equal(cap.jobMaxCalls, 60);
  assert.equal(cap.jobMaxTokens, 1500000);
  assert.equal(cap.modelCallTimeoutMs, MODEL_CALL_TIMEOUT_MS);
  assert.equal(MODEL_CALL_TIMEOUT_MS, 120000);
  assert.equal(cap.jobTtlMs, JOB_TTL_CAP_MS);
  assert.equal(limits({ MANUALOS_MODEL_CALL_TIMEOUT_MS: '1500' }).modelCallTimeoutMs, 1500);
  assert.equal(cap.aiMonthlyBudgetUsd, 20);
  assert.equal(cap.aiInputUsdPerMtok, 0.1);
  assert.equal(cap.aiOutputUsdPerMtok, 0.5);
  assert.equal(cap.checkoutPaused, false);
  assert.equal(cap.generationPaused, false);
  for (const on of ['true', 'TRUE', 'True', '1']) {
    assert.equal(limits({ MANUALOS_CHECKOUT_DISABLED: on }).checkoutPaused, true);
    assert.equal(limits({ MANUALOS_GENERATION_DISABLED: on }).generationPaused, true);
  }
  for (const off of [undefined, '', 'false', 'yes', 'on', '0', '2']) {
    assert.equal(limits({ MANUALOS_CHECKOUT_DISABLED: off }).checkoutPaused, false);
    assert.equal(limits({ MANUALOS_GENERATION_DISABLED: off }).generationPaused, false);
  }
  assert.equal(limits({ MANUALOS_CHECKOUT_DISABLED: ' true ' }).checkoutPaused, true);
  assert.equal(limits({ MANUALOS_JOB_MAX_CALLS: '12' }).jobMaxCalls, 12);
  assert.equal(limits({ MANUALOS_MAX_UPLOAD_BYTES: '2048' }).uploadBytes, 2048);
  assert.equal(limits({ MANUALOS_ZIP_MAX_BYTES: '4096' }).zipMaxBytes, 4096);
});

test('a project over the call estimate is rejected before any model call and the credit is released', async () => {
  const paid = stripeFor('0');
  let calls = 0;
  const app = createApp({
    env: env({ MANUALOS_JOB_MAX_CALLS: '1', MANUALOS_LEGACY_GENERATE: '1' }),
    stripe: paid.stripe,
    anthropic: anthropic(async () => {
      calls += 1;
      throw new Error('model should not be called');
    }),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  const project = await parseUploads([{ originalname: 'line.L5X', buffer: L5X }], {}, {});
  assert.ok(estimateModelCalls(project, {}) > 1);
  await withServer(app, async (base) => {
    const created = await postJob(base);
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'failed');
    assert.equal(done.code, 'job_too_large');
    assert.equal(done.error, JOB_TOO_LARGE_MESSAGE);
    assert.equal(done.message, JOB_TOO_LARGE_MESSAGE);
    assert.equal(calls, 0);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.meta.generation_in_progress, undefined);
    const pdf = await fetch(`${base}/jobs/${done.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal(pdf.status, 409);
    const legacy = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8') }),
    });
    assert.equal(legacy.status, 422);
    const legacyBody = await legacy.json();
    assert.equal(legacyBody.error, JOB_TOO_LARGE_MESSAGE);
    assert.equal(legacyBody.message, JOB_TOO_LARGE_MESSAGE);
    assert.equal(legacyBody.code, 'job_too_large');
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(calls, 0);
  });
});

test('retries count toward the per-job call cap and no partial manual is saved', async () => {
  const project = await parseUploads([{ originalname: 'line.L5X', buffer: L5X }], {}, {});
  const estimated = estimateModelCalls(project, {});
  assert.ok(estimated > 1);
  const paid = stripeFor('0');
  let calls = 0;
  const app = createApp({
    env: env({
      MANUALOS_JOB_MAX_CALLS: String(estimated),
      MANUALOS_AI_RETRIES: String(estimated),
      MANUALOS_AI_CONCURRENCY: '1',
    }),
    stripe: paid.stripe,
    anthropic: anthropic(async () => {
      calls += 1;
      throw new Error('model unavailable');
    }),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(app, async (base) => {
    const created = await postJob(base);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'failed');
    assert.equal(done.code, 'job_too_large');
    assert.equal(done.error, JOB_TOO_LARGE_MESSAGE);
    assert.equal(calls, estimated);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    const pdf = await fetch(`${base}/jobs/${done.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal(pdf.status, 409);
  });
});

test('real input and output tokens stop the job at the token cap', async () => {
  const paid = stripeFor('0');
  let calls = 0;
  const app = createApp({
    env: env({ MANUALOS_JOB_MAX_TOKENS: '100', MANUALOS_AI_CONCURRENCY: '1' }),
    stripe: paid.stripe,
    anthropic: anthropic(async (body) => {
      calls += 1;
      return modelMessage(body, { input_tokens: 80, output_tokens: 40 });
    }),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(app, async (base) => {
    const created = await postJob(base);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'failed');
    assert.equal(done.code, 'job_too_large');
    assert.equal(done.error, JOB_TOO_LARGE_MESSAGE);
    assert.equal(calls, 1);
    assert.equal(paid.meta.manuals_used, '0');
    const pdf = await fetch(`${base}/jobs/${done.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal(pdf.status, 409);
  });
});

test('activeJobs rises while a job is running and returns to 0 after success, failure, or job_too_large', async () => {
  async function watch(app, baseExpect, code) {
    const gate = hold();
    const createdApp = app(gate);
    await withServer(createdApp, async (base) => {
      const pending = postJob(base);
      await gate.started;
      const created = await pending;
      assert.equal(created.status, 202);
      const job = await created.json();
      const during = await (await fetch(`${base}/health`)).json();
      assert.equal(during.activeJobs, 1);
      assert.equal(during.activeJobs >= 0, true);
      const encoded = JSON.stringify(during);
      assert.equal(encoded.includes(job.id), false);
      assert.equal(encoded.includes('cs_test'), false);
      assert.equal(encoded.includes('pi_'), false);
      gate.release();
      const done = await waitJob(base, job.id);
      assert.equal(done.status, baseExpect);
      if (code) assert.equal(done.code, code);
      const after = await (await fetch(`${base}/health`)).json();
      assert.equal(after.activeJobs, 0);
    });
  }

  const success = stripeFor('0');
  await watch((gate) => createApp({
    env: env(),
    stripe: success.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
    beforeGenerate: gate.beforeGenerate,
  }), 'succeeded');

  const failed = stripeFor('0');
  await watch((gate) => createApp({
    env: env(),
    stripe: failed.stripe,
    anthropic: anthropic(),
    renderPdf: async () => { throw new Error('render exploded'); },
    beforeGenerate: gate.beforeGenerate,
  }), 'failed');
  assert.equal(failed.meta.manuals_used, '0');

  const tooLarge = stripeFor('0');
  let calls = 0;
  await watch((gate) => createApp({
    env: env({ MANUALOS_JOB_MAX_CALLS: '1' }),
    stripe: tooLarge.stripe,
    anthropic: anthropic(async () => {
      calls += 1;
      throw new Error('should not be called');
    }),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
    beforeGenerate: gate.beforeGenerate,
  }), 'failed', 'job_too_large');
  assert.equal(calls, 0);
  assert.equal(tooLarge.meta.manuals_used, '0');
});

test('a restarted process gives the interrupted credit back through the hand-back and leaves no delivery stamp', async () => {
  const support = tempDir();
  const jobDir = path.join(support, 'jobs');
  const paid = stripeFor('0');
  const gate = hold();
  const runtime = env({ SUPPORT_DATA_DIR: support, DATA_DIR: support });
  const ledger = createCreditLedger({ env: runtime, intervalMs: 0 });
  function openJobs() {
    return createJobStore({
      env: runtime,
      directory: jobDir,
      onAbandonedCredit(holdInfo) {
        return ledger.handBack(paid.stripe, holdInfo.paymentIntentId, holdInfo.token);
      },
    });
  }
  const jobs = openJobs();
  const first = createApp({
    env: runtime,
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%interrupted\n'),
    beforeGenerate: gate.beforeGenerate,
    jobs,
    creditLedger: ledger,
  });
  let jobId = '';
  let pending;
  await withServer(first, async (base) => {
    pending = postJob(base);
    await gate.started;
    const created = await pending;
    assert.equal(created.status, 202);
    jobId = (await created.json()).id;
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(typeof paid.meta.credit_hold, 'string');
    assert.equal(paid.meta.first_manual_at, undefined);
    const record = fs.readFileSync(path.join(jobDir, `${jobId}.json`), 'utf8');
    assert.equal(record.includes('cs_test_starter'), false);
    assert.equal(record.includes(paid.meta.credit_hold), true);
  });
  jobs.close();
  const restarted = openJobs();
  try {
    await restarted.releasesSettled();
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.meta.first_manual_at, undefined);
    const failed = restarted.get(jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, CREDIT_RETURN_MESSAGE);
  } finally {
    restarted.close();
  }
  const again = openJobs();
  try {
    await again.releasesSettled();
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.meta.first_manual_at, undefined);
    const second = createApp({
      env: runtime,
      stripe: paid.stripe,
      anthropic: anthropic(),
      renderPdf: async () => Buffer.from('%PDF-1.4\n%next\n'),
      jobs: again,
      creditLedger: ledger,
    });
    await withServer(second, async (base) => {
      const next = await postJob(base);
      assert.equal(next.status, 202);
      const done = await waitJob(base, (await next.json()).id);
      assert.equal(done.status, 'succeeded');
      assert.equal(paid.meta.manuals_used, '1');
      assert.match(paid.meta.first_manual_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.notEqual(done.id, jobId);
    });
  } finally {
    again.close();
    ledger.close();
  }
});

test('two finished jobs still consume two credits', async () => {
  const paid = stripeFor('0');
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
  });
  await withServer(app, async (base) => {
    const first = await postJob(base);
    assert.equal((await waitJob(base, (await first.json()).id)).status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '1');
    const second = await postJob(base, L5X, 'line.L5X', { confirmDuplicate: 'true' });
    assert.equal((await waitJob(base, (await second.json()).id)).status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '2');
    const third = await postJob(base, L5X, 'line.L5X', { confirmDuplicate: 'true' });
    assert.equal((await waitJob(base, (await third.json()).id)).status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '3');
  });
});

test('a hung model call fails the job and returns the Starter credit once', async () => {
  const paid = stripeFor('0');
  let calls = 0;
  let rendered = 0;
  const decrements = [];
  const original = paid.stripe.paymentIntents.update;
  paid.stripe.paymentIntents.update = async (id, params) => {
    const previous = Number(paid.meta.manuals_used || 0);
    const result = await original(id, params);
    const next = Number(paid.meta.manuals_used || 0);
    if (next < previous) decrements.push(previous);
    return result;
  };
  const app = createApp({
    env: env({ MANUALOS_MODEL_CALL_TIMEOUT_MS: '40', MANUALOS_AI_RETRIES: '2' }),
    stripe: paid.stripe,
    anthropic: anthropic((body, options) => new Promise((resolve, reject) => {
      calls += 1;
      const signal = options && options.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    })),
    renderPdf: async () => {
      rendered += 1;
      return Buffer.from('%PDF-1.4\n%hung\n');
    },
  });
  await withServer(app, async (base) => {
    const created = await postJob(base);
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'failed');
    assert.equal(done.code, 'model_call_timeout');
    assert.equal(done.error, CREDIT_RETURN_MESSAGE);
    assert.equal(done.message, CREDIT_RETURN_MESSAGE);
    for (let i = 0; i < 50 && paid.meta.manuals_used !== '0'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(calls, 1);
    assert.equal(rendered, 0);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.meta.first_manual_at, undefined);
    assert.equal(decrements.length, 1);
    const after = await (await fetch(`${base}/health`)).json();
    assert.equal(after.activeJobs, 0);
  });
});

test('monthly spend alerts fire once at 50 and 80, pause at 95, and reset on the Chicago month', async () => {
  const dir = tempDir();
  const lines = [];
  let now = new Date('2026-03-01T05:30:00.000Z');
  const march = new Date('2026-03-01T06:30:00.000Z');
  assert.equal(monthKey(now), '2026-02');
  assert.equal(monthKey(march), '2026-03');
  const spend = createAiSpend({
    directory: dir,
    env: {
      DATA_DIR: dir,
      MANUALOS_AI_MONTHLY_BUDGET_USD: '20',
      MANUALOS_AI_INPUT_USD_PER_MTOK: '0',
      MANUALOS_AI_OUTPUT_USD_PER_MTOK: '1000000',
    },
    now: () => now,
    warn: (line) => lines.push(JSON.parse(line)),
  });
  await spend.record({ inputTokens: 0, outputTokens: 10 });
  await spend.record({ inputTokens: 0, outputTokens: 1 });
  await spend.record({ inputTokens: 0, outputTokens: 5 });
  await spend.record({ inputTokens: 0, outputTokens: 1 });
  assert.equal(lines.filter((line) => line.level === 50).length, 1);
  assert.equal(lines.filter((line) => line.level === 80).length, 1);
  assert.equal(lines[0].event, 'ai_spend_alert');
  assert.equal(lines[0].month, '2026-02');
  assert.equal(typeof lines[0].percent, 'number');
  assert.equal(Object.hasOwn(lines[0], 'usd'), false);
  assert.equal(spend.blocksJobs(), false);
  await spend.record({ inputTokens: 4, outputTokens: 2 });
  assert.equal(spend.blocksJobs(), true);
  assert.ok(spend.percent() >= 95);
  assert.equal(lines.filter((line) => line.level === 50).length, 1);
  assert.equal(lines.filter((line) => line.level === 80).length, 1);

  now = march;
  assert.equal(spend.percent(), 0);
  assert.equal(spend.blocksJobs(), false);
  await spend.record({ inputTokens: 0, outputTokens: 10 });
  assert.equal(lines.filter((line) => line.level === 50 && line.month === '2026-03').length, 1);
  assert.equal(lines.filter((line) => line.level === 50 && line.month === '2026-02').length, 1);
  assert.equal(spend.blocksJobs(), false);
});

test('crossing 95 percent refuses the next job before spending and keeps the credit', async () => {
  const paid = stripeFor('0');
  const lines = [];
  let calls = 0;
  const app = createApp({
    env: env({
      MANUALOS_AI_MONTHLY_BUDGET_USD: '20',
      MANUALOS_AI_INPUT_USD_PER_MTOK: '0',
      MANUALOS_AI_OUTPUT_USD_PER_MTOK: '19000000',
      MANUALOS_AI_CONCURRENCY: '1',
    }),
    stripe: paid.stripe,
    anthropic: anthropic(async (body) => {
      calls += 1;
      return modelMessage(body, { input_tokens: 0, output_tokens: 1 });
    }),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
    aiWarn: (line) => lines.push(JSON.parse(line)),
  });
  await withServer(app, async (base) => {
    const created = await postJob(base);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '1');
    assert.ok(calls > 0);
    const health = await (await fetch(`${base}/health`)).json();
    assert.ok(health.aiBudgetPct >= 95);
    assert.equal(typeof health.aiBudgetPct, 'number');
    assert.equal(Object.hasOwn(health, 'usd'), false);
    assert.equal(lines.filter((line) => line.level === 50).length, 1);
    assert.equal(lines.filter((line) => line.level === 80).length, 1);
    const updates = paid.calls.updates.length;
    const seen = calls;
    const again = await postJob(base);
    assert.equal(again.status, 503);
    const body = await again.json();
    assert.equal(body.error, GENERATION_PAUSED_MESSAGE);
    assert.equal(body.message, GENERATION_PAUSED_MESSAGE);
    assert.equal(body.code, 'generation_paused');
    assert.equal(calls, seen);
    assert.equal(paid.calls.updates.length, updates);
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(lines.filter((line) => line.level === 50).length, 1);
    assert.equal(lines.filter((line) => line.level === 80).length, 1);
  });
});

test('uploads over the size limit return 413 and the 25-file limit stays', async () => {
  const paid = stripeFor('0');
  const app = createApp({
    env: env({ MANUALOS_MAX_UPLOAD_BYTES: '1000', MANUALOS_ZIP_MAX_BYTES: '50' }),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(app, async (base) => {
    const tooBig = await postJob(base, Buffer.alloc(1500, 1), 'big.L5X');
    assert.equal(tooBig.status, 413);
    const tooBigBody = await tooBig.json();
    assert.equal(tooBigBody.code, 'file_too_large');
    assert.equal(tooBigBody.file, 'big.L5X');
    assert.match(tooBigBody.error, /big\.L5X is .+ MB; the limit is .+ MB/);
    assert.equal(tooBigBody.message, tooBigBody.error);
    assert.equal(JSON.stringify(tooBigBody).includes('Anthropic'), false);
    assert.equal(paid.calls.updates.length, 0);

    const zip = new AdmZip();
    zip.addFile('note.L5X', Buffer.alloc(80, 65));
    const archived = await postJob(base, zip.toBuffer(), 'project.zip');
    assert.equal(archived.status, 400);
    const archivedBody = await archived.json();
    assert.equal(archivedBody.error, 'The archive expands too far and was rejected.');
    assert.match(archivedBody.message, /expands too far/i);
    assert.match(archivedBody.message, /50 bytes/);
    assert.equal(paid.meta.manuals_used, '0');

    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    for (let i = 0; i < 26; i += 1) form.append('file', new Blob(['x']), `f${i}.txt`);
    const many = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(many.status, 400);
    const manyBody = await many.json();
    assert.equal(manyBody.code, 'too_many_files');
    assert.equal(manyBody.limit, 25);
    assert.equal(manyBody.received, 26);
    assert.equal(paid.meta.manuals_used, '0');
  });
});

test('a nested zip and two zips share one unpacked limit and do not spend a credit', async () => {
  const paid = stripeFor('0');
  const cap = { MANUALOS_ZIP_MAX_BYTES: '1000' };
  const leaf = Buffer.alloc(800, 0x41);
  const innerA = new AdmZip();
  innerA.addFile('a.L5X', leaf);
  const innerB = new AdmZip();
  innerB.addFile('b.L5X', leaf);
  const outer = new AdmZip();
  outer.addFile('inner-a.zip', innerA.toBuffer());
  outer.addFile('inner-b.zip', innerB.toBuffer());
  const l5x = Buffer.from('<?xml version="1.0"?><RSLogix5000Content><Controller Name="Line"></Controller></RSLogix5000Content>');
  const zipA = new AdmZip();
  zipA.addFile('a.L5X', l5x);
  const zipB = new AdmZip();
  zipB.addFile('b.L5X', Buffer.alloc(950, 0x41));

  await assert.rejects(
    () => parseUploads([{ name: 'inner-a.zip', buffer: innerA.toBuffer() }], {}, cap),
    (err) => err.status === 415,
  );
  await assert.rejects(
    () => parseUploads([{ name: 'nested.zip', buffer: outer.toBuffer() }], {}, cap),
    (err) => err.status === 400
      && err.message === 'The archive expands too far and was rejected.'
      && /maximum unpacked size is 1000 bytes/.test(err.displayMessage),
  );
  await assert.rejects(
    () => parseUploads([{ name: 'one.zip', buffer: zipA.toBuffer() }], {}, cap),
    (err) => err.status !== 400,
  );
  await assert.rejects(
    () => parseUploads([{ name: 'two.zip', buffer: zipB.toBuffer() }], {}, cap),
    (err) => err.status === 415,
  );
  await assert.rejects(
    () => parseUploads([
      { name: 'one.zip', buffer: zipA.toBuffer() },
      { name: 'two.zip', buffer: zipB.toBuffer() },
    ], {}, cap),
    (err) => err.status === 400
      && err.message === 'The archive expands too far and was rejected.'
      && /maximum unpacked size is 1000 bytes/.test(err.displayMessage),
  );

  const app = createApp({
    env: env(cap),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(app, async (base) => {
    const nested = await postJob(base, outer.toBuffer(), 'nested.zip');
    assert.equal(nested.status, 400);
    const nestedBody = await nested.json();
    assert.equal(nestedBody.error, 'The archive expands too far and was rejected.');
    assert.match(nestedBody.message, /maximum unpacked size is 1000 bytes/);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.calls.updates.length, 0);

    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    form.append('file', new Blob([zipA.toBuffer()]), 'one.zip');
    form.append('file', new Blob([zipB.toBuffer()]), 'two.zip');
    const both = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(both.status, 400);
    const bothBody = await both.json();
    assert.equal(bothBody.error, 'The archive expands too far and was rejected.');
    assert.match(bothBody.message, /maximum unpacked size is 1000 bytes/);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.calls.updates.length, 0);
  });
});

test('checkout and generation switches pause new work and leave health, webhooks, and downloads up', async () => {
  const paid = stripeFor('0');
  let creates = 0;
  paid.stripe.checkout.sessions.create = async (params) => {
    creates += 1;
    return { id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new', mode: params.mode };
  };
  const store = createJobStore({ env: env(), directory: tempDir() });
  const ready = store.create({ sessionId: 'cs_test_starter' });
  ready.status = 'succeeded';
  store.savePdf(ready.id, Buffer.from('%PDF-1.4\n%saved\n'));

  const pausedCheckout = createApp({
    env: env({ MANUALOS_CHECKOUT_DISABLED: 'true' }),
    stripe: paid.stripe,
    anthropic: anthropic(),
    jobs: store,
  });
  await withServer(pausedCheckout, async (base) => {
    for (const plan of ['starter', 'pro']) {
      const res = await fetch(`${base}/create-checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), {
        error: 'checkout_paused',
        message: CHECKOUT_PAUSED_MESSAGE,
      });
    }
    assert.equal(creates, 0);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.checkoutPaused, true);
    assert.equal(health.generationPaused, false);
    assert.equal(health.activeJobs, 0);
    assert.equal(typeof health.aiBudgetPct, 'number');
    const verified = await fetch(`${base}/verify-session?session_id=cs_test_starter`);
    assert.equal(verified.status, 200);
    const hook = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active' } } }),
    });
    assert.equal(hook.status, 200);
    const pdf = await fetch(`${base}/jobs/${ready.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal(pdf.status, 200);
  });

  const pausedJobs = createApp({
    env: env({ MANUALOS_GENERATION_DISABLED: 'true' }),
    stripe: paid.stripe,
    anthropic: anthropic(async () => { throw new Error('model should not be called'); }),
    jobs: store,
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(pausedJobs, async (base) => {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.generationPaused, true);
    assert.equal(health.checkoutPaused, false);
    const job = await postJob(base);
    assert.equal(job.status, 503);
    const body = await job.json();
    assert.equal(body.error, GENERATION_PAUSED_MESSAGE);
    assert.equal(body.message, GENERATION_PAUSED_MESSAGE);
    assert.equal(body.code, 'generation_paused');
    assert.equal(paid.meta.manuals_used, '0');
    const pdf = await fetch(`${base}/jobs/${ready.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
    assert.equal(pdf.status, 200);
    const checkout = await fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    assert.equal(checkout.status, 200);
    assert.equal(creates, 1);
    const hook = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active' } } }),
    });
    assert.equal(hook.status, 200);
  });
});

function multipartBody({ boundary, fields = {}, files }) {
  const chunks = [];
  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('file size is not rounded down onto the limit', () => {
  const limit = 25 * 1024 * 1024;
  const size = Math.round(25.1 * 1024 * 1024);
  assert.equal(fileTooLargeMessage('line.L5X', size, limit), 'line.L5X is 25.1 MB; the limit is 25 MB.');
});

test('Content-Length above every allowed file is rejected before the body is read', async () => {
  const limit = 1000;
  const declared = limit * 25 + (256 * 1024) + 50;
  const req = new Readable({
    read() {
      this.pulled = true;
      this.push(null);
    },
  });
  req.pulled = false;
  req.headers = {
    'content-type': 'multipart/form-data; boundary=----ManualOS',
    'content-length': String(declared),
  };
  await assert.rejects(
    () => readMultipart(req, { MANUALOS_MAX_UPLOAD_BYTES: String(limit) }),
    (err) => err.code === 'file_too_large' && err.sizeBytes === declared && err.limitBytes === limit,
  );
  assert.equal(req.pulled, false);
});

test('the upload stream aborts once a file exceeds the limit and reports that file size', async () => {
  const limit = 1000;
  const file = Buffer.alloc(20000, 7);
  const boundary = '----ManualOS';
  const body = multipartBody({
    boundary,
    fields: { session_id: 'cs_test_starter' },
    files: [{ name: 'big.L5X', buffer: file }],
  });
  let readBytes = 0;
  const req = new Readable({
    read() {
      if (this.pending) return;
      this.pending = true;
      setImmediate(() => {
        this.pending = false;
        if (this.offset >= body.length) {
          this.push(null);
          return;
        }
        const n = Math.min(64, body.length - this.offset);
        readBytes += n;
        const slice = body.subarray(this.offset, this.offset + n);
        this.offset += n;
        this.push(slice);
      });
    },
  });
  req.offset = 0;
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  await assert.rejects(
    () => readMultipart(req, { MANUALOS_MAX_UPLOAD_BYTES: String(limit) }),
    (err) => {
      assert.equal(err.status, 413);
      assert.equal(err.code, 'file_too_large');
      assert.equal(err.file, 'big.L5X');
      assert.equal(err.sizeBytes, file.length);
      assert.match(err.message, /big\.L5X is [0-9.]+ MB; the limit is [0-9.]+ MB\./);
      const shown = Number(err.message.match(/is ([0-9.]+) MB/)[1]);
      const cap = Number(err.message.match(/limit is ([0-9.]+) MB/)[1]);
      assert.equal(shown > cap, true);
      return true;
    },
  );
  assert.equal(readBytes < body.length, true);
});

test('an identical upload returns the existing job and does not spend another credit', async () => {
  const paid = stripeFor('0');
  const gate = hold();
  const store = createJobStore({ env: env(), directory: tempDir() });
  const running = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    jobs: store,
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
    beforeGenerate: gate.beforeGenerate,
  });
  await withServer(running, async (base) => {
    const pending = postJob(base);
    await gate.started;
    const created = await pending;
    assert.equal(created.status, 202);
    const first = await created.json();
    const updates = paid.calls.updates.length;
    const again = await postJob(base, L5X, 'other-name.L5X');
    assert.equal(again.status, 409);
    const duplicate = await again.json();
    assert.equal(duplicate.code, 'duplicate_upload');
    assert.equal(duplicate.message, duplicate.error);
    assert.equal(duplicate.jobId, first.id);
    assert.equal(JSON.stringify(duplicate).includes('cs_test'), false);
    assert.equal(paid.calls.updates.length, updates);
    assert.equal(paid.meta.manuals_used, '1');
    gate.release();
    assert.equal((await waitJob(base, first.id)).status, 'succeeded');
    const finished = await postJob(base);
    assert.equal(finished.status, 409);
    assert.equal((await finished.json()).jobId, first.id);
    assert.equal(paid.meta.manuals_used, '1');

    const reversed = new FormData();
    reversed.set('session_id', 'cs_test_starter');
    const other = Buffer.from(L5X.toString('utf8').replace('Name="Line"', 'Name="Other"'));
    reversed.append('file', new Blob([other]), 'b.L5X');
    reversed.append('file', new Blob([L5X]), 'a.L5X');
    const firstSet = await fetch(`${base}/jobs`, { method: 'POST', body: reversed });
    assert.equal(firstSet.status, 202);
    assert.equal((await waitJob(base, (await firstSet.json()).id)).status, 'succeeded');
    const flipped = new FormData();
    flipped.set('session_id', 'cs_test_starter');
    flipped.append('file', new Blob([L5X]), 'a.L5X');
    flipped.append('file', new Blob([other]), 'b.L5X');
    const sameSet = await fetch(`${base}/jobs`, { method: 'POST', body: flipped });
    assert.equal(sameSet.status, 409);
    assert.equal(paid.meta.manuals_used, '2');

    const aged = store.get(first.id);
    aged.createdAt = new Date(Date.now() - (24 * 60 * 60 * 1000) - 1000).toISOString();
  });
  const later = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    jobs: store,
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
  });
  await withServer(later, async (base) => {
    const afterWindow = await postJob(base);
    assert.equal(afterWindow.status, 202);
    assert.equal((await waitJob(base, (await afterWindow.json()).id)).status, 'succeeded');
    assert.equal(paid.meta.manuals_used, '3');
  });

  const failing = stripeFor('0');
  const failApp = createApp({
    env: env(),
    stripe: failing.stripe,
    anthropic: anthropic(),
    renderPdf: async () => { throw new Error('render exploded'); },
  });
  await withServer(failApp, async (base) => {
    const created = await postJob(base);
    assert.equal(created.status, 202);
    assert.equal((await waitJob(base, (await created.json()).id)).status, 'failed');
    const retry = await postJob(base);
    assert.equal(retry.status, 202);
    assert.equal((await waitJob(base, (await retry.json()).id)).status, 'failed');
    assert.equal(failing.meta.manuals_used, '0');
  });
});

test('duplicate files in one upload are ignored and coverage counts the unique file', async () => {
  const paid = stripeFor('0');
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(),
    renderPdf: async () => Buffer.from('%PDF-1.4\n%ok\n'),
  });
  await withServer(app, async (base) => {
    const single = await postJob(base);
    const one = await waitJob(base, (await single.json()).id);
    assert.equal(one.status, 'succeeded');
    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    form.set('confirmDuplicate', 'true');
    form.append('file', new Blob([L5X]), 'line.L5X');
    form.append('file', new Blob([L5X]), 'copy.L5X');
    const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    assert.equal(created.status, 202);
    const body = await created.json();
    assert.deepEqual(body.ignored, ['copy.L5X']);
    const done = await waitJob(base, body.id);
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.ignored, ['copy.L5X']);
    assert.equal(done.coverage.units, one.coverage.units);
    assert.equal(paid.meta.manuals_used, '2');
  });

  const zip = new AdmZip();
  zip.addFile('a.L5X', L5X);
  zip.addFile('b.L5X', L5X);
  const project = await parseUploads([{ originalname: 'pack.zip', buffer: zip.toBuffer() }]);
  assert.deepEqual(project.ignoredFiles, ['b.L5X inside pack.zip']);
  assert.equal(project.sources.length, 1);
});

test('more than 25 files, an empty file, and an invalid file are rejected once without a credit', async () => {
  const paid = stripeFor('0');
  const app = createApp({
    env: env(),
    stripe: paid.stripe,
    anthropic: anthropic(async () => { throw new Error('model should not be called'); }),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(app, async (base) => {
    const many = new FormData();
    many.set('session_id', 'cs_test_starter');
    for (let i = 0; i < 26; i += 1) many.append('files', new Blob(['x']), `f${i}.L5X`);
    const tooMany = await fetch(`${base}/jobs`, { method: 'POST', body: many });
    assert.equal(tooMany.status, 400);
    const tooManyBody = await tooMany.json();
    assert.deepEqual(tooManyBody, {
      error: 'Too many files. The limit is 25 and 26 were received.',
      message: 'Too many files. The limit is 25 and 26 were received.',
      code: 'too_many_files',
      limit: 25,
      received: 26,
    });

    const empty = await postJob(base, Buffer.alloc(0), 'blank.L5X');
    assert.equal(empty.status, 400);
    const emptyBody = await empty.json();
    assert.equal(emptyBody.code, 'empty_file');
    assert.equal(emptyBody.file, 'blank.L5X');
    assert.equal(emptyBody.error, 'blank.L5X is empty.');
    assert.equal(emptyBody.message, 'blank.L5X is empty.');

    const packed = new AdmZip();
    packed.addFile('motor.L5X', Buffer.alloc(0));
    const emptyZip = await postJob(base, packed.toBuffer(), 'pack.zip');
    assert.equal(emptyZip.status, 400);
    const emptyZipBody = await emptyZip.json();
    assert.equal(emptyZipBody.code, 'empty_file');
    assert.equal(emptyZipBody.error, 'motor.L5X inside pack.zip is empty.');
    assert.equal(emptyZipBody.message, emptyZipBody.error);

    const renamed = await postJob(base, Buffer.from('not a project'), 'notes.txt');
    assert.equal(renamed.status, 415);
    const renamedBody = await renamed.json();
    assert.equal(renamedBody.code, 'unsupported_file');
    assert.equal(renamedBody.file, 'notes.txt');
    assert.equal((renamedBody.error.match(/notes\.txt/g) || []).length, 1);
    assert.equal(renamedBody.message, renamedBody.error);

    const archive = new AdmZip();
    archive.addFile('readme.txt', Buffer.from('hello'));
    archive.addFile('photo.bin', Buffer.from('not a photo'));
    const unsupported = await postJob(base, archive.toBuffer(), 'pack.zip');
    assert.equal(unsupported.status, 415);
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupportedBody.code, 'unsupported_file');
    assert.match(unsupportedBody.error, /inside pack\.zip is not a supported project format\./);
    assert.equal(unsupportedBody.message, unsupportedBody.error);
    assert.equal((unsupportedBody.error.match(/inside pack\.zip/g) || []).length, 1);
    const named = ['readme.txt', 'photo.bin'].filter((name) => unsupportedBody.error.includes(name));
    assert.deepEqual(named.length, 1);

    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.calls.updates.length, 0);
  });
});

test('kill switches accept only true or 1 and are read on each request', async () => {
  const paid = stripeFor('0');
  let creates = 0;
  paid.stripe.checkout.sessions.create = async () => {
    creates += 1;
    return { id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new' };
  };
  const runtime = env();
  const app = createApp({
    env: runtime,
    stripe: paid.stripe,
    anthropic: anthropic(async () => { throw new Error('model should not be called'); }),
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  await withServer(app, async (base) => {
    const checkout = () => fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'starter' }),
    });
    assert.equal((await checkout()).status, 200);
    assert.equal((await (await fetch(`${base}/health`)).json()).checkoutPaused, false);

    runtime.MANUALOS_CHECKOUT_DISABLED = 'TRUE';
    const paused = await checkout();
    assert.equal(paused.status, 503);
    assert.deepEqual(await paused.json(), {
      error: 'checkout_paused',
      message: CHECKOUT_PAUSED_MESSAGE,
    });
    assert.equal((await (await fetch(`${base}/health`)).json()).checkoutPaused, true);

    runtime.MANUALOS_CHECKOUT_DISABLED = 'yes';
    assert.equal((await checkout()).status, 200);
    runtime.MANUALOS_CHECKOUT_DISABLED = '1';
    assert.equal((await checkout()).status, 503);
    delete runtime.MANUALOS_CHECKOUT_DISABLED;
    assert.equal((await (await fetch(`${base}/health`)).json()).checkoutPaused, false);

    runtime.MANUALOS_GENERATION_DISABLED = 'True';
    assert.equal((await (await fetch(`${base}/health`)).json()).generationPaused, true);
    const held = await postJob(base);
    assert.equal(held.status, 503);
    const heldBody = await held.json();
    assert.equal(heldBody.code, 'generation_paused');
    assert.equal(heldBody.message, GENERATION_PAUSED_MESSAGE);
    assert.equal(heldBody.error, GENERATION_PAUSED_MESSAGE);

    runtime.MANUALOS_GENERATION_DISABLED = 'on';
    assert.equal((await (await fetch(`${base}/health`)).json()).generationPaused, false);
    runtime.MANUALOS_GENERATION_DISABLED = '1';
    assert.equal((await postJob(base)).status, 503);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(creates, 2);
  });
});
