const MNEMONICS = new Set('XIC XIO OTE OTL OTU TON TOF RTO CTU CTD RES MOV COP CLR ADD SUB MUL DIV EQU NEQ GRT GEQ LES LEQ AND OR XOR JSR RET SBR AFI NOP MSG GSV SSV FLL CMP CPT LIM PID PIDE BTD IOT ONS OSR OSF JMP LBL MCR UID UIE TND SCP SWPB SIZE'.split(' '));

const DICT = {
  conv: 'conveyor', conveyor: 'conveyor', infeed: 'infeed', outfeed: 'discharge',
  discharge: 'discharge', erector: 'erector', estop: 'emergency stop', estp: 'emergency stop',
  pb: 'pushbutton', sol: 'solenoid', pe: 'sensor', prox: 'sensor', ps: 'pressure switch',
  lt: 'indicator', mtr: 'motor', mot: 'motor', cyl: 'cylinder', jam: 'jam',
  door: 'door', doors: 'doors', guard: 'guard', guards: 'guards', start: 'start',
  stop: 'stop', run: 'run', reset: 'reset', fault: 'fault', alarm: 'alarm',
  glue: 'glue', vacuum: 'vacuum', flap: 'flap', case: 'case', blank: 'blank',
  mag: 'magazine', magazine: 'magazine', hmi: 'operator panel', auto: 'automatic',
  man: 'manual', mode: 'mode', air: 'air', ok: 'ok', closed: 'closed', present: 'present',
  ready: 'ready', seq: 'sequence', main: 'main', motor: 'motor', belt: 'belt',
  sensor: 'sensor', valve: 'valve', photo: 'photoelectric sensor', eye: 'sensor',
  lamp: 'lamp', light: 'light', curtain: 'light curtain', safety: 'safety',
  chain: 'circuit', interlock: 'interlock', enable: 'enable', home: 'home',
  pick: 'pick', place: 'place', gripper: 'gripper', clamp: 'clamp', lift: 'lift',
  axis: 'axis', servo: 'servo', drive: 'drive', spindle: 'spindle', robot: 'robot',
  conveyorrun: 'conveyor run',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMnemonic(word) {
  return MNEMONICS.has(String(word || '').toUpperCase());
}

const PROTECTED_WORDS = new Set('logic plc control alarm main stop start fault reset mode hmi sto sccr fla loto estop'.split(' '));
const TEMPLATE_HEADINGS = new Set(require('../data/section-model.json').sections.map((section) => section.title));

function isRawIdentifier(name) {
  const s = String(name || '');
  if (!s) return false;
  if (/[{}<>]/.test(s)) return true;
  if (/_/.test(s) || /\d/.test(s)) return true;
  if (/routine$/i.test(s)) return true;
  if (/^[A-Z]{2,6}$/.test(s) && isMnemonic(s)) return true;
  return false;
}

function looksRawName(name) {
  const s = String(name || '').trim();
  if (s.length < 2) return false;
  if (PROTECTED_WORDS.has(s.toLowerCase())) return false;
  if (/[{}<>]/.test(s)) return true;
  if (/_/.test(s) || /\d/.test(s)) return true;
  if (/[a-z][A-Z]/.test(s)) return true;
  if (/^[A-Z]{3,8}$/.test(s)) return true;
  return false;
}

function isTemplateHeading(text) {
  return TEMPLATE_HEADINGS.has(String(text || '').trim());
}

function humanize(raw) {
  let s = String(raw || '').replace(/^(?:R|N|P|B|T|C)\d{1,4}_/i, '');
  s = s.replace(/([a-z\d])([A-Z])/g, '$1 $2');
  s = s.replace(/[_\-.]+/g, ' ');
  const words = [];
  const seen = new Set();
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const key = word.toLowerCase();
    let next = '';
    if (DICT[key]) {
      next = DICT[key].split(' ').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    } else if (/routine/i.test(word) || /^\d+$/.test(word) || isMnemonic(word)) {
      next = '';
    } else if (/^[A-Za-z]{3,}$/.test(word)) {
      next = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    if (!next) continue;
    const token = next.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    words.push(next);
  }
  let out = words.join(' ').replace(/\s+/g, ' ').trim();
  if (/^Main$/i.test(out)) out = 'Main control';
  if (!out || isRawIdentifier(out) || /[{}]/.test(out) || /\bRoutine\b/i.test(out)) return '';
  return out;
}

function headingFrom(raw, fallback) {
  const cleaned = humanize(raw);
  if (cleaned) return cleaned;
  const fb = humanize(fallback);
  return fb || 'Machine function';
}

function decodeXmlEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity[1] === 'x') return String.fromCodePoint(parseInt(entity.slice(2), 16));
    return String.fromCodePoint(parseInt(entity.slice(1), 10));
  });
}

