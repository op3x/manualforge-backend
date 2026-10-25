const fs = require('fs');
const path = require('path');
const { e164 } = require('./policy');
const { supportDataDirectory } = require('./store');
const {
  LOCK_NAME,
  canonicalizeSupportDir,
  releaseAllSupportLocks,
  withSupportLock,
} = require('./lock');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SECOND_MS = 1000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const ESCALATION_PREFIX = 'ManualOS Support:';
// 63 days on disk plus Railway's 27-day weekly backup is the 90-day promise.
const DEFAULT_RETENTION_DAYS = 63;
const MIN_RETENTION_DAYS = 1;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TEMP_MAX_AGE_MS = HOUR_MS;
const PAGE_SIZE = 200;
const TWILIO_MAX_RETRIES = 3;

// Root files that are not customer-message artifacts. Opt-outs are kept
// forever. Consent records are purged 5 years after the last message or the
// opt-out, whichever is later. This sweep does not do that purge: a file
// whose name starts with opt-outs or consents is never opened. Budget and
// dedupe state have no message body.
const KEEP_ROOT = new Set([
  'opt-outs.json',
  'consents.jsonl',
  'budget.json',
  'once.json',
  'threads.json',
  'sms-notices.json',
  'state.json',
  'state.json.migrated',
  'messages.json',
  'transcripts.json',
]);

const STAMP_KEYS = ['updatedAt', 'startedAt', 'createdAt', 'timestamp', 'at', 'dateCreated', 'date'];
const TEXT_KEYS = ['line', 'detail', 'transcript', 'body', 'content', 'text', 'message'];
const RECORDING_SKIP = new Set(['in-progress', 'processing', 'paused', 'stopped', 'deleted']);
const TRANSCRIPTION_SKIP = new Set(['in-progress', 'deleted']);

function retentionDays(env = {}) {
  const raw = env && env.SUPPORT_RETENTION_DAYS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_RETENTION_DAYS;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.floor(parsed));
}

let inFlight = null;

