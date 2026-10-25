const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { createJobStore, removeTestJobDirectories } = require('../lib/jobs/store');
const { recoverAbandonedCredit } = require('../lib/billing');
const { createCreditLedger } = require('../lib/credit-ledger');
const { CREDIT_RETURN_MESSAGE } = require('../lib/job-timeout');

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

function starterStripe() {
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
        if (params.metadata && params.metadata.first_manual_at) throw new Error('stamp write failed');
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, metadata: { ...meta } };
      },
    },
  };
  return { stripe, meta };
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

async function waitJob(base, id, sessionId = 'cs_test_starter') {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${base}/jobs/${id}`, { headers: { 'X-Session-Id': sessionId } });
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('job did not finish');
}

test('BUG-29 a failure after the PDF is saved deletes that file', async () => {
  const { stripe, meta } = starterStripe();
  const jobs = createJobStore({ env: env() });
  try {
    await withServer(createApp({
      env: env(),
      stripe,
      anthropic: anthropic(),
      jobs,
      renderPdf: async () => Buffer.from('%PDF-1.4\n%kept\n'),
    }), async (base) => {
      const form = new FormData();
      form.set('session_id', 'cs_test_starter');
      form.set('file', new Blob([L5X]), 'line.L5X');
      const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
      assert.equal(created.status, 202);
      const body = await created.json();
      const hidden = await fetch(`${base}/jobs/${body.id}`);
      assert.equal(hidden.status, 401);
      const hiddenPdf = await fetch(`${base}/jobs/${body.id}/pdf`);
      assert.equal(hiddenPdf.status, 401);
      const done = await waitJob(base, body.id);
      assert.equal(done.status, 'failed');
      const pdf = await fetch(`${base}/jobs/${body.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
      assert.equal(pdf.status, 409);
      const other = await fetch(`${base}/jobs/${body.id}/pdf`, { headers: { 'X-Session-Id': 'cs_other' } });
      assert.equal(other.status, 403);
      assert.equal(fs.existsSync(path.join(jobs.dir, `${body.id}.pdf`)), false);
      assert.equal(meta.manuals_used, '0');
      assert.equal(Object.hasOwn(meta, 'first_manual_at'), false);
    });
  } finally {
    jobs.close();
  }
});

const COMMIT_TOKEN = '0123456789abcdef';

function creditStripe(meta) {
  const decrements = { count: 0 };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_test_starter',
          metadata: { plan: 'starter' },
          payment_status: 'paid',
          payment_intent: { id: 'pi_commit', metadata: { ...meta } },
          subscription: null,
        }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_commit', metadata: { ...meta } }),
      update: async (id, params) => {
        const prev = Number(meta.manuals_used || 0);
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        if (params.metadata && params.metadata.manuals_used != null && Number(params.metadata.manuals_used) < prev) {
          decrements.count += 1;
        }
        return { id, metadata: { ...meta } };
      },
    },
  };
  return { stripe, decrements };
}

function leaveRunning(meta, manualsUsed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-commit-crash-'));
  const dir = path.join(root, 'jobs');
  const first = createJobStore({ directory: dir, env: env() });
  const job = first.create({ sessionId: 'cs_test_starter' });
  job.status = 'running';
  job.creditHold = { paymentIntentId: 'pi_commit', token: COMMIT_TOKEN, manualsUsed };
  first.savePdf(job.id, Buffer.from('%PDF-1.4\n%committed\n'));
  first.persist(job);
  const id = job.id;
  first.close();
  return { root, dir, id };
}

