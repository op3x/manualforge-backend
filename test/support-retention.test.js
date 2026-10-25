const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installShutdown } = require('../server');
const { createSupportStore } = require('../lib/support/store');
const {
  DAY_MS,
  RETENTION_INTERVAL_MS,
  retentionDays,
  startSupportRetention,
  sweepSupportRetention,
} = require('../lib/support/retention');

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const ROOT = path.join(__dirname, '..');
const dirs = [];

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-retention-'));
  dirs.push(dir);
  return dir;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function age(file, ms) {
  const when = new Date(ms);
  if (fs.lstatSync(file).isSymbolicLink()) fs.lutimesSync(file, when, when);
  else fs.utimesSync(file, when, when);
}

async function capture(fn) {
  const lines = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = {};
  for (const method of methods) {
    saved[method] = console[method];
    console[method] = (...args) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
    };
  }
  try {
    const value = await fn();
    return { lines, value };
  } finally {
    for (const method of methods) console[method] = saved[method];
  }
}

function fakeClock(start) {
  let time = start;
  const timers = new Set();
  const clock = {
    now() { return time; },
    intervalMs: null,
    timer: null,
    setInterval(fn, ms) {
      const timer = {
        fn,
        ms,
        next: time + ms,
        cleared: false,
        unref() { this.unreffed = true; return this; },
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
    advance(ms) {
      const target = time + ms;
      const pending = [];
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
          const result = timer.fn();
          if (result && typeof result.then === 'function') pending.push(result);
        }
      }
      time = target;
      return Promise.all(pending);
    },
  };
  return clock;
}

function mockTwilio(recordings, transcriptions, hooks = {}) {
  const removed = { recordings: [], transcriptions: [] };
  const attempted = { recordings: [], transcriptions: [] };
  const lists = [];
  function collection(bucket, items) {
    const fn = (sid) => ({
      async remove() {
        attempted[bucket].push(sid);
        if (hooks.gone && hooks.gone.has(sid)) {
          const err = new Error('gone SECRET_TWILIO_ERROR');
          err.status = 404;
          err.code = 20404;
          throw err;
        }
        if (hooks.fail && hooks.fail.has(sid)) {
          const err = new Error('boom SECRET_TWILIO_TRANSCRIPT');
          err.status = 500;
          err.code = 20500;
          throw err;
        }
        removed[bucket].push(sid);
      },
    });
    fn.list = async (params) => {
      lists.push({ bucket, params });
      return items.map((item) => ({ ...item }));
    };
    return fn;
  }
  return {
    client: {
      recordings: collection('recordings', recordings),
      transcriptions: collection('transcriptions', transcriptions),
    },
    removed,
    attempted,
    lists,
  };
}

test('retention days default to 90 and never drop below 1', () => {
  assert.equal(retentionDays({}), 90);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '' }), 90);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '   ' }), 90);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: 'nope' }), 90);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '0' }), 1);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '-4' }), 1);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '0.2' }), 1);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '1.9' }), 1);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '45' }), 45);
});

