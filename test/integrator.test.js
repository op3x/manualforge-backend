const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkoutParams, accessFromSession, overageCheckoutParams } = require('../lib/billing');
const {
  applyWebhookEvent,
  creditWindowId,
  readCreditState,
  reserveIntegratorCredit,
  subscriptionIdFromInvoice,
} = require('../lib/integrator');
const { createAccountStore, readBranding } = require('../lib/accounts/store');
const { documentBranding, logoMarkup, normalizeCompanyName, validateLogo } = require('../lib/branding');
const { LOGO_MAX_BYTES } = require('../lib/config');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { createApp } = require('../server');
const { closeBrowser, findChrome, launchOptions, renderPdf } = require('../lib/manual/pdf');
const { fitHeaderLeft } = require('../lib/documents/stamp');

const SECRET = 'sk_test_SUPER_SECRET_KEY';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const L5X = `<?xml version="1.0" encoding="UTF-8"?>
<RSLogix5000Content>
  <Controller Name="Line1">
    <Programs>
      <Program Name="MainProgram">
        <Routines>
          <Routine Name="MainRoutine" Type="RLL"><Rung Number="0"><Text><![CDATA[XIC(Start)OTE(Run);]]></Text></Rung></Routine>
          <Routine Name="FaultRoutine" Type="RLL"><Rung Number="0"><Text><![CDATA[OTE(FaultLamp);]]></Text></Rung></Routine>
        </Routines>
      </Program>
    </Programs>
  </Controller>
</RSLogix5000Content>`;

function env(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_SECRET_KEY: SECRET,
    MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY: 'price_int_month',
    MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL: 'price_int_year',
    MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: 'price_int_over',
    ...extra,
  };
}

function createStripe(metadata = {}, status = 'active') {
  const sub = {
    id: 'sub_int',
    status,
    customer: 'cus_test123',
    current_period_start: 1700000000,
    metadata: {
      plan: 'integrator',
      interval: 'month',
      credit_generation: '0',
      overage_remaining: '0',
      manuals_used: '0',
      credits_granted: '0',
      credit_period: '',
      ...metadata,
    },
  };
  const calls = { create: [], updates: [], payments: {} };
  const stripe = {
    checkout: {
      sessions: {
        create: async (params) => {
          calls.create.push(params);
          return { id: 'cs_created', url: 'https://checkout.stripe.com/c/pay/cs_created' };
        },
        retrieve: async (id) => {
          if (id !== 'cs_test_integrator') {
            const err = new Error('missing');
            err.statusCode = 404;
            err.code = 'resource_missing';
            throw err;
          }
          return {
            id,
            metadata: { plan: 'integrator', interval: sub.metadata.interval || 'month' },
            payment_status: 'paid',
            subscription: sub.id,
            customer: sub.customer,
          };
        },
      },
    },
    subscriptions: {
      retrieve: async (id) => {
        if (id !== sub.id) return { id, status: 'active', metadata: { plan: 'pro' }, customer: 'cus_other123' };
        return structuredClone(sub);
      },
      update: async (id, params) => {
        if (id !== sub.id) throw new Error('unexpected subscription update');
        calls.updates.push(params);
        const meta = { ...sub.metadata };
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        sub.metadata = meta;
        return structuredClone(sub);
      },
    },
    paymentIntents: {
      retrieve: async (id) => structuredClone(calls.payments[id] || { id, metadata: {} }),
      update: async (id, params) => {
        const current = calls.payments[id] || { id, metadata: {} };
        const meta = { ...current.metadata };
        for (const [key, value] of Object.entries(params.metadata || {})) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        calls.payments[id] = { id, metadata: meta };
        return structuredClone(calls.payments[id]);
      },
    },
    webhooks: {
      constructEvent(body, signature, secret) {
        if (signature !== 't=1,v1=ok' || secret !== 'whsec_test') throw new Error('SUPER_SECRET_SIGNATURE_DETAIL');
        return JSON.parse(Buffer.from(body).toString('utf8'));
      },
    },
  };
  return { stripe, sub, calls };
}

