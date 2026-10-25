const test = require('node:test');
const assert = require('node:assert/strict');
const { checkoutParams } = require('../lib/billing');
const { ALLOWED_KEYS, KEY_PREFIX, VALUE_MAX, withAttribution } = require('../lib/attribution');
const { createApp } = require('../server');

const env = {
  FRONTEND_URL: 'https://manualos.com/',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
};

const validAttribution = {
  utm_source: ' google ',
  utm_medium: 'cpc\u0000',
  utm_campaign: 'spring',
  utm_term: 'plc manual',
  utm_content: 'ad-1',
  landing_path: 'https://manualos.com/pricing?utm_source=google&email=person@example.com',
  first_seen_at: '2026-10-25T05:41:00.123Z',
  referrer_host: 'https://WWW.Google.com/search?q=1',
  gclid: 'Cj0KCQjw_test',
  msclkid: 'abc123def456',
};

function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  try {
    const value = fn();
    return { value, lines };
  } finally {
    console.log = original;
  }
}

function assertSafeMetadata(metadata) {
  assert.ok(Object.keys(metadata).length <= 50);
  for (const [key, value] of Object.entries(metadata)) {
    assert.equal(typeof value, 'string');
    assert.ok(key.length <= 40, key);
    assert.ok(value.length <= 500, key);
    const field = key.replace(/^attr_(?:latest_)?/, '');
    if (field === 'gclid' || field === 'msclkid') continue;
    if (key.startsWith(KEY_PREFIX)) assert.ok(value.length <= VALUE_MAX, key);
  }
}

test('valid attribution is copied onto the Checkout Session', () => {
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('starter', env), validAttribution));
  assert.deepEqual(lines, ['attribution fields kept: 10']);
  assert.equal(lines.join('\n').includes('person@example.com'), false);
  assert.equal(lines.join('\n').includes('Cj0KCQjw_test'), false);
  assert.deepEqual(value.metadata, {
    plan: 'starter',
    attr_utm_source: 'google',
    attr_utm_medium: 'cpc',
    attr_utm_campaign: 'spring',
    attr_utm_term: 'plc manual',
    attr_utm_content: 'ad-1',
    attr_landing_path: '/pricing',
    attr_first_seen_at: '2026-10-25T05:41:00.123Z',
    attr_referrer_host: 'www.google.com',
    attr_gclid: 'Cj0KCQjw_test',
    attr_msclkid: 'abc123def456',
  });
  assert.deepEqual(value.payment_intent_data.metadata, { plan: 'starter', manuals_used: '0' });
  assert.equal(value.subscription_data, undefined);
  assert.equal(value.payment_method_types, undefined);
  assertSafeMetadata(value.metadata);
  for (const key of ALLOWED_KEYS) {
    assert.ok(value.metadata[`${KEY_PREFIX}${key}`]);
    assert.ok(`${KEY_PREFIX}${key}`.length <= 40);
  }
});

test('missing attribution leaves checkout metadata unchanged and logs nothing', () => {
  const starter = checkoutParams('starter', env);
  const { value, lines } = captureLog(() => withAttribution(starter, undefined));
  assert.deepEqual(lines, []);
  assert.deepEqual(value.metadata, { plan: 'starter' });
  assert.equal(value, starter);

  const omitted = captureLog(() => withAttribution(checkoutParams('pro', env)));
  assert.deepEqual(omitted.lines, []);
  assert.deepEqual(omitted.value.metadata, { plan: 'pro' });
  assert.deepEqual(omitted.value.subscription_data.metadata, { plan: 'pro' });
});

test('oversized attribution values are capped at 100 characters', () => {
  const tail = 'UNIQUE_TAIL_SHOULD_NOT_BE_STORED';
  const source = `${'a'.repeat(120)}${tail}`;
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('starter', env), {
    utm_source: source,
    utm_medium: 'b'.repeat(VALUE_MAX),
  }));
  assert.deepEqual(lines, ['attribution fields kept: 2']);
  assert.equal(value.metadata.attr_utm_source.length, VALUE_MAX);
  assert.equal(value.metadata.attr_utm_source, 'a'.repeat(VALUE_MAX));
  assert.equal(value.metadata.attr_utm_source.includes(tail), false);
  assert.equal(value.metadata.attr_utm_medium, 'b'.repeat(VALUE_MAX));
  assert.equal(JSON.stringify(value).includes(tail), false);
});

