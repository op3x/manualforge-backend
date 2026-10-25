const { humanize } = require('./text');

const STRUCTURAL = new Set(['frame', 'guard', 'fastener']);

const MOTION = {
  conveyor: 'The conveyor runs to move material along the line.',
  cylinder: 'The cylinder extends and retracts.',
  valve: 'The valve opens and closes to pass or stop the flow.',
  motor: 'The motor turns when the drive is enabled.',
  gripper: 'The gripper closes on the part and releases it at the next position.',
  robot: 'The arm moves between its taught positions.',
  heater: 'The heater raises the temperature and holds it.',
  frame: 'This structure does not move. It supports the equipment.',
  guard: 'The guard stays closed while the equipment runs. It is not a process step.',
  fastener: 'Fasteners hold the assembly together. They are not a process step.',
};

function titleWord(word, index) {
  const text = String(word || '').replace(/^[,;:.-]+|[,;:.-]+$/g, '');
  if (!text) return '';
  if (index > 0 && /^(and|of|the|for|with|to|a|an)$/i.test(text)) return text.toLowerCase();
  if (/^[A-Z0-9]{2,}$/.test(text) && text.length <= 4) return text;
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function polishName(raw) {
  let text = String(raw || '').trim();
  if (!text || /^\$+$/.test(text)) return '';
  text = text.replace(/\.(stp|step|igs|iges|dxf)$/i, '');
  text = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  text = text.replace(/,?\s*export\s*\d+/ig, ' ');
  text = text.replace(/(\d)\.(\d)/g, '$1\u0000$2');
  text = text.replace(/[_/+]+/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\b(ASY|ASSY)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/\u0000/g, '.');
  text = text.replace(/^[,;:\s]+|[,;:\s]+$/g, '');
  const words = text.split(' ').filter(Boolean).map((word, index) => titleWord(word, index));
  const out = [];
  const seen = new Set();
  const keepRepeat = /^(?:in|mm|cm|od|id|x|\d+(?:\.\d+)?)$/i;
  for (const word of words) {
    const key = word.toLowerCase();
    if (!key || (seen.has(key) && !keepRepeat.test(key))) continue;
    seen.add(key);
    out.push(word);
  }
  return out.join(' ').trim();
}

function looksCoded(name) {
  const text = String(name || '').trim();
  if (!text || /^\$+$/.test(text)) return false;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (!letters) return true;
  const caps = (letters.match(/[A-Z]/g) || []).length;
  if (caps / letters.length > 0.75 && /\b(ASY|ASSY|COMPLETE|FRAME)\b/.test(text)) return true;
  if (/^[A-Z0-9][A-Z0-9 ._-]{6,}$/.test(text) && caps / letters.length > 0.8) return true;
  return false;
}

function descriptiveFromFilename(name) {
  let base = String(name || '').replace(/\.[^.]+$/, '');
  base = base.replace(/^(?:creator|freecadlib|nist|cadzinho|onlinerobotics|so-arm\d+|rockwell|brewery|swat|emulator)[_-]/i, '');
  base = base.replace(/[_-]+/g, ' ');
  base = base.replace(/\bCOMPLETE\b/gi, ' ');
  base = base.replace(/\b(ASY|ASSY)\b/gi, ' ');
  return polishName(base);
}

function isStructural(kind) {
  return STRUCTURAL.has(kind);
}

function motionFor(kind) {
  return MOTION[kind] || '';
}

function readablePartName(raw) {
  let text = String(raw || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/\b(sketch|pocket|fillet|extrude|chamfer|revolve)\d*\b/i.test(text) || /\bpad\d+\b/i.test(text)) return '';
  text = text.replace(/,?\s*solid body\b/ig, ' ');
  text = text.replace(/\bpart\s+[A-Z0-9][A-Z0-9._-]{2,}\b/ig, ' ');
  text = text.replace(/^component\b[,:\s-]*/i, '');
  text = text.replace(/\b(\d)\s+(\d{1,3})\s+in\b/gi, '$1.$2 in');
  text = text.replace(/\b(OD|ID)\s+(\d{3})\b/gi, (all, label, digits) => `${label} 0.${String(digits).replace(/0+$/, '') || digits}`);
  text = text.replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim();
  if (!text || /^component$/i.test(text)) return 'Machined part';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function classLabel(kind) {
  return {
    fastener: 'Fastener',
    frame: 'Frame member',
    guard: 'Guard or panel',
    conveyor: 'Conveyor part',
    cylinder: 'Pneumatic cylinder',
    valve: 'Valve',
    motor: 'Motor',
    gripper: 'Gripper part',
    robot: 'Robot part',
    heater: 'Heater',
  }[kind] || 'Component';
}

function sampleBlob(project) {
  const bits = [
    project.identity && project.identity.productName,
    ...(project.sources || []).map((source) => source.name),
    ...(project.routines || []).map((routine) => [
      routine.name,
      routine.analysis && routine.analysis.purpose,
      ...((routine.analysis && routine.analysis.groups) || []).slice(0, 2).map((group) => group.text),
      ...(routine.units || []).slice(0, 4).map((unit) => `${unit.comment || ''} ${unit.text || ''}`),
    ].join(' ')),
    ...(project.tags || []).slice(0, 40).map((tag) => tag.description),
    ...(project.cad && project.cad.assemblies || []).slice(0, 20).map((item) => `${item.name} ${item.kind}`),
  ];
  return bits.filter(Boolean).join(' ').toLowerCase();
}

function equipmentMoves(project) {
  const tags = (project.tags || []).slice(0, 500).map((tag) => `${tag.name || ''} ${tag.description || ''} ${tag.direction || ''}`).join(' ');
  const blob = `${sampleBlob(project)} ${tags}`.replace(/[_/]+/g, ' ').toLowerCase();
  if (/\b(vfds?|inverters?|powerflex|kinetix|servos?|motors?|conveyors?|axes|axis|turntables?|saws?|agitat\w*|feeder screws?|variable frequency)\b/.test(blob)) return true;
  return ((project.cad && project.cad.assemblies) || []).some((item) => /\b(conveyor|motor|roller|belt|pulley|agitator|robot|cylinder)\b/i.test(`${item.name} ${item.kind || ''}`));
}

function detectKind(project) {
  const blob = sampleBlob(project);
  if (equipmentMoves(project)) {
    if (/tank|valve|dose|reactor|brew|mash|steam|level switch|fill/.test(blob)) return 'process';
    return 'machine';
  }
  if (/wet bulb|psychrometric|enthalpy|dew point|\bcalculation\b/.test(blob)) return 'calculation';
  if (/tank|valve|dose|reactor|brew|mash|level switch|fill/.test(blob) && !/conveyor|robot|gripper/.test(blob)) return 'process';
  const assemblies = (project.cad && project.cad.assemblies) || [];
  if (assemblies.length && !(project.routines || []).some((routine) => (routine.units || []).length)) {
    const structural = assemblies.filter((item) => item.role === 'structure' || isStructural(item.kind) || !item.kind).length;
    if (structural >= assemblies.length * 0.6) return 'structure';
  }
  return 'machine';
}

function fallbackNarrative(project) {
  const kind = detectKind(project);
  const bits = (project.routines || [])
    .map((routine) => (routine.analysis && (routine.analysis.purpose || (routine.analysis.groups[0] && routine.analysis.groups[0].text))) || '')
    .map((text) => String(text || '').trim())
    .filter((text) => text.length > 24)
    .slice(0, 3);
  let overview = bits.join(' ');
  let cycle = '';
  if (kind === 'calculation') {
    const useful = bits
      .map((text) => text.replace(/https?:\/\/\S+|www\.\S+/gi, ' ').replace(/(?:[-_=*]\s*){3,}/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((text) => text.length > 40 && !/^the control (sets|checks|selects)/i.test(text) && !/supports the function described above/i.test(text));
    overview = 'This device calculates a result from its measured inputs. It does not move a product through a machine cycle.';
    if (useful[0]) overview = `${overview} ${useful[0]}`;
    cycle = 'Read the inputs, run the calculation, and write the result. There is no product path and no station-to-station handoff.';
  } else if (kind === 'process') {
    overview = overview || 'The control fills, holds, and discharges according to the measured conditions.';
    cycle = overview;
  } else if (kind === 'structure') {
    const count = project.cad && project.cad.bodyCount;
    overview = `This is a frame and guarding assembly${count ? ` with ${count} solid bodies` : ''}. The members support the equipment. They are not process stations and they do not move a product.`;
    cycle = 'There is no operating cycle in this model. The frame supports the equipment and the guards stay closed.';
  } else if (!overview) {
    const stages = ((project.cad && project.cad.assemblies) || [])
      .filter((item) => item.kind && !isStructural(item.kind))
      .map((item) => item.name)
      .slice(0, 6);
    overview = stages.length
      ? `The equipment moves material with these assemblies: ${stages.join(', ')}.`
      : 'The uploaded files describe the equipment in the sections that follow.';
    cycle = 'Start only after the pre-start checks pass. Each station finishes its motion before the product moves on. Stop with the normal stop, or with an emergency stop if someone is at risk.';
  } else {
    cycle = bits.slice(0, 2).join(' ');
  }
  return { kind, overview, cycle, productName: '' };
}

function formatRange(numbers, kind = 'rung') {
  const unique = [...new Set(numbers.map(Number))].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!unique.length) return '';
  const parts = [];
  let start = unique[0];
  let prev = unique[0];
  for (let i = 1; i <= unique.length; i += 1) {
    const value = unique[i];
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = value;
  }
  const labels = {
    statement: ['Statement', 'Statements'],
    network: ['Network', 'Networks'],
    step: ['Step', 'Steps'],
    transition: ['Step', 'Steps'],
  }[kind] || ['Rung', 'Rungs'];
  const body = parts.join(', ');
  return unique.length === 1 ? `${labels[0]} ${body}` : `${labels[1]} ${body}`;
}

function mergedRef(groups) {
  const numbers = [];
  let kind = 'rung';
  for (const group of groups || []) {
    if (group.kind) kind = group.kind;
    for (const number of group.numbers || []) numbers.push(number);
  }
  return formatRange(numbers, kind);
}

function cleanSentence(text) {
  let value = String(text || '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/(?:[-_=*]\s*){3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '';
  if (/set to \d|already scaled|\bPV\b|\bByp\b|\breset min\b/i.test(value)) return '';
  if (/^[^A-Za-z]*$/.test(value)) return '';
  const words = value.split(' ');
  const short = words.filter((word) => word.length <= 3).length;
  if (words.length >= 4 && short / words.length > 0.6 && !/[.]$/.test(value)) return '';
  return value;
}

function uniqueSentences(text) {
  const cleaned = cleanSentence(text);
  if (!cleaned) return '';
  const parts = cleaned.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const part of parts.length ? parts : [cleaned]) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(' ');
}

function cleanAlarm(alarm) {
  if (!alarm) return null;
  const code = String(alarm.code || '').replace(/[-_=*]{3,}/g, '').trim();
  const message = uniqueSentences(alarm.text || alarm.message || '');
  if (!code && !message) return null;
  if (message && message.length < 4 && !code) return null;
  if (/^(automated te|alarm|fault)$/i.test(message) && !code) return null;
  return {
    code,
    text: message,
    cause: uniqueSentences(alarm.cause || ''),
    remedy: uniqueSentences(alarm.remedy || ''),
    severity: alarm.severity || 'Fault',
  };
}

function alarmKey(code, message) {
  let raw = `${code} ${message}`.toLowerCase();
  raw = raw.replace(/\bhigh[_\s-]*high(?:[_\s-]*alarm)?\b/g, 'high-high');
  raw = raw.replace(/\bhh\b/g, 'high-high');
  raw = raw.replace(/\blow[_\s-]*low(?:[_\s-]*alarm)?\b/g, 'low-low');
  raw = raw.replace(/\bll\b/g, 'low-low');
  raw = raw.replace(/\bhigh[_\s-]*alarm\b/g, 'high');
  raw = raw.replace(/\blow[_\s-]*alarm\b/g, 'low');
  return raw.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function alarmsOverlap(left, right) {
  const a = alarmKey(left[0], left[1]);
  const b = alarmKey(right[0], right[1]);
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return short.length > 8 && long.includes(short);
}

function wrapWords(text, width = 16) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const pushWord = (word) => {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  };
  for (const word of words) {
    if (word.length <= width) pushWord(word);
    else {
      for (let i = 0; i < word.length; i += width) pushWord(word.slice(i, i + width));
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function displayProductName(project) {
  if (project.identity.productNameFromUser && project.identity.productName) return project.identity.productName;
  const fromAnalysis = project.narrative && project.narrative.productName;
  if (fromAnalysis && !looksCoded(fromAnalysis)) return polishName(fromAnalysis);
  const raw = project.identity.productName || '';
  if (!raw || looksCoded(raw) || /^\$+$/.test(String(raw).trim())) {
    const fromFile = descriptiveFromFilename((project.sources[0] && project.sources[0].name) || '');
    if (fromFile) return fromFile;
  }
  return polishName(raw) || humanize(raw) || 'Industrial equipment';
}

module.exports = {
  polishName,
  looksCoded,
  descriptiveFromFilename,
  isStructural,
  motionFor,
  classLabel,
  readablePartName,
  equipmentMoves,
  detectKind,
  fallbackNarrative,
  formatRange,
  mergedRef,
  cleanSentence,
  uniqueSentences,
  cleanAlarm,
  alarmsOverlap,
  wrapWords,
  displayProductName,
};
