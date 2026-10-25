const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { installShutdown } = require('../server');
const { acquireSupportLock, LOCK_STALE_MS, LOCK_WAIT_MS, releaseSupportLock } = require('../lib/support/lock');
const { THREAD_IDLE_MS } = require('../lib/support/policy');
const { createSupportStore } = require('../lib/support/store');
const { SMS_CONSENT_LABEL, SMS_OPT_IN_CONFIRMATION, helpReply } = require('../lib/support/http');
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
  const support = hooks.support || '+15557650000';
  const calls = hooks.calls || [
    { sid: 'CA_support', to: support, from: '+15551110001', startTime: new Date(NOW - (91 * DAY_MS)) },
    { sid: 'CA_other', to: '+15550000000', from: '+15550000001', startTime: new Date(NOW - (91 * DAY_MS)) },
  ];
  const defaultCall = 'CA_support';
  const defaultRecording = recordings[0] && recordings[0].sid;

  function removeBody(bucket, sid) {
    return {
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
    };
  }

  function listable(bucket, select) {
    const fn = (sid) => removeBody(bucket, sid);
    fn.list = async (params) => {
      lists.push({ bucket, params });
      return select(params).map((item) => ({ ...item }));
    };
    return fn;
  }

  const callFn = (sid) => ({
    recordings: listable('recordings', () => recordings.filter((item) => (item.callSid || defaultCall) === sid)),
  });
  callFn.list = async (params) => {
    lists.push({ bucket: 'calls', params });
    return calls.map((item) => ({ ...item }));
  };
  const recordingFn = (sid) => ({
    transcriptions: listable('transcriptions', () => transcriptions.filter((item) => (item.recordingSid || defaultRecording) === sid)),
  });
  const messageFn = (sid) => removeBody('recordings', sid);
  messageFn.list = async (params) => {
    lists.push({ bucket: 'messages', params });
    return [];
  };

  return {
    client: {
      calls: callFn,
      recordings: recordingFn,
      messages: messageFn,
    },
    removed,
    attempted,
    lists,
    support,
  };
}