async function sweepSupportRetention(options = {}) {
  const env = options.env || process.env;
  const days = retentionDays(env);
  if (inFlight) {
    console.log('Support retention skipped in-flight');
    return skippedResult(days);
  }
  const run = runSweep(options, env, days);
  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

async function runSweep(options, env, days) {
  const rawNow = typeof options.now === 'function' ? Number(options.now()) : Date.now();
  const nowMs = Number.isFinite(rawNow) ? rawNow : Date.now();
  const cutoff = nowMs - (days * DAY_MS);
  const dir = canonicalizeSupportDir(options.directory
    ? options.directory
    : supportDataDirectory(env, { warn: options.warn !== false }));

  // The lock covers the disk read-modify-write only. A busy lock rejects this
  // promise; it does not throw into the boot path or the 6-hour timer. The
  // one-off script exits non-zero. Another tick in this process is skipped
  // by the in-flight flag before it asks for the lock. Twilio runs after release.
  const disk = await withSupportLock(dir, () => sweepDirectory(dir, cutoff, nowMs), {
    waitMs: 0,
    reentrant: false,
  });
  const remote = await sweepTwilio(env, options.twilioClient, options.twilioFactory, cutoff);
  const result = {
    days,
    threads: disk.threads,
    messages: disk.messages,
    transcripts: disk.transcripts,
    files: disk.files,
    recordings: remote.recordings,
    transcriptions: remote.transcriptions,
    sms: remote.sms,
    twilio: remote.twilio,
    errors: disk.failed + remote.errors,
  };
  logCounts(result);
  return result;
}

function skippedResult(days) {
  return {
    skipped: true,
    days,
    threads: 0,
    messages: 0,
    transcripts: 0,
    files: 0,
    recordings: 0,
    transcriptions: 0,
    sms: 0,
    twilio: 'off',
    errors: 0,
  };
}

function startSupportRetention(options = {}) {
  const schedule = options.setInterval || setInterval;
  const cancel = options.clearInterval || clearInterval;
  let stopped = false;
  const run = () => {
    if (stopped) return Promise.resolve();
    return sweepSupportRetention(options).catch((err) => {
      console.error('Support retention failed', err && err.code ? err.code : 'error');
    });
  };
  const started = run();
  const timer = schedule(run, RETENTION_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    started,
    run,
    stop() {
      stopped = true;
      if (timer) cancel(timer);
      releaseAllSupportLocks();
    },
  };
}

function emptyDisk() {
  return { threads: 0, messages: 0, transcripts: 0, files: 0, failed: 0 };
}

function sweepDirectory(dir, cutoff, nowMs) {
  const counts = emptyDisk();
  if (!dir || typeof dir !== 'string') return counts;
  let rootStat;
  try {
    rootStat = fs.lstatSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return counts;
    counts.failed += 1;
    console.error('Support retention failed', err && err.code ? err.code : 'error');
    return counts;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    counts.failed += 1;
    console.error('Support retention failed', 'ENOTDIR');
    return counts;
  }

  deleteStaleTemps(dir, counts, nowMs);
  pruneThreadsFile(path.join(dir, 'threads.json'), counts, cutoff, nowMs);
  pruneStateFile(path.join(dir, 'state.json'), counts, cutoff, nowMs);
  pruneStateFile(path.join(dir, 'state.json.migrated'), counts, cutoff, nowMs);
  pruneNotices(path.join(dir, 'sms-notices.json'), counts, cutoff, nowMs);
  pruneRecordFile(path.join(dir, 'messages.json'), counts, cutoff, nowMs, 'messages');
  pruneRecordFile(path.join(dir, 'transcripts.json'), counts, cutoff, nowMs, 'transcripts');
  walkArtifacts(dir, counts, cutoff, nowMs);
  return counts;
}

function deleteStaleTemps(root, counts, nowMs) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') fail(counts, err && err.code);
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'lost+found' || entry.name === LOCK_NAME) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(full);
        continue;
      }
      if (durableFileName(entry.name) || !entry.name.endsWith('.tmp')) continue;
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') fail(counts, err && err.code);
        continue;
      }
      const mtime = clampMtime(stat.mtimeMs, nowMs, full);
      if (mtime == null || nowMs - mtime <= TEMP_MAX_AGE_MS) continue;
      removePath(full, counts);
    }
  }
}

function pruneThreadsFile(file, counts, cutoff, nowMs) {
  const loaded = readJson(file, nowMs);
  if (loaded.status === 'missing' || loaded.status === 'skip') return;
  if (loaded.status === 'bad') return deleteIfOld(file, counts, cutoff, nowMs, 'files');
  if (loaded.status !== 'ok') return fail(counts, loaded.code);
  if (!isPlain(loaded.data)) return fail(counts, 'error');
  const result = pruneThreadMap(loaded.data, cutoff, nowMs, loaded.mtime);
  counts.threads += result.threads;
  counts.messages += result.messages;
  if (result.changed) writeOrFail(file, loaded.data, counts);
}

function pruneStateFile(file, counts, cutoff, nowMs) {
  const loaded = readJson(file, nowMs);
  if (loaded.status === 'missing' || loaded.status === 'skip') return;
  if (loaded.status === 'bad') return deleteIfOld(file, counts, cutoff, nowMs, 'files');
  if (loaded.status !== 'ok') return fail(counts, loaded.code);
  if (!isPlain(loaded.data) || !isPlain(loaded.data.threads)) return;
  const result = pruneThreadMap(loaded.data.threads, cutoff, nowMs, loaded.mtime);
  counts.threads += result.threads;
  counts.messages += result.messages;
  if (result.changed) writeOrFail(file, loaded.data, counts);
}

