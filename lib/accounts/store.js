const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isProduction } = require('../config');
const { exposed } = require('../errors');
const { redactCustomerLog } = require('../redact-log');
const { graphemeClusters } = require('../text');

const CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;
const STORAGE_UNAVAILABLE = 'Company logo storage is temporarily unavailable.';
const GRANTS_UNAVAILABLE = 'Extra manual records are temporarily unavailable.';

function accountDirectory({ env = process.env, directory } = {}) {
  if (directory) return { dir: directory, ensure: false };
  const fromEnv = env && env.MANUALOS_ACCOUNT_DIR && String(env.MANUALOS_ACCOUNT_DIR).trim();
  if (fromEnv) return { dir: fromEnv, ensure: false };
  if (isProduction(env)) return { dir: null, ensure: false };
  return { dir: path.join(os.tmpdir(), 'manualos-accounts'), ensure: true };
}

function rootReady(dir) {
  if (!dir) return false;
  try {
    if (!fs.existsSync(dir)) return false;
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function createAccountStore({ env = process.env, directory } = {}) {
  const located = accountDirectory({ env, directory });
  const dir = located.dir;
  if (located.ensure && dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // A missing temp directory is treated as no logo.
    }
  }

  function folder(customerId) {
    if (!CUSTOMER_ID.test(String(customerId || ''))) {
      throw exposed(400, 'Integrator account is missing.');
    }
    const base = path.join(dir, customerId);
    const resolvedDir = path.resolve(dir);
    const resolvedBase = path.resolve(base);
    if (resolvedBase !== resolvedDir && !resolvedBase.startsWith(resolvedDir + path.sep)) {
      throw exposed(400, 'Integrator account is missing.');
    }
    return resolvedBase;
  }

  function empty() {
    return { companyName: '', logo: null };
  }

  function readBranding(customerId) {
    if (!rootReady(dir)) return empty();
    let base;
    try {
      base = folder(customerId);
    } catch (err) {
      if (err && err.expose) throw err;
      return empty();
    }
    try {
      const metaPath = path.join(base, 'branding.json');
      if (!fs.existsSync(metaPath)) return empty();
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const companyName = typeof meta.companyName === 'string'
        ? graphemeClusters(meta.companyName.replace(/[\u0000-\u001F\u007F<>]/g, '').trim()).slice(0, 80).join('')
        : '';
      let logo = null;
      if (meta.logoType === 'png' || meta.logoType === 'svg') {
        const filename = meta.logoType === 'png' ? 'logo.png' : 'logo.svg';
        const file = path.join(base, filename);
        try {
          if (fs.existsSync(file)) logo = { type: meta.logoType, buffer: fs.readFileSync(file) };
        } catch {
          logo = null;
        }
      }
      return { companyName, logo };
    } catch {
      return empty();
    }
  }

  function writeBranding(customerId, patch = {}) {
    if (!rootReady(dir)) throw exposed(503, STORAGE_UNAVAILABLE);
    let base;
    try {
      base = folder(customerId);
      fs.mkdirSync(base, { recursive: true });
      const current = fs.existsSync(path.join(base, 'branding.json')) ? readBranding(customerId) : empty();
      const companyName = patch.companyName === undefined ? current.companyName : patch.companyName;
      const logo = patch.logo === undefined ? current.logo : patch.logo;
      fs.rmSync(path.join(base, 'logo.png'), { force: true });
      fs.rmSync(path.join(base, 'logo.svg'), { force: true });
      if (logo && (logo.type === 'png' || logo.type === 'svg')) {
        const filename = logo.type === 'png' ? 'logo.png' : 'logo.svg';
        fs.writeFileSync(path.join(base, filename), logo.buffer);
      }
      const payload = {
        companyName: companyName || '',
        logoType: logo && (logo.type === 'png' || logo.type === 'svg') ? logo.type : null,
      };
      fs.writeFileSync(path.join(base, 'branding.json'), JSON.stringify(payload));
      return readBranding(customerId);
    } catch (err) {
      if (err && err.expose) throw err;
      throw exposed(503, STORAGE_UNAVAILABLE);
    }
  }

  function grantsFile(customerId) {
    return path.join(folder(customerId), 'overage-grants.json');
  }

  function unreadableGrants(file) {
    const shown = String(file || '').replace(/cus_[A-Za-z0-9]+/g, 'cus_[redacted]');
    console.error(redactCustomerLog(`Overage grant file could not be read: ${shown}`));
    return exposed(503, GRANTS_UNAVAILABLE);
  }

  function readOverageGrants(customerId) {
    if (!rootReady(dir)) throw exposed(503, STORAGE_UNAVAILABLE);
    const file = grantsFile(customerId);
    if (!fs.existsSync(file)) return {};
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw unreadableGrants(file);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadableGrants(file);
    const grants = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || key.length > 255 || (value !== 'pending' && value !== 'done')) throw unreadableGrants(file);
      grants[key] = value;
    }
    return grants;
  }

  function writeOverageGrant(customerId, grantId, status) {
    if (!rootReady(dir)) throw exposed(503, STORAGE_UNAVAILABLE);
    const id = String(grantId || '');
    if (!id || id.length > 255 || (status !== 'pending' && status !== 'done')) {
      throw exposed(400, 'Integrator account is missing.');
    }
    const base = folder(customerId);
    fs.mkdirSync(base, { recursive: true });
    const grants = readOverageGrants(customerId);
    grants[id] = status;
    const file = grantsFile(customerId);
    const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const payload = Buffer.from(JSON.stringify(grants));
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'w');
      let offset = 0;
      while (offset < payload.length) {
        const wrote = fs.writeSync(fd, payload, offset);
        if (wrote <= 0) throw new Error('Overage grant file write was incomplete');
        offset += wrote;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, file);
      const dirFd = fs.openSync(base, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (err) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch { /* The descriptor is already closed. */ }
      }
      try { fs.rmSync(tmp, { force: true }); } catch { /* The temp file is already gone. */ }
      if (err && err.expose) throw err;
      throw exposed(503, GRANTS_UNAVAILABLE);
    }
    return status;
  }

  return { readBranding, writeBranding, readOverageGrants, writeOverageGrant, directory: dir };
}

function readBranding(customerId, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const directory = opts.dir || opts.directory;
  const env = Object.prototype.hasOwnProperty.call(opts, 'env') ? opts.env : process.env;
  return createAccountStore({ env, directory }).readBranding(customerId);
}

module.exports = { createAccountStore, readBranding };
