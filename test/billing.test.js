const test = require('node:test');
const assert = require('node:assert/strict');
const { checkoutParams, accessFromSession, parseManualsUsed, assertCanGenerate } = require('../lib/billing');
const { allowedOrigins, frontendOrigin, starterCreditAllowance, anthropicModel } = require('../lib/config');

const env = {
  FRONTEND_URL: 'https://manualos.com/',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  STARTER_CREDITS: '3',
};

test('checkout params match the Starter and Pro contract', () => {
  const starter = checkoutParams('starter', env);
  assert.equal(starter.mode, 'payment');
  assert.equal(starter.line_items[0].price, 'price_starter');
  assert.equal(starter.line_items[0].quantity, 1);
  assert.equal(starter.success_url, 'https://manualos.com/upload.html?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(starter.cancel_url, 'https://manualos.com/#pricing');
  assert.deepEqual(starter.metadata, { plan: 'starter', brand: 'manualos' });
  assert.equal(starter.payment_intent_data.metadata.manuals_used, '0');
  assert.equal(starter.payment_intent_data.metadata.plan, 'starter');
  assert.equal(starter.payment_intent_data.metadata.brand, 'manualos');
  assert.equal(starter.customer_creation, 'always');
  assert.equal(starter.customer, undefined);
  assert.equal(starter.customer_update, undefined);
  assert.equal(starter.payment_method_types, undefined);
  assert.match(starter.integration_identifier, /manualos_starter_[a-z]{8}$/);

  const pro = checkoutParams('pro', env);
  assert.equal(pro.mode, 'subscription');
  assert.equal(pro.line_items[0].price, 'price_pro');
  assert.deepEqual(pro.metadata, { plan: 'pro', brand: 'manualos' });
  assert.deepEqual(pro.subscription_data.metadata, { plan: 'pro', brand: 'manualos' });
  assert.equal(pro.payment_method_types, undefined);
  assert.match(pro.integration_identifier, /manualos_pro_[a-z]{8}$/);
  assert.notEqual(starter.integration_identifier, pro.integration_identifier);
});

test('checkout rejects an unknown plan before talking about prices', () => {
  assert.throws(() => checkoutParams('enterprise', env), (err) => err.status === 400 && err.expose === true);
});

test('starter remaining is credits minus manuals_used', () => {
  assert.equal(parseManualsUsed(undefined), 0);
  assert.equal(parseManualsUsed('2'), 2);
  assert.equal(parseManualsUsed('-4'), 0);
  const paid = accessFromSession(
    { metadata: { plan: 'starter' }, payment_status: 'paid' },
    { id: 'pi_1', metadata: { manuals_used: '1' } },
    null,
    env
  );
  assert.deepEqual(
    { valid: paid.valid, plan: paid.plan, remaining: paid.remaining },
    { valid: true, plan: 'starter', remaining: 2 }
  );

  const unpaid = accessFromSession(
    { metadata: { plan: 'starter' }, payment_status: 'unpaid' },
    { id: 'pi_1', metadata: { manuals_used: '0' } },
    null,
    env
  );
  assert.equal(unpaid.valid, false);
  assert.equal(unpaid.remaining, null);

  const exhausted = accessFromSession(
    { metadata: { plan: 'starter' }, payment_status: 'paid' },
    { id: 'pi_1', metadata: { manuals_used: '3' } },
    null,
    env
  );
  assert.equal(exhausted.valid, true);
  assert.equal(exhausted.remaining, 0);

  const revoked = accessFromSession(
    { metadata: { plan: 'starter' }, payment_status: 'paid' },
    { id: 'pi_1', metadata: { manuals_used: '1', credit_status: 'revoked' } },
    null,
    env
  );
  assert.equal(revoked.valid, false);
  assert.equal(revoked.remaining, 0);
  assert.equal(revoked.creditStatus, 'revoked');

  const suspended = accessFromSession(
    { metadata: { plan: 'starter' }, payment_status: 'paid' },
    { id: 'pi_1', metadata: { manuals_used: '1', credit_status: 'suspended' } },
    null,
    env
  );
  assert.equal(suspended.valid, false);
  assert.equal(suspended.remaining, 0);
  assert.equal(suspended.creditStatus, 'suspended');

  const refused = accessFromSession(
    {
      metadata: { plan: 'starter' },
      payment_status: 'paid',
      consent_collection: { terms_of_service: 'required' },
    },
    { id: 'pi_1', metadata: { manuals_used: '0' } },
    null,
    env
  );
  assert.equal(refused.valid, false);
  assert.equal(refused.remaining, null);

  const versioned = accessFromSession(
    {
      metadata: { plan: 'starter', terms_version: 'checkout-tos-v2' },
      payment_status: 'paid',
      consent_collection: { terms_of_service: 'required' },
    },
    { id: 'pi_1', metadata: { manuals_used: '0' } },
    null,
    env
  );
  assert.equal(versioned.valid, true);
  assert.equal(versioned.remaining, 3);
});

test('pro stays valid during past_due and ends on unpaid, canceled, or incomplete_expired', () => {
  for (const status of ['active', 'trialing', 'past_due']) {
    const access = accessFromSession(
      { metadata: { plan: 'pro' }, payment_status: 'paid' },
      null,
      { id: 'sub_1', status, customer: 'cus_1' },
      env
    );
    assert.equal(access.valid, true, status);
    assert.equal(access.plan, 'pro');
    assert.equal(access.remaining, null);
    assert.equal(access.billingIssue, status === 'past_due');
    assert.equal(access.subscriptionId, 'sub_1');
    assert.equal(access.customerId, 'cus_1');
  }
  for (const status of ['unpaid', 'canceled', 'incomplete_expired', 'incomplete', 'paused']) {
    const ended = accessFromSession(
      { metadata: { plan: 'pro' } },
      null,
      { id: 'sub_1', status },
      env
    );
    assert.equal(ended.valid, false, status);
    assert.equal(ended.plan, 'pro');
    assert.equal(ended.billingIssue, false);
  }
  for (const scheduled of [
    { id: 'sub_1', status: 'active', cancel_at: 1792800000, cancel_at_period_end: false },
    { id: 'sub_1', status: 'active', cancel_at: null, cancel_at_period_end: true },
  ]) {
    const access = accessFromSession(
      { metadata: { plan: 'pro' }, payment_status: 'paid' },
      null,
      scheduled,
      env
    );
    assert.equal(access.valid, true, JSON.stringify(scheduled));
    assert.equal(access.billingIssue, false);
  }
  const lapsed = accessFromSession(
    { metadata: { plan: 'pro' } },
    null,
    { id: 'sub_1', status: 'past_due', cancel_at_period_end: true },
    env
  );
  assert.equal(lapsed.valid, true);
  assert.equal(lapsed.plan, 'pro');
  assert.equal(lapsed.remaining, null);
  assert.equal(lapsed.billingIssue, true);

  const refused = accessFromSession(
    {
      metadata: { plan: 'pro' },
      payment_status: 'paid',
      consent_collection: { terms_of_service: 'required' },
    },
    null,
    { id: 'sub_1', status: 'past_due', customer: 'cus_1' },
    env
  );
  assert.equal(refused.valid, false);
  assert.equal(refused.billingIssue, true);
  assert.equal(refused.subscriptionId, 'sub_1');
  assert.equal(refused.customerId, 'cus_1');
});

test('a refunded or suspended pro period is not valid while the subscription stays active', () => {
  const refunded = accessFromSession(
    { metadata: { plan: 'pro' }, payment_status: 'paid' },
    null,
    { id: 'sub_1', status: 'active', metadata: { period_access: 'revoked', period_access_reason: 'refund' } },
    env,
  );
  assert.equal(refunded.valid, false);
  assert.equal(refunded.plan, 'pro');
  assert.equal(refunded.periodAccess, 'revoked');
  assert.equal(refunded.periodRevokeReason, 'refund');
  const lost = accessFromSession(
    { metadata: { plan: 'pro' } },
    null,
    { id: 'sub_1', status: 'active', metadata: { period_access: 'revoked', period_access_reason: 'dispute' } },
    env,
  );
  assert.equal(lost.valid, false);
  assert.equal(lost.periodRevokeReason, 'dispute');
  const suspended = accessFromSession(
    { metadata: { plan: 'pro' } },
    null,
    { id: 'sub_1', status: 'trialing', metadata: { period_access: 'suspended', period_access_reason: 'dispute' } },
    env,
  );
  assert.equal(suspended.valid, false);
  assert.equal(suspended.periodAccess, 'suspended');
});

test('assertCanGenerate returns 402 when starter credits are gone', async () => {
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          metadata: { plan: 'starter' },
          payment_status: 'paid',
          payment_intent: { id: 'pi_1', metadata: { manuals_used: '3' } },
          subscription: null,
        }),
      },
    },
  };
  await assert.rejects(() => assertCanGenerate(stripe, 'cs_test_id', env), (err) => err.status === 402);
});

test('origins and defaults', () => {
  assert.equal(frontendOrigin({ FRONTEND_URL: 'https://manualos.com/' }), 'https://manualos.com');
  const origins = allowedOrigins({ FRONTEND_URL: 'https://manualos.com' });
  assert.equal(origins.has('https://manualos.com'), true);
  assert.equal(origins.has('https://www.manualos.com'), true);
  assert.equal(origins.has('https://evil.example'), false);
  const apexAlways = allowedOrigins({ FRONTEND_URL: 'https://www.manualos.com' });
  assert.equal(apexAlways.has('https://manualos.com'), true);
  assert.equal(starterCreditAllowance({}), 3);
  assert.equal(starterCreditAllowance({ STARTER_CREDITS: '5' }), 5);
  assert.equal(starterCreditAllowance({ STARTER_CREDITS: 'nope' }), 3);
  assert.equal(anthropicModel({}), 'claude-haiku-5-5');
  assert.equal(anthropicModel({ ANTHROPIC_MODEL: 'claude-sonnet-5-5' }), 'claude-sonnet-5-5');
});
