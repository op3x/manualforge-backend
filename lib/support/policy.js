const VOICE_TURN_CAP = 12;
const SMS_TURN_CAP = 8;
const THREAD_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_TOKENS = 200;
const HISTORY_LIMIT = 6;
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
};

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

function mappedText(text) {
  const raw = String(text || '');
  let norm = '';
  const spans = [];
  for (let i = 0; i < raw.length;) {
    const cp = raw.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const start = i;
    i += ch.length;
    if (isFormatChar(ch)) continue;
    const folded = ch.normalize('NFKC');
    let piece = '';
    for (const part of folded) {
      if (isFormatChar(part)) continue;
      const digit = asciiDigit(part.codePointAt(0));
      piece += digit || part;
    }
    for (const part of piece) {
      norm += part;
      spans.push([start, i]);
    }
  }
  return { norm, spans };
}

function digitAtoms(mapped) {
  const atoms = [];
  const re = /\p{L}+|\d+/gu;
  let match = re.exec(mapped.norm);
  while (match) {
    const token = match[0];
    const index = match.index;
    if (/^\d+$/.test(token)) {
      for (let n = 0; n < token.length; n += 1) {
        const span = mapped.spans[index + n];
        atoms.push({
          value: token[n],
          start: span[0],
          end: span[1],
          normIndex: index + n,
          normEnd: index + n + 1,
        });
      }
    } else {
      const spoken = DIGIT_WORDS[token.toLowerCase()];
      if (spoken) {
        const first = mapped.spans[index];
        const last = mapped.spans[index + token.length - 1];
        atoms.push({
          value: spoken,
          start: first[0],
          end: last[1],
          normIndex: index,
          normEnd: index + token.length,
        });
      }
    }
    match = re.exec(mapped.norm);
  }
  return atoms;
}

function gapJoins(norm, from, to) {
  const gap = norm.slice(from, to);
  if (!gap) return true;
  if (/\d/.test(gap)) return false;
  const words = gap.split(/[^\p{L}]+/u).filter(Boolean);
  if (!words.length) return true;
  if (words.length === 1 && words[0].length <= 4 && !/^(?:cvv|cvc|exp|expiry|expiration|expires)$/i.test(words[0])) {
    return true;
  }
  return false;
}

function digitRuns(text) {
  const mapped = mappedText(text);
  const atoms = digitAtoms(mapped);
  const runs = [];
  let current = [];
  for (const atom of atoms) {
    if (current.length) {
      const prev = current[current.length - 1];
      if (!gapJoins(mapped.norm, prev.normEnd, atom.normIndex)) {
        runs.push(current);
        current = [];
      }
    }
    current.push(atom);
  }
  if (current.length) runs.push(current);
  return runs;
}

function iinOk(digits) {
  return /^(?:3[47]|4|5[1-5]|2[2-7]|6|3[05689])/.test(digits);
}

function runDigits(atoms, count) {
  let digits = '';
  for (let i = 0; i < count; i += 1) digits += atoms[i].value;
  return digits;
}

function cardSpanForRun(atoms) {
  const count = atoms.length;
  if (count < 13) return null;
  if (count <= 19) {
    const whole = runDigits(atoms, count);
    if (luhn(whole) && iinOk(whole)) return [atoms[0].start, atoms[count - 1].end];
  }
  const minLen = Math.max(13, count - 6);
  const maxLen = Math.min(19, count - 1);
  for (let len = maxLen; len >= minLen; len -= 1) {
    const digits = runDigits(atoms, len);
    if (luhn(digits) && iinOk(digits)) return [atoms[0].start, atoms[len - 1].end];
  }
  return null;
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
  const spans = [];
  for (const atoms of digitRuns(text)) {
    const span = cardSpanForRun(atoms);
    if (span) spans.push(span);
  }
  return mergeSpans(spans);
}

