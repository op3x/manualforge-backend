// Buyer-facing Checkout copy. Bump CHECKOUT_TOS_VERSION when any string changes.
// Each plan has its own terms label and submit text. There is no fallback plan.
// Stripe's create-session reference describes custom_text.submit.message as text
// of at most 1200 characters. Markdown links are documented for the terms
// checkbox, not for submit.message, so cancel URLs in submit text stay plain.
const crypto = require('crypto');

const CHECKOUT_TOS_VERSION = 'checkout-tos-v2';
const CHECKOUT_TEXT_LIMIT = 1200;

const STARTER_TERMS_ACCEPTANCE_MESSAGE = 'I agree to the [ManualOS Terms](https://manualos.com/terms.html) and authorize Op3x LLC to make this one-time charge. This isn\'t a subscription.';

const PRO_TERMS_ACCEPTANCE_MESSAGE = 'I agree to the [ManualOS Terms](https://manualos.com/terms.html) and authorize Op3x LLC to charge my card $79/month (USD, plus applicable taxes), renewing automatically each month until I cancel.';

const INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE = 'I agree to the [ManualOS Terms](https://manualos.com/terms.html) and authorize Op3x LLC to charge my card $249/month (USD, plus applicable taxes), renewing automatically each month until I cancel.';

const INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE = 'I agree to the [ManualOS Terms](https://manualos.com/terms.html) and authorize Op3x LLC to charge my card $2,490/year (USD, plus applicable taxes), renewing automatically each year until I cancel.';

const PRO_RENEWAL_MESSAGE = 'Pro renews automatically every month at $79 (USD, plus applicable taxes) until you cancel. Cancel anytime online with the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Pro until the end of the period you\'ve paid for.';

const PRO_REFUND_SENTENCE = 'Each monthly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise.';

const INTEGRATOR_KEEP_SENTENCE = 'Cancel anytime online with the one-click cancel email at manualos.com/cancel. Cancelling stops future charges, and you keep Integrator until the end of the period you\'ve paid for.';

const INTEGRATOR_MONTHLY_REFUND_SENTENCE = 'Each monthly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise.';

const INTEGRATOR_ANNUAL_REFUND_SENTENCE = 'Each yearly charge is refundable until that billing period ends, as long as no manual has been delivered in that period, except where the law requires otherwise.';

const PRO_SUBMIT_MESSAGE = `${PRO_RENEWAL_MESSAGE} ${PRO_REFUND_SENTENCE}`;

const INTEGRATOR_MONTHLY_SUBMIT_MESSAGE = `Integrator renews automatically every month at $249 (USD, plus applicable taxes) until you cancel. ${INTEGRATOR_KEEP_SENTENCE} ${INTEGRATOR_MONTHLY_REFUND_SENTENCE}`;

const INTEGRATOR_ANNUAL_SUBMIT_MESSAGE = `Integrator renews automatically every year at $2,490 (USD, plus applicable taxes) until you cancel. ${INTEGRATOR_KEEP_SENTENCE} ${INTEGRATOR_ANNUAL_REFUND_SENTENCE}`;

const STARTER_SUBMIT_MESSAGE = 'Full refund within 30 days of purchase, as long as no manual from that purchase has been delivered, except where the law requires otherwise.';

const APPROVED_CHECKOUT_COPY = {
  starter: {
    terms: STARTER_TERMS_ACCEPTANCE_MESSAGE,
    submit: STARTER_SUBMIT_MESSAGE,
  },
  pro: {
    terms: PRO_TERMS_ACCEPTANCE_MESSAGE,
    submit: PRO_SUBMIT_MESSAGE,
  },
  integrator_monthly: {
    terms: INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE,
    submit: INTEGRATOR_MONTHLY_SUBMIT_MESSAGE,
  },
  integrator_annual: {
    terms: INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE,
    submit: INTEGRATOR_ANNUAL_SUBMIT_MESSAGE,
  },
};

function assertCheckoutText(name, text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > CHECKOUT_TEXT_LIMIT) {
    throw new Error(`${name} is ${text && text.length} characters; Stripe custom text limit is ${CHECKOUT_TEXT_LIMIT}`);
  }
}

for (const [plan, copy] of Object.entries(APPROVED_CHECKOUT_COPY)) {
  assertCheckoutText(`${plan} terms`, copy.terms);
  assertCheckoutText(`${plan} submit`, copy.submit);
}

function planUnavailable() {
  const err = new Error('plan_unavailable');
  err.status = 400;
  err.expose = true;
  err.code = 'plan_unavailable';
  return err;
}

function checkoutCopy(plan) {
  if (typeof plan !== 'string' || !Object.hasOwn(APPROVED_CHECKOUT_COPY, plan)) throw planUnavailable();
  return APPROVED_CHECKOUT_COPY[plan];
}

// Never returns ''. A plan without approved copy is refused.
function termsAcceptanceMessage(plan) {
  return checkoutCopy(plan).terms;
}

function stripeSubmitMessage(plan) {
  return checkoutCopy(plan).submit;
}

function tosLabelSha(terms, submit) {
  return crypto.createHash('sha256').update(`${terms}${submit}`, 'utf8').digest('hex').slice(0, 12);
}

module.exports = {
  CHECKOUT_TOS_VERSION,
  CHECKOUT_TEXT_LIMIT,
  APPROVED_CHECKOUT_COPY,
  STARTER_TERMS_ACCEPTANCE_MESSAGE,
  PRO_TERMS_ACCEPTANCE_MESSAGE,
  INTEGRATOR_MONTHLY_TERMS_ACCEPTANCE_MESSAGE,
  INTEGRATOR_ANNUAL_TERMS_ACCEPTANCE_MESSAGE,
  PRO_RENEWAL_MESSAGE,
  PRO_SUBMIT_MESSAGE,
  INTEGRATOR_MONTHLY_SUBMIT_MESSAGE,
  INTEGRATOR_ANNUAL_SUBMIT_MESSAGE,
  STARTER_SUBMIT_MESSAGE,
  termsAcceptanceMessage,
  stripeSubmitMessage,
  tosLabelSha,
};
