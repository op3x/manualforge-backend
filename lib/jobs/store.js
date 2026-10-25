const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { limits } = require('../limits');
const { tokenSecret } = require('../access-token');

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const ephemeralDirectories = new Set();

function createJobStore({
  env = process.env,
  now = () => Date.now(),
  directory,
  setInterval: schedule = setInterval,
  clearInterval: cancel = clearInterval,
} = {}) {
  const ttlMs = limits(env).jobTtlMs;
  const dir = directory || defaultDirectory(env);
  ensureJobDirectory(dir);
  const jobs = new Map();

  function expiresMs(job) {
    if (!job) return 0;
    if (typeof job.expiresAt === 'number' && Number.isFinite(job.expiresAt)) return job.expiresAt;
    const parsed = Date.parse(job.expiresAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // A finished PDF is kept until completedAt plus the TTL. Queued and failed
  // jobs keep the deadline set when they were created. A stored expiresAt
  // cannot push a finished PDF past that cap.
  function retentionDeadline(job) {
    const listed = expiresMs(job);
    if (!job || job.status !== 'succeeded' || !job.completedAt) return listed;
    const finished = Date.parse(job.completedAt);
    if (!Number.isFinite(finished)) return listed;
    const fromPdf = finished + ttlMs;
    if (!listed) return fromPdf;
    return Math.min(listed, fromPdf);
  }

  function eachFile(fn) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      fn(entry.name);
    }
  }

  function mtimeMs(name) {
    try {
      return fs.statSync(path.join(dir, name)).mtimeMs;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      throw err;
    }
  }

  function removeStoredFile(name) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') logCleanupFailure(err);
    }
  }

  // Job pdf and json files in this directory only. Open credit holds live in
  // the parent support directory and are not read or rewritten here.
  function sweep() {
    const cutoff = now();
    for (const [id, job] of jobs) {
      if (retentionDeadline(job) <= cutoff) {
        jobs.delete(id);
        removeStoredFile(`${id}.pdf`);
        removeStoredFile(`${id}.json`);
      }
    }
  }

  // Delete files older than the configured TTL, which is at most 24 hours.
  // Orphan PDFs are deleted only after a one-hour grace period so a new process
  // does not remove PDFs a deploy that is still running may be serving.
  function sweepStartup() {
    const at = now();
    const agedBefore = at - ttlMs;
    const graceBefore = at - ORPHAN_GRACE_MS;
    const live = new Set();
    for (const [id, job] of jobs) {
      if (retentionDeadline(job) > at) live.add(`${id}.pdf`);
    }
    eachFile((name) => {
      const stamped = mtimeMs(name);
      if (stamped == null) return;
      const olderThanTtl = stamped <= agedBefore;
      const orphanPdfPastGrace = String(name).toLowerCase().endsWith('.pdf')
        && !live.has(name)
        && stamped <= graceBefore;
      if (olderThanTtl || orphanPdfPastGrace) removeStoredFile(name);
    });
  }

  // Mtime only. A PDF older than the TTL is removed even if the map still has the job,
  // and a young PDF is kept even if the map has never heard of it.
  function deleteAgedPdfs() {
    const agedBefore = now() - ttlMs;
    eachFile((name) => {
      if (!String(name).toLowerCase().endsWith('.pdf')) return;
      const stamped = mtimeMs(name);
      if (stamped == null) return;
      if (stamped <= agedBefore) removeStoredFile(name);
    });
  }

  function onInterval() {
    try {
      sweep();
      deleteAgedPdfs();
    } catch (err) {
      logCleanupFailure(err);
    }
  }

  try {
    sweepStartup();
    loadPersisted();
    sweep();
  } catch (err) {
    logCleanupFailure(err);
  }

  const timer = schedule(onInterval, CLEANUP_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  function close() {
    if (timer) cancel(timer);
  }

  function pepper() {
    const file = path.join(dir, '.pepper');
    try {
      const existing = fs.readFileSync(file);
      if (existing.length >= 32) return existing;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    const created = crypto.randomBytes(32);
    writePrivate(file, created);
    return created;
  }

  function hashingKey() {
    const secret = tokenSecret(env);
    if (secret) return secret;
    return pepper();
  }

  function hashCredential(value) {
    const text = String(value ?? '');
    if (!text) return '';
    return crypto.createHmac('sha256', hashingKey()).update(text).digest('hex');
  }

  function sealCredential(copy, field) {
    if (typeof copy[field] !== 'string' || !copy[field]) return;
    copy[`${field}Hash`] = hashCredential(copy[field]);
    delete copy[field];
  }

  function persist(job) {
    if (!job || typeof job.id !== 'string' || !/^job_[a-f0-9]{24}$/.test(job.id)) return;
    if (job.status === 'succeeded' && !job.completedAt) {
      const finished = now();
      job.completedAt = new Date(finished).toISOString();
      job.expiresAt = new Date(finished + ttlMs).toISOString();
    }
    const copy = { ...job };
    sealCredential(copy, 'sessionId');
    sealCredential(copy, 'customerId');
    sealCredential(copy, 'subscriptionId');
    writePrivate(path.join(dir, `${job.id}.json`), JSON.stringify(copy));
  }

  function loadPersisted() {
    eachFile((name) => {
      if (!String(name).toLowerCase().endsWith('.json')) return;
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (err) {
        logCleanupFailure(err);
        return;
      }
      if (!parsed || parsed.id !== name.slice(0, -'.json'.length)) return;
      if (!/^job_[a-f0-9]{24}$/.test(parsed.id)) return;
      jobs.set(parsed.id, parsed);
      if (parsed.sessionId || parsed.customerId || parsed.subscriptionId) persist(parsed);
    });
  }

  function create(extra = {}) {
    sweep();
    const id = `job_${crypto.randomBytes(12).toString('hex')}`;
    const createdAt = new Date(now()).toISOString();
    const job = {
      id,
      status: 'queued',
      progress: { stage: 'queued', percent: 0, message: 'Waiting to start' },
      error: null,
      warnings: [],
      coverage: null,
      createdAt,
      expiresAt: new Date(now() + ttlMs).toISOString(),
      ...extra,
    };
    jobs.set(id, job);
    persist(job);
    return job;
  }

  function get(id) {
    sweep();
    return jobs.get(id) || null;
  }

  function savePdf(id, buffer) {
    writePrivate(path.join(dir, `${id}.pdf`), buffer);
  }

  function removePdf(id) {
    if (typeof id !== 'string' || !/^job_[a-f0-9]{24}$/.test(id)) return;
    removeStoredFile(`${id}.pdf`);
  }

  function readPdf(id) {
    const file = path.join(dir, `${id}.pdf`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  }

  function ready() {
    sweep();
    const found = [];
    for (const job of jobs.values()) {
      if (job.status === 'succeeded' && fs.existsSync(path.join(dir, `${job.id}.pdf`))) found.push(job);
    }
    found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return found;
  }

  return { create, get, savePdf, removePdf, readPdf, persist, ready, sweep, sweepStartup, close, dir, hashCredential };
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') logCleanupFailure(err);
  }
}

function ensureJobDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (!err || err.code !== 'EACCES') throw err;
    console.error(`Job PDF directory is not writable (${err.code})`);
  }
}

