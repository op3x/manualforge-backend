const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp, trustProxyHops } = require('../server');
const { createRateLimiter } = require('../lib/rate-limit');
const { createJobStore, INDEX_NAME, removeTestJobDirectories } = require('../lib/jobs/store');
const { createSmtpMailer } = require('../lib/mail');
const {
  GRACE_MS,
  accessFromSession,
  assertCanGenerate,
  pastDueWithinGrace,
  publicAccess,
} = require('../lib/billing');
const { SENT_FILE, twelveMonthsAgoSeconds } = require('../lib/return-link');

test.after(() => {
  removeTestJobDirectories();
});

const SECRET = 'SUPER_SECRET_SMTP_PASS';
const STRIPE_SECRET = 'SUPER_SECRET_STRIPE_BODY';
const PERIOD_START = 1_700_000_000;
const START_MS = PERIOD_START * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function env(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
    SMTP_PASS: SECRET,
    ...extra,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-post-'));
}

function notFound() {
  const err = new Error('missing');
  err.statusCode = 404;
  err.code = 'resource_missing';
  return err;
}

function signedStripe(extra = {}) {
  return {
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') {
          throw new Error('SUPER_SECRET_SIGNATURE_DETAIL');
        }
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
    ...extra,
  };
}

async function withServer(app, fn) {
  if (app.ready) await app.ready;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function captureConsole(fn) {
  const lines = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  const saved = {};
  for (const method of methods) {
    saved[method] = console[method];
    console[method] = (...args) => {
      lines.push(args.map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.stack || arg.message;
        try { return JSON.stringify(arg); } catch { return String(arg); }
      }).join(' '));
    };
  }
  const restore = () => {
    for (const method of methods) console[method] = saved[method];
  };
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      restore();
      return { lines, value };
    }, (err) => {
      restore();
      throw err;
    });
}

function postJson(base, route, body, headers = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function completedEvent(session, id = 'evt_1') {
  return {
    id,
    type: 'checkout.session.completed',
    data: { object: session },
  };
}

async function postWebhook(base, event) {
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
    body: JSON.stringify(event),
  });
}

function starterSession(id, email) {
  return {
    id,
    payment_status: 'paid',
    metadata: { plan: 'starter' },
    customer_details: email ? { email } : undefined,
  };
}

function proSession(id, email) {
  return {
    id,
    payment_status: 'paid',
    metadata: { plan: 'pro' },
    customer_details: email ? { email } : undefined,
  };
}

function assertNoSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(STRIPE_SECRET), false);
  assert.equal(text.includes('SUPER_SECRET_SIGNATURE_DETAIL'), false);
}

