const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const {
  EMAIL_LIMIT,
  INVALID_LINK,
  IP_LIMIT,
  TOKEN_TTL_MS,
  normalizeEmail,
  sessionOpensPortal,
  signPortalToken,
  verifyPortalToken,
} = require('../lib/billing-portal');

const FIXED = Date.parse('2026-10-25T15:00:00.000Z');

const exclusive = (() => {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
})();

function baseEnv(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    PORTAL_TOKEN_SECRET: 'portal-test-secret',
    STARTER_CREDITS: '3',
    ...extra,
  };
}

function proSession(customer, extra = {}) {
  return {
    id: 'cs_test_pro',
    mode: 'subscription',
    payment_status: 'paid',
    customer,
    metadata: { plan: 'pro' },
    ...extra,
  };
}

test.after(() => {
  removeTestJobDirectories();
});

test('portal tokens are bound to one customer and expire', () => {
  const env = baseEnv();
  const token = signPortalToken('cus_buyer', env, FIXED);
  assert.equal(verifyPortalToken(token, env, FIXED), 'cus_buyer');
  assert.equal(verifyPortalToken(token, env, FIXED + TOKEN_TTL_MS - 1), 'cus_buyer');
  assert.equal(verifyPortalToken(token, env, FIXED + TOKEN_TTL_MS), '');
  assert.equal(signPortalToken('not-a-customer', env, FIXED), '');
  assert.equal(signPortalToken('cus_buyer', {}, FIXED), '');

  const webhookOnly = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  const dedicated = signPortalToken('cus_buyer', env, FIXED);
  assert.equal(verifyPortalToken(dedicated, webhookOnly, FIXED), '');
  const fallback = signPortalToken('cus_buyer', webhookOnly, FIXED);
  assert.equal(verifyPortalToken(fallback, webhookOnly, FIXED), 'cus_buyer');
  assert.equal(verifyPortalToken(fallback, env, FIXED), '');

  const [body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.c = 'cus_other';
  const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
  assert.equal(verifyPortalToken(tampered, env, FIXED), '');
  assert.equal(verifyPortalToken(`${body}.${sig.slice(0, -1)}a`, env, FIXED), '');
  assert.equal(normalizeEmail('  Buyer@Example.com '), 'buyer@example.com');
  assert.equal(normalizeEmail('not an email'), '');
  assert.equal(sessionOpensPortal(proSession('cus_trial', { payment_status: 'no_payment_required' })), true);
  assert.equal(sessionOpensPortal({ mode: 'payment', payment_status: 'paid', customer: 'cus_s', metadata: { plan: 'starter' } }), false);
  assert.equal(sessionOpensPortal({ mode: 'payment', payment_status: 'paid', customer: 'cus_o', metadata: { plan: 'integrator_overage' } }), false);
  assert.equal(sessionOpensPortal({ payment_status: 'paid', customer: { id: 'cus_integrator' }, metadata: { plan: 'integrator' } }), true);
});

function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
    server.once('error', reject);
  });
}

function headers(ip) {
  return {
    'Content-Type': 'application/json',
    'X-Forwarded-For': `203.0.113.9, ${ip}`,
    'X-Real-IP': '198.51.100.77',
  };
}

async function post(base, path, body, ip) {
  return fetch(base + path, {
    method: 'POST',
    headers: headers(ip),
    body: JSON.stringify(body),
  });
}

