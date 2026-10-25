const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const {
  EMAIL_LIMIT,
  INVALID_LINK,
  IP_LIMIT,
  LINK_CANCEL_STEPS,
  LINK_CANCEL_URL,
  MP_NO_PORTAL_WARNING,
  ONLINE_CANCEL_LOG,
  ONLINE_CANCEL_UNAVAILABLE,
  PORTAL_BLOCKED_LOG,
  PORTAL_UNAVAILABLE,
  SESSION_PORTAL_MAX_AGE_MS,
  SMTP_SKIP_WARNING,
  SMTP_UNCONFIGURED_WARNING,
  TOKEN_TTL_MS,
  customerOwnsManualos,
  isManualosPurchase,
  linkCancelOffer,
  normalizeEmail,
  portalMailText,
  renderCancelOffer,
  sessionOpensPortal,
  sessionWithinPortalWindow,
  signPortalToken,
  verifyPortalToken,
  warnIfManagedPaymentsWithoutPortal,
  warnIfSmtpUnconfigured,
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
    STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_manualos',
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
    created: Math.floor(FIXED / 1000),
    metadata: { plan: 'pro', brand: 'manualos' },
    integration_identifier: 'manualos_pro_mhtbvcln',
    ...extra,
  };
}

function htsSession(extra = {}) {
  return {
    id: 'cs_hts',
    mode: 'subscription',
    payment_status: 'paid',
    customer: 'cus_hts',
    created: Math.floor(FIXED / 1000),
    metadata: { plan: 'pro', brand: 'htsatlas' },
    integration_identifier: 'htsatlas_pro',
    lookup_key: 'htsatlas_pro',
    ...extra,
  };
}

function manualosStripeExtras() {
  return {
    customers: {
      retrieve: async (id) => {
        if (id === 'cus_hts') return { id, metadata: { brand: 'htsatlas' } };
        if (id === 'cus_unmarked') return { id, metadata: { plan: 'pro' } };
        return { id, metadata: { brand: 'manualos' } };
      },
    },
    subscriptions: {
      list: async ({ customer }) => {
        if (customer === 'cus_hts') {
          return {
            data: [{
              metadata: { brand: 'htsatlas' },
              items: { data: [{ price: { id: 'price_hts', lookup_key: 'htsatlas_pro' } }] },
            }],
          };
        }
        if (customer === 'cus_unmarked') return { data: [{ metadata: { plan: 'pro' } }] };
        return {
          data: [manualosSubscription()],
        };
      },
    },
  };
}

function manualosSubscription({
  id = 'sub_manualos',
  status = 'active',
  managed = false,
  cancelAt = null,
} = {}) {
  return {
    id,
    status,
    cancel_at: cancelAt,
    cancel_at_period_end: false,
    metadata: { brand: 'manualos' },
    items: { data: [{ price: { id: 'price_pro', lookup_key: 'manualos_pro_mhtbvcln' } }] },
    managed_payments: { enabled: managed === true },
  };
}

function htsSubscription({
  id = 'sub_hts',
  status = 'active',
  cancelAt = null,
} = {}) {
  return {
    id,
    status,
    cancel_at: cancelAt,
    cancel_at_period_end: false,
    metadata: { brand: 'htsatlas' },
    items: { data: [{ price: { id: 'price_hts', lookup_key: 'htsatlas_pro' } }] },
    managed_payments: { enabled: false },
  };
}

test.after(() => {
  removeTestJobDirectories();
});