function pruneThreadMap(threads, cutoff, nowMs, fileMtime) {
  let threadCount = 0;
  let messageCount = 0;
  let changed = false;
  for (const [key, thread] of Object.entries(threads)) {
    const decision = decideRecord(thread, cutoff, nowMs, fileMtime);
    changed = decision.clamped || changed;
    if (!decision.drop) continue;
    messageCount += historyLength(thread);
    delete threads[key];
    threadCount += 1;
    changed = true;
  }
  return { threads: threadCount, messages: messageCount, changed };
}

function pruneNotices(file, counts, cutoff, nowMs) {
  const loaded = readJson(file, nowMs);
  if (loaded.status === 'missing' || loaded.status === 'skip') return;
  if (loaded.status === 'bad') return deleteIfOld(file, counts, cutoff, nowMs, 'files');
  if (loaded.status !== 'ok') return fail(counts, loaded.code);
  if (!isPlain(loaded.data)) return fail(counts, 'error');
  let changed = false;
  for (const [key, row] of Object.entries(loaded.data)) {
    const decision = decideRecord(row, cutoff, nowMs, loaded.mtime);
    changed = decision.clamped || changed;
    if (!decision.drop) continue;
    if (hasText(row)) counts.transcripts += 1;
    else counts.messages += 1;
    delete loaded.data[key];
    changed = true;
  }
  if (changed) writeOrFail(file, loaded.data, counts);
}

function pruneRecordFile(file, counts, cutoff, nowMs, bucket) {
  const loaded = readJson(file, nowMs);
  if (loaded.status === 'missing' || loaded.status === 'skip') return;
  if (loaded.status === 'bad') return deleteIfOld(file, counts, cutoff, nowMs, bucket);
  if (loaded.status !== 'ok') return fail(counts, loaded.code);
  const classified = classifyRecords(loaded.data, cutoff, nowMs, loaded.mtime);
  if (classified.kind === 'skip') {
    deleteIfOld(file, counts, cutoff, nowMs, bucket);
    return;
  }
  counts[bucket] += classified.removed;
  if (classified.deleteFile) {
    removePath(file, counts);
    return;
  }
  if (classified.changed) writeOrFail(file, classified.data, counts);
}

function durableFileName(name) {
  const base = String(name || '').toLowerCase();
  return base.startsWith('opt-outs') || base.startsWith('consents');
}

function walkArtifacts(root, counts, cutoff, nowMs) {
  const pending = [root];
  const directories = [];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') fail(counts, err && err.code);
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'lost+found' || entry.name === LOCK_NAME) continue;
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      const atRoot = !rel.includes(path.sep);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(full);
        directories.push(full);
        continue;
      }
      if (durableFileName(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        if (atRoot && KEEP_ROOT.has(entry.name)) continue;
        deleteIfOld(full, counts, cutoff, nowMs, bucketFor(rel));
        continue;
      }
      if (!entry.isFile()) continue;
      if (atRoot && KEEP_ROOT.has(entry.name)) continue;
      sweepArtifact(full, rel, counts, cutoff, nowMs);
    }
  }
  directories.sort((a, b) => b.length - a.length);
  for (const directory of directories) {
    try {
      if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
    } catch {
      // A file kept inside the directory, or a race with another writer.
    }
  }
}

function sweepArtifact(file, rel, counts, cutoff, nowMs) {
  const bucket = bucketFor(rel);
  if (file.endsWith('.json')) {
    pruneRecordFile(file, counts, cutoff, nowMs, bucket);
    return;
  }
  deleteIfOld(file, counts, cutoff, nowMs, bucket);
}

