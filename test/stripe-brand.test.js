const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkoutParams } = require('../lib/billing');
const { createApp } = require('../server');
const {
  BRAND,
  HANDLED_EVENT_TYPES,
  LOOKUP_KEYS,
  classifyStripeEvent,
} = require('../lib/stripeBrand');

const env = {
  NODE_ENV: 'test',
  FRONTEND_URL: 'https://manualos.com',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STARTER_CREDITS: '3',
};

function tag(type, kind) {
  return `${kind}_${type.replace(/[^a-z0-9]+/gi, '_')}`;
}

function checkoutObject(type, kind) {
  const id = `cs_${tag(type, kind)}`;
  const customer = `cus_${tag(type, kind)}`;
  if (kind === 'blank') {
    return { id, object: 'checkout.session', payment_status: 'unpaid', customer, metadata: {} };
  }
  if (kind === 'manualos') {
    return {
      id,
      object: 'checkout.session',
      payment_status: 'paid',
      customer,
      metadata: { brand: 'manualos', plan: 'starter' },
      payment_intent: `pi_${tag(type, kind)}`,
    };
  }
  if (kind === 'htsatlas') {
    return {
      id,
      object: 'checkout.session',
      payment_status: 'paid',
      customer,
      metadata: { brand: 'htsatlas', plan: 'starter' },
      payment_intent: `pi_${tag(type, kind)}`,
    };
  }
  return {
    id,
    object: 'checkout.session',
    payment_status: 'paid',
    customer,
    metadata: { plan: 'starter' },
  };
}

function subscriptionObject(type, kind) {
  const id = `sub_${tag(type, kind)}`;
  if (kind === 'blank') return { id, object: 'subscription', status: 'active', metadata: {} };
  if (kind === 'manualos') {
    return { id, object: 'subscription', status: 'active', metadata: { brand: 'manualos', plan: 'pro' } };
  }
  if (kind === 'htsatlas') {
    return {
      id,
      object: 'subscription',
      status: 'active',
      metadata: { brand: 'htsatlas', plan: 'pro' },
      items: { data: [{ price: { id: 'price_pro', lookup_key: 'manualos_pro' } }] },
    };
  }
  return { id, object: 'subscription', status: 'active', metadata: { plan: 'pro' } };
}

function invoiceObject(type, kind) {
  const id = `in_${tag(type, kind)}`;
  if (kind === 'blank') return { id, object: 'invoice', metadata: {} };
  if (kind === 'manualos') return { id, object: 'invoice', metadata: { brand: 'manualos' } };
  if (kind === 'htsatlas') {
    return {
      id,
      object: 'invoice',
      metadata: { brand: 'htsatlas', plan: 'pro' },
      lines: { data: [{ price: { id: 'price_pro', lookup_key: 'manualos_pro' } }] },
    };
  }
  return {
    id,
    object: 'invoice',
    parent: { subscription_details: { metadata: { plan: 'pro' } } },
  };
}

function chargeObject(type, kind) {
  if (kind === 'unbranded') {
    return {
      id: 'ch_known',
      object: 'charge',
      customer: { id: 'cus_legacy_charge', metadata: {} },
      payment_intent: 'pi_known',
    };
  }
  const id = `ch_${tag(type, kind)}`;
  const customer = { id: `cus_${tag(type, kind)}`, metadata: {} };
  if (kind === 'manualos') customer.metadata.brand = 'manualos';
  if (kind === 'htsatlas') customer.metadata.brand = 'htsatlas';
  return { id, object: 'charge', customer, payment_intent: `pi_${tag(type, kind)}` };
}

function disputeObject(type, kind) {
  if (kind === 'unbranded') {
    return { id: `dp_${tag(type, kind)}`, object: 'dispute', charge: 'ch_known' };
  }
  const customer = { id: `cus_${tag(type, kind)}`, metadata: {} };
  if (kind === 'manualos') customer.metadata.brand = 'manualos';
  if (kind === 'htsatlas') customer.metadata.brand = 'htsatlas';
  return {
    id: `dp_${tag(type, kind)}`,
    object: 'dispute',
    charge: { id: `ch_${tag(type, kind)}`, customer },
  };
}

