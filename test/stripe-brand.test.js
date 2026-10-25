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
  applyManualosCheckout,
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
  const id = kind === 'unbranded' ? 'ch_known' : `ch_${tag(type, kind)}`;
  const charge = {
    id,
    object: 'charge',
    metadata: {},
    customer: { id: `cus_${tag(type, kind)}`, metadata: {} },
  };
  if (kind === 'unbranded') {
    charge.metadata = {};
    charge.payment_intent = { id: 'pi_known', metadata: { plan: 'starter' } };
    return charge;
  }
  if (kind === 'manualos') charge.metadata = { brand: 'manualos' };
  if (kind === 'htsatlas') charge.metadata = { brand: 'htsatlas' };
  if (kind !== 'blank') charge.payment_intent = `pi_${tag(type, kind)}`;
  return charge;
}

function disputeObject(type, kind) {
  const id = `dp_${tag(type, kind)}`;
  const charge = {
    id: `ch_${tag(type, kind)}`,
    object: 'charge',
    metadata: {},
    customer: { id: `cus_${tag(type, kind)}`, metadata: {} },
  };
  if (kind === 'unbranded') {
    charge.metadata = {};
    charge.payment_intent = { id: 'pi_known', metadata: { plan: 'starter' } };
  } else if (kind === 'manualos') charge.metadata = { brand: 'manualos' };
  else if (kind === 'htsatlas') charge.metadata = { brand: 'htsatlas' };
  return { id, object: 'dispute', metadata: {}, charge };
}

function efwObject(type, kind) {
  const id = `issfr_${tag(type, kind)}`;
  const charge = {
    id: `ch_${tag(type, kind)}`,
    object: 'charge',
    metadata: {},
    customer: { id: `cus_${tag(type, kind)}`, metadata: {} },
  };
  if (kind === 'unbranded') {
    charge.payment_intent = { id: 'pi_known', metadata: { plan: 'starter' } };
  } else if (kind === 'manualos') charge.metadata = { brand: 'manualos' };
  else if (kind === 'htsatlas') charge.metadata = { brand: 'htsatlas' };
  return { id, object: 'radar.early_fraud_warning', metadata: {}, charge };
}

function fixture(type, kind) {
  let object;
  if (type.startsWith('checkout.session.')) object = checkoutObject(type, kind);
  else if (type.startsWith('customer.subscription.')) object = subscriptionObject(type, kind);
  else if (type.startsWith('invoice.')) object = invoiceObject(type, kind);
  else if (type === 'charge.refunded') object = chargeObject(type, kind);
  else if (type === 'charge.dispute.created' || type === 'charge.dispute.closed') object = disputeObject(type, kind);
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
    'charge.dispute.closed',
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
      if (type.startsWith('customer.subscription.') || type.startsWith('invoice.')) {
        assertIgnored(await post(fixture(type, 'unbranded')), `${type} unbranded`);
      } else {
        assertProcessed(await post(fixture(type, 'unbranded')), `${type} unbranded`);
      }
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

    assertProcessed(await post({
      id: 'evt_charge_brand_beats_customer',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_charge_brand',
          object: 'dispute',
          metadata: {},
          charge: {
            id: 'ch_branded',
            object: 'charge',
            metadata: { brand: 'manualos' },
            customer: { id: 'cus_known', metadata: { brand: 'htsatlas' } },
          },
        },
      },
    }), 'charge.dispute.created charge brand');

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

