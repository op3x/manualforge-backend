const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { limits } = require('../limits');

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

function createJobStore({
  env = process.env,
  now = () => Date.now(),
  directory,
  setInterval: schedule = setInterval,
  clearInterval: cancel = clearInterval,
} = {}) {
  const ttlMs = limits(env).jobTtlMs;
  const dir = directory || defaultDirectory(env);
  fs.mkdirSync(dir, { recursive: true });
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
      if (!err || err.code !== 'ENOENT') console.error('Job PDF cleanup failed');
    }
  }

  function sweep() {
    const cutoff = now();
    for (const [id, job] of jobs) {
      if (expiresMs(job) <= cutoff) {
        jobs.delete(id);
        removeStoredFile(`${id}.pdf`);
      }
    }
  }

  // Drop files older than the TTL by mtime, and drop anything the in-memory map
  // does not reference. After a restart the map is empty, so every file here goes.
  function sweepStartup() {
    const at = now();
    const agedBefore = at - ttlMs;
    const live = new Set();
    for (const [id, job] of jobs) {
      if (expiresMs(job) > at) live.add(`${id}.pdf`);
    }
    eachFile((name) => {
      const stamped = mtimeMs(name);
      if (stamped == null) return;
      const aged = stamped <= agedBefore;
      const unreferenced = !live.has(name);
      if (aged || unreferenced) removeStoredFile(name);
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
    } catch {
      console.error('Job PDF cleanup failed');
    }
  }

  try {
    sweepStartup();
  } catch {
    console.error('Job PDF cleanup failed');
  }

  const timer = schedule(onInterval, CLEANUP_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  function close() {
    if (timer) cancel(timer);
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
    return job;
  }

  function get(id) {
    sweep();
    return jobs.get(id) || null;
  }

  function savePdf(id, buffer) {
    fs.writeFileSync(path.join(dir, `${id}.pdf`), buffer);
  }

  function readPdf(id) {
    const file = path.join(dir, `${id}.pdf`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  }

  return { create, get, savePdf, readPdf, sweep, sweepStartup, close, dir };
}

function defaultDirectory(env) {
  const root = path.join(os.tmpdir(), 'manualos-jobs');
  // Test files share a machine and run in parallel. A private folder keeps one
  // process's startup sweep from deleting another process's live PDFs.
  if (String(env && env.NODE_ENV || '').toLowerCase() === 'test') {
    fs.mkdirSync(root, { recursive: true });
    return fs.mkdtempSync(path.join(root, 't-'));
  }
  return root;
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

module.exports = { createJobStore, publicJob, CLEANUP_INTERVAL_MS };
