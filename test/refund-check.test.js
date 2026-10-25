const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { refundCheck } = require('../lib/delivery');

const DAY = 24 * 60 * 60 * 1000;
const PURCHASED = Date.parse('2026-01-01T00:00:00.000Z');
const STARTER_DEADLINE = new Date(PURCHASED + 30 * DAY).toISOString();
const DAY_29 = new Date(PURCHASED + 29 * DAY).toISOString();
const DAY_31 = new Date(PURCHASED + 31 * DAY).toISOString();
const PERIOD_END = Date.parse('2026-06-01T00:00:00.000Z');
const PERIOD_END_ISO = new Date(PERIOD_END).toISOString();
const BEFORE_PERIOD = new Date(PERIOD_END - 60 * 60 * 1000).toISOString();
const AFTER_PERIOD = new Date(PERIOD_END + 60 * 60 * 1000).toISOString();

function notFound() {
  const err = new Error('missing');
  err.statusCode = 404;
  err.code = 'resource_missing';
  return err;
}

function starterStripe(pi) {
  return {
    paymentIntents: {
      retrieve: async (id) => {
        if (id !== pi.id) throw notFound();
        return pi;
      },
    },
  };
}

test('starter is eligible on day 29 and past the deadline on day 31', async () => {
  const stripe = starterStripe({
    id: 'pi_starter',
    created: PURCHASED / 1000,
    customer: 'cus_starter',
    metadata: { plan: 'starter', manuals_used: '0' },
  });
  const early = await refundCheck(stripe, 'pi_starter', { now: DAY_29 });
  assert.equal(early.found, true);
  assert.equal(early.purchases.length, 1);
  assert.equal(early.purchases[0].plan, 'starter');
  assert.equal(early.purchases[0].delivered, false);
  assert.equal(early.purchases[0].refund_eligible, true);
  assert.equal(early.purchases[0].deadline, STARTER_DEADLINE);
  assert.equal(early.purchases[0].reason, `eligible until ${STARTER_DEADLINE}`);

  const late = await refundCheck(stripe, 'pi_starter', { now: DAY_31 });
  assert.equal(late.purchases[0].refund_eligible, false);
  assert.equal(late.purchases[0].delivered, false);
  assert.equal(late.purchases[0].deadline, STARTER_DEADLINE);
  assert.equal(late.purchases[0].reason, `past deadline ${STARTER_DEADLINE}`);
});

test('a delivered starter manual inside the window is not eligible', async () => {
  const deliveredAt = '2026-01-02T03:04:05.000Z';
  const stripe = starterStripe({
    id: 'pi_delivered',
    created: PURCHASED / 1000,
    metadata: { plan: 'starter', first_manual_at: deliveredAt },
  });
  const result = await refundCheck(stripe, 'pi_delivered', { now: DAY_29 });
  assert.equal(result.purchases[0].delivered, true);
  assert.equal(result.purchases[0].delivered_at, deliveredAt);
  assert.equal(result.purchases[0].refund_eligible, false);
  assert.equal(result.purchases[0].deadline, STARTER_DEADLINE);
  assert.equal(result.purchases[0].reason, `delivered at ${deliveredAt}`);
});

test('an unknown id is not found', async () => {
  const stripe = {
    paymentIntents: { retrieve: async () => { throw notFound(); } },
    charges: { retrieve: async () => { throw notFound(); } },
    invoices: { retrieve: async () => { throw notFound(); } },
    checkout: { sessions: { retrieve: async () => { throw notFound(); } } },
    customers: { list: async () => ({ data: [] }) },
  };
  for (const query of ['pi_missing', 'ch_missing', 'in_missing', 'cs_test_missing', 'nobody@example.com', 'not-an-id']) {
    const result = await refundCheck(stripe, query, { now: DAY_29 });
    assert.equal(result.found, false);
    assert.deepEqual(result.purchases, []);
  }
});