test('retention days default to 63 and never drop below 1', () => {
  assert.equal(retentionDays({}), 63);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '' }), 63);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: '   ' }), 63);
  assert.equal(retentionDays({ SUPPORT_RETENTION_DAYS: 'nope' }), 63);
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
  for (const name of ['threads.json', 'messages/blob.txt', 'transcripts/clip.txt', 'recordings/vm.wav', 'stray.txt', 'link-old', 'opt-outs.json', 'consents.jsonl']) {
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
  assert.equal(first.value.sms, 0);
  assert.equal(first.value.twilio, 'off');
  assert.equal(first.value.errors, 0);
  assert.match(log, /Support retention: days=90 threads=4 messages=6 transcripts=3 files=3 recordings=0 transcriptions=0 sms=0 twilio=off errors=0/);
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
  const support = '+15557650000';
  const twilio = mockTwilio([
    { sid: 'RE_old', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed' },
    { sid: 'RE_exact', dateCreated: new Date(cutoff), status: 'completed' },
    { sid: 'RE_young', dateCreated: new Date(cutoff + 1000), status: 'completed' },
    { sid: 'RE_missing', status: 'completed' },
    { sid: 'RE_processing', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'processing' },
    { sid: 'RE_gone', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed' },
    { sid: 'RE_fail', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed' },
    { sid: 'RE_other_brand', callSid: 'CA_other', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed' },
  ], [
    { sid: 'TR_old', recordingSid: 'RE_old', dateCreated: new Date(NOW - (91 * DAY_MS)), status: 'completed', transcriptionText: 'SECRET_TWILIO_TRANSCRIPT' },
    { sid: 'TR_young', recordingSid: 'RE_young', dateCreated: new Date(NOW - DAY_MS), status: 'completed', transcriptionText: 'YOUNG_TWILIO_TRANSCRIPT' },
    { sid: 'TR_live', recordingSid: 'RE_old', dateCreated: new Date(NOW - (100 * DAY_MS)), status: 'in-progress' },
    { sid: 'TR_other', recordingSid: 'RE_other_brand', dateCreated: new Date(NOW - (100 * DAY_MS)), status: 'completed' },
  ], {
    support,
    gone: new Set(['RE_gone']),
    fail: new Set(['RE_fail']),
  });
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: {
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      SUPPORT_RETENTION_DAYS: '90',
      TWILIO_ACCOUNT_SID: 'AC_test_account',
      TWILIO_AUTH_TOKEN: 'not-a-real-token',
      TWILIO_SUPPORT_NUMBER: support,
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
  const callLists = twilio.lists.filter((entry) => entry.bucket === 'calls');
  assert.equal(callLists.length, 2);
  assert.equal(callLists[0].params.to, support);
  assert.equal(callLists[0].params.from, undefined);
  assert.equal(callLists[1].params.from, support);
  assert.equal(callLists[1].params.to, undefined);
  assert.equal(callLists[0].params.pageSize, 200);
  assert.equal(callLists[0].params.startTimeBefore.getTime(), cutoff + DAY_MS);
  const recordingList = twilio.lists.find((entry) => entry.bucket === 'recordings');
  assert.equal(recordingList.params.pageSize, 200);
  assert.equal(recordingList.params.includeSoftDeleted, undefined);
  assert.equal(recordingList.params.dateCreatedBefore.getTime(), cutoff + DAY_MS);
  assert.equal(recordingList.params.to, undefined);
  assert.equal(recordingList.params.from, undefined);
  const transcriptionList = twilio.lists.find((entry) => entry.bucket === 'transcriptions');
  assert.equal(transcriptionList.params.dateCreatedBefore, undefined);
  assert.equal(twilio.attempted.recordings.includes('RE_other_brand'), false);
  assert.equal(twilio.attempted.transcriptions.includes('TR_other'), false);
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

test('missing timestamps use file mtime and durable names survive at any depth', async () => {
  const dir = tempDir();
  const old = NOW - (100 * DAY_MS);
  const young = NOW - (2 * DAY_MS);
  const hour = 60 * 60 * 1000;

  writeJson(path.join(dir, 'nested', 'opt-outs.json'), {
    optOuts: { '+15551110001': { at: iso(old), source: 'sms' } },
  });
  writeJson(path.join(dir, 'opt-outs.json.bak'), { optOuts: { '+15551110002': { at: iso(old) } } });
  writeJson(path.join(dir, 'archive', 'consents.jsonl'), [{ phone: '+15551110003', timestamp: iso(old) }]);
  writeJson(path.join(dir, 'archive', 'Consents-old.json'), { phone: '+15551110004' });
  writeJson(path.join(dir, 'fresh-notes.json'), { hello: 'FRESH_UNKNOWN' });
  writeJson(path.join(dir, 'old-notes.json'), { hello: 'OLD_UNKNOWN' });
  writeJson(path.join(dir, 'fresh-loose.json'), [{ body: 'UNDATED_FRESH' }]);
  writeJson(path.join(dir, 'old-loose.json'), [{ body: 'UNDATED_OLD' }, 'UNDATED_STRING']);
  writeJson(path.join(dir, 'threads.json'), {
    '+15551110005': { history: [{ role: 'user', content: 'FUTURE_THREAD' }], updatedAt: iso(NOW + (10 * DAY_MS)) },
  });
  writeJson(path.join(dir, 'messages.json'), {
    later: { at: NOW + (5 * DAY_MS), body: 'FUTURE_BODY' },
  });
  const futureFile = path.join(dir, 'future-loose.json');
  writeJson(futureFile, [{ body: 'FUTURE_MTIME' }]);
  const futureBin = path.join(dir, 'future.bin');
  fs.writeFileSync(futureBin, 'FUTURE_BIN');
  fs.mkdirSync(path.join(dir, 'lost+found'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lost+found', 'old.txt'), 'LOST_SECRET');
  fs.writeFileSync(path.join(dir, 'stale.tmp'), 'OLD_TMP_SECRET');
  fs.writeFileSync(path.join(dir, 'fresh.tmp'), 'YOUNG_TMP');
  fs.writeFileSync(path.join(dir, 'hour.tmp'), 'HOUR_TMP');

  for (const name of [
    'nested/opt-outs.json',
    'opt-outs.json.bak',
    'archive/consents.jsonl',
    'archive/Consents-old.json',
    'old-notes.json',
    'old-loose.json',
    'lost+found/old.txt',
  ]) {
    age(path.join(dir, name), old);
  }
  age(path.join(dir, 'fresh-notes.json'), young);
  age(path.join(dir, 'fresh-loose.json'), young);
  age(path.join(dir, 'stale.tmp'), NOW - hour - 1000);
  age(path.join(dir, 'fresh.tmp'), NOW - (30 * 60 * 1000));
  age(path.join(dir, 'hour.tmp'), NOW - hour);
  age(futureFile, NOW + (10 * DAY_MS));
  age(futureBin, NOW + (10 * DAY_MS));

  const nestedBefore = fs.readFileSync(path.join(dir, 'nested', 'opt-outs.json'));
  const bakBefore = fs.readFileSync(path.join(dir, 'opt-outs.json.bak'));
  const consentBefore = fs.readFileSync(path.join(dir, 'archive', 'consents.jsonl'));

  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' },
    now: () => NOW,
  }));
  const log = lines.join('\n');
  assert.equal(log.includes('FRESH_UNKNOWN'), false);
  assert.equal(log.includes('OLD_UNKNOWN'), false);
  assert.equal(log.includes('UNDATED_FRESH'), false);
  assert.equal(log.includes('FUTURE_THREAD'), false);
  assert.equal(log.includes('LOST_SECRET'), false);
  assert.equal(log.includes('OLD_TMP_SECRET'), false);
  assert.equal(log.includes('+15551110001'), false);

  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'opt-outs.json')).equals(nestedBefore), true);
  assert.equal(fs.readFileSync(path.join(dir, 'opt-outs.json.bak')).equals(bakBefore), true);
  assert.equal(fs.readFileSync(path.join(dir, 'archive', 'consents.jsonl')).equals(consentBefore), true);
  assert.equal(fs.existsSync(path.join(dir, 'archive', 'Consents-old.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'fresh-notes.json'), 'utf8')).hello, 'FRESH_UNKNOWN');
  assert.equal(fs.existsSync(path.join(dir, 'old-notes.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'fresh-loose.json'), 'utf8'))[0].body, 'UNDATED_FRESH');
  assert.equal(fs.existsSync(path.join(dir, 'old-loose.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'lost+found', 'old.txt'), 'utf8'), 'LOST_SECRET');
  assert.equal(fs.existsSync(path.join(dir, 'stale.tmp')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'fresh.tmp'), 'utf8'), 'YOUNG_TMP');
  assert.equal(fs.readFileSync(path.join(dir, 'hour.tmp'), 'utf8'), 'HOUR_TMP');

  const threads = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  assert.equal(threads['+15551110005'].updatedAt, iso(NOW));
  assert.equal(threads['+15551110005'].history[0].content, 'FUTURE_THREAD');
  const messages = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
  assert.equal(messages.later.at, NOW);
  assert.equal(messages.later.body, 'FUTURE_BODY');
  const futureLoose = JSON.parse(fs.readFileSync(futureFile, 'utf8'));
  assert.equal(futureLoose[0].body, 'FUTURE_MTIME');
  assert.equal(futureLoose[0].updatedAt, iso(NOW));
  assert.equal(fs.readFileSync(futureBin, 'utf8'), 'FUTURE_BIN');
  assert.ok(fs.statSync(futureBin).mtimeMs <= NOW + 2000);

  assert.equal(value.threads, 0);
  assert.equal(value.messages, 0);
  assert.ok(value.files >= 2);
  assert.equal(value.errors, 0);
});

test('a symlinked data directory is swept through its real path', async () => {
  const real = tempDir();
  const parent = tempDir();
  const link = path.join(parent, 'support');
  fs.symlinkSync(real, link);
  const artifact = path.join(real, 'stray.txt');
  fs.writeFileSync(artifact, 'LINKED_SECRET');
  age(artifact, NOW - (100 * DAY_MS));
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: link,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: link, SUPPORT_RETENTION_DAYS: '90' },
    now: () => NOW,
  }));
  assert.equal(fs.existsSync(artifact), false);
  assert.equal(fs.existsSync(path.join(real, '.support.lock')), false);
  assert.equal(value.files, 1);
  assert.equal(lines.join('\n').includes('LINKED_SECRET'), false);
});

test('the sweep refuses a busy lock and a stale lock can be taken over', async () => {
  assert.ok(LOCK_STALE_MS >= 20 * 1000);
  assert.ok(LOCK_STALE_MS <= 30 * 1000);
  const dir = tempDir();
  const artifact = path.join(dir, 'stray.txt');
  fs.writeFileSync(artifact, 'LOCKED_SECRET');
  age(artifact, NOW - (100 * DAY_MS));
  const env = { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' };
  const held = acquireSupportLock(dir);
  try {
    let pending;
    assert.doesNotThrow(() => {
      pending = sweepSupportRetention({ directory: dir, env, now: () => NOW });
    });
    await assert.rejects(pending, (err) => err && err.code === 'EBUSY');
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'LOCKED_SECRET');
  } finally {
    releaseSupportLock(held);
  }

  const stale = acquireSupportLock(dir);
  const staleAt = new Date(Date.now() - (2 * 60 * 60 * 1000));
  fs.utimesSync(stale.path, staleAt, staleAt);
  try {
    const { value } = await capture(() => sweepSupportRetention({ directory: dir, env, now: () => NOW }));
    assert.equal(value.files, 1);
    assert.equal(value.errors, 0);
    assert.equal(fs.existsSync(artifact), false);
  } finally {
    releaseSupportLock(stale);
  }
});

test('a live lock older than 30 seconds is taken and a foreign host is not', async () => {
  const dir = tempDir();
  const artifact = path.join(dir, 'stray.txt');
  const env = { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' };
  fs.writeFileSync(artifact, 'LIVE_LOCK_SECRET');
  age(artifact, NOW - (100 * DAY_MS));
  const held = acquireSupportLock(dir);
  const aged = new Date(Date.now() - (31 * 1000));
  fs.utimesSync(held.path, aged, aged);
  try {
    const { value } = await capture(() => sweepSupportRetention({ directory: dir, env, now: () => NOW }));
    assert.equal(value.files, 1);
    assert.equal(fs.existsSync(artifact), false);
  } finally {
    releaseSupportLock(held);
  }

  const foreign = tempDir();
  const foreignFile = path.join(foreign, 'stray.txt');
  fs.writeFileSync(foreignFile, 'FOREIGN_SECRET');
  age(foreignFile, NOW - (100 * DAY_MS));
  fs.writeFileSync(path.join(foreign, '.support.lock'), JSON.stringify({
    pid: 2147483646,
    hostname: 'other-host',
    at: Date.now(),
  }), { mode: 0o600 });
  await assert.rejects(
    sweepSupportRetention({
      directory: foreign,
      env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: foreign, SUPPORT_RETENTION_DAYS: '90' },
      now: () => NOW,
    }),
    (err) => err && err.code === 'EBUSY',
  );
  assert.equal(fs.readFileSync(foreignFile, 'utf8'), 'FOREIGN_SECRET');
});

test('a dead holder on this host is reclaimed immediately', async () => {
  const dir = tempDir();
  const artifact = path.join(dir, 'stray.txt');
  fs.writeFileSync(artifact, 'DEAD_LOCK_SECRET');
  age(artifact, NOW - (100 * DAY_MS));
  fs.writeFileSync(path.join(dir, '.support.lock'), JSON.stringify({
    pid: 2147483646,
    hostname: os.hostname(),
    at: Date.now(),
  }), { mode: 0o600 });
  const started = Date.now();
  const { value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' },
    now: () => NOW,
  }));
  assert.ok(Date.now() - started < 5000);
  assert.equal(value.files, 1);
  assert.equal(fs.existsSync(artifact), false);
  assert.equal(fs.existsSync(path.join(dir, '.support.lock')), false);
});

test('an in-flight sweep skips the next tick and does not hold the lock during Twilio', async () => {
  const dir = tempDir();
  const oldFile = path.join(dir, 'stray.txt');
  fs.writeFileSync(oldFile, 'OVERLAP_SECRET');
  age(oldFile, NOW - (100 * DAY_MS));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let listed = 0;
  const support = '+15557650000';
  const calls = (sid) => ({
    recordings: { list: async () => [], ...(sid ? {} : {}) },
  });
  calls.list = async () => {
    listed += 1;
    await gate;
    return [{ sid: 'CA_support', to: support, from: '+15551110001', startTime: new Date(NOW - (100 * DAY_MS)) }];
  };
  const messages = { list: async () => [] };
  const env = {
    NODE_ENV: 'test',
    SUPPORT_DATA_DIR: dir,
    SUPPORT_RETENTION_DAYS: '90',
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'token',
    TWILIO_SUPPORT_NUMBER: support,
  };
  const store = createSupportStore({ directory: dir, env, now: () => NOW });
  const first = sweepSupportRetention({
    directory: dir,
    env,
    now: () => NOW,
    twilioClient: { calls, messages },
  });
  try {
    const waitStart = Date.now();
    while (listed < 1) {
      if (Date.now() - waitStart > 2000) throw new Error('twilio list did not start');
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(fs.existsSync(path.join(dir, '.support.lock')), false);
    const second = await sweepSupportRetention({
      directory: dir,
      env,
      now: () => NOW,
      twilioClient: { calls, messages },
    });
    assert.equal(second.skipped, true);
    assert.equal(listed, 1);
    const optStart = Date.now();
    store.optOut('+15551110077', 'sms');
    assert.ok(Date.now() - optStart < 1000);
    store.saveThread('+15551110077', {
      turns: 1,
      history: [{ role: 'user', content: 'DURING_SWEEP' }],
      startedAt: iso(NOW),
    });
  } finally {
    release();
  }
  const { lines, value } = await capture(() => first);
  assert.equal(value.errors, 0);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(lines.join('\n').includes('OVERLAP_SECRET'), false);
  assert.equal(lines.join('\n').includes('DURING_SWEEP'), false);
  const threads = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  assert.equal(threads['+15551110077'].history[0].content, 'DURING_SWEEP');
  assert.equal(store.isOptedOut('+15551110077'), true);
});

test('the npm script exits when the support lock is held', () => {
  const dir = tempDir();
  writeJson(path.join(dir, 'threads.json'), {
    '+15551110001': { history: [{ role: 'user', content: 'SCRIPT_LOCKED_SECRET' }], updatedAt: iso(NOW - (200 * DAY_MS)) },
  });
  const held = acquireSupportLock(dir);
  try {
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
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EBUSY/);
    assert.equal(result.stderr.includes('SCRIPT_LOCKED_SECRET'), false);
    assert.equal(result.stdout.includes('SCRIPT_LOCKED_SECRET'), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'))['+15551110001'].history[0].content, 'SCRIPT_LOCKED_SECRET');
  } finally {
    releaseSupportLock(held);
  }
});

test('store writes from two processes keep every thread, opt-out, and consent', async () => {
  const dir = tempDir();
  const script = `
    const { createSupportStore } = require('./lib/support/store');
    const phone = process.argv[1];
    const store = createSupportStore({
      directory: process.env.SUPPORT_DATA_DIR,
      env: process.env,
    });
    for (let i = 1; i <= 25; i += 1) {
      store.saveThread(phone, {
        turns: i,
        history: [{ role: 'user', content: 'n' }],
        startedAt: new Date().toISOString(),
      });
    }
    store.optOut(phone, 'sms');
    store.addConsent({
      phone,
      consentTextVersion: 'v1',
      timestamp: new Date().toISOString(),
      source: 'website',
    });
  `;
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    SUPPORT_DATA_DIR: dir,
  };
  function run(phone) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script, phone], { cwd: ROOT, env });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
  }
  const phones = ['+15551112001', '+15551112002'];
  const results = await Promise.all(phones.map((phone) => run(phone)));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const threads = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  assert.equal(threads[phones[0]].turns, 25);
  assert.equal(threads[phones[1]].turns, 25);
  const optOuts = JSON.parse(fs.readFileSync(path.join(dir, 'opt-outs.json'), 'utf8'));
  assert.ok(optOuts.optOuts[phones[0]]);
  assert.ok(optOuts.optOuts[phones[1]]);
  const consents = fs.readFileSync(path.join(dir, 'consents.jsonl'), 'utf8').trim().split('\n');
  assert.equal(consents.length, 2);
});

test('twilio messages to and from the support number are deleted with the same error handling', async () => {
  const dir = tempDir();
  const cutoff = NOW - (90 * DAY_MS);
  const support = '+15557650000';
  const old = new Date(NOW - (91 * DAY_MS));
  const twilio = mockTwilio([
    { sid: 'RE_old', dateCreated: old, status: 'completed' },
  ], [
    { sid: 'TR_old', recordingSid: 'RE_old', dateCreated: old, status: 'completed', transcriptionText: 'SECRET_TWILIO_TRANSCRIPT' },
  ], { support });
  const removed = [];
  const attempted = [];
  const lists = [];
  const messages = [
    { sid: 'SM_to', to: support, from: '+15551110001', dateSent: old, body: 'SECRET_SMS_BODY' },
    { sid: 'SM_from', to: '+15551110002', from: support, dateSent: old, body: 'SECRET_SMS_OUT' },
    { sid: 'SM_both', to: support, from: support, dateSent: old },
    { sid: 'SM_pretty', to: '+1 (555) 765-0000', from: '+15551110004', dateSent: old },
    { sid: 'SM_other', to: '+15551110009', from: '+15551110008', dateSent: old, body: 'OTHER_SMS' },
    { sid: 'SM_young', to: support, from: '+15551110003', dateSent: new Date(cutoff + 1000) },
    { sid: 'SM_missing', to: support, from: '+15551110005' },
    { sid: 'SM_gone', to: support, from: '+15551110006', dateSent: old },
    { sid: 'SM_fail', to: '+15551110007', from: support, dateSent: old },
  ];
  const gone = new Set(['SM_gone']);
  const fail = new Set(['SM_fail']);
  const messageFn = (sid) => ({
    async remove() {
      attempted.push(sid);
      if (gone.has(sid)) {
        const err = new Error('gone SECRET_SMS_ERROR');
        err.status = 404;
        err.code = 20404;
        throw err;
      }
      if (fail.has(sid)) {
        const err = new Error('boom SECRET_SMS_BODY');
        err.status = 500;
        err.code = 20500;
        throw err;
      }
      removed.push(sid);
    },
  });
  messageFn.list = async (params) => {
    lists.push(params);
    return messages.map((item) => ({ ...item }));
  };
  twilio.client.messages = messageFn;
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: {
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      SUPPORT_RETENTION_DAYS: '90',
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_SUPPORT_NUMBER: support,
    },
    now: () => NOW,
    twilioClient: twilio.client,
  }));
  assert.deepEqual(removed.sort(), ['SM_both', 'SM_from', 'SM_pretty', 'SM_to']);
  assert.deepEqual(attempted.sort(), ['SM_both', 'SM_fail', 'SM_from', 'SM_gone', 'SM_pretty', 'SM_to']);
  assert.equal(lists.length, 2);
  assert.equal(lists[0].to, support);
  assert.equal(lists[0].from, undefined);
  assert.equal(lists[1].from, support);
  assert.equal(lists[1].to, undefined);
  assert.equal(lists[0].dateSentBefore.getTime(), cutoff + DAY_MS);
  assert.equal(lists[0].pageSize, 200);
  assert.equal(value.sms, 5);
  assert.equal(value.recordings, 1);
  assert.equal(value.transcriptions, 1);
  assert.equal(value.errors, 1);
  const log = lines.join('\n');
  assert.match(log, /sms=5/);
  assert.match(log, /Support retention failed 20500/);
  assert.equal(log.includes('SECRET_SMS_BODY'), false);
  assert.equal(log.includes('SECRET_TWILIO_TRANSCRIPT'), false);
  assert.equal(log.includes(support), false);
});

