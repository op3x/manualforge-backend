const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JOB_TTL_CAP_MS, limits } = require('../lib/limits');
const { createJobStore } = require('../lib/jobs/store');

test('MANUALOS_JOB_TTL_MS cannot extend job retention past 24 hours', () => {
  assert.equal(JOB_TTL_CAP_MS, 24 * 60 * 60 * 1000);
  assert.equal(limits({}).jobTtlMs, JOB_TTL_CAP_MS);
  assert.equal(limits({ MANUALOS_JOB_TTL_MS: String(60 * 60 * 1000) }).jobTtlMs, 60 * 60 * 1000);
  assert.equal(limits({ MANUALOS_JOB_TTL_MS: 'not-a-number' }).jobTtlMs, JOB_TTL_CAP_MS);

  const lines = [];
  const original = console.warn;
  console.warn = (message) => lines.push(String(message));
  let store;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-ttl-'));
  const started = Date.parse('2026-06-01T00:00:00.000Z');
  try {
    const over = limits({ MANUALOS_JOB_TTL_MS: String(JOB_TTL_CAP_MS * 28) });
    assert.equal(over.jobTtlMs, JOB_TTL_CAP_MS);
    assert.equal(limits({ MANUALOS_JOB_TTL_MS: String(JOB_TTL_CAP_MS + 1) }).jobTtlMs, JOB_TTL_CAP_MS);
    store = createJobStore({
      directory: dir,
      env: { NODE_ENV: 'test', MANUALOS_JOB_TTL_MS: String(JOB_TTL_CAP_MS * 28) },
      now: () => started,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    });
    const job = store.create({ sessionId: 'cs_ttl_cap' });
    assert.equal(Date.parse(job.expiresAt) - Date.parse(job.createdAt), JOB_TTL_CAP_MS);
  } finally {
    console.warn = original;
    if (store) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /MANUALOS_JOB_TTL_MS is above 24 hours and was clamped to 24 hours\./);
  assert.equal(lines[0].includes(String(JOB_TTL_CAP_MS * 28)), false);
});
