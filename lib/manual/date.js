const DEFAULT_ZONE = 'America/Chicago';

function normalizeClientDate(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return '';
  return text;
}

function formatInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => {
    const part = parts.find((item) => item.type === type);
    return part ? part.value : '';
  };
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    throw new RangeError(`Could not format a date in ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

function formatZoneDate(date, timeZone) {
  const requested = String(timeZone || '').trim() || DEFAULT_ZONE;
  try {
    return formatInZone(date, requested);
  } catch {
    if (requested !== DEFAULT_ZONE) {
      try {
        return formatInZone(date, DEFAULT_ZONE);
      } catch {
        /* fall through to UTC */
      }
    }
    return formatInZone(date, 'UTC');
  }
}

function manualDate({ now = new Date(), timeZone = DEFAULT_ZONE, clientDate } = {}) {
  const supplied = normalizeClientDate(clientDate);
  if (supplied) return supplied;
  const date = now instanceof Date ? now : new Date(now);
  return formatZoneDate(Number.isNaN(date.getTime()) ? new Date() : date, timeZone);
}

module.exports = { manualDate, normalizeClientDate, DEFAULT_ZONE };
