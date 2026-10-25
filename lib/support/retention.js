const fs = require('fs');
const path = require('path');
const { supportDataDirectory } = require('./store');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 1;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PAGE_SIZE = 200;

// Root files that are not customer-message artifacts. Opt-outs and consents
// have to outlive the 90-day window. Budget and dedupe state have no message body.
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

function sweepSupportRetention(options = {}) {
  const env = options.env || process.env;
  const days = retentionDays(env);
  const rawNow = typeof options.now === 'function' ? Number(options.now()) : Date.now();
  const nowMs = Number.isFinite(rawNow) ? rawNow : Date.now();
  const cutoff = nowMs - (days * DAY_MS);
  const dir = options.directory
    ? options.directory
    : supportDataDirectory(env, { warn: options.warn !== false });

  return sweepDiskThenTwilio(dir, cutoff, env, options.twilioClient)
    .then((counts) => {
      const result = { days, ...counts };
      logCounts(result);
      return result;
    });
}

function startSupportRetention(options = {}) {
  const schedule = options.setInterval || setInterval;
  const cancel = options.clearInterval || clearInterval;
  const run = () => sweepSupportRetention(options).catch((err) => {
    console.error('Support retention failed', err && err.code ? err.code : 'error');
  });
  const started = run();
  const timer = schedule(run, RETENTION_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    started,
    run,
    stop() {
      if (timer) cancel(timer);
    },
  };
}

async function sweepDiskThenTwilio(dir, cutoff, env, twilioClient) {
  const disk = emptyDisk();
  try {
    const swept = sweepDirectory(dir, cutoff);
    Object.assign(disk, swept);
  } catch (err) {
    disk.failed += 1;
    console.error('Support retention failed', err && err.code ? err.code : 'error');
  }
  const remote = await sweepTwilio(env, twilioClient, cutoff);
  return {
    threads: disk.threads,
    messages: disk.messages,
    transcripts: disk.transcripts,
    files: disk.files,
    recordings: remote.recordings,
    transcriptions: remote.transcriptions,
    twilio: remote.twilio,
    errors: disk.failed + remote.errors,
    failed: disk.failed,
    twilioErrors: remote.errors,
  };
}

function emptyDisk() {
  return { threads: 0, messages: 0, transcripts: 0, files: 0, failed: 0 };
}

function sweepDirectory(dir, cutoff) {
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

  pruneThreadsFile(path.join(dir, 'threads.json'), counts, cutoff);
  pruneStateFile(path.join(dir, 'state.json'), counts, cutoff);
  pruneStateFile(path.join(dir, 'state.json.migrated'), counts, cutoff);
  pruneNotices(path.join(dir, 'sms-notices.json'), counts, cutoff);
  pruneRecordFile(path.join(dir, 'messages.json'), counts, cutoff, 'messages');
  pruneRecordFile(path.join(dir, 'transcripts.json'), counts, cutoff, 'transcripts');
  walkArtifacts(dir, counts, cutoff);
  return counts;
}

function pruneThreadsFile(file, counts, cutoff) {
  const loaded = readJson(file);
  if (loaded.status === 'missing' || loaded.status === 'skip') return;
  if (loaded.status !== 'ok') return fail(counts, loaded.code);
  if (!isPlain(loaded.data)) return fail(counts, 'error');
  const result = pruneThreadMap(loaded.data, cutoff);
  counts.threads += result.threads;
  counts.messages += result.messages;
  if (result.changed) writeOrFail(file, loaded.data, counts);
}

function pruneStateFile(file, counts, cutoff) {
  const loaded = readJson(file);
  if (loaded.status === 'missing' || loaded.status === 'skip') return;
  if (loaded.status !== 'ok') return fail(counts, loaded.code);
  if (!isPlain(loaded.data) || !isPlain(loaded.data.threads)) return;
  const result = pruneThreadMap(loaded.data.threads, cutoff);
  counts.threads += result.threads;
  counts.messages += result.messages;
  if (result.changed) writeOrFail(file, loaded.data, counts);
}

function pruneThreadMap(threads, cutoff) {
  let threadCount = 0;
  let messageCount = 0;
  let changed = false;
  for (const [key, thread] of Object.entries(threads)) {
    if (!isPlain(thread) || expired(recordStamp(thread), cutoff)) {
      messageCount += historyLength(thread);
      delete threads[key];
      threadCount += 1;
      changed = true;
    }
  }
  return { threads: threadCount, messages: messageCount, changed };
}

function pruneNotices(file, counts, cutoff) {
  const loaded = readJson(file);
  if (loaded.status === 'missing' || loaded.status === 'skip') return;
  if (loaded.status !== 'ok') return fail(counts, loaded.code);
  if (!isPlain(loaded.data)) return fail(counts, 'error');
  let changed = false;
  for (const [key, row] of Object.entries(loaded.data)) {
    if (!isPlain(row) || expired(recordStamp(row), cutoff)) {
      if (hasText(row)) counts.transcripts += 1;
      else counts.messages += 1;
      delete loaded.data[key];
      changed = true;
    }
  }
  if (changed) writeOrFail(file, loaded.data, counts);
}

function pruneRecordFile(file, counts, cutoff, bucket) {
  const loaded = readJson(file);
  if (loaded.status === 'missing' || loaded.status === 'skip') return;
  if (loaded.status !== 'ok') return fail(counts, loaded.code);
  const classified = classifyRecords(loaded.data, cutoff);
  if (classified.kind === 'skip') {
    deleteIfOld(file, counts, cutoff, bucket);
    return;
  }
  counts[bucket] += classified.removed;
  if (classified.deleteFile) {
    removePath(file, counts);
    return;
  }
  if (classified.changed) writeOrFail(file, classified.data, counts);
}

