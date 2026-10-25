const os = require('os');
const path = require('path');

function productionEnv(env = {}) {
  const node = String(env.NODE_ENV || '').trim().toLowerCase();
  const railway = String(env.RAILWAY_ENVIRONMENT || '').trim().toLowerCase();
  return node === 'production' || railway === 'production';
}

function supportStorageProblem(env = {}) {
  if (!productionEnv(env)) return '';
  const configured = String(env.SUPPORT_DATA_DIR || '').trim();
  if (!configured) return 'SUPPORT_DATA_DIR is not set';
  if (!path.isAbsolute(configured)) return 'SUPPORT_DATA_DIR is not an absolute path';
  const resolved = path.resolve(configured);
  const temp = path.resolve(os.tmpdir());
  if (resolved === temp || resolved.startsWith(temp + path.sep)) {
    return 'SUPPORT_DATA_DIR is inside the temporary directory';
  }
  return '';
}

module.exports = {
  productionEnv,
  supportStorageProblem,
};
