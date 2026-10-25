const { humanize } = require('../text');
const { readablePartName } = require('../presentation');

const CLASSES = [
  { id: 'motor', label: 'Motors and drives', re: /\b(motors?|servos?|steppers?|rotors?|vfd|inverter|conveyors?|variable frequency|nema\s*\d+)\b/i },
  { id: 'pneumatic', label: 'Pneumatics', re: /\b(pneumatic|compressed air|cylinders?|solenoids?|air valve|air supply|valve actuator)\b/i },
  { id: 'hydraulic', label: 'Hydraulics', re: /\b(hydraulic|accumulator)\b/i },
  { id: 'thermal', label: 'Steam and heat', re: /\b(steam|heaters?|heating|hot water|heat exchanger|steam trap|thermocouple|temperature probe|\btemperature\b)\b/i },
  { id: 'process', label: 'Process fluid and pumps', re: /\b((?<!hydraulic\s)pumps?|process fluid|mash water|water to|water valve|discharge valve)\b/i },
  { id: 'agitator', label: 'Agitator', re: /\bagitat/i },
  { id: 'vacuum', label: 'Vacuum', re: /\bvacuum\b/i },
  { id: 'chemical', label: 'Process chemicals', re: /\b(caustic|sanitizer|\bcip\b|peracetic|solvent|chemical)\b/i },
  { id: 'sensor', label: 'Sensors', re: /\b(sensors?|proximity|photo-?eyes?|photoelectric|encoders?|limit switch|prox(?:es|imity)?)\b/i },
  { id: 'safety', label: 'Safety devices', re: /\b(e-?stops?|emergency stop|light curtain|interlocks?|guards?|safety relay|safe torque|gate switch)\b/i },
  { id: 'lubrication', label: 'Lubrication points', re: /\b(lubric\w*|bearings?|gearbox|gear box|grease fitting)\b/i },
  { id: 'filter', label: 'Filters', re: /\b((?:air|oil|return|hydraulic|suction|cabinet|fan)\s+filters?|strainers?|filter bowls?|filter elements?)\b/i },
  { id: 'gravity', label: 'Gravity and stored mechanical energy', re: /\b(lifts?|hoists?|elevators?|vertical|counterweights?|brakes?)\b/i },
];

const NAME_PREFIX = new Set(['prg', 'fb', 'fc', 'ob', 'db', 'main', 'routine', 'logic', 'program', 'seq']);
const SHORT_KEEP = new Set(['air', 'set', 'arm', 'fan', 'oil', 'lid', 'top', 'end', 'low', 'jam']);
const TYPE_WORDS = new Set(['dint', 'int', 'sint', 'lint', 'udint', 'uint', 'real', 'lreal', 'bool', 'boolean', 'ascii', 'math', 'str', 'string', 'bcd', 'word', 'dword', 'byte', 'timer', 'counter', 'float']);
const GENERIC_DEVICE = new Set(['motor', 'vfd', 'valve', 'sensor', 'interlock', 'stop', 'start', 'reset', 'drive', 'alarm', 'fault', 'pump', 'photoeyes', 'heater']);
const CONFIG_NOISE = /configure|set to \d|preset|coefficient|system defined|already scaled|for example|placeholder|\blogic\b/i;
const NOT_A_DEVICE = /\b(alarm|setpoint|debounce|permissive|inhibit|bypass|acknowledge|placeholder|for example|run command|status word|running|enabled|complete|abort\w*|delays?|timers?|request(?:ing|ed)?|active|paused|modes?|steps?|starting|needed|scenario|closed|opened|\bopen\b|sped|slow speed|high speed|low speed|pushbutton available|has\s+reset|is\s+reset|was\s+reset|meters?)\b/i;
const FUNCTION_TAIL = /\bcontrol$/i;
const STEP_LEAD = /^(close|open|start|stop|press|leave|request|enable|disable|step)\b/i;
const DEVICE_NOUN = /\b(button|pushbutton|switch|valve|sensor|motor|pump|probe|circuit|brake|filter|heater|trap|cylinder|actuator)\b/i;

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

function aoiNames(project) {
  return new Set((project.aois || []).map((item) => String(item.name || '').toLowerCase()).filter(Boolean));
}