function decodeBuffer(buffer) {
  if (!buffer || !buffer.length) return '';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.slice(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.slice(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const a = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = a;
    }
    return swapped.toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.slice(3).toString('utf8');
  let zeros = 0;
  const sample = Math.min(buffer.length, 240);
  for (let i = 1; i < sample; i += 2) if (buffer[i] === 0) zeros += 1;
  if (sample > 40 && zeros > sample / 4) return buffer.toString('utf16le');
  return buffer.toString('utf8');
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function safeName(name) {
  const base = String(name || 'upload').split(/[/\\]/).pop().replace(/[^\w.\- ]+/g, '').slice(0, 80);
  return base || 'upload';
}

function cssString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').slice(0, 180);
}

function describeOperand(operand, tagsByName) {
  const raw = String(operand || '').split(',')[0].trim();
  if (!raw || /^[\d.\-]+$/.test(raw)) return '';
  const base = raw.split('.')[0].split('[')[0];
  const tag = tagsByName.get(base.toLowerCase());
  if (tag && tag.description) return tag.description;
  return humanize(base) || '';
}

function describeInstruction(mnemonic, operand, tagsByName) {
  const name = describeOperand(operand, tagsByName);
  if (!name) return '';
  switch (mnemonic) {
    case 'XIC': return `${name} is on`;
    case 'XIO': return `${name} is off`;
    case 'OTE': return `turns on ${name}`;
    case 'OTL': return `latches ${name}`;
    case 'OTU': return `unlatches ${name}`;
    case 'TON':
    case 'TOF':
    case 'RTO': return `runs a timer for ${name}`;
    case 'CTU':
    case 'CTD': return `counts with ${name}`;
    case 'RES': return `resets ${name}`;
    case 'JSR': return `calls ${name}`;
    case 'MOV':
    case 'COP': return `copies a value into ${name}`;
    default: return `acts on ${name}`;
  }
}

function translateLogic(text, tagsByName) {
  const instructions = [];
  const re = /\b([A-Za-z]{2,6})\(([^)]*)\)/g;
  let match;
  const source = String(text || '');
  while ((match = re.exec(source)) !== null) {
    const mnemonic = match[1].toUpperCase();
    if (MNEMONICS.has(mnemonic)) instructions.push({ mnemonic, operand: match[2] });
  }
  if (!instructions.length) return '';
  const conditions = [];
  const results = [];
  for (const item of instructions) {
    if (item.mnemonic === 'NOP' || item.mnemonic === 'AFI') continue;
    const phrase = describeInstruction(item.mnemonic, item.operand, tagsByName);
    if (!phrase) continue;
    if (item.mnemonic === 'XIC' || item.mnemonic === 'XIO') conditions.push(phrase);
    else results.push(phrase);
  }
  if (conditions.length && results.length) {
    return `When ${conditions.join(' and ')}, the control ${results.join(' and ')}.`;
  }
  if (results.length) return `The control ${results.join(' and ')}.`;
  if (conditions.length) return `This checks that ${conditions.join(' and ')}.`;
  return '';
}

function comparisonWord(operator) {
  if (operator === '<') return 'less than';
  if (operator === '<=') return 'less than or equal to';
  if (operator === '>') return 'greater than';
  if (operator === '>=') return 'greater than or equal to';
  if (operator === '<>') return 'not equal to';
  if (operator === '=') return 'equal to';
  return '';
}

