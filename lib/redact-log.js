// Longer and multi-part extensions first so `.tar.gz` and `.step` win over `.gz` / `.st`.
const EXTENSIONS = [
  'tar\\.gz', 'tar\\.bz2', 'tar\\.xz', 'tar\\.zst',
  'sldprt', 'sldasm', 'slddrw',
  'xlsx', 'tcpou', 'step', 'iges',
  'l5x', 'l5k', 'dwg', 'dxf', 'acd', 'awl', 'xml', 'zip', 'xls', 'csv',
  'scl', 'exp', 'stl', 'pdf', 's7p', 'igs', 'stp', 'db',
  'zap\\d*', 'ap\\d*',
  'st',
].join('|');
const EXT_RE = new RegExp(`\\.(?:${EXTENSIONS})\\b`, 'giu');
const BARE_CHAR = /[\p{L}\p{M}\p{N}._()\-]/u;
const VERSION_STEM = /^\d+(?:\.\d+)+$/;
const SEGMENT_DELIM = new Set(['/', '\\', '"', "'", '`']);

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v';
}

function rangeFor(text, extStart, extEnd) {
  let i = extStart;
  let bareStart = extStart;
  let bare = true;
  while (i > 0) {
    const ch = text[i - 1];
    if (SEGMENT_DELIM.has(ch)) {
      if (i === extStart) return null;
      const stem = text.slice(i, extStart);
      if (VERSION_STEM.test(stem)) return null;
      return [i, extEnd];
    }
    if (ch === '\n' || ch === '\r' || ch === '\0') break;
    if (bare) {
      if (BARE_CHAR.test(ch)) {
        bareStart = i - 1;
        i -= 1;
        continue;
      }
      if (isSpace(ch)) {
        bare = false;
        i -= 1;
        continue;
      }
      break;
    }
    if (isSpace(ch) || BARE_CHAR.test(ch)) {
      i -= 1;
      continue;
    }
    break;
  }
  if (bareStart === extStart) return null;
  const stem = text.slice(bareStart, extStart);
  if (VERSION_STEM.test(stem)) return null;
  return [bareStart, extEnd];
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function redactSecrets(value) {
  return String(value || '').replace(/sk_(?:live|test)_[A-Za-z0-9]+|rk_(?:live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|cs_(?:live|test)_[A-Za-z0-9]+|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[redacted]');
}

function redactCustomerLog(value) {
  const text = String(value ?? '');
  const ranges = [];
  EXT_RE.lastIndex = 0;
  let match = EXT_RE.exec(text);
  while (match) {
    const range = rangeFor(text, match.index, match.index + match[0].length);
    if (range) ranges.push(range);
    if (match[0].length === 0) EXT_RE.lastIndex += 1;
    match = EXT_RE.exec(text);
  }
  const merged = mergeRanges(ranges);
  let redacted = text;
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const [start, end] = merged[i];
    redacted = `${redacted.slice(0, start)}[file]${redacted.slice(end)}`;
  }
  return redacted.replace(/Program block\s*:?\s+\S+/giu, 'Program block [redacted]');
}

module.exports = { redactCustomerLog, redactSecrets };