function usableTags(project) {
  const skip = aoiNames(project);
  return (project.tags || []).filter((tag) => !skip.has(String(tag.scope || '').toLowerCase()));
}

function stripRole(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+-\s+(normal|slow|auto)[\s-]*speed\b.*/i, '')
    .replace(/\b(run command|enable command|start command|homing request)\b/ig, '')
    .replace(/\b(healthy|enable)\b/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
    .trim();
}

function looksLikeTag(text) {
  const value = String(text || '').trim();
  if (!value || /\s/.test(value)) return false;
  return /[_./]/.test(value) || /^[A-Z]{2,}\d/.test(value) || /\d{3,}/.test(value);
}

function dedupedPhrase(text) {
  const words = String(text || '').split(' ').filter(Boolean);
  if (words.length >= 2 && words.length % 2 === 0) {
    const half = words.length / 2;
    const left = words.slice(0, half).join(' ');
    const right = words.slice(half).join(' ');
    if (left.toLowerCase() === right.toLowerCase()) return left;
  }
  return words.join(' ');
}

function sentenceDevice(raw) {
  let text = dedupedPhrase(stripRole(raw));
  text = text.replace(/\d+\s*°[^ ]*/g, '');
  text = text.replace(/#\s*\d+/g, '');
  text = text.replace(/\b\d+\s*-\s*\d+\b/g, '');
  text = text.replace(/["″]/g, '');
  text = text.replace(/\bPBs\b/g, 'pushbuttons').replace(/\bPB\b/g, 'pushbutton');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || looksLikeTag(text)) return '';
  if (text.length > 80 || text.split(' ').length > 8) return '';
  if (text === text.toUpperCase()) {
    text = text.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  }
  return text.replace(/\s+/g, ' ').trim();
}

function gluedFunction(text) {
  if (!/\bcontrol\b/i.test(text)) return false;
  let families = 0;
  if (/\b(conveyor|motor|pump|valve|cylinder|clamp\w*|brake|agitator)\b/i.test(text)) families += 1;
  if (/\b(guard|interlock|e-?stop|emergency)\b/i.test(text)) families += 1;
  if (/\b(sensor|photo-?eye|prox)\b/i.test(text)) families += 1;
  if (/\b(part|sequence|function|step)\b/i.test(text)) families += 1;
  return families >= 2;
}

function rejectedName(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return true;
  if (NOT_A_DEVICE.test(clean) || FUNCTION_TAIL.test(clean) || gluedFunction(clean)) return true;
  if (STEP_LEAD.test(clean) && !DEVICE_NOUN.test(clean)) return true;
  return false;
}

function identityNames(project) {
  const names = new Set();
  const add = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (text) names.add(text);
  };
  add(project.identity && project.identity.productName);
  add(project.controller);
  for (const program of project.programs || []) add(program);
  for (const source of project.sources || []) add(String(source.name || '').replace(/\.[^.]+$/, ''));
  for (const routine of project.routines || []) {
    add(routine.name);
    add(routine.analysis && routine.analysis.title);
    for (const group of (routine.analysis && routine.analysis.groups) || []) add(group.title);
  }
  for (const item of project.subsystems || []) add(item.name);
  return names;
}

function matchingLabel(text, regex) {
  let clean = sentenceDevice(text);
  if (!clean || /[{};=]|\b(XIC|XIO|OTE|JSR)\b|:=|[*#]{4,}/.test(clean)) return '';
  if (/\b(for example|e\.g\.|placeholder)\b/i.test(String(text || ''))) return '';
  if (/\bfilters?\b/i.test(clean) && /coefficient|analog|\bai\b|signal|\bpv\b/i.test(clean)) return '';
  if (CONFIG_NOISE.test(clean) || rejectedName(clean)) return '';
  if (GENERIC_DEVICE.has(clean.toLowerCase())) return '';
  if (clean.length < 3 || clean.length > 80) return '';
  if (/[.!?]/.test(clean) || clean.split(' ').length > 8) return '';
  if (/\b(when|while|until|because)\b/i.test(clean)) return '';
  if (regex && !regex.test(clean)) return '';
  return clean;
}

function remember(list, seen, text, regex, project) {
  const clean = matchingLabel(text, regex);
  if (!clean) return false;
  if (project && identityNames(project).has(clean.toLowerCase())) return false;
  const key = clean.toLowerCase();
  if (seen.has(key)) return false;
  seen.add(key);
  list.push(clean);
  return true;
}

function labelsFor(project, regex) {
  const list = [];
  const seen = new Set();
  for (const tag of usableTags(project)) {
    remember(list, seen, tag.description, regex, project);
    for (const note of tag.notes || []) remember(list, seen, note, regex, project);
    remember(list, seen, deviceName(tag.name), regex, project);
  }
  for (const part of (project.cad && project.cad.bom) || []) {
    remember(list, seen, readablePartName(part.description || part.partNumber), regex, project);
  }
  for (const item of project.subsystems || []) {
    remember(list, seen, item.name, regex, project);
  }
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    for (const member of routine.declarations || []) {
      remember(list, seen, member.comment, regex, project) || remember(list, seen, deviceName(member.name), regex, project);
    }
    remember(list, seen, deviceName(routine.name), regex, project);
    const groups = (routine.analysis && routine.analysis.groups) || [];
    for (const group of groups) remember(list, seen, group.title, regex, project);
    let comments = 0;
    for (const unit of routine.units || []) {
      if (!unit || !unit.comment || unit.unread || comments >= 40) continue;
      comments += 1;
      remember(list, seen, unit.comment, regex, project);
    }
  }
  return list.slice(0, 8);
}

function named(labels, fallback) {
  if (!labels.length) return fallback;
  if (labels.length === 1) return labels[0];
  return labels.slice(0, 3).join(', ');
}

function evidenceBlob(project) {
  const parts = [];
  for (const tag of usableTags(project)) {
    parts.push(tag.name, tag.description, tag.dataType, ...(tag.notes || []));
  }
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    parts.push(routine.name, routine.comment);
    for (const member of routine.declarations || []) parts.push(member.name, member.comment);
    for (const unit of routine.units || []) {
      if (unit && unit.comment && !unit.unread) parts.push(unit.comment);
    }
  }
  for (const part of (project.cad && project.cad.bom) || []) parts.push(part.description, part.partNumber);
  return parts.filter(Boolean).join('\n');
}

function classPresent(spec, blob, labels) {
  if (spec.id === 'motor' || spec.id === 'sensor' || spec.id === 'chemical') {
    return labels.some((label) => spec.re.test(label) && !NOT_A_DEVICE.test(label));
  }
  if (labels.length) return true;
  if (spec.id === 'thermal') {
    return /\b(steam|heaters?|heating|hot water|heat exchanger|steam trap|thermocouple|temperature probe)\b/i.test(blob)
      || (/\btemperature\b/i.test(blob) && !/\bdrive temp/i.test(blob));
  }
  if (spec.id === 'pneumatic') {
    if (!spec.re.test(blob)) return false;
    if (/\bvalve actuator\b/i.test(blob) && /\b(steam|hydraulic|mash water|process fluid)\b/i.test(blob) && !/\b(pneumatic|compressed air|solenoid|air supply|air valve)\b/i.test(blob)) {
      return false;
    }
    return true;
  }
  return spec.re.test(blob);
}

function pushUnique(list, text) {
  const clean = sentenceDevice(text);
  if (!clean || GENERIC_DEVICE.has(clean.toLowerCase()) || NOT_A_DEVICE.test(clean)) return;
  if (list.some((item) => item.toLowerCase() === clean.toLowerCase())) return;
  list.push(clean);
}

function pumpLabel(description) {
  const match = String(description || '').match(/([A-Za-z]+(?:\s+[A-Za-z]+){0,3})\s+pumps?\b/i);
  if (!match) return 'Process pump';
  const words = match[1].split(/\s+/).filter((word) => word && !/^(run|reset|the|a|to|for|and|active|addition|open|valve)$/i.test(word));
  return sentenceDevice(`${words.slice(-3).join(' ')} pump`) || 'Process pump';
}

function explicitLabels(project) {
  const thermal = [];
  const process = [];
  const agitator = [];
  const vacuum = [];
  const chemical = [];
  let steamValve = false;
  for (const tag of usableTags(project)) {
    const notes = (tag.notes || []).join(' ');
    const described = `${tag.description || ''} ${notes}`.replace(/\s+/g, ' ').trim();
    const blob = `${tag.name} ${described}`;
    if (/\bagitat/i.test(blob)) pushUnique(agitator, described.replace(/\s+-\s+.*$/, ''));
    if (/\bpumps?\b/i.test(described) && !/\bhydraulic\b/i.test(blob)) pushUnique(process, pumpLabel(described));
    if (/^PMP[_-]/i.test(tag.name) && !/\bhydraulic\b/i.test(blob)) pushUnique(process, described && /\bpumps?\b/i.test(described) ? pumpLabel(described) : 'Process pump');
    if (/\bwater\b/i.test(described) && /\b(valve|water to|onv)\b/i.test(blob) && !/\b(pump|running|enabled)\b/i.test(described)) {
      pushUnique(process, described);
    }
    if (/\btemperature\b/i.test(described) && !/\bdrive temp/i.test(described) && !/\blevel\b/i.test(described) && described.length <= 80) {
      const where = sentenceDevice(described).replace(/\btemperature\b[\s\S]*$/i, '').trim();
      pushUnique(thermal, where ? `${where} temperature probe` : 'Temperature probe');
    }
    if (/^TCV[_-]/i.test(tag.name) || /steam supply/i.test(described)) steamValve = true;
    if (/\bvacuum\b/i.test(blob)) pushUnique(vacuum, described || 'Vacuum');
    if (/\b(caustic|sanitizer|\bcip\b|solvent|chemical)\b/i.test(blob)) pushUnique(chemical, described || 'Process chemical');
  }
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    for (const unit of routine.units || []) {
      const comment = unit && unit.comment;
      if (!comment || unit.unread) continue;
      if (/steam supply/i.test(comment)) steamValve = true;
      if (/\bagitat/i.test(comment)) pushUnique(agitator, 'Agitator');
    }
  }
  if (steamValve) pushUnique(thermal, 'Steam supply valve');
  return { thermal, process, agitator, vacuum, chemical };
}

