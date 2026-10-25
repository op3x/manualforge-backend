const fs = require('fs');
const path = require('path');
const { isStripeNotFound, refundStarterCredit } = require('./billing');
const { jobTimeoutMs } = require('./job-timeout');

// A restart has no job list. Open holds are the only way to find a PaymentIntent
// that still has credit_hold set. This process's owned set is not written down:
// a hold is eligible only when this process does not have the job, and only once
// credit_hold_at is older than the job timeout plus this margin.
const HOLD_STALE_MARGIN_MS = 60 * 1000;
const HANDBACK_ATTEMPTS = 3;
const HANDBACK_BACKOFF_MS = [5000, 25000];
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const MIN_RECONCILE_INTERVAL_MS = 60 * 1000;
const MAX_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RECONCILE_INTERVAL_MS = RECONCILE_INTERVAL_MS;
// Captured when this module loads. A generation marker older than that was
// written by a process that is no longer running.
const PROCESS_STARTED_AT = Date.now();
let reconcileIntervalWarned = false;
const OPEN_FILE = 'open-holds.json';
const PENDING_FILE = 'credit-handbacks.json';
const DEAD_FILE = 'credit-handbacks-dead.json';
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
  const memory = { open: [], pending: [], dead: [] };
  const owned = new Set();
  const delays = Array.isArray(backoffMs) && backoffMs.length ? backoffMs : HANDBACK_BACKOFF_MS;
  const pause = typeof sleep === 'function' ? sleep : (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  let timer = null;
  let bound = null;
  let rejectedHandbacks = 0;
  let generationSwept = false;
  const warnedTails = new Set();

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

  function bucket(name) {
    if (name === OPEN_FILE) return 'open';
    if (name === DEAD_FILE) return 'dead';
    return 'pending';
  }

  function noteRejected(parsed) {
    const rejected = parsed.filter((item) => !paymentIdShapeOk(item));
    rejectedHandbacks = rejected.length;
    for (const item of rejected) {
      const tail = maskedPaymentTail(item && typeof item === 'object' ? item.paymentIntentId : '');
      if (warnedTails.has(tail)) continue;
      warnedTails.add(tail);
      console.warn(`WARNING: Starter credit hand-back ignored a record whose payment id is not a PaymentIntent (...${tail}).`);
    }
  }

  function readList(name, withHeldAt) {
    if (!dir) {
      if (name === PENDING_FILE) rejectedHandbacks = 0;
      return memory[bucket(name)].slice();
    }
    const file = path.join(dir, name);
    let parsed;
    try {
      if (!fs.existsSync(file)) {
        if (name === PENDING_FILE) rejectedHandbacks = 0;
        return [];
      }
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) {
        if (name === PENDING_FILE) rejectedHandbacks = 0;
        return [];
      }
      parsed = JSON.parse(text);
    } catch {
      console.error(name === OPEN_FILE ? 'Open credit hold record could not be read' : 'Credit hand-back queue could not be read');
      const err = new Error('Credit record could not be read');
      err.unreadable = true;
      throw err;
    }
    if (!Array.isArray(parsed)) {
      if (name === PENDING_FILE) rejectedHandbacks = 0;
      return [];
    }
    if (name === PENDING_FILE) noteRejected(parsed);
    return parsed.filter((item) => valid(item, withHeldAt)).map((item) => (
      withHeldAt
        ? { paymentIntentId: item.paymentIntentId, token: item.token, heldAt: item.heldAt }
        : { paymentIntentId: item.paymentIntentId, token: item.token }
    ));
  }

  function rejectedRows() {
    if (!dir) return [];
    const file = path.join(dir, PENDING_FILE);
    try {
      if (!fs.existsSync(file)) return [];
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) return [];
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => !paymentIdShapeOk(item));
    } catch {
      return [];
    }
  }

  function writeList(name, items, withHeldAt) {
    const clean = items.filter((item) => valid(item, withHeldAt)).map((item) => (
      withHeldAt
        ? { paymentIntentId: item.paymentIntentId, token: item.token, heldAt: item.heldAt }
        : { paymentIntentId: item.paymentIntentId, token: item.token }
    ));
    const payload = name === PENDING_FILE ? clean.concat(rejectedRows()) : clean;
    if (!dir) {
      memory[bucket(name)] = clean;
      return;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeDurableFile(path.join(dir, name), `${JSON.stringify(payload)}\n`);
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

  function health() {
    try {
      const pendingRows = readList(PENDING_FILE, false);
      const deadRows = readList(DEAD_FILE, false);
      readList(OPEN_FILE, true);
      return {
        ok: true,
        pending: pendingRows.length,
        dead: deadRows.length,
        rejected: rejectedHandbacks,
      };
    } catch {
      return { ok: false, pending: null, dead: null, rejected: null };
    }
  }

  function rememberDead(item) {
    if (!valid(item, false)) return;
    const dead = readList(DEAD_FILE, false).filter((row) => !same(row, item));
    dead.push({ paymentIntentId: item.paymentIntentId, token: item.token });
    writeList(DEAD_FILE, dead, false);
    writeList(PENDING_FILE, readList(PENDING_FILE, false).filter((row) => !same(row, item)), false);
    owned.delete(key(item));
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
        if (isStripeNotFound(err)) {
          rememberDead({ paymentIntentId, token });
          console.error('Starter credit hand-back dropped because the payment intent no longer exists');
          return null;
        }
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
        if (isStripeNotFound(err)) {
          rememberDead(item);
          console.error('Starter credit hand-back dropped because the payment intent no longer exists');
          continue;
        }
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

  async function clearStaleGenerations(stripe) {
    const ids = new Set();
    for (const item of readList(OPEN_FILE, true)) ids.add(item.paymentIntentId);
    for (const item of readList(PENDING_FILE, false)) ids.add(item.paymentIntentId);
    for (const paymentIntentId of ids) {
      try {
        const current = await stripe.paymentIntents.retrieve(paymentIntentId);
        const meta = (current && current.metadata) || {};
        const started = Date.parse(typeof meta.generation_started_at === 'string' ? meta.generation_started_at : '');
        if (!Number.isFinite(started) || started >= PROCESS_STARTED_AT) continue;
        await stripe.paymentIntents.update(paymentIntentId, {
          metadata: {
            generation_started_at: '',
            generation_in_progress: '',
          },
        });
      } catch (err) {
        if (isStripeNotFound(err)) continue;
        logFailure(err);
      }
    }
  }

  async function reconcile(stripe, options = {}) {
    const client = stripe || (bound && bound.stripe);
    if (!client || !client.paymentIntents) return;
    await retryPending(client);
    if (!generationSwept) {
      try {
        await clearStaleGenerations(client);
        generationSwept = true;
      } catch (err) {
        console.error('Starter generation marker sweep failed', redactCreditLog(err && err.message ? err.message : err));
      }
    }
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
    const every = Number.isFinite(intervalMs) ? intervalMs : reconcileIntervalMs(env);
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
    health,
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

function writeDurableFile(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  let dirFd;
  try {
    dirFd = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dirFd);
  } catch {
    console.error('Credit record directory sync failed');
  } finally {
    if (dirFd != null) {
      try { fs.closeSync(dirFd); } catch { /* ignore */ }
    }
  }
}

function writeStoredCreditFile(dir, name, items, withHeldAt) {
  const clean = items.filter((item) => creditRecordValid(item, withHeldAt)).map((item) => copyCreditRecord(item, withHeldAt));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeDurableFile(path.join(dir, name), `${JSON.stringify(clean)}\n`);
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

function reconcileIntervalMs(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const raw = source.MANUALOS_RECONCILE_INTERVAL_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_RECONCILE_INTERVAL_MS;
  const requested = String(raw).trim();
  const n = Number(requested);
  if (!Number.isFinite(n) || n < MIN_RECONCILE_INTERVAL_MS || n > MAX_RECONCILE_INTERVAL_MS) {
    const clamped = !Number.isFinite(n)
      ? DEFAULT_RECONCILE_INTERVAL_MS
      : Math.min(MAX_RECONCILE_INTERVAL_MS, Math.max(MIN_RECONCILE_INTERVAL_MS, n));
    if (!reconcileIntervalWarned) {
      reconcileIntervalWarned = true;
      console.warn(`WARNING: MANUALOS_RECONCILE_INTERVAL_MS ${requested} is outside 1 minute to 1 hour and was adjusted to ${clamped}.`);
    }
    return clamped;
  }
  return n;
}

function paymentIdShapeOk(item) {
  return Boolean(item && typeof item === 'object' && typeof item.paymentIntentId === 'string' && PI.test(item.paymentIntentId));
}

function maskedPaymentTail(id) {
  if (typeof id !== 'string' || id.length <= 4) return '****';
  return id.slice(-4);
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
  MIN_RECONCILE_INTERVAL_MS,
  MAX_RECONCILE_INTERVAL_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  reconcileIntervalMs,
};
