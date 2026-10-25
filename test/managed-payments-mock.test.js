const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { spawn } = require('child_process');
const Stripe = require('stripe');
const { checkoutParams } = require('../lib/billing');
const { withCheckoutPolicy } = require('../lib/checkoutPolicy');
const { TOP_LEVEL_CONFLICTS } = require('../lib/managedPayments');

function mockBinary() {
  const candidates = [
    process.env.STRIPE_MOCK_BIN,
    '/tmp/stripe-mock/stripe-mock',
    '/home/box/stripe-mock/stripe-mock',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

const binary = mockBinary();
const PORT = 12121;

function form(body) {
  return new URLSearchParams(String(body || ''));
}

function absent(params, key) {
  assert.equal(params.has(key), false, key);
}

async function waitForMock(port) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/products?limit=1`, {
        headers: { Authorization: 'Bearer sk_test_mock' },
      });
      if (response.status < 500) return;
      lastError = new Error(`stripe-mock status ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw lastError || new Error('stripe-mock did not start');
}

function listen(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stripe-mock exited before it listened')), 5000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`stripe-mock exited ${code}`));
    });
    waitForMock(PORT).then(() => {
      clearTimeout(timer);
      child.removeAllListeners('exit');
      resolve();
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('stripe-mock Checkout for Starter and Pro, flag on and off', {
  skip: binary ? false : 'stripe-mock binary not found. Set STRIPE_MOCK_BIN or install stripe-mock at /tmp/stripe-mock/stripe-mock or /home/box/stripe-mock/stripe-mock.',
}, async () => {
  const child = spawn(binary, ['-http-port', String(PORT), '-https-port', String(PORT + 1)], {
    stdio: 'ignore',
  });
  const bodies = [];
  const httpClient = Stripe.createNodeHttpClient();
  const makeRequest = httpClient.makeRequest.bind(httpClient);
  httpClient.makeRequest = (host, port, path, method, headers, requestData, protocol, timeout) => {
    if (String(path).startsWith('/v1/checkout/sessions') && String(method).toUpperCase() === 'POST') {
      bodies.push(String(requestData || ''));
    }
    return makeRequest(host, port, path, method, headers, requestData, protocol, timeout);
  };
  try {
    await listen(child);
    const stripe = new Stripe('sk_test_mock', {
      host: '127.0.0.1',
      port: PORT,
      protocol: 'http',
      httpClient,
    });
    const base = {
      FRONTEND_URL: 'https://manualos.com',
      STRIPE_PRICE_STARTER: 'price_starter',
      STRIPE_PRICE_PRO: 'price_pro',
      STARTER_CREDITS: '3',
    };

    async function send(plan, flag) {
      const sessionEnv = { ...base };
      if (flag !== undefined) sessionEnv.MANUALOS_MANAGED_PAYMENTS = flag;
      const built = checkoutParams(plan, sessionEnv);
      built.metadata.brand = 'manualos';
      if (plan === 'starter') built.payment_intent_data.metadata.brand = 'manualos';
      else built.subscription_data.metadata.brand = 'manualos';
      if (flag === '1') {
        built.custom_text = { submit: { message: 'Refund rule that Managed Payments rejects.' } };
        built.automatic_tax = { enabled: true };
        built.tax_id_collection = { enabled: true };
        built.billing_address_collection = 'required';
        built.payment_method_types = ['card'];
        built.customer_update = { address: 'auto', name: 'auto' };
        built.consent_collection = { terms_of_service: 'required', promotions: 'auto' };
        if (plan === 'starter') {
          built.payment_intent_data.receipt_email = 'buyer@example.com';
          built.payment_intent_data.statement_descriptor = 'MANUALOS';
          built.payment_intent_data.statement_descriptor_suffix = 'MANUALOS';
        } else {
          built.subscription_data.invoice_settings = { description: 'nope' };
          built.subscription_data.default_tax_rates = ['txr_123'];
        }
      }
      const params = withCheckoutPolicy(built, {
        plan,
        env: { ...sessionEnv, CHECKOUT_REQUIRE_TOS: '1' },
      });
      const before = bodies.length;
      const session = await stripe.checkout.sessions.create(params);
      const posted = form(bodies[before]);
      return { params, session, posted };
    }

    for (const plan of ['starter', 'pro']) {
      const on = await send(plan, '1');
      assert.equal(on.session.livemode, false);
      assert.match(on.session.id, /^cs_/);
      assert.equal(on.posted.get('managed_payments[enabled]'), 'true');
      assert.equal(on.posted.get('mode'), plan === 'starter' ? 'payment' : 'subscription');
      assert.equal(on.posted.get('metadata[plan]'), plan);
      assert.equal(on.posted.get('metadata[brand]'), 'manualos');
      assert.equal(on.posted.get('billing_address_collection'), 'required');
      assert.equal(on.session.billing_address_collection, 'required');
      assert.equal(on.posted.get('consent_collection[terms_of_service]'), 'required');
      for (const key of ['custom_text[submit][message]', 'automatic_tax[enabled]', 'tax_id_collection[enabled]', 'payment_method_types[0]', 'customer_update[address]']) {
        absent(on.posted, key);
      }
      for (const key of TOP_LEVEL_CONFLICTS) assert.equal(on.params[key], undefined, `${plan} ${key}`);
      assert.equal(on.params.billing_address_collection, 'required');
      assert.equal(on.params.consent_collection.terms_of_service, 'required');
      assert.equal(on.params.consent_collection.promotions, 'auto');
      assert.equal(on.posted.get('consent_collection[promotions]'), 'auto');
      if (plan === 'starter') {
        absent(on.posted, 'payment_intent_data[receipt_email]');
        absent(on.posted, 'payment_intent_data[statement_descriptor]');
        absent(on.posted, 'payment_intent_data[statement_descriptor_suffix]');
        assert.equal(on.params.payment_intent_data.statement_descriptor_suffix, undefined);
        assert.equal(on.posted.get('payment_intent_data[metadata][brand]'), 'manualos');
        assert.equal(on.posted.get('payment_intent_data[metadata][manuals_used]'), '0');
        assert.match(on.posted.get('payment_intent_data[description]'), /ManualOS Starter/);
      } else {
        absent(on.posted, 'subscription_data[invoice_settings][description]');
        absent(on.posted, 'subscription_data[default_tax_rates][0]');
        assert.equal(on.posted.get('subscription_data[metadata][brand]'), 'manualos');
        assert.match(on.posted.get('subscription_data[description]'), /ManualOS Pro/);
      }

      const off = await send(plan, undefined);
      assert.equal(off.session.livemode, false);
      assert.match(off.session.id, /^cs_/);
      absent(off.posted, 'managed_payments[enabled]');
      assert.equal(off.posted.get('billing_address_collection'), 'required');
      assert.equal(off.session.billing_address_collection, 'required');
      assert.match(off.posted.get('custom_text[submit][message]'), /Refundable until your first manual is delivered/);
      assert.equal(off.posted.get('consent_collection[terms_of_service]'), 'required');
      if (plan === 'pro') {
        assert.match(off.posted.get('custom_text[submit][message]'), /Cancel anytime\.$/);
      } else {
        assert.equal(off.posted.get('custom_text[submit][message]').includes('Cancel anytime.'), false);
      }
      assert.equal(off.posted.get('metadata[brand]'), 'manualos');
      assert.equal(off.params.managed_payments, undefined);
    }

    const explicit = await send('starter', 'true');
    absent(explicit.posted, 'managed_payments[enabled]');
    assert.match(explicit.posted.get('custom_text[submit][message]'), /Refundable until your first manual is delivered/);
    const enabled = await send('pro', '1');
    assert.equal(enabled.posted.get('managed_payments[enabled]'), 'true');
    absent(enabled.posted, 'custom_text[submit][message]');
    absent(enabled.posted, 'subscription_data[invoice_settings][description]');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});
