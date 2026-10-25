// Shared with the Managed Payments checkout change. On only when the value is
// exactly "1". Unset, "true", "yes", "0", and " 1 " are off.
function isManagedPayments(env) {
  const source = env && typeof env === 'object' ? env : {};
  return source.MANUALOS_MANAGED_PAYMENTS === '1';
}

module.exports = { isManagedPayments };
