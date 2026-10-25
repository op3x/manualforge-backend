const VOICE_TURN_CAP = 12;
const SMS_TURN_CAP = 8;
const THREAD_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_TOKENS = 200;
const HISTORY_LIMIT = 6;
const DIGIT_WINDOW_MS = 30 * 60 * 1000;
const DIGIT_BUFFER_MAX = 8;
const MODEL_TIMEOUT_MS = 9000;
const GUARD_TIMEOUT_MS = 4000;
const TOTAL_BUDGET_MS = 14000;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BUDGET_USD = 10;
// gpt-4o-mini public rates. Override when LLM_MODEL is not this model.
const DEFAULT_INPUT_PER_1M = 0.15;
const DEFAULT_OUTPUT_PER_1M = 0.60;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const CARD_REPLY = 'I cannot take card numbers by phone or text. Please use checkout at https://manualos.com.';
const INTEGRATOR_REPLY = 'The Integrator plan is not available yet. Starter is $39 one-time for 3 manuals, and Pro is $79 per month.';
const LEGAL_REPLY = 'I cannot give legal advice. Email support@manualos.com and the team will follow up.';
const UNSURE_REPLY = 'I am not sure about that. Please try once more, or say representative to reach a person.';

const BRANDS = [
  [/\b(?:allen[\s–—-]*bradley|rockwell|siemens|mitsubishi|omron|beckhoff|automation\s*direct)\s+(?:studio\s*5000|rslogix|controllogix|tia\s*portal|codesys|gx[\s-]*works)\b/gi, 'your PLC software'],
  [/\bsiemens\s+nx\b/gi, 'your PLC software'],
  [/\bsiemens\s+step\s*7\b/gi, 'your PLC software'],
  [/\bstep7\b/gi, 'your PLC software'],
  [/\bSTEP\s+7\b(?!\s*[:.\-–—])/g, 'your PLC software'],
  [/\bStep\s+7\b(?!\s*[:.\-–—])/g, 'your PLC software'],
  [/studio\s*5000/gi, 'your PLC software'],
  [/rslogix/gi, 'your PLC software'],
  [/controllogix/gi, 'your PLC'],
  [/tia\s*portal/gi, 'your PLC software'],
  [/\bcodesys\b/gi, 'your PLC software'],
  [/gx[\s-]*works/gi, 'your PLC software'],
  [/\bcreo\b/gi, 'your CAD software'],
  [/\bcatia\b/gi, 'your CAD software'],
  [/allen[\s–—-]*bradley/gi, 'your PLC'],
  [/rockwell(?!\s+hardness\b)/gi, 'your PLC vendor'],
  [/siemens/gi, 'your PLC vendor'],
  [/\bschneider[\s–—-]*electric\b(?:\s+\S+){0,4}\s+(?:plcs?|modicon|ecostruxure|exports?)\b/gi, 'your PLC vendor'],
  [/\bschneider[\s–—-]*electric\b/gi, 'your PLC vendor'],
  [/\bschneider\b(?:\s+\S+){0,4}\s+(?:plcs?|modicon|ecostruxure|exports?)\b/gi, 'your PLC vendor'],
  [/\b(?:plcs?|modicon|ecostruxure|exports?)\b(?:\s+\S+){0,4}\s+schneider\b/gi, 'your PLC'],
  [/\b(?:modicon|ecostruxure)\b/gi, 'your PLC'],
  [/mitsubishi/gi, 'your PLC vendor'],
  [/omron/gi, 'your PLC vendor'],
  [/beckhoff/gi, 'your PLC vendor'],
  [/automation\s*direct/gi, 'your PLC vendor'],
  [/\bautodesk\s+inventor\b/gi, 'your CAD software'],
  [/autodesk/gi, 'your CAD vendor'],
  [/autocad/gi, 'your CAD files'],
  [/solidworks/gi, 'your CAD files'],
  [/\bsolid\s*edge\b/gi, 'your CAD software'],
  [/fusion\s*360/gi, 'your CAD files'],
  [/\bfusion\s+files?\b/gi, 'your CAD files'],
  [/\bFusion\b(?!\s+(?:welding|splicing)\b)/g, 'your CAD software'],
  [/\binventor\s+files?\b/gi, 'your CAD files'],
  [/\bInventor\b(?!\s+of\b)/g, 'your CAD software'],
  [/onshape/gi, 'your CAD files'],
  [/\bNX\s+files?\b/g, 'your CAD files'],
  [/\bNX\b/g, 'your CAD software'],
  [/\bcompactlogix\b/gi, 'your PLC'],
  [/\blogix\s*designer\b/gi, 'your PLC software'],
  [/\bsimatic\b/gi, 'your PLC software'],
  [/\btwincat\s*\d*\b/gi, 'your PLC software'],
  [/\bfactorytalk\b/gi, 'your PLC software'],
  [/\bi(?:\s+am|['’]m)\s+claude\b/gi, 'I am the assistant'],
  [/\b(?:made|built|created|trained)\s+by\s+(?:anthropic|open[\s-]*ai|google)\b/gi, 'part of ManualOS'],
  [/\bchatgpt\b/gi, 'the assistant'],
  [/\bopen[\s-]*ai\b/gi, 'the assistant'],
  [/\banthropic(?:\s+claude)?\b/gi, 'the assistant'],
  [/\bgemini\b/gi, 'the assistant'],
  [/\bllama\b/gi, 'the assistant'],
  [/\bmistral\b/gi, 'the assistant'],
  [/\bmeta\s*ai\b/gi, 'the assistant'],
  [/\bmeta\b(?!\s*data\b)/gi, 'the assistant'],
  [/\ba model from\s+(?:anthropic|open[\s-]*ai|google|claude)\b/gi, 'the assistant'],
  [/\bgpt-?\s*\d+\w*/gi, 'the assistant'],
  [/\bgpt\b(?!\s+partition\b)/gi, 'the assistant'],
  [/\btwilio\b/gi, 'the phone provider'],
  [/\bgoogle\b(?!\s+(?:it|search)\b)/gi, 'the speech service'],
];

const PERSON_PATTERNS = [
  /\b(?:person|human|agent|operator|representative)\b/i,
  /\breal person\b/i,
  /\btalk to someone\b/i,
  /\b(?:talk|speak|transfer|connect)(?: me)? (?:to|with) (?:a |an )?(?:person|human|someone|somebody|agent|operator|representative|manager|rep)\b/i,
  /\b(?:live|real|actual) (?:agent|person|human|operator|representative)\b/i,
  /\b(?:customer service|support agent)\b/i,
];

const DIGIT_WORDS = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  cero: '0',
  uno: '1',
  dos: '2',
  tres: '3',
  cuatro: '4',
  cinco: '5',
  seis: '6',
  siete: '7',
  ocho: '8',
  nueve: '9',
};

const TEENS = {
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  diez: '10',
  once: '11',
  doce: '12',
  trece: '13',
  catorce: '14',
  quince: '15',
  dieciseis: '16',
  diecisiete: '17',
  dieciocho: '18',
  diecinueve: '19',
};

const TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  veinte: 20,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
};

const SPANISH_HINTS = new Set([
  'tarjeta', 'numero', 'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'veinte', 'treinta', 'cuarenta', 'cincuenta',
]);

const MULTIPLIERS = { double: 2, triple: 3, doble: 2 };

function e164(value) {
  const compact = String(value || '').trim().replace(/[\s()-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  return '';
}

function llmConfig(env) {
  const rawProvider = env.LLM_PROVIDER;
  const provider = String(rawProvider == null || String(rawProvider).trim() === '' ? 'openai' : rawProvider).trim().toLowerCase();
  return {
    providerOk: provider === 'openai',
    apiKey: String(env.LLM_API_KEY || '').trim(),
    model: String(env.LLM_MODEL || '').trim() || DEFAULT_MODEL,
  };
}

function aiConfigured(env) {
  const llm = llmConfig(env);
  return Boolean(llm.providerOk && llm.apiKey);
}

function monthlyBudgetUsd(env) {
  const raw = env.LLM_MONTHLY_BUDGET_USD;
  if (raw == null || String(raw).trim() === '') return DEFAULT_BUDGET_USD;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return DEFAULT_BUDGET_USD;
  return amount;
}

function integratorEnabled(env) {
  const raw = String(env.SUPPORT_INTEGRATOR_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function extraDocumentsEnabled(env) {
  const raw = String((env && env.MANUALOS_EXTRA_DOCUMENTS) || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function monthKey(ms) {
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}

function perToken(env, name, perMillion) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return perMillion / 1_000_000;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return perMillion / 1_000_000;
  return amount / 1_000_000;
}

function tokenCost(usage, env = {}) {
  const prompt = nonNeg(usage && usage.prompt_tokens);
  const completion = nonNeg(usage && usage.completion_tokens);
  const total = nonNeg(usage && usage.total_tokens);
  let input = prompt;
  let output = completion;
  if (!input && !output && total) output = total;
  const usd = (input * perToken(env, 'LLM_USD_PER_1M_INPUT', DEFAULT_INPUT_PER_1M))
    + (output * perToken(env, 'LLM_USD_PER_1M_OUTPUT', DEFAULT_OUTPUT_PER_1M));
  return { inputTokens: input, outputTokens: output, usd: roundMoney(usd) };
}

function nonNeg(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return amount;
}

function roundMoney(value) {
  return Math.round(value * 1e8) / 1e8;
}

function clip(text, max) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 3))}...`;
}

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const ND_CACHE = new Map();

function isFormatChar(ch) {
  return /\p{Cf}/u.test(ch);
}

function isDecimalDigit(cp) {
  if (ND_CACHE.has(cp)) return ND_CACHE.get(cp);
  const yes = /\p{Nd}/u.test(String.fromCodePoint(cp));
  ND_CACHE.set(cp, yes);
  return yes;
}

function asciiDigit(cp) {
  if (cp >= 48 && cp <= 57) return String.fromCharCode(cp);
  if (!isDecimalDigit(cp)) return '';
  let start = cp;
  while (start > 0 && isDecimalDigit(start - 1)) start -= 1;
  return String((cp - start) % 10);
}

function normalizeInbound(text) {
  const raw = String(text || '');
  let out = '';
  for (let i = 0; i < raw.length;) {
    const cp = raw.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (isFormatChar(ch)) continue;
    const folded = ch.normalize('NFKC');
    for (const part of folded) {
      if (isFormatChar(part)) continue;
      const digit = asciiDigit(part.codePointAt(0));
      out += digit || part;
    }
  }
  return out
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function consumeKeycap(raw, index) {
  let end = index;
  const mark = raw.codePointAt(end);
  if (mark === 0xFE0F || mark === 0xFE0E) end += 1;
  if (raw.codePointAt(end) === 0x20E3) end += 1;
  return end;
}

function mappedText(text) {
  const raw = String(text || '');
  let norm = '';
  const spans = [];
  for (let i = 0; i < raw.length;) {
    const cp = raw.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const start = i;
    let next = i + ch.length;
    if (isFormatChar(ch)) {
      i = next;
      continue;
    }
    const folded = ch.normalize('NFKC');
    let piece = '';
    for (let p = 0; p < folded.length;) {
      const pcp = folded.codePointAt(p);
      const pch = String.fromCodePoint(pcp);
      p += pch.length;
      if (isFormatChar(pch)) continue;
      const digit = asciiDigit(pcp);
      piece += digit || pch;
    }
    let end = next;
    if (piece.length === 1 && piece >= '0' && piece <= '9') end = consumeKeycap(raw, next);
    for (let u = 0; u < piece.length; u += 1) {
      norm += piece[u];
      spans.push([start, end]);
    }
    i = end;
  }
  return { norm, spans };
}

function foldWord(word) {
  return String(word || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function mapConfusableToken(token) {
  return String(token || '').replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
}

function confusableDigits(token, neighbors) {
  const raw = String(token || '');
  if (!/^[0-9OoIl]+$/.test(raw)) return '';
  const hasDigit = /\d/.test(raw);
  const hasMark = /[OoIl]/.test(raw);
  if (hasDigit && hasMark && raw.length >= 3 && raw.length <= 19) return mapConfusableToken(raw);
  if (!hasDigit && /^[OoIl]{4}$/.test(raw) && neighbors) return mapConfusableToken(raw);
  return '';
}

const SPANISH_ONLY = new Set([
  'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa', 'doble',
]);

function scanTokens(mapped) {
  const tokens = [];
  const re = /\p{L}+|\d+/gu;
  let match = re.exec(mapped.norm);
  while (match) {
    const token = match[0];
    const index = match.index;
    const startSpan = mapped.spans[index];
    const endSpan = mapped.spans[index + token.length - 1];
    if (startSpan && endSpan) {
      tokens.push({
        token,
        index,
        start: startSpan[0],
        end: endSpan[1],
      });
    }
    match = re.exec(mapped.norm);
  }
  return tokens;
}

function spanishMode(tokens) {
  return tokens.some((item) => SPANISH_HINTS.has(foldWord(item.token)));
}

function mergeConfusables(tokens, norm) {
  const merged = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let current = tokens[i];
    while (i + 1 < tokens.length) {
      const next = tokens[i + 1];
      const gap = norm.slice(current.index + current.token.length, next.index);
      if (gap) break;
      if (!/^[0-9OoIl]+$/.test(current.token) || !/^[0-9OoIl]+$/.test(next.token)) break;
      current = {
        token: current.token + next.token,
        index: current.index,
        start: current.start,
        end: next.end,
      };
      i += 1;
    }
    merged.push(current);
  }
  return merged;
}

function unitDigits(word, spanish) {
  if (!spanish && SPANISH_ONLY.has(word)) return '';
  return DIGIT_WORDS[word] || '';
}

function teenDigits(word, spanish) {
  if (!spanish && SPANISH_ONLY.has(word)) return '';
  return TEENS[word] || '';
}

function tensValue(word, spanish) {
  if (!spanish && SPANISH_ONLY.has(word)) return null;
  return Object.prototype.hasOwnProperty.call(TENS, word) ? TENS[word] : null;
}

function digitAtoms(mapped) {
  const atoms = [];
  const tokens = mergeConfusables(scanTokens(mapped), mapped.norm);
  const spanish = spanishMode(tokens);
  const confusableNeighbor = tokens.some((item) => confusableDigits(item.token, false));
  let groupId = 1;
  function pushAtom(atom) {
    if (atoms.length) {
      const prev = atoms[atoms.length - 1];
      if (atom.normIndex > prev.normEnd && mapped.norm.slice(prev.normEnd, atom.normIndex)) groupId += 1;
    }
    atoms.push({ ...atom, groupId });
  }
  function addDigits(digits, start, end, normIndex, normEnd) {
    const value = String(digits || '');
    for (let i = 0; i < value.length; i += 1) {
      const last = i === value.length - 1;
      pushAtom({
        value: value[i],
        start,
        end,
        normIndex: i === 0 ? normIndex : normIndex,
        normEnd: last ? normEnd : normIndex,
      });
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const current = tokens[i];
    const word = foldWord(current.token);
    const next = tokens[i + 1];
    const third = tokens[i + 2];
    const nextWord = next ? foldWord(next.token) : '';
    const thirdWord = third ? foldWord(third.token) : '';
    if (MULTIPLIERS[word] && (spanish || word !== 'doble')) {
      const repeated = unitDigits(nextWord, spanish) || teenDigits(nextWord, spanish);
      if (repeated && next) {
        addDigits(repeated.repeat(MULTIPLIERS[word]), current.start, next.end, current.index, next.index + next.token.length);
        i += 1;
        continue;
      }
    }
    const tens = tensValue(word, spanish);
    if (tens != null) {
      let ones = '';
      let end = current.end;
      let normEnd = current.index + current.token.length;
      let skip = 0;
      const joiner = nextWord === 'y' || nextWord === 'and' || nextWord === 'e';
      const unitWord = joiner ? thirdWord : nextWord;
      const unitToken = joiner ? third : next;
      const unit = unitDigits(unitWord, spanish);
      if (unit && unit.length === 1 && unitToken) {
        ones = unit;
        end = unitToken.end;
        normEnd = unitToken.index + unitToken.token.length;
        skip = joiner ? 2 : 1;
      }
      addDigits(String(tens + (ones === '' ? 0 : Number(ones))).padStart(2, '0'), current.start, end, current.index, normEnd);
      i += skip;
      continue;
    }
    const teen = teenDigits(word, spanish);
    if (teen) {
      addDigits(teen, current.start, current.end, current.index, current.index + current.token.length);
      continue;
    }
    const spoken = unitDigits(word, spanish);
    if (spoken) {
      addDigits(spoken, current.start, current.end, current.index, current.index + current.token.length);
      continue;
    }
    const disguised = confusableDigits(current.token, confusableNeighbor);
    const digits = /^\d+$/.test(current.token) ? current.token : disguised;
    if (!digits) continue;
    for (let n = 0; n < digits.length; n += 1) {
      const span = mapped.spans[current.index + Math.min(n, current.token.length - 1)];
      if (!span) continue;
      pushAtom({
        value: digits[n],
        start: span[0],
        end: span[1],
        normIndex: current.index + n,
        normEnd: current.index + n + 1,
      });
    }
  }
  return atoms;
}

function gapJoins(norm, from, to, leftLen, rightLen) {
  const gap = norm.slice(Math.min(from, to), Math.max(from, to));
  if (!gap) return true;
  if (from > to) return true;
  if (/\d/.test(gap)) return false;
  const words = gap.match(/\p{L}+/gu) || [];
  if (!words.length) return true;
  const glued = /^\p{L}|\p{L}$/u.test(gap);
  if (glued) {
    return words.length === 1 && words[0].length <= 4 && leftLen >= 4 && rightLen >= 4;
  }
  if (words.length === 1 && words[0].length <= 4 && !/^(?:cvv|cvc|exp|expiry|expiration|expires|zip|postal)$/i.test(words[0])) {
    return true;
  }
  return false;
}

function groupSize(atoms, index) {
  const id = atoms[index].groupId;
  let count = 0;
  for (let i = index; i >= 0 && atoms[i].groupId === id; i -= 1) count += 1;
  for (let i = index + 1; i < atoms.length && atoms[i].groupId === id; i += 1) count += 1;
  return count;
}

function digitRunsFromAtoms(atoms, norm) {
  const runs = [];
  let current = [];
  for (let i = 0; i < atoms.length; i += 1) {
    if (current.length && atoms[i].groupId !== current[current.length - 1].groupId) {
      const prev = current[current.length - 1];
      const leftLen = groupSize(atoms, i - 1);
      const rightLen = groupSize(atoms, i);
      if (!gapJoins(norm, prev.normEnd, atoms[i].normIndex, leftLen, rightLen)) {
        runs.push(current);
        current = [];
      }
    }
    current.push(atoms[i]);
  }
  if (current.length) runs.push(current);
  return runs;
}

function scanDigits(text) {
  const mapped = mappedText(text);
  const atoms = digitAtoms(mapped);
  return { mapped, atoms, runs: digitRunsFromAtoms(atoms, mapped.norm) };
}

function cardOk(digits) {
  if (!luhn(digits)) return false;
  const n = digits.length;
  if (n < 12 || n > 19) return false;
  if (/^4/.test(digits)) return n === 13 || n === 16 || n === 19;
  if (/^3[47]/.test(digits)) return n === 15;
  if (/^(?:5[1-5]|2[2-7])/.test(digits)) return n === 16;
  if (/^35/.test(digits)) return n >= 16 && n <= 19;
  if (/^3(?:0[0-5]|[689])/.test(digits)) return n === 14 || n === 16;
  if (/^6(?:011|5|4[4-9])/.test(digits)) return n >= 16 && n <= 19;
  if (/^(?:50|5[6-9]|6\d)/.test(digits)) return n >= 12 && n <= 19;
  return false;
}

function windowsForRun(atoms) {
  const spans = [];
  const count = atoms.length;
  for (let i = 0; i < count; i += 1) {
    if (i > 0 && atoms[i].groupId === atoms[i - 1].groupId) continue;
    let digits = '';
    for (let j = i; j < count; j += 1) {
      digits += atoms[j].value;
      if (digits.length > 19) break;
      const boundary = j + 1 === count || atoms[j].groupId !== atoms[j + 1].groupId;
      if (!boundary) continue;
      if (!cardOk(digits)) continue;
      const wholeRun = i === 0 && j === count - 1;
      const oneGroup = atoms[i].groupId === atoms[j].groupId;
      if (digits.length === 12 && !wholeRun && !oneGroup) continue;
      spans.push([atoms[i].start, atoms[j].end]);
    }
  }
  let groupStart = 0;
  while (groupStart < count) {
    let groupEnd = groupStart;
    while (groupEnd + 1 < count && atoms[groupEnd + 1].groupId === atoms[groupStart].groupId) groupEnd += 1;
    const length = groupEnd - groupStart + 1;
    if (length > 19) {
      let body = '';
      for (let k = groupStart; k <= groupEnd; k += 1) body += atoms[k].value;
      for (let len = 19; len >= 13; len -= 1) {
        for (let offset = 0; offset + len <= length; offset += 1) {
          if (!cardOk(body.slice(offset, offset + len))) continue;
          spans.push([atoms[groupStart + offset].start, atoms[groupStart + offset + len - 1].end]);
        }
      }
    }
    groupStart = groupEnd + 1;
  }
  return spans;
}

function mergeSpans(spans) {
  const sorted = spans.filter((span) => span[1] > span[0]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (!last || span[0] > last[1]) merged.push([span[0], span[1]]);
    else last[1] = Math.max(last[1], span[1]);
  }
  return merged;
}

function panSpans(text) {
  const { runs } = scanDigits(text);
  const spans = [];
  for (const atoms of runs) spans.push(...windowsForRun(atoms));
  return mergeSpans(spans);
}

function partNumberRanges(norm) {
  const ranges = [];
  const re = /\S+/gu;
  let match = re.exec(norm);
  while (match) {
    const token = match[0];
    if (/\p{L}/u.test(token) && /\d/.test(token)) {
      const groups = token.match(/\d+/g) || [];
      if (groups.some((group) => group.length < 4)) ranges.push([match.index, match.index + token.length]);
    }
    match = re.exec(norm);
  }
  return ranges;
}

function insideRange(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function isNumberWord(word) {
  const folded = foldWord(word);
  if (!folded) return false;
  if (MULTIPLIERS[folded]) return true;
  if (unitDigits(folded, true)) return true;
  if (teenDigits(folded, true)) return true;
  return tensValue(folded, true) != null;
}

function proseLetters(text) {
  const words = String(text || '').match(/\p{L}+/gu) || [];
  return words.filter((word) => !isNumberWord(word)).length;
}

function spokenAtom(text, atom) {
  return /\p{L}/u.test(String(text || '').slice(atom.start, atom.end));
}

function chatterFragment(text, start, digits) {
  const raw = String(text || '');
  const before = raw.slice(Math.max(0, start - 24), start);
  if (digits.length === 5 && /\b(?:zip|postal|postcode)\b/i.test(raw)) return true;
  if (digits.length <= 4 && /\b(?:qty|quantity|ext|extension)\b[\s:#-]*$/i.test(before)) return true;
  if (digits.length <= 3 && proseLetters(raw) >= 2) return true;
  return false;
}

function panFragments(text) {
  const raw = String(text || '');
  const { mapped, runs } = scanDigits(raw);
  const blocked = partNumberRanges(mapped.norm);
  const fragments = [];
  const letters = proseLetters(raw);
  for (const run of runs) {
    let cursor = 0;
    while (cursor < run.length) {
      let end = cursor;
      // A spelled digit is its own one-digit group. Join those words, and a mix of
      // words and digits, before the length rule so a card split across texts survives.
      if (spokenAtom(raw, run[cursor])) {
        while (end + 1 < run.length && spokenAtom(raw, run[end + 1])) end += 1;
      } else {
        while (end + 1 < run.length && run[end + 1].groupId === run[cursor].groupId) end += 1;
      }
      const digits = run.slice(cursor, end + 1).map((atom) => atom.value).join('');
      const atom = run[cursor];
      const keep = digits.length >= 4 || (digits.length >= 2 && letters < 2);
      if (keep && digits.length <= 12 && !insideRange(blocked, atom.normIndex) && !chatterFragment(raw, atom.start, digits)) {
        fragments.push({ digits, start: atom.start, end: run[end].end });
      }
      cursor = end + 1;
    }
  }
  return fragments;
}

function referenceBefore(text, start) {
  const before = String(text || '').slice(Math.max(0, start - 32), start);
  return /\b(?:order|ref(?:erence)?|job|serial|tracking|invoice|acct)\b\s*[:#-]?\s*$/i.test(before);
}

function expiryEnd(text, end) {
  const rest = text.slice(end);
  const match = rest.match(/^\s*(?:(?:exp(?:iry|iration)?|expires)\b\s*[:#-]?\s*)?(?:0[1-9]|1[0-2])(?:[/\-]\s*|\s+)\d{2}\b(?:\s+\d{3,4}\b)?/i);
  return match ? end + match[0].length : end;
}

function cvvSpans(text) {
  const raw = String(text || '');
  const mapped = mappedText(raw);
  const spoken = 'zero|oh|one|two|three|four|five|six|seven|eight|nine';
  const cvv = new RegExp(`\\b(?:cvv|cvc|security code)\\s*(?:is\\s*)?[:#-]?\\s*(?:\\d{3,4}|(?:${spoken})(?:\\s+(?:${spoken})){2,3})\\b`, 'ig');
  const spans = [];
  let match = cvv.exec(mapped.norm);
  while (match) {
    const start = mapped.spans[match.index];
    const end = mapped.spans[match.index + match[0].length - 1];
    if (start && end) spans.push([start[0], end[1]]);
    match = cvv.exec(mapped.norm);
  }
  return spans;
}

function sensitiveSpans(text) {
  const raw = String(text || '');
  const spans = panSpans(raw).map(([start, end]) => [start, expiryEnd(raw, end)]);
  spans.push(...cvvSpans(raw));
  return mergeSpans(spans);
}

function extendTail(raw, end) {
  let index = end;
  while (index < raw.length) {
    const cp = raw.codePointAt(index);
    if (!Number.isFinite(cp)) break;
    const ch = String.fromCodePoint(cp);
    if (cp === 0xFE0F || cp === 0xFE0E || cp === 0x20E3 || /\p{M}/u.test(ch)) {
      index += ch.length;
      continue;
    }
    break;
  }
  return index;
}

function redactRanges(text, ranges) {
  const raw = String(text || '');
  const spans = mergeSpans(ranges).map(([start, end]) => [start, extendTail(raw, end)]);
  if (!spans.length) return raw;
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    out += raw.slice(cursor, from);
    out += '[redacted]';
    cursor = end;
  }
  return out + raw.slice(cursor);
}

function splitCardGroups(texts) {
  const located = [];
  texts.forEach((text, index) => {
    for (const frag of panFragments(text)) located.push({ index, ...frag });
  });
  const groups = [];
  for (let start = 0; start < located.length; start += 1) {
    let digits = '';
    const members = [];
    for (let cursor = start; cursor < located.length; cursor += 1) {
      if (digits.length + located[cursor].digits.length > 19) break;
      digits += located[cursor].digits;
      members.push(located[cursor]);
      const messages = new Set(members.map((item) => item.index));
      if (messages.size < 2 || digits.length < 12) continue;
      if (cardOk(digits)) {
        groups.push(members.map((item) => ({ index: item.index, start: item.start, end: item.end, digits: item.digits })));
      }
    }
  }
  return groups;
}

function groupLabeled(texts, group) {
  const first = group[0];
  return referenceBefore(texts[first.index], first.start);
}

function redactUserSeries(texts) {
  const extra = texts.map(() => []);
  for (const group of splitCardGroups(texts)) {
    for (const member of group) extra[member.index].push([member.start, member.end]);
  }
  return texts.map((text, index) => redactRanges(text, sensitiveSpans(text).concat(extra[index])));
}

function redactStoredHistory(history) {
  const items = (Array.isArray(history) ? history : []).map((message) => ({
    role: message && message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message && message.content || ''),
  }));
  const userSlots = [];
  items.forEach((message, index) => {
    if (message.role === 'user') userSlots.push(index);
  });
  const redactedUsers = redactUserSeries(userSlots.map((index) => items[index].content));
  userSlots.forEach((index, position) => {
    items[index].content = redactedUsers[position];
  });
  return items.map((message) => ({
    role: message.role,
    content: message.role === 'assistant' ? redactCardNumbers(message.content) : message.content,
  }));
}

function freshDigitGroups(state, nowMs) {
  const groups = Array.isArray(state && state.digitGroups) ? state.digitGroups : [];
  return groups.filter((group) => group && typeof group.digits === 'string' && nowMs - Number(group.at) < DIGIT_WINDOW_MS);
}

function matchBuffer(groups) {
  const last = groups.length - 1;
  if (last < 1) return null;
  for (let start = 0; start <= last; start += 1) {
    let digits = '';
    const messages = new Set();
    for (let i = start; i <= last; i += 1) {
      if (digits.length + groups[i].digits.length > 19) break;
      digits += groups[i].digits;
      messages.add(Number(groups[i].msg) || 0);
      // One text is already scanned inline. A 12-digit slice of an order number
      // must not become a card until the digits actually arrive in separate texts.
      if (i === last && i > start && messages.size >= 2 && digits.length >= 12 && cardOk(digits)) {
        return { start, end: i, labeled: Boolean(groups[start].labeled) };
      }
    }
  }
  return null;
}

function prepareConversation(state, text, nowMs) {
  const history = Array.isArray(state && state.history) ? state.history.map((message) => ({
    role: message && message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message && message.content || ''),
  })) : [];
  const userSlots = [];
  history.forEach((message, index) => {
    if (message.role === 'user') userSlots.push(index);
  });
  const originals = userSlots.map((index) => history[index].content).concat([String(text || '')]);
  const groups = splitCardGroups(originals);
  let unlabeledSplit = groups.some((group) => !groupLabeled(originals, group));
  const stamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  const prior = freshDigitGroups(state, stamp);
  const msg = prior.reduce((max, group) => Math.max(max, Number(group.msg) || 0), 0) + 1;
  const covered = panSpans(text);
  const incoming = panFragments(text).filter((frag) => !covered.some(([start, end]) => frag.start >= start && frag.end <= end)).map((frag) => ({
    digits: frag.digits,
    at: stamp,
    labeled: referenceBefore(text, frag.start),
    msg,
  }));
  const buffer = prior.concat(incoming).slice(-DIGIT_BUFFER_MAX);
  const matched = incoming.length ? matchBuffer(buffer) : null;
  const used = new Set();
  if (matched) {
    buffer.slice(matched.start, matched.end + 1).forEach((group) => used.add(group.digits));
    if (!matched.labeled) unlabeledSplit = true;
    state.digitGroups = buffer.slice(0, matched.start).concat(buffer.slice(matched.end + 1));
  } else if (state) {
    state.digitGroups = buffer;
  }
  const redactedUsers = originals.map((value, index) => {
    const extra = [];
    if (used.size) {
      for (const frag of panFragments(value)) {
        if (used.has(frag.digits)) extra.push([frag.start, frag.end]);
      }
    }
    const splitExtra = [];
    for (const group of groups) {
      for (const member of group) {
        if (member.index === index) splitExtra.push([member.start, member.end]);
      }
    }
    return redactRanges(value, sensitiveSpans(value).concat(splitExtra, extra));
  });
  userSlots.forEach((index, position) => {
    history[index].content = redactedUsers[position];
  });
  for (const message of history) {
    if (message.role === 'assistant') message.content = redactCardNumbers(message.content);
  }
  return {
    history,
    inbound: redactedUsers[redactedUsers.length - 1],
    unlabeledSplit,
  };
}