function anthropic() {
  return {
    messages: {
      create: async (body) => {
        const name = body.messages[0].content.includes('FaultRoutine') ? 'FaultRoutine' : 'MainRoutine';
        return {
          content: [
            { type: 'thinking', thinking: 'hidden chain' },
            { type: 'text', text: `###ROUTINE### ${name}\n####DETAIL#### Summary: Described ${name}.` },
          ],
        };
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

test('integrator checkout uses monthly and annual prices and does not set payment methods', () => {
  const monthly = checkoutParams('integrator', env(), { interval: 'month' });
  assert.equal(monthly.mode, 'subscription');
  assert.equal(monthly.line_items[0].price, 'price_int_month');
  assert.equal(monthly.line_items[0].quantity, 1);
  assert.deepEqual(monthly.metadata, { plan: 'integrator', interval: 'month' });
  assert.equal(monthly.subscription_data.metadata.plan, 'integrator');
  assert.equal(monthly.subscription_data.metadata.interval, 'month');
  assert.equal(monthly.payment_method_types, undefined);
  assert.equal(monthly.success_url, 'https://manualos.com/upload.html?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(monthly.cancel_url, 'https://manualos.com/#pricing');
  assert.match(monthly.integration_identifier, /manualos_integrator_month_[a-z]{8}$/);

  const annual = checkoutParams('integrator_annual', env());
  assert.equal(annual.line_items[0].price, 'price_int_year');
  assert.equal(annual.metadata.interval, 'year');
  assert.equal(annual.payment_method_types, undefined);
  assert.match(annual.integration_identifier, /manualos_integrator_year_[a-z]{8}$/);
  assert.notEqual(monthly.integration_identifier, annual.integration_identifier);

  const starter = checkoutParams('starter', env());
  assert.equal(starter.mode, 'payment');
  assert.equal(starter.line_items[0].price, 'price_starter');
  assert.deepEqual(starter.metadata, { plan: 'starter' });
  const pro = checkoutParams('pro', env());
  assert.equal(pro.mode, 'subscription');
  assert.deepEqual(pro.subscription_data.metadata, { plan: 'pro' });
});

test('a missing integrator price is a 503 and does not include secret values', () => {
  assert.throws(
    () => checkoutParams('integrator', env({ MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY: '  ' }), { interval: 'month' }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.expose, true);
      assert.match(err.message, /Integrator monthly checkout is temporarily unavailable/);
      assert.equal(err.message.includes(SECRET), false);
      assert.equal(String(err.logMessage).includes(SECRET), false);
      assert.equal(String(err.logMessage).includes('price_int'), false);
      return true;
    }
  );
  assert.throws(
    () => checkoutParams('integrator', env({ MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL: '' }), { interval: 'year' }),
    (err) => err.status === 503 && /annual/.test(err.message)
  );
  assert.throws(() => checkoutParams('integrator', env()), (err) => err.status === 400);
  assert.throws(() => checkoutParams('starter', { FRONTEND_URL: 'https://manualos.com' }), (err) => err.status === 500);
  assert.throws(
    () => overageCheckoutParams(env({ MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: '' }), {
      subscriptionId: 'sub_int',
      customerId: 'cus_test123',
      sessionId: 'cs_test_integrator',
    }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /Integrator overage checkout is temporarily unavailable/);
      assert.equal(err.message.includes(SECRET), false);
      return true;
    }
  );
});

test('monthly credits reset on a new period and do not roll over', () => {
  const anchor = Math.floor(Date.UTC(2026, 0, 15) / 1000);
  const january = {
    status: 'active',
    current_period_start: anchor,
    metadata: {
      plan: 'integrator',
      interval: 'year',
      credit_period: `month:${anchor}:0`,
      credits_granted: '25',
      manuals_used: '10',
      overage_remaining: '2',
    },
  };
  const still = readCreditState(january, env(), Date.UTC(2026, 1, 14));
  assert.equal(still.periodOpen, true);
  assert.equal(still.includedRemaining, 15);
  assert.equal(still.overageRemaining, 2);

  const march = readCreditState(january, env(), Date.UTC(2026, 2, 15));
  assert.equal(march.periodOpen, false);
  assert.equal(march.includedRemaining, 25);
  assert.equal(march.overageRemaining, 2);
  assert.equal(march.window, `month:${anchor}:2`);

  const renewed = {
    status: 'active',
    current_period_start: anchor + 100,
    metadata: {
      plan: 'integrator',
      interval: 'month',
      credit_period: `period:${anchor}`,
      credits_granted: '25',
      manuals_used: '10',
      overage_remaining: '1',
    },
  };
  const nextBill = readCreditState(renewed, env(), Date.UTC(2026, 5, 1));
  assert.equal(nextBill.includedRemaining, 25);
  assert.equal(nextBill.overageRemaining, 1);
  assert.equal(nextBill.window, `period:${anchor + 100}`);

  const onItem = readCreditState({
    status: 'active',
    items: { data: [{ current_period_start: 1800000000, price: { id: 'price_int_month', recurring: { interval: 'month' } } }] },
    metadata: { plan: 'integrator' },
  }, env());
  assert.equal(onItem.window, 'period:1800000000');
});

test('invoice.paid grants 25 credits once per period and cancellation clears them', async () => {
  const { stripe, sub, calls } = createStripe({
    credit_period: 'period:1600000000',
    credits_granted: '25',
    manuals_used: '9',
    overage_remaining: '2',
    credit_generation: '4',
  });
  sub.current_period_start = 1700000000;
  const invoice = {
    id: 'in_1',
    status: 'paid',
    parent: { subscription_details: { subscription: 'sub_int' } },
  };
  await applyWebhookEvent(stripe, { id: 'evt_1', type: 'invoice.paid', data: { object: invoice } }, env());
  assert.equal(sub.metadata.credits_granted, '25');
  assert.equal(sub.metadata.manuals_used, '0');
  assert.equal(sub.metadata.overage_remaining, '2');
  assert.equal(sub.metadata.credit_period, 'period:1700000000');
  const updatesAfterGrant = calls.updates.length;
  await applyWebhookEvent(stripe, { id: 'evt_1b', type: 'invoice.paid', data: { object: invoice } }, env());
  assert.equal(calls.updates.length, updatesAfterGrant);
  assert.equal(sub.metadata.manuals_used, '0');

  sub.metadata.manuals_used = '6';
  await applyWebhookEvent(stripe, { id: 'evt_same', type: 'invoice.paid', data: { object: invoice } }, env());
  assert.equal(sub.metadata.manuals_used, '6');

  const legacy = subscriptionIdFromInvoice({ id: 'in_old', subscription: 'sub_legacy' });
  assert.equal(legacy, 'sub_legacy');
  const modern = subscriptionIdFromInvoice({
    parent: { subscription_details: { subscription: { id: 'sub_modern' } } },
  });
  assert.equal(modern, 'sub_modern');

  const before = calls.updates.length;
  await applyWebhookEvent(stripe, {
    id: 'evt_pro',
    type: 'invoice.paid',
    data: { object: { id: 'in_pro', status: 'paid', subscription: 'sub_pro' } },
  }, env());
  assert.equal(calls.updates.length, before);

  const usedBeforeCancelSchedule = sub.metadata.manuals_used;
  await applyWebhookEvent(stripe, {
    id: 'evt_schedule',
    type: 'customer.subscription.updated',
    data: { object: { id: sub.id, status: 'active', cancel_at_period_end: true, metadata: { plan: 'integrator' } } },
  }, env());
  assert.equal(sub.metadata.manuals_used, usedBeforeCancelSchedule);

  sub.status = 'canceled';
  await applyWebhookEvent(stripe, {
    id: 'evt_cancel',
    type: 'customer.subscription.deleted',
    data: { object: { id: sub.id, status: 'canceled', metadata: { plan: 'integrator', interval: 'month' } } },
  }, env());
  assert.equal(sub.metadata.cancelled, 'true');
  assert.equal(sub.metadata.credits_granted, '0');
  const access = accessFromSession(
    { metadata: { plan: 'integrator' }, payment_status: 'paid' },
    null,
    sub,
    env()
  );
  assert.equal(access.valid, false);
  assert.equal(access.plan, 'integrator');
  assert.equal(access.remaining, null);
});

test('overage checkout is one manual at a time and the webhook grants it once', async () => {
  const { stripe, sub, calls } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '0',
  });
  const event = {
    id: 'evt_over',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_over_1',
        payment_status: 'paid',
        metadata: { plan: 'integrator_overage', subscription_id: sub.id },
      },
    },
  };
  const grantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-overage-once-'));
  const grantEnv = env({ MANUALOS_ACCOUNT_DIR: grantDir });
  await applyWebhookEvent(stripe, event, grantEnv);
  await applyWebhookEvent(stripe, event, grantEnv);
  assert.equal(sub.metadata.overage_remaining, '1');
  await applyWebhookEvent(stripe, {
    id: 'evt_unpaid',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_over_2',
        payment_status: 'unpaid',
        metadata: { plan: 'integrator_overage', subscription_id: sub.id },
      },
    },
  }, env());
  assert.equal(sub.metadata.overage_remaining, '1');

  const march = Date.UTC(2026, 2, 15);
  const anchor = Math.floor(Date.UTC(2026, 0, 15) / 1000);
  sub.current_period_start = anchor;
  sub.metadata.interval = 'year';
  sub.metadata.credit_period = `month:${anchor}:0`;
  sub.metadata.credits_granted = '25';
  sub.metadata.manuals_used = '10';
  sub.metadata.overage_remaining = '2';
  const reserved = await reserveIntegratorCredit(stripe, sub.id, env(), march);
  assert.equal(reserved.bucket, 'included');
  assert.equal(sub.metadata.manuals_used, '1');
  assert.equal(sub.metadata.overage_remaining, '2');
  assert.equal(sub.metadata.credit_period, creditWindowId(sub, env(), march));
  assert.equal(calls.create.length, 0);
});

