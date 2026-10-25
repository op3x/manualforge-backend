// Integrator white-label hook.
// PR #6 (cursor/integrator-plan-3980) stores a company name and logo and passes
// documentBranding() into the manual. This loader uses those modules when they
// are present and applies the same object to every extra document. Until that
// plan code is on main, Integrator sessions are still allowed by the document
// gate, and branding stays empty.

function resolveDocumentBranding(access) {
  if (!access || access.plan !== 'integrator') return null;
  let documentBranding;
  try {
    ({ documentBranding } = require('../branding'));
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
  let accounts;
  try {
    accounts = require('../accounts/store');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
  if (typeof documentBranding !== 'function' || !accounts || typeof accounts.readBranding !== 'function') return null;
  if (!access.customerId) return null;
  return documentBranding(accounts.readBranding(access.customerId));
}

module.exports = { resolveDocumentBranding };
