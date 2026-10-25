const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { limits } = require('../limits');

function createJobStore({ env = process.env, now = () => Date.now(), directory } = {}) {
  const ttlMs = limits(env).jobTtlMs;
  const dir = directory || path.join(os.tmpdir(), 'manualos-jobs');
  fs.mkdirSync(dir, { recursive: true });
  const jobs = new Map();

  function sweep() {
    const cutoff = now();
    for (const [id, job] of jobs) {
      if (job.expiresAt <= cutoff) {
        jobs.delete(id);
        fs.rmSync(path.join(dir, `${id}.pdf`), { force: true });
      }
    }
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

  return { create, get, savePdf, readPdf, sweep, dir };
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

module.exports = { createJobStore, publicJob };