test('a surfaced 429 stops the rest of the twilio pass', async () => {
  const dir = tempDir();
  const old = new Date(NOW - (100 * DAY_MS));
  const support = '+15557650000';
  const removed = [];
  const transcribed = [];
  let messages = 0;
  const recordings = (sid) => ({
    async remove() {
      if (sid === 'RE_slow') {
        const err = new Error('slow SECRET_RATE');
        err.status = 429;
        err.code = 20429;
        throw err;
      }
      removed.push(sid);
    },
  });
  recordings.list = async () => [
    { sid: 'RE_ok', dateCreated: old, status: 'completed' },
    { sid: 'RE_slow', dateCreated: old, status: 'completed' },
    { sid: 'RE_later', dateCreated: old, status: 'completed' },
  ];
  const transcriptions = (sid) => ({
    transcriptions: {
      list: async () => {
        transcribed.push(sid);
        return [];
      },
    },
  });
  const calls = (sid) => ({ recordings });
  calls.list = async (params) => {
    if (params.from) return [];
    return [{ sid: 'CA_support', to: support, from: '+15551110001', startTime: old }];
  };
  const messageList = { list: async () => { messages += 1; return []; } };
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: {
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      SUPPORT_RETENTION_DAYS: '90',
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_SUPPORT_NUMBER: support,
    },
    now: () => NOW,
    twilioClient: { calls, recordings: transcriptions, messages: messageList },
  }));
  assert.deepEqual(removed, ['RE_ok']);
  assert.deepEqual(transcribed, ['RE_ok', 'RE_slow']);
  assert.equal(messages, 0);
  assert.equal(value.recordings, 1);
  assert.equal(value.sms, 0);
  assert.equal(value.errors, 1);
  const log = lines.join('\n');
  assert.match(log, /Support retention failed 20429/);
  assert.equal(log.includes('SECRET_RATE'), false);
});