function inspectEquipment(project) {
  const blob = evidenceBlob(project);
  const extra = explicitLabels(project);
  const classes = {};
  for (const spec of CLASSES) {
    const labels = labelsFor(project, spec.re);
    for (const label of extra[spec.id] || []) {
      if (!labels.some((item) => item.toLowerCase() === label.toLowerCase())) labels.push(label);
    }
    let kept = labels.filter((label) => !identityNames(project).has(label.toLowerCase()));
    if (spec.id === 'thermal') {
      kept = kept.filter((label) => /probe|steam supply|heater|steam trap|hot water/i.test(label));
    }
    if (spec.id === 'process') {
      kept = kept.filter((label) => !/\btemperature\b/i.test(label) && !/\bhydraulic\b/i.test(label) && !NOT_A_DEVICE.test(label) && !/\b(run|reset|addition)\b/i.test(label));
      kept = kept.filter((label, index, all) => !all.some((other, otherIndex) => {
        if (otherIndex === index || other.length < label.length) return false;
        const short = label.toLowerCase().replace(/s$/, '');
        const long = other.toLowerCase().replace(/s$/, '');
        return short === long || other.toLowerCase().startsWith(`${label.toLowerCase()} `);
      }));
    }
    if (spec.id === 'agitator') {
      kept = kept.filter((label) => !NOT_A_DEVICE.test(label));
      if (!kept.length && spec.re.test(blob)) kept = ['Agitator'];
    }
    kept = kept.slice(0, 8);
    classes[spec.id] = {
      id: spec.id,
      label: spec.label,
      present: classPresent(spec, blob, kept),
      labels: kept,
    };
  }
  if (classes.pneumatic.present && classes.thermal.present && !/\b(pneumatic|compressed air|solenoid|air supply|air valve)\b/i.test(blob)) {
    classes.pneumatic.present = classes.pneumatic.labels.some((label) => /\b(pneumatic|compressed air|cylinder|solenoid|air)\b/i.test(label));
  }
  const present = CLASSES.filter((spec) => classes[spec.id].present).map((spec) => spec.id);
  const powered = present.includes('motor') || present.includes('agitator') || (project.routines || []).some((routine) => !routine.aoi && (routine.units || []).length) || (project.modules || []).length > 0 || usableTags(project).length > 0;
  return { classes, present, powered, any: present.length > 0 || powered };
}