test('charge lookup uses payment intent plan and ignores a later customer brand', async () => {
  const calls = [];
  const stripe = {
    charges: {
      retrieve: async (id) => {
        calls.push(['charge', id]);
        return { id, object: 'charge', metadata: {}, payment_intent: 'pi_known', customer: 'cus_later' };
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        calls.push(['pi', id]);
        return { id, metadata: { plan: 'starter' } };
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
    data: { object: { id: 'dp_pi', object: 'dispute', metadata: {}, charge: 'ch_hidden' } },
  }, { stripe, env });
  assert.equal(ours, 'ours');
  assert.deepEqual(calls, [['charge', 'ch_hidden'], ['pi', 'pi_known']]);

  calls.length = 0;
  const foreignStripe = {
    charges: {
      retrieve: async (id) => {
        calls.push(['charge', id]);
        return {
          id,
          object: 'charge',
          metadata: {},
          customer: { id: 'cus_later', metadata: { brand: 'htsatlas' } },
        };
      },
    },
  };
  const foreign = await classifyStripeEvent({
    type: 'radar.early_fraud_warning.created',
    data: { object: { id: 'issfr_id', object: 'radar.early_fraud_warning', charge: 'ch_foreign' } },
  }, { stripe: foreignStripe, env });
  assert.equal(foreign, 'other');
  assert.deepEqual(calls, [['charge', 'ch_foreign']]);

  const priceOnly = await classifyStripeEvent({
    type: 'invoice.paid',
    data: { object: { id: 'in_price', object: 'invoice', lines: { data: [{ price: 'price_pro' }] } } },
  }, { env });
  assert.equal(priceOnly, 'ours');

  const secretShaped = await classifyStripeEvent({
    type: 'invoice.paid',
    data: { object: { id: 'in_secret', object: 'invoice', lines: { data: [{ price: 'price_from_secret' }] } } },
  }, { env: { ...env, STRIPE_SECRET_KEY: 'price_from_secret', STRIPE_WEBHOOK_SECRET: 'price_from_secret' } });
  assert.equal(secretShaped, 'unknown');

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
    assert.equal(creates[0].customer, undefined);
    assert.equal(creates[0].customer_update, undefined);
    assert.equal(creates[0].customer_creation, 'always');
    assert.equal(creates[0].payment_method_types, undefined);
    assert.deepEqual(customers, []);
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
    charges: {
      retrieve: async (id) => {
        if (id === 'ch_gone') {
          const missing = new Error('No such charge');
          missing.statusCode = 404;
          missing.code = 'resource_missing';
          throw missing;
        }
        throw new Error('sk_live_SHOULD_NOT_LEAK');
      },
    },
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
    assert.equal(checkout.status, 200);
    assert.equal(checkoutText.includes('sk_live_SHOULD_NOT_LEAK'), false);
    assert.equal(writes.includes('sessions.create'), true);
    assert.equal(writes.includes('customers.create'), false);

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

    const brandedDespiteCustomer = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_brand_on_charge',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_branded',
            object: 'charge',
            metadata: { brand: 'manualos' },
            customer: 'cus_foreign',
          },
        },
      }),
    });
    assert.equal(brandedDespiteCustomer.status, 200);
    assert.equal(handled.includes('ran'), true);

    const missingCharge = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_missing_charge',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_missing', object: 'dispute', metadata: {}, charge: 'ch_gone' } },
      }),
    });
    const missingText = await missingCharge.text();
    assert.equal(missingCharge.status, 200);
    assert.equal(missingText.includes('sk_live'), false);
    assert.equal(handled.length, 1);

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
    assert.equal(joined.includes('Stripe customer create failed'), false);
    assert.match(joined, /Webhook classification failed/);
    assert.match(joined, /Webhook brand unknown/);
    assert.match(joined, /Webhook handler failed/);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('managed payments fixtures classify from the charge, payment intent, or invoice', async () => {
  const calls = [];
  const handled = [];
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const missing = (id) => {
    const err = new Error(`No such ${id}`);
    err.statusCode = 404;
    err.code = 'resource_missing';
    throw err;
  };
  const stripe = {
    charges: {
      retrieve: async (id) => {
        calls.push(`charge ${id}`);
        if (id === 'ch_mp') {
          return {
            id,
            object: 'charge',
            metadata: { brand: 'manualos' },
            customer: 'cus_mp',
            payment_intent: 'pi_mp',
          };
        }
        if (id === 'ch_pi_only') {
          return { id, object: 'charge', metadata: {}, customer: 'cus_blank', payment_intent: 'pi_only' };
        }
        if (id === 'ch_renew') {
          return { id, object: 'charge', metadata: {}, customer: 'cus_blank', payment_intent: 'pi_renew' };
        }
        if (id === 'ch_price') {
          return { id, object: 'charge', metadata: {}, customer: null, payment_intent: 'pi_price' };
        }
        if (id === 'ch_product') {
          return { id, object: 'charge', metadata: {}, customer: 'cus_blank', payment_intent: 'pi_product' };
        }
        return missing(id);
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        calls.push(`pi ${id}`);
        if (id === 'pi_only') return { id, metadata: { brand: 'manualos' } };
        if (id === 'pi_plan') return { id, metadata: { plan: 'starter' } };
        if (id === 'pi_renew' || id === 'pi_price' || id === 'pi_product') return { id, metadata: {} };
        return missing(id);
      },
    },
    customers: {
      retrieve: async (id) => {
        calls.push(`customer ${id}`);
        if (id === 'cus_del') return { id, object: 'customer', deleted: true };
        if (id === 'cus_blank' || id === 'cus_mp') return { id, metadata: {} };
        return missing(id);
      },
    },
    invoicePayments: {
      list: async (params) => {
        calls.push(`inpay ${params.payment.payment_intent}`);
        const id = params.payment.payment_intent;
        if (id === 'pi_renew') {
          return {
            data: [{
              status: 'paid',
              invoice: {
                id: 'in_renew',
                metadata: {},
                parent: { subscription_details: { metadata: { plan: 'pro', brand: 'manualos' }, subscription: 'sub_pro' } },
              },
            }],
          };
        }
        if (id === 'pi_price') {
          return {
            data: [{
              status: 'paid',
              invoice: {
                id: 'in_price',
                metadata: {},
                lines: { data: [{ pricing: { price_details: { price: 'price_pro', product: 'prod_pro' } } }] },
              },
            }],
          };
        }
        if (id === 'pi_product') {
          return {
            data: [{
              status: 'paid',
              invoice: {
                id: 'in_product',
                metadata: {},
                lines: { data: [{ pricing: { price_details: { price: 'price_other', product: 'prod_mos' } } }] },
              },
            }],
          };
        }
        return { data: [] };
      },
    },
    prices: {
      retrieve: async (id) => {
        calls.push(`price ${id}`);
        if (id === 'price_other') return { id, lookup_key: null, product: 'prod_mos' };
        if (id === 'price_pro') return { id, lookup_key: null, product: 'prod_pro' };
        return missing(id);
      },
    },
    products: {
      retrieve: async (id) => {
        calls.push(`product ${id}`);
        if (id === 'prod_mos') return { id, metadata: { brand: 'manualos', plan: 'pro' } };
        return { id, metadata: {} };
      },
    },
    subscriptions: {
      retrieve: async (id) => {
        calls.push(`sub ${id}`);
        return { id, metadata: { plan: 'pro' } };
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
    onStripeEvent: async (event) => handled.push(event.id),
  });
  const server = await listen(app);
  async function post(event) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify(event),
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    const chargeBrand = await post({
      id: 'evt_mp_charge',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_mp_inline',
          object: 'charge',
          metadata: { brand: 'manualos', purpose: 'mp_webhook_refund_test' },
          customer: { id: 'cus_mp', metadata: {} },
          payment_intent: 'pi_mp',
        },
      },
    });
    assert.equal(chargeBrand.status, 200);
    assert.deepEqual(handled, ['evt_mp_charge']);

    const dispute = await post({
      id: 'evt_mp_dispute',
      type: 'charge.dispute.created',
      data: { object: { id: 'du_mp', object: 'dispute', metadata: {}, charge: 'ch_mp', payment_intent: 'pi_mp' } },
    });
    assert.equal(dispute.status, 200);
    assert.deepEqual(handled, ['evt_mp_charge', 'evt_mp_dispute']);
    assert.equal(calls.includes('customer cus_mp'), false);

    const piOnly = await post({
      id: 'evt_pi_only',
      type: 'charge.dispute.created',
      data: { object: { id: 'du_pi', object: 'dispute', metadata: {}, charge: 'ch_pi_only' } },
    });
    assert.equal(piOnly.status, 200);
    assert.equal(handled.includes('evt_pi_only'), true);

    const guest = await post({
      id: 'evt_guest',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'du_guest',
          object: 'dispute',
          metadata: {},
          charge: { id: 'ch_guest', object: 'charge', metadata: {}, customer: null, payment_intent: 'pi_plan' },
        },
      },
    });
    assert.equal(guest.status, 200);
    assert.equal(handled.includes('evt_guest'), true);

    const supportRefund = await post({
      id: 'evt_support_refund',
      type: 'refund.created',
      data: {
        object: {
          id: 're_support',
          object: 'refund',
          metadata: { brand: 'manualos' },
          charge: { id: 'ch_hts_refund', object: 'charge', metadata: { brand: 'htsatlas' }, customer: { id: 'cus_blank', metadata: {} } },
        },
      },
    });
    assert.equal(supportRefund.status, 200);
    assert.equal(handled.includes('evt_support_refund'), false);
    assert.equal(logs.some((line) => line.includes('evt_support_refund')), false);

    const beforeRenew = logs.length;
    const renewal = await post({
      id: 'evt_renew',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_renew_inline',
          object: 'charge',
          metadata: {},
          customer: { id: 'cus_blank', metadata: {} },
          payment_intent: 'pi_renew',
        },
      },
    });
    assert.equal(renewal.status, 200);
    assert.equal(handled.includes('evt_renew'), true);
    assert.equal(logs.length, beforeRenew);

    const priced = await post({
      id: 'evt_price',
      type: 'radar.early_fraud_warning.created',
      data: { object: { id: 'issfr_price', object: 'radar.early_fraud_warning', metadata: {}, charge: 'ch_price' } },
    });
    assert.equal(priced.status, 200);
    assert.equal(handled.includes('evt_price'), true);

    const product = await classifyStripeEvent({
      id: 'evt_product',
      type: 'charge.dispute.created',
      data: { object: { id: 'du_product', object: 'dispute', metadata: {}, charge: 'ch_product' } },
    }, { stripe, env });
    assert.equal(product, 'ours');

    const deleted = await post({
      id: 'evt_deleted',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_deleted',
          object: 'charge',
          metadata: {},
          customer: { id: 'cus_del', object: 'customer', deleted: true },
        },
      },
    });
    assert.equal(deleted.status, 200);
    assert.equal(handled.includes('evt_deleted'), false);
    assert.equal(logs.some((line) => line.includes('Webhook brand unknown') && line.includes('evt_deleted') && line.includes('ch_deleted')), true);

    const gone = await post({
      id: 'evt_gone',
      type: 'charge.refunded',
      data: { object: { id: 'ch_customer_gone', object: 'charge', metadata: {}, customer: 'cus_gone' } },
    });
    assert.equal(gone.status, 200);
    assert.equal(handled.includes('evt_gone'), false);
    assert.equal(logs.some((line) => line.includes('evt_gone')), true);

    stripe.customers.retrieve = async () => {
      const err = new Error('sk_live_SHOULD_NOT_LEAK');
      err.statusCode = 500;
      throw err;
    };
    const down = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_down',
        type: 'charge.refunded',
        data: { object: { id: 'ch_down', object: 'charge', metadata: {}, customer: 'cus_down' } },
      }),
    });
    const downText = await down.text();
    assert.equal(down.status, 500);
    assert.equal(downText.includes('sk_live'), false);
    assert.equal(handled.includes('evt_down'), false);
    assert.equal(logs.join('\n').includes('sk_live'), false);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('plan=pro alone is not ManualOS and a starter PaymentIntent still is', async () => {
  const proOnly = await classifyStripeEvent({
    type: 'invoice.paid',
    data: { object: { id: 'in_pro_only', object: 'invoice', metadata: { plan: 'pro' } } },
  }, { env });
  assert.equal(proOnly, 'unknown');

  const proOnIntent = await classifyStripeEvent({
    type: 'charge.refunded',
    data: {
      object: {
        id: 'ch_pro_only',
        object: 'charge',
        metadata: {},
        payment_intent: { id: 'pi_pro_only', metadata: { plan: 'pro' } },
      },
    },
  }, { env });
  assert.equal(proOnIntent, 'unknown');

  const proBrand = await classifyStripeEvent({
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_pro_brand', object: 'subscription', metadata: { plan: 'pro', brand: 'manualos' } } },
  }, { env });
  assert.equal(proBrand, 'ours');

  const proPrice = await classifyStripeEvent({
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_pro_price',
        object: 'invoice',
        metadata: { plan: 'pro' },
        lines: { data: [{ price: 'price_pro' }] },
      },
    },
  }, { env });
  assert.equal(proPrice, 'ours');

  const proLookup = await classifyStripeEvent({
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_pro_lookup',
        object: 'invoice',
        metadata: { plan: 'pro' },
        lines: { data: [{ price: { id: 'price_other', lookup_key: 'manualos_pro' } }] },
      },
    },
  }, { env });
  assert.equal(proLookup, 'ours');

  const starterIntent = await classifyStripeEvent({
    type: 'charge.refunded',
    data: {
      object: {
        id: 'ch_starter_legacy',
        object: 'charge',
        metadata: {},
        payment_intent: { id: 'pi_starter_legacy', metadata: { plan: 'starter' } },
      },
    },
  }, { env });
  assert.equal(starterIntent, 'ours');
});

