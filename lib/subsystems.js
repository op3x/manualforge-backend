const { humanize, sanitizeProse, headingFrom } = require('./text');
const { hazardsForSubsystem } = require('./hazards');
const { containsRawSource } = require('./logic');
const { isStructural, motionFor, uniqueSentences, polishName } = require('./presentation');

const MOTION = /motor|servo|cylinder|actuator|valve|vacuum|belt|gearbox|drive|solenoid|axis|spindle|pump|heater/i;
const SENSOR = /sensor|switch|photo|prox|encoder|pressure|guard|interlock|e-?stop|light curtain|temp|humidity|level|flow|analog/i;
const FLOW = ['infeed', 'collation', 'pick', 'erector', 'magazine', 'glue', 'flap', 'discharge', 'outfeed', 'conveyor', 'robot', 'guard', 'cabinet'];

function tokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
}

function flowRank(name) {
  const text = name.toLowerCase();
  const index = FLOW.findIndex((word) => text.includes(word));
  return index === -1 ? 50 : index;
}

function routineTitle(routine) {
  const fromAnalysis = routine.analysis && routine.analysis.groups[0] && routine.analysis.groups[0].title;
  return headingFrom(routine.analysis && routine.analysis.title, fromAnalysis) || humanize(routine.name) || 'Machine function';
}

function deviceNames(project, keys, mode, loose = false) {
  const hits = [];
  const related = (blob) => loose || !keys.size || tokens(blob).some((token) => keys.has(token));
  for (const tag of project.tags || []) {
    const label = tag.description || humanize(tag.name);
    if (!label) continue;
    const blob = `${tag.description} ${tag.name} ${humanize(tag.name)}`;
    if (!related(blob)) continue;
    if (mode === 'sensor' && !SENSOR.test(blob)) continue;
    if (mode === 'component' && !MOTION.test(blob) && !/module|drive|valve|motor|cylinder|pump|heater/i.test(blob)) continue;
    hits.push(label);
  }
  for (const moduleNode of project.modules || []) {
    const label = moduleNode.catalog || moduleNode.description || humanize(moduleNode.name);
    if (!label) continue;
    const blob = `${moduleNode.catalog} ${moduleNode.name} ${moduleNode.description}`;
    if (!related(blob)) continue;
    if (mode === 'component') hits.push(label);
  }
  for (const aoi of project.aois || []) {
    const label = humanize(aoi.name || aoi) || '';
    if (!label) continue;
    if (!related(label)) continue;
    if (mode === 'component') hits.push(label);
  }
  return [...new Set(hits.filter(Boolean))].slice(0, 8);
}

const NAME_STOP = new Set(['the', 'and', 'for', 'with', 'from']);

function normalizeName(value) {
  return polishName(String(value || '').replace(/[-–—]+/g, ' ')).toLowerCase().replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function nameTokens(value) {
  return new Set(normalizeName(value).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !NAME_STOP.has(word)));
}

function markerSets(value) {
  const tokens = normalizeName(value).split(/[^a-z0-9]+/).filter(Boolean);
  return {
    sides: tokens.filter((token) => token === 'left' || token === 'right'),
    versions: tokens.filter((token) => /^v\d+$/.test(token)),
  };
}

function sameMarkers(left, right) {
  return left.length === right.length && left.every((token) => right.includes(token));
}

function markersConflict(left, right) {
  const a = markerSets(left);
  const b = markerSets(right);
  if (a.sides.length && b.sides.length && !sameMarkers(a.sides, b.sides)) return true;
  if ((a.versions.length || b.versions.length) && !sameMarkers(a.versions, b.versions)) return true;
  return false;
}

function namesClose(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (markersConflict(left, right)) return false;
  if (a.length > 5 && b.length > 5 && (a.includes(b) || b.includes(a))) return true;
  const leftTokens = nameTokens(a);
  const rightTokens = nameTokens(b);
  if (!leftTokens.size || !rightTokens.size) return false;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  return shared >= 2 && shared / smaller >= 0.6;
}