test('an old overage purchase stays granted after ten newer ones', async () => {
  const { stripe, sub } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '0',
    overage_applied: 'cs_dropped_1,cs_dropped_2,cs_dropped_3,cs_dropped_4,cs_dropped_5,cs_dropped_6',
  });
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-overage-'));
  const replayEnv = env({ MANUALOS_ACCOUNT_DIR: ledgerDir });
  const oldId = 'cs_over_old';
  const paid = (id) => ({
    id: `evt_${id}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id,
        payment_status: 'paid',
        metadata: { plan: 'integrator_overage', subscription_id: sub.id },
      },
    },
  });
  await applyWebhookEvent(stripe, paid(oldId), replayEnv);
  for (let index = 0; index < 10; index += 1) {
    await applyWebhookEvent(stripe, paid(`cs_over_new_${index}`), replayEnv);
  }
  assert.equal(sub.metadata.overage_remaining, '11');
  assert.equal(String(sub.metadata.overage_applied || '').split(',').includes(oldId), false);
  await applyWebhookEvent(stripe, paid(oldId), replayEnv);
  assert.equal(sub.metadata.overage_remaining, '11');
  const grants = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'cus_test123', 'overage-grants.json'), 'utf8'));
  assert.equal(grants[oldId], 'done');
  assert.equal(Object.keys(grants).length, 11);
});

test('a corrupt overage ledger is not treated as empty', async () => {
  const { stripe, sub, calls } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '0',
  });
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-overage-corrupt-'));
  fs.mkdirSync(path.join(ledgerDir, 'cus_test123'));
  fs.writeFileSync(path.join(ledgerDir, 'cus_test123', 'overage-grants.json'), '{');
  const event = {
    id: 'evt_corrupt',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_over_old',
        payment_status: 'paid',
        payment_intent: 'pi_corrupt',
        metadata: { plan: 'integrator_overage', subscription_id: sub.id },
      },
    },
  };
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map((part) => String(part)).join(' '));
  try {
    await assert.rejects(
      () => applyWebhookEvent(stripe, event, env({ MANUALOS_ACCOUNT_DIR: ledgerDir })),
      (err) => err.status === 503 && err.message === 'Extra manual records are temporarily unavailable.'
    );
  } finally {
    console.error = originalError;
  }
  const logged = logs.join('\n');
  assert.match(logged, /overage-grants\.json/);
  assert.equal(logged.includes('cus_test123'), false);
  assert.equal(sub.metadata.overage_remaining, '0');
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.payments.pi_corrupt, undefined);
});

test('a crash after the extra-manual credit still leaves exactly one credit', async () => {
  const { stripe, sub, calls } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '0',
  });
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-overage-pi-'));
  const replayEnv = env({ MANUALOS_ACCOUNT_DIR: ledgerDir });
  const eventFor = (id, paymentIntent) => ({
    id: `evt_${id}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id,
        payment_status: 'paid',
        payment_intent: paymentIntent,
        customer: sub.customer,
        metadata: { plan: 'integrator_overage', subscription_id: sub.id },
      },
    },
  });
  const update = stripe.subscriptions.update;
  let loseResponse = true;
  stripe.subscriptions.update = async (id, params) => {
    const result = await update(id, params);
    if (loseResponse && params.metadata && params.metadata.overage_grant === 'cs_over_crash') {
      loseResponse = false;
      throw new Error('lost response after credit');
    }
    return result;
  };
  await assert.rejects(
    () => applyWebhookEvent(stripe, eventFor('cs_over_crash', 'pi_over_crash'), replayEnv),
    /lost response after credit/
  );
  assert.equal(sub.metadata.overage_remaining, '1');
  assert.equal(sub.metadata.overage_last_pi, 'pi_over_crash');
  assert.equal(calls.payments.pi_over_crash, undefined);
  await applyWebhookEvent(stripe, eventFor('cs_over_crash', 'pi_over_crash'), replayEnv);
  assert.equal(sub.metadata.overage_remaining, '1');
  assert.equal(calls.payments.pi_over_crash.metadata.overage_credit_granted, '1');
  fs.rmSync(path.join(ledgerDir, 'cus_test123', 'overage-grants.json'));
  sub.metadata.overage_grant = 'cs_over_newer';
  delete sub.metadata.overage_last_pi;
  delete calls.payments.pi_over_crash;
  await applyWebhookEvent(stripe, eventFor('cs_over_crash', 'pi_over_crash'), replayEnv);
  assert.equal(sub.metadata.overage_remaining, '1');
  assert.equal(sub.metadata.overage_grant, 'cs_over_newer');
  assert.equal(calls.payments.pi_over_crash.metadata.overage_credit_granted, '1');
});

