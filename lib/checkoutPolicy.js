// Checkout fields that give a dispute a billing address, a plan-specific
// terms checkbox, and a receipt description. Returns a new params object.
// Does not call Stripe.
const { starterCreditAllowance } = require('./config');
const {
  CHECKOUT_TOS_VERSION,
  stripeSubmitMessage,
  termsAcceptanceMessage,
  tosLabelSha,
} = require('./checkoutLabels');

const DESCRIPTIONS = {
  pro: {
    month: 'ManualOS Pro: unlimited manuals, billed monthly',
    year: 'ManualOS Pro: unlimited manuals, billed yearly',
  },
  integrator: {
    month: 'ManualOS Integrator: 25 manuals per month',
    year: 'ManualOS Integrator: 25 manuals per month, billed yearly',
  },
  overage: 'ManualOS Integrator: one extra manual',
};

function intervalFromName(plan) {
  const value = String(plan || '').trim().toLowerCase();
  if (value.endsWith('_annual') || value.endsWith('_yearly') || value.endsWith('_year')) return 'year';
  if (value.endsWith('_monthly') || value.endsWith('_month')) return 'month';
  return '';
}

function intervalFromValue(value) {
  const interval = String(value || '').trim().toLowerCase();
  if (interval === 'year' || interval === 'annual' || interval === 'yearly') return 'year';
  if (interval === 'month' || interval === 'monthly') return 'month';
  return '';
}

function billingInterval(params, plan) {
  const named = intervalFromName(plan);
  if (named) return named;
  const metadata = params && params.metadata;
  const subscription = params && params.subscription_data;
  const subscriptionMetadata = subscription && subscription.metadata;
  return intervalFromValue(metadata && metadata.interval)
    || intervalFromValue(subscriptionMetadata && subscriptionMetadata.interval)
    || 'month';
}

function legalPlan(planInput, params) {
  const value = String(planInput || '').trim().toLowerCase();
  if (value === 'starter') return 'starter';
  if (value === 'pro' || value === 'pro_monthly' || value === 'pro_month') {
    return billingInterval(params, planInput) === 'year' ? 'pro_annual' : 'pro';
  }
  if (value === 'pro_annual' || value === 'pro_yearly' || value === 'pro_year') return 'pro_annual';
  if (value === 'integrator_overage' || value === 'overage') return 'overage';
  if (
    value === 'integrator'
    || value === 'integrator_monthly'
    || value === 'integrator_month'
    || value === 'integrator_annual'
    || value === 'integrator_yearly'
    || value === 'integrator_year'
  ) {
    return billingInterval(params, value) === 'year' ? 'integrator_annual' : 'integrator_monthly';
  }
  return '';
}

function allowanceEnv(env) {
  return env && typeof env === 'object' ? env : {};
}

function starterDescription(env) {
  const count = starterCreditAllowance(allowanceEnv(env));
  const manuals = count === 1 ? 'manual' : 'manuals';
  return `ManualOS Starter: ${count} operator and maintenance ${manuals} from your files`;
}

function productDescription(plan, mode, env) {
  if (plan === 'starter' && mode === 'payment') return starterDescription(env);
  if (plan === 'pro' && mode === 'subscription') return DESCRIPTIONS.pro.month;
  if (plan === 'integrator_monthly' && mode === 'subscription') return DESCRIPTIONS.integrator.month;
  if (plan === 'integrator_annual' && mode === 'subscription') return DESCRIPTIONS.integrator.year;
  return '';
}

function copyRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const copy = { ...value };
  if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)) {
    copy.metadata = { ...value.metadata };
  }
  return copy;
}

function refuse(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (message === 'plan_unavailable') err.code = 'plan_unavailable';
  return err;
}

// CHECKOUT_TOS_MODE=off and CHECKOUT_REQUIRE_TOS=0 fail closed. They do not
// skip the terms checkbox or restore any older pay-button sentence.
function checkoutTosBlocked(env) {
  const settings = env && typeof env === 'object' ? env : {};
  const legacy = String(settings.CHECKOUT_REQUIRE_TOS == null ? '' : settings.CHECKOUT_REQUIRE_TOS).trim();
  if (legacy === '0') return true;
  const mode = String(settings.CHECKOUT_TOS_MODE == null ? '' : settings.CHECKOUT_TOS_MODE).trim().toLowerCase();
  return mode === 'off';
}

function withApprovedText(customText, terms, submit) {
  const copy = customText && typeof customText === 'object' && !Array.isArray(customText)
    ? { ...customText }
    : {};
  const submitBox = copy.submit && typeof copy.submit === 'object' && !Array.isArray(copy.submit)
    ? { ...copy.submit }
    : {};
  submitBox.message = submit;
  copy.submit = submitBox;
  const acceptance = copy.terms_of_service_acceptance
    && typeof copy.terms_of_service_acceptance === 'object'
    && !Array.isArray(copy.terms_of_service_acceptance)
    ? { ...copy.terms_of_service_acceptance }
    : {};
  acceptance.message = terms;
  copy.terms_of_service_acceptance = acceptance;
  return copy;
}

function withTosMetadata(metadata, record) {
  const copy = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  copy.plan = record.plan;
  copy.terms_version = record.terms_version;
  copy.tos_label_sha = record.tos_label_sha;
  return copy;
}

function withCheckoutPolicy(params, options) {
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const settings = options && typeof options === 'object' ? options : {};
  const env = Object.hasOwn(settings, 'env') ? settings.env : process.env;
  if (checkoutTosBlocked(env)) {
    throw refuse(503, 'Checkout is temporarily unavailable.');
  }
  const planInput = settings.plan || (source.metadata && source.metadata.plan);
  const plan = legalPlan(planInput, source);
  let terms;
  let submit;
  try {
    terms = termsAcceptanceMessage(plan);
    submit = stripeSubmitMessage(plan);
  } catch (err) {
    if (err && err.code === 'plan_unavailable') throw err;
    throw refuse(400, 'plan_unavailable');
  }
  if (!terms || !submit) throw refuse(400, 'plan_unavailable');
  const record = {
    plan,
    terms_version: CHECKOUT_TOS_VERSION,
    tos_label_sha: tosLabelSha(terms, submit),
  };
  const description = productDescription(plan, source.mode, env);

  const next = { ...source };
  next.metadata = withTosMetadata(source.metadata, record);
  next.billing_address_collection = 'required';
  next.custom_text = withApprovedText(source.custom_text, terms, submit);

  if (source.mode === 'payment') {
    const paymentIntentData = copyRecord(source.payment_intent_data);
    if (description) paymentIntentData.description = description;
    paymentIntentData.metadata = withTosMetadata(paymentIntentData.metadata, record);
    next.payment_intent_data = paymentIntentData;
  } else if (source.mode === 'subscription') {
    const subscriptionData = copyRecord(source.subscription_data);
    if (description) subscriptionData.description = description;
    subscriptionData.metadata = withTosMetadata(subscriptionData.metadata, record);
    next.subscription_data = subscriptionData;
  }

  const consent = source.consent_collection && typeof source.consent_collection === 'object' && !Array.isArray(source.consent_collection)
    ? { ...source.consent_collection }
    : {};
  consent.terms_of_service = 'required';
  next.consent_collection = consent;

  return next;
}

module.exports = {
  DESCRIPTIONS,
  starterDescription,
  checkoutTosBlocked,
  legalPlan,
  withCheckoutPolicy,
};
