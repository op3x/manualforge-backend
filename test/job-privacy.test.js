const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJobStore, CLEANUP_INTERVAL_MS, ORPHAN_GRACE_MS, removeTestJobDirectories } = require('../lib/jobs/store');
const { createCreditLedger } = require('../lib/credit-ledger');
const { CREDIT_RETURN_MESSAGE, JOB_TIMEOUT_MESSAGE } = require('../lib/job-timeout');
const { redactCustomerLog } = require('../lib/redact-log');
const { emptyProject, applyFields } = require('../lib/project');
const { buildDocument } = require('../lib/manual/assemble');
const { manualDate } = require('../lib/manual/date');
const { launchOptions, closeBrowser } = require('../lib/manual/pdf');
const { createApp, installShutdown, fieldsFrom } = require('../server');

test.after(() => {
  removeTestJobDirectories();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TAG = 'ZephyrValveTag_42';
const PHRASE = 'amberloom hopper stays pressurized';
const FILE_NAME = 'ZephyrCustomerFile.L5X';
const FILE_BODY = 'CUSTOMER_PROGRAM_TEXT_amberloom';

function fakeClock(start) {
  let time = start;
  const timers = new Set();
  const clock = {
    now() { return time; },
    get time() { return time; },
    intervalMs: null,
    timer: null,
    advance(ms) {
      const target = time + ms;
      for (;;) {
        let nextAt = null;
        for (const timer of timers) {
          if (timer.cleared) continue;
          if (nextAt == null || timer.next < nextAt) nextAt = timer.next;
        }
        if (nextAt == null || nextAt > target) break;
        time = nextAt;
        for (const timer of [...timers]) {
          if (timer.cleared || timer.next !== time) continue;
          timer.next += timer.ms;
          timer.fn();
        }
      }
      time = target;
    },
    setInterval(fn, ms) {
      const timer = {
        fn,
        ms,
        next: time + ms,
        cleared: false,
        unref() { this.unreffed = true; return this; },
        ref() { this.unreffed = false; return this; },
        hasRef() { return !this.unreffed; },
      };
      timers.add(timer);
      clock.timer = timer;
      clock.intervalMs = ms;
      return timer;
    },
    clearInterval(timer) {
      if (!timer) return;
      timer.cleared = true;
      timers.delete(timer);
    },
  };
  return clock;
}

function touch(file, ms) {
  const when = new Date(ms);
  fs.utimesSync(file, when, when);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-privacy-'));
}

function openStore(clock, dir) {
  return createJobStore({
    directory: dir,
    now: () => clock.now(),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (timer) => clock.clearInterval(timer),
  });
}

function captureConsole(fn) {
  const lines = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = {};
  const format = (arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  };
  for (const method of methods) {
    saved[method] = console[method];
    console[method] = (...args) => lines.push(args.map(format).join(' '));
  }
  const restore = () => {
    for (const method of methods) console[method] = saved[method];
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then((value) => {
        restore();
        return { lines, value };
      }, (err) => {
        restore();
        throw err;
      });
    }
    restore();
    return { lines, value: result };
  } catch (err) {
    restore();
    throw err;
  }
}

test('cleanup interval is ten minutes, unrefd, and deletes aged pdfs by mtime', () => {
  assert.equal(CLEANUP_INTERVAL_MS, 10 * 60 * 1000);
  const clock = fakeClock(Date.UTC(2026, 0, 15));
  const dir = tempDir();
  const store = openStore(clock, dir);
  try {
    assert.equal(clock.intervalMs, CLEANUP_INTERVAL_MS);
    assert.equal(clock.timer.hasRef(), false);

    const job = store.create();
    const livePdf = path.join(dir, `${job.id}.pdf`);
    store.savePdf(job.id, Buffer.from('%PDF-1.4 live'));
    touch(livePdf, clock.time - DAY_MS - 5000);

    const oldOrphan = path.join(dir, 'job_orphan.pdf');
    const youngOrphan = path.join(dir, 'job_recent.pdf');
    const oldNote = path.join(dir, 'customer-notes.txt');
    fs.writeFileSync(oldOrphan, 'old-orphan');
    fs.writeFileSync(youngOrphan, 'young-orphan');
    fs.writeFileSync(oldNote, PHRASE);
    touch(oldOrphan, clock.time - DAY_MS - 5000);
    touch(youngOrphan, clock.time - 1000);
    touch(oldNote, clock.time - DAY_MS - 5000);

    clock.advance(CLEANUP_INTERVAL_MS - 1);
    assert.equal(fs.existsSync(oldOrphan), true);
    assert.equal(fs.existsSync(livePdf), true);

    clock.advance(1);
    assert.equal(fs.existsSync(oldOrphan), false);
    assert.equal(fs.existsSync(livePdf), false);
    assert.equal(fs.existsSync(youngOrphan), true);
    assert.equal(fs.existsSync(oldNote), true);
    assert.ok(store.get(job.id));
    assert.equal(store.readPdf(job.id), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restart through SUPPORT_DATA_DIR keeps a two-hour-old PDF and drops a true orphan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-support-'));
  const supportEnv = { SUPPORT_DATA_DIR: root };
  const clock = fakeClock(Date.UTC(2026, 4, 1, 12));
  const first = createJobStore({
    env: supportEnv,
    now: () => clock.now(),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (timer) => clock.clearInterval(timer),
  });
  try {
    assert.equal(first.dir, path.join(root, 'jobs'));
    const job = first.create({ sessionId: 'cs_test_owner' });
    first.savePdf(job.id, Buffer.from('%PDF-1.4\n%kept\n'));
    job.status = 'succeeded';
    first.persist(job);
    const pdf = path.join(first.dir, `${job.id}.pdf`);
    const sidecar = path.join(first.dir, `${job.id}.json`);
    const orphan = path.join(first.dir, 'job_orphanold.pdf');
    fs.writeFileSync(orphan, 'orphan');
    const aged = clock.time - (2 * 60 * 60 * 1000);
    touch(pdf, aged);
    touch(sidecar, aged);
    touch(orphan, aged);
    const id = job.id;
    first.close();

    const restarted = createJobStore({
      env: supportEnv,
      now: () => clock.now(),
      setInterval: (fn, ms) => clock.setInterval(fn, ms),
      clearInterval: (timer) => clock.clearInterval(timer),
    });
    try {
      const loaded = restarted.get(id);
      assert.ok(loaded);
      assert.equal(loaded.status, 'succeeded');
      assert.equal(restarted.readPdf(id).toString().includes('%kept'), true);
      assert.equal(restarted.ready().some((item) => item.id === id), true);
      assert.equal(fs.existsSync(orphan), false);
    } finally {
      restarted.close();
    }
  } finally {
    first.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a job left running at restart is failed and its credit is handed back once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-abandon-'));
  const supportEnv = { SUPPORT_DATA_DIR: root };
  const clock = fakeClock(Date.UTC(2026, 4, 1, 12));
  const heldAt = new Date(clock.time).toISOString();
  const token = '0123456789abcdef';
  const paymentIntentId = 'pi_restart';
  const deadBody = '[{"paymentIntentId":"pi_keep","token":"abcdefabcdefabcd"}]\n';
  const pendingBody = '[]\n';
  fs.writeFileSync(path.join(root, 'credit-handbacks-dead.json'), deadBody);
  fs.writeFileSync(path.join(root, 'credit-handbacks.json'), pendingBody);
  const meta = {
    manuals_used: '1',
    plan: 'starter',
    credit_generation: '1',
    credit_hold: token,
    credit_hold_at: heldAt,
  };
  const decrements = { count: 0 };
  const stripe = {
    paymentIntents: {
      retrieve: async () => ({ id: paymentIntentId, metadata: { ...meta } }),
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
  const ledger = createCreditLedger({ env: supportEnv, intervalMs: 0 });
  ledger.note({ paymentIntentId, token, heldAt });
  const calls = [];
  function open(onAbandonedCredit) {
    return createJobStore({
      env: supportEnv,
      now: () => clock.now(),
      setInterval: (fn, ms) => clock.setInterval(fn, ms),
      clearInterval: (timer) => clock.clearInterval(timer),
      onAbandonedCredit,
    });
  }
  const first = open();
  try {
    const running = first.create({ sessionId: 'cs_test_runner' });
    running.status = 'running';
    running.creditHold = { paymentIntentId, token };
    first.savePdf(running.id, Buffer.from('%PDF-1.4\n%running\n'));
    first.persist(running);
    const pro = first.create({ sessionId: 'cs_test_prorun' });
    pro.status = 'running';
    first.savePdf(pro.id, Buffer.from('%PDF-1.4\n%pro\n'));
    first.persist(pro);
    const bad = first.create();
    bad.status = 'running';
    first.persist(bad);
    const badFile = path.join(first.dir, `${bad.id}.json`);
    const badRecord = JSON.parse(fs.readFileSync(badFile, 'utf8'));
    badRecord.creditHold = { paymentIntentId: 'not-a-pi', token: 'nope' };
    fs.writeFileSync(badFile, JSON.stringify(badRecord));
    const done = first.create({ sessionId: 'cs_test_done' });
    first.savePdf(done.id, Buffer.from('%PDF-1.4\n%done\n'));
    done.status = 'succeeded';
    first.persist(done);
    const doneFile = path.join(first.dir, `${done.id}.json`);
    const doneRecord = JSON.parse(fs.readFileSync(doneFile, 'utf8'));
    doneRecord.creditHold = { paymentIntentId: 'pi_donehold', token: 'fedcba9876543210' };
    fs.writeFileSync(doneFile, JSON.stringify(doneRecord));
    const queued = first.create({ sessionId: 'cs_test_wait' });
    const runningFile = JSON.parse(fs.readFileSync(path.join(first.dir, `${running.id}.json`), 'utf8'));
    assert.equal(runningFile.status, 'running');
    assert.deepEqual(runningFile.creditHold, { paymentIntentId, token });
    assert.equal(runningFile.sessionId, undefined);
    assert.equal(fs.readFileSync(path.join(root, 'open-holds.json'), 'utf8').includes(token), true);
    const ids = { running: running.id, pro: pro.id, bad: bad.id, done: done.id, queued: queued.id };
    first.close();

    const restarted = open((hold) => {
      calls.push(hold);
      return ledger.handBack(stripe, hold.paymentIntentId, hold.token);
    });
    try {
      await restarted.releasesSettled();
      assert.deepEqual(calls, [{ paymentIntentId, token }]);
      const failed = restarted.get(ids.running);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error, CREDIT_RETURN_MESSAGE);
      assert.equal(failed.progress.message, CREDIT_RETURN_MESSAGE);
      assert.equal(failed.creditHold, undefined);
      assert.equal(restarted.readPdf(ids.running), null);
      const failedFile = JSON.parse(fs.readFileSync(path.join(restarted.dir, `${ids.running}.json`), 'utf8'));
      assert.equal(failedFile.status, 'failed');
      assert.equal(failedFile.creditHold, undefined);
      const proJob = restarted.get(ids.pro);
      assert.equal(proJob.status, 'failed');
      assert.equal(proJob.error, JOB_TIMEOUT_MESSAGE);
      assert.equal(restarted.readPdf(ids.pro), null);
      const badJob = restarted.get(ids.bad);
      assert.equal(badJob.status, 'failed');
      assert.equal(badJob.error, JOB_TIMEOUT_MESSAGE);
      assert.equal(badJob.creditHold, undefined);
      const finished = restarted.get(ids.done);
      assert.equal(finished.status, 'succeeded');
      assert.equal(finished.creditHold, undefined);
      assert.equal(restarted.readPdf(ids.done).toString().includes('%done'), true);
      const finishedFile = JSON.parse(fs.readFileSync(path.join(restarted.dir, `${ids.done}.json`), 'utf8'));
      assert.equal(finishedFile.creditHold, undefined);
      assert.equal(restarted.get(ids.queued).status, 'queued');
      assert.equal(meta.manuals_used, '0');
      assert.equal(meta.credit_hold, undefined);
      assert.equal(decrements.count, 1);
      const openAfter = fs.readFileSync(path.join(root, 'open-holds.json'), 'utf8');
      assert.equal(openAfter.includes(token), false);
      assert.equal(openAfter.includes(paymentIntentId), false);
      assert.equal(fs.readFileSync(path.join(root, 'credit-handbacks-dead.json'), 'utf8'), deadBody);
      assert.equal(fs.readFileSync(path.join(root, 'credit-handbacks.json'), 'utf8'), pendingBody);
    } finally {
      restarted.close();
    }

    const again = open(() => {
      calls.push('again');
    });
    try {
      await again.releasesSettled();
      assert.deepEqual(calls, [{ paymentIntentId, token }]);
      assert.equal(again.get(ids.running).status, 'failed');
      assert.equal(decrements.count, 1);
      assert.equal(meta.manuals_used, '0');
    } finally {
      again.close();
    }
  } finally {
    first.close();
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup sweep keeps recent orphan pdfs for one hour and still drops files older than 24 hours', () => {
  assert.equal(ORPHAN_GRACE_MS, 60 * 60 * 1000);
  const clock = fakeClock(Date.UTC(2026, 3, 2));
  const dir = tempDir();
  const first = openStore(clock, dir);
  const job = first.create();
  first.savePdf(job.id, Buffer.from('%PDF-1.4 restart'));
  const recent = path.join(dir, `${job.id}.pdf`);
  const pastGrace = path.join(dir, 'job_past_grace.pdf');
  const old = path.join(dir, 'job_leftover.pdf');
  const note = path.join(dir, 'customer-notes.txt');
  const oldNote = path.join(dir, 'old-notes.txt');
  fs.writeFileSync(pastGrace, 'past-grace');
  fs.writeFileSync(old, 'old');
  fs.writeFileSync(note, PHRASE);
  fs.writeFileSync(oldNote, 'old-note');
  touch(recent, clock.time - 30 * 60 * 1000);
  touch(pastGrace, clock.time - ORPHAN_GRACE_MS - 5000);
  touch(old, clock.time - DAY_MS - 5000);
  touch(note, clock.time - 1000);
  touch(oldNote, clock.time - DAY_MS - 5000);
  first.close();

  const restarted = openStore(clock, dir);
  try {
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(pastGrace), false);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(note), true);
    assert.equal(fs.existsSync(oldNote), false);

    const live = restarted.create();
    restarted.savePdf(live.id, Buffer.from('%PDF-1.4 kept'));
    const livePdf = path.join(dir, `${live.id}.pdf`);
    touch(livePdf, clock.time - ORPHAN_GRACE_MS - 5000);
    const orphan = path.join(dir, 'job_unreferenced.pdf');
    fs.writeFileSync(orphan, 'orphan');
    touch(orphan, clock.time - 30 * 60 * 1000);
    restarted.sweepStartup();
    assert.equal(fs.existsSync(livePdf), true);
    assert.equal(fs.existsSync(orphan), true);

    touch(orphan, clock.time - ORPHAN_GRACE_MS - 5000);
    restarted.sweepStartup();
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(livePdf), true);

    touch(livePdf, clock.time - DAY_MS - 5000);
    restarted.sweepStartup();
    assert.equal(fs.existsSync(livePdf), false);
    assert.ok(restarted.get(live.id));
  } finally {
    restarted.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no job file on disk contains the raw session id', () => {
  const clock = fakeClock(Date.UTC(2026, 6, 1));
  const dir = tempDir();
  const sessionId = 'cs_test_retentionsessionbearervalue';
  const customerId = 'cus_retention_customer_bearer';
  const subscriptionId = 'sub_retention_subscription_bearer';
  const store = openStore(clock, dir);
  try {
    const job = store.create({
      sessionId,
      customerId,
      subscriptionId,
      nameSource: 'Pump',
    });
    store.savePdf(job.id, Buffer.from('%PDF-1.4\n%retention\n'));
    job.status = 'succeeded';
    store.persist(job);
    const names = fs.readdirSync(dir);
    assert.ok(names.some((name) => name === `${job.id}.json`));
    assert.ok(names.some((name) => name === `${job.id}.pdf`));
    for (const name of names) {
      const text = fs.readFileSync(path.join(dir, name)).toString('utf8');
      assert.equal(text.includes(sessionId), false, name);
      assert.equal(text.includes(customerId), false, name);
      assert.equal(text.includes(subscriptionId), false, name);
    }
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${job.id}.json`), 'utf8'));
    assert.equal(onDisk.sessionId, undefined);
    assert.equal(onDisk.customerId, undefined);
    assert.equal(onDisk.subscriptionId, undefined);
    assert.equal(onDisk.sessionIdHash, store.hashCredential(sessionId));
    assert.equal(onDisk.customerIdHash, store.hashCredential(customerId));
    assert.equal(onDisk.subscriptionIdHash, store.hashCredential(subscriptionId));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished PDF expires 24 hours after completedAt and the sweep is at most one interval late', () => {
  const clock = fakeClock(Date.UTC(2026, 7, 1));
  const dir = tempDir();
  const store = openStore(clock, dir);
  try {
    const job = store.create();
    const failed = store.create();
    failed.status = 'failed';
    store.persist(failed);
    const queued = store.create();
    assert.equal(failed.completedAt, undefined);
    assert.equal(Date.parse(failed.expiresAt) - Date.parse(failed.createdAt), DAY_MS);
    assert.equal(queued.completedAt, undefined);

    clock.advance(2 * 60 * 60 * 1000);
    store.savePdf(job.id, Buffer.from('%PDF-1.4 finished'));
    job.status = 'succeeded';
    store.persist(job);
    const pdf = path.join(dir, `${job.id}.pdf`);
    const finished = Date.parse(job.completedAt);
    assert.equal(finished, clock.time);
    assert.equal(Date.parse(job.expiresAt) - finished, DAY_MS);
    assert.ok(finished > Date.parse(job.createdAt));

    clock.advance(Date.parse(job.createdAt) + DAY_MS - clock.time);
    assert.equal(store.get(failed.id), null);
    assert.equal(store.get(queued.id), null);
    assert.equal(fs.existsSync(pdf), true);
    assert.ok(store.get(job.id));

    const deadline = finished + DAY_MS;
    clock.advance(deadline - clock.time - 1);
    assert.equal(fs.existsSync(pdf), true);
    assert.ok(store.get(job.id));

    clock.advance(1 + CLEANUP_INTERVAL_MS);
    assert.equal(fs.existsSync(pdf), false);
    assert.equal(store.get(job.id), null);
    assert.ok(clock.time <= deadline + CLEANUP_INTERVAL_MS);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lookup removes a job once its 24 hour expiry has passed', () => {
  const clock = fakeClock(Date.UTC(2026, 5, 1));
  const dir = tempDir();
  const store = openStore(clock, dir);
  try {
    const job = store.create();
    store.savePdf(job.id, Buffer.from('%PDF-1.4 ttl'));
    clock.advance(DAY_MS - 1);
    assert.ok(store.get(job.id));
    clock.advance(1);
    assert.equal(store.get(job.id), null);
    assert.equal(fs.existsSync(path.join(dir, `${job.id}.pdf`)), false);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logs record an identifier count and never the customer text or file name', async () => {
  const redacted = redactCustomerLog(
    `File content does not match its type: ${FILE_NAME}. Program block ${TAG} has a logic body. See C:\\plant\\${FILE_NAME}`,
  );
  assert.equal(redacted.includes(FILE_NAME), false);
  assert.equal(redacted.includes(TAG), false);
  assert.match(redacted, /\[file\]/);
  assert.match(redacted, /Program block \[redacted\]/);
  const unicodeName = 'Förderband_Geheim.L5X';
  const unicodeLog = redactCustomerLog(`opened ${unicodeName} and Program block: Förderband_Geheim next`);
  assert.equal(unicodeLog.includes('Fö'), false);
  assert.equal(unicodeLog.includes('örder'), false);
  assert.equal(unicodeLog.includes('Geheim'), false);
  assert.match(unicodeLog, /opened \[file\]/);
  assert.match(unicodeLog, /Program block \[redacted\]/);
  assert.equal(redactCustomerLog('schema 32.00.xml shipped'), 'schema 32.00.xml shipped');
  assert.equal(redactCustomerLog('/tmp/32.00.xml'), '/tmp/32.00.xml');
  assert.equal(
    redactCustomerLog('/tmp/up/Förderband Geheim.L5X'),
    '/tmp/up/[file]',
  );
  assert.equal(
    redactCustomerLog('saved /var/backups/plant backup.tar.gz today'),
    'saved /var/backups/[file] today',
  );
  assert.equal(
    redactCustomerLog('cell.s7p and /tmp/up/Line 1.s7p'),
    '[file] and /tmp/up/[file]',
  );
  assert.equal(
    redactCustomerLog('C:\\plant\\Förderband Geheim.L5X'),
    'C:\\plant\\[file]',
  );
  assert.equal(redactCustomerLog('"Förderband Geheim.L5X"'), '"[file]"');
  for (const name of ['cell.awl', 'tags.db', 'part.stl', 'prog.ap', 'prog.ap17', 'pack.zap', 'pack.zap16', 'draw.dwg', 'draw.dxf', 'body.sldprt', 'body.sldasm', 'body.slddrw', 'proj.acd', 'model.step', 'model.stp', 'model.iges', 'model.igs', 'cell.s7p', 'backup.tar.gz', 'backup.tar.bz2', 'backup.tar.xz', 'backup.tar.zst']) {
    const line = redactCustomerLog(`got ${name} here`);
    assert.equal(line, 'got [file] here', name);
    assert.equal(line.includes(name), false);
  }

  const project = emptyProject();
  project.identity.productName = 'Example line';
  project.tags = [{ name: TAG, description: 'tank level', dataType: 'BOOL' }];
  project.narrative = {
    kind: 'machine',
    overview: `${TAG} means the ${PHRASE}.`,
    cycle: 'The equipment runs its cycle.',
    productName: 'Example line',
  };
  const built = captureConsole(() => buildDocument(project));
  const logged = built.lines.join('\n');
  assert.match(logged, /count=\d+/);
  assert.match(logged, /category=identifier/);
  assert.equal(logged.includes(TAG), false);
  assert.equal(logged.includes(PHRASE), false);
  assert.equal(logged.includes(FILE_NAME), false);
  const warnings = (project.warnings || []).join('\n');
  assert.equal(warnings.includes(TAG), false);
  assert.equal(warnings.includes(PHRASE), false);
  assert.match(warnings, /category=identifier/);

  const dir = tempDir();
  const clock = fakeClock(Date.UTC(2026, 6, 1));
  const store = openStore(clock, dir);
  const meta = { manuals_used: '0', plan: 'starter' };
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
      update: async (id, params) => ({ id, metadata: { ...meta, ...params.metadata } }),
    },
    subscriptions: { retrieve: async () => ({ id: 'sub_1', status: 'active' }) },
  };
  const app = createApp({
    env: {
      NODE_ENV: 'test',
      FRONTEND_URL: 'https://manualos.com',
      STRIPE_PRICE_STARTER: 'price_starter',
      STRIPE_PRICE_PRO: 'price_pro',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      STARTER_CREDITS: '3',
    },
    stripe,
    anthropic: { messages: { create: async () => ({ content: [] }) } },
    jobs: store,
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const captured = await captureConsole(async () => {
      const form = new FormData();
      form.set('session_id', 'cs_test_starter');
      form.set('file', new Blob([FILE_BODY]), FILE_NAME);
      const res = await fetch(`http://127.0.0.1:${server.address().port}/jobs`, { method: 'POST', body: form });
      return res.status;
    });
    assert.equal(captured.value, 415);
    const serverLog = captured.lines.join('\n');
    assert.equal(serverLog.includes(FILE_NAME), false);
    assert.equal(serverLog.includes(FILE_BODY), false);
    assert.equal(serverLog.includes(TAG), false);
    assert.equal(serverLog.includes(PHRASE), false);
  } finally {
    store.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('savePdf recreates a missing directory and startup survives EACCES', () => {
  const clock = fakeClock(Date.UTC(2026, 8, 1));
  const dir = tempDir();
  const store = openStore(clock, dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    store.savePdf('job_restored', Buffer.from('%PDF-1.4'));
    assert.equal(fs.readFileSync(path.join(dir, 'job_restored.pdf')).toString(), '%PDF-1.4');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-readonly-'));
  const blocked = path.join(parent, 'jobs');
  fs.chmodSync(parent, 0o500);
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  let blockedStore;
  try {
    blockedStore = createJobStore({
      directory: blocked,
      now: () => clock.now(),
      setInterval: (fn, ms) => clock.setInterval(fn, ms),
      clearInterval: (timer) => clock.clearInterval(timer),
    });
  } finally {
    console.error = original;
    if (blockedStore) blockedStore.close();
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  }
  const logged = logs.join('\n');
  assert.match(logged, /EACCES/);
  assert.equal(logged.includes(blocked), false);
  assert.equal(logged.includes(parent), false);
});

test('the retention sweep leaves open credit holds untouched', () => {
  const root = tempDir();
  const jobsDir = path.join(root, 'jobs');
  fs.mkdirSync(jobsDir);
  const holds = path.join(root, 'open-holds.json');
  const queue = path.join(root, 'credit-handbacks.json');
  const holdsBody = '[{"paymentIntentId":"pi_hold","token":"tok","heldAt":"2020-01-01T00:00:00.000Z"}]\n';
  const queueBody = '[{"paymentIntentId":"pi_q","token":"tok2"}]\n';
  fs.writeFileSync(holds, holdsBody);
  fs.writeFileSync(queue, queueBody);
  const clock = fakeClock(Date.UTC(2026, 0, 1));
  const store = openStore(clock, jobsDir);
  try {
    const job = store.create({ sessionId: 'cs_test_owner' });
    store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
    job.status = 'succeeded';
    store.persist(job);
    const beforeHolds = fs.readFileSync(holds);
    const beforeQueue = fs.readFileSync(queue);
    clock.advance(DAY_MS + CLEANUP_INTERVAL_MS);
    assert.equal(store.get(job.id), null);
    assert.equal(fs.existsSync(path.join(jobsDir, `${job.id}.pdf`)), false);
    assert.equal(fs.existsSync(path.join(jobsDir, `${job.id}.json`)), false);
    assert.equal(fs.readFileSync(holds).equals(beforeHolds), true);
    assert.equal(fs.readFileSync(queue).equals(beforeQueue), true);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup failures log the error code and not the path', () => {
  const clock = fakeClock(Date.UTC(2026, 9, 1));
  const dir = tempDir();
  const store = openStore(clock, dir);
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'not-a-directory');
    clock.advance(CLEANUP_INTERVAL_MS);
    const logged = logs.join('\n');
    assert.match(logged, /Job PDF cleanup failed \(ENOTDIR\)/);
    assert.equal(logged.includes(dir), false);
  } finally {
    console.error = original;
    store.close();
    fs.rmSync(dir, { force: true });
  }
});

test('test job directories and their pdfs are removed on teardown', () => {
  const clock = fakeClock(Date.UTC(2026, 10, 1));
  const store = createJobStore({
    env: { NODE_ENV: 'test' },
    now: () => clock.now(),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (timer) => clock.clearInterval(timer),
  });
  store.savePdf('job_left', Buffer.from('%PDF-1.4'));
  const dir = store.dir;
  try {
    assert.match(path.basename(dir), /^t-/);
    assert.equal(fs.existsSync(path.join(dir, 'job_left.pdf')), true);
  } finally {
    store.close();
  }
  removeTestJobDirectories();
  assert.equal(fs.existsSync(dir), false);
});

test('shutdown closes the browser without letting puppeteer handle process signals', async () => {
  const options = launchOptions('/usr/bin/chromium');
  assert.equal(options.handleSIGTERM, false);
  assert.equal(options.handleSIGINT, false);
  assert.equal(options.handleSIGHUP, false);
  await closeBrowser();

  const signals = [];
  let serverClosed = false;
  let browserClosed = 0;
  let exited = null;
  const handler = installShutdown({
    close(callback) {
      serverClosed = true;
      callback();
    },
  }, {
    closeBrowser: async () => { browserClosed += 1; },
    exit: (code) => { exited = code; },
    on: (signal, listener) => signals.push([signal, listener]),
  });
  assert.deepEqual(signals.map((item) => item[0]), ['SIGTERM', 'SIGINT', 'SIGHUP']);
  await handler();
  await handler();
  assert.equal(serverClosed, true);
  assert.equal(browserClosed, 1);
  assert.equal(exited, 0);
});

test('shutdown forces exit when keep-alive connections stay open', async () => {
  let browserClosed = 0;
  let exited = null;
  let idle = 0;
  let all = 0;
  let closeCalls = 0;
  let cleared = 0;
  const timers = [];
  const handler = installShutdown({
    close() { closeCalls += 1; },
    closeIdleConnections() { idle += 1; },
    closeAllConnections() { all += 1; },
  }, {
    closeBrowser: async () => { browserClosed += 1; },
    exit: (code) => { exited = code; },
    on: () => {},
    forceMs: 10000,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => { cleared += 1; },
  });
  const pending = handler();
  assert.equal(closeCalls, 1);
  assert.equal(idle, 1);
  assert.equal(all, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10000);
  assert.equal(exited, null);
  timers[0].fn();
  await pending;
  assert.equal(browserClosed, 1);
  assert.equal(exited, 0);
  assert.equal(cleared, 1);
  timers[0].fn();
  await handler();
  assert.equal(browserClosed, 1);
  assert.equal(exited, 0);
});

function revisionDate(doc) {
  for (const chapter of doc.chapters) {
    for (const section of chapter.sections) {
      for (const block of section.blocks) {
        if (block.type === 'table' && block.headers[0] === 'Revision' && block.headers[1] === 'Date') {
          return block.rows[0][1];
        }
      }
    }
  }
  return null;
}

test('manual date uses America/Chicago or a client-supplied date', () => {
  const evening = new Date('2026-10-25T02:53:00Z');
  assert.equal(manualDate({ now: evening, timeZone: 'America/Chicago' }), '2026-10-24');
  assert.equal(manualDate({ now: evening, timeZone: 'UTC' }), '2026-10-25');
  assert.equal(manualDate({ now: evening, timeZone: 'Not/AZone' }), '2026-10-24');
  assert.equal(manualDate({ now: evening, timeZone: 'UTC', clientDate: '2024-05-06' }), '2024-05-06');
  assert.equal(manualDate({ now: evening, timeZone: 'UTC', clientDate: '2026-02-31' }), '2026-10-25');
  assert.equal(manualDate({ now: evening, clientDate: 'yesterday' }), '2026-10-24');

  const zoned = buildDocument(emptyProject(), { now: evening, env: {} });
  assert.equal(zoned.cover.date, '2026-10-24');
  assert.equal(zoned.meta.date, '2026-10-24');
  assert.equal(revisionDate(zoned), '2026-10-24');
  assert.equal(JSON.stringify(zoned).includes('2026-10-25'), false);

  const utc = buildDocument(emptyProject(), { now: evening, env: { MANUALOS_TZ: 'UTC' } });
  assert.equal(utc.cover.date, '2026-10-25');
  assert.equal(revisionDate(utc), '2026-10-25');

  const project = emptyProject();
  applyFields(project, { date: '2024-05-06' });
  const supplied = buildDocument(project, { now: evening, env: { MANUALOS_TZ: 'UTC' } });
  assert.equal(supplied.cover.date, '2024-05-06');
  assert.equal(supplied.meta.date, '2024-05-06');
  assert.equal(revisionDate(supplied), '2024-05-06');

  const override = buildDocument(emptyProject(), { now: evening, env: { MANUALOS_TZ: 'UTC' }, date: '2024-01-02' });
  assert.equal(override.cover.date, '2024-01-02');
  assert.equal(revisionDate(override), '2024-01-02');
  assert.deepEqual(fieldsFrom({ body: { date: '2026-10-24', revision: 'B', ignored: 'no' } }), {
    date: '2026-10-24',
    revision: 'B',
  });
});