test('integrator overage checkout keeps a caller-set customer and drops customer_update', async () => {
  const created = [];
  const stripe = {
    customers: {
      create: async (params) => {
        created.push(params);
        return { id: 'cus_created' };
      },
    },
    prices: { list: async () => ({ data: [] }) },
  };
  const overage = await applyManualosCheckout(stripe, {
    mode: 'payment',
    customer: ' cus_test123 ',
    customer_update: { name: 'auto' },
    metadata: {
      plan: 'integrator_overage',
      kind: 'overage',
      brand: 'manualos',
    },
    payment_intent_data: {
      description: 'ManualOS Integrator: one extra manual',
      metadata: { plan: 'integrator_overage', kind: 'overage', brand: 'manualos' },
    },
  }, 'integrator_overage');
  assert.equal(overage.customer, 'cus_test123');
  assert.equal(overage.customer_update, undefined);
  assert.deepEqual(created, []);

  const empty = await applyManualosCheckout(stripe, {
    customer: '   ',
    customer_update: { address: 'auto' },
    metadata: { plan: 'integrator_overage' },
  }, 'overage');
  assert.equal(empty.customer, undefined);
  assert.equal(empty.customer_update, undefined);

  const starter = await applyManualosCheckout(stripe, checkoutParams('starter', env), 'starter');
  assert.equal(starter.customer, undefined);
  assert.equal(starter.customer_update, undefined);
  assert.equal(starter.customer_creation, 'always');

  const pro = await applyManualosCheckout(stripe, {
    ...checkoutParams('pro', env),
    customer_update: { name: 'auto' },
  }, 'pro');
  assert.equal(pro.customer, undefined);
  assert.equal(pro.customer_update, undefined);
});