test('portal tokens are bound to one customer, reusable for one hour, and then expire', () => {
  const env = baseEnv();
  const token = signPortalToken('cus_buyer', env, FIXED);
  assert.equal(verifyPortalToken(token, env, FIXED), 'cus_buyer');
  assert.equal(verifyPortalToken(token, env, FIXED), 'cus_buyer');
  assert.equal(verifyPortalToken(token, env, FIXED + TOKEN_TTL_MS - 1), 'cus_buyer');
  assert.equal(verifyPortalToken(token, env, FIXED + TOKEN_TTL_MS), '');
  assert.equal(signPortalToken('not-a-customer', env, FIXED), '');
  assert.equal(signPortalToken('cus_buyer', {}, FIXED), '');

  const webhookOnly = { STRIPE_WEBHOOK_SECRET: 'whsec_test' };
  const dedicated = signPortalToken('cus_buyer', env, FIXED);
  assert.equal(verifyPortalToken(dedicated, webhookOnly, FIXED), '');
  assert.equal(signPortalToken('cus_buyer', webhookOnly, FIXED), '');
  assert.equal(verifyPortalToken(dedicated, { PORTAL_TOKEN_SECRET: '   ', STRIPE_WEBHOOK_SECRET: 'whsec_test' }, FIXED), '');

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

test('ManualOS identification ignores HTS Atlas on the shared Stripe account', async () => {
  const env = baseEnv();
  const cases = [
    [{ metadata: { brand: 'manualos', plan: 'pro' } }, true],
    [{ metadata: { brand: ' ManualOS ' } }, true],
    [{ metadata: { brand: 'htsatlas', plan: 'pro' }, integration_identifier: 'htsatlas_pro', lookup_key: 'htsatlas_pro' }, false],
    [{ metadata: { plan: 'pro' } }, false],
    [{ metadata: { brand: 'htsatlas' }, line_items: { data: [{ price: { id: 'price_pro' } }] } }, true],
    [{ metadata: { brand: 'htsatlas' }, lookup_key: 'htsatlas_pro' }, false],
    [{ metadata: { plan: 'pro' }, integration_identifier: 'manualos_pro_mhtbvcln' }, true],
    [{ metadata: { plan: 'pro' }, lookup_key: 'manualos_starter_kwnqxpdl' }, true],
    [{ metadata: { plan: 'pro' }, line_items: { data: [{ price: { lookup_key: 'manualos_pro_mhtbvcln' } }] } }, true],
  ];
  for (const [session, expected] of cases) {
    assert.equal(isManualosPurchase(session, null, null, env), expected, JSON.stringify(session.metadata));
  }
  assert.equal(isManualosPurchase(
    null,
    { metadata: { brand: 'htsatlas' }, items: { data: [{ price: { id: 'price_pro', lookup_key: 'manualos_pro_mhtbvcln' } }] } },
    { metadata: { brand: 'manualos' } },
    env,
  ), false);
  assert.equal(isManualosPurchase(
    null,
    { metadata: { plan: 'pro' }, items: { data: [{ price: { id: 'price_pro' } }] } },
    null,
    env,
  ), true);
  assert.equal(isManualosPurchase({ metadata: { plan: 'pro' } }, null, { metadata: { brand: 'manualos' } }, env), true);
  assert.equal(isManualosPurchase(
    { metadata: { brand: 'htsatlas' } },
    { metadata: { brand: 'manualos' } },
    { metadata: { brand: 'manualos' } },
    env,
  ), false);

  const foreignCustomer = {
    customers: { retrieve: async () => ({ metadata: { brand: 'manualos' } }) },
    subscriptions: {
      list: async () => ({
        data: [{ metadata: { brand: 'htsatlas' }, items: { data: [{ price: { lookup_key: 'htsatlas_pro' } }] } }],
      }),
    },
  };
  assert.equal(await customerOwnsManualos(foreignCustomer, 'cus_hts', env), false);
  const brandedOnly = {
    customers: { retrieve: async () => ({ metadata: { brand: 'manualos' } }) },
    subscriptions: { list: async () => ({ data: [] }) },
  };
  assert.equal(await customerOwnsManualos(brandedOnly, 'cus_new', env), true);
  const unmarked = {
    customers: { retrieve: async () => ({ metadata: { plan: 'pro' } }) },
    subscriptions: { list: async () => ({ data: [{ metadata: { plan: 'pro' } }] }) },
  };
  assert.equal(await customerOwnsManualos(unmarked, 'cus_plain', env), false);
  const missingApis = { customers: { retrieve: async () => ({ metadata: {} }) } };
  assert.equal(await customerOwnsManualos(missingApis, 'cus_plain', env), false);
});

test('session_id portal access is limited to checkout sessions from the last 24 hours', () => {
  const recent = { created: Math.floor(FIXED / 1000) };
  assert.equal(sessionWithinPortalWindow(recent, FIXED), true);
  assert.equal(sessionWithinPortalWindow({ created: Math.floor((FIXED - SESSION_PORTAL_MAX_AGE_MS) / 1000) }, FIXED), true);
  assert.equal(sessionWithinPortalWindow({ created: Math.floor((FIXED - SESSION_PORTAL_MAX_AGE_MS) / 1000) - 1 }, FIXED), false);
  assert.equal(sessionWithinPortalWindow({}, FIXED), false);
  assert.equal(sessionWithinPortalWindow({ created: Math.floor(FIXED / 1000) + 60 }, FIXED), false);
  assert.equal(sessionWithinPortalWindow({ created: FIXED }, FIXED), true);
});

test('smtp warnings name the missing cancel-mail configuration', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => {
    const line = args.join(' ');
    if (line === SMTP_UNCONFIGURED_WARNING) warnings.push(line);
  };
  try {
    const before = warnings.length;
    assert.equal(warnIfSmtpUnconfigured({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'alerts@example.com' }), false);
    assert.equal(warnings.length, before);
    assert.equal(warnIfSmtpUnconfigured({ SMTP_HOST: 'smtp.example.com' }), true);
    assert.equal(warnings.at(-1), SMTP_UNCONFIGURED_WARNING);
    assert.equal(warnIfSmtpUnconfigured({}), true);
    assert.equal(SMTP_UNCONFIGURED_WARNING.includes('buyer@'), false);
  } finally {
    console.warn = original;
  }
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
          if (params.customer_details.email === 'hts-only@example.com') {
            return { data: [htsSession({ customer: 'cus_hts_only', id: 'cs_hts_only' })] };
          }
          if (params.customer_details.email === 'buyer@example.com') {
            return {
              data: [
                proSession('cus_buyer'),
                { id: 'cs_starter', mode: 'payment', payment_status: 'paid', customer: 'cus_starter', metadata: { plan: 'starter' } },
                { id: 'cs_unpaid', mode: 'subscription', payment_status: 'unpaid', customer: 'cus_unpaid', metadata: { plan: 'pro' } },
                proSession({ id: 'cus_expanded' }, { customer: { id: 'cus_expanded' }, id: 'cs_expanded' }),
                htsSession(),
                {
                  id: 'cs_unmarked',
                  mode: 'subscription',
                  payment_status: 'paid',
                  customer: 'cus_unmarked',
                  created: Math.floor(FIXED / 1000),
                  metadata: { plan: 'pro' },
                },
              ],
            };
          }
          return { data: [] };
        },
        retrieve: async (id) => {
          if (id === 'cs_test_pro') return proSession('cus_session');
          if (id === 'cs_starter') {
            return {
              id,
              mode: 'payment',
              payment_status: 'paid',
              customer: 'cus_starter',
              created: Math.floor(FIXED / 1000),
              metadata: { plan: 'starter' },
            };
          }
          if (id === 'cs_old') {
            return proSession('cus_old', { id, created: Math.floor(FIXED / 1000) - (25 * 60 * 60) });
          }
          if (id === 'cs_hts') return htsSession();
          if (id === 'cs_unmarked') {
            return {
              id,
              mode: 'subscription',
              payment_status: 'paid',
              customer: 'cus_unmarked',
              created: Math.floor(FIXED / 1000),
              metadata: { plan: 'pro' },
            };
          }
          if (id === 'cs_price') {
            return {
              id,
              mode: 'subscription',
              payment_status: 'paid',
              customer: 'cus_price',
              created: Math.floor(FIXED / 1000),
              metadata: { plan: 'pro' },
              line_items: { data: [{ price: { id: 'price_pro' } }] },
            };
          }
          const err = new Error('SUPER_SECRET_SESSION');
          err.statusCode = 404;
          err.code = 'resource_missing';
          throw err;
        },
      },
    },
    ...manualosStripeExtras(),
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
    assert.equal(sent[0].text.includes('htsatlas'), false);
    assert.equal(sent[0].text.includes('cus_hts'), false);
    assert.equal(sent[0].text.includes('cus_unmarked'), false);
    const tokens = links.map((link) => new URL(link).searchParams.get('token'));
    const customers = tokens.map((token) => verifyPortalToken(token, env, FIXED));
    assert.deepEqual(customers, ['cus_buyer', 'cus_expanded']);
    const htsOnly = await post(base, '/access-link', { email: 'hts-only@example.com' }, '198.51.100.10');
    assert.equal(htsOnly.status, 202);
    assert.deepEqual(await htsOnly.json(), { ok: true });
    await app.settle();
    assert.equal(sent.length, 1);
    assert.equal(lists.length, 3);

    const mismatch = await post(base, '/billing-portal', {
      token: tokens[0],
      customer: 'cus_expanded',
    }, '198.51.100.11');
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error, INVALID_LINK);
    assert.equal(created.length, 0);

    const opened = await post(base, '/billing-portal', { token: tokens[0] }, '198.51.100.11');
    assert.equal(opened.status, 200);
    assert.deepEqual(Object.keys(await opened.json()), ['method', 'url']);
    assert.equal(created[0].customer, customers[0]);
    assert.equal(created[0].return_url, 'https://manualos.com/cancel');
    assert.equal(created[0].configuration, 'bpc_manualos');
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

    const old = await post(base, '/billing-portal', { session_id: 'cs_old' }, '198.51.100.22');
    assert.equal(old.status, 400);
    assert.equal((await old.json()).error, INVALID_LINK);
    const hts = await post(base, '/billing-portal', { session_id: 'cs_hts' }, '198.51.100.23');
    assert.equal(hts.status, 400);
    assert.equal((await hts.json()).error, INVALID_LINK);
    const unmarked = await post(base, '/billing-portal', { session_id: 'cs_unmarked' }, '198.51.100.24');
    assert.equal(unmarked.status, 400);
    assert.equal((await unmarked.json()).error, INVALID_LINK);
    const priced = await post(base, '/billing-portal', { session_id: 'cs_price' }, '198.51.100.25');
    assert.equal(priced.status, 200);
    assert.equal(created.at(-1).customer, 'cus_price');
    const htsToken = signPortalToken('cus_hts', env, FIXED);
    const htsPortal = await post(base, '/billing-portal', { token: htsToken }, '198.51.100.26');
    assert.equal(htsPortal.status, 400);
    assert.equal((await htsPortal.json()).error, INVALID_LINK);
    assert.equal(created.some((row) => row.customer === 'cus_hts' || row.customer === 'cus_unmarked' || row.customer === 'cus_old'), false);

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

