const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { assertSessionId } = require('../lib/session-id');
const {
  MAX_UNKNOWN_EVENT_BYTES,
  MAX_UNKNOWN_EVENT_LINES,
  countUnknownEvents,
  recordUnknownEvent,
} = require('../lib/unknown-events');

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-unknown-'));
  return {
    dir,
    env: {
      NODE_ENV: 'test',
      FRONTEND_URL: 'https://manualos.com',
      STRIPE_PRICE_STARTER: 'price_starter',
      STRIPE_PRICE_PRO: 'price_pro',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      PORTAL_TOKEN_SECRET: 'test-portal-token-secret-32bytes-min',
      DATA_DIR: dir,
    },
  };
}

function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

function linesOf(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
}

test('unknown-events.jsonl is mode 0600, capped, and /health does not reread it', async () => {
  const { dir, env } = tempEnv();
  const file = path.join(dir, 'unknown-events.jsonl');
  try {
    recordUnknownEvent(env, { eventId: 'evt_one', type: 'charge.refunded', objectId: 'ch_one' });
    assert.equal(modeOf(file), 0o600);
    fs.chmodSync(file, 0o644);
    assert.equal(modeOf(file), 0o644);
    recordUnknownEvent(env, { eventId: 'evt_two', type: 'invoice.paid', objectId: 'in_two' });
    assert.equal(modeOf(file), 0o600);
    assert.equal(countUnknownEvents(env), 2);

    const app = createApp({ env, stripe: null, anthropic: null });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const first = await fetch(`${base}/health`);
      assert.equal((await first.json()).unknownEvents, 2);
      fs.appendFileSync(file, `${JSON.stringify({ eventId: 'evt_extra' })}\n`);
      const second = await fetch(`${base}/health`);
      assert.equal((await second.json()).unknownEvents, 2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown-events.jsonl keeps the last 10k lines and stays within 5 MB', () => {
  const lineCap = tempEnv();
  const lineFile = path.join(lineCap.dir, 'unknown-events.jsonl');
  try {
    const seeded = [];
    for (let i = 0; i < MAX_UNKNOWN_EVENT_LINES; i += 1) {
      seeded.push(JSON.stringify({ eventId: `evt_seed_${i}`, type: 'charge.refunded', objectId: 'ch_seed' }));
    }
    fs.writeFileSync(lineFile, `${seeded.join('\n')}\n`, { mode: 0o644 });
    recordUnknownEvent(lineCap.env, { eventId: 'evt_newest', type: 'invoice.paid', objectId: 'in_newest' });
    const kept = linesOf(lineFile);
    assert.equal(kept.length, MAX_UNKNOWN_EVENT_LINES);
    assert.equal(kept.some((line) => line.includes('evt_seed_0')), false);
    assert.equal(kept[kept.length - 1].includes('evt_newest'), true);
    assert.equal(countUnknownEvents(lineCap.env), MAX_UNKNOWN_EVENT_LINES);
    assert.equal(modeOf(lineFile), 0o600);
    fs.appendFileSync(lineFile, `${JSON.stringify({ eventId: 'evt_not_counted' })}\n`);
    assert.equal(countUnknownEvents(lineCap.env), MAX_UNKNOWN_EVENT_LINES);
  } finally {
    fs.rmSync(lineCap.dir, { recursive: true, force: true });
  }

  const byteCap = tempEnv();
  const byteFile = path.join(byteCap.dir, 'unknown-events.jsonl');
  try {
    const chunk = 'x'.repeat(1024 * 1024);
    const seeded = [];
    for (let i = 0; i < 6; i += 1) {
      seeded.push(JSON.stringify({ eventId: `evt_big_${i}`, type: 'charge.refunded', objectId: chunk }));
    }
    fs.writeFileSync(byteFile, `${seeded.join('\n')}\n`, { mode: 0o644 });
    assert.ok(fs.statSync(byteFile).size > MAX_UNKNOWN_EVENT_BYTES);
    recordUnknownEvent(byteCap.env, { eventId: 'evt_tail', type: 'invoice.paid', objectId: 'in_tail' });
    const kept = linesOf(byteFile);
    assert.ok(fs.statSync(byteFile).size <= MAX_UNKNOWN_EVENT_BYTES);
    assert.equal(kept.some((line) => line.includes('evt_big_0')), false);
    assert.equal(kept[kept.length - 1].includes('evt_tail'), true);
    assert.equal(countUnknownEvents(byteCap.env), kept.length);
    assert.equal(modeOf(byteFile), 0o600);
  } finally {
    fs.rmSync(byteCap.dir, { recursive: true, force: true });
  }
});

test('an invalid session id log keeps only the last four alphanumeric characters', () => {
  assert.throws(
    () => assertSessionId('pre!\nfixWXYZ'),
    (err) => {
      assert.equal(err.logMessage, 'Rejected session id (...WXYZ)');
      assert.equal(err.logMessage.includes('\n'), false);
      assert.equal(err.logMessage.includes('!'), false);
      assert.equal(err.logMessage.includes('prefix'), false);
      return true;
    },
  );
  assert.throws(
    () => assertSessionId('a.b'),
    (err) => err.logMessage === 'Rejected session id (...****)',
  );
  assert.throws(
    () => assertSessionId('cs_made_up'),
    (err) => err.logMessage === 'Rejected session id (...deup)',
  );
});