test('sweep deletes aged support artifacts and keeps durable records', async () => {
  const dir = tempDir();
  const old = NOW - (100 * DAY_MS);
  const young = NOW - (2 * DAY_MS);
  const exact = NOW - (90 * DAY_MS);
  const outside = path.join(os.tmpdir(), `manualos-retention-outside-${process.pid}-${Date.now()}`);
  dirs.push(outside);

  writeJson(path.join(dir, 'threads.json'), {
    '+15551110001': {
      turns: 2,
      history: [
        { role: 'user', content: 'OLD_THREAD_MESSAGE' },
        { role: 'assistant', content: 'OLD_THREAD_REPLY' },
      ],
      updatedAt: iso(old),
    },
    '+15551110002': {
      turns: 1,
      history: [{ role: 'user', content: 'YOUNG_THREAD_MESSAGE' }],
      updatedAt: iso(young),
    },
    '+15551110003': {
      turns: 1,
      history: [{ role: 'user', content: 'UNDATED_THREAD_MESSAGE' }],
    },
    '+15551110004': {
      turns: 1,
      history: [],
      startedAt: iso(exact),
    },
  });
  writeJson(path.join(dir, 'messages.json'), {
    old: { at: old, body: 'OLD_MESSAGE_BODY' },
    young: { at: young, body: 'YOUNG_MESSAGE_BODY' },
  });
  writeJson(path.join(dir, 'transcripts.json'), {
    old: { timestamp: iso(old), text: 'OLD_TRANSCRIPT_JSON' },
    young: { timestamp: iso(young), text: 'YOUNG_TRANSCRIPT_JSON' },
  });
  writeJson(path.join(dir, 'sms-notices.json'), {
    SM_OLD: { at: old, line: 'SECRET_TRANSCRIPT_NOTICE', from: '+15551110001' },
    SM_YOUNG: { at: young, line: 'YOUNG_NOTICE_LINE', from: '+15551110002' },
  });
  writeJson(path.join(dir, 'state.json.migrated'), {
    optOuts: { '+15551119999': { at: iso(old), source: 'sms' } },
    threads: {
      '+15551110005': {
        history: [{ role: 'user', content: 'MIGRATED_OLD_MESSAGE' }],
        updatedAt: iso(old),
      },
    },
  });
  writeJson(path.join(dir, 'opt-outs.json'), {
    optOuts: { '+15551118888': { at: iso(old), source: 'sms' } },
    optIns: {},
  });
  const consent = `${JSON.stringify({ phone: '+15551117777', consentTextVersion: 'v1', timestamp: iso(old), source: 'website' })}\n`;
  fs.writeFileSync(path.join(dir, 'consents.jsonl'), consent, { mode: 0o600 });
  writeJson(path.join(dir, 'budget.json'), { '2026-01': { usd: 1.25, inputTokens: 10, outputTokens: 4 } });
  writeJson(path.join(dir, 'once.json'), { 'handoff:CA_old': old });
  fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages', 'blob.txt'), 'SECRET_MESSAGE_FILE');
  fs.writeFileSync(path.join(dir, 'transcripts', 'clip.txt'), 'SECRET_TRANSCRIPT_FILE');
  fs.writeFileSync(path.join(dir, 'recordings', 'vm.wav'), 'not-really-audio');
  fs.writeFileSync(path.join(dir, 'stray.txt'), 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE_secret_customer');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'YOUNG_ARTIFACT');
  fs.writeFileSync(outside, 'OUTSIDE_SECRET');
  fs.symlinkSync(outside, path.join(dir, 'link-old'));
  for (const name of ['messages/blob.txt', 'transcripts/clip.txt', 'recordings/vm.wav', 'stray.txt', 'link-old', 'opt-outs.json', 'consents.jsonl']) {
    age(path.join(dir, name), old);
  }
  age(path.join(dir, 'keep.txt'), young);
  const consentBefore = fs.readFileSync(path.join(dir, 'consents.jsonl'));
  const optOutBefore = fs.readFileSync(path.join(dir, 'opt-outs.json'));
  const budgetBefore = fs.readFileSync(path.join(dir, 'budget.json'));
  const onceBefore = fs.readFileSync(path.join(dir, 'once.json'));
  const consentMtime = fs.statSync(path.join(dir, 'consents.jsonl')).mtimeMs;

  const env = { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' };
  const first = await capture(() => sweepSupportRetention({ directory: dir, env, now: () => NOW }));
  const log = first.lines.join('\n');

  assert.equal(first.value.threads, 4);
  assert.equal(first.value.messages, 6);
  assert.equal(first.value.transcripts, 3);
  assert.equal(first.value.files, 3);
  assert.equal(first.value.recordings, 0);
  assert.equal(first.value.transcriptions, 0);
  assert.equal(first.value.twilio, 'off');
  assert.equal(first.value.errors, 0);
  assert.match(log, /Support retention: days=90 threads=4 messages=6 transcripts=3 files=3 recordings=0 transcriptions=0 twilio=off errors=0/);
  for (const secret of [
    'OLD_THREAD_MESSAGE',
    'YOUNG_THREAD_MESSAGE',
    'OLD_MESSAGE_BODY',
    'SECRET_TRANSCRIPT_NOTICE',
    'SECRET_TRANSCRIPT_FILE',
    'SECRET_MESSAGE_FILE',
    'OUTSIDE_SECRET',
    '+15551110001',
    '+15551118888',
    'RE_secret_customer',
  ]) {
    assert.equal(log.includes(secret), false, secret);
  }

  const threads = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  assert.deepEqual(Object.keys(threads), ['+15551110002']);
  assert.equal(threads['+15551110002'].history[0].content, 'YOUNG_THREAD_MESSAGE');
  assert.equal(fs.statSync(path.join(dir, 'threads.json')).mode & 0o777, 0o600);

  const messages = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
  assert.deepEqual(Object.keys(messages), ['young']);
  assert.equal(messages.young.body, 'YOUNG_MESSAGE_BODY');
  const transcripts = JSON.parse(fs.readFileSync(path.join(dir, 'transcripts.json'), 'utf8'));
  assert.equal(transcripts.young.text, 'YOUNG_TRANSCRIPT_JSON');
  assert.equal(transcripts.old, undefined);
  const notices = JSON.parse(fs.readFileSync(path.join(dir, 'sms-notices.json'), 'utf8'));
  assert.deepEqual(Object.keys(notices), ['SM_YOUNG']);
  const migrated = JSON.parse(fs.readFileSync(path.join(dir, 'state.json.migrated'), 'utf8'));
  assert.equal(migrated.optOuts['+15551119999'].source, 'sms');
  assert.deepEqual(migrated.threads, {});

  assert.equal(fs.readFileSync(path.join(dir, 'consents.jsonl')).equals(consentBefore), true);
  assert.equal(fs.readFileSync(path.join(dir, 'opt-outs.json')).equals(optOutBefore), true);
  assert.equal(fs.readFileSync(path.join(dir, 'budget.json')).equals(budgetBefore), true);
  assert.equal(fs.readFileSync(path.join(dir, 'once.json')).equals(onceBefore), true);
  assert.equal(fs.statSync(path.join(dir, 'consents.jsonl')).mtimeMs, consentMtime);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'YOUNG_ARTIFACT');
  assert.equal(fs.existsSync(path.join(dir, 'messages', 'blob.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'transcripts', 'clip.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'recordings', 'vm.wav')), false);
  assert.equal(fs.existsSync(path.join(dir, 'stray.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'link-old')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_SECRET');
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.tmp')), false);
  assert.equal(fs.existsSync(path.join(dir, 'messages')), false);
  assert.equal(fs.existsSync(path.join(dir, 'transcripts')), false);
  assert.equal(fs.existsSync(path.join(dir, 'recordings')), false);

  const second = await capture(() => sweepSupportRetention({ directory: dir, env, now: () => NOW }));
  assert.equal(second.value.threads, 0);
  assert.equal(second.value.messages, 0);
  assert.equal(second.value.transcripts, 0);
  assert.equal(second.value.files, 0);
  assert.equal(second.value.errors, 0);
});

test('a minimum of one day keeps same-day data when retention is set to zero', async () => {
  const dir = tempDir();
  writeJson(path.join(dir, 'threads.json'), {
    '+15551110009': { history: [{ role: 'user', content: 'recent' }], updatedAt: iso(NOW - (12 * 60 * 60 * 1000)) },
    '+15551110008': { history: [{ role: 'user', content: 'stale' }], updatedAt: iso(NOW - (2 * DAY_MS)) },
  });
  const { value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '0' },
    now: () => NOW,
  }));
  const threads = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  assert.equal(value.days, 1);
  assert.ok(threads['+15551110009']);
  assert.equal(threads['+15551110008'], undefined);
  assert.equal(value.threads, 1);
  assert.equal(value.messages, 1);
});