function purposeText(text, title) {
  const value = String(text || '').trim();
  if (!value || /^none\.?$/i.test(value)) return '';
  if (normalizeName(value) === normalizeName(title)) return '';
  return value;
}

function isMotorDriver(name) {
  return /tb6621|\bfng\b|motor driver/i.test(String(name || ''));
}

function componentPartTitle(name) {
  const text = String(name || '');
  if (isMotorDriver(text)) return false;
  return /^component\b/i.test(text) && /\d/.test(text);
}

function isDrawingLayerName(name) {
  const text = polishName(name) || String(name || '');
  return /^(visible|sketch\d*|defpoints|hidden|center|dimension|0)$/i.test(text.trim())
    || /^drawing layer\b/i.test(String(name || ''));
}

function isDoorName(name, extra = '') {
  return /\bdoor\b/i.test(`${name || ''} ${extra || ''}`);
}

function sideWord(text) {
  const value = String(text || '');
  const subject = value.match(/\b(left|right)\b(?:\s+\w+){0,4}\s+wheels?\b/i);
  if (subject) return subject[1];
  const lead = value.match(/^\s*(?:the\s+)?(left|right)\b/i);
  if (lead) return lead[1];
  return '';
}

function withSide(name, fn) {
  const side = sideWord(fn);
  const title = polishName(name) || String(name || '').trim();
  if (!title || !side || new RegExp(`\\b${side}\\b`, 'i').test(title)) return title;
  return polishName(`${side} ${title}`) || `${side} ${title}`;
}

function purposesDiffer(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a !== b;
}

function isGenericPurpose(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (/is part of the equipment|supports or guards the equipment|not a process station|none identified/i.test(value)) return true;
  const words = value.split(/\s+/);
  if (words.length <= 4 && !/\b(is|are|runs|carries|opens|closes|turns|moves|supports|provides|converts|holds|raises|drives)\b/i.test(value)) return true;
  return false;
}

function isFillerHardware(item) {
  const name = String((item && item.name) || '');
  const blob = `${name} ${(item && item.purpose) || ''}`;
  if (isMotorDriver(blob)) return false;
  return /nuts?\s+and\s+bolts|miscellaneous parts?|miscellaneous hardware/i.test(name)
    || /\bled\b/i.test(name)
    || /\bheader\b/i.test(name)
    || /\bpcb\b/i.test(name)
    || /printed circuit/i.test(name)
    || /beaglebone/i.test(name);
}

function isEmptySubsystem(item) {
  if (!item) return true;
  if (isMotorDriver(`${item.name} ${item.purpose}`)) return false;
  if ((item.groups || []).length) return false;
  if (cleanList(item.components).length) return false;
  if (cleanList(item.motions).length) return false;
  if (cleanList(item.sensors).length) return false;
  if (item.purpose && !isGenericPurpose(item.purpose)) return false;
  return true;
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/;\s*/).map((item) => item.trim()).filter(Boolean);
}