function proStripe({ oldEnd, newEnd, deliveredAt }) {
  const oldInvoice = {
    id: 'in_old',
    period_end: oldEnd / 1000,
    lines: { data: [{ period: { start: (oldEnd - 30 * DAY) / 1000, end: oldEnd / 1000 } }] },
    subscription: 'sub_pro',
    charge: 'ch_old',
    metadata: deliveredAt ? { first_manual_at: deliveredAt } : {},
  };
  const currentInvoice = {
    id: 'in_current',
    period_end: newEnd / 1000,
    lines: { data: [{ period: { end: newEnd / 1000 } }] },
    subscription: 'sub_pro',
    charge: 'ch_current',
    metadata: {},
  };
  const subscription = {
    id: 'sub_pro',
    metadata: { plan: 'pro' },
    latest_invoice: 'in_current',
    current_period_end: newEnd / 1000,
    items: { data: [{ current_period_end: newEnd / 1000 }] },
  };
  const charges = {
    ch_old: {
      id: 'ch_old',
      created: (oldEnd - 20 * DAY) / 1000,
      invoice: oldInvoice,
      customer: 'cus_pro',
      metadata: {},
    },
    ch_current: {
      id: 'ch_current',
      created: (newEnd - 10 * DAY) / 1000,
      invoice: 'in_current',
      customer: 'cus_pro',
      metadata: {},
    },
  };
  return {
    charges: {
      retrieve: async (id) => {
        if (!charges[id]) throw notFound();
        return charges[id];
      },
    },
    invoices: {
      retrieve: async (id) => (id === 'in_current' ? currentInvoice : notFound()),
    },
    subscriptions: {
      retrieve: async () => subscription,
    },
  };
}

test('a pro charge is eligible before its period ends and not after', async () => {
  const stripe = proStripe({ oldEnd: PERIOD_END, newEnd: PERIOD_END });
  const before = await refundCheck(stripe, 'ch_current', { now: BEFORE_PERIOD });
  assert.equal(before.purchases[0].plan, 'pro');
  assert.equal(before.purchases[0].delivered, false);
  assert.equal(before.purchases[0].refund_eligible, true);
  assert.equal(before.purchases[0].deadline, PERIOD_END_ISO);
  assert.equal(before.purchases[0].reason, `eligible until ${PERIOD_END_ISO}`);

  const after = await refundCheck(stripe, 'ch_current', { now: AFTER_PERIOD });
  assert.equal(after.purchases[0].refund_eligible, false);
  assert.equal(after.purchases[0].reason, `past deadline ${PERIOD_END_ISO}`);
  assert.equal(after.purchases[0].deadline, PERIOD_END_ISO);
});

test('a delivered pro manual inside the period is not eligible, and the previous period is separate', async () => {
  const deliveredAt = '2026-05-02T00:00:00.000Z';
  const nextEnd = Date.parse('2026-07-01T00:00:00.000Z');
  const stripe = proStripe({ oldEnd: PERIOD_END, newEnd: nextEnd, deliveredAt });
  stripe.charges.retrieve = async (id) => {
    if (id === 'ch_old') {
      return {
        id: 'ch_old',
        created: (PERIOD_END - 20 * DAY) / 1000,
        invoice: {
          id: 'in_old',
          period_end: PERIOD_END / 1000,
          lines: { data: [{ period: { end: PERIOD_END / 1000 } }] },
          subscription: 'sub_pro',
          metadata: { first_manual_at: deliveredAt },
        },
        customer: 'cus_pro',
        metadata: { first_manual_at: deliveredAt },
      };
    }
    if (id === 'ch_current') {
      return {
        id: 'ch_current',
        invoice: 'in_current',
        customer: 'cus_pro',
        metadata: {},
      };
    }
    throw notFound();
  };
  const delivered = await refundCheck(stripe, 'ch_old', { now: BEFORE_PERIOD });
  assert.equal(delivered.purchases[0].refund_eligible, false);
  assert.equal(delivered.purchases[0].reason, `delivered at ${deliveredAt}`);
  assert.equal(delivered.purchases[0].id, 'ch_old');

  const current = await refundCheck(stripe, 'ch_current', { now: new Date(PERIOD_END + DAY).toISOString() });
  assert.equal(current.purchases[0].id, 'ch_current');
  assert.equal(current.purchases[0].delivered, false);
  assert.equal(current.purchases[0].refund_eligible, true);
  assert.equal(current.purchases[0].deadline, new Date(nextEnd).toISOString());
});

test('an earlier pro period uses that invoice period, not the live current_period_end', async () => {
  const stripe = proStripe({ oldEnd: PERIOD_END, newEnd: Date.parse('2026-08-01T00:00:00.000Z') });
  const result = await refundCheck(stripe, 'ch_old', { now: AFTER_PERIOD });
  assert.equal(result.purchases[0].refund_eligible, false);
  assert.equal(result.purchases[0].reason, `past deadline ${PERIOD_END_ISO}`);
});