function classifyRecords(data, cutoff, nowMs, fileMtime) {
  if (Array.isArray(data)) {
    const kept = [];
    let removed = 0;
    let changed = false;
    for (const item of data) {
      const decision = decideRecord(item, cutoff, nowMs, fileMtime);
      if (decision.clamped) changed = true;
      if (decision.drop) removed += 1;
      else kept.push(item);
    }
    return {
      kind: 'list',
      data: kept,
      removed,
      changed: changed || removed > 0,
      deleteFile: removed > 0 && kept.length === 0,
    };
  }
  if (!isPlain(data)) return { kind: 'skip' };
  if (isSingleRecord(data)) {
    const decision = decideRecord(data, cutoff, nowMs, fileMtime);
    if (decision.drop) return { kind: 'one', removed: 1, changed: true, deleteFile: true };
    return { kind: 'one', data, removed: 0, changed: decision.clamped, deleteFile: false };
  }
  const values = Object.values(data);
  if (!values.length || !values.every(isPlain)) return { kind: 'skip' };
  const next = {};
  let removed = 0;
  let changed = false;
  for (const [key, value] of Object.entries(data)) {
    const decision = decideRecord(value, cutoff, nowMs, fileMtime);
    if (decision.clamped) changed = true;
    if (decision.drop) removed += 1;
    else next[key] = value;
  }
  return {
    kind: 'map',
    data: next,
    removed,
    changed: changed || removed > 0,
    deleteFile: removed > 0 && Object.keys(next).length === 0,
  };
}

function decideRecord(record, cutoff, nowMs, fileMtime) {
  const found = findStamp(record);
  if (!found) {
    if (fileMtime != null && fileMtime <= cutoff) return { drop: true, clamped: false };
    // A file that is rewritten stays young. Stamp a dateless record on first
    // sight so that rewrite cannot keep it forever.
    if (isPlain(record)) {
      const stamped = fileMtime != null && !isFuture(fileMtime, nowMs) ? fileMtime : nowMs;
      record.updatedAt = new Date(stamped).toISOString();
      return { drop: false, clamped: true };
    }
    return { drop: false, clamped: false };
  }
  if (isFuture(found.ms, nowMs)) {
    record[found.key] = clampedStamp(found.raw, nowMs);
    return { drop: false, clamped: true };
  }
  return { drop: found.ms <= cutoff, clamped: false };
}

function isFuture(stamp, nowMs) {
  return stamp >= nowMs + SECOND_MS;
}

function findStamp(record) {
  if (!isPlain(record)) return null;
  for (const key of STAMP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const raw = record[key];
    const ms = stampOf(raw);
    if (ms != null) return { key, ms, raw };
  }
  return null;
}

function clampedStamp(raw, nowMs) {
  if (typeof raw === 'number') {
    if (Math.abs(raw) < 1e12) return Math.floor(nowMs / SECOND_MS);
    return nowMs;
  }
  return new Date(nowMs).toISOString();
}

function isSingleRecord(data) {
  for (const key of STAMP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (typeof value === 'number' || typeof value === 'string' || value instanceof Date) return true;
  }
  return TEXT_KEYS.some((key) => typeof data[key] === 'string');
}

function deleteIfOld(file, counts, cutoff, nowMs, bucket) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') fail(counts, err && err.code);
    return;
  }
  if (stat.isDirectory()) return;
  const mtime = clampMtime(stat.mtimeMs, nowMs, file);
  if (mtime == null || mtime > cutoff) return;
  if (removePath(file, counts) && bucket) counts[bucket] += 1;
}

function clampMtime(mtimeMs, nowMs, file) {
  if (!Number.isFinite(mtimeMs)) return null;
  if (!isFuture(mtimeMs, nowMs)) return mtimeMs;
  if (file) {
    const when = new Date(nowMs);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fs.lutimesSync(file, when, when);
      else fs.utimesSync(file, when, when);
    } catch {
      // Age is still "now", so a future modification time cannot keep the file forever.
    }
  }
  return nowMs;
}

function bucketFor(rel) {
  const name = String(rel || '').replace(/\\/g, '/').toLowerCase();
  if (name.includes('transcript')) return 'transcripts';
  if (name.includes('message')) return 'messages';
  return 'files';
}

