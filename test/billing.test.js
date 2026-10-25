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
  assert.deepEqual(starter.metadata, { plan: 'starter' });
  assert.equal(starter.payment_intent_data.metadata.manuals_used, '0');
  assert.equal(starter.payment_intent_data.metadata.plan, 'starter');
  assert.equal(starter.payment_method_types, undefined);
  assert.match(starter.integration_identifier, /manualos_starter_[a-z]{8}$/);

  const pro = checkoutParams('pro', env);
  assert.equal(pro.mode, 'subscription');
  assert.equal(pro.line_items[0].price, 'price_pro');
  assert.deepEqual(pro.metadata, { plan: 'pro' });
  assert.deepEqual(pro.subscription_data.metadata, { plan: 'pro' });
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
});

test('pro is valid only while the subscription is active or trialing', () => {
  for (const status of ['active', 'trialing']) {
    const access = accessFromSession(
      { metadata: { plan: 'pro' }, payment_status: 'paid' },
      null,
      { id: 'sub_1', status },
      env
    );
    assert.equal(access.valid, true);
    assert.equal(access.plan, 'pro');
    assert.equal(access.remaining, null);
  }
  const lapsed = accessFromSession(
    { metadata: { plan: 'pro' } },
    null,
    { id: 'sub_1', status: 'past_due' },
    env
  );
  assert.equal(lapsed.valid, false);
  assert.equal(lapsed.plan, 'pro');
  assert.equal(lapsed.remaining, null);
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
  await assert.rejects(() => assertCanGenerate(stripe, 'cs_test', env), (err) => err.status === 402);
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