test('a transient subscription error still grants the extra manual once', async () => {
  const { stripe, sub, calls } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '0',
  });
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-overage-transient-'));
  const replayEnv = env({ MANUALOS_ACCOUNT_DIR: ledgerDir });
  const event = {
    id: 'evt_transient',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_over_transient',
        payment_status: 'paid',
        payment_intent: 'pi_transient',
        customer: sub.customer,
        metadata: { plan: 'integrator_overage', subscription_id: sub.id },
      },
    },
  };
  const update = stripe.subscriptions.update;
  let failed = false;
  stripe.subscriptions.update = async (id, params) => {
    if (!failed && params.metadata && params.metadata.overage_grant === 'cs_over_transient') {
      failed = true;
      const err = new Error('stripe timeout');
      err.statusCode = 500;
      throw err;
    }
    return update(id, params);
  };
  await assert.rejects(() => applyWebhookEvent(stripe, event, replayEnv), /stripe timeout/);
  assert.equal(sub.metadata.overage_remaining, '0');
  assert.equal(calls.payments.pi_transient, undefined);
  await applyWebhookEvent(stripe, event, replayEnv);
  assert.equal(sub.metadata.overage_remaining, '1');
  assert.equal(sub.metadata.overage_last_pi, 'pi_transient');
  assert.equal(calls.payments.pi_transient.metadata.overage_credit_granted, '1');
  await applyWebhookEvent(stripe, event, replayEnv);
  assert.equal(sub.metadata.overage_remaining, '1');
});

test('ten concurrent overage webhooks grant one credit', async () => {
  const { stripe, sub } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '0',
  });
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-overage-race-'));
  const replayEnv = env({ MANUALOS_ACCOUNT_DIR: ledgerDir });
  const event = {
    id: 'evt_race',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_over_race',
        payment_status: 'paid',
        payment_intent: 'pi_race',
        customer: sub.customer,
        metadata: { plan: 'integrator_overage', subscription_id: sub.id },
      },
    },
  };
  await Promise.all(Array.from({ length: 10 }, () => applyWebhookEvent(stripe, event, replayEnv)));
  assert.equal(sub.metadata.overage_remaining, '1');
  assert.equal(sub.metadata.overage_pi.includes('pi_race'), true);
});

test('a webhook failure logs the redacted error', async () => {
  const { stripe } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '0',
  });
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-overage-log-'));
  stripe.subscriptions.retrieve = async () => {
    throw new Error('stripe down sk_test_SECRETVALUE whsec_SECRETVALUE');
  };
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map((part) => String(part)).join(' '));
  try {
    const app = createApp({
      env: env({ MANUALOS_ACCOUNT_DIR: ledgerDir }),
      stripe,
      anthropic: anthropic(),
    });
    await withServer(app, async (base) => {
      const hook = await fetch(base + '/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
        body: JSON.stringify({
          id: 'evt_log',
          type: 'checkout.session.completed',
          data: {
            object: {
              id: 'cs_over_log',
              payment_status: 'paid',
              payment_intent: 'pi_log',
              metadata: { plan: 'integrator_overage', subscription_id: 'sub_int' },
            },
          },
        }),
      });
      assert.equal(hook.status, 500);
      assert.deepEqual(await hook.json(), { error: 'Webhook handler failed' });
    });
  } finally {
    console.error = originalError;
  }
  const logged = logs.join('\n');
  assert.match(logged, /Webhook handler failed \(checkout\.session\.completed\)/);
  assert.match(logged, /stripe down/);
  assert.match(logged, /\[redacted\]/);
  assert.equal(logged.includes('sk_test_SECRETVALUE'), false);
  assert.equal(logged.includes('whsec_SECRETVALUE'), false);
});

test('logos are PNG or SVG, size-capped, and program files are not stored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-accounts-'));
  const accounts = createAccountStore({ directory: dir });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
  const stored = accounts.writeBranding('cus_test123', {
    companyName: 'Sample Integrator',
    logo: validateLogo(svg),
  });
  assert.equal(stored.companyName, 'Sample Integrator');
  assert.equal(stored.logo.type, 'svg');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cus_test123')).sort(), ['branding.json', 'logo.svg']);
  const saved = fs.readFileSync(path.join(dir, 'cus_test123', 'logo.svg'));
  assert.equal(saved.includes(Buffer.from('RSLogix')), false);
  assert.equal(saved.includes(Buffer.from('<script')), false);

  assert.throws(() => validateLogo(Buffer.from(L5X)), (err) => err.status === 400);
  assert.throws(
    () => validateLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script></svg>')),
    (err) => err.status === 400 && err.message === 'Logo SVG is not allowed.'
  );
  const oversized = Buffer.alloc(LOGO_MAX_BYTES + 1);
  PNG.copy(oversized);
  assert.throws(() => validateLogo(oversized), (err) => err.status === 400 && /too large/.test(err.message));
  assert.throws(() => normalizeCompanyName(`<${'A'.repeat(10)}>`), (err) => err.status === 400);
  assert.throws(() => accounts.writeBranding('../cus_test123', {}), (err) => err.status === 400);
  assert.equal(fs.existsSync(path.join(dir, '..', 'cus_test123', 'branding.json')), false);
});