function bestControl(labels) {
  const ranked = [];
  const seen = new Set();
  for (const label of labels) {
    const text = String(label || '').replace(/\s+/g, ' ').trim();
    if (!text || GENERIC_DEVICE.has(text.toLowerCase()) || rejectedName(text)) continue;
    if (/\b(alarm|permissive|inhibit|setpoint|bypass|acknowledge)\b/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let score = text.split(' ').length > 1 ? 1 : 0;
    if (/\b(button|pushbutton|switch|circuit|device)\b/i.test(text)) score += 5;
    if (/\bemergency stop\b/i.test(text)) score += 3;
    ranked.push({ text, score });
  }
  ranked.sort((left, right) => right.score - left.score || left.text.length - right.text.length);
  return ranked.length ? [ranked[0].text] : [];
}

function mentions(project, regex) {
  for (const tag of usableTags(project)) {
    if (regex.test(`${tag.name} ${tag.description || ''} ${(tag.notes || []).join(' ')}`)) return true;
  }
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    for (const member of routine.declarations || []) {
      if (regex.test(`${member.name} ${member.comment || ''}`)) return true;
    }
  }
  return false;
}

function controlPoints(project) {
  const pick = (regex, reject) => bestControl(labelsFor(project, regex).filter((label) => !reject || !reject.test(label)));
  const homes = pick(/\b(home|homing|park position|reference position)\b/i);
  return {
    stops: pick(/\bstop\b/i, /e-?stop|emergency|alarm/i),
    estops: pick(/\be-?stop\b|\bemergency stop\b/i),
    resets: pick(/\breset\b/i, /alarm|bypass|setpoint|meter|has\s+reset/i),
    starts: pick(/\bstart\b/i, /\bstartup\b|permissive|inhibit|alarm/i),
    homes: homes.length ? homes : (mentions(project, /\b(home|homing)\b/i) ? ['Homing'] : []),
    guards: pick(/\b(guard|interlock|light curtain|gate switch)\b/i, /knife gate|valve/i),
  };
}

