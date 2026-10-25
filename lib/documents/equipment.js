const { humanize } = require('../text');
const { readablePartName } = require('../presentation');

const CLASSES = [
  { id: 'motor', label: 'Motors and drives', re: /\b(motors?|servos?|vfd|inverter|conveyors?|axis|axes|axis drive|variable frequency)\b/i },
  { id: 'pneumatic', label: 'Pneumatics', re: /\b(pneumatic|compressed air|cylinders?|solenoids?|air valve|air supply)\b/i },
  { id: 'hydraulic', label: 'Hydraulics', re: /\b(hydraulic|accumulator)\b/i },
  { id: 'sensor', label: 'Sensors', re: /\b(sensors?|proximity|photo-?eyes?|photoelectric|encoders?|limit switch|prox(?:es|imity)?)\b/i },
  { id: 'safety', label: 'Safety devices', re: /\b(e-?stops?|emergency stop|light curtain|interlocks?|guards?|safety relay|safe torque)\b/i },
  { id: 'lubrication', label: 'Lubrication points', re: /\b(lubric\w*|bearings?|gearbox|gear box|grease fitting)\b/i },
  { id: 'filter', label: 'Filters', re: /\b((?:air|oil|return|hydraulic|suction|cabinet|fan)\s+filters?|strainers?|filter bowls?|filter elements?)\b/i },
  { id: 'gravity', label: 'Gravity and stored mechanical energy', re: /\b(lifts?|hoists?|elevators?|vertical|counterweights?|brakes?)\b/i },
];

const NAME_PREFIX = new Set(['prg', 'fb', 'fc', 'ob', 'db', 'main', 'routine', 'logic', 'program', 'seq']);
const SHORT_KEEP = new Set(['air', 'set', 'arm', 'fan', 'oil', 'lid', 'top', 'end', 'low', 'jam']);
const TYPE_WORDS = new Set(['dint', 'int', 'sint', 'lint', 'udint', 'uint', 'real', 'lreal', 'bool', 'boolean', 'ascii', 'math', 'str', 'string', 'bcd', 'word', 'dword', 'byte', 'timer', 'counter', 'float']);

// "Conv" in a name such as Dint_Conv is a conversion example, not a conveyor.
function misleadingConveyor(raw) {
  const tokens = String(raw || '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !/^\d+$/.test(token) && !/^r\d+$/.test(token));
  if (!tokens.includes('conv') || tokens.includes('conveyor')) return false;
  return tokens.filter((token) => token !== 'conv').every((token) => TYPE_WORDS.has(token) || token.length <= 2);
}

function deviceName(raw) {
  if (misleadingConveyor(raw)) return '';
  return plainDeviceName(raw);
}

function plainDeviceName(raw) {
  const human = humanize(raw);
  if (!human) return '';
  const words = human.split(' ').filter((word) => {
    const key = word.toLowerCase();
    if (!key || NAME_PREFIX.has(key)) return false;
    if (word.length <= 3 && !SHORT_KEEP.has(key)) return false;
    return true;
  });
  return words.join(' ').trim();
}

function deviceLabel(tag) {
  const described = String((tag && tag.description) || '').replace(/\s+/g, ' ').trim();
  if (described && described.length <= 80 && !/[{};]/.test(described) && !/\b(XIC|XIO|OTE)\b/.test(described) && !/system defined parameter/i.test(described)) {
    return described;
  }
  return plainDeviceName(tag && tag.name) || '';
}

const CONFIG_NOISE = /configure|set to \d|preset|coefficient|system defined|already scaled|for example|\blogic\b/i;

function matchingLabel(text, regex) {
  let clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean || /[{};=]|\b(XIC|XIO|OTE|JSR)\b|:=|[*#]{4,}/.test(clean)) return '';
  if (/\bfilters?\b/i.test(clean) && /coefficient|analog|\bai\b|signal|\bpv\b/i.test(clean)) return '';
  if (CONFIG_NOISE.test(clean)) {
    const hit = clean.match(regex);
    if (!hit || CONFIG_NOISE.test(hit[0])) return '';
    clean = hit[0].charAt(0).toUpperCase() + hit[0].slice(1);
  }
  if (clean.length < 3 || clean.length > 80) return '';
  if (/[.!?]/.test(clean) || clean.split(' ').length > 8) return '';
  if (/\b(when|while|until|because)\b/i.test(clean)) return '';
  if (regex && !regex.test(clean)) return '';
  return clean;
}

function remember(list, seen, text, regex) {
  const clean = matchingLabel(text, regex);
  if (!clean) return false;
  const key = clean.toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  list.push(clean);
  return true;
}

function labelsFor(project, regex) {
  const list = [];
  const seen = new Set();
  for (const tag of project.tags || []) {
    remember(list, seen, tag.description, regex) || remember(list, seen, deviceName(tag.name), regex);
  }
  for (const part of (project.cad && project.cad.bom) || []) {
    remember(list, seen, readablePartName(part.description || part.partNumber), regex);
  }
  for (const item of project.subsystems || []) {
    remember(list, seen, item.name, regex);
  }
  for (const routine of project.routines || []) {
    for (const member of routine.declarations || []) {
      remember(list, seen, member.comment, regex) || remember(list, seen, deviceName(member.name), regex);
    }
    remember(list, seen, deviceName(routine.name), regex);
    const groups = (routine.analysis && routine.analysis.groups) || [];
    for (const group of groups) remember(list, seen, group.title, regex);
    let comments = 0;
    for (const unit of routine.units || []) {
      if (!unit || !unit.comment || comments >= 40) continue;
      comments += 1;
      remember(list, seen, unit.comment, regex);
    }
  }
  return list.slice(0, 8);
}

function named(labels, fallback) {
  if (!labels.length) return fallback;
  if (labels.length === 1) return labels[0];
  return labels.slice(0, 4).join(', ');
}

function inspectEquipment(project) {
  const classes = {};
  for (const spec of CLASSES) {
    const labels = labelsFor(project, spec.re);
    classes[spec.id] = { id: spec.id, label: spec.label, present: labels.length > 0, labels };
  }
  const present = CLASSES.filter((spec) => classes[spec.id].present).map((spec) => spec.id);
  const powered = present.includes('motor') || (project.routines || []).length > 0 || (project.modules || []).length > 0 || (project.tags || []).length > 0;
  return { classes, present, powered, any: present.length > 0 || powered };
}

function controlPoints(project) {
  const pick = (regex, reject) => labelsFor(project, regex).filter((label) => !reject || !reject.test(label));
  return {
    stops: pick(/\bstop\b/i, /e-?stop|emergency/i),
    estops: pick(/\be-?stop\b|\bemergency stop\b/i),
    resets: pick(/\breset\b/i),
    starts: pick(/\bstart\b/i, /\bstartup\b/i),
    homes: pick(/\b(home|homing|park position|reference position)\b/i),
    guards: pick(/\b(guard|interlock|light curtain)\b/i),
  };
}

module.exports = { CLASSES, inspectEquipment, controlPoints, named, deviceLabel };