function containsCardNumber(text) {
  const raw = String(text || '');
  return panSpans(raw).some(([start]) => !referenceBefore(raw, start));
}

function redactCardNumbers(text) {
  return redactRanges(text, sensitiveSpans(text));
}

function wantsPerson(text) {
  return PERSON_PATTERNS.some((pattern) => pattern.test(text));
}

function isSafety(text) {
  return /\b(?:emergenc(?:y|ies)|injured|injury|electrocute[sd]?|electric shock|ambulance|smoking|sparking|fire|unsafe|killed|dying|cannot breathe|can't breathe)\b/i.test(text)
    || /\bguard\s+broken\b/i.test(text)
    || /\bguard\s+is\s+broken\b/i.test(text)
    || /\bsafety (?:issue|hazard|problem)\b/i.test(text)
    || /\b(?:someone|somebody) (?:is |was )?(?:hurt|injured)\b/i.test(text);
}

function isLegal(text) {
  return /\b(?:lawyer|attorney|lawsuit|legal action|sue you|suing|take you to court)\b/i.test(text);
}

function isAngry(text) {
  return /\b(?:furious|so angry|really angry|i am angry|i'm angry|unacceptable|this is a scam|rip-?off|worst (?:company|service|product))\b/i.test(text);
}

function isComplaint(text) {
  return /\b(?:complaints?|complain(?:ing|ed)?)\b/i.test(text)
    || /\b(?:unhappy|not happy|disappointed|not satisfied|frustrated|frustrating|poor service|bad experience)\b/i.test(text)
    || isAngry(text);
}

function isBilling(text) {
  const raw = normalizeInbound(text);
  if (/^cancels?[.!]?$/i.test(raw)) return true;
  if (/\bunsubscrib\w*\b/i.test(raw) && /\b(?:premium|tiers?|plans?|services?)\b/i.test(raw)) return true;
  if (/\b(?:refunds?|invoices?|overcharg\w*|charg(?:e|ed|es|ing)|billing|bill(?:ed|s)?|payments?|subscriptions?|subscrib(?:e|ed|ing)|cancellations?|cancell?ed|money\s+back|disput(?:e|ed|es|ing))\b/i.test(raw)) return true;
  if (/\b(?:cancel(?:\s+my)?(?:\s+(?:the\s+)?)?(?:plan|subscription|account|membership|service|pro)|want to cancel|please cancel|cancel my order)\b/i.test(raw)) return true;
  if (/\bhow (?:do|can) i cancel\b/i.test(raw)) return true;
  if (/\b(?:unauthori[sz]ed|didn'?t authori[sz]e|did not authori[sz]e)\b/i.test(raw)) return true;
  if (/\bcharge\s*backs?\b/i.test(raw)) return true;
  if (/\b(?:debit(?:ed|s)?|statements?|receipts?|auto-?renew\w*|stole|stolen)\b/i.test(raw)) return true;
  if (/\bhit twice\b/i.test(raw)) return true;
  if (/\bpaid but\b/i.test(raw)) return true;
  if (/\b(?:downgrade|upgrade)\b/i.test(raw) && /\b(?:me|plan|subscription|account|pro|starter|integrator)\b/i.test(raw)) return true;
  if (/\b(?:took|take)\s+\$\s?\d/i.test(raw)) return true;
  if (/\$\s?\d[\d.,]*(?:\s+\w+){0,3}\s+(?:twice|again|from my)\b/i.test(raw)) return true;
  if (/\btake me off\b/i.test(raw) && /\b(?:plans?|auto-?renew\w*|subscriptions?|memberships?|billing)\b/i.test(raw)) return true;
  const aboutPlan = /\b(?:plans?|subscriptions?|billing|pro|starter|integrator|charges?|payments?|refunds?|cancels?|cancellations?|accounts?)\b/i.test(raw);
  if (aboutPlan && /\b(?:unsubscrib\w*|opt(?:\s+me)?[\s-]+out|remove me)\b/i.test(raw)) return true;
  return false;
}

function classify(text) {
  try {
    const raw = normalizeInbound(text);
    const card = containsCardNumber(raw);
    const person = wantsPerson(raw);
    const billing = isBilling(raw);
    const complaint = isComplaint(raw);
    // Words like "credit card" are not card data. Real digits still escalate billing and complaints.
    if (card && billing) return 'billing';
    if (card && complaint) return 'complaint';
    if (card && person) return 'card-person';
    if (card) return 'card';
    if (person) return 'person';
    if (isSafety(raw)) return 'safety';
    if (isLegal(raw)) return 'legal';
    if (billing) return 'billing';
    if (complaint) return 'complaint';
    return '';
  } catch (err) {
    console.error('Support classify failed');
    return '';
  }
}

const SUPPORT_TIME_ZONE = 'America/Chicago';
const OPEN_START_HOUR = 8;
const OPEN_END_HOUR = 20;

function hourInTimeZone(nowMs, timeZone = SUPPORT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const hour = parts.find((part) => part.type === 'hour');
  const value = hour ? Number(hour.value) : NaN;
  return Number.isFinite(value) ? value : NaN;
}

function isAfterHours(nowMs, timeZone = SUPPORT_TIME_ZONE) {
  const hour = hourInTimeZone(nowMs, timeZone);
  if (!Number.isFinite(hour)) return false;
  return hour < OPEN_START_HOUR || hour >= OPEN_END_HOUR;
}

function escalatesAtThisHour(reason, nowMs) {
  // Billing and complaints always page the owner. A later quiet-hours rule must not drop them.
  if (reason === 'billing' || reason === 'complaint') return true;
  void nowMs;
  return true;
}

function refundWindow(env) {
  if (integratorEnabled(env)) {
    return 'Starter within 30 days of purchase, Pro and Integrator charges before that billing period ends.';
  }
  return 'Starter within 30 days of purchase; Pro charges before that billing period ends.';
}

function refundReply(env) {
  return `A purchase can be refunded only if no manual from it has been delivered: ${refundWindow(env)} I cannot approve or issue a refund. The team will follow up at support@manualos.com.`;
}

function systemPrompt(env, channel) {
  const phone = e164(env.SUPPORT_PHONE);
  const lines = [
    'You are the ManualOS support assistant on a live phone or text line. Answer only from the facts below. If you are unsure, say so.',
    'You are the ManualOS support assistant. Never say you are a named AI model, and never name an AI company.',
    'ManualOS turns PLC and CAD files into operator and maintenance manuals.',
    'Starter is $39 one-time for 3 manuals. Plus applicable taxes.',
    extraDocumentsEnabled(env)
      ? 'Pro is $79 per month: unlimited manuals. Plus applicable taxes. Plus a PM schedule, startup and shutdown procedures, and other documents on request.'
      : 'Pro is $79 per month: unlimited manuals. Plus applicable taxes.',
  ];
  if (integratorEnabled(env)) {
    lines.push('Integrator is $249 per month or $2,490 per year, 25 manuals per month, white-label, and $9 per extra manual.');
  } else {
    lines.push('The Integrator plan is not launched and is not available. Do not mention Integrator pricing. If asked, say it is not available yet.');
  }
  lines.push(
    `A purchase can be refunded only if no manual from it has been delivered: ${refundWindow(env)} You cannot approve or issue a refund. Never promise a refund. The team follows up at support@manualos.com.`,
    'Support email is support@manualos.com.',
    phone ? `The support phone line is ${phone}.` : 'Do not invent a phone number.',
    'You cannot see orders, manuals, or payments. Never invent status. Offer support@manualos.com or a person.',
    'No binding legal advice. No safety instructions for equipment. Urgent or safety issues are handed to a person.',
    'Never accept, repeat, or store card numbers, CVV, or bank details. Refuse and send the caller to checkout at https://manualos.com.',
    'Do not use real third-party brand names. Say "your PLC files" or "your CAD files".',
    'Admit when you are unsure.',
    `Channel: ${channel === 'sms' ? 'sms' : 'voice'}. Keep the reply short enough to speak aloud.`,
    'Respond with one JSON object and nothing else: {"reply":"what the caller hears","confidence":"high|medium|low","handoff":false,"reason":"","summary":"one line for a teammate"}.',
    'Set handoff to true when the caller asks for a person, reports an urgent or safety issue, raises a legal issue, complains, or has any billing issue (charge, refund, invoice, payment, subscription, or cancellation). Billing and complaints are escalated at any hour.',
    'When you set handoff for billing, set reason to "billing". When you set handoff for a complaint, set reason to "complaint".',
    'Set confidence to low when the question is outside these facts.',
  );
  return lines.join('\n');
}

const REFUND_MENTION = /\b(?:refund(?:ed|ing|s)?|reimburse\w*|reimburs\w*ment|money\s+back|credit\s+back)\b/i;
const PROMISE_PATTERNS = [
  REFUND_MENTION,
  /(?:\$\s?\d[\d.,]*|\bmoney\b|\bpayment\b|\bcard\b)(?:\W+\w+){0,6}\W+(?<!\byou\s)\bback\b/i,
  /\bback\b(?:\W+\w+){0,6}\W+(?:\$\s?\d[\d.,]*|\bmoney\b|\bpayment\b|\bcard\b)/i,
  /\b(?:revers(?:e|ed|al|ing)|void(?:ed|ing)?|waiv(?:e|ed|ing))\b(?:\W+\w+){0,8}\W+\b(?:charges?|payments?|cards?|invoices?|amounts?|transactions?)\b/i,
  /\b(?:charges?|payments?|cards?|invoices?|amounts?|transactions?)\b(?:\W+\w+){0,8}\W+\b(?:revers(?:e|ed|al|ing)|void(?:ed|ing)?|waiv(?:e|ed|ing)|returned)\b|\b\$\s?\d[\d.,]*(?:\W+\w+){0,8}\W+\b(?:revers(?:e|ed|al|ing)|void(?:ed|ing)?|waiv(?:e|ed|ing)|returned)\b/i,
  /\breversal\b/i,
  /\bcharge\s*backs?\b/i,
  /\bmake (?:it right|you whole)\b/i,
  /\bmake it right on your (?:bill|invoice|account|statement)\b/i,
  /\b(?:next|this)\s+(?:month|bill|invoice)(?:'s| is)?\s+(?:on us|free|covered|comped)\b/i,
  /\b(?:on us|on the house)\b/i,
  /\bcredit your (?:next\s+)?(?:invoice|bill|account|statement|card)\b/i,
  /\b(?:take care of|cover|wipe|clear) (?:the\s+|this\s+|that\s+|your\s+)?(?:charge|fee|bill|invoice|balance|cost)\b/i,
  /\badjust your (?:bill|invoice|balance|account|statement)\b/i,
  /\b(?:comp|waive) (?:your\s+|the\s+|this\s+)?(?:next\s+)?(?:month|bill|invoice|charge|fee)\b/i,
  /\bpay you back\b/i,
  /\breturned to your card\b/i,
  /\breturn(?:ed)? your (?:payment|money)\b/i,
  /\bzeroed out\b/i,
  /\bcredit(?:s|ed|ing)?\b(?:\W+\w+){0,6}\W+(?:\$\s?\d[\d.,]*|\bamount\b|\bcard\b)/i,
  /\bwon'?t pay\b/i,
  /\bcomp(?:ed|ing)?\b(?:\W+\w+){0,6}\W+\b(?:account|month|charge|invoice)\b/i,
  /\b(?:appl(?:y|ied|ying)|added|issued)\b(?:\W+\w+){0,6}\W+\bcredits?\b/i,
  /\bcredits?\b(?:\W+\w+){0,5}\W+\b(?:your\s+)?(?:account|balance)\b/i,
  /\bcancel(?:l?ed|ling|ing)?\b(?:\W+\w+){0,4}\W+\b(?:the\s+|your\s+|this\s+|that\s+)?charges?\b/i,
  /\bbalance\b(?:\W+\w+){0,6}\W+\$\s*0(?:\.0{1,2})?\b/i,
  /\bmark(?:ed|ing)?\b(?:\W+\w+){0,8}\W+\bpaid\b/i,
  /\$\s?\d[\d.,]*\s+off\b/i,
  /\bfree\s+months?\b/i,
  /\b(?:manuals?|months?)\s+are\s+free\b/i,
  /\b(?:will not|won'?t)\s+be\s+charged\b/i,
  /\b(?:charge|fee|bill|invoice|balance|cost|payment)\b(?:\W+\w+){0,10}\W+\btaken\s+care\s+of\b/i,
  /\bprocess(?:ing)?\s+a\s+return\b/i,
  /\bstore\s+credits?\b/i,
  /\bprorat\w*/i,
  /\bforgiven\b/i,
  /\beat\s+the\s+(?:cost|charge|fee|bill)\b/i,
];
const REFUND_CONTRADICTION = /\b(?:already\s+(?:issued|approved|sent|processed|done)|it is approved|(?:i have|i've)\s+already|already approved|has approved)\b/i;
const APPROVED_REFUND_PHRASES = [
  /\bonly the team can issue a refund\b/gi,
  /\bthe team decides whether to issue a refund\b/gi,
  /\bto (?:get|request) a refund,\s*email support\b/gi,
  /\ba purchase can be refunded only if no manual from it has been delivered\b/gi,
  /\bi\s+can(?:not|['’]t)\s+(?:approve or\s+)?issue (?:a\s+)?refunds?\b/gi,
  /\byou\s+can(?:not|['’]t)\s+approve or issue a refund\b/gi,
  /\brefunds are handled by a person\b/gi,
];

function normalizeForRefund(text) {
  const folded = normalizeInbound(text).normalize('NFD').replace(/\p{M}/gu, '');
  return folded.replace(/(?:\b[A-Za-z][\s.\-–—]+){3,}[A-Za-z]\b/g, (match) => match.replace(/[\s.\-–—]+/g, ''));
}

function stripAllowlisted(text) {
  let rest = String(text || '');
  for (const pattern of APPROVED_REFUND_PHRASES) {
    pattern.lastIndex = 0;
    rest = rest.replace(pattern, ' ');
  }
  return rest.replace(/\s+/g, ' ').trim();
}

function patternHits(pattern, text) {
  pattern.lastIndex = 0;
  return pattern.test(text);
}

const FOREIGN_REFUND = [
  /(?:reembols\w*|devolv\w*|devuelt\w*|devuelv\w*|reintegr\w*|abon(?:o|ar|are|amos|ado|a)?\b|acredit\w*)/i,
  /no\s+(?:se|te|le|les|lo)\s+(?:le\s+|te\s+|les\s+)?cobr/i,
  /\brevert\w*\b(?:\W+\w+){0,6}\W+\bcargos?\b/i,
  /\bcancel\w*\b(?:\W+\w+){0,6}\W+\bcargos?\b/i,
  /\bcompens\w*\b(?:\W+\w+){0,8}\W+\b(?:factura|cargo|cuenta|tarjeta|pago|importe)\b/i,
  /\bno\s+pagar\w*\s+nada\b/i,
  /por\s+nuestra\s+cuenta/i,
  /(?:rembours\w*|rembourser\w*)/i,
  /(?:le\s+mois\s+prochain|c'est)\s+(?:est\s+)?(?:pour\s+nous|gratuit)/i,
  /on\s+prend\s+en\s+charge/i,
  /(?:reembols\w*|estorn\w*|devolv\w*)/i,
  /por\s+nossa\s+conta/i,
  /nao\s+(?:sera|vai\s+ser)\s+cobrad/i,
  /(?:ruckerstatt\w*|zuruckerstatt\w*|erstatt\w*|gutschrift\w*)/i,
  /geld\s+zuruck/i,
  /(?:nachsten|naechsten)\s+monat\s+ubernehmen/i,
  /(?:rimbors\w*|restitu\w*|accredit\w*|storn\w*)/i,
  /a\s+nostro\s+carico/i,
  /non\s+(?:le|ti|vi)\s+verra\s+addebitat/i,
  /退款|退钱|退还|退费|返还|报销|免单|下个?月(?:我们)?(?:免费|请客)|不用付|给你退/,
];

function promisesRefund(text) {
  const raw = normalizeForRefund(text);
  if (!raw) return false;
  const rest = stripAllowlisted(raw);
  const removed = rest !== raw.replace(/\s+/g, ' ').trim();
  if (PROMISE_PATTERNS.some((pattern) => patternHits(pattern, rest))) return true;
  if (FOREIGN_REFUND.some((pattern) => patternHits(pattern, rest))) return true;
  if (removed && patternHits(REFUND_CONTRADICTION, rest)) return true;
  return false;
}

function collapseNeutral(text) {
  const neutral = '(?:your PLC(?: vendor| software)?|your CAD(?: vendor| software| files)?)';
  const re = new RegExp(`${neutral}(?:\\s+${neutral})+`, 'gi');
  return String(text || '').replace(re, (match) => {
    const cad = /CAD/i.test(match);
    const plc = /PLC/i.test(match);
    if (cad && plc) return 'your files';
    if (cad) return 'your CAD files';
    if (/software/i.test(match)) return 'your PLC software';
    return 'your PLC files';
  });
}

function scrubClaude(text) {
  return String(text || '').replace(/\bclaude\b/gi, (match, offset, source) => {
    const after = source.slice(offset + match.length);
    if (/^\s+from\b/i.test(after)) return match;
    if (/^\s+[A-Z][a-z]/.test(after)) return match;
    return 'the assistant';
  });
}

function stripBrands(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of BRANDS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return collapseNeutral(scrubClaude(out));
}

function applyGuardrails(reply, env) {
  const text = redactCardNumbers(String(reply || '')).trim();
  if (!text) return 'I am not sure about that. Email support@manualos.com if you want a person to follow up.';
  if (promisesRefund(text)) return refundReply(env);
  if (!integratorEnabled(env) && /\bintegrator\b/i.test(text)) return INTEGRATOR_REPLY;
  const cleaned = stripBrands(text);
  if (/\b(?:you should sue|you are legally entitled|you have a legal right to)\b/i.test(cleaned)) return LEGAL_REPLY;
  return cleaned;
}

function parseModelJson(raw) {
  const text = messageText(raw).trim();
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = tryJson(stripped) || tryJson(sliceObject(stripped));
  if (parsed) return parsed;
  return {
    reply: text,
    confidence: text ? 'medium' : 'low',
    handoff: false,
    reason: '',
    summary: '',
    parsed: false,
  };
}

function tryJson(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const confidence = ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : 'medium';
    return {
      reply: String(value.reply || '').trim(),
      confidence,
      handoff: Boolean(value.handoff),
      reason: String(value.reason || '').slice(0, 60),
      summary: String(value.summary || '').slice(0, 200),
      parsed: true,
    };
  } catch {
    return null;
  }
}

function sliceObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return '';
}

function handoffReply(reason, channel) {
  if (channel === 'sms') {
    if (reason === 'safety') return 'I cannot give safety advice. A person will follow up by text.';
    if (reason === 'legal') return 'I cannot give legal advice. A person will follow up by text.';
    if (reason === 'billing') return 'A billing question needs a person. The team will follow up. I cannot approve or issue a refund.';
    if (reason === 'complaint' || reason === 'angry') return 'I am sorry this has been frustrating. A person will follow up by text.';
    if (reason === 'turn_cap') return 'I need a person to continue this conversation. The team will follow up.';
    if (reason === 'low_confidence') return 'I am not sure about that. A person will follow up.';
    if (reason === 'budget') return 'Automated replies are paused. A person will call you back.';
    return 'A person will follow up by text.';
  }
  if (reason === 'safety') return 'I cannot give safety advice. Connecting you to a person now.';
  if (reason === 'legal') return 'I cannot give legal advice. Connecting you to a person now.';
  if (reason === 'billing') return 'A billing question needs a person. Connecting you now. I cannot approve or issue a refund.';
  if (reason === 'complaint' || reason === 'angry') return 'I am sorry this has been frustrating. Connecting you to a person now.';
  if (reason === 'turn_cap') return 'I need a person to keep going. Connecting you now.';
  if (reason === 'low_confidence') return 'I am not confident I can answer that. Connecting you to a person.';
  if (reason === 'budget') return 'Automated help is unavailable right now. Connecting you to a person.';
  return 'Connecting you to a person now.';
}

function modelBackupCategory(parsed) {
  const reason = String(parsed && parsed.reason || '').toLowerCase();
  if (/\b(?:billing|charge|refund|invoice|payment|subscription|cancel)/.test(reason)) return 'billing';
  if (/\b(?:complaint|complain|angry|unhappy)/.test(reason)) return 'complaint';
  return '';
}

function applyQuietHours(decision, nowMs) {
  const reason = String(decision.reason || '').slice(0, 40);
  if ((decision.handoff || decision.escalate) && !escalatesAtThisHour(reason, nowMs)) {
    return {
      ...decision,
      handoff: false,
      escalate: false,
      reason: 'quiet_hours',
      reply: 'The team is away right now and will follow up during the day. Email support@manualos.com if you want that noted.',
    };
  }
  return decision;
}

function finish(decision, nowMs) {
  const gated = applyQuietHours(decision, nowMs);
  return {
    handoff: Boolean(gated.handoff),
    escalate: Boolean(gated.escalate),
    reason: String(gated.reason || '').slice(0, 40),
    reply: clip(redactCardNumbers(gated.reply), 500),
    summary: clip(redactCardNumbers(gated.summary || ''), 180),
    usage: gated.usage || null,
  };
}

function refreshThread(state, nowMs) {
  if (!state || typeof state !== 'object') return;
  const at = Date.parse(state.updatedAt || '');
  if (!Number.isFinite(at)) return;
  if (nowMs - at < THREAD_IDLE_MS) return;
  state.turns = 0;
  state.lowConfidence = 0;
  state.history = [];
  state.digitGroups = [];
  state.updatedAt = null;
  state.startedAt = null;
}

const SAFE_FALLBACK = 'I am not sure about that. Email support@manualos.com if you want a person to follow up.';
const GUARD_SYSTEM = [
  'You are a fail-closed classifier for one outbound ManualOS support reply. The reply may be in any language.',
  'Set refund to true when the reply promises, offers, or implies that money, a credit, a charge, a payment, a fee, or a card charge will be returned, reversed, voided, waived, credited, comped, cancelled, discounted away, or otherwise given back. Implied credits count, in every language, including "next month is on us", "we will make it right on your bill", "we will credit your next invoice", and "we will take care of the charge". The word refund is not required.',
  'The assistant never offers money, credits, or refunds. Billing goes to the owner.',
  'Set leak to true when the reply names an AI model or company, or reveals a third-party model or vendor identity, including Claude, Anthropic, OpenAI, GPT, Gemini, Llama, Meta, and Mistral.',
  'If you are unsure, set the relevant field to true.',
  'Respond with one JSON object and nothing else: {"refund":false,"leak":false}. A reply-shaped object is not a verdict.',
].join(' ');

function isSafeTemplate(reply, env) {
  const text = String(reply || '').trim();
  if (!text) return true;
  return [
    refundReply(env),
    refundReply({}),
    refundReply({ SUPPORT_INTEGRATOR_ENABLED: 'true' }),
    CARD_REPLY,
    INTEGRATOR_REPLY,
    LEGAL_REPLY,
    UNSURE_REPLY,
    SAFE_FALLBACK,
  ].includes(text);
}

function guardTimeoutMs(env) {
  const raw = env && env.LLM_GUARD_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return GUARD_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return GUARD_TIMEOUT_MS;
  return value;
}

function modelTimeoutMs(env) {
  const raw = env && env.LLM_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return MODEL_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return MODEL_TIMEOUT_MS;
  return value;
}

function choiceText(response) {
  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  return messageText(content).trim();
}

function strictVerdict(value) {
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (word === 'allow') return { refund: false, leak: false };
    if (word === 'block') return { refund: false, leak: true };
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 1 && (value.verdict === 'allow' || value.verdict === 'block')) {
    return { refund: false, leak: value.verdict === 'block' };
  }
  if (keys.length === 2 && typeof value.refund === 'boolean' && typeof value.leak === 'boolean'
    && keys.every((key) => key === 'refund' || key === 'leak')) {
    return { refund: value.refund, leak: value.leak };
  }
  return null;
}

function readGuardVerdict(response) {
  const text = choiceText(response).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!text) return { error: true };
  const direct = strictVerdict(text);
  if (direct) return direct;
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const parsed = strictVerdict(value);
  if (!parsed) return { error: true };
  return parsed;
}

function addUsage(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return {
    inputTokens: (left.inputTokens || 0) + (right.inputTokens || 0),
    outputTokens: (left.outputTokens || 0) + (right.outputTokens || 0),
    usd: roundMoney((left.usd || 0) + (right.usd || 0)),
  };
}

async function guardOutboundReply({ reply, env, complete, llm, timeoutMs }) {
  const text = redactCardNumbers(String(reply || '')).trim();
  if (!text || isSafeTemplate(text, env) || !complete || !llm || !llm.apiKey) return { reply: text, usage: null };
  const limit = timeoutMs == null ? guardTimeoutMs(env) : timeoutMs;
  if (limit <= 0) return { reply: SAFE_FALLBACK, usage: null };
  const timeoutMsUsed = limit;
  const controller = new AbortController();
  let timer;
  try {
    const response = await Promise.race([
      complete({
        apiKey: llm.apiKey,
        model: llm.model,
        maxTokens: 60,
        messages: [
          { role: 'system', content: GUARD_SYSTEM },
          { role: 'user', content: clip(text, 500) },
        ],
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const err = new Error('timeout');
          err.code = 'timeout';
          reject(err);
        }, timeoutMsUsed);
      }),
    ]);
    const verdict = readGuardVerdict(response);
    const usage = usageFrom(response, [{ content: GUARD_SYSTEM }, { content: text }], choiceText(response), env);
    if (verdict.error || verdict.leak) return { reply: SAFE_FALLBACK, usage };
    if (verdict.refund) return { reply: refundReply(env), usage };
    return { reply: redactCardNumbers(text), usage };
  } catch (err) {
    console.error('Outbound classifier failed', err && err.code === 'timeout' ? 'timeout' : 'error');
    return { reply: SAFE_FALLBACK, usage: null };
  } finally {
    clearTimeout(timer);
  }
}

async function triageTurn(input) {
  try {
    return await triageTurnBody(input || {});
  } catch (err) {
    console.error('Support triage failed');
    const nowMs = input && typeof input.now === 'function' ? input.now() : Date.now();
    return finish({
      handoff: false,
      escalate: false,
      reason: 'error',
      reply: SAFE_FALLBACK,
      summary: 'Support triage failed.',
    }, nowMs);
  }
}

async function triageTurnBody({
  channel,
  text,
  state,
  env,
  spentUsd,
  complete,
  now,
}) {
  const nowMs = typeof now === 'function' ? now() : Date.now();
  const budgetStart = Date.now();
  const decide = (decision) => finish(decision, nowMs);
  refreshThread(state, nowMs);
  const prepared = prepareConversation(state, text, nowMs);
  state.history = prepared.history;
  const safeText = prepared.inbound;
  const cap = channel === 'sms' ? SMS_TURN_CAP : VOICE_TURN_CAP;
  let kind = classify(text);
  if (!kind && prepared.unlabeledSplit) kind = wantsPerson(text) ? 'card-person' : 'card';
  if (kind === 'card' || kind === 'card-person') {
    state.turns += 1;
    const handoff = kind === 'card-person';
    const reply = handoff
      ? `${CARD_REPLY} ${channel === 'sms' ? 'A person will follow up by text.' : 'Connecting you to a person.'}`
      : CARD_REPLY;
    return decide({
      handoff,
      escalate: handoff,
      reason: 'card',
      reply,
      summary: handoff
        ? 'Payment details were refused and the caller asked for a person.'
        : 'Payment details were refused.',
    });
  }
  if (kind) {
    state.turns += 1;
    const reason = kind === 'person' ? 'representative' : kind;
    let reply = handoffReply(reason, channel);
    if (containsCardNumber(text) && (kind === 'billing' || kind === 'complaint')) {
      reply = `${CARD_REPLY} ${reply}`;
    }
    return decide({
      handoff: true,
      escalate: true,
      reason,
      reply,
      summary: `${kind}: ${clip(safeText, 140)}`,
    });
  }
  if (state.turns >= cap) {
    return decide({
      handoff: true,
      escalate: true,
      reason: 'turn_cap',
      reply: handoffReply('turn_cap', channel),
      summary: 'Turn cap reached.',
    });
  }
  const llm = llmConfig(env);
  if (!llm.providerOk || !llm.apiKey || spentUsd >= monthlyBudgetUsd(env)) {
    const reason = 'budget';
    return decide({
      handoff: channel === 'voice',
      escalate: true,
      reason,
      reply: handoffReply(reason, channel),
      summary: 'AI unavailable or monthly budget reached. Please call the customer back.',
    });
  }

  state.turns += 1;
  const history = (Array.isArray(state.history) ? state.history.slice(-HISTORY_LIMIT) : []).map((message) => ({
    role: message && message.role === 'assistant' ? 'assistant' : 'user',
    content: redactCardNumbers(message && message.content),
  }));
  const messages = [
    { role: 'system', content: systemPrompt(env, channel) },
    ...history,
    { role: 'user', content: clip(safeText, 1000) },
  ];
  const modelBudget = Math.min(modelTimeoutMs(env), Math.max(0, TOTAL_BUDGET_MS - (Date.now() - budgetStart)));
  if (modelBudget <= 0) {
    return decide({
      handoff: false,
      escalate: false,
      reason: 'error',
      reply: UNSURE_REPLY,
      summary: 'Model budget exhausted.',
    });
  }
  const modelController = new AbortController();
  let modelTimer;
  let response;
  try {
    response = await Promise.race([
      (complete || completeOpenAI)({
        apiKey: llm.apiKey,
        model: llm.model,
        messages,
        maxTokens: MAX_TOKENS,
        timeoutMs: modelBudget,
        signal: modelController.signal,
      }),
      new Promise((_, reject) => {
        modelTimer = setTimeout(() => {
          modelController.abort();
          const err = new Error('timeout');
          err.code = 'timeout';
          reject(err);
        }, modelBudget);
      }),
    ]);
  } catch (err) {
    console.error('Support model call failed', err && err.status ? String(err.status) : 'error');
    state.lowConfidence += 1;
    if (state.lowConfidence >= 2) {
      return decide({
        handoff: true,
        escalate: true,
        reason: 'low_confidence',
        reply: handoffReply('low_confidence', channel),
        summary: 'Model failed twice.',
      });
    }
    return decide({
      handoff: false,
      escalate: false,
      reason: 'error',
      reply: UNSURE_REPLY,
      summary: 'Model error.',
    });
  } finally {
    clearTimeout(modelTimer);
  }

  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  const parsed = parseModelJson(content);
  const guardBudget = Math.min(guardTimeoutMs(env), Math.max(0, TOTAL_BUDGET_MS - (Date.now() - budgetStart)));
  const guarded = await guardOutboundReply({
    reply: applyGuardrails(redactCardNumbers(parsed.reply), env),
    env,
    complete: complete || completeOpenAI,
    llm,
    timeoutMs: guardBudget,
  });
  const reply = redactCardNumbers(guarded.reply);
  const usage = addUsage(usageFrom(response, messages, content, env), guarded.usage);
  state.history = history.concat([
    { role: 'user', content: clip(safeText, 500) },
    { role: 'assistant', content: clip(reply, 500) },
  ]).slice(-HISTORY_LIMIT);
  if (parsed.confidence === 'low') state.lowConfidence += 1;
  else state.lowConfidence = 0;

  const backup = modelBackupCategory(parsed);
  if (backup) {
    return decide({
      handoff: true,
      escalate: true,
      reason: backup,
      reply: handoffReply(backup, channel),
      summary: parsed.summary || `${backup}: ${clip(safeText, 140)}`,
      usage,
    });
  }
  if (state.lowConfidence >= 2) {
    return decide({
      handoff: true,
      escalate: true,
      reason: 'low_confidence',
      reply: handoffReply('low_confidence', channel),
      summary: parsed.summary || 'Low confidence after 2 tries.',
      usage,
    });
  }
  if (parsed.handoff) {
    return decide({
      handoff: true,
      escalate: true,
      reason: parsed.reason || 'handoff',
      reply: reply || handoffReply('representative', channel),
      summary: parsed.summary || reply,
      usage,
    });
  }
  return decide({
    handoff: false,
    escalate: false,
    reason: '',
    reply,
    summary: parsed.summary || '',
    usage,
  });
}

function usageFrom(response, messages, content, env) {
  const raw = response && response.usage;
  if (raw && (raw.prompt_tokens || raw.completion_tokens || raw.total_tokens)) return tokenCost(raw, env);
  const promptChars = messages.map((message) => String(message.content || '')).join('').length;
  const outChars = messageText(content).length;
  return tokenCost({
    prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)),
    completion_tokens: Math.max(1, Math.ceil(outChars / 4)),
  }, env);
}

async function completeOpenAI({ apiKey, model, messages, maxTokens, fetchImpl = globalThis.fetch, signal, timeoutMs = MODEL_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      const err = new Error('LLM request failed');
      err.status = response.status;
      throw err;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const SMS_FOOTER = 'Reply STOP to opt out, HELP for help. Msg&data rates may apply.';

function formatCustomerSms(body, { footer = true } = {}) {
  let text = clip(body, 320);
  if (footer && !/reply stop to opt out/i.test(text)) text = `${text} ${SMS_FOOTER}`;
  if (!text.startsWith('ManualOS Support:')) text = `ManualOS Support: ${text}`;
  return text;
}

function formatEscalationSms(body) {
  const text = clip(redactCardNumbers(body), 420);
  if (text.startsWith('ManualOS Support:')) return text;
  return `ManualOS Support: ${text}`;
}

module.exports = {
  VOICE_TURN_CAP,
  SMS_TURN_CAP,
  THREAD_IDLE_MS,
  MAX_TOKENS,
  HISTORY_LIMIT,
  DIGIT_WINDOW_MS,
  MODEL_TIMEOUT_MS,
  GUARD_TIMEOUT_MS,
  TOTAL_BUDGET_MS,
  SAFE_FALLBACK,
  DEFAULT_MODEL,
  DEFAULT_BUDGET_USD,
  DEFAULT_INPUT_PER_1M,
  DEFAULT_OUTPUT_PER_1M,
  CARD_REPLY,
  SMS_FOOTER,
  e164,
  llmConfig,
  aiConfigured,
  monthlyBudgetUsd,
  integratorEnabled,
  monthKey,
  tokenCost,
  clip,
  containsCardNumber,
  redactCardNumbers,
  redactStoredHistory,
  normalizeInbound,
  classify,
  promisesRefund,
  isAfterHours,
  escalatesAtThisHour,
  SUPPORT_TIME_ZONE,
  systemPrompt,
  applyGuardrails,
  triageTurn,
  completeOpenAI,
  formatCustomerSms,
  formatEscalationSms,
};
