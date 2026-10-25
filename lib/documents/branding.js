// Integrator white-label hook.
// Callers pass branding already resolved for the manual. When they do not,
// readBranding(customerId) and readBranding(customerId, { dir }) are both tried.
// A missing module, a missing export, or any read failure leaves branding empty.

function wrapBranding(value) {
  if (!value || typeof value !== 'object') return null;
  let documentBranding;
  try {
    ({ documentBranding } = require('../branding'));
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') return null;
    return value;
  }
  if (typeof documentBranding !== 'function') return value;
  try {
    return documentBranding(value);
  } catch {
    return null;
  }
}

function readStoredBranding(readBranding, customerId, access) {
  const attempts = [
    () => readBranding(customerId, { dir: access && access.dir }),
    () => readBranding(customerId),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // Try the other signature. A failure here is an empty brand, not an error.
    }
  }
  return null;
}

function resolveDocumentBranding(access, supplied) {
  if (!access || access.plan !== 'integrator') return null;
  const passed = supplied || access.branding;
  if (passed && typeof passed === 'object') return wrapBranding(passed);
  let accounts;
  try {
    accounts = require('../accounts/store');
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') return null;
    return null;
  }
  if (!accounts || typeof accounts.readBranding !== 'function' || !access.customerId) return null;
  return wrapBranding(readStoredBranding(accounts.readBranding, access.customerId, access));
}

module.exports = { resolveDocumentBranding };