test('white-label manuals replace the product name on the cover, header, and footer', async () => {
  const project = await parseUploads([{ originalname: 'line.L5X', buffer: Buffer.from(L5X) }]);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const plain = renderHtml(buildDocument(project));
  assert.match(plain, /ManualOS/);
  assert.equal(plain.includes('<div class="brand-header">'), false);

  const branding = documentBranding({
    companyName: 'Sample Integrator',
    logo: { type: 'png', buffer: PNG },
  });
  const html = renderHtml(buildDocument(project, { branding }));
  assert.equal(html.includes('ManualOS'), false);
  assert.equal(html.includes('brand-header'), false);
  assert.equal(html.includes('brand-footer'), false);
  assert.match(html, /<div class="publisher">[\s\S]*Sample Integrator/);
  assert.match(html, /<img class="brand-logo"/);
  assert.equal((html.match(/content: "Sample Integrator/g) || []).length >= 2, true);
  assert.equal(html.split(PNG.toString('base64')).length - 1, 1);
});

function crc32(buffer) {
  let crc = ~0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function solidPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = 0x13;
      raw[pixel + 1] = 0x31;
      raw[pixel + 2] = 0x4f;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', require('zlib').deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('the cover warning stays above the footer on branded and plain covers', async () => {
  const puppeteer = require('puppeteer-core');
  const executablePath = findChrome();
  assert.ok(executablePath, 'Chrome is required to measure the cover');
  const project = await parseUploads([{ originalname: 'line.L5X', buffer: fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X')) }]);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const tallSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="400" viewBox="0 0 40 400"><rect width="40" height="400" fill="#13314f"/></svg>');
  const twoLineName = 'North Line Controls International Manufacturing and Service Division of the Northern Works';
  const unbrokenName = `North${'A'.repeat(90)}`;
  const pages = {
    square: documentBranding({ companyName: 'North Line Controls', logo: validateLogo(solidPng(200, 200)) }),
    tall: documentBranding({ companyName: 'North Line Controls', logo: validateLogo(tallSvg) }),
    wrapped: documentBranding({ companyName: twoLineName, logo: validateLogo(solidPng(80, 80)) }),
    unbroken: documentBranding({ companyName: unbrokenName, logo: validateLogo(solidPng(80, 80)) }),
    plain: null,
  };
  const browser = await puppeteer.launch(launchOptions(executablePath));
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 1 });
    await page.emulateMediaType('print');
    for (const [name, branding] of Object.entries(pages)) {
      const html = renderHtml(buildDocument(project, { branding }));
      await page.setContent(html, { waitUntil: 'load' });
      const box = await page.evaluate(() => {
        const rect = (node) => {
          const box = node.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
        };
        const cover = rect(document.querySelector('.cover'));
        const warn = rect(document.querySelector('.cwarn'));
        const foot = rect(document.querySelector('.cfoot'));
        const logo = document.querySelector('.brand-logo');
        const publisher = document.querySelector('.publisher');
        const label = document.querySelector('.publisher-name');
        const inside = (inner, outer) => inner.top >= outer.top - 0.5
          && inner.bottom <= outer.bottom + 0.5
          && inner.left >= outer.left - 0.5
          && inner.right <= outer.right + 0.5;
        const logoBox = logo ? rect(logo) : null;
        const publisherBox = publisher ? rect(publisher) : null;
        const nameBox = label ? rect(label) : null;
        return {
          gap: foot.top - warn.bottom,
          cover,
          warn,
          foot,
          logo: logoBox,
          publisher: publisherBox,
          name: nameBox,
          nameText: label ? label.textContent : '',
          nameClipped: label ? (label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1) : false,
          publisherOverflow: publisher ? getComputedStyle(publisher).overflow : '',
          nameWrap: label ? getComputedStyle(label).overflowWrap : '',
          logoInsidePublisher: logo && publisher ? inside(logoBox, publisherBox) : false,
          nameInsidePublisher: label && publisher ? inside(nameBox, publisherBox) : false,
          publisherInsideCover: publisher ? inside(publisherBox, cover) : false,
          css: document.querySelector('style').textContent,
        };
      });
      assert.ok(box.gap >= 8, `${name} cover gap ${box.gap}px is under 8px`);
      assert.ok(box.foot.bottom <= box.cover.bottom + 0.5, `${name} footer extends past the cover`);
      assert.ok(box.warn.bottom <= box.foot.top - 8, `${name} warning meets the footer`);
      assert.ok(box.foot.top >= box.cover.top, `${name} footer is outside the cover`);
      assert.match(box.css, /@top-right\s*\{[^}]*white-space:\s*nowrap/);
      assert.match(box.css, /@top-left\s*\{[^}]*white-space:\s*nowrap/);
      assert.match(box.css, /@top-left\s*\{[^}]*text-overflow:\s*ellipsis/);
      if (name === 'plain') {
        assert.equal(box.logo, null);
        continue;
      }
      assert.equal(box.publisherOverflow, 'visible');
      assert.equal(box.nameWrap, 'anywhere');
      assert.equal(box.nameClipped, false, `${name} company name is clipped`);
      assert.equal(box.logoInsidePublisher, true, `${name} logo is clipped`);
      assert.equal(box.nameInsidePublisher, true, `${name} name is outside the publisher`);
      assert.equal(box.publisherInsideCover, true, `${name} publisher is clipped by the cover`);
      assert.ok(box.logo.height > 0 && box.logo.height <= 54, `${name} logo height ${box.logo.height}`);
      if (name === 'square') assert.ok(Math.abs(box.logo.width - box.logo.height) < 2, `${name} logo ${box.logo.width}x${box.logo.height}`);
      if (name === 'tall') assert.ok(box.logo.width < box.logo.height * 0.6, `${name} logo ${box.logo.width}x${box.logo.height}`);
      if (name === 'wrapped') {
        assert.equal(box.nameText, twoLineName);
        assert.ok(box.name.height > 30, `${name} name stayed on one line`);
      }
      if (name === 'unbroken') {
        assert.equal(box.nameText, unbrokenName);
        assert.ok(box.name.height > 30, `${name} name stayed on one line`);
      }
    }
  } finally {
    await browser.close();
  }
});

function pdfTextRuns(pdf) {
  const zlib = require('zlib');
  const text = pdf.toString('latin1');
  const runs = [];
  let cursor = 0;
  while (cursor < pdf.length) {
    const start = text.indexOf('stream', cursor);
    if (start < 0) break;
    let dataStart = start + 6;
    if (pdf[dataStart] === 0x0d && pdf[dataStart + 1] === 0x0a) dataStart += 2;
    else if (pdf[dataStart] === 0x0a) dataStart += 1;
    const end = text.indexOf('endstream', dataStart);
    if (end < 0) break;
    let rawEnd = end;
    if (pdf[rawEnd - 1] === 0x0a) rawEnd -= pdf[rawEnd - 2] === 0x0d ? 2 : 1;
    let inflated = null;
    try {
      inflated = zlib.inflateSync(pdf.subarray(dataStart, rawEnd));
    } catch {
      inflated = null;
    }
    if (inflated) {
      const source = inflated.toString('latin1');
      const blocks = source.matchAll(/BT([\s\S]*?)ET/g);
      for (const block of blocks) {
        const body = block[1];
        const placed = body.match(/([0-9.\-]+) ([0-9.\-]+) ([0-9.\-]+) ([0-9.\-]+) ([0-9.\-]+) ([0-9.\-]+) Tm/);
        if (!placed) continue;
        const advances = [...body.matchAll(/([0-9.\-]+) ([0-9.\-]+) Td/g)].map((item) => Number(item[1]));
        const glyphs = (body.match(/<[0-9A-F]+>/gi) || []).length;
        if (glyphs < 4) continue;
        const x = Number(placed[5]);
        const y = Number(placed[6]);
        const endX = x + advances.reduce((sum, width) => sum + width, 0) + 12;
        runs.push({ x, y, end: endX, glyphs });
      }
    }
    cursor = end + 9;
  }
  return runs;
}

function headerGaps(runs) {
  const header = runs.filter((run) => run.y > 20 && run.y < 120);
  const gaps = [];
  for (const right of header) {
    if (right.x < 450) continue;
    for (const left of header) {
      if (left.x > 200 || Math.abs(left.y - right.y) > 25) continue;
      gaps.push(right.x - left.end);
    }
  }
  return gaps;
}

test('a long running header stays clear of Rev. A', async () => {
  const company = 'North Line Controls International Manufacturing and Service Division'.padEnd(80, 'x').slice(0, 80);
  assert.equal(company.length, 80);
  const raw = `${company} · Packaging Conveyor · Operating and Maintenance Manual`;
  const fitted = fitHeaderLeft(raw);
  assert.equal(fitted.endsWith('…'), true);
  assert.ok([...fitted].length <= 110);
  const wide = fitHeaderLeft(`${'N'.repeat(80)} · Packaging Conveyor · Operating and Maintenance Manual`);
  assert.equal(wide.endsWith('…'), true);
  assert.ok([...wide].length < 80);
  assert.equal(fitHeaderLeft('North Line · Line · Operating and Maintenance Manual'), 'North Line · Line · Operating and Maintenance Manual');

  const puppeteer = require('puppeteer-core');
  const executablePath = findChrome();
  assert.ok(executablePath, 'Chrome is required to measure the header');
  const project = await parseUploads([{ originalname: 'line.L5X', buffer: fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X')) }]);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const savedName = project.identity.productName;
  const savedFlag = project.identity.productNameFromUser;
  project.identity.productNameFromUser = true;
  project.identity.productName = 'Packaging Conveyor '.repeat(6).trim();
  const pages = {
    named: documentBranding({ companyName: company }),
    unbroken: documentBranding({ companyName: 'N'.repeat(80) }),
    plain: null,
  };
  const browser = await puppeteer.launch(launchOptions(executablePath));
  try {
    const page = await browser.newPage();
    for (const [name, branding] of Object.entries(pages)) {
      const doc = buildDocument(project, { branding });
      const header = doc.meta.headerLeft;
      assert.ok([...header].length <= 110, `${name} header is ${[...header].length} characters`);
      assert.equal(header.endsWith('…'), true, `${name} header was not shortened`);
      await page.setContent(renderHtml(doc), { waitUntil: 'load' });
      const pdf = Buffer.from(await page.pdf({
        format: 'Letter',
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      }));
      const gaps = headerGaps(pdfTextRuns(pdf));
      assert.ok(gaps.length > 0, `${name} produced no running header`);
      for (const gap of gaps) assert.ok(gap > 8, `${name} header runs into Rev. A (gap ${gap})`);
    }
  } finally {
    project.identity.productName = savedName;
    project.identity.productNameFromUser = savedFlag;
    await browser.close();
  }
});

test('http checkout, overage offer, webhook grant, and white-label rendering', async () => {
  const priceEnv = env({ MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY: '' });
  const bare = createStripe();
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map((part) => String(part)).join(' '));
  try {
    const app = createApp({ env: priceEnv, stripe: bare.stripe, anthropic: anthropic() });
    await withServer(app, async (base) => {
      const missing = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'integrator', interval: 'month' }),
      });
      assert.equal(missing.status, 503);
      const body = await missing.json();
      assert.match(body.error, /Integrator monthly checkout is temporarily unavailable/);
      assert.equal(JSON.stringify(body).includes(SECRET), false);
      assert.equal(body.error.includes('MANUALOS_STRIPE_PRICE'), false);
      assert.equal(bare.calls.create.length, 0);
      const starter = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'starter' }),
      });
      assert.equal(starter.status, 200);
      const pro = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      });
      assert.equal(pro.status, 200);
      const unnamed = await fetch(base + '/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 'integrator' }),
      });
      assert.equal(unnamed.status, 503);
      const unnamedBody = await unnamed.json();
      assert.equal(unnamedBody.error, 'Integrator checkout is temporarily unavailable.');
      assert.equal(JSON.stringify(unnamedBody).includes(SECRET), false);
      const health = await fetch(base + '/health');
      assert.equal(health.status, 200);
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(logs.some((line) => line.includes(SECRET)), false);
  assert.equal(logs.some((line) => line.includes('MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY is not set')), true);

  const ready = createStripe();
  const app = createApp({ env: env(), stripe: ready.stripe, anthropic: anthropic() });
  await withServer(app, async (base) => {
    const checkout = await fetch(base + '/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'integrator', interval: 'year' }),
    });
    assert.equal(checkout.status, 200);
    assert.deepEqual(Object.keys(await checkout.json()), ['url']);
    assert.equal(ready.calls.create[0].line_items[0].price, 'price_int_year');
    assert.equal(ready.calls.create[0].payment_method_types, undefined);
    assert.equal(ready.calls.create[0].billing_address_collection, 'required');
    assert.match(ready.calls.create[0].custom_text.submit.message, /Cancel anytime/);
    assert.match(ready.calls.create[0].subscription_data.description, /Integrator/);

    const verified = await fetch(base + '/verify-session?session_id=cs_test_integrator');
    const access = await verified.json();
    assert.deepEqual(Object.keys(access).sort(), ['overage_remaining', 'plan', 'remaining', 'valid']);
    assert.equal(access.valid, true);
    assert.equal(access.plan, 'integrator');
    assert.equal(access.remaining, 25);
    assert.equal(access.overage_remaining, 0);
    assert.equal(Object.hasOwn(access, 'seats'), false);
  });

  const exhausted = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '0',
    credit_generation: '8',
  });
  let modelCalls = 0;
  const counting = {
    messages: {
      create: async () => {
        modelCalls += 1;
        throw new Error('model should not run');
      },
    },
  };
  const exhaustedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-overage-http-'));
  const exhaustedApp = createApp({
    env: env({ MANUALOS_ACCOUNT_DIR: exhaustedDir }),
    stripe: exhausted.stripe,
    anthropic: counting,
  });
  await withServer(exhaustedApp, async (base) => {
    const blocked = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_integrator' },
      body: JSON.stringify({ plcContent: L5X }),
    });
    assert.equal(blocked.status, 402);
    const blockedBody = await blocked.json();
    assert.match(blockedBody.error, /\$9/);
    assert.deepEqual(blockedBody.overage, { plan: 'integrator_overage', amount_cents: 900, currency: 'usd' });
    assert.equal(exhausted.calls.create.length, 0);
    assert.equal(modelCalls, 0);

    const overage = await fetch(base + '/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'integrator_overage', session_id: 'cs_test_integrator' }),
    });
    assert.equal(overage.status, 200);
    const params = exhausted.calls.create[0];
    assert.equal(params.mode, 'payment');
    assert.equal(params.line_items[0].price, 'price_int_over');
    assert.equal(params.line_items[0].quantity, 1);
    assert.equal(params.customer, 'cus_test123');
    assert.equal(params.metadata.plan, 'integrator_overage');
    assert.equal(params.metadata.kind, 'overage');
    assert.equal(params.metadata.subscription_id, 'sub_int');
    assert.equal(params.payment_intent_data.metadata.plan, 'integrator_overage');
    assert.equal(params.payment_intent_data.metadata.kind, 'overage');
    assert.equal(params.payment_intent_data.metadata.subscription_id, 'sub_int');
    assert.equal(params.payment_method_types, undefined);
    assert.equal(params.billing_address_collection, 'required');
    assert.equal(params.payment_intent_data.description, 'ManualOS Integrator: one extra manual');
    assert.equal(/Cancel anytime/.test(params.custom_text.submit.message), false);
    assert.match(params.integration_identifier, /manualos_integrator_overage_[a-z]{8}$/);
    assert.match(params.success_url, /session_id=cs_test_integrator$/);
    assert.equal(params.success_url.includes('CHECKOUT_SESSION_ID'), false);

    const hook = await fetch(base + '/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=ok' },
      body: JSON.stringify({
        id: 'evt_over_http',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_over_http',
            payment_status: 'paid',
            metadata: { plan: 'integrator_overage', subscription_id: 'sub_int' },
          },
        },
      }),
    });
    assert.equal(hook.status, 200);
    assert.equal(exhausted.sub.metadata.overage_remaining, '1');
    assert.equal(exhausted.sub.metadata.manuals_used, '25');
  });

  let seenHtml = '';
  const branded = createStripe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-brand-'));
  const accounts = createAccountStore({ directory: dir });
  const brandApp = createApp({
    env: env(),
    stripe: branded.stripe,
    anthropic: anthropic(),
    accounts,
    renderPdf: async (html) => {
      seenHtml = html;
      return Buffer.from('%PDF-1.4\n%manual\n');
    },
  });
  await withServer(brandApp, async (base) => {
    const form = new FormData();
    form.append('session_id', 'cs_test_integrator');
    form.append('company_name', 'Sample Integrator');
    form.append('logo', new Blob([PNG], { type: 'image/png' }), 'mark.png');
    const saved = await fetch(base + '/integrator/branding', { method: 'POST', body: form });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.deepEqual(savedBody, { company_name: 'Sample Integrator', has_logo: true, logo_type: 'png' });
    assert.equal(JSON.stringify(savedBody).includes(PNG.toString('base64')), false);

    const listed = await fetch(base + '/integrator/branding?session_id=cs_test_integrator');
    assert.deepEqual(await listed.json(), savedBody);

    const generated = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_integrator' },
      body: JSON.stringify({ plcContent: L5X }),
    });
    assert.equal(generated.status, 200);
    assert.equal(Buffer.from(await generated.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal(seenHtml.includes('ManualOS'), false);
    assert.equal(seenHtml.includes('brand-header'), false);
    assert.match(seenHtml, /<div class="publisher">[\s\S]*Sample Integrator/);
    assert.match(seenHtml, /content: "Sample Integrator/);
    assert.equal(seenHtml.split(PNG.toString('base64')).length - 1, 1);
    assert.equal(branded.sub.metadata.manuals_used, '1');

    const names = fs.readdirSync(path.join(dir, 'cus_test123')).sort();
    assert.deepEqual(names, ['branding.json', 'logo.png']);
    const dumped = names.map((name) => fs.readFileSync(path.join(dir, 'cus_test123', name)));
    assert.equal(dumped.some((buf) => buf.includes(Buffer.from('RSLogix'))), false);
  });
});

