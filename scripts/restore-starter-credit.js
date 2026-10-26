require('dotenv').config();
const Stripe = require('stripe');
const { runRestore } = require('../lib/restore-starter-credit');

async function main() {
  const result = await runRestore({
    argv: process.argv.slice(2),
    env: process.env,
    key: process.env.STRIPE_SECRET_KEY,
    stripeFactory(key) {
      return new Stripe(key);
    },
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.exitCode);
}

main().catch((err) => {
  const { redactCreditLog } = require('../lib/credit-ledger');
  console.error(redactCreditLog(err && err.message ? err.message : 'Restore failed'));
  process.exit(1);
});