test('unknown attribution keys are dropped', () => {
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('starter', env), {
    utm_source: 'newsletter',
    email: 'person@example.com',
    plan: 'enterprise',
    user_id: 'user_123',
    attr_utm_source: 'spoofed',
    period: '2026-10',
  }));
  assert.deepEqual(lines, ['attribution fields kept: 1']);
  assert.deepEqual(value.metadata, { plan: 'starter', attr_utm_source: 'newsletter' });
  assert.equal(JSON.stringify(value).includes('person@example.com'), false);
  assert.equal(JSON.stringify(value).includes('enterprise'), false);
  assert.equal(JSON.stringify(value).includes('spoofed'), false);
});

test('an email address in an attribution value is dropped', () => {
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('starter', env), {
    utm_source: 'newsletter',
    utm_campaign: 'founder@manualos.com',
    utm_content: 'ask person@example.com for the guide',
    gclid: 'click%40secret.example',
  }));
  assert.deepEqual(lines, ['attribution fields kept: 1']);
  assert.equal(lines[0].includes('@'), false);
  assert.equal(lines[0].includes('founder'), false);
  assert.deepEqual(value.metadata, { plan: 'starter', attr_utm_source: 'newsletter' });
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('founder@manualos.com'), false);
  assert.equal(serialized.includes('person@example.com'), false);
  assert.equal(serialized.includes('secret.example'), false);
});

test('drops phone numbers and long digit runs without blocking checkout', () => {
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('starter', env), {
    utm_source: 'ads',
    utm_term: '555-123-4567',
    utm_content: '123456789',
    utm_campaign: 'fy2026',
    landing_path: '/orders/123456789',
    first_seen_at: 'not-a-date',
    referrer_host: 'user@gmail.com',
  }));
  assert.deepEqual(lines, ['attribution fields kept: 2']);
  assert.deepEqual(value.metadata, {
    plan: 'starter',
    attr_utm_source: 'ads',
    attr_utm_campaign: 'fy2026',
  });
  assert.equal(JSON.stringify(value).includes('555'), false);
  assert.equal(JSON.stringify(value).includes('123456789'), false);
});

test('landing_path keeps the path and drops the host and query string', () => {
  const cases = [
    ['/pricing?utm_source=google#top', '/pricing'],
    ['https://manualos.com/upload.html?session=1', '/upload.html'],
    ['//manualos.com/docs/start', '/docs/start'],
    ['manualos.com/pricing', '/pricing'],
    ['pricing', null],
    ['https://evil.example', '/'],
  ];
  for (const [input, expected] of cases) {
    const { value } = captureLog(() => withAttribution(checkoutParams('starter', env), { landing_path: input }));
    assert.equal(value.metadata.attr_landing_path, expected === null ? undefined : expected, input);
  }
});

test('invalid attribution does not throw and does not change metadata', () => {
  for (const raw of [null, 'google', 42, ['utm_source'], true]) {
    const { value, lines } = captureLog(() => withAttribution(checkoutParams('pro', env), raw));
    assert.deepEqual(lines, ['attribution fields kept: 0']);
    assert.deepEqual(value.metadata, { plan: 'pro' });
    assert.deepEqual(value.subscription_data.metadata, { plan: 'pro' });
  }

  const explosive = {};
  Object.defineProperty(explosive, 'utm_source', {
    enumerable: true,
    get() {
      throw new Error('secret-utm-value');
    },
  });
  const blown = captureLog(() => withAttribution(checkoutParams('starter', env), explosive));
  assert.deepEqual(blown.lines, ['attribution fields kept: 0']);
  assert.equal(blown.lines.join('\n').includes('secret-utm-value'), false);
  assert.deepEqual(blown.value.metadata, { plan: 'starter' });
});