test('a failed manual refunds an overage credit and does not open checkout', async () => {
  const { stripe, sub, calls } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '25',
    overage_remaining: '1',
    credit_generation: '3',
  });
  const app = createApp({
    env: env(),
    stripe,
    anthropic: anthropic(),
    renderPdf: async () => {
      throw new Error('render failed');
    },
  });
  await withServer(app, async (base) => {
    const res = await fetch(base + '/generate-manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_integrator' },
      body: JSON.stringify({ plcContent: L5X }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Internal server error');
    assert.equal(JSON.stringify(body).includes('render failed'), false);
  });
  assert.equal(sub.metadata.overage_remaining, '1');
  assert.equal(sub.metadata.manuals_used, '25');
  assert.equal(calls.create.length, 0);
});

test('integrator checkout stays inert until monthly, annual, and overage prices are set', () => {
  assert.throws(
    () => checkoutParams('integrator', env({ MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: '' }), { interval: 'month' }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.message, 'Integrator checkout is temporarily unavailable.');
      assert.equal(err.message.includes(SECRET), false);
      assert.equal(String(err.logMessage).includes('price_int'), false);
      return true;
    },
  );
  assert.throws(
    () => checkoutParams('integrator', env({
      MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY: '',
      MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL: '',
      MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: '',
    })),
    (err) => err.status === 503 && err.message === 'Integrator checkout is temporarily unavailable.',
  );
  const starter = checkoutParams('starter', env({
    MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY: '',
    MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL: '',
    MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: '',
  }));
  assert.equal(starter.mode, 'payment');
  assert.equal(starter.line_items[0].price, 'price_starter');
  const pro = checkoutParams('pro', env({
    MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY: ' ',
    MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL: ' ',
    MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE: ' ',
  }));
  assert.equal(pro.mode, 'subscription');
  assert.equal(pro.line_items[0].price, 'price_pro');
});

