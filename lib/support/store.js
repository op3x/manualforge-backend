const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalizeSupportDir, LOCK_WAIT_MS, withSupportLock } = require('./lock');
const { clip, e164, redactCardNumbers, THREAD_IDLE_MS } = require('./policy');

const ephemeralDirectories = new Set();
let exitHooked = false;

function createSupportStore({ directory, env = process.env, now = () => Date.now() } = {}) {
  const digitBuffers = new Map();
  const dir = canonicalizeSupportDir(directory || defaultDirectory(env));
  try {
    withSupportLock(dir, () => migrateLegacy(dir), { waitMs: LOCK_WAIT_MS });
  } catch (err) {
    if (!err || err.code !== 'EBUSY') throw err;
    console.error('Support store lock is busy', 'EBUSY');
  }

  function locked(fn) {
    try {
      return withSupportLock(dir, fn, { waitMs: LOCK_WAIT_MS });
    } catch (err) {
      if (err && err.code === 'EBUSY') throw unreadable();
      throw err;
    }
  }

  function isOptedOut(phone) {
    const loaded = readOptState(dir);
    // Fail closed: a broken opt-out list must not send another customer text.
    if (loaded.error) return true;
    return Boolean(loaded.data.optOuts[phone]);
  }

  function optOut(phone, source) {
    return locked(() => {
      const at = new Date(now()).toISOString();
      const loaded = readOptState(dir);
      if (loaded.error) throw unreadable();
      loaded.data.optOuts[phone] = { at, source: source || 'sms' };
      delete loaded.data.optIns[phone];
      writeJson(dir, 'opt-outs.json', loaded.data);
    });
  }

  function optIn(phone, source) {
    return locked(() => {
      const at = new Date(now()).toISOString();
      const loaded = readOptState(dir);
      if (loaded.error) throw unreadable();
      const changed = Boolean(loaded.data.optOuts[phone]) || !loaded.data.optIns[phone];
      delete loaded.data.optOuts[phone];
      loaded.data.optIns[phone] = { at, source: source || 'sms' };
      writeJson(dir, 'opt-outs.json', loaded.data);
      return changed;
    });
  }

  function hasConsent(phone, source) {
    const loaded = readConsents(dir);
    if (loaded.error) return false;
    return loaded.data.some((row) => row && row.phone === phone && row.source === source);
  }

  function addConsent(record) {
    return locked(() => {
      const row = {
        phone: record.phone,
        consentTextVersion: record.consentTextVersion,
        timestamp: record.timestamp,
        ip: record.ip || '',
        source: record.source || 'website',
      };
      const consentText = optionalString(record.consentText, 1000);
      const scope = optionalString(record.scope, 80);
      const expiresAt = optionalString(record.expiresAt, 40);
      if (consentText) row.consentText = consentText;
      if (scope) row.scope = scope;
      if (typeof record.alerts === 'boolean') row.alerts = record.alerts;
      if (typeof record.pending === 'boolean') row.pending = record.pending;
      if (typeof record.webOptIn === 'boolean') row.webOptIn = record.webOptIn;
      if (typeof record.confirmationSent === 'boolean') row.confirmationSent = record.confirmationSent;
      if (expiresAt) row.expiresAt = expiresAt;
      appendJsonl(dir, 'consents.jsonl', row);
    });
  }

  function listConsents() {
    const loaded = readConsents(dir);
    if (loaded.error) return [];
    return loaded.data.map((row) => ({ ...row }));
  }

  function getThread(phone) {
    const loaded = readObject(dir, 'threads.json');
    if (loaded.error) return freshThread();
    const at = Date.parse((loaded.data[phone] && loaded.data[phone].updatedAt) || '');
    if (Number.isFinite(at) && now() - at >= THREAD_IDLE_MS) {
      digitBuffers.delete(phone);
      return freshThread();
    }
    const thread = copyThread(loaded.data[phone]);
    thread.digitGroups = digitBuffers.get(phone) || [];
    return thread;
  }

  function saveThread(phone, thread) {
    return locked(() => {
      const loaded = readObject(dir, 'threads.json');
      if (loaded.error) throw unreadable();
      const history = Array.isArray(thread.history)
        ? thread.history.slice(-6).map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: redactCardNumbers(String(message.content || '')).slice(0, 500),
        }))
        : [];
      if (Array.isArray(thread.digitGroups)) {
        digitBuffers.set(phone, thread.digitGroups.map((group) => ({
          digits: String(group.digits || '').slice(0, 19),
          at: Number(group.at) || now(),
          labeled: Boolean(group.labeled),
          msg: Number(group.msg) || 0,
        })).slice(-8));
      }
      loaded.data[phone] = {
        turns: Number(thread.turns) || 0,
        lowConfidence: Number(thread.lowConfidence) || 0,
        history,
        startedAt: thread.startedAt || null,
        updatedAt: new Date(now()).toISOString(),
      };
      pruneThreads(loaded.data);
      writeJson(dir, 'threads.json', loaded.data);
    });
  }

  function spentUsd(month) {
    const loaded = readObject(dir, 'budget.json');
    if (loaded.error) return Number.POSITIVE_INFINITY;
    const row = loaded.data[month];
    return row ? Number(row.usd) || 0 : 0;
  }

  function addUsage(month, usage) {
    return locked(() => {
      const loaded = readObject(dir, 'budget.json');
      if (loaded.error) throw unreadable();
      const row = loaded.data[month] || { inputTokens: 0, outputTokens: 0, usd: 0 };
      row.inputTokens += Number(usage.inputTokens) || 0;
      row.outputTokens += Number(usage.outputTokens) || 0;
      row.usd = roundMoney(row.usd + (Number(usage.usd) || 0));
      loaded.data[month] = row;
      writeJson(dir, 'budget.json', loaded.data);
    });
  }

  function claimOnce(key) {
    if (!key) return true;
    return locked(() => {
      const loaded = readObject(dir, 'once.json');
      if (loaded.error) throw unreadable();
      const nowMs = now();
      const cutoff = nowMs - (7 * 24 * 60 * 60 * 1000);
      for (const [existing, at] of Object.entries(loaded.data)) {
        if (at < cutoff) delete loaded.data[existing];
      }
      if (loaded.data[key]) {
        writeJson(dir, 'once.json', loaded.data);
        return false;
      }
      loaded.data[key] = nowMs;
      const keys = Object.keys(loaded.data);
      if (keys.length > 5000) {
        keys.sort((a, b) => loaded.data[a] - loaded.data[b]);
        for (const old of keys.slice(0, keys.length - 5000)) delete loaded.data[old];
      }
      writeJson(dir, 'once.json', loaded.data);
      return true;
    });
  }

  function saveSmsNotice(sid, notice) {
    const id = String(sid || '').slice(0, 64);
    if (!id) return;
    return locked(() => {
      const loaded = readObject(dir, 'sms-notices.json');
      if (loaded.error) throw unreadable();
      const nowMs = now();
      const cutoff = nowMs - (7 * 24 * 60 * 60 * 1000);
      for (const [existing, row] of Object.entries(loaded.data)) {
        if (!row || typeof row !== 'object' || row.at < cutoff) delete loaded.data[existing];
      }
      const source = notice && typeof notice === 'object' ? notice : {};
      loaded.data[id] = {
        key: String(source.key || '').slice(0, 200),
        interaction: String(source.interaction || '').slice(0, 200),
        liveTransfer: Boolean(source.liveTransfer),
        category: clip(redactCardNumbers(source.category || ''), 40),
        from: e164(source.from) || '',
        line: clip(redactCardNumbers(source.line || ''), 180),
        detail: clip(redactCardNumbers(source.detail || ''), 420),
        at: nowMs,
      };
      const keys = Object.keys(loaded.data);
      if (keys.length > 2000) {
        keys.sort((a, b) => (loaded.data[a].at || 0) - (loaded.data[b].at || 0));
        for (const old of keys.slice(0, keys.length - 2000)) delete loaded.data[old];
      }
      writeJson(dir, 'sms-notices.json', loaded.data);
    });
  }

  function getSmsNotice(sid) {
    const loaded = readObject(dir, 'sms-notices.json');
    if (loaded.error) throw unreadable();
    const row = loaded.data[String(sid || '')];
    if (!row || typeof row !== 'object') return null;
    return {
      key: String(row.key || ''),
      interaction: String(row.interaction || ''),
      liveTransfer: Boolean(row.liveTransfer),
      category: clip(redactCardNumbers(row.category || ''), 40),
      from: e164(row.from) || '',
      line: clip(redactCardNumbers(row.line || ''), 180),
      detail: clip(redactCardNumbers(row.detail || ''), 420),
    };
  }

  return {
    directory: dir,
    isOptedOut,
    optOut,
    optIn,
    hasConsent,
    addConsent,
    listConsents,
    getThread,
    saveThread,
    spentUsd,
    addUsage,
    claimOnce,
    saveSmsNotice,
    getSmsNotice,
  };
}