test('unknown and known emails match, and a token cannot open another customer', async () => exclusive(async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const sent = [];
  const created = [];
  const lists = [];
  const logs = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  console.log = (...args) => logs.push(args.map(String).join(' '));
  const stripe = {
    checkout: {
      sessions: {
        list: async (params) => {
          lists.push(params);
          await gate;
          if (params.customer_details.email === 'buyer@example.com') {
            return {
              data: [
                proSession('cus_buyer'),
                { id: 'cs_starter', mode: 'payment', payment_status: 'paid', customer: 'cus_starter', metadata: { plan: 'starter' } },
                { id: 'cs_unpaid', mode: 'subscription', payment_status: 'unpaid', customer: 'cus_unpaid', metadata: { plan: 'pro' } },
                proSession({ id: 'cus_expanded' }, { customer: { id: 'cus_expanded' }, id: 'cs_expanded' }),
              ],
            };
          }
          return { data: [] };
        },
        retrieve: async (id) => {
          if (id === 'cs_test_pro') return proSession('cus_session');
          if (id === 'cs_starter') {
            return { id, mode: 'payment', payment_status: 'paid', customer: 'cus_starter', metadata: { plan: 'starter' } };
          }
          const err = new Error('SUPER_SECRET_SESSION');
          err.statusCode = 404;
          err.code = 'resource_missing';
          throw err;
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          created.push(params);
          if (params.customer === 'cus_missing') {
            const err = new Error('SUPER_SECRET_PORTAL');
            err.code = 'resource_missing';
            err.statusCode = 404;
            throw err;
          }
          return { id: 'bps_test', url: 'https://billing.stripe.com/p/session/bps_test' };
        },
      },
    },
  };
  const env = baseEnv();
  const app = createApp({
    env,
    stripe,
    anthropic: null,
    mailer: {
      async sendMail(message) {
        sent.push(message);
      },
    },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    async function timedPost(body) {
      let timer;
      try {
        return await Promise.race([
          post(base, '/access-link', body, '198.51.100.10'),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('response waited on lookup')), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    const known = await timedPost({ email: '  Buyer@Example.com ' });
    const unknown = await timedPost({ email: 'other@example.com' });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.equal(known.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(known.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await known.json(), { ok: true });
    assert.deepEqual(await unknown.json(), { ok: true });
    assert.equal(sent.length, 0);

    release();
    await app.settle();
    assert.equal(lists.length, 2);
    assert.equal(lists[0].customer_details.email, 'buyer@example.com');
    assert.equal(lists[0].status, 'complete');
    assert.equal(lists[0].limit, 10);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'buyer@example.com');
    assert.equal(sent[0].subject, 'Manage your ManualOS subscription');
    assert.equal(sent[0].text.includes('cs_test_pro'), false);
    assert.equal(sent[0].text.includes('other@example.com'), false);
    const links = sent[0].text.match(/https:\/\/\S+/g);
    assert.equal(links.length, 2);
    const tokens = links.map((link) => new URL(link).searchParams.get('token'));
    const customers = tokens.map((token) => verifyPortalToken(token, env, FIXED));
    assert.deepEqual(customers, ['cus_buyer', 'cus_expanded']);

    const mismatch = await post(base, '/billing-portal', {
      token: tokens[0],
      customer: 'cus_expanded',
    }, '198.51.100.11');
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error, INVALID_LINK);
    assert.equal(created.length, 0);

    const opened = await post(base, '/billing-portal', { token: tokens[0] }, '198.51.100.11');
    assert.equal(opened.status, 200);
    assert.deepEqual(Object.keys(await opened.json()), ['url']);
    assert.equal(created[0].customer, customers[0]);
    assert.equal(created[0].return_url, 'https://manualos.com/cancel');
    assert.equal(created[0].configuration, undefined);
    assert.equal(opened.headers.get('referrer-policy'), 'no-referrer');

    const same = await post(base, '/billing-portal', { token: tokens[1], customer: customers[1] }, '198.51.100.12');
    assert.equal(same.status, 200);
    assert.equal(created[1].customer, customers[1]);

    const expired = signPortalToken('cus_buyer', env, FIXED - TOKEN_TTL_MS);
    const expiredRes = await post(base, '/billing-portal', { token: expired }, '198.51.100.13');
    assert.equal(expiredRes.status, 400);
    assert.equal((await expiredRes.json()).error, INVALID_LINK);

    const session = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.14');
    assert.equal(session.status, 200);
    assert.equal(created[2].customer, 'cus_session');
    const crossed = await post(base, '/billing-portal', { session_id: 'cs_test_pro', customer: 'cus_buyer' }, '198.51.100.15');
    assert.equal(crossed.status, 400);
    assert.equal(created.length, 3);
    const starter = await post(base, '/billing-portal', { session_id: 'cs_starter' }, '198.51.100.16');
    assert.equal(starter.status, 400);
    assert.equal((await starter.json()).error, INVALID_LINK);
    const missing = await post(base, '/billing-portal', { session_id: 'cs_missing' }, '198.51.100.17');
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.error, INVALID_LINK);
    assert.equal(JSON.stringify(missingBody).includes('SUPER_SECRET_SESSION'), false);
    const both = await post(base, '/billing-portal', { token: tokens[0], session_id: 'cs_test_pro' }, '198.51.100.18');
    assert.equal(both.status, 400);
    assert.equal((await both.json()).error, 'A cancel link is required.');
    const none = await post(base, '/billing-portal', {}, '198.51.100.19');
    assert.equal(none.status, 400);
    assert.equal((await none.json()).error, 'A cancel link is required.');

    const badEmail = await post(base, '/access-link', { email: 'nope' }, '198.51.100.21');
    assert.equal(badEmail.status, 400);
    assert.equal((await badEmail.json()).error, 'A valid email is required.');

    const logged = logs.join('\n');
    assert.equal(logged.includes('portal-test-secret'), false);
    assert.equal(logged.includes('whsec_test'), false);
    assert.equal(logged.includes('SUPER_SECRET_SESSION'), false);
    assert.equal(tokens.some((token) => logged.includes(token)), false);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    release();
    await app.settle();
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('portal configuration is optional and rate limits match the consent route', async () => exclusive(async () => {
  const created = [];
  const lists = [];
  const stripe = {
    checkout: {
      sessions: {
        list: async (params) => {
          lists.push(params.customer_details.email);
          return { data: [] };
        },
        retrieve: async () => proSession('cus_config'),
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          created.push(params);
          if (!params.configuration) return { url: '' };
          return { url: 'https://billing.stripe.com/p/session/configured' };
        },
      },
    },
  };
  const app = createApp({
    env: baseEnv({ STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_cancel123' }),
    stripe,
    anthropic: null,
    mailer: { async sendMail() {} },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const configured = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.30');
    assert.equal(configured.status, 200);
    assert.equal((await configured.json()).url, 'https://billing.stripe.com/p/session/configured');
    assert.deepEqual(created[0], {
      customer: 'cus_config',
      return_url: 'https://manualos.com/cancel',
      configuration: 'bpc_cancel123',
    });

    for (let i = 0; i < IP_LIMIT; i += 1) {
      const res = await post(base, '/billing-portal', { token: 'not-a-token' }, '198.51.100.31');
      assert.equal(res.status, 400, `portal ${i}`);
    }
    const blocked = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.31');
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: 'Too many requests. Try again later.' });
    assert.equal(created.length, 1);
    const spoofed = await fetch(base + '/billing-portal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Real-IP': '203.0.113.50',
        'X-Forwarded-For': '203.0.113.50, 198.51.100.31',
      },
      body: JSON.stringify({ session_id: 'cs_test_pro' }),
    });
    assert.equal(spoofed.status, 429);
    const otherIp = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.32');
    assert.equal(otherIp.status, 200);

    const knownEmail = 'buyer@example.com';
    const unknownEmail = 'nobody@example.com';
    for (let i = 0; i < EMAIL_LIMIT; i += 1) {
      const known = await post(base, '/access-link', { email: knownEmail }, '198.51.100.40');
      const unknown = await post(base, '/access-link', { email: unknownEmail }, '198.51.100.41');
      assert.equal(known.status, 202);
      assert.equal(unknown.status, 202);
    }
    await app.settle();
    const before = lists.length;
    const knownLimited = await post(base, '/access-link', { email: knownEmail }, '198.51.100.42');
    const unknownLimited = await post(base, '/access-link', { email: unknownEmail }, '198.51.100.43');
    assert.equal(knownLimited.status, 429);
    assert.equal(unknownLimited.status, 429);
    assert.deepEqual(await knownLimited.json(), await unknownLimited.json());
    await app.settle();
    assert.equal(lists.length, before);
  } finally {
    await app.settle();
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('a bad portal configuration and a Stripe failure stay generic', async () => exclusive(async () => {
  const stripe = {
    checkout: { sessions: { retrieve: async () => proSession('cus_config') } },
    billingPortal: {
      sessions: {
        create: async () => {
          throw new Error('SUPER_SECRET_PORTAL');
        },
      },
    },
  };
  const bad = createApp({
    env: baseEnv({ STRIPE_PORTAL_CONFIGURATION_ID: 'not-a-config' }),
    stripe,
    anthropic: null,
    now: () => FIXED,
  });
  const badServer = await listen(bad);
  try {
    const res = await post(badServer.base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.50');
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Checkout is temporarily unavailable.');
    assert.equal(JSON.stringify(body).includes('not-a-config'), false);
    assert.equal(JSON.stringify(body).includes('SUPER_SECRET_PORTAL'), false);
  } finally {
    await new Promise((resolve) => badServer.server.close(resolve));
  }

  const boom = createApp({
    env: baseEnv(),
    stripe,
    anthropic: null,
    now: () => FIXED,
  });
  const boomServer = await listen(boom);
  try {
    const res = await post(boomServer.base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.51');
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Internal server error');
    assert.equal(JSON.stringify(body).includes('SUPER_SECRET_PORTAL'), false);
  } finally {
    await new Promise((resolve) => boomServer.server.close(resolve));
  }
}));

test('lookup and mail failures do not change the access-link response or log the address', async () => exclusive(async () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const stripe = {
    checkout: {
      sessions: {
        list: async () => {
          const err = new Error('buyer@example.com SUPER_SECRET_LOOKUP');
          err.code = 'lookup_failed';
          throw err;
        },
      },
    },
  };
  const app = createApp({
    env: baseEnv(),
    stripe,
    anthropic: null,
    mailer: { async sendMail() { throw Object.assign(new Error('SUPER_SECRET_SMTP'), { code: 'EAUTH' }); } },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const res = await post(base, '/access-link', { email: 'buyer@example.com' }, '198.51.100.60');
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true });
    await app.settle();
    const logged = logs.join('\n');
    assert.match(logged, /portal link failed lookup_failed/);
    assert.equal(logged.includes('buyer@example.com'), false);
    assert.equal(logged.includes('SUPER_SECRET_LOOKUP'), false);
    assert.equal(logged.includes('SUPER_SECRET_SMTP'), false);
  } finally {
    console.error = original;
    await new Promise((resolve) => server.close(resolve));
  }
}));