test('a 429 on the next recording page stops after the current page', async () => {
  const dir = tempDir();
  const old = new Date(NOW - (100 * DAY_MS));
  const support = '+15557650000';
  const removed = [];
  let messages = 0;
  const recordings = (sid) => ({
    async remove() { removed.push(sid); },
  });
  recordings.page = async (params) => {
    assert.equal(params.pageSize, 200);
    assert.equal(params.dateCreatedBefore.getTime(), (NOW - (90 * DAY_MS)) + DAY_MS);
    return {
      instances: [{ sid: 'RE_page', dateCreated: old, status: 'completed' }],
      nextPage: async () => {
        const err = new Error('page SECRET_PAGE');
        err.status = 429;
        err.code = 20429;
        throw err;
      },
    };
  };
  recordings.list = async () => {
    throw new Error('list should not be used when page exists');
  };
  const calls = () => ({ recordings });
  calls.list = async (params) => {
    if (params.from) return [];
    return [{ sid: 'CA_support', to: support, from: '+15551110001', startTime: old }];
  };
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: {
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      SUPPORT_RETENTION_DAYS: '90',
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_SUPPORT_NUMBER: support,
    },
    now: () => NOW,
    twilioClient: {
      calls,
      recordings: () => ({ transcriptions: { list: async () => [] } }),
      messages: { list: async () => { messages += 1; return []; } },
    },
  }));
  assert.deepEqual(removed, ['RE_page']);
  assert.equal(messages, 0);
  assert.equal(value.recordings, 1);
  assert.equal(value.errors, 1);
  assert.match(lines.join('\n'), /Support retention failed 20429/);
  assert.equal(lines.join('\n').includes('SECRET_PAGE'), false);
});