function freshThread() {
  return { turns: 0, lowConfidence: 0, history: [], updatedAt: null, startedAt: null };
}

function copyThread(thread) {
  if (!thread) return freshThread();
  return {
    turns: Number(thread.turns) || 0,
    lowConfidence: Number(thread.lowConfidence) || 0,
    history: Array.isArray(thread.history)
      ? thread.history.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: redactCardNumbers(String(message.content || '')),
      }))
      : [],
    updatedAt: thread.updatedAt || null,
    startedAt: thread.startedAt || null,
  };
}

function pruneThreads(threads) {
  const entries = Object.entries(threads);
  if (entries.length <= 2000) return;
  entries.sort((a, b) => String(a[1].updatedAt || '').localeCompare(String(b[1].updatedAt || '')));
  for (const [phone] of entries.slice(0, entries.length - 2000)) delete threads[phone];
}

function unreadable() {
  const err = new Error('Support store is unreadable');
  err.status = 500;
  err.expose = true;
  return err;
}

function readOptState(dir) {
  const loaded = readObject(dir, 'opt-outs.json');
  if (loaded.error) return loaded;
  return {
    error: null,
    data: {
      optOuts: objectOrEmpty(loaded.data.optOuts),
      optIns: objectOrEmpty(loaded.data.optIns),
    },
  };
}