function translateStructuredText(text, tagsByName) {
  const source = String(text || '')
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/\/\/.*$/gm, ' ');
  if (!/:=|\bIF\b|\bCASE\b|\bWHILE\b/i.test(source)) return '';
  const sentences = [];
  const lines = source.split(/[;\n]/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (sentences.length >= 4) break;
    const conditional = line.match(/^IF\s+(.+?)\s+THEN\b\s*(.*)$/i);
    if (conditional) {
      const cmp = conditional[1].match(/([A-Za-z_][\w.]*)\s*(<=|>=|<>|<|>|=)\s*([A-Za-z_][\w.]*|\d+(?:\.\d+)?)/);
      const assign = String(conditional[2] || '').match(/([A-Za-z_][\w.]*)\s*:=\s*([A-Za-z0-9_.]+)/);
      let verb = 'acts on';
      let dest = 'the output';
      if (assign) {
        dest = describeOperand(assign[1], tagsByName) || 'the output';
        if (/^(?:TRUE|1)$/i.test(assign[2])) verb = 'turns on';
        else if (/^(?:FALSE|0)$/i.test(assign[2])) verb = 'turns off';
        else verb = 'sets';
      }
      if (cmp) {
        const left = describeOperand(cmp[1], tagsByName) || 'the measured value';
        const right = /^\d/.test(cmp[3]) ? cmp[3] : (describeOperand(cmp[3], tagsByName) || 'the setpoint');
        sentences.push(`${verb} ${dest} when ${left} is ${comparisonWord(cmp[2])} ${right}`);
      } else {
        sentences.push(`${verb} ${dest} when the condition is true`);
      }
      continue;
    }
    const assign = line.match(/^([A-Za-z_][\w.]*)\s*:=\s*(.+)$/);
    if (assign) {
      const dest = describeOperand(assign[1], tagsByName);
      if (!dest) continue;
      if (/^(?:TRUE|1)$/i.test(assign[2].trim())) sentences.push(`turns on ${dest}`);
      else if (/^(?:FALSE|0)$/i.test(assign[2].trim())) sentences.push(`turns off ${dest}`);
      else sentences.push(`sets ${dest}`);
      continue;
    }
    if (/^CASE\b/i.test(line)) sentences.push('selects an action from the machine state');
  }
  if (!sentences.length) return '';
  return `The control ${sentences.join(', ')}.`;
}

function commentIsPlain(comment, forbidden) {
  const text = String(comment || '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/(?:[-_=*]\s*){3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length < 8) return false;
  if (/\bset to \d|\balready scaled\b|\bPV\b|\bByp\b/i.test(text)) return false;
  if (/[{}]/.test(text) || /\b(XIC|XIO|OTE|OTL|OTU|TON|JSR)\b/.test(text)) return false;
  for (const name of forbidden) {
    if (name && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text)) return false;
  }
  return true;
}

function shieldAlarmCodes(text) {
  const saved = [];
  const shielded = String(text || '').replace(/\bALM-\d+\b/g, (code) => {
    saved.push(code);
    return `\u0000A${saved.length - 1}\u0000`;
  });
  return { shielded, saved };
}

function restoreAlarmCodes(text, saved) {
  return String(text || '').replace(/\u0000A(\d+)\u0000/g, (all, index) => saved[Number(index)] || all);
}

function sanitizeProse(text, project) {
  const original = String(text || '');
  if (isTemplateHeading(original)) return original.trim();
  const shielded = shieldAlarmCodes(original);
  let s = shielded.shielded
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/(?:[-_=*]\s*){3,}/g, ' ');
  const tags = tagIndex(project);
  s = s.replace(/\b([A-Za-z]{2,6})\(([^)]*)\)/g, (all, mnemonic, operand) => {
    const upper = mnemonic.toUpperCase();
    if (!MNEMONICS.has(upper)) return all;
    return describeInstruction(upper, operand, tags);
  });
  s = s.replace(/\b(XIC|XIO|OTE|OTL|OTU|TON|TOF|RTO|CTU|CTD|JSR|AFI|NOP|RES|MOV|COP|CLR)\b/g, '');
  const names = [];
  for (const tag of project.tags || []) if (looksRawName(tag.name)) names.push(tag);
  for (const routine of project.routines || []) {
    if (looksRawName(routine.name)) names.push({ name: routine.name, description: humanize(routine.name) });
  }
  names.sort((a, b) => b.name.length - a.name.length);
  for (const tag of names) {
    let replacement = tag.description || humanize(tag.name) || 'the signal';
    if (!replacement || replacement === tag.name || new RegExp(`\\b${escapeRegExp(tag.name)}\\b`).test(replacement)) {
      replacement = humanize(tag.name) || 'the signal';
    }
    if (!replacement || replacement === tag.name || isRawIdentifier(replacement) || looksRawName(replacement)) replacement = 'the signal';
    if (PROTECTED_WORDS.has(String(tag.name).toLowerCase())) continue;
    const flags = /[_\d{}<>]/.test(tag.name) ? 'gi' : 'g';
    s = s.replace(new RegExp(`\\b${escapeRegExp(tag.name)}\\b`, flags), replacement);
  }
  s = s.replace(/[{}<>]/g, ' ');
  s = s.replace(/\b(?:Local:)?[A-Z]{1,3}:\d+(?:\/\d+)?(?:\.\w+)*/g, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
  return restoreAlarmCodes(s, shielded.saved);
}

