const { humanize, sanitizeProse, headingFrom } = require('./text');
const { hazardsForSubsystem } = require('./hazards');
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

function namesClose(left, right) {
  const a = polishName(left).toLowerCase();
  const b = polishName(right).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length > 5 && b.length > 5 && (a.includes(b) || b.includes(a));
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/;\s*/).map((item) => item.trim()).filter(Boolean);
}

function overlayModel(project, subsystems) {
  const models = (project.narrative && project.narrative.modelSubsystems) || [];
  const tagOnly = !(project.cad.assemblies || []).length && !(project.routines || []).some((routine) => (routine.units || []).length);
  if (tagOnly && models.length) {
    subsystems.length = 0;
    for (const model of models.slice(0, 6)) {
      const structural = model.role === 'frame' || model.role === 'guarding' || model.role === 'structure';
      subsystems.push({
        name: polishName(model.name) || 'Signals',
        purpose: model.function || `${polishName(model.name)} is described by the tag list.`,
        role: structural ? 'structure' : 'process',
        components: [...splitList(model.components), ...deviceNames(project, new Set(), 'component', true)].slice(0, 8),
        motions: [model.motion].filter(Boolean).slice(0, 3),
        sensors: [...splitList(model.sensors), ...deviceNames(project, new Set(), 'sensor', true)].slice(0, 6),
        interlocks: [uniqueSentences(model.interlocks || '')].filter(Boolean).slice(0, 4),
        operator: [],
        groups: [],
        sources: ['tags'],
        inferred: true,
        hazardIds: [],
      });
    }
    return;
  }
  for (const model of models) {
    const structural = model.role === 'frame' || model.role === 'guarding' || model.role === 'structure';
    let target = subsystems.find((item) => namesClose(item.name, model.name));
    if (!target && structural) target = subsystems.find((item) => item.role === 'structure');
    if (!target) continue;
    if (model.function) target.purpose = model.function;
    if (model.motion) target.motions = [model.motion, ...target.motions].filter(Boolean).slice(0, 3);
    const sensors = splitList(model.sensors);
    if (sensors.length) target.sensors = [...sensors, ...target.sensors].slice(0, 6);
    if (model.interlocks) target.interlocks = [uniqueSentences(model.interlocks), ...target.interlocks].filter(Boolean).slice(0, 4);
    const components = splitList(model.components);
    if (components.length) target.components = [...components, ...target.components].slice(0, 8);
    if (structural) target.role = 'structure';
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
    const title = polishName(name) || headingFrom(name, description) || humanize(name) || 'Subsystem';
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
    const analysis = extra.analysis || {};
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
    const purpose = sanitizeProse(analysis.function || description, project)
      || (groups[0] && groups[0].text)
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
    const key = String(assembly.name || '').toLowerCase();
    if (!key || seenNames.has(key)) continue;
    seenNames.add(key);
    chosen.push(assembly);
    if (chosen.length >= 8) break;
  }
  for (const assembly of chosen) {
    absorb(assembly.name, assembly.analysis?.function || assembly.description, 'cad', {
      kind: assembly.kind,
      role: 'process',
      analysis: assembly.analysis,
    });
  }
  if (structural.length) {
    absorb('Frame and guarding', 'The frame, panels, brackets, and fasteners support the equipment and separate people from moving parts.', 'cad', {
      kind: 'frame',
      role: 'structure',
      partNames: structural.map((item) => item.name).slice(0, 8),
      analysis: structural.find((item) => item.analysis)?.analysis,
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
  if (!subsystems.length) return [];
  return subsystems;
}

module.exports = { buildSubsystems, flowRank };
