const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJobStore, CLEANUP_INTERVAL_MS, ORPHAN_GRACE_MS, removeTestJobDirectories } = require('../lib/jobs/store');
const { redactCustomerLog } = require('../lib/redact-log');
const { emptyProject } = require('../lib/project');
const { buildDocument } = require('../lib/manual/assemble');
const { launchOptions, closeBrowser } = require('../lib/manual/pdf');
const { createApp, installShutdown } = require('../server');

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
  for (const name of ['cell.awl', 'tags.db', 'part.stl', 'prog.ap', 'prog.ap17', 'pack.zap', 'pack.zap16', 'draw.dwg', 'draw.dxf', 'body.sldprt', 'body.sldasm', 'body.slddrw', 'proj.acd', 'model.step', 'model.stp', 'model.iges', 'model.igs']) {
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