function tagIndex(project) {
  const map = new Map();
  for (const tag of project.tags || []) {
    if (tag && tag.name) map.set(String(tag.name).toLowerCase(), tag);
  }
  return map;
}

function forbiddenNames(project) {
  const names = [];
  for (const tag of project.tags || []) if (looksRawName(tag.name)) names.push(tag.name);
  for (const routine of project.routines || []) if (looksRawName(routine.name)) names.push(routine.name);
  return names.sort((a, b) => b.length - a.length);
}

function trackedNames(project) {
  const exact = new Set();
  const lower = new Set();
  for (const name of forbiddenNames(project)) {
    if (!name || name.length < 4) continue;
    if (isRawIdentifier(name)) {
      exact.add(name);
      lower.add(name.toLowerCase());
      continue;
    }
    if (/[a-z][A-Z]|_|\d/.test(name)) exact.add(name);
  }
  return { exact, lower };
}

function identifierHits(text, sets) {
  if (!sets.exact.size && !sets.lower.size) return '';
  const re = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
  let match;
  while ((match = re.exec(text))) {
    if (sets.exact.has(match[0]) || sets.lower.has(match[0].toLowerCase())) return match[0];
  }
  return '';
}

function snippetAround(text, index, length) {
  const source = String(text || '');
  const start = Math.max(0, index - 48);
  const end = Math.min(source.length, index + Math.max(length, 1) + 48);
  let snippet = source.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < source.length) snippet = `${snippet}…`;
  return snippet.slice(0, 140);
}

function replaceTracked(text, names) {
  if (!names.exact.size && !names.lower.size) return String(text || '');
  return String(text || '').replace(/[A-Za-z_][A-Za-z0-9_]{3,}/g, (word) => (
    names.exact.has(word) || names.lower.has(word.toLowerCase()) ? 'the signal' : word
  ));
}

function headingViolations(headings, project) {
  const bad = [];
  const names = trackedNames(project);
  for (const heading of headings) {
    const text = String(heading || '');
    const mnemonic = text.match(/[{}]|\b(XIC|XIO|OTE|OTL|OTU|TON|TOF|RTO|CTU|CTD|JSR|AFI)\b/);
    if (mnemonic) {
      bad.push(snippetAround(text, mnemonic.index, mnemonic[0].length));
      continue;
    }
    const hit = identifierHits(text, names);
    if (hit) bad.push(snippetAround(text, text.indexOf(hit), hit.length));
  }
  return bad;
}

function proseViolations(text, project) {
  const names = trackedNames(project);
  const bad = [];
  const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const hit = identifierHits(sentence, names);
    if (!hit) continue;
    const at = sentence.toLowerCase().indexOf(hit.toLowerCase());
    bad.push(snippetAround(sentence, at < 0 ? 0 : at, hit.length));
    if (bad.length >= 8) break;
  }
  return bad;
}

function scrubField(text, project) {
  const original = String(text || '');
  if (!original || isTemplateHeading(original)) return { text: original.trim(), snippets: [] };
  const names = trackedNames(project);
  const snippets = [];
  const sentences = original.split(/(?<=[.!?])\s+|\n+/);
  const cleaned = sentences.map((sentence) => {
    const hit = identifierHits(sentence, names);
    let next = sanitizeProse(sentence, project);
    const still = identifierHits(next, names);
    if (still) next = replaceTracked(next, names);
    if (hit || still) {
      const needle = hit || still;
      const at = sentence.toLowerCase().indexOf(String(needle).toLowerCase());
      const snippet = snippetAround(sentence, at < 0 ? 0 : at, String(needle).length);
      if (snippet && !snippets.includes(snippet)) snippets.push(snippet);
    }
    return next;
  });
  const joiner = original.includes('\n') ? '\n' : ' ';
  return { text: cleaned.join(joiner).replace(/[ ]{2,}/g, ' ').trim(), snippets };
}

module.exports = {
  MNEMONICS,
  escapeHtml,
  escapeRegExp,
  isMnemonic,
  isRawIdentifier,
  looksRawName,
  isTemplateHeading,
  humanize,
  headingFrom,
  decodeXmlEntities,
  decodeBuffer,
  estimateTokens,
  safeName,
  cssString,
  describeOperand,
  translateLogic,
  translateStructuredText,
  commentIsPlain,
  sanitizeProse,
  tagIndex,
  forbiddenNames,
  headingViolations,
  proseViolations,
  scrubField,
  snippetAround,
  trackedNames,
  identifierHits,
};