function referenceBefore(text, start) {
  const before = String(text || '').slice(Math.max(0, start - 32), start);
  return /\b(?:order|ref(?:erence)?|job|serial|tracking|invoice|acct)\b\s*[:#-]?\s*$/i.test(before);
}

function expiryEnd(text, end) {
  const rest = text.slice(end);
  const match = rest.match(/^\s*(?:(?:exp(?:iry|iration)?|expires)\b\s*[:#-]?\s*)?(?:0[1-9]|1[0-2])(?:[/\-]\s*|\s+)\d{2}\b/i);
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

function redactRanges(text, ranges) {
  const raw = String(text || '');
  const spans = mergeSpans(ranges);
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

function messageCardRuns(text) {
  return digitRuns(text).map((run) => ({
    digits: run.map((atom) => atom.value).join(''),
    start: run[0].start,
    end: run[run.length - 1].end,
  }));
}

function splitCardGroups(texts) {
  const located = [];
  texts.forEach((text, index) => {
    for (const run of messageCardRuns(text)) located.push({ index, ...run });
  });
  const groups = [];
  for (let start = 0; start < located.length; start += 1) {
    if (located[start].digits.length >= 13) continue;
    let digits = '';
    const members = [];
    for (let cursor = start; cursor < located.length; cursor += 1) {
      if (located[cursor].digits.length >= 13) break;
      if (digits.length + located[cursor].digits.length > 19) break;
      digits += located[cursor].digits;
      members.push(located[cursor]);
      const messages = new Set(members.map((item) => item.index));
      if (messages.size < 2 || digits.length < 13) continue;
      if (luhn(digits) && iinOk(digits)) {
        groups.push(members.map((item) => ({ index: item.index, start: item.start, end: item.end })));
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

function prepareConversation(state, text) {
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
  const unlabeledSplit = groups.some((group) => !groupLabeled(originals, group));
  const redactedUsers = redactUserSeries(originals);
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
  const raw = String(text || '');
  const spans = sensitiveSpans(raw);
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
    'Starter is $39 one-time for 3 manuals.',
    'Pro is $79 per month: unlimited manuals, plus a PM schedule, startup and shutdown procedures, and other documents on request.',
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
  /\bpay you back\b/i,
  /\breturned to your card\b/i,
  /\breturn(?:ed)? your (?:payment|money)\b/i,
  /\bzeroed out\b/i,
  /\bcredit(?:s|ed|ing)?\b(?:\W+\w+){0,6}\W+(?:\$\s?\d[\d.,]*|\bamount\b|\bcard\b)/i,
  /\bwon'?t pay\b/i,
  /\bcomp(?:ed|ing)?\b(?:\W+\w+){0,6}\W+\b(?:account|month|charge|invoice)\b/i,
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

function promisesRefund(text) {
  const raw = normalizeForRefund(text);
  if (!raw) return false;
  const rest = stripAllowlisted(raw);
  const removed = rest !== raw.replace(/\s+/g, ' ').trim();
  if (PROMISE_PATTERNS.some((pattern) => patternHits(pattern, rest))) return true;
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
    reply: clip(gated.reply, 500),
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
  state.updatedAt = null;
  state.startedAt = null;
}

const SAFE_FALLBACK = 'I am not sure about that. Email support@manualos.com if you want a person to follow up.';
const GUARD_SYSTEM = [
  'You are a fail-closed classifier for one outbound ManualOS support reply.',
  'Set refund to true when the reply promises that money, a charge, a payment, or a card charge will be returned, reversed, voided, waived, credited, comped, cancelled, or otherwise given back. The word refund is not required.',
  'Set leak to true when the reply names an AI model or company, or reveals a third-party model or vendor identity, including Claude, Anthropic, OpenAI, GPT, Gemini, Llama, Meta, and Mistral.',
  'If you are unsure, set the relevant field to true.',
  'Respond with one JSON object and nothing else: {"refund":false,"leak":false}',
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
  if (raw == null || String(raw).trim() === '') return 8000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 8000;
  return value;
}

function choiceText(response) {
  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  return messageText(content).trim();
}

function readGuardVerdict(response) {
  const text = choiceText(response).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    const sliced = sliceObject(text);
    if (sliced) {
      try {
        value = JSON.parse(sliced);
      } catch {
        value = null;
      }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: true };
  const hasVerdict = typeof value.refund === 'boolean' || typeof value.leak === 'boolean'
    || value.verdict === 'allow' || value.verdict === 'block';
  if (!hasVerdict && typeof value.reply === 'string') return { stub: true };
  if (!hasVerdict) return { error: true };
  return {
    refund: value.refund === true || value.verdict === 'block',
    leak: value.leak === true || value.identity === true || value.vendor === true,
  };
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

async function guardOutboundReply({ reply, env, complete, llm }) {
  const text = String(reply || '').trim();
  if (!text || isSafeTemplate(text, env) || !complete || !llm || !llm.apiKey) return { reply: text, usage: null };
  const timeoutMs = guardTimeoutMs(env);
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
        }, timeoutMs);
      }),
    ]);
    const verdict = readGuardVerdict(response);
    const usage = usageFrom(response, [{ content: GUARD_SYSTEM }, { content: text }], choiceText(response), env);
    if (verdict.stub) return { reply: text, usage };
    if (verdict.error || verdict.leak) return { reply: SAFE_FALLBACK, usage };
    if (verdict.refund) return { reply: refundReply(env), usage };
    return { reply: text, usage };
  } catch (err) {
    console.error('Outbound classifier failed', err && err.code === 'timeout' ? 'timeout' : 'error');
    return { reply: SAFE_FALLBACK, usage: null };
  } finally {
    clearTimeout(timer);
  }
}

async function triageTurn({
  channel,
  text,
  state,
  env,
  spentUsd,
  complete,
  now,
}) {
  const nowMs = typeof now === 'function' ? now() : Date.now();
  const decide = (decision) => finish(decision, nowMs);
  refreshThread(state, nowMs);
  const prepared = prepareConversation(state, text);
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
  let response;
  try {
    response = await (complete || completeOpenAI)({
      apiKey: llm.apiKey,
      model: llm.model,
      messages,
      maxTokens: MAX_TOKENS,
    });
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
  }

  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  const parsed = parseModelJson(content);
  const guarded = await guardOutboundReply({
    reply: applyGuardrails(parsed.reply, env),
    env,
    complete: complete || completeOpenAI,
    llm,
  });
  const reply = guarded.reply;
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

async function completeOpenAI({ apiKey, model, messages, maxTokens, fetchImpl = globalThis.fetch, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
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
