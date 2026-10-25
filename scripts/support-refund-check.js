require('dotenv').config();
const Stripe = require('stripe');
const { refundCheck } = require('../lib/delivery');

function redact(text) {
  return String(text || '')
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/rk_(live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/whsec_[A-Za-z0-9]+/g, '[redacted]');
}

function recognized(query) {
  if (/^(pi_|ch_|cs_|in_)/.test(query)) return true;
  return query.includes('@') && !/\s/.test(query);
}

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query || !recognized(query)) {
    console.error('Usage: npm run support:refund-check -- <payment_intent|charge|checkout_session|invoice|email>');
    process.exit(1);
  }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !String(key).trim()) {
    console.error('STRIPE_SECRET_KEY is not set');
    process.exit(1);
  }
  const stripe = new Stripe(String(key).trim());
  const result = await refundCheck(stripe, query);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.found ? 0 : 2);
}

main().catch((err) => {
  console.error(redact(err && err.message ? err.message : 'Lookup failed'));
  process.exit(1);
});