function assertCleanMail(message) {
  const body = `${message.text}\n${message.html}`;
  assert.equal(message.subject, 'Your ManualOS upload link');
  assert.equal(message.from, 'support@manualos.com');
  assert.match(message.text, /^Your upload link/);
  assert.match(message.html, /<p>Your upload link/);
  assert.match(message.html, /<a href="/);
  assert.equal(/stripe|anthropic|claude|railway|twilio|nodemailer|starter|pro\b/i.test(body), false);
  assertNoSecrets(body);
}

test('past_due grace follows the failed invoice period start', () => {
  const inside = {
    status: 'past_due',
    latest_invoice: { period_start: PERIOD_START },
    current_period_start: PERIOD_START - 30 * 24 * 60 * 60,
  };
  assert.equal(pastDueWithinGrace(inside, START_MS), true);
  assert.equal(pastDueWithinGrace(inside, START_MS + GRACE_MS - 1), true);
  assert.equal(pastDueWithinGrace(inside, START_MS + GRACE_MS), false);
  assert.equal(pastDueWithinGrace({ status: 'past_due' }, START_MS), false);
  assert.equal(pastDueWithinGrace({ status: 'active', latest_invoice: { period_start: PERIOD_START } }, START_MS), false);

  const lineOnly = {
    status: 'past_due',
    latest_invoice: { lines: { data: [{ period: { start: PERIOD_START } }] } },
  };
  assert.equal(pastDueWithinGrace(lineOnly, START_MS + 1000), true);

  const currentOnly = { status: 'past_due', current_period_start: PERIOD_START };
  assert.equal(pastDueWithinGrace(currentOnly, START_MS + GRACE_MS - 1), true);

  const invoiceWins = {
    status: 'past_due',
    current_period_start: PERIOD_START,
    latest_invoice: { period_start: PERIOD_START - 8 * 24 * 60 * 60 },
  };
  assert.equal(pastDueWithinGrace(invoiceWins, START_MS), false);

  const envNow = { FRONTEND_URL: 'https://manualos.com', STARTER_CREDITS: '3' };
  for (const status of ['unpaid', 'canceled', 'incomplete_expired']) {
    const access = accessFromSession(
      { metadata: { plan: 'pro' }, payment_status: 'paid' },
      null,
      { id: 'sub', status, latest_invoice: { period_start: PERIOD_START } },
      envNow,
      START_MS
    );
    assert.equal(access.valid, false, status);
    assert.equal(access.paymentIssue, false, status);
    assert.equal(access.portal, status === 'canceled', status);
    assert.equal(access.reason, status === 'canceled' ? 'canceled' : null, status);
    assert.equal(Object.hasOwn(publicAccess(access), 'payment_issue'), false);
  }

  const open = accessFromSession(
    { metadata: { plan: 'pro' }, payment_status: 'paid' },
    null,
    inside,
    envNow,
    START_MS + GRACE_MS - 1
  );
  assert.equal(open.valid, true);
  assert.deepEqual(publicAccess(open), {
    valid: true,
    access: true,
    plan: 'pro',
    remaining: null,
    portal: true,
    payment_issue: true,
    reason: 'payment_failed',
  });

  const closed = accessFromSession(
    { metadata: { plan: 'pro' }, payment_status: 'paid' },
    null,
    inside,
    envNow,
    START_MS + GRACE_MS
  );
  assert.equal(closed.valid, false);
  assert.deepEqual(publicAccess(closed), {
    valid: false,
    access: false,
    plan: 'pro',
    remaining: null,
    portal: true,
    payment_issue: true,
    reason: 'payment_failed',
  });

  const active = accessFromSession(
    { metadata: { plan: 'pro' } },
    null,
    { status: 'active' },
    envNow,
    START_MS
  );
  assert.deepEqual(publicAccess(active), { valid: true, access: true, plan: 'pro', remaining: null, portal: true });
});

test('past_due inside the grace window can generate and verify-session reports payment_issue', async () => {
  const clock = () => START_MS + 1000;
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          if (id === 'cs_late') {
            return {
              id,
              metadata: { plan: 'pro' },
              payment_status: 'paid',
              payment_intent: null,
              subscription: {
                status: 'past_due',
                latest_invoice: { period_start: Math.floor((START_MS - GRACE_MS) / 1000) },
              },
            };
          }
          return {
            id,
            metadata: { plan: 'pro' },
            payment_status: 'paid',
            payment_intent: null,
            subscription: { status: 'past_due', latest_invoice: { period_start: PERIOD_START } },
          };
        },
      },
    },
  };
  await assertCanGenerate(stripe, 'cs_open', env(), clock());
  await assert.rejects(() => assertCanGenerate(stripe, 'cs_late', env(), clock()), (err) => err.status === 402);

  const subs = {
    sub_inside: { id: 'sub_inside', status: 'past_due', latest_invoice: { period_start: PERIOD_START } },
    sub_outside: { id: 'sub_outside', status: 'past_due', latest_invoice: { period_start: PERIOD_START - 8 * 24 * 60 * 60 } },
    sub_unpaid: { id: 'sub_unpaid', status: 'unpaid', latest_invoice: { period_start: PERIOD_START } },
    sub_canceled: { id: 'sub_canceled', status: 'canceled', latest_invoice: { period_start: PERIOD_START } },
    sub_expired: { id: 'sub_expired', status: 'incomplete_expired', latest_invoice: { period_start: PERIOD_START } },
    sub_active: { id: 'sub_active', status: 'active' },
  };
  const httpStripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          const subId = id.replace(/^cs_/, '');
          if (!subs[subId]) throw notFound();
          return {
            id,
            metadata: { plan: 'pro' },
            payment_status: 'paid',
            payment_intent: null,
            subscription: subId,
            customer: 'cus_pro',
          };
        },
      },
    },
    subscriptions: { retrieve: async (id) => subs[id] },
  };
  const app = createApp({ env: env(), stripe: httpStripe, anthropic: null, now: clock, mailer: null });
  await withServer(app, async (base) => {
    const inside = await fetch(`${base}/verify-session?session_id=cs_sub_inside`);
    assert.deepEqual(await inside.json(), {
      valid: true,
      access: true,
      plan: 'pro',
      remaining: null,
      portal: true,
      payment_issue: true,
      reason: 'payment_failed',
    });
    const outside = await fetch(`${base}/verify-session?session_id=cs_sub_outside`);
    assert.deepEqual(await outside.json(), {
      valid: false,
      access: false,
      plan: 'pro',
      remaining: null,
      portal: true,
      payment_issue: true,
      reason: 'payment_failed',
    });
    const canceled = await fetch(`${base}/verify-session?session_id=cs_sub_canceled`);
    assert.deepEqual(await canceled.json(), {
      valid: false,
      access: false,
      plan: 'pro',
      remaining: null,
      portal: true,
      reason: 'canceled',
    });
    for (const id of ['cs_sub_unpaid', 'cs_sub_expired']) {
      const res = await fetch(`${base}/verify-session?session_id=${id}`);
      assert.deepEqual(await res.json(), { valid: false, access: false, plan: 'pro', remaining: null, portal: false });
    }
    const active = await fetch(`${base}/verify-session?session_id=cs_sub_active`);
    assert.deepEqual(await active.json(), { valid: true, access: true, plan: 'pro', remaining: null, portal: true });

    const stillBlocked = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_sub_outside', plcContent: 'x' }),
    });
    assert.equal(stillBlocked.status, 402);
    const canceledBlocked = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_sub_canceled', plcContent: 'x' }),
    });
    assert.equal(canceledBlocked.status, 402);
    assert.equal(inside.headers.get('referrer-policy'), 'no-referrer');
  });
});