test('a restart keeps the PDF until the hand-back resolves', async () => {
  const { root, dir, id } = leaveRunning({ manuals_used: '1' }, 1);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let during = null;
  const restarted = createJobStore({
    directory: dir,
    env: env(),
    async onAbandonedCredit() {
      during = restarted.readPdf(id);
      await gate;
      return { delivered: true };
    },
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarted.get(id).status, 'running');
    assert.equal(during.toString().includes('%committed'), true);
    assert.equal(fs.existsSync(path.join(dir, `${id}.pdf`)), true);
    release();
    await restarted.releasesSettled();
    const done = restarted.get(id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.error, null);
    assert.equal(done.progress.message, 'Manual is ready');
    assert.equal(restarted.readPdf(id).toString().includes('%committed'), true);
    assert.equal(JSON.stringify(done).includes('credit has been returned'), false);
  } finally {
    restarted.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a crash after the Starter credit commit keeps the manual and does not return the credit', async () => {
  const meta = {
    manuals_used: '1',
    plan: 'starter',
    credit_generation: '1',
    credit_hold: '',
  };
  const { root, dir, id } = leaveRunning(meta, 1);
  const { stripe, decrements } = creditStripe(meta);
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: root }, intervalMs: 0 });
  const jobs = createJobStore({
    directory: dir,
    env: env(),
    onAbandonedCredit: (hold) => recoverAbandonedCredit(stripe, hold, ledger),
  });
  try {
    await jobs.releasesSettled();
    assert.equal(jobs.get(id).status, 'succeeded');
    assert.equal(jobs.readPdf(id).toString().includes('%committed'), true);
    assert.equal(meta.manuals_used, '1');
    assert.equal(decrements.count, 0);
    assert.equal(meta.credit_hold || '', '');
    await withServer(createApp({
      env: env(),
      stripe,
      anthropic: null,
      jobs,
      creditLedger: ledger,
    }), async (base) => {
      const hidden = await fetch(`${base}/jobs/${id}`);
      assert.equal(hidden.status, 401);
      const hiddenPdf = await fetch(`${base}/jobs/${id}/pdf`);
      assert.equal(hiddenPdf.status, 401);
      const other = await fetch(`${base}/jobs/${id}/pdf`, { headers: { 'X-Session-Id': 'cs_other' } });
      assert.equal(other.status, 403);
      const res = await fetch(`${base}/jobs/${id}`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
      const body = await res.json();
      assert.equal(body.status, 'succeeded');
      assert.equal(body.error, null);
      assert.equal(JSON.stringify(body).includes('credit has been returned'), false);
      const pdf = await fetch(`${base}/jobs/${id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
      assert.equal(pdf.status, 200);
      assert.equal(Buffer.from(await pdf.arrayBuffer()).toString().includes('%committed'), true);
    });
    assert.equal(meta.manuals_used, '1');
    assert.equal(decrements.count, 0);
  } finally {
    jobs.close();
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a restart still returns a matching Starter hold and then deletes the PDF', async () => {
  const meta = {
    manuals_used: '1',
    plan: 'starter',
    credit_generation: '1',
    credit_hold: COMMIT_TOKEN,
    credit_hold_at: '2026-01-01T00:00:00.000Z',
  };
  const { root, dir, id } = leaveRunning(meta, 1);
  const { stripe, decrements } = creditStripe(meta);
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: root }, intervalMs: 0 });
  const jobs = createJobStore({
    directory: dir,
    env: env(),
    onAbandonedCredit: (hold) => recoverAbandonedCredit(stripe, hold, ledger),
  });
  try {
    await jobs.releasesSettled();
    const done = jobs.get(id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, CREDIT_RETURN_MESSAGE);
    assert.equal(jobs.readPdf(id), null);
    assert.equal(meta.manuals_used, '0');
    assert.equal(decrements.count, 1);
    assert.equal(meta.credit_hold, undefined);
  } finally {
    jobs.close();
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a hold already handed back is not marked succeeded', async () => {
  const meta = {
    manuals_used: '0',
    plan: 'starter',
    credit_generation: '2',
    credit_hold: '',
  };
  const { root, dir, id } = leaveRunning(meta, 1);
  const { stripe, decrements } = creditStripe(meta);
  const ledger = createCreditLedger({ env: { SUPPORT_DATA_DIR: root }, intervalMs: 0 });
  const jobs = createJobStore({
    directory: dir,
    env: env(),
    onAbandonedCredit: (hold) => recoverAbandonedCredit(stripe, hold, ledger),
  });
  try {
    await jobs.releasesSettled();
    const done = jobs.get(id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error, CREDIT_RETURN_MESSAGE);
    assert.equal(jobs.readPdf(id), null);
    assert.equal(meta.manuals_used, '0');
    assert.equal(decrements.count, 0);
  } finally {
    jobs.close();
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