test('a failed rename leaves the previous file in place and no temp file behind', async () => {
  const dir = tempDir();
  const original = {
    '+15551110001': { history: [{ role: 'user', content: 'keep-on-failure' }], updatedAt: iso(NOW - (100 * DAY_MS)) },
    '+15551110002': { history: [{ role: 'user', content: 'young' }], updatedAt: iso(NOW - DAY_MS) },
  };
  writeJson(path.join(dir, 'threads.json'), original);
  const rename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('disk full SECRET_SHOULD_NOT_LOG');
    err.code = 'EIO';
    throw err;
  };
  try {
    const { lines, value } = await capture(() => sweepSupportRetention({
      directory: dir,
      env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
      now: () => NOW,
    }));
    assert.equal(value.errors, 1);
    assert.equal(lines.join('\n').includes('SECRET_SHOULD_NOT_LOG'), false);
    assert.match(lines.join('\n'), /Support retention failed EIO/);
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8')), original);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.tmp')), false);
});

test('startup sweep repeats every 6 hours until stopped', async () => {
  const dir = tempDir();
  const clock = fakeClock(NOW);
  const old = NOW - (100 * DAY_MS);
  const artifact = path.join(dir, 'stray.txt');
  fs.writeFileSync(artifact, 'one');
  age(artifact, old);
  const retention = startSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' },
    now: () => clock.now(),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (timer) => clock.clearInterval(timer),
  });
  await retention.started;
  assert.equal(fs.existsSync(artifact), false);
  assert.equal(clock.intervalMs, RETENTION_INTERVAL_MS);
  assert.equal(clock.timer.unreffed, true);

  fs.writeFileSync(artifact, 'two');
  age(artifact, old);
  await clock.advance(RETENTION_INTERVAL_MS - 1);
  assert.equal(fs.existsSync(artifact), true);
  await clock.advance(1);
  assert.equal(fs.existsSync(artifact), false);

  fs.writeFileSync(artifact, 'three');
  age(artifact, old);
  retention.stop();
  await clock.advance(RETENTION_INTERVAL_MS);
  assert.equal(fs.existsSync(artifact), true);
});

