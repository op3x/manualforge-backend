const { INTEGRATION_IDS } = require('./config');

// Checkout plans the API can recognize. Integrator (PR #6) extends this map
// with one entry instead of another starter/pro string compare:
//   kind: 'credit' | 'subscription'
//   portal: Billing Portal and "fix your payment" links
//   returnLink: email the upload link after checkout
//   mode / priceEnv: POST /create-checkout-session, when this plan is sold there
// Also add the plan name to INTEGRATION_IDS.
const PLANS = {
  starter: {
    kind: 'credit',
    portal: false,
    returnLink: true,
    mode: 'payment',
    priceEnv: 'STRIPE_PRICE_STARTER',
  },
  pro: {
    kind: 'subscription',
    portal: true,
    returnLink: true,
    mode: 'subscription',
    priceEnv: 'STRIPE_PRICE_PRO',
  },
};

function planRecord(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PLANS, name)) return null;
  const record = PLANS[name];
  return {
    name,
    ...record,
    integrationId: INTEGRATION_IDS[name] || null,
  };
}

function planFromSession(session) {
  const name = session && session.metadata && session.metadata.plan;
  return planRecord(name);
}

module.exports = {
  PLANS,
  planRecord,
  planFromSession,
};
