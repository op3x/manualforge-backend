// Checkout Session ids are cs_test_… or cs_live_…. Anything else is rejected
// before a Stripe retrieve so a bad query, body, or header cannot amplify lookups.
const SESSION_ID_MAX = 255;
const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]+$/;

function sessionIdOk(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SESSION_ID_MAX
    && SESSION_ID_RE.test(value);
}

function maskSessionId(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= 4) return '****';
  return text.slice(-4);
}

// Invalid ids are not a fixed shape. Keep only letters and digits, then the
// last four. Fewer than five of those characters is ****, so a quote, CR, LF,
// NUL, or bidi mark cannot land in the log.
function invalidSessionSuffix(value) {
  const text = typeof value === 'string' ? value : '';
  const cleaned = text.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length <= 4) return '****';
  return cleaned.slice(-4);
}

function invalidSessionId(value) {
  const err = new Error('Session id is invalid.');
  err.status = 400;
  err.expose = true;
  err.publicCode = 'invalid_session_id';
  err.logMessage = `Rejected session id (...${invalidSessionSuffix(value)})`;
  return err;
}

// A missing or blank id stays "required". An array, object, or other non-string
// is invalid and must not be treated as absent.
function coerceSessionId(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  throw invalidSessionId('');
}

function sessionFrom(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
  if (!Object.prototype.hasOwnProperty.call(source, 'session_id')) return '';
  return coerceSessionId(source.session_id);
}

// JSON.parse keeps the last duplicate key. Scan the raw object so two
// session_id keys are rejected before that collapse.
function duplicateTopLevelKey(buf, name) {
  if (!buf || !buf.length) return false;
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n && text.charCodeAt(i) <= 32) i += 1;
  };
  const readString = () => {
    if (text[i] !== '"') throw new Error('string');
    i += 1;
    let out = '';
    while (i < n) {
      const ch = text[i];
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch === '\\') {
        i += 1;
        if (i >= n) throw new Error('escape');
        const esc = text[i];
        i += 1;
        if (esc === 'u') {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('hex');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else out += esc;
      } else {
        out += ch;
        i += 1;
      }
    }
    throw new Error('unterminated');
  };
  const skipValue = () => {
    ws();
    if (i >= n) throw new Error('eof');
    const ch = text[i];
    if (ch === '"') {
      readString();
      return;
    }
    if (ch === '{' || ch === '[') {
      i += 1;
      let depth = 1;
      let inString = false;
      while (i < n && depth) {
        const cur = text[i];
        if (inString) {
          if (cur === '\\') {
            i += 2;
            continue;
          }
          if (cur === '"') inString = false;
          i += 1;
          continue;
        }
        if (cur === '"') {
          inString = true;
          i += 1;
          continue;
        }
        if (cur === '{' || cur === '[') depth += 1;
        else if (cur === '}' || cur === ']') depth -= 1;
        i += 1;
      }
      if (depth) throw new Error('nest');
      return;
    }
    while (i < n && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i += 1;
  };
  ws();
  if (text[i] !== '{') return false;
  i += 1;
  let seen = 0;
  while (i < n) {
    ws();
    if (text[i] === '}') return false;
    const key = readString();
    ws();
    if (text[i] !== ':') throw new Error('colon');
    i += 1;
    if (key === name) {
      seen += 1;
      if (seen > 1) return true;
    }
    skipValue();
    ws();
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] === '}') return false;
    throw new Error('separator');
  }
  return false;
}

function assertSessionId(value) {
  if (!sessionIdOk(value)) throw invalidSessionId(value);
  return value;
}

module.exports = {
  SESSION_ID_MAX,
  SESSION_ID_RE,
  sessionIdOk,
  maskSessionId,
  invalidSessionSuffix,
  invalidSessionId,
  coerceSessionId,
  sessionFrom,
  duplicateTopLevelKey,
  assertSessionId,
};