function cleanList(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item || '').trim().replace(/[.;\s]+$/g, '').trim();
    if (!text || /^none$/i.test(text) || /^none identified/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function modelRecord(model, project, source) {
  const structural = model.role === 'frame' || model.role === 'guarding' || model.role === 'structure';
  const title = withSide(polishName(model.name) || 'Subsystem', model.function);
  const extraComponents = source === 'tags' ? deviceNames(project, new Set(), 'component', true) : [];
  const extraSensors = source === 'tags' ? deviceNames(project, new Set(), 'sensor', true) : [];
  return {
    name: title,
    purpose: purposeText(model.function, title) || `${title} is part of the equipment.`,
    role: structural ? 'structure' : 'process',
    components: cleanList([...splitList(model.components), ...extraComponents]).slice(0, 8),
    motions: cleanList(splitList(model.motion)).slice(0, 3),
    sensors: cleanList([...splitList(model.sensors), ...extraSensors]).slice(0, 6),
    interlocks: cleanList([uniqueSentences(model.interlocks || '')]).slice(0, 4),
    operator: [],
    groups: [],
    sources: [source],
    inferred: true,
    hazardIds: [],
  };
}

function mergeModel(target, model) {
  const structural = model.role === 'frame' || model.role === 'guarding' || model.role === 'structure';
  const purpose = purposeText(model.function, model.name) || purposeText(model.function, target.name);
  if (purpose && target.purpose && !isGenericPurpose(target.purpose) && purposesDiffer(target.purpose, purpose)) return false;
  if (purpose) target.purpose = purpose;
  const sided = withSide(target.name, purpose || target.purpose);
  if (sided && !markersConflict(sided, target.name)) target.name = sided;
  target.motions = cleanList([...splitList(model.motion), ...target.motions]).slice(0, 3);
  target.sensors = cleanList([...splitList(model.sensors), ...target.sensors]).slice(0, 6);
  target.interlocks = cleanList([uniqueSentences(model.interlocks || ''), ...target.interlocks]).slice(0, 4);
  target.components = cleanList([...splitList(model.components), ...target.components]).slice(0, 8);
  if (structural && !isDoorName(target.name, purpose || '')) target.role = 'structure';
  return true;
}

function overlayModel(project, subsystems) {
  const models = (project.narrative && project.narrative.modelSubsystems) || [];
  const tagOnly = !(project.cad.assemblies || []).length && !(project.routines || []).some((routine) => (routine.units || []).length);
  if (tagOnly && models.length) {
    subsystems.length = 0;
    const seen = new Set();
    for (const model of models) {
      if (isDrawingLayerName(model.name) || componentPartTitle(model.name)) continue;
      const created = modelRecord(model, project, 'tags');
      const key = `${normalizeName(created.name)}|${normalizeName(created.purpose)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      subsystems.push(created);
      if (subsystems.length >= 6) break;
    }
    return;
  }
  const purposeOf = (model) => purposeText(model.function, model.name);
  for (const model of models) {
    if (isDrawingLayerName(model.name) || isDrawingLayerName(model.assembly || '')) continue;
    if (componentPartTitle(model.name) || componentPartTitle(model.assembly || '')) continue;
    const incomingPurpose = purposeOf(model);
    const sameFunction = (item) => !incomingPurpose || !item.purpose || isGenericPurpose(item.purpose) || !purposesDiffer(item.purpose, incomingPurpose);
    const structural = (model.role === 'frame' || model.role === 'guarding' || model.role === 'structure') && !isDoorName(model.name, `${model.assembly || ''} ${model.function || ''}`);
    let target = subsystems.find((item) => sameFunction(item) && !markersConflict(item.name, model.name) && namesClose(item.name, model.assembly || model.name));
    if (!target) target = subsystems.find((item) => sameFunction(item) && !markersConflict(item.name, model.name) && namesClose(item.name, model.name));
    if (!target && structural) target = subsystems.find((item) => item.role === 'structure' && !isDoorName(item.name) && sameFunction(item));
    if (!target) {
      if (subsystems.length >= 16) continue;
      const created = modelRecord(model, project, 'model');
      if (isDrawingLayerName(created.name) || componentPartTitle(created.name) || isEmptySubsystem(created)) continue;
      const key = `${normalizeName(created.name)}|${normalizeName(created.purpose)}`;
      if (subsystems.some((item) => `${normalizeName(item.name)}|${normalizeName(item.purpose)}` === key)) continue;
      subsystems.push(created);
      continue;
    }
    if (!mergeModel(target, model) && subsystems.length < 16) {
      const created = modelRecord(model, project, 'model');
      if (!isDrawingLayerName(created.name) && !isEmptySubsystem(created) && !componentPartTitle(created.name)) subsystems.push(created);
    }
  }
}

function buildSubsystems(project, hazards) {
  const assemblies = (project.cad.assemblies || []).filter((item) => item && item.name);
  const tree = assemblies.filter((item) => !item.leaf);
  const useCad = tree.length ? tree : assemblies;
  const routines = (project.routines || []).filter((routine) => (routine.analysis?.groups || []).length || (routine.units || []).length);
  const usedRoutines = new Set();
  const subsystems = [];

  const absorb = (name, description, source, extra = {}) => {
    if (isDrawingLayerName(name)) return;
    const analysis = extra.analysis || {};
    const title = withSide(
      polishName(name) || headingFrom(name, description) || humanize(name) || 'Subsystem',
      analysis.function || '',
    );
    const keys = new Set(tokens(`${name} ${description} ${title} ${extra.kind || ''}`));
    const matched = routines.filter((routine) => {
      if (usedRoutines.has(routine)) return false;
      const routineTokens = tokens(`${routineTitle(routine)} ${routine.comment || ''} ${(routine.analysis?.groups || []).map((group) => group.title).join(' ')}`);
      return routineTokens.some((token) => keys.has(token));
    });
    matched.forEach((routine) => usedRoutines.add(routine));
    const groups = matched.flatMap((routine) => (routine.analysis?.groups || []).map((group) => ({
      ...group,
      routineName: routine.name,
      sectionHint: title,
    })));
    const structural = extra.role === 'structure' || isStructural(extra.kind);
    const loose = (project.routines || []).length <= 3;
    const componentNames = [
      ...(analysis.components || []),
      ...deviceNames(project, keys, 'component', loose),
      ...(extra.partNames || []),
    ];
    const sensors = [
      analysis.sensors,
      ...deviceNames(project, keys, 'sensor', loose),
    ].flatMap((item) => (Array.isArray(item) ? item : String(item || '').split(/;\s*/))).filter(Boolean);
    const motions = [
      analysis.motion,
      motionFor(extra.kind),
      ...groups.map((group) => group.text).filter((text) => MOTION.test(text)),
    ].filter(Boolean);
    const interlocks = [...new Set([
      uniqueSentences(analysis.interlocks || ''),
      ...groups.map((group) => uniqueSentences(group.conditions || '')),
    ].filter(Boolean))].slice(0, 4);
    const described = purposeText(analysis.function, title) || purposeText(description, title);
    const groupPurpose = groups.map((group) => group.text).find((text) => text && !containsRawSource(text) && !/\bis set to\b/i.test(text));
    const purpose = sanitizeProse(described, project)
      || groupPurpose
      || (structural
        ? `${title} supports or guards the equipment. It is not a process station.`
        : `${title} is part of the equipment.`);
    const subsystem = {
      name: title,
      purpose,
      role: structural ? 'structure' : 'process',
      components: [...new Set(componentNames)].slice(0, 8),
      motions: [...new Set(motions)].slice(0, 3),
      sensors: [...new Set(sensors)].slice(0, 6),
      interlocks,
      operator: [],
      groups,
      sources: [source, matched.length ? 'plc' : ''].filter(Boolean),
      inferred: source !== 'library',
    };
    if (matched.length && description) subsystem.sources = [...new Set(['cad', 'plc', source].filter((item) => item === 'cad' || item === 'plc'))];
    subsystem.hazardIds = hazardsForSubsystem(hazards, subsystem).map((hazard) => hazard.id);
    subsystems.push(subsystem);
  };

  const structural = useCad.filter((item) => item.role === 'structure' || isStructural(item.kind));
  const processCad = useCad.filter((item) => !(item.role === 'structure' || isStructural(item.kind)));
  const chosen = [];
  const seenNames = new Set();
  for (const assembly of processCad) {
    if (isDrawingLayerName(assembly.name)) continue;
    const fn = normalizeName(assembly.analysis && assembly.analysis.function);
    const key = `${String(assembly.name || '').toLowerCase()}|${fn}`;
    if (!assembly.name || seenNames.has(key)) continue;
    seenNames.add(key);
    chosen.push(assembly);
    if (chosen.length >= 8) break;
  }
  for (const assembly of chosen) {
    if (componentPartTitle(assembly.name)) continue;
    absorb(assembly.name, assembly.analysis?.function || assembly.description, 'cad', {
      kind: assembly.kind,
      role: 'process',
      analysis: assembly.analysis,
    });
  }
  const doors = structural.filter((item) => isDoorName(item.name, `${item.description || ''} ${(item.analysis && item.analysis.function) || ''}`));
  const frameParts = structural.filter((item) => !doors.includes(item) && !isDrawingLayerName(item.name));
  for (const door of doors.slice(0, 4)) {
    absorb(door.name, (door.analysis && door.analysis.function) || door.description, 'cad', {
      kind: 'guard',
      role: 'structure',
      analysis: door.analysis,
    });
  }
  if (frameParts.length) {
    const frameAnalysis = frameParts.find((item) => item.analysis && !isDoorName(item.name, item.analysis.function || ''))?.analysis;
    absorb('Frame and guarding', 'The frame, panels, brackets, and fasteners support the equipment and separate people from moving parts.', 'cad', {
      kind: 'frame',
      role: 'structure',
      partNames: frameParts.map((item) => item.name).filter((name) => !componentPartTitle(name) && !isDoorName(name)).slice(0, 8),
      analysis: frameAnalysis,
    });
  }
  for (const routine of routines) {
    if (usedRoutines.has(routine)) continue;
    if (!(routine.analysis?.groups || []).length && !(routine.units || []).length) continue;
    if (subsystems.length >= 16) break;
    absorb(routineTitle(routine), routine.analysis?.purpose || routine.comment || '', 'plc');
    usedRoutines.add(routine);
  }
  if (!subsystems.length && (project.tags || []).length) {
    const buckets = new Map();
    for (const tag of project.tags) {
      const prefix = humanize(String(tag.name || '').split(/[_.]/)[0]) || 'Signals';
      if (!buckets.has(prefix)) buckets.set(prefix, []);
      buckets.get(prefix).push(tag);
    }
    const ranked = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
    for (const [name, tags] of ranked) {
      const sensors = tags.filter((tag) => SENSOR.test(`${tag.description} ${tag.name}`)).map((tag) => tag.description || humanize(tag.name)).filter(Boolean);
      const components = tags.filter((tag) => MOTION.test(`${tag.description} ${tag.name}`)).map((tag) => tag.description || humanize(tag.name)).filter(Boolean);
      absorb(name, tags.map((tag) => tag.description).filter(Boolean).slice(0, 3).join(' '), 'tags', {
        analysis: {
          function: tags.map((tag) => tag.description).filter(Boolean).slice(0, 2).join(' ') || `${name} is described by the tag list.`,
          sensors: sensors.join('; '),
          components,
          motion: components.length ? 'The tag list names this device. The upload has no routine logic, so the motion is taken from the tag descriptions.' : '',
        },
      });
    }
  }
  subsystems.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'structure' ? 1 : -1;
    return flowRank(a.name) - flowRank(b.name);
  });
  overlayModel(project, subsystems);
  const folded = foldHardware(subsystems.filter((item) => !isDrawingLayerName(item.name)));
  const kept = folded.filter((item) => !componentPartTitle(item.name) && !isEmptySubsystem(item));
  if (!kept.length) return [];
  return kept;
}

function foldHardware(list) {
  const fillers = list.filter(isFillerHardware);
  if (!fillers.length) return list;
  const rest = list.filter((item) => !isFillerHardware(item));
  rest.push({
    name: 'Electronics and hardware',
    purpose: 'The circuit boards, indicators, headers, and fasteners support the drives. They are not a moving station.',
    role: 'structure',
    components: [...new Set(fillers.flatMap((item) => [item.name, ...(item.components || [])]))].slice(0, 8),
    motions: [],
    sensors: [],
    interlocks: [],
    operator: [],
    groups: fillers.flatMap((item) => item.groups || []).slice(0, 4),
    sources: ['cad'],
    inferred: true,
    hazardIds: [],
  });
  return rest;
}

module.exports = {
  buildSubsystems, flowRank, namesClose, cleanList, markersConflict, componentPartTitle, purposeText,
  withSide, purposesDiffer, isMotorDriver, isDrawingLayerName, isDoorName,
};