test('the retention twilio client enables autoRetry', async () => {
  const dir = tempDir();
  let seen = null;
  const calls = () => ({ recordings: { list: async () => [] } });
  calls.list = async () => [];
  const messages = { list: async () => [] };
  const { value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: {
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      TWILIO_ACCOUNT_SID: 'AC_factory',
      TWILIO_AUTH_TOKEN: 'factory-token',
      TWILIO_SUPPORT_NUMBER: '+15557650000',
    },
    now: () => NOW,
    twilioFactory(sid, token, opts) {
      seen = { sid, token, opts };
      return { calls, messages };
    },
  }));
  assert.equal(seen.sid, 'AC_factory');
  assert.equal(seen.token, 'factory-token');
  assert.equal(seen.opts.autoRetry, true);
  assert.equal(seen.opts.maxRetries, 3);
  assert.equal(value.twilio, 'on');
  assert.equal(value.sms, 0);
  assert.equal(value.errors, 0);
});

test('a non-directory and a busy lock do not throw into boot', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  const clock = fakeClock(NOW);
  const retention = startSupportRetention({
    directory: file,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: file, SUPPORT_RETENTION_DAYS: '90' },
    now: () => NOW,
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (timer) => clock.clearInterval(timer),
  });
  await retention.started;
  retention.stop();

  let pending;
  assert.doesNotThrow(() => {
    pending = sweepSupportRetention({
      directory: file,
      env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: file },
      now: () => NOW,
    });
  });
  assert.equal(typeof pending.then, 'function');
  await assert.rejects(pending, (err) => err && (err.code === 'EEXIST' || err.code === 'ENOTDIR'));

  const locked = tempDir();
  const artifact = path.join(locked, 'stray.txt');
  fs.writeFileSync(artifact, 'BOOT_SECRET');
  age(artifact, NOW - (100 * DAY_MS));
  const held = acquireSupportLock(locked);
  const bootClock = fakeClock(NOW);
  const boot = startSupportRetention({
    directory: locked,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: locked, SUPPORT_RETENTION_DAYS: '90' },
    now: () => NOW,
    setInterval: (fn, ms) => bootClock.setInterval(fn, ms),
    clearInterval: (timer) => bootClock.clearInterval(timer),
  });
  try {
    await boot.started;
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'BOOT_SECRET');
  } finally {
    boot.stop();
    releaseSupportLock(held);
  }
});

test('a timer tick during Twilio does not start a second pass', async () => {
  const dir = tempDir();
  const clock = fakeClock(NOW);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let listed = 0;
  const calls = () => ({ recordings: { list: async () => [] } });
  calls.list = async () => {
    listed += 1;
    await gate;
    return [];
  };
  const retention = startSupportRetention({
    directory: dir,
    env: {
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      SUPPORT_RETENTION_DAYS: '90',
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_SUPPORT_NUMBER: '+15557650000',
    },
    now: () => clock.now(),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (timer) => clock.clearInterval(timer),
    twilioClient: { calls, messages: { list: async () => [] } },
  });
  try {
    const waitStart = Date.now();
    while (listed < 1) {
      if (Date.now() - waitStart > 2000) throw new Error('twilio list did not start');
      await new Promise((resolve) => setImmediate(resolve));
    }
    await clock.advance(RETENTION_INTERVAL_MS);
    assert.equal(listed, 1);
  } finally {
    release();
    await retention.started;
    retention.stop();
  }
});

