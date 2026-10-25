const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { removeTestJobDirectories } = require('../lib/jobs/store');
const {
  EMAIL_LIMIT,
  INVALID_LINK,
  IP_LIMIT,
  PORTAL_UNAVAILABLE,
  SESSION_PORTAL_MAX_AGE_MS,
  SMTP_SKIP_WARNING,
  SMTP_UNCONFIGURED_WARNING,
  TOKEN_TTL_MS,
  customerOwnsManualos,
  isManualosPurchase,
  normalizeEmail,
  sessionOpensPortal,
  sessionWithinPortalWindow,
  signPortalToken,
  verifyPortalToken,
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
          data: [{
            metadata: { brand: 'manualos' },
            items: { data: [{ price: { id: 'price_pro', lookup_key: 'manualos_pro_mhtbvcln' } }] },
          }],
        };
      },
    },
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
          lists.push(params);
          return { data: [proSession('cus_buyer')] };
        },
      },
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
    await app.settle();
    assert.equal(lists.length, 0);
    assert.equal(warnings.filter((line) => line === SMTP_SKIP_WARNING).length, 1);
    assert.equal(warnings.some((line) => line.includes('buyer@example.com')), false);
  } finally {
    console.warn = original;
    await new Promise((resolve) => server.close(resolve));
  }
}));
