// The extras job delivers the operating manual on the same path as a manual-only
// job. When lib/delivery.js is present (#9), stamp first_manual_at so a refund
// locks after that PDF exists. Until that module is on the branch, this is a no-op.

function missingDeliveryModule(err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') return false;
  return /cannot find module ['"](?:\.\/delivery|[^'"]*[\\/]delivery)['"]/i.test(String(err.message || ''));
}

function loadDelivery() {
  return require('./delivery');
}

async function markDeliveredManual(stripe, access, sessionId, load = loadDelivery) {
  let delivery;
  try {
    delivery = load();
  } catch (err) {
    if (missingDeliveryModule(err)) return null;
    throw err;
  }
  if (!delivery || typeof delivery.markFirstManualDelivered !== 'function') return null;
  return delivery.markFirstManualDelivered(stripe, access, sessionId);
}

module.exports = { markDeliveredManual };
