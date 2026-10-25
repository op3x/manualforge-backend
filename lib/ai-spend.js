const fs = require('fs');
const os = require('os');
const path = require('path');
const { generationPausedError } = require('./ai-budget');
const { limits } = require('./limits');

const FILE_NAME = 'ai-spend.json';
const ALERT_LEVELS = [50, 80];
const PAUSE_PERCENT = 95;
const ZONE = 'America/Chicago';

const ephemeralDirectories = new Set();
let exitHooked = false;
let missingDirWarned = false;

function nonNeg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundMoney(value) {
  return Math.round(value * 1e8) / 1e8;
}

function monthKey(now) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year');
  const month = parts.find((part) => part.type === 'month');
  return `${year ? year.value : '0000'}-${month ? month.value : '01'}`;
}

function percentOf(usd, budget) {
  if (!(budget > 0)) return 100;
  const raw = (Number(usd) || 0) / budget * 100;
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.round(raw * 10) / 10;
}

function spendDirectory(env) {
  const data = env && env.DATA_DIR && String(env.DATA_DIR).trim();
  if (data) return data;
  const support = env && env.SUPPORT_DATA_DIR && String(env.SUPPORT_DATA_DIR).trim();
  if (support) return support;
  if (String(env && env.NODE_ENV || '').toLowerCase() === 'test') return makeTestDirectory();
  if (!missingDirWarned) {
    missingDirWarned = true;
    console.warn('WARNING: DATA_DIR and SUPPORT_DATA_DIR are not set. The monthly manual-generation spend counter is on disk that is wiped on redeploy. Mount a volume and set DATA_DIR or SUPPORT_DATA_DIR.');
  }
  return path.join(os.tmpdir(), 'manualos-ai-spend');
}

function makeTestDirectory() {
  const root = path.join(os.tmpdir(), 'manualos-ai-spend');
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

function emptyBook() {
  return { months: {} };
}

function readBook(file) {
  if (!fs.existsSync(file)) return { error: null, data: emptyBook() };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: new Error('unreadable'), data: null };
    const months = parsed.months && typeof parsed.months === 'object' && !Array.isArray(parsed.months) ? parsed.months : {};
    return { error: null, data: { months } };
  } catch (err) {
    return { error: err, data: null };
  }
}

function writeBook(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE_NAME);
  const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function createAiSpend({
  env = process.env,
  now = () => Date.now(),
  directory,
  warn = (line) => console.warn(line),
} = {}) {
  const dir = directory || spendDirectory(env);
  const file = path.join(dir, FILE_NAME);
  let chain = Promise.resolve();

  function locked(fn) {
    const run = chain.then(() => fn(), () => fn());
    chain = run.then(() => {}, () => {});
    return run;
  }

  function budget() {
    return limits(env).aiMonthlyBudgetUsd;
  }

  function rates() {
    const cap = limits(env);
    return {
      input: cap.aiInputUsdPerMtok / 1_000_000,
      output: cap.aiOutputUsdPerMtok / 1_000_000,
    };
  }

  function rowFor(data, month) {
    const existing = data.months[month];
    if (existing && typeof existing === 'object') {
      return {
        inputTokens: nonNeg(existing.inputTokens),
        outputTokens: nonNeg(existing.outputTokens),
        usd: roundMoney(nonNeg(existing.usd)),
        alerts: existing.alerts && typeof existing.alerts === 'object' ? { ...existing.alerts } : {},
      };
    }
    return { inputTokens: 0, outputTokens: 0, usd: 0, alerts: {} };
  }

  function snapshot() {
    const loaded = readBook(file);
    if (loaded.error) return { error: true, usd: 0, percent: 100, month: monthKey(now()) };
    const month = monthKey(now());
    const row = rowFor(loaded.data, month);
    const percent = percentOf(row.usd, budget());
    return { error: false, usd: row.usd, percent, month };
  }

  function percent() {
    return snapshot().percent;
  }

  function blocksJobs() {
    return snapshot().percent >= PAUSE_PERCENT;
  }

  function recordFailed() {
    console.error('AI spend record failed');
    const err = generationPausedError();
    err.budgetFatal = true;
    return err;
  }

  function record(usage) {
    return locked(() => {
      const loaded = readBook(file);
      if (loaded.error) throw recordFailed();
      const month = monthKey(now());
      const row = rowFor(loaded.data, month);
      const inputTokens = nonNeg(usage && usage.inputTokens);
      const outputTokens = nonNeg(usage && usage.outputTokens);
      const price = rates();
      row.inputTokens += inputTokens;
      row.outputTokens += outputTokens;
      row.usd = roundMoney(row.usd + (inputTokens * price.input) + (outputTokens * price.output));
      const percent = percentOf(row.usd, budget());
      const alerts = [];
      for (const level of ALERT_LEVELS) {
        if (percent >= level && !row.alerts[String(level)]) {
          row.alerts[String(level)] = true;
          alerts.push({ event: 'ai_spend_alert', level, percent, month });
        }
      }
      loaded.data.months[month] = row;
      try {
        writeBook(dir, loaded.data);
      } catch (err) {
        throw recordFailed();
      }
      for (const line of alerts) warn(JSON.stringify(line));
      return { percent, month };
    });
  }

  return { directory: dir, percent, blocksJobs, record, monthKey: () => monthKey(now()) };
}

function removeTestSpendDirectories() {
  for (const dir of ephemeralDirectories) fs.rmSync(dir, { recursive: true, force: true });
  ephemeralDirectories.clear();
}

module.exports = {
  createAiSpend,
  removeTestSpendDirectories,
  monthKey,
  PAUSE_PERCENT,
  ALERT_LEVELS,
};