test('a missing logo directory produces no logo and does not throw', () => {
  const missing = path.join(os.tmpdir(), `manualos-missing-${process.pid}-${Date.now()}`);
  const stored = readBranding('cus_test', { dir: missing });
  assert.deepEqual(stored, { companyName: '', logo: null });
  assert.equal(documentBranding(stored), null);
  const accounts = createAccountStore({ directory: missing });
  assert.throws(() => accounts.writeBranding('cus_test123', { companyName: 'North Line Controls' }), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.expose, true);
    assert.equal(err.message, 'Company logo storage is temporarily unavailable.');
    assert.equal(err.message.includes(missing), false);
    assert.equal(err.message.includes('cus_'), false);
    return true;
  });
  assert.equal(fs.existsSync(missing), false);
});

function assertWhiteLabelHtml(html) {
  assert.match(html, /North Line Controls/);
  assert.match(html, /<div class="publisher">[\s\S]*North Line Controls/);
  assert.match(html, /content: "North Line Controls/);
  assert.equal(html.includes('ManualOS'), false);
  assert.equal(html.includes('brand-header'), false);
  assert.equal(html.includes('brand-footer'), false);
}

async function uploadFixture(base, route) {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
  const form = new FormData();
  form.set('session_id', 'cs_test_integrator');
  form.set('file', new Blob([bytes]), 'line.L5X');
  return fetch(base + route, { method: 'POST', body: form });
}

test('a multipart job upload keeps the company name in the manual html', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-multipart-job-'));
  const accounts = createAccountStore({ directory: dir });
  accounts.writeBranding('cus_test123', { companyName: 'North Line Controls' });
  const seen = [];
  const { stripe, sub } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '0',
    overage_remaining: '0',
  });
  const app = createApp({
    env: env({ MANUALOS_ACCOUNT_DIR: dir }),
    stripe,
    anthropic: anthropic(),
    accounts,
    renderPdf: async (html) => {
      seen.push(html);
      return Buffer.from('%PDF-1.4\n%job\n');
    },
  });
  await withServer(app, async (base) => {
    const started = await uploadFixture(base, '/jobs');
    assert.equal(started.status, 202);
    const created = await started.json();
    let body = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const polled = await fetch(`${base}/jobs/${created.id}`);
      body = await polled.json();
      if (body.status === 'succeeded' || body.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(body.status, 'succeeded', body && body.error);
  });
  assert.equal(seen.length, 1);
  assertWhiteLabelHtml(seen[0]);
  assert.equal(sub.metadata.manuals_used, '1');
});

