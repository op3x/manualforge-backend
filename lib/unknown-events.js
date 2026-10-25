const fs = require('fs');
const path = require('path');

const FILE_NAME = 'unknown-events.jsonl';
const SAFE_ID = /^[A-Za-z0-9_.]{1,80}$/;
const MAX_UNKNOWN_EVENT_LINES = 10000;
const MAX_UNKNOWN_EVENT_BYTES = 5 * 1024 * 1024;

// Line count for a file this process has already measured. /health reads this
// instead of the whole log. A path is loaded from disk at most once.
const counts = new Map();

function dataDir(env) {
  if (!env || typeof env.DATA_DIR !== 'string') return '';
  return env.DATA_DIR.trim();
}

function unknownEventsFile(env) {
  const dir = dataDir(env);
  if (!dir) return '';
  return path.join(dir, FILE_NAME);
}

function safeToken(value) {
  if (typeof value !== 'string') return 'unknown';
  if (!SAFE_ID.test(value)) return 'unknown';
  return value;
}

function lineCount(text) {
  if (!text) return 0;
  return text.split('\n').filter((line) => line.trim()).length;
}

function loadCount(file) {
  if (counts.has(file)) return counts.get(file);
  let count = 0;
  if (fs.existsSync(file)) {
    count = lineCount(fs.readFileSync(file, 'utf8'));
  }
  counts.set(file, count);
  return count;
}

function restrictMode(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      const code = err && err.code ? err.code : 'unknown';
      console.error(`Unknown event file mode was not set (${code})`);
    }
  }
}

function bytesOf(lines) {
  if (!lines.length) return 0;
  return Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8');
}

function trimUnknownEvents(file) {
  const count = counts.get(file) || 0;
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (count <= MAX_UNKNOWN_EVENT_LINES && size <= MAX_UNKNOWN_EVENT_BYTES) return;
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  } catch (err) {
    const code = err && err.code ? err.code : 'unknown';
    console.error(`Unknown event file was not trimmed (${code})`);
    return;
  }
  if (lines.length > MAX_UNKNOWN_EVENT_LINES) lines = lines.slice(-MAX_UNKNOWN_EVENT_LINES);
  while (lines.length > 1 && bytesOf(lines) > MAX_UNKNOWN_EVENT_BYTES) lines.shift();
  const body = lines.length ? `${lines.join('\n')}\n` : '';
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  restrictMode(tmp);
  fs.renameSync(tmp, file);
  restrictMode(file);
  counts.set(file, lines.length);
}

function recordUnknownEvent(env, record) {
  const file = unknownEventsFile(env);
  if (!file) return;
  const line = `${JSON.stringify({
    eventId: safeToken(record && record.eventId),
    type: safeToken(record && record.type),
    objectId: safeToken(record && record.objectId),
    timestamp: new Date().toISOString(),
  })}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!counts.has(file)) loadCount(file);
  fs.appendFileSync(file, line, { mode: 0o600 });
  restrictMode(file);
  counts.set(file, (counts.get(file) || 0) + 1);
  trimUnknownEvents(file);
}

function countUnknownEvents(env) {
  const file = unknownEventsFile(env);
  if (!file) return 0;
  return loadCount(file);
}

module.exports = {
  MAX_UNKNOWN_EVENT_LINES,
  MAX_UNKNOWN_EVENT_BYTES,
  recordUnknownEvent,
  countUnknownEvents,
};