function homingReleasesBrake(project) {
  for (const routine of project.routines || []) {
    for (const unit of routine.units || []) {
      const text = `${unit.text || ''}\n${unit.comment || ''}`;
      if (/home/i.test(text) && /brake\w*\s*:=\s*(?:FALSE|0|OFF)\b/i.test(text)) return true;
    }
  }
  return false;
}

function programFacts(project) {
  let steamOpen = false;
  let steamClose = false;
  let steamVent = false;
  let agitatorRunning = false;
  for (const tag of usableTags(project)) {
    const blob = `${tag.name} ${tag.description || ''}`;
    if (/vent/i.test(blob) && /steam|heat|cool|drain/i.test(blob)) steamVent = true;
  }
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    for (const unit of routine.units || []) {
      const text = `${unit.comment || ''}\n${unit.text || ''}`;
      if (/open steam supply/i.test(text)) steamOpen = true;
      if (/close steam supply/i.test(text) || (/steam/i.test(unit.comment || '') && /\.CLOSED\b/i.test(unit.text || ''))) steamClose = true;
      if (/vent/i.test(text) && /steam|heat|cool/i.test(text)) steamVent = true;
      if (/\bagitat/i.test(text) && /running/i.test(text)) agitatorRunning = true;
      if (/\bAGI[_A-Za-z0-9]*\.Running\b/.test(unit.text || '')) agitatorRunning = true;
    }
  }
  return { steamOpen, steamClose, steamVent, agitatorRunning };
}