test('a checkout session uses that session and the payment or session creation time', async () => {
  const pi = {
    id: 'pi_session',
    metadata: { plan: 'starter' },
    customer: 'cus_session',
  };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id) => {
          if (id !== 'cs_test_session') throw notFound();
          return {
            id,
            created: PURCHASED / 1000,
            metadata: { plan: 'starter' },
            payment_intent: pi,
            customer: 'cus_session',
          };
        },
      },
    },
  };
  const early = await refundCheck(stripe, 'cs_test_session', { now: DAY_29 });
  assert.equal(early.purchases[0].id, 'pi_session');
  assert.equal(early.purchases[0].via, 'cs_test_session');
  assert.equal(early.purchases[0].refund_eligible, true);
  assert.equal(early.purchases[0].deadline, STARTER_DEADLINE);
  const late = await refundCheck(stripe, 'cs_test_session', { now: DAY_31 });
  assert.equal(late.purchases[0].reason, `past deadline ${STARTER_DEADLINE}`);
});

test('a pro checkout session resolves to that session invoice, not the latest period', async () => {
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_test_old',
          metadata: { plan: 'pro' },
          invoice: {
            id: 'in_old',
            period_end: PERIOD_END / 1000,
            lines: { data: [{ period: { end: PERIOD_END / 1000 } }] },
            subscription: {
              id: 'sub_pro',
              latest_invoice: 'in_later',
              metadata: { plan: 'pro' },
              items: { data: [{ current_period_end: Date.parse('2026-12-01T00:00:00.000Z') / 1000 }] },
            },
            charge: 'ch_old',
            metadata: {},
          },
          subscription: 'sub_pro',
          customer: 'cus_pro',
        }),
      },
    },
    charges: {
      retrieve: async () => ({
        id: 'ch_old',
        invoice: 'in_old',
        customer: 'cus_pro',
        metadata: {},
      }),
    },
    invoices: {
      retrieve: async () => ({
        id: 'in_old',
        period_end: PERIOD_END / 1000,
        lines: { data: [{ period: { end: PERIOD_END / 1000 } }] },
        subscription: 'sub_pro',
        metadata: {},
      }),
    },
    subscriptions: {
      retrieve: async () => ({
        id: 'sub_pro',
        latest_invoice: 'in_later',
        metadata: { plan: 'pro' },
        items: { data: [{ current_period_end: Date.parse('2026-12-01T00:00:00.000Z') / 1000 }] },
      }),
    },
  };
  const result = await refundCheck(stripe, 'cs_test_old', { now: new Date(PERIOD_END + DAY).toISOString() });
  assert.equal(result.purchases[0].id, 'ch_old');
  assert.equal(result.purchases[0].via, 'cs_test_old');
  assert.equal(result.purchases[0].refund_eligible, false);
  assert.equal(result.purchases[0].reason, `past deadline ${PERIOD_END_ISO}`);
});

test('integrator subscription charges use the billing period end', async () => {
  const stripe = {
    charges: {
      retrieve: async () => ({
        id: 'ch_integrator',
        invoice: {
          id: 'in_year',
          period_end: PERIOD_END / 1000,
          subscription: {
            id: 'sub_integrator',
            latest_invoice: 'in_year',
            metadata: { plan: 'integrator' },
            current_period_end: PERIOD_END / 1000,
          },
          metadata: {},
        },
        metadata: {},
      }),
    },
  };
  const result = await refundCheck(stripe, 'ch_integrator', { now: BEFORE_PERIOD });
  assert.equal(result.purchases[0].plan, 'integrator');
  assert.equal(result.purchases[0].refund_eligible, true);
  assert.equal(result.purchases[0].reason, `eligible until ${PERIOD_END_ISO}`);
});

test('email lookup does not echo the address', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const stripe = {
      customers: {
        list: async ({ email }) => {
          assert.equal(email, 'buyer@example.com');
          return { data: [{ id: 'cus_mail' }] };
        },
      },
      charges: {
        list: async ({ customer }) => ({
          data: [{
            id: 'ch_mail',
            created: PURCHASED / 1000,
            customer,
            payment_intent: 'pi_mail',
            metadata: {},
          }],
        }),
      },
      paymentIntents: {
        retrieve: async () => ({
          id: 'pi_mail',
          created: PURCHASED / 1000,
          metadata: { plan: 'starter' },
        }),
      },
    };
    const result = await refundCheck(stripe, 'buyer@example.com', { now: DAY_29 });
    const text = JSON.stringify(result);
    assert.equal(text.includes('buyer@example.com'), false);
    assert.equal(text.includes('@'), false);
    assert.equal(result.purchases[0].customer, 'cus_mail');
    assert.equal(result.purchases[0].refund_eligible, true);
    assert.equal(lines.some((line) => line.includes('@')), false);
  } finally {
    console.log = original;
  }
});

test('support refund check usage exits 1 without calling stripe', () => {
  const result = spawnSync(process.execPath, ['scripts/support-refund-check.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm run support:refund-check/);
});
