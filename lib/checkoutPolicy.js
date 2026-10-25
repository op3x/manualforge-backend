// Checkout fields that give a dispute a billing address, a refund rule, and a
// receipt description. Returns a new params object. Does not call Stripe.
const { starterCreditAllowance } = require('./config');

// Integrator is not launched. PR #6 can name it here again when that plan ships.
const REFUND_RULE = 'Refundable until your first manual is delivered: within 30 days for Starter, or before the billing period ends for Pro. Once a manual is delivered, that purchase is no longer refundable.';
const PAYMENT_REFUND_MESSAGE = REFUND_RULE;
const SUBSCRIPTION_REFUND_MESSAGE = `${REFUND_RULE} Cancel anytime.`;

const SUBMIT_MESSAGE_LIMIT = 1200;

if (PAYMENT_REFUND_MESSAGE.length > SUBMIT_MESSAGE_LIMIT || SUBSCRIPTION_REFUND_MESSAGE.length > SUBMIT_MESSAGE_LIMIT) {
  throw new Error('Checkout refund message exceeds 1200 characters');
}

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

function canonicalPlan(plan) {
  const value = String(plan || '').trim().toLowerCase();
  if (value === 'starter') return 'starter';
  if (value === 'pro' || value === 'pro_monthly' || value === 'pro_annual' || value === 'pro_yearly' || value === 'pro_year') {
    return 'pro';
  }
  if (value === 'integrator_overage' || value === 'overage') return 'overage';
  if (
    value === 'integrator'
    || value === 'integrator_monthly'
    || value === 'integrator_annual'
    || value === 'integrator_yearly'
    || value === 'integrator_year'
  ) {
    return 'integrator';
  }
  return '';
}

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

function allowanceEnv(env) {
  return env && typeof env === 'object' ? env : {};
}

function starterDescription(env) {
  const count = starterCreditAllowance(allowanceEnv(env));
  const manuals = count === 1 ? 'manual' : 'manuals';
  return `ManualOS Starter: ${count} operator and maintenance ${manuals} from your files`;
}

function submitMessage(mode) {
  return mode === 'subscription' ? SUBSCRIPTION_REFUND_MESSAGE : PAYMENT_REFUND_MESSAGE;
}

function productDescription(plan, interval, mode, env) {
  if (plan === 'starter' && mode === 'payment') return starterDescription(env);
  if (plan === 'pro' && mode === 'subscription') {
    return interval === 'year' ? DESCRIPTIONS.pro.year : DESCRIPTIONS.pro.month;
  }
  if (plan === 'integrator' && mode === 'subscription') {
    return interval === 'year' ? DESCRIPTIONS.integrator.year : DESCRIPTIONS.integrator.month;
  }
  if (plan === 'overage' && mode === 'payment') return DESCRIPTIONS.overage;
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

function withSubmitMessage(customText, mode) {
  const copy = customText && typeof customText === 'object' && !Array.isArray(customText)
    ? { ...customText }
    : {};
  const submit = copy.submit && typeof copy.submit === 'object' && !Array.isArray(copy.submit)
    ? { ...copy.submit }
    : {};
  submit.message = submitMessage(mode);
  copy.submit = submit;
  return copy;
}

function termsRequired(env) {
  if (!env || typeof env !== 'object') return false;
  return String(env.CHECKOUT_REQUIRE_TOS == null ? '' : env.CHECKOUT_REQUIRE_TOS).trim() === '1';
}

function withCheckoutPolicy(params, options) {
  const source = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const settings = options && typeof options === 'object' ? options : {};
  const env = Object.hasOwn(settings, 'env') ? settings.env : process.env;
  const planInput = settings.plan || (source.metadata && source.metadata.plan);
  const plan = canonicalPlan(planInput);
  const description = productDescription(plan, billingInterval(source, planInput), source.mode, env);

  const next = { ...source };
  if (source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)) {
    next.metadata = { ...source.metadata };
  }
  next.billing_address_collection = 'required';
  next.custom_text = withSubmitMessage(source.custom_text, source.mode);

  if (source.mode === 'payment' && description) {
    const paymentIntentData = copyRecord(source.payment_intent_data);
    paymentIntentData.description = description;
    next.payment_intent_data = paymentIntentData;
  } else if (source.mode === 'subscription' && description) {
    const subscriptionData = copyRecord(source.subscription_data);
    subscriptionData.description = description;
    next.subscription_data = subscriptionData;
  }

  if (termsRequired(env)) {
    const consent = source.consent_collection && typeof source.consent_collection === 'object' && !Array.isArray(source.consent_collection)
      ? { ...source.consent_collection }
      : {};
    consent.terms_of_service = 'required';
    next.consent_collection = consent;
  }

  return next;
}

module.exports = {
  PAYMENT_REFUND_MESSAGE,
  SUBSCRIPTION_REFUND_MESSAGE,
  SUBMIT_MESSAGE_LIMIT,
  DESCRIPTIONS,
  starterDescription,
  withCheckoutPolicy,
};