test('twilio deletion is skipped without credentials and filters by instant', async () => {
  const dir = tempDir();
  let calls = 0;
  const blocked = {
    recordings: {
      list() {
        calls += 1;
        throw new Error('SECRET_SHOULD_NOT_CALL');
      },
    },
  };
  const skipped = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, TWILIO_ACCOUNT_SID: 'AC_test' },
    now: () => NOW,
    twilioClient: blocked,
  }));
  assert.equal(calls, 0);
  assert.equal(skipped.value.twilio, 'off');
  assert.equal(skipped.value.recordings, 0);
  assert.equal(skipped.lines.join('\n').includes('SECRET_SHOULD_NOT_CALL'), false);

  const cutoff = NOW - (90 * DAY_MS);
  const twilio = mockTwilio([
    { sid: 'RE_old', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed' },
    { sid: 'RE_exact', dateCreated: new Date(cutoff), status: 'completed' },
    { sid: 'RE_young', dateCreated: new Date(cutoff + 1000), status: 'completed' },
    { sid: 'RE_missing', status: 'completed' },
    { sid: 'RE_processing', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'processing' },
    { sid: 'RE_gone', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed' },
    { sid: 'RE_fail', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed' },
  ], [
    { sid: 'TR_old', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed', transcriptionText: 'SECRET_TWILIO_TRANSCRIPT' },
    { sid: 'TR_young', dateCreated: new Date(NOW - DAY_MS), status: 'completed', transcriptionText: 'YOUNG_TWILIO_TRANSCRIPT' },
    { sid: 'TR_live', dateCreated: new Date(NOW - (100 * DAY_MS)), status: 'in-progress' },
  ], {
    gone: new Set(['RE_gone']),
    fail: new Set(['RE_fail']),
  });
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: {
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      TWILIO_ACCOUNT_SID: 'AC_test_account',
      TWILIO_AUTH_TOKEN: 'not-a-real-token',
    },
    now: () => NOW,
    twilioClient: twilio.client,
  }));
  assert.deepEqual(twilio.attempted.recordings.sort(), ['RE_exact', 'RE_fail', 'RE_gone', 'RE_old']);
  assert.deepEqual(twilio.removed.recordings.sort(), ['RE_exact', 'RE_old']);
  assert.deepEqual(twilio.removed.transcriptions, ['TR_old']);
  assert.equal(value.recordings, 3);
  assert.equal(value.transcriptions, 1);
  assert.equal(value.twilio, 'on');
  assert.equal(value.errors, 1);
  const recordingList = twilio.lists.find((entry) => entry.bucket === 'recordings');
  assert.equal(recordingList.params.pageSize, 200);
  assert.equal(recordingList.params.includeSoftDeleted, undefined);
  assert.equal(recordingList.params.dateCreatedBefore.getTime(), cutoff + DAY_MS);
  const transcriptionList = twilio.lists.find((entry) => entry.bucket === 'transcriptions');
  assert.equal(transcriptionList.params.dateCreatedBefore, undefined);
  const log = lines.join('\n');
  assert.match(log, /twilio=on errors=1/);
  assert.equal(log.includes('SECRET_TWILIO_TRANSCRIPT'), false);
  assert.equal(log.includes('YOUNG_TWILIO_TRANSCRIPT'), false);
  assert.equal(log.includes('RE_old'), false);
  assert.match(log, /Support retention failed 20500/);
});

