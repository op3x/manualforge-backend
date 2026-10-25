const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { limits } = require('../limits');

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
      if (!err || err.code !== 'ENOENT') logCleanupFailure(err);
    }
  }

  function ownsFile(id, name) {
    return name === `${id}.pdf` || name === `${id}.zip` || name.startsWith(`${id}--`);
  }

  function removeJobArtifacts(id) {
    eachFile((name) => {
      if (ownsFile(id, name)) removeStoredFile(name);
    });
  }

  function sweep() {
    const cutoff = now();
    for (const [id, job] of jobs) {
      if (expiresMs(job) <= cutoff) {
        jobs.delete(id);
        removeJobArtifacts(id);
      }
    }
  }

  // Delete files older than the 24-hour TTL. Orphan PDFs are deleted only after a
  // one-hour grace period so a new process does not remove PDFs a deploy that is
  // still running may be serving.
  function sweepStartup() {
    const at = now();
    const agedBefore = at - ttlMs;
    const graceBefore = at - ORPHAN_GRACE_MS;
    const liveIds = [];
    for (const [id, job] of jobs) {
      if (expiresMs(job) > at) liveIds.push(id);
    }
    eachFile((name) => {
      const stamped = mtimeMs(name);
      if (stamped == null) return;
      const olderThanTtl = stamped <= agedBefore;
      const managed = /\.(pdf|zip)$/i.test(String(name));
      const live = liveIds.some((id) => ownsFile(id, name));
      const orphanPastGrace = managed && !live && stamped <= graceBefore;
      if (olderThanTtl || orphanPastGrace) removeStoredFile(name);
    });
  }

  // Mtime only. A PDF older than the TTL is removed even if the map still has the job,
  // and a young PDF is kept even if the map has never heard of it.
  function deleteAgedPdfs() {
    const agedBefore = now() - ttlMs;
    eachFile((name) => {
      if (!/\.(pdf|zip)$/i.test(String(name))) return;
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

  function artifactName(id, key) {
    if (key === 'manual') return `${id}.pdf`;
    if (key === 'zip') return `${id}.zip`;
    if (key === 'combined') return `${id}--combined.pdf`;
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(String(key || ''))) {
      const err = new Error('Invalid document id');
      err.status = 400;
      err.expose = true;
      throw err;
    }
    return `${id}--${key}.pdf`;
  }

  function savePdf(id, buffer) {
    saveArtifact(id, 'manual', buffer);
  }

  function readPdf(id) {
    return readArtifact(id, 'manual');
  }

  function saveArtifact(id, key, buffer) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, artifactName(id, key)), buffer);
  }

  function readArtifact(id, key) {
    const file = path.join(dir, artifactName(id, key));
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  }

  return { create, get, savePdf, readPdf, saveArtifact, readArtifact, sweep, sweepStartup, close, dir };
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

function publicJob(job) {
  const documents = Array.isArray(job.documents) ? job.documents.map((doc) => {
    const ready = doc.status === 'ready';
    const row = {
      id: doc.id,
      title: doc.title,
      kind: doc.kind,
      status: doc.status,
      download_url: ready ? `/jobs/${job.id}/documents/${doc.id}` : null,
    };
    if (doc.reason) row.reason = doc.reason;
    return row;
  }) : [];
  const ready = job.status === 'succeeded' && documents.some((doc) => doc.status === 'ready');
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error,
    warnings: job.warnings,
    coverage: job.coverage,
    documents,
    downloads: {
      combined_pdf: ready ? `/jobs/${job.id}/combined.pdf` : null,
      zip: ready ? `/jobs/${job.id}/documents.zip` : null,
    },
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
