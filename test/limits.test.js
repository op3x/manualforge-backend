const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JOB_TTL_CAP_MS, limits } = require('../lib/limits');
const { createJobStore } = require('../lib/jobs/store');

test('MANUALOS_JOB_TTL_MS above 7 days or invalid clamps to 24 hours', () => {
  assert.equal(JOB_TTL_CAP_MS, 86400000);
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  let store;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-ttl-'));
  const started = Date.parse('2026-06-01T00:00:00.000Z');
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  try {
    assert.equal(limits({}).jobTtlMs, JOB_TTL_CAP_MS);
    assert.equal(limits({ MANUALOS_JOB_TTL_MS: '3600000' }).jobTtlMs, 3600000);
    assert.equal(lines.length, 0);

    const env = {
      MANUALOS_JOB_TTL_MS: String(sevenDays),
      STRIPE_SECRET_KEY: 'sk_test_should_not_appear',
      PORTAL_TOKEN_SECRET: 'portal-secret-should-not-appear',
    };
    assert.equal(limits(env).jobTtlMs, 86400000);
    assert.equal(limits({ MANUALOS_JOB_TTL_MS: 'not-a-number' }).jobTtlMs, 86400000);
    assert.equal(limits({ MANUALOS_JOB_TTL_MS: '0' }).jobTtlMs, 86400000);
    assert.equal(limits({ MANUALOS_JOB_TTL_MS: '-5' }).jobTtlMs, 86400000);
    assert.equal(limits({ MANUALOS_JOB_TTL_MS: String(86400000 + 1) }).jobTtlMs, 86400000);

    store = createJobStore({
      directory: dir,
      env: { NODE_ENV: 'test', MANUALOS_JOB_TTL_MS: String(sevenDays) },
      now: () => started,
      setInterval: () => ({ unref() {} }),
      clearInterval: () => {},
    });
    const job = store.create({ sessionId: 'cs_ttl_cap' });
    assert.equal(Date.parse(job.expiresAt) - Date.parse(job.createdAt), 86400000);
  } finally {
    console.warn = original;
    if (store) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /MANUALOS_JOB_TTL_MS was clamped to 24 hours\./);
  assert.equal(lines[0].includes(String(sevenDays)), false);
  assert.equal(lines[0].includes('sk_test_should_not_appear'), false);
  assert.equal(lines[0].includes('portal-secret-should-not-appear'), false);
  assert.equal(lines[0].includes('not-a-number'), false);
});
