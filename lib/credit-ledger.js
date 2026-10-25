const fs = require('fs');
const path = require('path');
const { refundStarterCredit } = require('./billing');
const { jobTimeoutMs } = require('./job-timeout');

// A restart has no job list. Open holds are the only way to find a PaymentIntent
// that still has credit_hold set. This process's owned set is not written down:
// a hold is eligible only when this process does not have the job, and only once
// credit_hold_at is older than the job timeout plus this margin.
const HOLD_STALE_MARGIN_MS = 60 * 1000;
const HANDBACK_ATTEMPTS = 3;
const HANDBACK_BACKOFF_MS = [5000, 25000];
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const OPEN_FILE = 'open-holds.json';
const PENDING_FILE = 'credit-handbacks.json';
const PI = /^pi_[A-Za-z0-9]+$/;
const TOKEN = /^[a-f0-9]{16}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function redactCreditLog(value) {
  return String(value || '')
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/rk_(live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/whsec_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi, '[redacted]')
    .replace(/pi_[A-Za-z0-9]+/g, 'pi_[redacted]');
}

function supportDir(env) {
  const raw = env && typeof env.SUPPORT_DATA_DIR === 'string' ? env.SUPPORT_DATA_DIR.trim() : '';
  return raw;
}

function createCreditLedger({
  env = {},
  sleep,
  backoffMs,
  intervalMs,
} = {}) {
  const dir = supportDir(env);
  const memory = { open: [], pending: [] };
  const owned = new Set();
  const delays = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : HANDBACK_BACKOFF_MS;
  const pause = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  let timer = null;
  let bound = null;

  function key(item) {
    return `${item.paymentIntentId}\n${item.token}`;
  }

  function valid(item, withHeldAt) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.paymentIntentId !== 'string' || !PI.test(item.paymentIntentId)) return false;
    if (typeof item.token !== 'string' || !TOKEN.test(item.token)) return false;
    if (withHeldAt && (typeof item.heldAt !== 'string' || !STAMP.test(item.heldAt))) return false;
    return true;
  }

  function readList(name, withHeldAt) {
    if (!dir) return (name === OPEN_FILE ? memory.open : memory.pending).slice();
    const file = path.join(dir, name);
    let parsed;
    try {
      if (!fs.existsSync(file)) return [];
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) return [];
      parsed = JSON.parse(text);
    } catch {
      console.error(name === OPEN_FILE ? 'Open credit hold record could not be read' : 'Credit hand-back queue could not be read');
      const err = new Error('Credit record could not be read');
      err.unreadable = true;
      throw err;
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => valid(item, withHeldAt)).map((item) => (
      withHeldAt
        ? { paymentIntentId: item.paymentIntentId, token: item.token, heldAt: item.heldAt }
        : { paymentIntentId: item.paymentIntentId, token: item.token }
    ));
  }

  function writeList(name, items, withHeldAt) {
    const clean = items.filter((item) => valid(item, withHeldAt)).map((item) => (
      withHeldAt
        ? { paymentIntentId: item.paymentIntentId, token: item.token, heldAt: item.heldAt }
        : { paymentIntentId: item.paymentIntentId, token: item.token }
    ));
    if (!dir) {
      if (name === OPEN_FILE) memory.open = clean;
      else memory.pending = clean;
      return;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function same(left, right) {
    return left.paymentIntentId === right.paymentIntentId && left.token === right.token;
  }

  function note(item) {
    if (!valid(item, true)) return;
    const open = readList(OPEN_FILE, true).filter((row) => !same(row, item));
    open.push({ paymentIntentId: item.paymentIntentId, token: item.token, heldAt: item.heldAt });
    writeList(OPEN_FILE, open, true);
    owned.add(key(item));
  }

  function drop(item) {
    if (!item || !item.paymentIntentId || !item.token) return;
    owned.delete(key(item));
    writeList(OPEN_FILE, readList(OPEN_FILE, true).filter((row) => !same(row, item)), true);
    writeList(PENDING_FILE, readList(PENDING_FILE, false).filter((row) => !same(row, item)), false);
  }

  function owns(paymentIntentId, token) {
    return owned.has(key({ paymentIntentId, token }));
  }

  function unown(item) {
    if (!item || !item.paymentIntentId || !item.token) return;
    owned.delete(key(item));
  }

  function enqueue(item) {
    if (!valid(item, false)) return;
    const pending = readList(PENDING_FILE, false);
    if (pending.some((row) => same(row, item))) return;
    pending.push({ paymentIntentId: item.paymentIntentId, token: item.token });
    writeList(PENDING_FILE, pending, false);
  }

  function pending() {
    return readList(PENDING_FILE, false).length;
  }

  function logFailure(err) {
    console.error('Starter credit hand-back failed', redactCreditLog(err && err.message ? err.message : err));
  }

  async function handBack(stripe, paymentIntentId, token) {
    for (let attempt = 0; attempt < HANDBACK_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const wait = delays[attempt - 1] != null ? delays[attempt - 1] : delays[delays.length - 1];
        await pause(wait);
      }
      try {
        const result = await refundStarterCredit(stripe, paymentIntentId, token);
        drop({ paymentIntentId, token });
        return result;
      } catch (err) {
        logFailure(err);
      }
    }
    enqueue({ paymentIntentId, token });
    return null;
  }

  async function retryPending(stripe) {
    for (const item of readList(PENDING_FILE, false)) {
      try {
        await refundStarterCredit(stripe, item.paymentIntentId, item.token);
        drop(item);
      } catch (err) {
        logFailure(err);
      }
    }
  }

  async function releaseStale(stripe, nowMs, timeoutMs) {
    const limit = timeoutMs + HOLD_STALE_MARGIN_MS;
    for (const item of readList(OPEN_FILE, true)) {
      if (owns(item.paymentIntentId, item.token)) continue;
      let current;
      try {
        current = await stripe.paymentIntents.retrieve(item.paymentIntentId);
      } catch (err) {
        logFailure(err);
        continue;
      }
      const meta = (current && current.metadata) || {};
      if (meta.credit_hold !== item.token) {
        drop(item);
        continue;
      }
      const heldAt = Date.parse(typeof meta.credit_hold_at === 'string' ? meta.credit_hold_at : '');
      if (!Number.isFinite(heldAt) || nowMs - heldAt <= limit) continue;
      await handBack(stripe, item.paymentIntentId, item.token);
    }
  }

  function nowMs(options) {
    if (options && typeof options.now === 'function') return options.now();
    if (options && typeof options.now === 'number') return options.now;
    if (bound && typeof bound.now === 'function') return bound.now();
    return Date.now();
  }

  function timeoutOf(options) {
    if (options && Number.isFinite(options.timeoutMs)) return options.timeoutMs;
    if (bound && typeof bound.timeoutMs === 'function') return bound.timeoutMs();
    return jobTimeoutMs(env);
  }

  async function reconcile(stripe, options = {}) {
    const client = stripe || (bound && bound.stripe);
    if (!client || !client.paymentIntents) return;
    await retryPending(client);
    await releaseStale(client, nowMs(options), timeoutOf(options));
  }

  function attach(stripe, hooks = {}) {
    bound = { stripe, now: hooks.now, timeoutMs: hooks.timeoutMs };
    if (timer) return;
    const run = () => {
      reconcile().catch((err) => {
        console.error('Starter credit reconcile failed', redactCreditLog(err && err.message ? err.message : err));
      });
    };
    run();
    const every = Number.isFinite(intervalMs) ? intervalMs : RECONCILE_INTERVAL_MS;
    if (every > 0) {
      timer = setInterval(run, every);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }

  function close() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    note,
    drop,
    unown,
    owns,
    pending,
    handBack,
    reconcile,
    attach,
    close,
  };
}