test('shutdown releases a held support lock', async () => {
  const dir = tempDir();
  const clock = fakeClock(NOW);
  const retention = startSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    now: () => clock.now(),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (timer) => clock.clearInterval(timer),
  });
  await retention.started;
  const held = acquireSupportLock(dir);
  assert.equal(fs.existsSync(held.path), true);
  retention.stop();
  assert.equal(fs.existsSync(held.path), false);
});

test('the store waits a few seconds instead of blocking on the lock', () => {
  assert.ok(LOCK_WAIT_MS >= 1000);
  assert.ok(LOCK_WAIT_MS <= 5000);
  const dir = tempDir();
  const env = { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir };
  const store = createSupportStore({ directory: dir, env, now: () => NOW });
  const held = acquireSupportLock(dir);
  try {
    const started = Date.now();
    assert.throws(
      () => store.optOut('+15551110001', 'sms'),
      (err) => err && err.status === 500,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= LOCK_WAIT_MS - 250, `elapsed ${elapsed}`);
    assert.ok(elapsed < 20000, `elapsed ${elapsed}`);
    assert.equal(fs.existsSync(path.join(dir, 'opt-outs.json')), false);
  } finally {
    releaseSupportLock(held);
  }
});

test('a killed holder is reclaimed on the next sweep', async () => {
  const dir = tempDir();
  const artifact = path.join(dir, 'stray.txt');
  fs.writeFileSync(artifact, 'KILLED_SECRET');
  age(artifact, NOW - (100 * DAY_MS));
  const script = `
    const { acquireSupportLock } = require('./lib/support/lock');
    acquireSupportLock(process.env.SUPPORT_DATA_DIR);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
    },
    stdio: 'ignore',
  });
  const lockPath = path.join(dir, '.support.lock');
  try {
    const waitStart = Date.now();
    while (!fs.existsSync(lockPath)) {
      if (child.exitCode != null) throw new Error('child exited before locking');
      if (Date.now() - waitStart > 5000) throw new Error('child lock did not appear');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('close', resolve));
    assert.equal(fs.existsSync(lockPath), true);
    const started = Date.now();
    const { lines, value } = await capture(() => sweepSupportRetention({
      directory: dir,
      env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' },
      now: () => NOW,
    }));
    assert.ok(Date.now() - started < 5000);
    assert.equal(value.files, 1);
    assert.equal(value.errors, 0);
    assert.equal(fs.existsSync(artifact), false);
    assert.equal(lines.join('\n').includes('KILLED_SECRET'), false);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
});

test('the lock is released before Twilio and a killed sweep can be restarted', async () => {
  const dir = tempDir();
  const script = `
    const fs = require('fs');
    const path = require('path');
    const { sweepSupportRetention } = require('./lib/support/retention');
    const root = process.env.SUPPORT_DATA_DIR;
    const calls = () => ({ recordings: { list: async () => [] } });
    calls.list = () => {
      fs.writeFileSync(path.join(root, 'twilio-started'), '1');
      // A pending promise does not keep the process alive. The interval does,
      // so the parent can observe the lock after this list starts.
      setInterval(() => {}, 1000);
      return new Promise(() => {});
    };
    sweepSupportRetention({
      directory: root,
      env: process.env,
      twilioClient: { calls, messages: { list: async () => [] } },
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      SUPPORT_RETENTION_DAYS: '90',
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_SUPPORT_NUMBER: '+15557650000',
    },
    stdio: 'ignore',
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  const startedFile = path.join(dir, 'twilio-started');
  try {
    const waitStart = Date.now();
    while (!fs.existsSync(startedFile)) {
      if (child.exitCode != null) throw new Error('child exited before Twilio');
      if (Date.now() - waitStart > 5000) throw new Error('twilio list did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(path.join(dir, '.support.lock')), false);
    child.kill('SIGKILL');
    await closed;
    const artifact = path.join(dir, 'stray.txt');
    fs.writeFileSync(artifact, 'RESTART_SECRET');
    age(artifact, NOW - (100 * DAY_MS));
    const { value } = await capture(() => sweepSupportRetention({
      directory: dir,
      env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' },
      now: () => NOW,
    }));
    assert.equal(value.files, 1);
    assert.equal(fs.existsSync(artifact), false);
    assert.equal(fs.existsSync(path.join(dir, '.support.lock')), false);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
});

test('corrupt and oversized JSON follow the file modification time', async () => {
  const dir = tempDir();
  const old = NOW - (100 * DAY_MS);
  const young = NOW - (2 * DAY_MS);
  const big = 'x'.repeat((8 * 1024 * 1024) + 1);
  fs.writeFileSync(path.join(dir, 'old-bad.json'), '{');
  fs.writeFileSync(path.join(dir, 'young-bad.json'), '{');
  fs.writeFileSync(path.join(dir, 'old-big.json'), big);
  fs.writeFileSync(path.join(dir, 'young-big.json'), big);
  age(path.join(dir, 'old-bad.json'), old);
  age(path.join(dir, 'old-big.json'), old);
  age(path.join(dir, 'young-bad.json'), young);
  age(path.join(dir, 'young-big.json'), young);
  const { value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' },
    now: () => NOW,
  }));
  assert.equal(value.errors, 0);
  assert.equal(fs.existsSync(path.join(dir, 'old-bad.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'old-big.json')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'young-bad.json'), 'utf8'), '{');
  assert.equal(fs.existsSync(path.join(dir, 'young-big.json')), true);
});

test('a stampless record is stamped on first sight and later expires', async () => {
  const dir = tempDir();
  const young = NOW - (2 * DAY_MS);
  writeJson(path.join(dir, 'threads.json'), {
    '+15551110042': { history: [{ role: 'user', content: 'STAMP_ME' }] },
  });
  age(path.join(dir, 'threads.json'), young);
  const env = { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' };
  const first = await capture(() => sweepSupportRetention({ directory: dir, env, now: () => NOW }));
  const threads = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  const stamped = Date.parse(threads['+15551110042'].updatedAt);
  assert.ok(Math.abs(stamped - young) < 2000);
  assert.equal(threads['+15551110042'].history[0].content, 'STAMP_ME');
  assert.equal(first.value.threads, 0);
  assert.equal(first.lines.join('\n').includes('STAMP_ME'), false);
  const later = NOW + (100 * DAY_MS);
  const second = await capture(() => sweepSupportRetention({ directory: dir, env, now: () => later }));
  assert.equal(second.value.threads, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8')), {});
});

test('durable names match files only and directories are still entered', async () => {
  const dir = tempDir();
  const old = NOW - (100 * DAY_MS);
  fs.mkdirSync(path.join(dir, 'opt-outs-dir'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'consents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'opt-outs-dir', 'old.txt'), 'DIR_SECRET');
  writeJson(path.join(dir, 'consents', 'consents.json'), { phone: '+15551110001', body: 'KEEP_CONSENT' });
  writeJson(path.join(dir, 'consents', 'note.json'), { body: 'NESTED_OLD' });
  writeJson(path.join(dir, 'consent.json'), { body: 'NOT_A_PREFIX' });
  for (const name of ['opt-outs-dir/old.txt', 'consents/consents.json', 'consents/note.json', 'consent.json']) {
    age(path.join(dir, name), old);
  }
  const kept = fs.readFileSync(path.join(dir, 'consents', 'consents.json'));
  const keptMtime = fs.statSync(path.join(dir, 'consents', 'consents.json')).mtimeMs;
  const { lines } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' },
    now: () => NOW,
  }));
  assert.equal(fs.existsSync(path.join(dir, 'opt-outs-dir', 'old.txt')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'consents', 'consents.json')).equals(kept), true);
  assert.equal(fs.statSync(path.join(dir, 'consents', 'consents.json')).mtimeMs, keptMtime);
  assert.equal(fs.existsSync(path.join(dir, 'consents', 'note.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'consent.json')), false);
  const log = lines.join('\n');
  assert.equal(log.includes('DIR_SECRET'), false);
  assert.equal(log.includes('KEEP_CONSENT'), false);
  assert.equal(log.includes('NESTED_OLD'), false);
  assert.equal(log.includes('+15551110001'), false);
});

test('opt-outs and consents are never opened by the 63-day sweep', async () => {
  const dir = tempDir();
  const ancient = NOW - (6 * 365 * DAY_MS);
  writeJson(path.join(dir, 'opt-outs.json'), {
    optOuts: { '+15551110001': { at: iso(ancient), source: 'sms' } },
    optIns: {},
  });
  const consent = `${JSON.stringify({ phone: '+15551110001', timestamp: iso(ancient), consentText: 'SECRET_CONSENT' })}\n`;
  fs.writeFileSync(path.join(dir, 'consents.jsonl'), consent, { mode: 0o600 });
  writeJson(path.join(dir, 'nested', 'opt-outs.json.bak'), { at: iso(ancient) });
  age(path.join(dir, 'opt-outs.json'), ancient);
  age(path.join(dir, 'consents.jsonl'), ancient);
  age(path.join(dir, 'nested', 'opt-outs.json.bak'), ancient);
  const optBefore = fs.readFileSync(path.join(dir, 'opt-outs.json'));
  const consentBefore = fs.readFileSync(path.join(dir, 'consents.jsonl'));
  const bakBefore = fs.readFileSync(path.join(dir, 'nested', 'opt-outs.json.bak'));
  const optMtime = fs.statSync(path.join(dir, 'opt-outs.json')).mtimeMs;
  const consentMtime = fs.statSync(path.join(dir, 'consents.jsonl')).mtimeMs;
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '63' },
    now: () => NOW,
  }));
  assert.equal(fs.readFileSync(path.join(dir, 'opt-outs.json')).equals(optBefore), true);
  assert.equal(fs.readFileSync(path.join(dir, 'consents.jsonl')).equals(consentBefore), true);
  assert.equal(fs.readFileSync(path.join(dir, 'nested', 'opt-outs.json.bak')).equals(bakBefore), true);
  assert.equal(fs.statSync(path.join(dir, 'opt-outs.json')).mtimeMs, optMtime);
  assert.equal(fs.statSync(path.join(dir, 'consents.jsonl')).mtimeMs, consentMtime);
  assert.equal(value.errors, 0);
  assert.equal(lines.join('\n').includes('SECRET_CONSENT'), false);
  assert.equal(lines.join('\n').includes('+15551110001'), false);
});

test('second-resolution timestamps are aged as milliseconds and sub-second skew is kept', async () => {
  const dir = tempDir();
  writeJson(path.join(dir, 'messages.json'), {
    oldSec: { at: Math.floor((NOW - (100 * DAY_MS)) / 1000), body: 'SEC_OLD' },
    skew: { at: NOW + 500, body: 'SKEW_BODY' },
    futureSec: { at: Math.floor(NOW / 1000) + 5, body: 'FUT_SEC' },
  });
  const { lines } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir, SUPPORT_RETENTION_DAYS: '90' },
    now: () => NOW,
  }));
  const messages = JSON.parse(fs.readFileSync(path.join(dir, 'messages.json'), 'utf8'));
  assert.equal(messages.oldSec, undefined);
  assert.equal(messages.skew.at, NOW + 500);
  assert.equal(messages.skew.body, 'SKEW_BODY');
  assert.equal(messages.futureSec.at, Math.floor(NOW / 1000));
  assert.equal(messages.futureSec.body, 'FUT_SEC');
  const log = lines.join('\n');
  assert.equal(log.includes('SEC_OLD'), false);
  assert.equal(log.includes('SKEW_BODY'), false);
  assert.equal(log.includes('FUT_SEC'), false);
});

test('escalation texts are deleted only for this app prefix to the escalation phone', async () => {
  const dir = tempDir();
  const support = '+15557650000';
  const from = '+15557651111';
  const recipient = '+15557652222';
  const old = new Date(NOW - (91 * DAY_MS));
  const rows = [
    { sid: 'SM_esc', from, to: recipient, dateSent: old, body: 'ManualOS Support: SECRET_ESC' },
    { sid: 'SM_plain', from, to: recipient, dateSent: old, body: 'hello SECRET_PLAIN' },
    { sid: 'SM_other', from, to: '+15550001111', dateSent: old, body: 'ManualOS Support: nope' },
  ];
  const removed = [];
  const lists = [];
  const messageFn = (sid) => ({
    async remove() { removed.push(sid); },
  });
  messageFn.list = async (params) => {
    lists.push({ ...params });
    return rows.map((item) => ({ ...item }));
  };
  const calls = () => ({ recordings: { list: async () => [] } });
  calls.list = async () => [];
  const baseEnv = {
    NODE_ENV: 'test',
    SUPPORT_DATA_DIR: dir,
    SUPPORT_RETENTION_DAYS: '90',
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'token',
    TWILIO_SUPPORT_NUMBER: support,
    TWILIO_FROM_NUMBER: from,
  };
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: { ...baseEnv, ESCALATION_PHONE: recipient },
    now: () => NOW,
    twilioClient: { calls, messages: messageFn },
  }));
  assert.deepEqual(removed, ['SM_esc']);
  assert.equal(lists.length, 3);
  assert.equal(lists[2].from, from);
  assert.equal(lists[2].to, recipient);
  assert.equal(value.sms, 1);
  assert.equal(value.errors, 0);
  assert.equal(lines.join('\n').includes('SECRET_ESC'), false);
  assert.equal(lines.join('\n').includes(from), false);

  removed.length = 0;
  const warned = await capture(() => sweepSupportRetention({
    directory: dir,
    env: baseEnv,
    now: () => NOW,
    twilioClient: { calls, messages: messageFn },
  }));
  assert.deepEqual(removed, []);
  assert.match(warned.lines.join('\n'), /Support retention skipped escalation texts: ESCALATION_PHONE is not set/);
  assert.equal(warned.lines.join('\n').includes('SECRET_PLAIN'), false);
});