function efwObject(type, kind) {
  if (kind === 'unbranded') {
    return {
      id: `issfr_${tag(type, kind)}`,
      object: 'radar.early_fraud_warning',
      charge: `ch_${tag(type, kind)}`,
      payment_intent: 'pi_known',
    };
  }
  const customer = { id: `cus_${tag(type, kind)}`, metadata: {} };
  if (kind === 'manualos') customer.metadata.brand = 'manualos';
  if (kind === 'htsatlas') customer.metadata.brand = 'htsatlas';
  return {
    id: `issfr_${tag(type, kind)}`,
    object: 'radar.early_fraud_warning',
    charge: { id: `ch_${tag(type, kind)}`, customer },
  };
}

function fixture(type, kind) {
  let object;
  if (type.startsWith('checkout.session.')) object = checkoutObject(type, kind);
  else if (type.startsWith('customer.subscription.')) object = subscriptionObject(type, kind);
  else if (type.startsWith('invoice.')) object = invoiceObject(type, kind);
  else if (type === 'charge.refunded') object = chargeObject(type, kind);
  else if (type === 'charge.dispute.created') object = disputeObject(type, kind);
  else object = efwObject(type, kind);
  return { id: `evt_${tag(type, kind)}`, type, data: { object } };
}

function constructEvent(body, signature, secret) {
  if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') {
    throw new Error('SUPER_SECRET_SIGNATURE_DETAIL');
  }
  return JSON.parse(Buffer.from(body).toString('utf8'));
}

function writing(writes, name) {
  return async () => {
    writes.push(name);
    throw new Error(`unexpected stripe write ${name}`);
  };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server;
}

test('checkout params stamp manualos on the session, payment, and subscription', () => {
  const starter = checkoutParams('starter', env);
  const pro = checkoutParams('pro', env);
  assert.equal(BRAND, 'manualos');
  assert.equal(starter.metadata.brand, 'manualos');
  assert.equal(starter.payment_intent_data.metadata.brand, 'manualos');
  assert.equal(starter.subscription_data, undefined);
  assert.equal(pro.metadata.brand, 'manualos');
  assert.equal(pro.subscription_data.metadata.brand, 'manualos');
  assert.deepEqual(LOOKUP_KEYS, { starter: 'manualos_starter', pro: 'manualos_pro' });
  assert.equal(starter.payment_method_types, undefined);
  assert.equal(pro.payment_method_types, undefined);
});

