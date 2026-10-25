const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { limits } = require('../limits');
const { atomicWriteFile } = require('../atomic-write');

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const INDEX_NAME = 'jobs.json';
const KEPT_FILES = new Set([INDEX_NAME, 'return-link-sent.json']);
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
      if (KEPT_FILES.has(entry.name)) continue;
      fn(entry.name);
    }
  }

  function persist() {
    try {
      atomicWriteFile(path.join(dir, INDEX_NAME), JSON.stringify({ jobs: [...jobs.values()] }));
    } catch (err) {
      const code = err && err.code ? err.code : 'unknown';
      console.error(`Job store write failed (${code})`);
    }
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, INDEX_NAME), 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error(`Job store read failed (${err.code || 'unknown'})`);
      }
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      const list = parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
      for (const job of list) {
        if (!job || typeof job.id !== 'string' || !job.id) continue;
        jobs.set(job.id, job);
      }
    } catch {
      console.error('Job store read failed (invalid)');
    }
  }

  function recoverInterrupted() {
    let changed = false;
    for (const job of jobs.values()) {
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.error = 'Manual generation was interrupted. Please try again.';
        const percent = job.progress && typeof job.progress.percent === 'number' ? job.progress.percent : 0;
        job.progress = { stage: 'failed', percent, message: job.error };
        if (job.credit && job.credit.paymentIntentId && job.credit.token) job.needsCreditRefund = true;
        changed = true;
      }
    }
    if (changed) persist();
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

  function sweep() {
    const cutoff = now();
    let changed = false;
    for (const [id, job] of jobs) {
      if (job && job.needsCreditRefund) continue;
      if (expiresMs(job) <= cutoff) {
        jobs.delete(id);
        removeStoredFile(`${id}.pdf`);
        changed = true;
      }
    }
    if (changed) persist();
  }

  // Delete files older than the 24-hour TTL. Orphan PDFs are deleted only after a
  // one-hour grace period so a new process does not remove PDFs a deploy that is
  // still running may be serving.
  function sweepStartup() {
    const at = now();
    const agedBefore = at - ttlMs;
    const graceBefore = at - ORPHAN_GRACE_MS;
    const live = new Set();
    for (const [id, job] of jobs) {
      if (expiresMs(job) > at) live.add(`${id}.pdf`);
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
    load();
    recoverInterrupted();
  } catch (err) {
    const code = err && err.code ? err.code : 'unknown';
    console.error(`Job store read failed (${code})`);
  }

  try {
    sweepStartup();
  } catch (err) {
    logCleanupFailure(err);
  }

  const timer = schedule(onInterval, CLEANUP_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  function close() {
    if (timer) cancel(timer);
  }

  function create(extra = {}) {
    sweep();
    const id = usableJobId(extra.id) ? extra.id : newJobId();
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
      id,
    };
    jobs.set(id, job);
    persist();
    return job;
  }

  function commit(job) {
    if (!job || typeof job.id !== 'string' || !job.id) return null;
    jobs.set(job.id, job);
    persist();
    return job;
  }

  function get(id) {
    sweep();
    return jobs.get(id) || null;
  }

  function pdfReady(id) {
    return fs.existsSync(path.join(dir, `${id}.pdf`));
  }

  function listForSession(sessionId) {
    sweep();
    if (!sessionId) return [];
    const cutoff = now() - ttlMs;
    const rows = [];
    for (const job of jobs.values()) {
      if (job.sessionId !== sessionId) continue;
      const created = Date.parse(job.createdAt);
      if (!Number.isFinite(created) || created < cutoff) continue;
      rows.push({
        id: job.id,
        status: job.status,
        created_at: job.createdAt,
        filename: job.filename || null,
        pdf_available: job.status === 'succeeded' && pdfReady(job.id),
      });
    }
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return rows;
  }

  function refundsDue() {
    const due = [];
    for (const job of jobs.values()) {
      if (job.needsCreditRefund && job.credit && job.credit.paymentIntentId && job.credit.token) due.push(job);
    }
    return due;
  }

  function markCreditRefunded(job) {
    if (!job) return;
    job.needsCreditRefund = false;
    job.credit = null;
    if (job.id && jobs.has(job.id)) jobs.set(job.id, job);
    persist();
  }

  function savePdf(id, buffer) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.pdf`), buffer);
  }

  function readPdf(id) {
    const file = path.join(dir, `${id}.pdf`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  }

  return {
    create,
    commit,
    get,
    listForSession,
    refundsDue,
    markCreditRefunded,
    savePdf,
    readPdf,
    sweep,
    sweepStartup,
    close,
    dir,
  };
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
  const configured = String((env && env.DATA_DIR) || '').trim();
  if (configured) return path.resolve(configured);
  const root = path.join(os.tmpdir(), 'manualos-jobs');
  // Test files share a machine and run in parallel. A private folder keeps one
  // process's startup sweep from deleting another process's live PDFs.
  if (String(env && env.NODE_ENV || '').toLowerCase() === 'test') {
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, 't-'));
    ephemeralDirectories.add(dir);
    return dir;
  }
  return root;
}

function removeTestJobDirectories() {
  for (const dir of ephemeralDirectories) fs.rmSync(dir, { recursive: true, force: true });
  ephemeralDirectories.clear();
}

function newJobId() {
  return `job_${crypto.randomBytes(12).toString('hex')}`;
}

function usableJobId(id) {
  return typeof id === 'string' && /^job_[0-9a-f]{24}$/.test(id);
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
  newJobId,
  publicJob,
  CLEANUP_INTERVAL_MS,
  ORPHAN_GRACE_MS,
  INDEX_NAME,
  removeTestJobDirectories,
};