test('checkout completion emails the upload link once and never fails the webhook', async () => {
  const accountDir = tempDir();
  const dataDir = tempDir();
  const sent = [];
  const mailer = {
    async sendMail(message) {
      sent.push(message);
    },
  };
  const app = createApp({
    env: env({ DATA_DIR: dataDir, MANUALOS_ACCOUNT_DIR: accountDir }),
    stripe: signedStripe(),
    anthropic: null,
    mailer,
  });
  try {
    await withServer(app, async (base) => {
      const starter = starterSession('cs_link_1', 'buyer@example.com');
      const first = await postWebhook(base, completedEvent(starter, 'evt_a'));
      const second = await postWebhook(base, completedEvent(starter, 'evt_b'));
      const parallel = await Promise.all([
        postWebhook(base, completedEvent(starter, 'evt_c')),
        postWebhook(base, completedEvent(starter, 'evt_d')),
      ]);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { received: true });
      assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(second.status, 200);
      assert.equal(parallel[0].status, 200);
      assert.equal(parallel[1].status, 200);
      await app.settle();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, 'buyer@example.com');
      assert.equal(sent[0].text.includes('https://manualos.com/upload.html?session_id=cs_link_1'), true);
      assert.equal(sent[0].html.includes('https://manualos.com/upload.html?session_id=cs_link_1'), true);
      assertCleanMail(sent[0]);

      const pro = await postWebhook(base, completedEvent(proSession('cs_link_2', 'owner@example.com'), 'evt_pro'));
      assert.equal(pro.status, 200);
      await app.settle();
      assert.equal(sent.length, 2);
      assert.equal(sent[1].to, 'owner@example.com');
      assertCleanMail(sent[1]);

      const failing = createApp({
        env: env(),
        stripe: signedStripe(),
        anthropic: null,
        mailer: {
          async sendMail() {
            const err = new Error(`mailbox rejected ${SECRET}`);
            err.code = 'EAUTH';
            throw err;
          },
        },
      });
      const captured = await captureConsole(() => withServer(failing, async (failBase) => {
        const res = await postWebhook(failBase, completedEvent(starterSession('cs_fail', 'buyer@example.com'), 'evt_fail'));
        assert.equal(res.status, 200);
        const retry = await postWebhook(failBase, completedEvent(starterSession('cs_fail', 'buyer@example.com'), 'evt_fail_2'));
        assert.equal(retry.status, 200);
        await failing.settle();
        return true;
      }));
      assert.equal(captured.lines.some((line) => line.includes('return-link email failed')), true);
      assertNoSecrets(captured.lines.join('\n'));

      const quietApp = createApp({
        env: env(),
        stripe: signedStripe(),
        anthropic: null,
      });
      const quiet = await captureConsole(() => withServer(quietApp, async (quietBase) => {
        const res = await postWebhook(quietBase, completedEvent(starterSession('cs_skip', 'buyer@example.com')));
        assert.equal(res.status, 200);
        const nameless = await postWebhook(quietBase, completedEvent({
          id: 'cs_no_email',
          payment_status: 'paid',
          metadata: { plan: 'pro' },
        }, 'evt_nameless'));
        assert.equal(nameless.status, 200);
        await quietApp.settle();
      }));
      assert.equal(quiet.lines.includes('return-link email skipped: SMTP not configured'), true);
      assert.equal(quiet.lines.includes('return-link email skipped: checkout session has no email'), true);
      assertNoSecrets(quiet.lines.join('\n'));
    });
    const sentFile = JSON.parse(fs.readFileSync(path.join(accountDir, SENT_FILE), 'utf8'));
    assert.equal(sentFile.sessions.cs_link_1 > 0, true);
    assert.equal(sentFile.sessions.cs_link_2 > 0, true);
    assert.equal(fs.existsSync(path.join(dataDir, SENT_FILE)), false);
    assertNoSecrets(JSON.stringify(sentFile));
  } finally {
    fs.rmSync(accountDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('access-link is enumeration-safe, rate limited, and emails sessions that can open the portal', async () => {
  const fixed = Date.UTC(2026, 9, 25, 15, 0, 0);
  const recent = Math.floor((fixed - HOUR_MS) / 1000);
  const sessions = [
    {
      id: 'cs_live_1',
      metadata: { plan: 'starter' },
      payment_status: 'paid',
      status: 'complete',
      customer_details: { email: 'buyer@example.com' },
      payment_intent: { id: 'pi_live', metadata: { manuals_used: '1' } },
      subscription: null,
    },
    {
      id: 'cs_grace_1',
      metadata: { plan: 'pro' },
      payment_status: 'paid',
      status: 'complete',
      customer: 'cus_grace',
      customer_details: { email: 'buyer@example.com' },
      payment_intent: null,
      subscription: 'sub_grace',
    },
    {
      id: 'cs_old_1',
      metadata: { plan: 'pro' },
      payment_status: 'paid',
      status: 'complete',
      customer: 'cus_old',
      customer_details: { email: 'buyer@example.com' },
      payment_intent: null,
      subscription: 'sub_canceled',
    },
    {
      id: 'cs_late_1',
      metadata: { plan: 'pro' },
      payment_status: 'paid',
      status: 'complete',
      customer: 'cus_late',
      customer_details: { email: 'buyer@example.com' },
      payment_intent: null,
      subscription: 'sub_late',
    },
    {
      id: 'cs_unpaid',
      metadata: { plan: 'starter' },
      payment_status: 'unpaid',
      status: 'complete',
      customer_details: { email: 'buyer@example.com' },
      payment_intent: { id: 'pi_unpaid', metadata: { manuals_used: '0' } },
      subscription: null,
    },
  ];
  const calls = { list: [], retrieve: [] };
  const stripe = {
    checkout: {
      sessions: {
        list: async (params) => {
          calls.list.push(params);
          const email = params.customer_details && params.customer_details.email;
          const data = sessions.filter((session) => session.customer_details.email === email);
          return { data: data.slice(0, params.limit) };
        },
        retrieve: async (id) => {
          calls.retrieve.push(id);
          const session = sessions.find((item) => item.id === id);
          if (!session) throw notFound();
          return session;
        },
      },
    },
    paymentIntents: {
      retrieve: async (id) => ({ id, metadata: { manuals_used: '1' } }),
    },
    subscriptions: {
      retrieve: async (id) => {
        if (id === 'sub_grace') {
          return { id, status: 'past_due', latest_invoice: { period_start: recent } };
        }
        if (id === 'sub_late') {
          return { id, status: 'past_due', latest_invoice: { period_start: recent - (8 * 24 * 60 * 60) } };
        }
        return { id, status: 'canceled', latest_invoice: { period_start: recent } };
      },
    },
  };
  const sent = [];
  const app = createApp({
    env: env({ SMTP_FROM: 'support@manualos.com', TRUST_PROXY_HOPS: '1' }),
    stripe,
    anthropic: null,
    now: () => fixed,
    mailer: { async sendMail(message) { sent.push(message); } },
  });
  await withServer(app, async (base) => {
    const known = await postJson(base, '/access-link', { email: 'Buyer@Example.com' }, { 'X-Forwarded-For': '203.0.113.10' });
    const unknown = await postJson(base, '/access-link', { email: 'nobody@example.com' }, { 'X-Forwarded-For': '203.0.113.10' });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.deepEqual(await known.json(), { ok: true });
    assert.deepEqual(await unknown.json(), { ok: true });
    assert.equal(known.headers.get('referrer-policy'), 'no-referrer');
    await app.settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'buyer@example.com');
    assert.equal(sent[0].from, 'support@manualos.com');
    assert.equal(sent[0].text.includes('https://manualos.com/upload.html?session_id=cs_live_1'), true);
    assert.equal(sent[0].text.includes('https://manualos.com/upload.html?session_id=cs_grace_1'), true);
    assert.equal(sent[0].text.includes('https://manualos.com/upload.html?session_id=cs_old_1'), true);
    assert.equal(sent[0].text.includes('https://manualos.com/upload.html?session_id=cs_late_1'), true);
    assert.equal(sent[0].text.includes('cs_unpaid'), false);
    assert.equal(sent[0].html.includes('cs_old_1'), true);
    assertCleanMail({ ...sent[0], text: sent[0].text.replace('links', 'link') });
    assert.match(sent[0].text, /Your upload links:/);
    assert.deepEqual(calls.list[0], {
      limit: 10,
      status: 'complete',
      customer_details: { email: 'buyer@example.com' },
      created: { gte: twelveMonthsAgoSeconds(fixed) },
    });
    assert.deepEqual(calls.list[1].customer_details, { email: 'nobody@example.com' });
    assert.equal(calls.retrieve.includes('cs_unpaid'), false);
    assert.equal(calls.retrieve.includes('cs_live_1'), true);
    assert.equal(calls.retrieve.includes('cs_old_1'), true);

    const invalid = await postJson(base, '/access-link', { email: 'not an email' }, { 'X-Forwarded-For': '203.0.113.10' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'A valid email is required.' });
    const injected = await postJson(base, '/access-link', { email: 'buyer@example.com\nBcc: evil@example.com' }, { 'X-Forwarded-For': '203.0.113.10' });
    assert.equal(injected.status, 400);
    const tooLong = `${'a'.repeat(243)}@example.com`;
    assert.equal(tooLong.length, 255);
    const oversized = await postJson(base, '/access-link', { email: tooLong }, { 'X-Forwarded-For': '203.0.113.10' });
    assert.equal(oversized.status, 400);
    const max = `${'a'.repeat(242)}@example.com`;
    assert.equal(max.length, 254);
    const accepted = await postJson(base, '/access-link', { email: max }, { 'X-Forwarded-For': '203.0.113.11' });
    assert.equal(accepted.status, 202);
    await app.settle();
    assert.equal(calls.list.some((params) => params.customer_details.email === max), true);
  });

  let time = fixed;
  const limited = [];
  const limitStripe = {
    checkout: {
      sessions: {
        list: async () => ({ data: [] }),
        retrieve: async () => { throw notFound(); },
      },
    },
  };
  const limitApp = createApp({
    env: env({ TRUST_PROXY_HOPS: '1' }),
    stripe: limitStripe,
    anthropic: null,
    now: () => time,
    mailer: { async sendMail() {} },
  });
  await withServer(limitApp, async (base) => {
    const emailHeaders = { 'X-Forwarded-For': '198.51.100.8, 203.0.113.10' };
    for (let i = 0; i < 3; i += 1) {
      const res = await postJson(base, '/access-link', { email: 'buyer@example.com' }, emailHeaders);
      assert.equal(res.status, 202);
    }
    const blockedEmail = await postJson(base, '/access-link', { email: 'buyer@example.com' }, emailHeaders);
    assert.equal(blockedEmail.status, 429);
    const blockedBody = await blockedEmail.json();
    assert.deepEqual(blockedBody, { error: 'Too many requests. Try again later.' });
    const stranger = await postJson(base, '/access-link', { email: 'stranger@example.com' }, { 'X-Forwarded-For': '203.0.113.12' });
    assert.equal(stranger.status, 202);
    for (let i = 0; i < 3; i += 1) {
      const res = await postJson(base, '/access-link', { email: 'nobody@example.com' }, { 'X-Forwarded-For': '203.0.113.12' });
      assert.equal(res.status, 202);
    }
    const blockedUnknown = await postJson(base, '/access-link', { email: 'nobody@example.com' }, { 'X-Forwarded-For': '203.0.113.12' });
    assert.equal(blockedUnknown.status, 429);
    assert.deepEqual(await blockedUnknown.json(), blockedBody);
    time += HOUR_MS;
    const again = await postJson(base, '/access-link', { email: 'buyer@example.com' }, emailHeaders);
    assert.equal(again.status, 202);

    for (let i = 1; i <= 10; i += 1) {
      const res = await postJson(
        base,
        '/access-link',
        { email: `person${i}@example.com` },
        { 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.50` }
      );
      assert.equal(res.status, 202);
      limited.push(res.status);
    }
    const otherIp = await postJson(
      base,
      '/access-link',
      { email: 'other-ip@example.com' },
      { 'X-Forwarded-For': '198.51.100.99, 203.0.113.51' }
    );
    assert.equal(otherIp.status, 202);
    const eleventh = await postJson(
      base,
      '/access-link',
      { email: 'eleventh@example.com' },
      { 'X-Forwarded-For': '198.51.100.100, 203.0.113.50' }
    );
    assert.equal(eleventh.status, 429);
    const body = await eleventh.json();
    assert.deepEqual(body, { error: 'Too many requests. Try again later.' });
    assert.equal(JSON.stringify(body).includes('@'), false);
  });

  const boom = createApp({
    env: env(),
    stripe: {
      checkout: {
        sessions: {
          list: async () => {
            const err = new Error(STRIPE_SECRET);
            err.code = 'api_error';
            throw err;
          },
        },
      },
    },
    anthropic: null,
    mailer: { async sendMail() { throw new Error('should not send'); } },
  });
  const captured = await captureConsole(() => withServer(boom, async (base) => {
    const res = await postJson(base, '/access-link', { email: 'buyer@example.com' }, { 'X-Forwarded-For': '203.0.113.77' });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true });
    await boom.settle();
  }));
  assertNoSecrets(captured.lines.join('\n'));
  assert.equal(captured.lines.some((line) => line.includes('return-link email failed')), true);
});

test('billing portal returns a url for paid Pro and rejects Starter or invalid sessions', async () => {
  const calls = [];
  const sessions = {
    cs_pro: {
      id: 'cs_pro',
      metadata: { plan: 'pro' },
      payment_status: 'paid',
      customer: 'cus_pro',
    },
    cs_starter: {
      id: 'cs_starter',
      metadata: { plan: 'starter' },
      payment_status: 'paid',
      customer: 'cus_starter',
    },
    cs_unpaid: {
      id: 'cs_unpaid',
      metadata: { plan: 'pro' },
      payment_status: 'unpaid',
      customer: 'cus_unpaid',
    },
    cs_nocustomer: {
      id: 'cs_nocustomer',
      metadata: { plan: 'pro' },
      payment_status: 'paid',
      customer: null,
    },
  };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          if (!sessions[id]) throw notFound();
          return sessions[id];
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          return { url: 'https://billing.example/session/portal_test' };
        },
      },
    },
  };
  const app = createApp({ env: env(), stripe, anthropic: null, mailer: null });
  await withServer(app, async (base) => {
    const missing = await postJson(base, '/billing-portal', {});
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'session_id is required');
    assert.equal(calls.length, 0);

    const starter = await postJson(base, '/billing-portal', { session_id: 'cs_starter' });
    assert.equal(starter.status, 400);
    assert.deepEqual(await starter.json(), { error: 'Billing portal is available for Pro subscriptions.' });

    const unpaid = await postJson(base, '/billing-portal', { session_id: 'cs_unpaid' });
    assert.equal(unpaid.status, 402);
    const unknown = await postJson(base, '/billing-portal', { session_id: 'cs_missing' });
    assert.equal(unknown.status, 402);
    const bare = await postJson(base, '/billing-portal', { session_id: 'cs_nocustomer' });
    assert.equal(bare.status, 402);
    assert.deepEqual(await bare.json(), { error: 'Payment required. This checkout session is not valid.' });
    assert.equal(calls.length, 0);

    const ok = await postJson(base, '/billing-portal', { session_id: 'cs_pro' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { url: 'https://billing.example/session/portal_test' });
    assert.deepEqual(calls, [{
      customer: 'cus_pro',
      return_url: 'https://manualos.com/upload.html?session_id=cs_pro',
    }]);
  });
});

test('jobs require the owning session, survive restart, and refund a running Starter credit', async () => {
  const dir = tempDir();
  const expiresAt = new Date(Date.now() + 2 * DAY_MS).toISOString();
  const records = [
    {
      id: 'job_running',
      status: 'running',
      progress: { stage: 'analyzing', percent: 40, message: 'Working' },
      error: null,
      warnings: [],
      coverage: null,
      createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      expiresAt,
      sessionId: 'cs_owner',
      filename: 'line.L5X',
      credit: { paymentIntentId: 'pi_restart', token: 'hold_run' },
    },
    {
      id: 'job_queued',
      status: 'queued',
      progress: { stage: 'queued', percent: 0, message: 'Waiting to start' },
      error: null,
      warnings: [],
      coverage: null,
      createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      expiresAt,
      sessionId: 'cs_owner',
      filename: 'queued.L5X',
      credit: { paymentIntentId: 'pi_queued', token: 'hold_queue' },
    },
    {
      id: 'job_pro',
      status: 'running',
      progress: { stage: 'rendering', percent: 80, message: 'Working' },
      error: null,
      warnings: [],
      coverage: null,
      createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      expiresAt,
      sessionId: 'cs_pro',
      filename: 'pro.L5X',
      credit: null,
    },
  ];
  fs.writeFileSync(path.join(dir, INDEX_NAME), JSON.stringify({ jobs: records }));
  const intents = {
    pi_restart: { manuals_used: '1', credit_generation: '0', credit_hold: 'hold_run', plan: 'starter' },
    pi_queued: { manuals_used: '1', credit_generation: '0', credit_hold: 'hold_queue', plan: 'starter' },
  };
  const updates = [];
  const stripe = {
    paymentIntents: {
      retrieve: async (id) => ({ id, metadata: { ...intents[id] } }),
      update: async (id, params) => {
        updates.push(id);
        const meta = intents[id];
        for (const [key, value] of Object.entries(params.metadata)) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, metadata: { ...meta } };
      },
    },
  };
  const store = createJobStore({ directory: dir, env: env() });
  const captured = await captureConsole(async () => {
    const app = createApp({ env: env(), stripe, anthropic: null, jobs: store, mailer: null });
    await app.ready;
    return app;
  });
  assertNoSecrets(captured.lines.join('\n'));
  assert.equal(captured.lines.join('\n').includes('hold_run'), false);
  const app = captured.value;
  try {
    assert.equal(store.get('job_running').status, 'failed');
    assert.equal(store.get('job_running').credit, null);
    assert.equal(store.get('job_queued').status, 'failed');
    assert.equal(store.get('job_queued').credit, null);
    assert.equal(store.get('job_pro').status, 'failed');
    assert.deepEqual(updates, ['pi_restart', 'pi_queued']);
    assert.equal(intents.pi_restart.manuals_used, '0');
    assert.equal(intents.pi_restart.credit_hold, undefined);
    assert.equal(intents.pi_queued.manuals_used, '0');
    assert.equal(intents.pi_queued.credit_hold, undefined);

    const again = createJobStore({ directory: dir, env: env() });
    const second = createApp({ env: env(), stripe, anthropic: null, jobs: again, mailer: null });
    await second.ready;
    again.close();
    assert.deepEqual(updates, ['pi_restart', 'pi_queued']);

    const recent = store.create({
      sessionId: 'cs_owner',
      filename: 'newer.L5X',
      status: 'succeeded',
      createdAt: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    store.savePdf(recent.id, Buffer.from('%PDF-1.4\n%owned\n'));
    store.commit(recent);
    const stale = store.create({
      sessionId: 'cs_owner',
      filename: 'stale.L5X',
      createdAt: new Date(Date.now() - 25 * HOUR_MS).toISOString(),
      expiresAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
    });
    await withServer(app, async (base) => {
      const missing = await fetch(`${base}/jobs/${recent.id}`);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'Job not found or expired.' });
      const wrong = await fetch(`${base}/jobs/${recent.id}`, { headers: { 'X-Session-Id': 'cs_other' } });
      assert.equal(wrong.status, 404);
      const query = await fetch(`${base}/jobs/${recent.id}?session_id=cs_owner`);
      assert.equal(query.status, 404);
      const owned = await fetch(`${base}/jobs/${recent.id}`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(owned.status, 200);
      const body = await owned.json();
      assert.equal(body.status, 'succeeded');
      assert.equal(Object.hasOwn(body, 'sessionId'), false);
      assert.equal(Object.hasOwn(body, 'credit'), false);
      assert.equal(Object.hasOwn(body, 'filename'), false);
      assert.equal(JSON.stringify(body).includes('hold_run'), false);

      const pdfWrong = await fetch(`${base}/jobs/${recent.id}/pdf`, { headers: { 'X-Session-Id': 'cs_other' } });
      assert.equal(pdfWrong.status, 404);
      const pdfMissing = await fetch(`${base}/jobs/${recent.id}/pdf`);
      assert.equal(pdfMissing.status, 404);
      const pdf = await fetch(`${base}/jobs/${recent.id}/pdf`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(pdf.status, 200);
      assert.match(pdf.headers.get('content-type'), /pdf/);

      const noHeader = await fetch(`${base}/jobs?mine`);
      assert.equal(noHeader.status, 404);
      const notMine = await fetch(`${base}/jobs`);
      assert.equal(notMine.status, 404);
      const other = await fetch(`${base}/jobs?mine`, { headers: { 'X-Session-Id': 'cs_other' } });
      assert.deepEqual(await other.json(), { jobs: [] });
      const mine = await fetch(`${base}/jobs?mine`, { headers: { 'X-Session-Id': 'cs_owner' } });
      const listed = await mine.json();
      const ids = listed.jobs.map((job) => job.id);
      assert.equal(ids.includes(recent.id), true);
      assert.equal(ids.includes(stale.id), false);
      assert.equal(ids[0], recent.id);
      const row = listed.jobs.find((job) => job.id === recent.id);
      assert.deepEqual(Object.keys(row).sort(), ['created_at', 'filename', 'id', 'pdf_available', 'status']);
      assert.equal(row.filename, 'newer.L5X');
      assert.equal(row.status, 'succeeded');
      assert.equal(row.pdf_available, true);
      assert.equal(listed.jobs.some((job) => job.filename === 'stale.L5X'), false);
    });

    const reloaded = createJobStore({ directory: dir, env: env() });
    try {
      const saved = reloaded.get(recent.id);
      assert.equal(saved.status, 'succeeded');
      assert.equal(saved.sessionId, 'cs_owner');
      assert.equal(reloaded.readPdf(recent.id).includes(Buffer.from('%PDF')), true);
    } finally {
      reloaded.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DATA_DIR is the job store and SMTP is skipped until SMTP_HOST is set', () => {
  const dir = tempDir();
  const store = createJobStore({
    env: { DATA_DIR: dir, NODE_ENV: 'test' },
    now: () => Date.now(),
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
  });
  try {
    assert.equal(store.dir, path.resolve(dir));
    const job = store.create({ sessionId: 'cs_data', filename: 'line.L5X' });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, INDEX_NAME), 'utf8'));
    assert.equal(raw.jobs.some((item) => item.id === job.id), true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(createSmtpMailer({ SMTP_PASS: SECRET, SMTP_FROM: 'support@manualos.com' }), null);
  const mailer = createSmtpMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '25', SMTP_PASS: SECRET });
  assert.equal(typeof mailer.sendMail, 'function');
});

test('access-link responds before the Stripe lookup', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let listed = 0;
  const app = createApp({
    env: env({ TRUST_PROXY_HOPS: '1' }),
    stripe: {
      checkout: {
        sessions: {
          list: async () => {
            listed += 1;
            await gate;
            return { data: [] };
          },
        },
      },
    },
    anthropic: null,
    mailer: { async sendMail() { throw new Error('should not send'); } },
  });
  await withServer(app, async (base) => {
    const pending = postJson(base, '/access-link', { email: 'buyer@example.com' }, { 'X-Forwarded-For': '203.0.113.80' });
    const winner = await Promise.race([
      pending.then((res) => ({ res })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 300)),
    ]);
    assert.equal(winner.timeout, undefined);
    assert.equal(winner.res.status, 202);
    assert.deepEqual(await winner.res.json(), { ok: true });
    assert.equal(listed, 1);
    release();
    await app.settle();
  });
});

test('the webhook acks before SMTP and still sends once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const app = createApp({
    env: env(),
    stripe: signedStripe(),
    anthropic: null,
    mailer: {
      async sendMail(message) {
        await gate;
        sent.push(message);
      },
    },
  });
  await withServer(app, async (base) => {
    const pending = postWebhook(base, completedEvent(starterSession('cs_async', 'buyer@example.com'), 'evt_async'));
    const winner = await Promise.race([
      pending.then((res) => ({ res })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 300)),
    ]);
    assert.equal(winner.timeout, undefined);
    assert.equal(winner.res.status, 200);
    assert.equal(sent.length, 0);
    release();
    await app.settle();
    assert.equal(sent.length, 1);
    const again = await postWebhook(base, completedEvent(starterSession('cs_async', 'buyer@example.com'), 'evt_async_2'));
    assert.equal(again.status, 200);
    await app.settle();
    assert.equal(sent.length, 1);
  });
});

test('two in-flight Starter jobs each refund once after a restart', async () => {
  const dir = tempDir();
  const store = createJobStore({ directory: dir, env: env() });
  const meta = { manuals_used: '0', plan: 'starter', credit_generation: '0' };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_test_starter',
          metadata: { plan: 'starter' },
          payment_status: 'paid',
          payment_intent: 'pi_two',
          subscription: null,
        }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_two', metadata: { ...meta } }),
      update: async (id, params) => {
        for (const [key, value] of Object.entries(params.metadata)) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, metadata: { ...meta } };
      },
    },
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const l5x = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
  const app = createApp({
    env: env(),
    stripe,
    jobs: store,
    mailer: null,
    anthropic: { messages: { create: async () => { await gate; throw new Error('stopped'); } } },
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  try {
    await withServer(app, async (base) => {
      async function startJob() {
        const form = new FormData();
        form.set('session_id', 'cs_test_starter');
        form.set('file', new Blob([l5x]), 'line.L5X');
        const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
        assert.equal(created.status, 202);
        return created.json();
      }
      const first = await startJob();
      const second = await startJob();
      assert.equal(meta.manuals_used, '2');
      assert.equal(String(meta.credit_holds).split(',').length, 2);
      assert.equal(String(meta.credit_holds).includes(first.id), true);
      assert.equal(String(meta.credit_holds).includes(second.id), true);

      const restarted = createJobStore({ directory: dir, env: env() });
      const next = createApp({ env: env(), stripe, anthropic: null, jobs: restarted, mailer: null });
      await next.ready;
      assert.equal(meta.manuals_used, '0');
      assert.equal(meta.credit_holds, undefined);
      assert.equal(restarted.get(first.id).status, 'failed');
      assert.equal(restarted.get(second.id).status, 'failed');
      assert.equal(restarted.get(first.id).needsCreditRefund, false);
      restarted.close();

      release();
      for (const id of [first.id, second.id]) {
        let body;
        for (let i = 0; i < 50; i += 1) {
          const res = await fetch(`${base}/jobs/${id}`, { headers: { 'X-Session-Id': 'cs_test_starter' } });
          body = await res.json();
          if (body.status === 'failed' || body.status === 'succeeded') break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(body.status === 'failed' || body.status === 'succeeded', true);
      }
      assert.equal(meta.manuals_used, '0');
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed startup refund is retried and the job survives the 24h sweep', async () => {
  const dir = tempDir();
  const record = {
    id: 'job_hold',
    status: 'running',
    progress: { stage: 'analyzing', percent: 10, message: 'Working' },
    error: null,
    warnings: [],
    coverage: null,
    createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    sessionId: 'cs_owner',
    filename: 'line.L5X',
    credit: { paymentIntentId: 'pi_hold', token: 'tok_hold' },
  };
  fs.writeFileSync(path.join(dir, INDEX_NAME), JSON.stringify({ jobs: [record] }));
  const meta = { manuals_used: '1', credit_generation: '0', credit_hold: 'tok_hold', plan: 'starter' };
  let down = true;
  const stripe = {
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_hold', metadata: { ...meta } }),
      update: async (id, params) => {
        if (down) {
          const err = new Error('down');
          err.code = 'stripe_down';
          throw err;
        }
        for (const [key, value] of Object.entries(params.metadata)) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, metadata: { ...meta } };
      },
    },
  };
  const store = createJobStore({ directory: dir, env: env() });
  const app = createApp({ env: env(), stripe, anthropic: null, jobs: store, mailer: null });
  try {
    await app.ready;
    assert.equal(store.get('job_hold').needsCreditRefund, true);
    assert.equal(store.get('job_hold').status, 'failed');
    store.sweep();
    assert.equal(store.get('job_hold').id, 'job_hold');
    assert.equal(meta.manuals_used, '1');
    down = false;
    await app.retryRefunds();
    assert.equal(meta.manuals_used, '0');
    assert.equal(meta.credit_hold, undefined);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, INDEX_NAME), 'utf8'));
    assert.equal(saved.jobs[0].needsCreditRefund, false);
    store.sweep();
    assert.equal(store.get('job_hold'), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rate limiter drops expired keys and proxy hops follow TRUST_PROXY_HOPS', async () => {
  let t = 1_000_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.size(), 1);
  t += 1001;
  assert.equal(limiter.allow('b'), true);
  assert.equal(limiter.size(), 1);

  assert.equal(trustProxyHops({}), 0);
  assert.equal(trustProxyHops({ RAILWAY_ENVIRONMENT: 'production' }), 1);
  assert.equal(trustProxyHops({ RAILWAY_PROJECT_ID: 'proj' }), 1);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: '2', RAILWAY_ENVIRONMENT: 'production' }), 2);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: '0', RAILWAY_ENVIRONMENT: 'production' }), 0);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: 'nope' }), 0);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: '9' }), 0);

  const app = createApp({
    env: env(),
    stripe: { checkout: { sessions: { list: async () => ({ data: [] }) } } },
    anthropic: null,
    mailer: { async sendMail() {} },
  });
  await withServer(app, async (base) => {
    for (let i = 0; i < 10; i += 1) {
      const res = await postJson(
        base,
        '/access-link',
        { email: `direct${i}@example.com` },
        { 'X-Forwarded-For': `198.51.100.${i}` }
      );
      assert.equal(res.status, 202);
    }
    const eleventh = await postJson(
      base,
      '/access-link',
      { email: 'direct10@example.com' },
      { 'X-Forwarded-For': '203.0.113.200' }
    );
    assert.equal(eleventh.status, 429);
    await app.settle();
  });
});