test('the npm script sweeps the configured directory and does not call Twilio', () => {
  const dir = tempDir();
  const stale = new Date(Date.now() - (200 * DAY_MS)).toISOString();
  writeJson(path.join(dir, 'threads.json'), {
    '+15551110001': { history: [{ role: 'user', content: 'SCRIPT_OLD_MESSAGE' }], updatedAt: stale },
  });
  const pkg = require('../package.json');
  assert.equal(pkg.scripts['support:retention'], 'node scripts/support-retention.js');
  const result = spawnSync(process.execPath, ['scripts/support-retention.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      SUPPORT_RETENTION_DAYS: '90',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /threads=1 messages=1/);
  assert.match(result.stdout, /twilio=off/);
  assert.equal(result.stdout.includes('SCRIPT_OLD_MESSAGE'), false);
  assert.equal(result.stderr.includes('SCRIPT_OLD_MESSAGE'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8')), {});
});

test('shutdown stops retention before it closes the server', async () => {
  let stopped = 0;
  let closed = 0;
  const handler = installShutdown({
    close(callback) {
      closed += 1;
      assert.equal(stopped, 1);
      if (callback) callback();
    },
  }, {
    closeBrowser: async () => {},
    exit: () => {},
    on: () => {},
    closeExtra: () => { stopped += 1; },
  });
  await handler();
  await handler();
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
});

test('store-shaped threads are pruned and opt-outs survive', async () => {
  const dir = tempDir();
  const oldStore = createSupportStore({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    now: () => NOW - (100 * DAY_MS),
  });
  oldStore.optOut('+15551116666', 'sms');
  oldStore.addConsent({
    phone: '+15551116666',
    consentTextVersion: 'v1',
    timestamp: iso(NOW - (100 * DAY_MS)),
    source: 'website',
  });
  oldStore.saveThread('+15551116666', {
    turns: 1,
    history: [{ role: 'user', content: 'stored thread body' }],
    startedAt: iso(NOW - (100 * DAY_MS)),
  });
  const youngStore = createSupportStore({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    now: () => NOW - (60 * 60 * 1000),
  });
  youngStore.saveThread('+15551116777', {
    turns: 1,
    history: [{ role: 'user', content: 'still here' }],
    startedAt: iso(NOW - (60 * 60 * 1000)),
  });

  const { value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    now: () => NOW,
  }));
  assert.equal(value.threads, 1);
  assert.equal(value.messages, 1);
  const threads = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  assert.deepEqual(Object.keys(threads), ['+15551116777']);
  assert.equal(threads['+15551116777'].history[0].content, 'still here');
  const reloaded = createSupportStore({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    now: () => NOW,
  });
  assert.equal(reloaded.isOptedOut('+15551116666'), true);
  assert.equal(reloaded.getThread('+15551116777').history[0].content, 'still here');
  assert.equal(reloaded.listConsents().length, 1);
});