function readConsents(dir) {
  const file = path.join(dir, 'consents.jsonl');
  try {
    if (!fs.existsSync(file)) return { error: null, data: [] };
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
      } catch {
        // One bad line must not drop the rest of the consent log.
      }
    }
    return { error: null, data: rows };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { error: null, data: [] };
    console.error('Support store read failed', err && err.code ? err.code : 'error');
    return { error: err, data: null };
  }
}

function readObject(dir, name) {
  const loaded = readJson(dir, name, {});
  if (loaded.error) return loaded;
  if (!loaded.data || typeof loaded.data !== 'object' || Array.isArray(loaded.data)) {
    return { error: null, data: {} };
  }
  return loaded;
}

function readJson(dir, name, fallback) {
  const file = path.join(dir, name);
  try {
    if (!fs.existsSync(file)) return { error: null, data: fallback };
    return { error: null, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { error: null, data: fallback };
    console.error('Support store read failed', err && err.code ? err.code : 'error');
    return { error: err, data: null };
  }
}

function writeJson(dir, name, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function appendJsonl(dir, name, record) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function objectOrEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function optionalString(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max);
}

function migrateLegacy(dir) {
  const legacyPath = path.join(dir, 'state.json');
  if (!fs.existsSync(legacyPath)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  } catch {
    console.error('Support store legacy state was not readable');
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'opt-outs.json'))) {
    writeJson(dir, 'opt-outs.json', {
      optOuts: objectOrEmpty(data.optOuts),
      optIns: objectOrEmpty(data.optIns),
    });
  }
  if (!fs.existsSync(path.join(dir, 'budget.json')) && data.budget && typeof data.budget === 'object') {
    writeJson(dir, 'budget.json', data.budget);
  }
  if (!fs.existsSync(path.join(dir, 'threads.json')) && data.threads && typeof data.threads === 'object') {
    writeJson(dir, 'threads.json', data.threads);
  }
  if (!fs.existsSync(path.join(dir, 'once.json')) && data.once && typeof data.once === 'object') {
    writeJson(dir, 'once.json', data.once);
  }
  const consentFile = path.join(dir, 'consents.jsonl');
  if (!fs.existsSync(consentFile) && Array.isArray(data.consents) && data.consents.length) {
    const lines = data.consents
      .filter((row) => row && typeof row === 'object')
      .map((row) => JSON.stringify(row))
      .join('\n');
    if (lines) fs.appendFileSync(consentFile, `${lines}\n`, { mode: 0o600 });
  }
  const migrated = path.join(dir, 'state.json.migrated');
  if (fs.existsSync(migrated)) fs.rmSync(migrated, { force: true });
  fs.renameSync(legacyPath, migrated);
}

function roundMoney(value) {
  return Math.round(value * 1e8) / 1e8;
}

function supportDataDirectory(env = process.env, { warn = true } = {}) {
  const configured = env.SUPPORT_DATA_DIR && String(env.SUPPORT_DATA_DIR).trim();
  if (configured) return canonicalizeSupportDir(configured);
  if (String(env.NODE_ENV || '').toLowerCase() === 'test') return canonicalizeSupportDir(makeTestDirectory());
  if (warn) {
    console.warn('WARNING: SUPPORT_DATA_DIR is not set. SMS opt-outs, consent records, and the monthly LLM budget live on disk that Railway wipes on redeploy. Mount a volume and set SUPPORT_DATA_DIR to a subfolder such as /data/support.');
  }
  return canonicalizeSupportDir(path.join(os.tmpdir(), 'manualos-support'));
}

function defaultDirectory(env) {
  return supportDataDirectory(env);
}

function makeTestDirectory() {
  const root = path.join(os.tmpdir(), 'manualos-support');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 't-'));
  ephemeralDirectories.add(dir);
  if (!exitHooked) {
    exitHooked = true;
    process.on('exit', () => {
      for (const entry of ephemeralDirectories) fs.rmSync(entry, { recursive: true, force: true });
    });
  }
  return dir;
}

function removeTestSupportDirectories() {
  for (const dir of ephemeralDirectories) fs.rmSync(dir, { recursive: true, force: true });
  ephemeralDirectories.clear();
}

module.exports = {
  createSupportStore,
  removeTestSupportDirectories,
  supportDataDirectory,
  THREAD_IDLE_MS,
};