function creditRecordValid(item, withHeldAt) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.paymentIntentId !== 'string' || !PI.test(item.paymentIntentId)) return false;
  if (typeof item.token !== 'string' || !TOKEN.test(item.token)) return false;
  if (withHeldAt && (typeof item.heldAt !== 'string' || !STAMP.test(item.heldAt))) return false;
  return true;
}

function copyCreditRecord(item, withHeldAt) {
  return withHeldAt
    ? { paymentIntentId: item.paymentIntentId, token: item.token, heldAt: item.heldAt }
    : { paymentIntentId: item.paymentIntentId, token: item.token };
}

function readStoredCreditFile(dir, name, withHeldAt) {
  const file = path.join(dir, name);
  let parsed;
  try {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return [];
    parsed = JSON.parse(text);
  } catch {
    const err = new Error('Credit record could not be read');
    err.unreadable = true;
    throw err;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) => creditRecordValid(item, withHeldAt)).map((item) => copyCreditRecord(item, withHeldAt));
}

function writeStoredCreditFile(dir, name, items, withHeldAt) {
  const clean = items.filter((item) => creditRecordValid(item, withHeldAt)).map((item) => copyCreditRecord(item, withHeldAt));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function listPurchaseCredits(env, paymentIntentId) {
  const dir = supportDir(env);
  if (!dir) return { status: 'unset', open: [], pending: [] };
  try {
    const open = readStoredCreditFile(dir, OPEN_FILE, true).filter((item) => item.paymentIntentId === paymentIntentId);
    const pending = readStoredCreditFile(dir, PENDING_FILE, false).filter((item) => item.paymentIntentId === paymentIntentId);
    return { status: 'ok', open, pending };
  } catch (err) {
    if (err && err.unreadable) return { status: 'unreadable', open: [], pending: [] };
    throw err;
  }
}

function removePurchaseCredits(env, paymentIntentId) {
  const dir = supportDir(env);
  if (!dir) return { status: 'unset', removedOpen: 0, removedPending: 0 };
  const open = readStoredCreditFile(dir, OPEN_FILE, true);
  const pending = readStoredCreditFile(dir, PENDING_FILE, false);
  const nextOpen = open.filter((item) => item.paymentIntentId !== paymentIntentId);
  const nextPending = pending.filter((item) => item.paymentIntentId !== paymentIntentId);
  writeStoredCreditFile(dir, OPEN_FILE, nextOpen, true);
  writeStoredCreditFile(dir, PENDING_FILE, nextPending, false);
  return {
    status: 'ok',
    removedOpen: open.length - nextOpen.length,
    removedPending: pending.length - nextPending.length,
  };
}

function supportDataDirOk(env) {
  const dir = supportDir(env);
  if (!dir) return false;
  const probe = path.join(dir, `.support-data-dir-probe-${process.pid}-${Math.random().toString(16).slice(2)}`);
  let handle;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    handle = fs.openSync(probe, 'wx', 0o600);
    fs.closeSync(handle);
    handle = null;
    fs.unlinkSync(probe);
    return true;
  } catch {
    if (handle != null) {
      try { fs.closeSync(handle); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(probe); } catch { /* ignore */ }
    return false;
  }
}

const SUPPORT_DATA_DIR_UNSET = 'WARNING: SUPPORT_DATA_DIR is not set. Open Starter holds and failed hand-backs stay in memory, so a restart cannot return them.';
const SUPPORT_DATA_DIR_UNWRITABLE = 'WARNING: SUPPORT_DATA_DIR is not writable. Open Starter holds and failed hand-backs cannot be saved, so a restart cannot return them.';
let supportDataDirWarned = false;

function supportDataDirWarning(env) {
  if (supportDataDirOk(env)) return '';
  if (!supportDir(env)) return SUPPORT_DATA_DIR_UNSET;
  return SUPPORT_DATA_DIR_UNWRITABLE;
}

function warnSupportDataDir(env) {
  if (supportDataDirWarned) return;
  const message = supportDataDirWarning(env);
  if (!message) return;
  supportDataDirWarned = true;
  console.warn(message);
}

module.exports = {
  createCreditLedger,
  redactCreditLog,
  listPurchaseCredits,
  removePurchaseCredits,
  supportDataDirOk,
  supportDataDirWarning,
  warnSupportDataDir,
  HOLD_STALE_MARGIN_MS,
  HANDBACK_ATTEMPTS,
  HANDBACK_BACKOFF_MS,
  RECONCILE_INTERVAL_MS,
};