test('drops card, phone, and SSN values mixed with words, separators, or full-width digits', () => {
  const blocked = [
    'card 4111 1111 1111 1111',
    'cc:4111-1111-1111-1111',
    '4111_1111_1111_1111',
    '4111/1111/1111/1111',
    'call 555 123 4567',
    'SSN 123-45-6789',
    '４１１１　１１１１　１１１１　１１１１',
    'card ４１１１-１１１１-１１１１-１１１１',
  ];
  for (const sample of blocked) {
    const { value, lines } = captureLog(() => withAttribution(checkoutParams('starter', env), {
      utm_source: 'ads',
      utm_campaign: sample,
      landing_path: `/${sample}`,
    }));
    assert.deepEqual(lines, ['attribution fields kept: 1'], sample);
    assert.deepEqual(value.metadata, { plan: 'starter', attr_utm_source: 'ads' });
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes(sample), false, sample);
    assert.equal(serialized.includes('4111111111111111'), false, sample);
    assert.equal(serialized.includes('5551234567'), false, sample);
    assert.equal(serialized.includes('123456789'), false, sample);
  }
});

test('gclid and msclkid keep long digit runs up to 500 characters', () => {
  const gclid = `Cj0KCQjw-${'1'.repeat(20)}${'A'.repeat(90)}`;
  const msclkid = `123456789abcdef123456789abcdef12`;
  assert.ok(gclid.length > VALUE_MAX);
  assert.match(gclid, /[A-Za-z0-9_-]+/);
  assert.match(msclkid, /\d{9,}/);
  const maxGclid = `A_b-${'c'.repeat(496)}`;
  assert.equal(maxGclid.length, 500);
  const maxMsclk = 'a1'.repeat(250);
  assert.equal(maxMsclk.length, 500);
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('starter', env), {
    utm_source: 'ads',
    gclid,
    msclkid,
  }));
  assert.deepEqual(lines, ['attribution fields kept: 3']);
  assert.equal(value.metadata.attr_gclid, gclid);
  assert.equal(value.metadata.attr_msclkid, msclkid);
  assert.equal(value.metadata.attr_utm_source, 'ads');

  const full = captureLog(() => withAttribution(checkoutParams('pro', env), {
    gclid: maxGclid,
    msclkid: maxMsclk,
  }));
  assert.deepEqual(full.lines, ['attribution fields kept: 2']);
  assert.equal(full.value.metadata.attr_gclid, maxGclid);
  assert.equal(full.value.metadata.attr_msclkid, maxMsclk);
  assert.equal(full.value.subscription_data.metadata.attr_gclid, maxGclid);
  assert.equal(full.value.subscription_data.metadata.attr_msclkid, maxMsclk);

  const rejected = captureLog(() => withAttribution(checkoutParams('starter', env), {
    utm_source: 'ads',
    gclid: `${'A'.repeat(501)}`,
    msclkid: `${'a1'.repeat(250)}b`,
  }));
  assert.deepEqual(rejected.lines, ['attribution fields kept: 1']);
  assert.deepEqual(rejected.value.metadata, { plan: 'starter', attr_utm_source: 'ads' });
  assert.equal(JSON.stringify(rejected.value).includes('A'.repeat(100)), false);

  const badChars = captureLog(() => withAttribution(checkoutParams('starter', env), {
    utm_source: 'ads',
    gclid: 'Cj0KCQjw.test',
    msclkid: 'abc123-def456',
  }));
  assert.deepEqual(badChars.lines, ['attribution fields kept: 1']);
  assert.equal(badChars.value.metadata.attr_gclid, undefined);
  assert.equal(badChars.value.metadata.attr_msclkid, undefined);
  assertSafeMetadata(value.metadata);
  assertSafeMetadata(full.value.subscription_data.metadata);
});