function logCleanupFailure(err) {
  const code = err && err.code ? err.code : 'unknown';
  console.error(`Job PDF cleanup failed (${code})`);
}

function defaultDirectory(env) {
  const configured = env && env.SUPPORT_DATA_DIR && String(env.SUPPORT_DATA_DIR).trim();
  const root = configured
    ? path.join(configured, 'jobs')
    : path.join(os.tmpdir(), 'manualos-jobs');
  // Test files share a machine and run in parallel. A private folder keeps one
  // process's startup sweep from deleting another process's live PDFs.
  if (String(env && env.NODE_ENV || '').toLowerCase() === 'test') {
    const parent = path.join(os.tmpdir(), 'manualos-jobs');
    fs.mkdirSync(parent, { recursive: true });
    const dir = fs.mkdtempSync(path.join(parent, 't-'));
    ephemeralDirectories.add(dir);
    return dir;
  }
  return root;
}

function removeTestJobDirectories() {
  for (const dir of ephemeralDirectories) fs.rmSync(dir, { recursive: true, force: true });
  ephemeralDirectories.clear();
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    warnings: job.warnings,
    coverage: job.coverage,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
  };
}

module.exports = {
  createJobStore,
  publicJob,
  CLEANUP_INTERVAL_MS,
  ORPHAN_GRACE_MS,
  removeTestJobDirectories,
};