function stampOf(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds are 10 digits. Milliseconds are 13. A second-resolution
    // number must not be read as 1970.
    if (Math.abs(value) < 1e12) return value * SECOND_MS;
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function historyLength(thread) {
  if (!isPlain(thread) || !Array.isArray(thread.history)) return 0;
  return thread.history.length;
}

function hasText(row) {
  if (!isPlain(row)) return false;
  return TEXT_KEYS.some((key) => typeof row[key] === 'string' && row[key].trim());
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file, nowMs) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', code: err && err.code ? err.code : 'error' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'skip' };
  const mtime = clampMtime(stat.mtimeMs, nowMs, file);
  if (stat.size > MAX_JSON_BYTES) return { status: 'bad', mtime };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { status: 'unreadable', code: err && err.code ? err.code : 'error', mtime };
  }
  try {
    return { status: 'ok', data: JSON.parse(raw), mtime };
  } catch {
    return { status: 'bad', mtime };
  }
}

function writeOrFail(file, data, counts) {
  try {
    writeJsonAtomic(file, data);
  } catch (err) {
    fail(counts, err && err.code);
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* the temp file may already be gone */ }
    throw err;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* the replace already used mode 0600 */ }
}

function removePath(file, counts) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fs.unlinkSync(file);
    else fs.rmSync(file, { force: true });
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return true;
    fail(counts, err && err.code);
    return false;
  }
}

function fail(counts, code) {
  counts.failed += 1;
  console.error('Support retention failed', code || 'error');
}