test('latest touch is stored as attr_latest_* and copied onto Pro subscription metadata', () => {
  for (const key of ALLOWED_KEYS) {
    assert.ok(`${KEY_PREFIX}${key}`.length <= 40);
    assert.ok(`${KEY_PREFIX}latest_${key}`.length <= 40);
  }
  const raw = {
    utm_source: 'google',
    utm_medium: 'cpc',
    gclid: 'Cj0KCQjw_ok',
    latest: {
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'founder@manualos.com',
      utm_term: 'call 555 123 4567',
      landing_path: 'https://manualos.com/pricing?plan=pro',
      gclid: 'not a click id',
      msclkid: 'abc123def456',
      unknown: 'nope',
    },
  };
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('pro', env), raw));
  assert.deepEqual(lines, ['attribution fields kept: 7']);
  const expected = {
    plan: 'pro',
    attr_utm_source: 'google',
    attr_utm_medium: 'cpc',
    attr_gclid: 'Cj0KCQjw_ok',
    attr_latest_utm_source: 'newsletter',
    attr_latest_utm_medium: 'email',
    attr_latest_landing_path: '/pricing',
    attr_latest_msclkid: 'abc123def456',
  };
  assert.deepEqual(value.metadata, expected);
  assert.deepEqual(value.subscription_data.metadata, expected);
  assertSafeMetadata(value.metadata);
  assertSafeMetadata(value.subscription_data.metadata);
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('founder@manualos.com'), false);
  assert.equal(serialized.includes('555'), false);
  assert.equal(serialized.includes('not a click id'), false);
  assert.equal(serialized.includes('nope'), false);

  const starter = captureLog(() => withAttribution(checkoutParams('starter', env), raw));
  assert.equal(starter.value.payment_intent_data.metadata.attr_latest_utm_source, undefined);
  assert.deepEqual(starter.value.payment_intent_data.metadata, { plan: 'starter', manuals_used: '0' });

  const crowded = { plan: 'pro' };
  for (let i = 0; i < 48; i += 1) crowded[`p${i}`] = 'x';
  assert.equal(Object.keys(crowded).length, 49);
  const packed = captureLog(() => withAttribution({
    mode: 'subscription',
    metadata: { ...crowded },
    subscription_data: { metadata: { ...crowded } },
  }, {
    utm_source: 'google',
    utm_medium: 'cpc',
    latest: { utm_source: 'newsletter' },
  }));
  assert.deepEqual(packed.lines, ['attribution fields kept: 1']);
  assert.equal(Object.keys(packed.value.metadata).length, 50);
  assert.equal(packed.value.metadata.attr_utm_source, 'google');
  assert.equal(packed.value.metadata.attr_utm_medium, undefined);
  assert.equal(packed.value.metadata.attr_latest_utm_source, undefined);
  assert.equal(Object.keys(packed.value.subscription_data.metadata).length, 50);
  assert.equal(packed.value.subscription_data.metadata.attr_utm_source, 'google');
  assert.equal(packed.value.subscription_data.metadata.attr_latest_utm_source, undefined);
});

test('utm_source, utm_medium, and utm_campaign are trimmed and lowercased before metadata is written', () => {
  const gclid = 'Cj0KCQjw_AbC';
  const msclkid = 'AbC123def';
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('pro', env), {
    utm_source: '  Google  Ads  ',
    utm_medium: ' CPC ',
    utm_campaign: ' Q3-Launch ',
    utm_term: ' PLC Manual ',
    utm_content: 'AdVariant',
    gclid,
    msclkid,
    latest: {
      utm_source: 'FaceBook',
      utm_medium: 'Email',
      utm_campaign: 'Fall_Sale',
      utm_term: 'Operator Manual',
      utm_content: 'Hero',
      gclid,
      msclkid,
    },
  }));
  assert.deepEqual(lines, ['attribution fields kept: 14']);
  const expected = {
    plan: 'pro',
    attr_utm_source: 'google  ads',
    attr_utm_medium: 'cpc',
    attr_utm_campaign: 'q3-launch',
    attr_utm_term: 'PLC Manual',
    attr_utm_content: 'AdVariant',
    attr_gclid: gclid,
    attr_msclkid: msclkid,
    attr_latest_utm_source: 'facebook',
    attr_latest_utm_medium: 'email',
    attr_latest_utm_campaign: 'fall_sale',
    attr_latest_utm_term: 'Operator Manual',
    attr_latest_utm_content: 'Hero',
    attr_latest_gclid: gclid,
    attr_latest_msclkid: msclkid,
  };
  assert.deepEqual(value.metadata, expected);
  assert.deepEqual(value.subscription_data.metadata, expected);
  assert.equal(value.metadata.attr_gclid, gclid);
  assert.equal(value.metadata.attr_msclkid, msclkid);
});

