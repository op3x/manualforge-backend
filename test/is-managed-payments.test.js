const test = require('node:test');
const assert = require('node:assert/strict');
const { isManagedPayments } = require('../lib/is-managed-payments');

test('isManagedPayments is on only when MANUALOS_MANAGED_PAYMENTS is exactly 1', () => {
  assert.equal(isManagedPayments({ MANUALOS_MANAGED_PAYMENTS: '1' }), true);
  for (const value of [undefined, null, '', 'true', 'yes', 'false', '0', 'off', 'no', ' 1 ', '1\n', '01', 1]) {
    assert.equal(isManagedPayments({ MANUALOS_MANAGED_PAYMENTS: value }), false, `value ${JSON.stringify(value)}`);
  }
  assert.equal(isManagedPayments(undefined), false);
  assert.equal(isManagedPayments(null), false);
  assert.equal(isManagedPayments({}), false);
  assert.equal(isManagedPayments({ STRIPE_MANAGED_PAYMENTS: '1' }), false);
});