function credentialsPresent(env) {
  const sid = String(env && env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(env && env.TWILIO_AUTH_TOKEN || '').trim();
  return Boolean(sid && token);
}

function openTwilio(env, twilioFactory) {
  const sid = String(env.TWILIO_ACCOUNT_SID).trim();
  const token = String(env.TWILIO_AUTH_TOKEN).trim();
  const opts = { autoRetry: true, maxRetries: TWILIO_MAX_RETRIES };
  if (typeof twilioFactory === 'function') return twilioFactory(sid, token, opts);
  const twilio = require('twilio');
  return twilio(sid, token, opts);
}

// Recordings and transcriptions are deleted only for calls to or from
// TWILIO_SUPPORT_NUMBER. The account may be shared with another brand.
async function sweepTwilio(env, twilioClient, twilioFactory, cutoff) {
  const off = { recordings: 0, transcriptions: 0, sms: 0, twilio: 'off', errors: 0 };
  if (!credentialsPresent(env) || twilioClient === null) return off;
  const support = e164(env && env.TWILIO_SUPPORT_NUMBER);
  if (!support) {
    console.warn('Support retention skipped Twilio deletion: TWILIO_SUPPORT_NUMBER is not set');
    return off;
  }
  let client = twilioClient;
  if (client === undefined) {
    try {
      client = openTwilio(env, twilioFactory);
    } catch (err) {
      console.error('Support retention failed', errorCode(err));
      return { ...off, twilio: 'on', errors: 1 };
    }
  }
  if (!client) return off;

  const seenCalls = new Set();
  const toMedia = await sweepSupportCalls(client, cutoff, support, 'to', seenCalls);
  if (toMedia.stopped) return mediaCounts(toMedia, null);
  const fromMedia = await sweepSupportCalls(client, cutoff, support, 'from', seenCalls);
  const media = combineMedia(toMedia, fromMedia);
  if (fromMedia.stopped) return mediaCounts(media, null);

  const seen = new Set();
  const inbound = await deleteAged(client.messages, cutoff, {
    dateField: 'dateSent',
    dateParam: 'dateSentBefore',
    extra: { to: support },
    match: (item) => e164(item && item.to) === support,
    seen,
  });
  if (inbound.stopped) return mediaCounts(media, inbound);
  const outbound = await deleteAged(client.messages, cutoff, {
    dateField: 'dateSent',
    dateParam: 'dateSentBefore',
    extra: { from: support },
    match: (item) => e164(item && item.from) === support,
    seen,
  });
  let messages = combineAged(inbound, outbound);
  if (outbound.stopped) return mediaCounts(media, messages);
  messages = combineAged(messages, await sweepEscalationMessages(client, env, cutoff, support, seen));
  return mediaCounts(media, messages);
}

function mediaCounts(media, messages) {
  const calls = media || { recordings: 0, transcriptions: 0, errors: 0 };
  const sms = messages || { deleted: 0, errors: 0 };
  return {
    recordings: calls.recordings || 0,
    transcriptions: calls.transcriptions || 0,
    sms: sms.deleted || 0,
    twilio: 'on',
    errors: (calls.errors || 0) + (sms.errors || 0),
  };
}

function combineMedia(left, right) {
  return {
    recordings: left.recordings + right.recordings,
    transcriptions: left.transcriptions + right.transcriptions,
    errors: left.errors + right.errors,
    stopped: Boolean(left.stopped || right.stopped),
  };
}

async function sweepSupportCalls(client, cutoff, support, direction, seen) {
  const result = { recordings: 0, transcriptions: 0, errors: 0, stopped: false };
  const calls = client && client.calls;
  if (!calls || (typeof calls.page !== 'function' && typeof calls.list !== 'function')) {
    result.errors += 1;
    console.error('Support retention failed', 'ENOSYS');
    return result;
  }
  const params = { pageSize: PAGE_SIZE, startTimeBefore: new Date(cutoff + DAY_MS) };
  params[direction] = support;
  try {
    const signal = await forEachPage(calls, params, async (items) => {
      if (!Array.isArray(items)) {
        result.errors += 1;
        console.error('Support retention failed', 'error');
        return 'stop-page';
      }
      for (const call of items) {
        if (!call || typeof call.sid !== 'string' || !call.sid.trim()) continue;
        if (seen.has(call.sid)) continue;
        const party = direction === 'to' ? call.to : call.from;
        if (e164(party) !== support) continue;
        const started = stampOf(call.startTime);
        if (started != null && started > cutoff) continue;
        seen.add(call.sid);
        const step = await deleteCallMedia(client, call.sid, cutoff, result);
        if (step === 'stop') return 'stop-pass';
      }
      return null;
    });
    if (signal === 'stop-pass') result.stopped = true;
  } catch (err) {
    result.errors += 1;
    result.stopped = isRateLimited(err);
    console.error('Support retention failed', isRateLimited(err) ? rateCode(err) : errorCode(err));
  }
  return result;
}

async function deleteCallMedia(client, callSid, cutoff, result) {
  let recordings;
  try {
    recordings = client.calls(callSid).recordings;
  } catch (err) {
    result.errors += 1;
    console.error('Support retention failed', errorCode(err));
    return 'next';
  }
  try {
    const signal = await forEachPage(recordings, {
      pageSize: PAGE_SIZE,
      dateCreatedBefore: new Date(cutoff + DAY_MS),
    }, async (items) => {
      if (!Array.isArray(items)) {
        result.errors += 1;
        console.error('Support retention failed', 'error');
        return 'stop-page';
      }
      for (const recording of items) {
        if (!recording || typeof recording.sid !== 'string' || !recording.sid.trim()) continue;
        const stamp = stampOf(recording.dateCreated);
        if (stamp == null || stamp > cutoff) continue;
        const status = typeof recording.status === 'string' ? recording.status.toLowerCase() : '';
        if (status && RECORDING_SKIP.has(status)) continue;
        const transcripts = await deleteRecordingTranscriptions(client, recording.sid, cutoff, result);
        if (transcripts === 'stop') return 'stop-pass';
        try {
          await removeResource(recordings, recording.sid);
          result.recordings += 1;
        } catch (err) {
          if (isGone(err)) {
            result.recordings += 1;
            continue;
          }
          result.errors += 1;
          if (isRateLimited(err)) {
            console.error('Support retention failed', rateCode(err));
            return 'stop-pass';
          }
          console.error('Support retention failed', errorCode(err));
        }
      }
      return null;
    });
    return signal === 'stop-pass' ? 'stop' : 'next';
  } catch (err) {
    if (isGone(err)) return 'next';
    result.errors += 1;
    if (isRateLimited(err)) {
      console.error('Support retention failed', rateCode(err));
      return 'stop';
    }
    console.error('Support retention failed', errorCode(err));
    return 'next';
  }
}

async function deleteRecordingTranscriptions(client, recordingSid, cutoff, result) {
  let collection;
  try {
    collection = client.recordings(recordingSid).transcriptions;
  } catch (err) {
    result.errors += 1;
    console.error('Support retention failed', errorCode(err));
    return 'next';
  }
  try {
    const signal = await forEachPage(collection, { pageSize: PAGE_SIZE }, async (items) => {
      if (!Array.isArray(items)) {
        result.errors += 1;
        console.error('Support retention failed', 'error');
        return 'stop-page';
      }
      for (const item of items) {
        if (!item || typeof item.sid !== 'string' || !item.sid.trim()) continue;
        const stamp = stampOf(item.dateCreated);
        if (stamp == null || stamp > cutoff) continue;
        const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
        if (status && TRANSCRIPTION_SKIP.has(status)) continue;
        try {
          await removeResource(collection, item.sid);
          result.transcriptions += 1;
        } catch (err) {
          if (isGone(err)) {
            result.transcriptions += 1;
            continue;
          }
          result.errors += 1;
          if (isRateLimited(err)) {
            console.error('Support retention failed', rateCode(err));
            return 'stop-pass';
          }
          console.error('Support retention failed', errorCode(err));
        }
      }
      return null;
    });
    return signal === 'stop-pass' ? 'stop' : 'next';
  } catch (err) {
    if (isGone(err)) return 'next';
    result.errors += 1;
    if (isRateLimited(err)) {
      console.error('Support retention failed', rateCode(err));
      return 'stop';
    }
    console.error('Support retention failed', errorCode(err));
    return 'next';
  }
}

async function sweepEscalationMessages(client, env, cutoff, support, seen) {
  const from = e164(env && env.TWILIO_FROM_NUMBER);
  const empty = { deleted: 0, errors: 0, stopped: false };
  if (!from || from === support) return empty;
  const recipient = e164(env && env.ESCALATION_PHONE);
  if (!recipient) {
    // Without the recipient we cannot tell this app's texts from another sender on the same number.
    console.warn('Support retention skipped escalation texts: ESCALATION_PHONE is not set');
    return empty;
  }
  return deleteAged(client.messages, cutoff, {
    dateField: 'dateSent',
    dateParam: 'dateSentBefore',
    extra: { from, to: recipient },
    match: (item) => e164(item && item.from) === from
      && e164(item && item.to) === recipient
      && typeof item.body === 'string'
      && item.body.startsWith(ESCALATION_PREFIX),
    seen,
  });
}

function combineAged(left, right) {
  return {
    deleted: left.deleted + right.deleted,
    errors: left.errors + right.errors,
    stopped: Boolean(left.stopped || right.stopped),
  };
}

async function deleteAged(collection, cutoff, options) {
  const result = { deleted: 0, errors: 0, stopped: false };
  if (!collection || (typeof collection.page !== 'function' && typeof collection.list !== 'function')) {
    result.errors += 1;
    console.error('Support retention failed', 'ENOSYS');
    return result;
  }
  const params = { pageSize: PAGE_SIZE };
  // Date filters are a GMT calendar day. Ask for the day after the cutoff,
  // then keep only resources whose instant is actually outside the window.
  if (options.dateParam) params[options.dateParam] = new Date(cutoff + DAY_MS);
  if (options.extra) Object.assign(params, options.extra);
  try {
    const signal = await forEachPage(collection, params, async (items) => {
      if (typeof options.touch === 'function') options.touch();
      if (!Array.isArray(items)) {
        result.errors += 1;
        console.error('Support retention failed', 'error');
        return 'stop-page';
      }
      for (const item of items) {
        const step = await deleteOne(collection, item, cutoff, options, result);
        if (step === 'stop') return 'stop-pass';
      }
      return null;
    });
    if (signal === 'stop-pass') result.stopped = true;
  } catch (err) {
    result.errors += 1;
    result.stopped = isRateLimited(err);
    console.error('Support retention failed', isRateLimited(err) ? rateCode(err) : errorCode(err));
  }
  return result;
}

async function forEachPage(collection, params, visit) {
  if (typeof collection.page === 'function') {
    let page = await collection.page(params);
    while (page) {
      const items = Array.isArray(page) ? page : page.instances;
      const signal = await visit(items);
      if (signal) return signal;
      if (Array.isArray(page) || typeof page.nextPage !== 'function') break;
      page = await page.nextPage();
    }
    return null;
  }
  return visit(await collection.list(params));
}

async function deleteOne(collection, item, cutoff, options, result) {
  if (!item || typeof item.sid !== 'string' || !item.sid.trim()) return 'next';
  if (options.seen && options.seen.has(item.sid)) return 'next';
  if (options.match && !options.match(item)) return 'next';
  const stamp = stampOf(item[options.dateField || 'dateCreated']);
  if (stamp == null || stamp > cutoff) return 'next';
  const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
  if (status && options.skipStatus && options.skipStatus.has(status)) return 'next';
  try {
    await removeResource(collection, item.sid);
    result.deleted += 1;
    if (options.seen) options.seen.add(item.sid);
  } catch (err) {
    if (isGone(err)) {
      result.deleted += 1;
      if (options.seen) options.seen.add(item.sid);
      return 'next';
    }
    result.errors += 1;
    if (isRateLimited(err)) {
      console.error('Support retention failed', rateCode(err));
      return 'stop';
    }
    console.error('Support retention failed', errorCode(err));
  }
  return 'next';
}

async function removeResource(collection, sid) {
  if (typeof collection !== 'function') {
    const err = new Error('Twilio collection is not callable');
    err.code = 'ENOSYS';
    throw err;
  }
  const resource = collection(sid);
  if (resource && typeof resource.remove === 'function') return resource.remove();
  if (resource && typeof resource.delete === 'function') return resource.delete();
  const err = new Error('Twilio resource cannot be deleted');
  err.code = 'ENOSYS';
  throw err;
}

function isGone(err) {
  if (!err) return false;
  if (err.status === 404 || err.statusCode === 404) return true;
  return err.code === 20404 || err.code === '20404';
}

function isRateLimited(err) {
  if (!err) return false;
  if (err.status === 429 || err.statusCode === 429) return true;
  return err.code === 429 || err.code === '429' || err.code === 20429 || err.code === '20429';
}

function rateCode(err) {
  if (err && (err.code === 20429 || err.code === '20429' || err.code === 429 || err.code === '429')) return err.code;
  return 429;
}

function errorCode(err) {
  return err && err.code ? err.code : 'error';
}

function logCounts(counts) {
  console.log([
    'Support retention:',
    `days=${counts.days}`,
    `threads=${counts.threads}`,
    `messages=${counts.messages}`,
    `transcripts=${counts.transcripts}`,
    `files=${counts.files}`,
    `recordings=${counts.recordings}`,
    `transcriptions=${counts.transcriptions}`,
    `sms=${counts.sms}`,
    `twilio=${counts.twilio === 'on' ? 'on' : 'off'}`,
    `errors=${counts.errors}`,
  ].join(' '));
}

module.exports = {
  DAY_MS,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RETENTION_INTERVAL_MS,
  retentionDays,
  startSupportRetention,
  sweepSupportRetention,
};
