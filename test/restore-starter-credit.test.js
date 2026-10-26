const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const { refundStarterCredit } = require('../lib/billing');
const { supportDataDirWarning } = require('../lib/credit-ledger');
const { parseRestoreArgs, runRestore } = require('../lib/restore-starter-credit');

test.after(() => {
  removeTestJobDirectories();
});

const PI = 'pi_restore';
const OTHER = 'pi_other';
const TOKEN = '0123456789abcdef';
const HELD_AT = '2026-01-01T00:00:00.000Z';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
}

function writeRecords(dir, open, pending) {
  fs.writeFileSync(path.join(dir, 'open-holds.json'), `${JSON.stringify(open)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'credit-handbacks.json'), `${JSON.stringify(pending)}\n`, { mode: 0o600 });
}

function readRecords(dir) {
  return {
    open: JSON.parse(fs.readFileSync(path.join(dir, 'open-holds.json'), 'utf8')),
    pending: JSON.parse(fs.readFileSync(path.join(dir, 'credit-handbacks.json'), 'utf8')),
  };
}

function fakeStripe({
  manualsUsed = '1',
  plan = 'starter',
  generation = '3',
  token = TOKEN,
  heldAt = HELD_AT,
  livemode = false,
  restoredTickets = '',
  retrieveError = null,
} = {}) {
  const meta = {
    manuals_used: String(manualsUsed),
    plan,
    credit_generation: String(generation),
  };
  if (token) meta.credit_hold = token;
  if (heldAt) meta.credit_hold_at = heldAt;
  if (restoredTickets) meta.restored_tickets = restoredTickets;
  const calls = { retrieves: 0, updates: 0 };
  const stripe = {
    paymentIntents: {
      retrieve: async () => {
        calls.retrieves += 1;
        if (retrieveError) throw retrieveError;
        return {
          id: PI,
          livemode,
          receipt_email: 'buyer@example.com',
          metadata: { ...meta },
        };
      },
      update: async (id, params) => {
        calls.updates += 1;
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, livemode, receipt_email: 'buyer@example.com', metadata: { ...meta } };
      },
    },
  };
  return { stripe, meta, calls };
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

test('legacy generate is 404 and does not spend a credit unless the flag is 1', async () => {
  const paid = fakeStripe({ manualsUsed: '1', token: '', heldAt: '' });
  let modelCalls = 0;
  const anthropic = { messages: { create: async () => { modelCalls += 1; throw new Error('should not be called'); } } };
  const app = createApp({ env: env(), stripe: paid.stripe, anthropic });
  await withServer(app, async (base) => {
    const blocked = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
      body: JSON.stringify({ plcContent: 'start' }),
    });
    assert.equal(blocked.status, 404);
    assert.deepEqual(await blocked.json(), { error: 'not_found' });
  });
  const loose = createApp({ env: env({ MANUALOS_LEGACY_GENERATE: 'true' }), stripe: paid.stripe, anthropic });
  await withServer(loose, async (base) => {
    const blocked = await fetch(`${base}/generate-manual`, { method: 'POST' });
    assert.equal(blocked.status, 404);
    assert.deepEqual(await blocked.json(), { error: 'not_found' });
  });
  assert.equal(paid.calls.retrieves, 0);
  assert.equal(paid.calls.updates, 0);
  assert.equal(paid.meta.manuals_used, '1');
  assert.equal(modelCalls, 0);
});

test('health reports supportDataDirOk and startup names the missing directory without a path', () => {
  const secretPath = path.join(os.tmpdir(), 'SECRET_PATH_VALUE');
  fs.writeFileSync(secretPath, 'nope');
  try {
    const missing = supportDataDirWarning({});
    const blocked = supportDataDirWarning({ SUPPORT_DATA_DIR: secretPath });
    const ready = supportDataDirWarning({ SUPPORT_DATA_DIR: os.tmpdir() });
    assert.match(missing, /SUPPORT_DATA_DIR is not set/);
    assert.match(blocked, /SUPPORT_DATA_DIR is not writable/);
    assert.equal(ready, '');
    assert.equal(missing.includes('SECRET_PATH_VALUE'), false);
    assert.equal(blocked.includes('SECRET_PATH_VALUE'), false);
  } finally {
    fs.rmSync(secretPath, { force: true });
  }
});

test('health supportDataDirOk is false when the directory is unset or not a directory', async () => {
  const file = path.join(os.tmpdir(), `support-file-${process.pid}`);
  fs.writeFileSync(file, 'nope');
  try {
    const unset = createApp({ env: env(), stripe: fakeStripe().stripe, anthropic: null });
    await withServer(unset, async (base) => {
      const body = await (await fetch(`${base}/health`)).json();
      assert.equal(body.supportDataDirOk, false);
      assert.equal(typeof body.supportDataDirOk, 'boolean');
    });
    const blocked = createApp({
      env: env({ SUPPORT_DATA_DIR: file }),
      stripe: fakeStripe().stripe,
      anthropic: null,
    });
    await withServer(blocked, async (base) => {
      const body = await (await fetch(`${base}/health`)).json();
      assert.equal(body.supportDataDirOk, false);
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a dry run prints the credit and the holds and does not write', async () => {
  const dir = tempDir();
  const paid = fakeStripe({ manualsUsed: '2' });
  writeRecords(dir, [
    { paymentIntentId: PI, token: TOKEN, heldAt: HELD_AT },
    { paymentIntentId: OTHER, token: 'abcdef0123456789', heldAt: HELD_AT },
  ], [
    { paymentIntentId: PI, token: TOKEN },
  ]);
  try {
    const result = await runRestore({
      args: { apply: false, live: false, paymentIntentId: PI, ticket: 'T-100' },
      stripe: paid.stripe,
      key: 'sk_test_secretvalue',
      env: { SUPPORT_DATA_DIR: dir },
    });
    assert.equal(result.exitCode, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.manualsUsed, 2);
    assert.equal(report.openHolds.length, 1);
    assert.equal(report.openHolds[0].token, TOKEN);
    assert.equal(report.handbacks.length, 1);
    assert.equal(report.change.manualsUsed, 1);
    assert.equal(report.change.manualsDelta, -1);
    assert.equal(report.change.recordTicket, true);
    assert.equal(report.change.clearHold, true);
    assert.equal(report.result, 'dry_run');
    assert.equal(paid.calls.updates, 0);
    assert.equal(paid.meta.manuals_used, '2');
    assert.equal(readRecords(dir).open.length, 2);
    const text = `${result.stdout}${result.stderr}`;
    assert.equal(text.includes('buyer@example.com'), false);
    assert.equal(text.includes('sk_test_secretvalue'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply decrements a Starter credit once per ticket and a later hand-back does not', async () => {
  const dir = tempDir();
  const paid = fakeStripe({ manualsUsed: '2' });
  writeRecords(dir, [
    { paymentIntentId: PI, token: TOKEN, heldAt: HELD_AT },
    { paymentIntentId: OTHER, token: 'abcdef0123456789', heldAt: HELD_AT },
  ], [
    { paymentIntentId: PI, token: TOKEN },
    { paymentIntentId: OTHER, token: 'abcdef0123456789' },
  ]);
  const options = {
    stripe: paid.stripe,
    key: 'sk_test_secretvalue',
    env: { SUPPORT_DATA_DIR: dir },
  };
  try {
    const first = await runRestore({
      ...options,
      args: { apply: true, live: false, paymentIntentId: PI, ticket: 'T-100' },
    });
    assert.equal(first.exitCode, 0);
    const applied = JSON.parse(first.stdout);
    assert.equal(applied.result, 'applied');
    assert.equal(applied.manualsUsed, 1);
    assert.equal(applied.change.manualsDelta, -1);
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(paid.meta.credit_hold, undefined);
    assert.equal(paid.meta.restored_tickets, 'T-100');
    assert.equal(paid.meta.credit_generation, '4');
    const left = readRecords(dir);
    assert.deepEqual(left.open, [{ paymentIntentId: OTHER, token: 'abcdef0123456789', heldAt: HELD_AT }]);
    assert.deepEqual(left.pending, [{ paymentIntentId: OTHER, token: 'abcdef0123456789' }]);
    assert.equal(`${first.stdout}${first.stderr}`.includes('buyer@example.com'), false);

    const again = await runRestore({
      ...options,
      args: { apply: true, live: false, paymentIntentId: PI, ticket: 'T-100' },
    });
    assert.equal(again.exitCode, 0);
    assert.equal(JSON.parse(again.stdout).result, 'already_restored');
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(paid.calls.updates, 1);

    const second = await runRestore({
      ...options,
      args: { apply: true, live: false, paymentIntentId: PI, ticket: 'T-200' },
    });
    assert.equal(JSON.parse(second.stdout).manualsUsed, 0);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.restored_tickets, 'T-100,T-200');

    const known = await runRestore({
      ...options,
      args: { apply: false, live: false, paymentIntentId: PI, ticket: 'T-100' },
    });
    assert.equal(JSON.parse(known.stdout).result, 'already_restored');

    const dry = await runRestore({
      ...options,
      args: { apply: false, live: false, paymentIntentId: PI, ticket: 'T-300' },
    });
    assert.equal(JSON.parse(dry.stdout).result, 'nothing_to_restore');
    assert.equal(JSON.parse(dry.stdout).change, null);
    assert.equal(paid.calls.updates, 2);

    const floor = await runRestore({
      ...options,
      args: { apply: true, live: false, paymentIntentId: PI, ticket: 'T-300' },
    });
    const floorReport = JSON.parse(floor.stdout);
    assert.equal(floor.exitCode, 0);
    assert.equal(floorReport.result, 'nothing_to_restore');
    assert.equal(floorReport.manualsUsed, 0);
    assert.equal(floorReport.change, null);
    assert.equal(paid.meta.manuals_used, '0');
    assert.equal(paid.meta.restored_tickets, 'T-100,T-200');
    assert.equal(paid.calls.updates, 2);
    const auditPath = path.join(dir, 'credit-restores.jsonl');
    const audit = fs.readFileSync(auditPath, 'utf8');
    const lines = audit.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.result), ['applied', 'already_restored', 'applied', 'nothing_to_restore']);
    assert.equal(lines.every((line) => line.paymentIntentId === PI.slice(-4)), true);
    assert.equal(audit.includes(PI), false);
    assert.equal(audit.includes('buyer@example.com'), false);
    assert.equal(audit.includes('sk_test'), false);
    assert.equal(await refundStarterCredit(paid.stripe, PI, TOKEN), 0);
    assert.equal(paid.meta.manuals_used, '0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply does not change a purchase that is not Starter', async () => {
  const dir = tempDir();
  const paid = fakeStripe({ plan: 'pro', manualsUsed: '1' });
  try {
    const result = await runRestore({
      args: { apply: true, live: false, paymentIntentId: PI, ticket: 'T-100' },
      stripe: paid.stripe,
      key: 'sk_test_secretvalue',
      env: { SUPPORT_DATA_DIR: dir },
    });
    assert.equal(result.exitCode, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.result, 'not_starter');
    assert.equal(report.change, null);
    assert.equal(paid.calls.updates, 0);
    assert.equal(paid.meta.manuals_used, '1');
    assert.equal(paid.meta.restored_tickets, undefined);
    const audit = fs.readFileSync(path.join(dir, 'credit-restores.jsonl'), 'utf8');
    assert.match(audit, /"result":"not_starter"/);
    assert.equal(audit.includes('buyer@example.com'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('live mode is refused unless --live is passed, and secrets are not printed', async () => {
  const paid = fakeStripe({ livemode: true });
  const fromKey = await runRestore({
    args: { apply: true, live: false, paymentIntentId: PI, ticket: 'T-100' },
    stripe: paid.stripe,
    key: 'sk_live_secretvalue',
    env: {},
  });
  assert.equal(fromKey.exitCode, 1);
  assert.match(fromKey.stderr, /live mode/);
  assert.equal(fromKey.stderr.includes('sk_live_secretvalue'), false);
  assert.equal(paid.calls.retrieves, 0);
  assert.equal(paid.calls.updates, 0);

  const fromIntent = await runRestore({
    args: { apply: false, live: false, paymentIntentId: PI, ticket: 'T-100' },
    stripe: paid.stripe,
    key: 'sk_test_secretvalue',
    env: {},
  });
  assert.equal(fromIntent.exitCode, 1);
  assert.match(fromIntent.stderr, /live mode/);
  assert.equal(fromIntent.stdout, '');
  assert.equal(paid.calls.updates, 0);

  const allowed = await runRestore({
    args: { apply: true, live: true, paymentIntentId: PI, ticket: 'T-100' },
    stripe: paid.stripe,
    key: 'sk_live_secretvalue',
    env: {},
  });
  assert.equal(allowed.exitCode, 0);
  assert.equal(JSON.parse(allowed.stdout).manualsUsed, 0);
  assert.equal(`${allowed.stdout}${allowed.stderr}`.includes('sk_live_secretvalue'), false);
  assert.equal(`${allowed.stdout}${allowed.stderr}`.includes('buyer@example.com'), false);

  const exploded = await runRestore({
    args: { apply: false, live: true, paymentIntentId: PI, ticket: 'T-100' },
    stripe: fakeStripe({ retrieveError: new Error('stripe down buyer@example.com sk_live_secretvalue pi_abcdefghijklmnopqrstuv') }).stripe,
    key: 'sk_live_secretvalue',
    env: {},
  });
  assert.equal(exploded.exitCode, 1);
  assert.equal(exploded.stderr.includes('buyer@example.com'), false);
  assert.equal(exploded.stderr.includes('sk_live_secretvalue'), false);
  assert.equal(exploded.stderr.includes('pi_abcdefghijklmnopqrstuv'), false);
});

test('the restore command rejects a live key and a bad id without printing them', () => {
  const parsed = parseRestoreArgs(['--payment-intent', 'sk_live_secretvalue', '--ticket', 'buyer@example.com']);
  assert.equal(parsed.ok, false);
  assert.equal(JSON.stringify(parsed).includes('sk_live_secretvalue'), false);
  assert.equal(JSON.stringify(parsed).includes('buyer@example.com'), false);

  const root = path.join(__dirname, '..');
  const live = spawnSync(process.execPath, [
    'scripts/restore-starter-credit.js',
    '--payment-intent', PI,
    '--ticket', 'T-100',
    '--apply',
  ], {
    cwd: root,
    env: { ...process.env, STRIPE_SECRET_KEY: 'sk_live_secretvalue' },
    encoding: 'utf8',
  });
  assert.equal(live.status, 1);
  assert.match(live.stderr, /live mode/);
  assert.equal(`${live.stdout}${live.stderr}`.includes('sk_live_secretvalue'), false);

  const usage = spawnSync(process.execPath, ['scripts/restore-starter-credit.js'], {
    cwd: root,
    env: { ...process.env, STRIPE_SECRET_KEY: 'sk_test_secretvalue' },
    encoding: 'utf8',
  });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage/);
});

test('a restore audit masks a short payment id completely', async () => {
  const dir = tempDir();
  const short = 'pi_1';
  const paid = fakeStripe({ manualsUsed: '1' });
  try {
    const result = await runRestore({
      args: { apply: true, live: false, paymentIntentId: short, ticket: 'T-1' },
      stripe: paid.stripe,
      key: 'sk_test_secretvalue',
      env: { SUPPORT_DATA_DIR: dir },
    });
    assert.equal(result.exitCode, 0);
    const audit = fs.readFileSync(path.join(dir, 'credit-restores.jsonl'), 'utf8');
    const line = JSON.parse(audit.trim());
    assert.equal(line.paymentIntentId, '****');
    assert.equal(audit.includes(short), false);
    assert.equal(audit.includes('buyer@example.com'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
