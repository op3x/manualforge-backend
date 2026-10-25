const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function appFor(flag) {
  const env = {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STARTER_CREDITS: '3',
  };
  if (flag !== undefined) env.MANUALOS_MANAGED_PAYMENTS = flag;
  return createApp({
    env,
    stripe: { checkout: { sessions: { create: async () => { throw new Error('config must not create a session'); } } } },
    anthropic: null,
  });
}

test('GET /api/checkout-config reports only the Managed Payments flag', async () => {
  const cases = [
    [undefined, false],
    ['', false],
    ['true', false],
    ['0', false],
    ['1', true],
    [' 1 ', true],
  ];
  for (const [flag, enabled] of cases) {
    const server = await listen(appFor(flag));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/checkout-config`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.deepEqual(body, { managedPayments: enabled });
      assert.deepEqual(Object.keys(body), ['managedPayments']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('Managed Payments falls back when a product has no tax code', async () => {
  const calls = [];
  const logs = [];
  const original = console.error;
  console.error = (...args) => {
    logs.push(args.map((part) => String(part)).join(' '));
  };
  const env = {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STARTER_CREDITS: '3',
    MANUALOS_MANAGED_PAYMENTS: '1',
    CHECKOUT_REQUIRE_TOS: '1',
  };
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.push(params);
          return { id: 'cs_fallback', url: 'https://checkout.stripe.com/c/pay/cs_fallback' };
        },
      },
    },
    prices: {
      retrieve: async (id) => ({ id, product: { id: 'prod_bare', tax_code: null } }),
    },
  };
  const server = await listen(createApp({ env, stripe, anthropic: null }));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'starter' }),
    });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].managed_payments, undefined);
    assert.equal(calls[0].billing_address_collection, 'required');
    assert.equal(calls[0].consent_collection.terms_of_service, 'required');
    assert.match(calls[0].custom_text.submit.message, /Refundable until your first manual is delivered/);
    assert.match(logs.join('\n'), /MANAGED PAYMENTS skipped/);
    assert.match(logs.join('\n'), /prod_bare/);
    assert.equal(logs.join('\n').includes('sk_'), false);
  } finally {
    console.error = original;
    await new Promise((resolve) => server.close(resolve));
  }
});
