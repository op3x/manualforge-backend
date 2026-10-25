const fs = require('fs');
const path = require('path');

// PR #18's 90-day sweep already keeps consents.jsonl and opt-outs.json.
// Call purgeExpiredConsents from that monthly sweep. It drops consent rows
// once the later of the last outbound text and the opt-out is 5 years old.
// It never deletes opt-out entries.
const FIVE_YEARS_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return data;
}

function stamp(value) {
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? at : 0;
}

function purgeExpiredConsents(directory, nowMs = Date.now()) {
  const dir = String(directory || '');
  const consentFile = path.join(dir, 'consents.jsonl');
  const cutoff = nowMs - FIVE_YEARS_MS;
  const opt = readJson(path.join(dir, 'opt-outs.json'));
  const optOuts = opt.optOuts && typeof opt.optOuts === 'object' ? opt.optOuts : {};
  const lastMessages = opt.lastMessages && typeof opt.lastMessages === 'object' ? opt.lastMessages : {};
  if (!fs.existsSync(consentFile)) return { kept: 0, dropped: 0 };
  const raw = fs.readFileSync(consentFile, 'utf8').split('\n');
  const rows = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch {
      rows.push({ __raw: line });
    }
  }
  const activity = {};
  for (const row of rows) {
    if (row.__raw || !row.phone) continue;
    activity[row.phone] = Math.max(activity[row.phone] || 0, stamp(row.timestamp), stamp(row.occurredAt));
  }
  for (const [phone, at] of Object.entries(lastMessages)) {
    activity[phone] = Math.max(activity[phone] || 0, stamp(at));
  }
  for (const [phone, row] of Object.entries(optOuts)) {
    activity[phone] = Math.max(activity[phone] || 0, stamp(row && row.at));
  }
  const kept = [];
  let dropped = 0;
  for (const row of rows) {
    if (row.__raw) {
      kept.push(row.__raw);
      continue;
    }
    const when = activity[row.phone] || stamp(row.timestamp);
    if (when && when < cutoff) {
      dropped += 1;
      continue;
    }
    kept.push(JSON.stringify(row));
  }
  const tmp = path.join(dir, `.consents.jsonl.${process.pid}.tmp`);
  fs.writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 });
  fs.renameSync(tmp, consentFile);
  return { kept: kept.length, dropped };
}

module.exports = {
  FIVE_YEARS_MS,
  purgeExpiredConsents,
};
