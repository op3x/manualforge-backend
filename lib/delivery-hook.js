// The extras job delivers the operating manual on the same path as a manual-only
// job. When lib/delivery.js is present (#9), stamp first_manual_at so a refund
// locks after that PDF exists. Until that module is on the branch, this is a no-op.

async function markDeliveredManual(stripe, access, sessionId) {
  let delivery;
  try {
    delivery = require('./delivery');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
  if (!delivery || typeof delivery.markFirstManualDelivered !== 'function') return null;
  return delivery.markFirstManualDelivered(stripe, access, sessionId);
}

module.exports = { markDeliveredManual };