function energyTable(project) {
  const equipment = inspectEquipment(project);
  const facts = programFacts(project);
  const rows = [[
    'Electrical',
    'Main disconnect for this equipment',
    'Wait until drives and power supplies have discharged, then test for absence of voltage.',
    'The start control does nothing, and a voltage test shows the circuit is de-energized.',
  ]];
  if (equipment.classes.pneumatic.present) {
    rows.push([
      'Pneumatic',
      'Lockable air shutoff and exhaust',
      'Exhaust residual air. Support a load that a cylinder is holding before you open a fitting.',
      'The supply gauge reads zero. A cylinder moves only when the procedure says it is safe to move it by hand.',
    ]);
  }
  if (equipment.classes.hydraulic.present) {
    rows.push([
      'Hydraulic',
      'Pump isolation and accumulator dump',
      'Stop the pump, isolate the supply, and dump stored pressure, including an accumulator.',
      'Gauges read zero and lines are not holding a load.',
    ]);
  }
  if (equipment.classes.thermal.present) {
    rows.push([
      'Steam or heat',
      'Lockable steam supply valve',
      'Close and lock the steam supply valve. Confirm the valve is closed. Vent residual pressure. Wait until the vessel, jackets, and piping have cooled. Treat those surfaces as hot until they have cooled.',
      facts.steamClose
        ? 'The steam supply valve is closed and locked, residual pressure is vented, and surfaces have cooled.'
        : 'The steam supply is isolated, residual pressure is vented, and surfaces have cooled.',
    ]);
  }
  if (equipment.classes.process.present) {
    const hot = equipment.classes.thermal.present || equipment.classes.process.labels.some((label) => /\b(water|steam|hot)\b/i.test(label));
    rows.push([
      'Process fluid',
      'Pump isolation and supply valves',
      hot
        ? 'Stop the pump. Close and lock the supply valves. Drain hot fluid before you open a line.'
        : 'Stop the pump. Close and lock the supply valves before you open a line.',
      'The pump does not start, the valves are closed, and the line is drained or blocked.',
    ]);
  }
  if (equipment.classes.vacuum.present) {
    rows.push([
      'Vacuum',
      'Vacuum shutoff and vent',
      'Close the vacuum supply and vent the line to atmosphere before you open a cup or a fitting.',
      'The vacuum gauge reads the same as the room, and a cup does not hold a part.',
    ]);
  }
  if (equipment.classes.chemical.present) {
    rows.push([
      'Process chemical',
      'Chemical supply valve and drain',
      'Close and lock the chemical supply. Drain and flush the line into the site collection point before you open a fitting.',
      'The supply valve is closed and locked, and the line is drained.',
    ]);
  }
  if (equipment.classes.agitator.present) {
    rows.push([
      'Rotating agitator',
      'Agitator drive disconnect',
      facts.agitatorRunning
        ? 'Stop the agitator and confirm it is no longer turning before you isolate energy or open the vessel. The cook sequence advances transfer steps only while the agitator is running.'
        : 'Stop the agitator and confirm it is no longer turning before you isolate energy or open the vessel.',
      'The agitator is still, and its drive does not respond to a start.',
    ]);
  }
  if (equipment.classes.gravity.present) {
    rows.push([
      'Gravity or stored mechanical energy',
      'Mechanical block, prop, or brake',
      'Lower the load or block it before you release a brake or open a coupling.',
      'The load cannot move while the block is in place.',
    ]);
  }
  const valveLabels = [
    ...equipment.classes.pneumatic.labels,
    ...equipment.classes.process.labels,
    ...equipment.classes.hydraulic.labels,
  ];
  const knownContents = equipment.classes.thermal.present
    || equipment.classes.chemical.present
    || equipment.classes.process.present
    || equipment.classes.hydraulic.present;
  if (valveLabels.some((label) => /\bvalve\b/i.test(label)) && !knownContents) {
    rows.push([
      'Controlled line',
      'Isolation valve for the controlled line',
      'Isolate the line and release what it holds. Contents to be confirmed.',
      'The line is isolated. Contents to be confirmed.',
    ]);
  }
  return rows;
}

module.exports = {
  CLASSES,
  inspectEquipment,
  controlPoints,
  named,
  deviceLabel,
  energyTable,
  homingReleasesBrake,
  programFacts,
};
