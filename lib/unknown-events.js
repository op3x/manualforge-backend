const fs = require('fs');
const path = require('path');

const FILE_NAME = 'unknown-events.jsonl';
const SAFE_ID = /^[A-Za-z0-9_.]{1,80}$/;

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
  fs.appendFileSync(file, line);
}

function countUnknownEvents(env) {
  const file = unknownEventsFile(env);
  if (!file || !fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8');
  if (!text) return 0;
  return text.split('\n').filter((line) => line.trim()).length;
}

module.exports = {
  recordUnknownEvent,
  countUnknownEvents,
};