test('a multipart generate-manual upload keeps the company name in the manual html', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-multipart-manual-'));
  const accounts = createAccountStore({ directory: dir });
  accounts.writeBranding('cus_test123', { companyName: 'North Line Controls' });
  const seen = [];
  const { stripe, sub } = createStripe({
    credit_period: 'period:1700000000',
    credits_granted: '25',
    manuals_used: '0',
    overage_remaining: '0',
  });
  const app = createApp({
    env: env({ MANUALOS_ACCOUNT_DIR: dir }),
    stripe,
    anthropic: anthropic(),
    accounts,
    renderPdf: async (html) => {
      seen.push(html);
      return Buffer.from('%PDF-1.4\n%manual\n');
    },
  });
  await withServer(app, async (base) => {
    const generated = await uploadFixture(base, '/generate-manual');
    assert.equal(generated.status, 200);
    assert.equal(Buffer.from(await generated.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  });
  assert.equal(seen.length, 1);
  assertWhiteLabelHtml(seen[0]);
  assert.equal(sub.metadata.manuals_used, '1');
});

test('svg logos are data urls and chromium does not fetch their targets', async () => {
  const http = require('http');
  let hits = 0;
  const listener = http.createServer((req, res) => {
    hits += 1;
    res.end('no');
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  const host = `127.0.0.1:${port}`;
  const payloads = [
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="http&#58;//${host}/a"></image></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="http&#x3a;//${host}/b"></image></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http&#58;//${host}/c)"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><filter id="f"><feImage href="http&#58;//${host}/d"/></filter><rect filter="url(#f)"/></svg>`,
  ];
  try {
    const images = payloads.map((svg) => {
      const logo = validateLogo(Buffer.from(svg));
      const markup = logoMarkup(logo);
      assert.match(markup, /^<img class="brand-logo" alt="" src="data:image\/svg\+xml;base64,/);
      assert.equal(markup.includes('<svg'), false);
      assert.equal(markup.includes(`http://${host}`), false);
      return markup;
    });
    const html = `<!doctype html><html><body>${images.join('')}<img src="http://${host}/plain" alt=""></body></html>`;
    const pdf = await renderPdf(html);
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    assert.equal(hits, 0);
  } finally {
    await closeBrowser();
    await new Promise((resolve) => listener.close(resolve));
  }
});

test('a failed integrator job releases the integrator credit and still refunds a starter credit', async () => {
  const billing = require('../lib/billing');
  const integratorLib = require('../lib/integrator');
  const calls = { starter: [], integrator: [] };
  const originalStarter = billing.refundStarterCredit;
  const originalIntegrator = integratorLib.refundIntegratorCredit;
  billing.refundStarterCredit = async (stripe, paymentIntentId, token) => {
    calls.starter.push({ paymentIntentId, token });
    return originalStarter(stripe, paymentIntentId, token);
  };
  integratorLib.refundIntegratorCredit = async (stripe, subscriptionId, token) => {
    calls.integrator.push({ subscriptionId, token });
    return originalIntegrator(stripe, subscriptionId, token);
  };
  const serverPath = require.resolve('../server');
  delete require.cache[serverPath];
  const { createApp: freshApp } = require('../server');
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.map((part) => String(part)).join(' '));
  try {
    const { stripe, sub } = createStripe({
      credit_period: 'period:1700000000',
      credits_granted: '25',
      manuals_used: '0',
      overage_remaining: '0',
      credit_generation: '3',
    });
    const app = freshApp({
      env: env(),
      stripe,
      anthropic: anthropic(),
      renderPdf: async () => {
        throw new Error('render failed sk_test_JOBFAILTOKEN secret-program.L5X whsec_JOBFAILTOKEN');
      },
    });
    await withServer(app, async (base) => {
      const started = await fetch(base + '/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_integrator' },
        body: JSON.stringify({ plcContent: L5X }),
      });
      assert.equal(started.status, 202);
      const created = await started.json();
      let body = null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const polled = await fetch(`${base}/jobs/${created.id}`);
        body = await polled.json();
        if (body.status === 'succeeded' || body.status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(body.status, 'failed');
      assert.equal(JSON.stringify(body).includes('JOBFAILTOKEN'), false);
      assert.equal(JSON.stringify(body).includes('secret-program'), false);
    });
    assert.equal(calls.integrator.length, 1);
    assert.equal(calls.integrator[0].subscriptionId, 'sub_int');
    assert.equal(calls.starter.length, 1);
    assert.equal(calls.starter[0].paymentIntentId, null);
    assert.equal(sub.metadata.manuals_used, '0');
    assert.equal(sub.metadata.credit_hold, undefined);
    const logged = logs.join('\n');
    assert.equal(logged.includes('JOBFAILTOKEN'), false);
    assert.equal(logged.includes('secret-program'), false);
    assert.match(logged, /\[redacted\]/);
  } finally {
    console.error = originalError;
    billing.refundStarterCredit = originalStarter;
    integratorLib.refundIntegratorCredit = originalIntegrator;
    delete require.cache[serverPath];
  }
});