test('a portal configuration id is sent and rate limits match the consent route', async () => exclusive(async () => {
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
    subscriptions: {
      list: async () => ({ data: [manualosSubscription()] }),
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
  let created = 0;
  const stripe = {
    checkout: { sessions: { retrieve: async () => proSession('cus_config') } },
    billingPortal: {
      sessions: {
        create: async () => {
          created += 1;
          throw new Error('SUPER_SECRET_PORTAL');
        },
      },
    },
    subscriptions: {
      list: async () => ({ data: [manualosSubscription()] }),
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
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, ONLINE_CANCEL_UNAVAILABLE);
    assert.equal(created, 0);
    assert.equal(JSON.stringify(body).includes('not-a-config'), false);
    assert.equal(JSON.stringify(body).includes('SUPER_SECRET_PORTAL'), false);
    assert.equal(/email/i.test(body.error), false);
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
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, ONLINE_CANCEL_UNAVAILABLE);
    assert.equal(created, 1);
    assert.equal(JSON.stringify(body).includes('SUPER_SECRET_PORTAL'), false);
    assert.equal(/email/i.test(body.error), false);
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

test('a missing portal secret fails closed and does not fall back to the webhook secret', async () => exclusive(async () => {
  const lists = [];
  const created = [];
  const sent = [];
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const env = baseEnv();
  delete env.PORTAL_TOKEN_SECRET;
  const stripe = {
    checkout: {
      sessions: {
        list: async (params) => {
          lists.push(params);
          return { data: [proSession('cus_buyer')] };
        },
        retrieve: async () => proSession('cus_session'),
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          created.push(params);
          return { url: 'https://billing.stripe.com/p/session/recent' };
        },
      },
    },
    ...manualosStripeExtras(),
  };
  const app = createApp({
    env,
    stripe,
    anthropic: null,
    mailer: { async sendMail(message) { sent.push(message); } },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const invalid = await post(base, '/access-link', { email: 'nope' }, '198.51.100.70');
    assert.equal(invalid.status, 503);
    assert.deepEqual(await invalid.json(), { error: PORTAL_UNAVAILABLE });
    const known = await post(base, '/access-link', { email: 'buyer@example.com' }, '198.51.100.71');
    assert.equal(known.status, 503);
    assert.equal(known.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await known.json(), { error: PORTAL_UNAVAILABLE });
    await app.settle();
    assert.equal(lists.length, 0);
    assert.equal(sent.length, 0);

    const token = signPortalToken('cus_buyer', baseEnv(), FIXED);
    const redeemed = await post(base, '/billing-portal', { token }, '198.51.100.72');
    assert.equal(redeemed.status, 503);
    assert.deepEqual(await redeemed.json(), { error: PORTAL_UNAVAILABLE });
    assert.equal(created.length, 0);

    const session = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.73');
    assert.equal(session.status, 200);
    assert.equal(created.length, 1);
    assert.equal(created[0].customer, 'cus_session');

    const logged = logs.join('\n');
    assert.match(logged, /PORTAL_TOKEN_SECRET is not set/);
    assert.equal(logged.includes('whsec_test'), false);
    assert.equal(logged.includes(token), false);
    assert.equal(logged.includes('buyer@example.com'), false);
  } finally {
    console.error = original;
    await app.settle();
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('each skipped cancel email warns when SMTP is not configured', async () => exclusive(async () => {
  const warnings = [];
  const lists = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const stripe = {
    checkout: {
      sessions: {
        list: async (params) => {
          lists.push(params.customer_details.email);
          if (params.customer_details.email === 'buyer@example.com') {
            return { data: [proSession('cus_buyer')] };
          }
          return { data: [] };
        },
      },
    },
    subscriptions: {
      list: async () => ({ data: [manualosSubscription()] }),
    },
  };
  const app = createApp({
    env: baseEnv(),
    stripe,
    anthropic: null,
    mailer: null,
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const res = await post(base, '/access-link', { email: 'buyer@example.com' }, '198.51.100.80');
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true });
    const unknown = await post(base, '/access-link', { email: 'nobody@example.com' }, '198.51.100.81');
    assert.equal(unknown.status, 202);
    await app.settle();
    assert.deepEqual(lists, ['buyer@example.com', 'nobody@example.com']);
    assert.equal(warnings.filter((line) => line === SMTP_SKIP_WARNING).length, 1);
    assert.equal(warnings.some((line) => line.includes('buyer@example.com')), false);
    assert.equal(warnings.some((line) => line.includes('nobody@example.com')), false);
  } finally {
    console.warn = original;
    await new Promise((resolve) => server.close(resolve));
  }
}));

function assertOnlineCancelRendered(text) {
  const body = String(text || '');
  const online = /https:\/\/app\.link\.com\b/i.test(body)
    || /https:\/\/billing\.stripe\.com\b/i.test(body)
    || /\/cancel\?token=/.test(body);
  const emailOnly = /\b(e-mail|email)\b/i.test(body) && !online;
  assert.equal(emailOnly, false, body);
  assert.equal(online, true, body);
}

test('email-only cancellation is never rendered', () => {
  const portal = renderCancelOffer({ method: 'portal', url: 'https://billing.stripe.com/p/session/bps_test' });
  const link = renderCancelOffer(linkCancelOffer());
  const mailed = portalMailText(['https://manualos.com/cancel?token=abc']);
  for (const rendered of [portal, link, mailed]) assertOnlineCancelRendered(rendered);
  const emailOnly = 'To cancel your subscription, email support@manualos.com.';
  assert.throws(() => assertOnlineCancelRendered(emailOnly));
});

test('startup warns when Managed Payments is on without a portal configuration', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => {
    const line = args.join(' ');
    if (line === MP_NO_PORTAL_WARNING) warnings.push(line);
  };
  try {
    assert.equal(warnIfManagedPaymentsWithoutPortal({ MANUALOS_MANAGED_PAYMENTS: '1', STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_manualos' }), false);
    assert.equal(warnings.length, 0);
    assert.equal(warnIfManagedPaymentsWithoutPortal({ STRIPE_PORTAL_CONFIGURATION_ID: '' }), false);
    assert.equal(warnIfManagedPaymentsWithoutPortal({ MANUALOS_MANAGED_PAYMENTS: ' 1 ' }), false);
    assert.equal(warnIfManagedPaymentsWithoutPortal({ MANUALOS_MANAGED_PAYMENTS: 'true' }), false);
    assert.equal(warnIfManagedPaymentsWithoutPortal({ STRIPE_MANAGED_PAYMENTS: '1' }), false);
    assert.equal(warnings.length, 0);
    assert.equal(warnIfManagedPaymentsWithoutPortal({ MANUALOS_MANAGED_PAYMENTS: '1' }), true);
    assert.equal(warnings.at(-1), MP_NO_PORTAL_WARNING);
    assert.equal(warnIfManagedPaymentsWithoutPortal({ MANUALOS_MANAGED_PAYMENTS: '1', STRIPE_PORTAL_CONFIGURATION_ID: 'not-a-config' }), true);
    assert.equal(MP_NO_PORTAL_WARNING.includes('not-a-config'), false);
  } finally {
    console.warn = original;
  }
});

test('customer portal is the cancel path when a configuration can open a session', async () => exclusive(async () => {
  const created = [];
  const stripe = {
    checkout: { sessions: { retrieve: async () => proSession('cus_portal') } },
    billingPortal: {
      sessions: {
        create: async (params) => {
          created.push(params);
          return { url: 'https://billing.stripe.com/p/session/portal' };
        },
      },
    },
    subscriptions: {
      list: async () => ({ data: [manualosSubscription()] }),
    },
  };
  const app = createApp({
    env: baseEnv({ MANUALOS_MANAGED_PAYMENTS: '1' }),
    stripe,
    anthropic: null,
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const res = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.90');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { method: 'portal', url: 'https://billing.stripe.com/p/session/portal' });
    assert.equal(created.length, 1);
    assert.equal(created[0].configuration, 'bpc_manualos');
    assert.equal(JSON.stringify(body).includes('link.com'), false);
    assertOnlineCancelRendered(renderCancelOffer(body));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('Managed Payments shows app.link.com when the portal session cannot be created', async () => exclusive(async () => {
  const created = [];
  const sent = [];
  const stripe = {
    checkout: {
      sessions: {
        list: async () => ({ data: [proSession('cus_link')] }),
        retrieve: async () => proSession('cus_link'),
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          created.push(params);
          throw Object.assign(new Error('portal down'), { code: 'portal_down' });
        },
      },
    },
    ...manualosStripeExtras(),
    subscriptions: {
      list: async () => ({ data: [manualosSubscription({ managed: true })] }),
    },
  };
  const app = createApp({
    env: baseEnv({ STRIPE_PORTAL_CONFIGURATION_ID: '', MANUALOS_MANAGED_PAYMENTS: '1' }),
    stripe,
    anthropic: null,
    mailer: { async sendMail(message) { sent.push(message); } },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const res = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.91');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(created.length, 0);
    assert.equal(body.method, 'link');
    assert.equal(body.url, LINK_CANCEL_URL);
    assert.deepEqual(body.steps, LINK_CANCEL_STEPS);
    assert.equal(body.backup, 'email');
    assert.equal(body.text.indexOf(LINK_CANCEL_URL) < body.text.indexOf('Email is only a backup'), true);
    for (const step of LINK_CANCEL_STEPS) assert.equal(body.text.includes(step), true);
    assertOnlineCancelRendered(body.text);

    const mailed = await post(base, '/access-link', { email: 'buyer@example.com' }, '198.51.100.92');
    assert.equal(mailed.status, 202);
    await app.settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, 'Cancel your ManualOS subscription');
    assertOnlineCancelRendered(sent[0].text);
    assert.equal(sent[0].text.includes(LINK_CANCEL_URL), true);
    assert.equal(sent[0].text.includes('Email is only a backup'), true);
  } finally {
    await app.settle();
    await new Promise((resolve) => server.close(resolve));
  }

  const failedCreate = [];
  const failed = createApp({
    env: baseEnv({ MANUALOS_MANAGED_PAYMENTS: '1' }),
    stripe: {
      checkout: { sessions: { retrieve: async () => proSession('cus_link') } },
      billingPortal: {
        sessions: {
          create: async () => {
            failedCreate.push(true);
            throw Object.assign(new Error('SUPER_SECRET_PORTAL'), { code: 'portal_down' });
          },
        },
      },
      subscriptions: {
        list: async () => ({ data: [manualosSubscription({ managed: true })] }),
      },
    },
    anthropic: null,
    now: () => FIXED,
  });
  const failedServer = await listen(failed);
  try {
    const res = await post(failedServer.base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.93');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(failedCreate.length, 1);
    assert.equal(body.method, 'link');
    assert.equal(body.url, LINK_CANCEL_URL);
    assertOnlineCancelRendered(body.text);
    assert.equal(JSON.stringify(body).includes('SUPER_SECRET_PORTAL'), false);
  } finally {
    await new Promise((resolve) => failedServer.server.close(resolve));
  }
}));

test('app.link.com stays off unless the ManualOS subscription has managed payments', async () => exclusive(async () => {
  const logs = [];
  const sent = [];
  const lists = [];
  const created = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const stripe = {
    checkout: {
      sessions: {
        list: async (params) => {
          lists.push(params);
          return { data: [proSession('cus_buyer')] };
        },
        retrieve: async () => proSession('cus_buyer'),
      },
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          created.push(params);
          return { url: 'https://billing.stripe.com/p/session/should-not-open' };
        },
      },
    },
    subscriptions: {
      list: async () => ({ data: [manualosSubscription({ managed: false })] }),
    },
  };
  const app = createApp({
    env: baseEnv({ STRIPE_PORTAL_CONFIGURATION_ID: '', MANUALOS_MANAGED_PAYMENTS: '1' }),
    stripe,
    anthropic: null,
    mailer: { async sendMail(message) { sent.push(message); } },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const res = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, '198.51.100.94');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { error: ONLINE_CANCEL_UNAVAILABLE });
    assert.equal(created.length, 0);
    assert.equal(JSON.stringify(body).includes('app.link.com'), false);
    assert.equal(/email/i.test(JSON.stringify(body)), false);
    assert.equal(logs.some((line) => line === ONLINE_CANCEL_LOG), true);

    const mailed = await post(base, '/access-link', { email: 'buyer@example.com' }, '198.51.100.95');
    assert.equal(mailed.status, 202);
    await app.settle();
    assert.equal(sent.length, 0);
    assert.equal(lists.length, 1);
    assert.equal(logs.filter((line) => line === ONLINE_CANCEL_LOG).length >= 2, true);
    assert.equal(logs.some((line) => line.includes('buyer@example.com')), false);
    for (const line of logs) assert.equal(/\bemail support@/i.test(line), false);
  } finally {
    console.error = original;
    await app.settle();
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('a non-canceled HTS subscription blocks the portal on the token and session paths', async () => exclusive(async () => {
  const logs = [];
  const created = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const env = baseEnv({ MANUALOS_MANAGED_PAYMENTS: '1' });
  const token = signPortalToken('cus_mixed', env, FIXED);

  function stripeFor(subs) {
    return {
      checkout: { sessions: { retrieve: async () => proSession('cus_mixed') } },
      customers: {
        retrieve: async () => ({ id: 'cus_mixed', metadata: { brand: 'manualos' }, email: 'buyer@example.com' }),
      },
      subscriptions: { list: async () => ({ data: subs }) },
      billingPortal: {
        sessions: {
          create: async (params) => {
            created.push(params);
            return { url: 'https://billing.stripe.com/p/session/should-stay-closed' };
          },
        },
      },
    };
  }

  async function bothPaths(subs, ipBase) {
    const before = created.length;
    const logFrom = logs.length;
    const app = createApp({ env, stripe: stripeFor(subs), anthropic: null, now: () => FIXED });
    const { server, base } = await listen(app);
    try {
      const sessionRes = await post(base, '/billing-portal', { session_id: 'cs_test_pro' }, ipBase);
      const sessionBody = await sessionRes.json();
      const tokenRes = await post(base, '/billing-portal', { token }, `${ipBase.slice(0, -1)}9`);
      const tokenBody = await tokenRes.json();
      return {
        sessionRes,
        sessionBody,
        tokenRes,
        tokenBody,
        opened: created.slice(before),
        lines: logs.slice(logFrom),
      };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  try {
    const canceledManualos = await bothPaths([
      manualosSubscription({ id: 'sub_os_old', status: 'canceled', managed: true }),
      htsSubscription({ id: 'sub_hts_live', status: 'active' }),
    ], '198.51.100.96');
    for (const result of [canceledManualos.sessionRes, canceledManualos.tokenRes]) {
      assert.equal(result.status, 503);
    }
    for (const body of [canceledManualos.sessionBody, canceledManualos.tokenBody]) {
      assert.deepEqual(body, { error: ONLINE_CANCEL_UNAVAILABLE });
      assert.equal(JSON.stringify(body).includes('app.link.com'), false);
      assert.equal(JSON.stringify(body).includes('billing.stripe.com'), false);
    }
    assert.equal(canceledManualos.opened.length, 0);
    assert.equal(canceledManualos.lines.some((line) => line === PORTAL_BLOCKED_LOG), true);
    assert.equal(canceledManualos.lines.some((line) => line === ONLINE_CANCEL_LOG), true);

    const activePair = await bothPaths([
      manualosSubscription({ id: 'sub_os_live', status: 'active', managed: false }),
      htsSubscription({ id: 'sub_hts_live', status: 'active' }),
    ], '198.51.100.97');
    for (const result of [activePair.sessionRes, activePair.tokenRes]) {
      assert.equal(result.status, 503);
    }
    for (const body of [activePair.sessionBody, activePair.tokenBody]) {
      assert.deepEqual(body, { error: ONLINE_CANCEL_UNAVAILABLE });
      assert.equal(JSON.stringify(body).includes('app.link.com'), false);
    }
    assert.equal(activePair.opened.length, 0);
    assert.equal(activePair.lines.some((line) => line === PORTAL_BLOCKED_LOG), true);
    assert.equal(activePair.lines.some((line) => line === ONLINE_CANCEL_LOG), true);

    const activeManaged = await bothPaths([
      manualosSubscription({ id: 'sub_os_mp', status: 'active', managed: true }),
      htsSubscription({ id: 'sub_hts_live', status: 'active' }),
    ], '198.51.100.98');
    assert.equal(activeManaged.sessionBody.method, 'link');
    assert.equal(activeManaged.tokenBody.url, LINK_CANCEL_URL);
    assert.equal(activeManaged.opened.length, 0);
    assert.equal(activeManaged.lines.some((line) => line === PORTAL_BLOCKED_LOG), true);

    const scheduledHts = await bothPaths([
      manualosSubscription({ id: 'sub_os_live', status: 'active', managed: false }),
      htsSubscription({ id: 'sub_hts_scheduled', status: 'active', cancelAt: Math.floor(FIXED / 1000) }),
    ], '198.51.100.100');
    assert.equal(scheduledHts.sessionRes.status, 503);
    assert.equal(scheduledHts.tokenRes.status, 503);
    assert.equal(scheduledHts.opened.length, 0);
    assert.equal(scheduledHts.lines.some((line) => line === PORTAL_BLOCKED_LOG), true);

    const canceledHts = await bothPaths([
      manualosSubscription({ id: 'sub_os_live', status: 'active' }),
      htsSubscription({ id: 'sub_hts_done', status: 'canceled' }),
    ], '198.51.100.110');
    assert.equal(canceledHts.sessionRes.status, 200);
    assert.equal(canceledHts.tokenRes.status, 200);
    assert.equal(canceledHts.sessionBody.method, 'portal');
    assert.equal(canceledHts.tokenBody.method, 'portal');
    assert.equal(canceledHts.opened.length, 2);
    assert.equal(canceledHts.lines.some((line) => line === PORTAL_BLOCKED_LOG), false);
  } finally {
    console.error = original;
  }
}));

function confirmationDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-cancel-'));
}

test('a ManualOS cancellation confirmation is sent once', async () => exclusive(async () => {
  const sent = [];
  const dir = confirmationDir();
  const warnings = [];
  const logs = [];
  const retrieved = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const end = Math.floor(Date.parse('2026-10-25T00:00:00.000Z') / 1000);
  const later = Math.floor(Date.parse('2026-11-01T00:00:00.000Z') / 1000);
  const stripe = {
    customers: {
      retrieve: async (id) => {
        retrieved.push(id);
        return { id, email: id === 'cus_hts' ? 'hts@example.com' : 'buyer@example.com' };
      },
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') throw new Error('bad signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
  function eventFor(object, previous) {
    return {
      id: `evt_${object.id}`,
      type: 'customer.subscription.updated',
      data: { object, previous_attributes: previous },
    };
  }
  async function postEvent(base, payload) {
    return fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify(payload),
    });
  }
  const portalCancel = eventFor({
    id: 'sub_os',
    status: 'active',
    customer: 'cus_buyer',
    cancel_at: end,
    cancel_at_period_end: false,
    metadata: { brand: 'manualos' },
    items: { data: [{ price: { id: 'price_pro' } }] },
  }, { cancel_at: null });
  const app = createApp({
    env: baseEnv({ SUPPORT_DATA_DIR: dir }),
    stripe,
    anthropic: null,
    mailer: { async sendMail(message) { sent.push(message); } },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const first = await postEvent(base, portalCancel);
    assert.equal(first.status, 200);
    const again = await postEvent(base, portalCancel);
    assert.equal(again.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'buyer@example.com');
    assert.equal(sent[0].subject, 'Your ManualOS subscription is scheduled to cancel');
    assert.match(sent[0].text, /October 25, 2026/);
    assert.match(sent[0].text, /There are no further charges/);

    const hts = await postEvent(base, eventFor({
      id: 'sub_hts',
      status: 'active',
      customer: 'cus_hts',
      cancel_at: end,
      cancel_at_period_end: false,
      metadata: { brand: 'htsatlas' },
      items: { data: [{ price: { id: 'price_hts', lookup_key: 'htsatlas_pro' } }] },
    }, { cancel_at: null }));
    assert.equal(hts.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(retrieved.includes('cus_hts'), false);

    const plain = await postEvent(base, eventFor({
      id: 'sub_plain',
      status: 'active',
      customer: 'cus_buyer',
      cancel_at: end,
      cancel_at_period_end: false,
      metadata: { plan: 'pro' },
    }, { cancel_at: null }));
    assert.equal(plain.status, 200);
    assert.equal(sent.length, 1);

    const period = await postEvent(base, eventFor({
      id: 'sub_period',
      status: 'active',
      customer: 'cus_buyer',
      cancel_at: null,
      cancel_at_period_end: true,
      current_period_end: later,
      metadata: { brand: 'manualos' },
    }, { cancel_at_period_end: false }));
    assert.equal(period.status, 200);
    assert.equal(sent.length, 2);
    assert.match(sent[1].text, /November 1, 2026/);
    assert.match(sent[1].text, /There are no further charges/);

    const metadataOnly = await postEvent(base, eventFor({
      id: 'sub_os',
      status: 'active',
      customer: 'cus_buyer',
      cancel_at: end,
      cancel_at_period_end: false,
      metadata: { brand: 'manualos', note: 'later' },
    }, { metadata: { note: 'earlier' } }));
    assert.equal(metadataOnly.status, 200);
    assert.equal(sent.length, 2);
    assert.equal(logs.some((line) => line.includes('buyer@example.com') || line.includes('hts@example.com')), false);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }

  const quietWarnings = [];
  console.warn = (...args) => quietWarnings.push(args.join(' '));
  const quiet = createApp({
    env: baseEnv({ SUPPORT_DATA_DIR: dir }),
    stripe,
    anthropic: null,
    mailer: null,
    now: () => FIXED,
  });
  const quietServer = await listen(quiet);
  try {
    const res = await postEvent(quietServer.base, portalCancel);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
    assert.equal(quietWarnings.filter((line) => line === SMTP_SKIP_WARNING).length, 1);
    assert.equal(quietWarnings.some((line) => line.includes('buyer@example.com')), false);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    await new Promise((resolve) => quietServer.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

function confirmationStripe() {
  return {
    customers: {
      retrieve: async (id) => ({ id, email: 'buyer@example.com' }),
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') throw new Error('bad signature');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
}

function confirmationEvent(end) {
  return {
    id: 'evt_sub_os',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_os',
        status: 'active',
        customer: 'cus_buyer',
        cancel_at: end,
        cancel_at_period_end: false,
        metadata: { brand: 'manualos' },
        items: { data: [{ price: { id: 'price_pro' } }] },
      },
      previous_attributes: { cancel_at: null },
    },
  };
}

async function postConfirmation(base, payload) {
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
    body: JSON.stringify(payload),
  });
}

test('concurrent cancellation deliveries send one confirmation', async () => exclusive(async () => {
  const dir = confirmationDir();
  const end = Math.floor(Date.parse('2026-10-25T00:00:00.000Z') / 1000);
  const sent = [];
  let releaseSend;
  const gate = new Promise((resolve) => { releaseSend = resolve; });
  let started = 0;
  const app = createApp({
    env: baseEnv({ SUPPORT_DATA_DIR: dir }),
    stripe: confirmationStripe(),
    anthropic: null,
    mailer: {
      async sendMail(message) {
        started += 1;
        sent.push(message);
        await gate;
      },
    },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  const payload = confirmationEvent(end);
  const finished = [];
  try {
    const pending = [postConfirmation(base, payload), postConfirmation(base, payload)].map((run) => run.then((res) => {
      finished.push(res);
      return res;
    }));
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (started === 1 && finished.length === 1) {
          clearInterval(timer);
          clearTimeout(limit);
          resolve();
        }
      }, 5);
      const limit = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`concurrent confirmations did not settle started=${started} finished=${finished.length}`));
      }, 3000);
    });
    assert.equal(started, 1);
    releaseSend();
    const responses = await Promise.all(pending);
    assert.equal(responses.filter((res) => res.status === 200).length, 2);
    assert.equal(started, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'buyer@example.com');
    assert.equal(fs.readdirSync(path.join(dir, 'cancel-confirmations')).length, 1);
  } finally {
    releaseSend();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('a cancellation confirmation is not sent again after a restart', async () => exclusive(async () => {
  const dir = confirmationDir();
  const end = Math.floor(Date.parse('2026-10-25T00:00:00.000Z') / 1000);
  const payload = confirmationEvent(end);
  const env = baseEnv({ SUPPORT_DATA_DIR: dir });
  const firstSent = [];
  const first = createApp({
    env,
    stripe: confirmationStripe(),
    anthropic: null,
    mailer: { async sendMail(message) { firstSent.push(message); } },
    now: () => FIXED,
  });
  const firstServer = await listen(first);
  try {
    const res = await postConfirmation(firstServer.base, payload);
    assert.equal(res.status, 200);
    assert.equal(firstSent.length, 1);
    assert.equal(fs.readdirSync(path.join(dir, 'cancel-confirmations')).length, 1);
  } finally {
    await new Promise((resolve) => firstServer.server.close(resolve));
  }

  const secondSent = [];
  const second = createApp({
    env,
    stripe: confirmationStripe(),
    anthropic: null,
    mailer: { async sendMail(message) { secondSent.push(message); } },
    now: () => FIXED,
  });
  const secondServer = await listen(second);
  try {
    const again = await postConfirmation(secondServer.base, payload);
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { received: true });
    assert.equal(secondSent.length, 0);
    assert.equal(firstSent.length, 1);
    assert.equal(fs.readdirSync(path.join(dir, 'cancel-confirmations')).length, 1);
  } finally {
    await new Promise((resolve) => secondServer.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));

test('a failed cancellation send releases the claim so a retry can send', async () => exclusive(async () => {
  const dir = confirmationDir();
  const end = Math.floor(Date.parse('2026-10-25T00:00:00.000Z') / 1000);
  const payload = confirmationEvent(end);
  const sent = [];
  let attempts = 0;
  const app = createApp({
    env: baseEnv({ SUPPORT_DATA_DIR: dir }),
    stripe: confirmationStripe(),
    anthropic: null,
    mailer: {
      async sendMail(message) {
        attempts += 1;
        if (attempts === 1) throw new Error('smtp down');
        sent.push(message);
      },
    },
    now: () => FIXED,
  });
  const { server, base } = await listen(app);
  try {
    const failed = await postConfirmation(base, payload);
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'Webhook handler failed' });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'cancel-confirmations')), []);
    const retried = await postConfirmation(base, payload);
    assert.equal(retried.status, 200);
    assert.equal(attempts, 2);
    assert.equal(sent.length, 1);
    assert.equal(fs.readdirSync(path.join(dir, 'cancel-confirmations')).length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}));