function walkArtifacts(root, counts, cutoff) {
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
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      const atRoot = !rel.includes(path.sep);
      if (entry.isSymbolicLink()) {
        if (atRoot && KEEP_ROOT.has(entry.name)) continue;
        deleteIfOld(full, counts, cutoff, bucketFor(rel));
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(full);
        directories.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (atRoot && KEEP_ROOT.has(entry.name)) continue;
      sweepArtifact(full, rel, counts, cutoff);
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

function sweepArtifact(file, rel, counts, cutoff) {
  const bucket = bucketFor(rel);
  if (file.endsWith('.json')) {
    pruneRecordFile(file, counts, cutoff, bucket);
    return;
  }
  deleteIfOld(file, counts, cutoff, bucket);
}

function classifyRecords(data, cutoff) {
  if (Array.isArray(data)) {
    const kept = [];
    let removed = 0;
    for (const item of data) {
      if (dropRecord(item, cutoff)) removed += 1;
      else kept.push(item);
    }
    return {
      kind: 'list',
      data: kept,
      removed,
      changed: removed > 0,
      deleteFile: removed > 0 && kept.length === 0,
    };
  }
  if (!isPlain(data)) return { kind: 'skip' };
  if (isSingleRecord(data)) {
    if (!dropRecord(data, cutoff)) return { kind: 'one', removed: 0, changed: false, deleteFile: false };
    return { kind: 'one', removed: 1, changed: true, deleteFile: true };
  }
  const values = Object.values(data);
  if (!values.length || !values.every(isPlain)) return { kind: 'skip' };
  const next = {};
  let removed = 0;
  for (const [key, value] of Object.entries(data)) {
    if (dropRecord(value, cutoff)) removed += 1;
    else next[key] = value;
  }
  return {
    kind: 'map',
    data: next,
    removed,
    changed: removed > 0,
    deleteFile: removed > 0 && Object.keys(next).length === 0,
  };
}

function dropRecord(record, cutoff) {
  if (!isPlain(record)) return true;
  return expired(recordStamp(record), cutoff);
}

function isSingleRecord(data) {
  for (const key of STAMP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (typeof value === 'number' || typeof value === 'string' || value instanceof Date) return true;
  }
  return TEXT_KEYS.some((key) => typeof data[key] === 'string');
}

function deleteIfOld(file, counts, cutoff, bucket) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') fail(counts, err && err.code);
    return;
  }
  if (stat.isDirectory()) return;
  if (stat.mtimeMs > cutoff) return;
  if (removePath(file, counts)) counts[bucket] += 1;
}

function bucketFor(rel) {
  const name = String(rel || '').replace(/\\/g, '/').toLowerCase();
  if (name.includes('transcript')) return 'transcripts';
  if (name.includes('message')) return 'messages';
  return 'files';
}

function expired(stamp, cutoff) {
  return stamp == null || stamp <= cutoff;
}

function recordStamp(record) {
  if (!isPlain(record)) return null;
  for (const key of STAMP_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const stamp = stampOf(record[key]);
    if (stamp != null) return stamp;
  }
  return null;
}

function stampOf(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
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

function readJson(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', code: err && err.code ? err.code : 'error' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'skip' };
  try {
    return { status: 'ok', data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { status: 'unreadable', code: err && err.code ? err.code : 'error' };
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

async function sweepTwilio(env, twilioClient, cutoff) {
  const off = { recordings: 0, transcriptions: 0, twilio: 'off', errors: 0 };
  if (!credentialsPresent(env) || twilioClient === null) return off;
  let client = twilioClient;
  if (client === undefined) {
    try {
      const twilio = require('twilio');
      client = twilio(String(env.TWILIO_ACCOUNT_SID).trim(), String(env.TWILIO_AUTH_TOKEN).trim());
    } catch (err) {
      console.error('Support retention failed', err && err.code ? err.code : 'error');
      return { recordings: 0, transcriptions: 0, twilio: 'on', errors: 1 };
    }
  }
  if (!client) return off;
  const recordings = await deleteAged(client.recordings, cutoff, true, RECORDING_SKIP);
  const transcriptions = await deleteAged(client.transcriptions, cutoff, false, TRANSCRIPTION_SKIP);
  return {
    recordings: recordings.deleted,
    transcriptions: transcriptions.deleted,
    twilio: 'on',
    errors: recordings.errors + transcriptions.errors,
  };
}

async function deleteAged(collection, cutoff, dateFilter, skipStatus) {
  if (!collection || typeof collection.list !== 'function') return { deleted: 0, errors: 1 };
  let items;
  try {
    const params = { pageSize: PAGE_SIZE };
    // DateCreated<= is a GMT calendar day. Ask for the day after the cutoff,
    // then keep only resources whose instant is actually outside the window.
    if (dateFilter) params.dateCreatedBefore = new Date(cutoff + DAY_MS);
    items = await collection.list(params);
  } catch (err) {
    console.error('Support retention failed', err && err.code ? err.code : 'error');
    return { deleted: 0, errors: 1 };
  }
  if (!Array.isArray(items)) return { deleted: 0, errors: 1 };
  let deleted = 0;
  let errors = 0;
  for (const item of items) {
    if (!item || typeof item.sid !== 'string' || !item.sid.trim()) continue;
    const stamp = stampOf(item.dateCreated);
    if (stamp == null || stamp > cutoff) continue;
    const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
    if (status && skipStatus.has(status)) continue;
    try {
      await removeResource(collection, item.sid);
      deleted += 1;
    } catch (err) {
      if (isGone(err)) {
        deleted += 1;
      } else {
        errors += 1;
        console.error('Support retention failed', err && err.code ? err.code : 'error');
      }
    }
  }
  return { deleted, errors };
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
