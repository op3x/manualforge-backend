const fs = require('fs');
const os = require('os');
const path = require('path');

const ephemeralDirectories = new Set();
let exitHooked = false;

function emptyState() {
  return { optOuts: {}, optIns: {}, consents: [], threads: {}, budget: {}, once: {} };
}

function createSupportStore({ directory, env = process.env } = {}) {
  const dir = directory || defaultDirectory(env);
  const file = path.join(dir, 'state.json');

  function readState() {
    try {
      if (!fs.existsSync(file)) return { error: null, state: emptyState() };
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { error: null, state: normalizeState(data) };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { error: null, state: emptyState() };
      console.error('Support store read failed', err && err.code ? err.code : 'error');
      return { error: err, state: null };
    }
  }

  function writeState(state) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function update(mutator) {
    const loaded = readState();
    if (loaded.error) {
      const err = new Error('Support store is unreadable');
      err.status = 500;
      err.expose = true;
      throw err;
    }
    const result = mutator(loaded.state);
    writeState(loaded.state);
    return result;
  }

  function isOptedOut(phone) {
    const loaded = readState();
    // Fail closed: a broken opt-out list must not send another customer text.
    if (loaded.error) return true;
    return Boolean(loaded.state.optOuts[phone]);
  }

  function optOut(phone, source) {
    const at = new Date().toISOString();
    update((state) => {
      state.optOuts[phone] = { at, source: source || 'sms' };
      delete state.optIns[phone];
    });
  }

  function optIn(phone, source) {
    const at = new Date().toISOString();
    return update((state) => {
      const changed = Boolean(state.optOuts[phone]) || !state.optIns[phone];
      delete state.optOuts[phone];
      state.optIns[phone] = { at, source: source || 'sms' };
      return changed;
    });
  }

  function hasConsent(phone, source) {
    const loaded = readState();
    if (loaded.error) return true;
    return loaded.state.consents.some((row) => row && row.phone === phone && row.source === source);
  }

  function addConsent(record) {
    update((state) => {
      state.consents.push({
        phone: record.phone,
        consentTextVersion: record.consentTextVersion,
        timestamp: record.timestamp,
        ip: record.ip || '',
        source: record.source || 'website',
      });
      if (state.consents.length > 5000) {
        state.consents.splice(0, state.consents.length - 5000);
      }
    });
  }

  function listConsents() {
    const loaded = readState();
    if (loaded.error) return [];
    return loaded.state.consents.map((row) => ({ ...row }));
  }

  function getThread(phone) {
    const loaded = readState();
    if (loaded.error) return { turns: 0, lowConfidence: 0, history: [], updatedAt: null };
    return copyThread(loaded.state.threads[phone]);
  }

  function saveThread(phone, thread) {
    update((state) => {
      state.threads[phone] = {
        turns: Number(thread.turns) || 0,
        lowConfidence: Number(thread.lowConfidence) || 0,
        history: Array.isArray(thread.history)
          ? thread.history.slice(-6).map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: String(message.content || '').slice(0, 500),
          }))
          : [],
        updatedAt: new Date().toISOString(),
      };
      pruneThreads(state.threads);
    });
  }

  function spentUsd(month) {
    const loaded = readState();
    if (loaded.error) return Number.POSITIVE_INFINITY;
    const row = loaded.state.budget[month];
    return row ? Number(row.usd) || 0 : 0;
  }

  function addUsage(month, usage) {
    update((state) => {
      const row = state.budget[month] || { inputTokens: 0, outputTokens: 0, usd: 0 };
      row.inputTokens += Number(usage.inputTokens) || 0;
      row.outputTokens += Number(usage.outputTokens) || 0;
      row.usd = roundMoney(row.usd + (Number(usage.usd) || 0));
      state.budget[month] = row;
    });
  }

  function claimOnce(key) {
    if (!key) return true;
    return update((state) => {
      const nowMs = Date.now();
      const cutoff = nowMs - (7 * 24 * 60 * 60 * 1000);
      for (const [existing, at] of Object.entries(state.once)) {
        if (at < cutoff) delete state.once[existing];
      }
      if (state.once[key]) return false;
      state.once[key] = nowMs;
      const keys = Object.keys(state.once);
      if (keys.length > 5000) {
        keys.sort((a, b) => state.once[a] - state.once[b]);
        for (const old of keys.slice(0, keys.length - 5000)) delete state.once[old];
      }
      return true;
    });
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
  };
}

function copyThread(thread) {
  if (!thread) return { turns: 0, lowConfidence: 0, history: [], updatedAt: null };
  return {
    turns: Number(thread.turns) || 0,
    lowConfidence: Number(thread.lowConfidence) || 0,
    history: Array.isArray(thread.history)
      ? thread.history.map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || ''),
      }))
      : [],
    updatedAt: thread.updatedAt || null,
  };
}

function pruneThreads(threads) {
  const entries = Object.entries(threads);
  if (entries.length <= 2000) return;
  entries.sort((a, b) => String(a[1].updatedAt || '').localeCompare(String(b[1].updatedAt || '')));
  for (const [phone] of entries.slice(0, entries.length - 2000)) delete threads[phone];
}

function normalizeState(data) {
  const state = emptyState();
  if (!data || typeof data !== 'object') return state;
  if (data.optOuts && typeof data.optOuts === 'object') state.optOuts = data.optOuts;
  if (data.optIns && typeof data.optIns === 'object') state.optIns = data.optIns;
  if (Array.isArray(data.consents)) state.consents = data.consents;
  if (data.threads && typeof data.threads === 'object') state.threads = data.threads;
  if (data.budget && typeof data.budget === 'object') state.budget = data.budget;
  if (data.once && typeof data.once === 'object') state.once = data.once;
  return state;
}

function roundMoney(value) {
  return Math.round(value * 1e8) / 1e8;
}

function defaultDirectory(env) {
  const configured = env.SUPPORT_DATA_DIR && String(env.SUPPORT_DATA_DIR).trim();
  if (configured) return configured;
  if (String(env.NODE_ENV || '').toLowerCase() === 'test') return makeTestDirectory();
  console.warn('WARNING: SUPPORT_DATA_DIR is not set. SMS opt-outs, consent records, and the monthly LLM budget live on disk that Railway wipes on redeploy. Mount a volume and set SUPPORT_DATA_DIR.');
  return path.join(os.tmpdir(), 'manualos-support');
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
};