test('webhook brand matrix for every handled event', async () => {
  assert.deepEqual(HANDLED_EVENT_TYPES, [
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_failed',
    'charge.refunded',
    'charge.dispute.created',
    'radar.early_fraud_warning.created',
  ]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-brand-'));
  const handled = [];
  const emails = [];
  const writes = [];
  const reads = [];
  const knownChargeIds = new Set(['ch_known', 'pi_known']);
  const knownCustomerIds = new Set(['cus_known']);

  const stripe = {
    checkout: { sessions: { create: writing(writes, 'sessions.create'), update: writing(writes, 'sessions.update') } },
    customers: {
      create: writing(writes, 'customers.create'),
      update: writing(writes, 'customers.update'),
      retrieve: async (id) => {
        reads.push(id);
        throw new Error('customer retrieve was not expected');
      },
    },
    charges: {
      retrieve: async (id) => {
        reads.push(id);
        throw new Error('charge retrieve was not expected');
      },
      update: writing(writes, 'charges.update'),
    },
    paymentIntents: {
      retrieve: writing(writes, 'paymentIntents.retrieve'),
      update: writing(writes, 'paymentIntents.update'),
    },
    subscriptions: { update: writing(writes, 'subscriptions.update') },
    prices: { list: writing(writes, 'prices.list') },
    webhooks: { constructEvent },
  };
  const mailer = {
    sendMail: async (message) => {
      emails.push(message);
    },
  };
  const app = createApp({
    env,
    stripe,
    anthropic: null,
    jobs: {},
    supportStore: {},
    mailer,
    knownChargeIds,
    knownCustomerIds,
    onStripeEvent: async (event) => {
      handled.push(event.type);
      fs.writeFileSync(path.join(dir, `${handled.length}.txt`), event.type);
      await mailer.sendMail({ subject: event.type });
    },
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function post(event) {
    const before = {
      handled: handled.length,
      emails: emails.length,
      files: fs.readdirSync(dir).length,
      writes: writes.length,
      reads: reads.length,
      charges: knownChargeIds.size,
      customers: knownCustomerIds.size,
    };
    const response = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify(event),
    });
    const body = await response.json();
    return {
      status: response.status,
      body,
      before,
      after: {
        handled: handled.length,
        emails: emails.length,
        files: fs.readdirSync(dir).length,
        writes: writes.length,
        reads: reads.length,
        charges: knownChargeIds.size,
        customers: knownCustomerIds.size,
      },
    };
  }

  function assertIgnored(result, label) {
    assert.equal(result.status, 200, label);
    assert.deepEqual(result.body, { received: true }, label);
    assert.equal(result.after.handled, result.before.handled, label);
    assert.equal(result.after.emails, result.before.emails, label);
    assert.equal(result.after.files, result.before.files, label);
    assert.equal(result.after.writes, result.before.writes, label);
    assert.equal(result.after.reads, result.before.reads, label);
    assert.equal(result.after.charges, result.before.charges, label);
    assert.equal(result.after.customers, result.before.customers, label);
  }

  function assertProcessed(result, label) {
    assert.equal(result.status, 200, label);
    assert.deepEqual(result.body, { received: true }, label);
    assert.equal(result.after.handled, result.before.handled + 1, label);
    assert.equal(result.after.emails, result.before.emails + 1, label);
    assert.equal(result.after.files, result.before.files + 1, label);
    assert.equal(result.after.writes, 0, label);
    assert.equal(result.after.reads, result.before.reads, label);
    assert.equal(handled[handled.length - 1], label.split(' ')[0], label);
  }

  try {
    for (const type of HANDLED_EVENT_TYPES) {
      assertProcessed(await post(fixture(type, 'manualos')), `${type} manualos`);
      assertIgnored(await post(fixture(type, 'htsatlas')), `${type} htsatlas`);
      assertProcessed(await post(fixture(type, 'unbranded')), `${type} unbranded`);
      assertIgnored(await post(fixture(type, 'blank')), `${type} blank`);
    }

    assertIgnored(await post({
      id: 'evt_other_brand',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_other', object: 'checkout.session', metadata: { brand: 'contoso', plan: 'starter' } } },
    }), 'contoso');

    assertIgnored(await post({
      id: 'evt_lookup_hts',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_lookup_hts',
          object: 'invoice',
          metadata: { plan: 'starter' },
          lines: { data: [{ price: { id: 'price_hts', lookup_key: 'htsatlas_starter' } }] },
        },
      },
    }), 'htsatlas lookup key');

    assertProcessed(await post({
      id: 'evt_lookup_mos',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_lookup_mos',
          object: 'invoice',
          lines: { data: [{ pricing: { price_details: { price: 'price_other' } }, price: { id: 'price_other', lookup_key: 'manualos_pro' } }] },
        },
      },
    }), 'invoice.payment_failed manualos lookup');

    const knownCharge = await post({
      id: 'evt_known_charge_foreign_customer',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_known_foreign',
          object: 'dispute',
          charge: 'ch_known',
          customer: { id: 'cus_known', metadata: { brand: 'htsatlas' } },
        },
      },
    });
    assertProcessed(knownCharge, 'charge.dispute.created known charge');

    assertIgnored(await post({
      id: 'evt_known_customer_foreign',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_not_recorded',
          object: 'charge',
          customer: { id: 'cus_known', metadata: { brand: 'htsatlas' } },
        },
      },
    }), 'foreign brand wins over known customer');

    assertIgnored(await post({
      id: 'evt_known_customer_unbranded',
      type: 'radar.early_fraud_warning.created',
      data: {
        object: {
          id: 'issfr_known_customer',
          object: 'radar.early_fraud_warning',
          charge: { id: 'ch_not_a_known_charge', customer: { id: 'cus_known', metadata: {} } },
        },
      },
    }), 'known customer without a brand or charge');

    assertIgnored(await post({
      id: 'evt_refund_created_hts',
      type: 'refund.created',
      data: {
        object: {
          id: 're_hts',
          object: 'refund',
          charge: { id: 'ch_refund_hts', customer: { id: 'cus_refund_hts', metadata: { brand: 'htsatlas' } } },
        },
      },
    }), 'refund.created htsatlas');

    assert.equal(writes.length, 0);
    assert.equal(knownCustomerIds.has('cus_htsatlas_checkout_session_completed'), false);
    assert.equal(knownChargeIds.has('ch_htsatlas_charge_refunded'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('charge lookup uses customer brand and a known payment intent', async () => {
  const calls = [];
  const stripe = {
    charges: {
      retrieve: async (id) => {
        calls.push(['charge', id]);
        return { id, object: 'charge', payment_intent: 'pi_known', customer: 'cus_later' };
      },
    },
    customers: {
      retrieve: async (id) => {
        calls.push(['customer', id]);
        return { id, metadata: { brand: 'htsatlas' } };
      },
    },
  };
  const ours = await classifyStripeEvent({
    type: 'charge.dispute.created',
    data: { object: { id: 'dp_pi', object: 'dispute', charge: 'ch_hidden' } },
  }, { stripe, knownChargeIds: new Set(['pi_known']), knownCustomerIds: new Set(['cus_later']) });
  assert.equal(ours, 'ours');
  assert.deepEqual(calls, [['charge', 'ch_hidden']]);

  calls.length = 0;
  const foreign = await classifyStripeEvent({
    type: 'radar.early_fraud_warning.created',
    data: { object: { id: 'issfr_id', object: 'radar.early_fraud_warning', charge: 'ch_foreign' } },
  }, { stripe, knownChargeIds: new Set(), knownCustomerIds: new Set(['cus_later']) });
  assert.equal(foreign, 'other');
  assert.deepEqual(calls, [['charge', 'ch_foreign'], ['customer', 'cus_later']]);

  const priceOnly = await classifyStripeEvent({
    type: 'invoice.paid',
    data: { object: { id: 'in_price', object: 'invoice', lines: { data: [{ price: 'price_pro' }] } } },
  }, { env });
  assert.equal(priceOnly, 'ours');

  const secretShaped = await classifyStripeEvent({
    type: 'invoice.paid',
    data: { object: { id: 'in_secret', object: 'invoice', lines: { data: [{ price: 'price_from_secret' }] } } },
  }, { env: { ...env, STRIPE_SECRET_KEY: 'price_from_secret', STRIPE_WEBHOOK_SECRET: 'price_from_secret' } });
  assert.equal(secretShaped, 'other');

  const missing = await classifyStripeEvent({ id: 'evt_bad', type: 'invoice.paid' }, { env });
  assert.equal(missing, 'other');
});

test('checkout creates a manualos customer and prefers the lookup key', async () => {
  const creates = [];
  const customers = [];
  const lists = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          creates.push(params);
          return { id: 'cs_lookup', url: 'https://checkout.stripe.com/c/pay/cs_lookup' };
        },
      },
    },
    customers: {
      create: async (params) => {
        customers.push(params);
        return { id: 'cus_created' };
      },
    },
    prices: {
      list: async (params) => {
        lists.push(params);
        if (params.lookup_keys[0] === 'manualos_starter') {
          return { data: [{ id: 'price_from_lookup', lookup_key: 'manualos_starter' }] };
        }
        return { data: [] };
      },
    },
    webhooks: { constructEvent },
  };
  const app = createApp({ env, stripe, anthropic: null, jobs: {}, supportStore: {} });
  const server = await listen(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const starter = await fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'starter' }),
    });
    assert.equal(starter.status, 200);
    assert.equal(creates[0].line_items[0].price, 'price_from_lookup');
    assert.equal(creates[0].metadata.brand, 'manualos');
    assert.equal(creates[0].payment_intent_data.metadata.brand, 'manualos');
    assert.equal(creates[0].customer, 'cus_created');
    assert.deepEqual(creates[0].customer_update, { address: 'auto' });
    assert.equal(creates[0].payment_method_types, undefined);
    assert.deepEqual(customers[0], { metadata: { brand: 'manualos' } });
    assert.deepEqual(lists[0], { lookup_keys: ['manualos_starter'], active: true, limit: 1 });

    const pro = await fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    assert.equal(pro.status, 200);
    assert.equal(creates[1].line_items[0].price, 'price_pro');
    assert.equal(creates[1].subscription_data.metadata.brand, 'manualos');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checkout and webhook failures do not echo secrets or apply side effects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-brand-fail-'));
  const writes = [];
  const handled = [];
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => {
    logs.push(args.map(String).join(' '));
    originalError.apply(console, args);
  };
  const knownChargeIds = new Set();
  const stripe = {
    checkout: {
      sessions: {
        create: async () => {
          writes.push('sessions.create');
          return { id: 'cs_x', url: 'https://checkout.stripe.com/c/pay/cs_x' };
        },
      },
    },
    customers: {
      create: async () => {
        throw new Error('sk_live_SHOULD_NOT_LEAK');
      },
      retrieve: async () => {
        throw new Error('sk_live_SHOULD_NOT_LEAK');
      },
      update: writing(writes, 'customers.update'),
    },
    charges: { retrieve: async () => { throw new Error('sk_live_SHOULD_NOT_LEAK'); } },
    prices: {
      list: async () => {
        throw new Error('sk_live_SHOULD_NOT_LEAK');
      },
    },
    webhooks: { constructEvent },
  };
  const app = createApp({
    env,
    stripe,
    anthropic: null,
    jobs: {},
    supportStore: {},
    knownChargeIds,
    onStripeEvent: async () => {
      handled.push('ran');
      fs.writeFileSync(path.join(dir, 'side-effect.txt'), 'nope');
    },
  });
  const server = await listen(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const checkout = await fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'starter' }),
    });
    const checkoutText = await checkout.text();
    assert.equal(checkout.status, 500);
    assert.equal(checkoutText.includes('sk_live_SHOULD_NOT_LEAK'), false);
    assert.equal(writes.includes('sessions.create'), false);

    const priced = stripe.customers.create;
    stripe.customers.create = async () => ({ id: 'cus_ok' });
    const fallback = await fetch(`${base}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    });
    assert.equal(fallback.status, 200);
    stripe.customers.create = priced;

    const failedLookup = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_need_customer',
        type: 'charge.refunded',
        data: { object: { id: 'ch_need', object: 'charge', customer: 'cus_need' } },
      }),
    });
    const failedText = await failedLookup.text();
    assert.equal(failedLookup.status, 500);
    assert.equal(failedText.includes('sk_live'), false);
    assert.deepEqual(JSON.parse(failedText), { error: 'Webhook processing failed' });
    assert.equal(handled.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'side-effect.txt')), false);
    assert.equal(knownChargeIds.has('ch_need'), false);

    const knownStripe = {
      ...stripe,
      customers: {
        ...stripe.customers,
        retrieve: async () => {
          throw new Error('sk_live_SHOULD_NOT_LEAK');
        },
      },
      webhooks: { constructEvent },
    };
    const knownApp = createApp({
      env,
      stripe: knownStripe,
      anthropic: null,
      jobs: {},
      supportStore: {},
      knownChargeIds: new Set(['ch_known']),
      onStripeEvent: async () => {
        handled.push('known');
      },
    });
    const knownServer = await listen(knownApp);
    try {
      const knownBase = `http://127.0.0.1:${knownServer.address().port}`;
      const known = await fetch(`${knownBase}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
        body: JSON.stringify({
          id: 'evt_known_despite_retrieve',
          type: 'charge.refunded',
          data: {
            object: {
              id: 'ch_known',
              object: 'charge',
              customer: 'cus_foreign',
            },
          },
        }),
      });
      assert.equal(known.status, 200);
      assert.equal(handled.includes('known'), true);
    } finally {
      await new Promise((resolve) => knownServer.close(resolve));
    }

    const boom = createApp({
      env,
      stripe,
      anthropic: null,
      jobs: {},
      supportStore: {},
      onStripeEvent: async () => {
        throw new Error('sk_live_SHOULD_NOT_LEAK');
      },
    });
    const boomServer = await listen(boom);
    try {
      const boomBase = `http://127.0.0.1:${boomServer.address().port}`;
      const handlerFailed = await fetch(`${boomBase}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
        body: JSON.stringify({
          id: 'evt_handler',
          type: 'customer.subscription.deleted',
          data: { object: { id: 'sub_handler', object: 'subscription', metadata: { brand: 'manualos' } } },
        }),
      });
      const handlerText = await handlerFailed.text();
      assert.equal(handlerFailed.status, 500);
      assert.equal(handlerText.includes('sk_live'), false);
    } finally {
      await new Promise((resolve) => boomServer.close(resolve));
    }

    const joined = logs.join('\n');
    assert.equal(joined.includes('sk_live'), false);
    assert.match(joined, /Price lookup key search failed/);
    assert.match(joined, /Stripe customer create failed/);
    assert.match(joined, /Webhook classification failed/);
    assert.match(joined, /Webhook handler failed/);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