test('subscription checkout copies attribution onto subscription_data.metadata', () => {
  const { value, lines } = captureLog(() => withAttribution(checkoutParams('pro', env), {
    utm_source: 'partner',
    utm_medium: 'email',
    utm_campaign: 'october',
    landing_path: '/pricing?plan=pro',
    first_seen_at: '2026-10-01T00:00:00+00:00',
  }));
  assert.deepEqual(lines, ['attribution fields kept: 5']);
  const expected = {
    plan: 'pro',
    attr_utm_source: 'partner',
    attr_utm_medium: 'email',
    attr_utm_campaign: 'october',
    attr_landing_path: '/pricing',
    attr_first_seen_at: '2026-10-01T00:00:00+00:00',
  };
  assert.equal(value.mode, 'subscription');
  assert.deepEqual(value.metadata, expected);
  assert.deepEqual(value.subscription_data.metadata, expected);
  assert.equal(value.payment_method_types, undefined);
  assert.match(value.integration_identifier, /manualos_pro_[a-z]{8}$/);
  assertSafeMetadata(value.subscription_data.metadata);
});

function baseEnv() {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
  };
}

function mockStripe() {
  const creates = [];
  return {
    creates,
    stripe: {
      checkout: {
        sessions: {
          async create(params) {
            creates.push(params);
            return { id: 'cs_test_attr', url: 'https://checkout.stripe.com/c/pay/cs_test_attr' };
          },
        },
      },
    },
  };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('create-checkout-session forwards sanitized attribution through mocked Stripe', async () => {
  const harness = mockStripe();
  const app = createApp({ env: baseEnv(), stripe: harness.stripe, anthropic: null });
  const logs = [];
  const original = console.log;
  console.log = (...args) => {
    logs.push(args.map((part) => String(part)).join(' '));
  };
  try {
    await withServer(app, async (base) => {
      const pro = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: 'pro',
          attribution: {
            utm_source: 'google',
            utm_campaign: 'buyer@example.com',
            unknown: 'drop-me',
            landing_path: '/pricing?plan=pro',
          },
        }),
      });
      assert.equal(pro.status, 200);
      assert.deepEqual(Object.keys(await pro.json()), ['url']);
      assert.equal(harness.creates.length, 1);
      assert.equal(harness.creates[0].mode, 'subscription');
      assert.equal(harness.creates[0].metadata.plan, 'pro');
      assert.equal(harness.creates[0].metadata.attr_utm_source, 'google');
      assert.equal(harness.creates[0].metadata.attr_landing_path, '/pricing');
      assert.equal(harness.creates[0].metadata.attr_utm_campaign, undefined);
      assert.deepEqual(harness.creates[0].subscription_data.metadata, harness.creates[0].metadata);
      assert.equal(JSON.stringify(harness.creates[0]).includes('buyer@example.com'), false);
      assert.equal(JSON.stringify(harness.creates[0]).includes('drop-me'), false);

      const starter = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'starter' }),
      });
      assert.equal(starter.status, 200);
      assert.deepEqual(harness.creates[1].metadata, { plan: 'starter' });
      assert.deepEqual(harness.creates[1].payment_intent_data.metadata, { plan: 'starter', manuals_used: '0' });
      assert.equal(harness.creates[1].subscription_data, undefined);

      const invalid = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'starter', attribution: { utm_source: 12, utm_medium: 'cpc' } }),
      });
      assert.equal(invalid.status, 200);
      assert.deepEqual(harness.creates[2].metadata, { plan: 'starter', attr_utm_medium: 'cpc' });

      const badPlan = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'enterprise', attribution: { utm_source: 'google' } }),
      });
      assert.equal(badPlan.status, 400);
      assert.equal(harness.creates.length, 3);
    });
  } finally {
    console.log = original;
  }
  assert.deepEqual(logs.filter((line) => line.startsWith('attribution fields kept')), [
    'attribution fields kept: 2',
    'attribution fields kept: 1',
  ]);
  assert.equal(logs.join('\n').includes('buyer@example.com'), false);
  assert.equal(logs.join('\n').includes('google'), false);
});