test('an unset support number skips every Twilio delete', async () => {
  const dir = tempDir();
  let calls = 0;
  const client = {
    calls: {
      list() {
        calls += 1;
        return [];
      },
    },
    messages: {
      list() {
        calls += 1;
        return [];
      },
    },
  };
  const { lines, value } = await capture(() => sweepSupportRetention({
    directory: dir,
    env: {
      NODE_ENV: 'test',
      SUPPORT_DATA_DIR: dir,
      TWILIO_ACCOUNT_SID: 'AC_test',
      TWILIO_AUTH_TOKEN: 'token',
    },
    now: () => NOW,
    twilioClient: client,
  }));
  assert.equal(calls, 0);
  assert.equal(value.twilio, 'off');
  assert.equal(value.recordings, 0);
  assert.equal(value.sms, 0);
  assert.match(lines.join('\n'), /Support retention skipped Twilio deletion: TWILIO_SUPPORT_NUMBER is not set/);
});

test('the approved HELP reply and consent record stay intact', () => {
  const withNumber = helpReply({ SUPPORT_PHONE: '+15557654321' });
  const withoutNumber = helpReply({});
  assert.equal(withNumber, 'ManualOS (Op3x LLC) support: email support@manualos.com or call +1 555-765-4321. Msg&data rates may apply. Reply STOP to cancel.');
  assert.equal(withoutNumber, 'ManualOS (Op3x LLC) support: email support@manualos.com. Msg&data rates may apply. Reply STOP to cancel.');
  const source = fs.readFileSync(path.join(ROOT, 'lib/support/http.js'), 'utf8');
  assert.equal(source.includes(SMS_CONSENT_LABEL), true);
  assert.equal(source.includes(SMS_OPT_IN_CONFIRMATION), true);
  assert.equal(SMS_OPT_IN_CONFIRMATION, "ManualOS (Op3x LLC): You're opted in to support & order-status texts. Msg frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to cancel.");
  assert.match(SMS_CONSENT_LABEL, /^Yes, text me at this number\. I agree to receive support replies and order\/manual-status texts from ManualOS \(Op3x LLC\)\./);

  const dir = tempDir();
  const store = createSupportStore({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    now: () => NOW,
  });
  store.addConsent({
    phone: '+15551110001',
    consentTextVersion: 'support-sms-v3',
    timestamp: iso(NOW),
    source: 'sms',
    consentText: SMS_CONSENT_LABEL,
    scope: 'support-replies,order-status',
    alerts: true,
    pending: false,
    webOptIn: true,
    confirmationSent: true,
    expiresAt: iso(NOW),
  });
  const row = store.listConsents()[0];
  assert.equal(row.consentText, SMS_CONSENT_LABEL);
  assert.equal(row.scope, 'support-replies,order-status');
  assert.equal(row.alerts, true);
  assert.equal(row.pending, false);
  assert.equal(row.webOptIn, true);
  assert.equal(row.confirmationSent, true);
  assert.equal(row.expiresAt, iso(NOW));
});

test('digit groups are stored inside the thread lock and cleared after idle', () => {
  const dir = tempDir();
  let t = NOW;
  const store = createSupportStore({
    directory: dir,
    env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    now: () => t,
  });
  const phone = '+15551110088';
  const groups = [];
  for (let i = 0; i < 10; i += 1) {
    groups.push({ digits: '12345678901234567890', at: t, labeled: i === 0, msg: i });
  }
  store.saveThread(phone, {
    turns: 1,
    history: [{ role: 'user', content: '4111111111111111' }],
    startedAt: iso(t),
    digitGroups: groups,
  });
  const live = store.getThread(phone);
  assert.equal(live.digitGroups.length, 8);
  assert.equal(live.digitGroups[0].digits, '1234567890123456789');
  assert.equal(live.history[0].content.includes('4111111111111111'), false);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  assert.equal(JSON.stringify(onDisk).includes('1234567890123456789'), false);
  t = NOW + THREAD_IDLE_MS;
  const idle = store.getThread(phone);
  assert.equal(idle.history.length, 0);
  assert.equal(idle.digitGroups, undefined);
  t = NOW + 1000;
  const again = store.getThread(phone);
  assert.deepEqual(again.digitGroups, []);
  assert.equal(again.history.length, 1);
});