test('integrator overage charge with a customer is ManualOS and an HTS customer is ignored', async () => {
  const handled = [];
  const customerReads = [];
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map(String).join(' '));
  const stripe = {
    customers: {
      create: async () => {
        throw new Error('customers.create');
      },
      retrieve: async (id) => {
        customerReads.push(id);
        if (id === 'cus_hts') return { id, metadata: { brand: 'htsatlas' } };
        return { id, metadata: {} };
      },
    },
    paymentIntents: {
      retrieve: async (id) => {
        if (id === 'pi_over_pi') return { id, metadata: { brand: 'manualos', plan: 'integrator' } };
        if (id === 'pi_over_session') return { id, metadata: {} };
        return { id, metadata: {} };
      },
    },
    checkout: {
      sessions: {
        list: async ({ payment_intent: paymentIntentId }) => {
          if (paymentIntentId === 'pi_over_session') {
            return {
              data: [{
                id: 'cs_over',
                object: 'checkout.session',
                customer: 'cus_test123',
                metadata: { brand: 'manualos', plan: 'integrator', kind: 'overage', subscription_id: 'sub_int' },
              }],
            };
          }
          return { data: [] };
        },
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
    onStripeEvent: async (event) => handled.push(event.id),
  });
  const server = await listen(app);
  async function post(event) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify(event),
    });
    return { status: response.status, body: await response.json() };
  }
  const integratorMeta = {
    brand: 'manualos',
    plan: 'integrator',
    kind: 'overage',
    subscription_id: 'sub_int',
  };
  try {
    const onCharge = await post({
      id: 'evt_over_charge',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_over_charge',
          object: 'charge',
          customer: 'cus_test123',
          metadata: integratorMeta,
          payment_intent: { id: 'pi_over_charge', metadata: integratorMeta },
        },
      },
    });
    assert.equal(onCharge.status, 200);
    assert.equal(handled.includes('evt_over_charge'), true);

    const onIntent = await post({
      id: 'evt_over_pi',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_over_pi',
          object: 'charge',
          customer: 'cus_test123',
          metadata: {},
          payment_intent: 'pi_over_pi',
        },
      },
    });
    assert.equal(onIntent.status, 200);
    assert.equal(handled.includes('evt_over_pi'), true);

    const onSession = await post({
      id: 'evt_over_session',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_over_session',
          object: 'charge',
          customer: 'cus_test123',
          metadata: {},
          payment_intent: 'pi_over_session',
        },
      },
    });
    assert.equal(onSession.status, 200);
    assert.equal(handled.includes('evt_over_session'), true);

    const htsCustomerOnManualos = await post({
      id: 'evt_over_hts_customer',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_over_hts_customer',
          object: 'charge',
          customer: { id: 'cus_hts', metadata: { brand: 'htsatlas' }, email: 'buyer@example.com' },
          metadata: integratorMeta,
          payment_intent: { id: 'pi_over_hts_customer', metadata: integratorMeta },
        },
      },
    });
    assert.equal(htsCustomerOnManualos.status, 200);
    assert.equal(handled.includes('evt_over_hts_customer'), true);

    const beforeHts = logs.length;
    const htsBrand = await post({
      id: 'evt_over_hts',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_over_hts',
          object: 'charge',
          customer: 'cus_hts',
          metadata: { brand: 'htsatlas', plan: 'integrator', kind: 'overage' },
          payment_intent: {
            id: 'pi_over_hts',
            metadata: { brand: 'htsatlas', plan: 'integrator', kind: 'overage' },
          },
        },
      },
    });
    assert.equal(htsBrand.status, 200);
    assert.equal(handled.includes('evt_over_hts'), false);
    assert.equal(logs.length, beforeHts);

    const htsReused = await post({
      id: 'evt_hts_reused',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_hts_reused',
          object: 'charge',
          customer: { id: 'cus_hts', metadata: { brand: 'htsatlas' }, email: 'buyer@example.com' },
          metadata: {},
        },
      },
    });
    assert.equal(htsReused.status, 200);
    assert.equal(handled.includes('evt_hts_reused'), false);
    assert.equal(logs.some((line) => line.includes('evt_hts_reused')), false);
    assert.deepEqual(customerReads, []);
  } finally {
    console.error = originalError;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unknown money events are recorded for dashboard replay and counted on health', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-unknown-'));
  const handled = [];
  const app = createApp({
    env: { ...env, DATA_DIR: dir },
    stripe: { webhooks: { constructEvent } },
    anthropic: null,
    jobs: {},
    supportStore: {},
    onStripeEvent: async (event) => handled.push(event.id),
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_unknown_1',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_unknown_1',
            object: 'charge',
            metadata: {},
            customer: 'cus_secret',
            billing_details: { email: 'buyer@example.com' },
          },
        },
      }),
    });
    assert.equal(first.status, 200);
    const second = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_unknown_2',
        type: 'invoice.paid',
        data: { object: { id: 'in_unknown_2', object: 'invoice', metadata: { plan: 'pro' } } },
      }),
    });
    assert.equal(second.status, 200);
    const foreign = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_foreign_quiet',
        type: 'charge.refunded',
        data: { object: { id: 'ch_foreign_quiet', object: 'charge', metadata: { brand: 'htsatlas' } } },
      }),
    });
    assert.equal(foreign.status, 200);
    assert.deepEqual(handled, []);

    const file = path.join(dir, 'unknown-events.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const rows = lines.map((line) => JSON.parse(line));
    assert.deepEqual(Object.keys(rows[0]).sort(), ['eventId', 'objectId', 'timestamp', 'type']);
    assert.equal(rows[0].eventId, 'evt_unknown_1');
    assert.equal(rows[0].type, 'charge.refunded');
    assert.equal(rows[0].objectId, 'ch_unknown_1');
    assert.match(rows[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(rows[1].eventId, 'evt_unknown_2');
    assert.equal(rows[1].type, 'invoice.paid');
    assert.equal(rows[1].objectId, 'in_unknown_2');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.includes('buyer@example.com'), false);
    assert.equal(raw.includes('cus_secret'), false);
    assert.equal(raw.includes('evt_foreign_quiet'), false);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).unknownEvents, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Pro dispute retrieves the charge once', async () => {
  const chargeReads = [];
  const stripe = {
    charges: {
      retrieve: async (id) => {
        chargeReads.push(id);
        return {
          id,
          object: 'charge',
          metadata: {},
          invoice: 'in_pro',
          payment_intent: 'pi_pro_dispute',
          customer: 'cus_pro',
        };
      },
    },
    paymentIntents: {
      retrieve: async (id) => ({ id, metadata: { brand: 'manualos', plan: 'pro' } }),
    },
    invoices: {
      retrieve: async (id) => ({ id, subscription: 'sub_pro', metadata: {} }),
    },
    subscriptions: {
      retrieve: async (id) => ({
        id,
        status: 'active',
        metadata: { plan: 'pro', brand: 'manualos' },
        latest_invoice: 'in_pro',
      }),
      update: async () => ({ id: 'sub_pro', metadata: {} }),
    },
    checkout: { sessions: { list: async () => ({ data: [] }) } },
    webhooks: { constructEvent },
  };
  const app = createApp({
    env,
    stripe,
    anthropic: null,
    jobs: {},
    supportStore: {},
  });
  const server = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_pro_dispute_once',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_pro_once', object: 'dispute', metadata: {}, charge: 'ch_pro_once' } },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(chargeReads, ['ch_pro_once']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
