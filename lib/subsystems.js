const { humanize, sanitizeProse, headingFrom } = require('./text');
const { hazardsForSubsystem } = require('./hazards');

const MOTION = /motor|servo|cylinder|actuator|valve|vacuum|belt|gearbox|drive|solenoid|axis|spindle/i;
const SENSOR = /sensor|switch|photo|prox|encoder|pressure|guard|interlock|e-?stop|light curtain/i;
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

function buildSubsystems(project, hazards) {
  const useCad = (project.cad.assemblies || []).filter((item) => item && item.name);
  const routines = (project.routines || []).filter((routine) => (routine.analysis?.groups || []).length || (routine.units || []).length);
  const usedRoutines = new Set();
  const subsystems = [];

  const absorb = (name, description, source) => {
    const title = headingFrom(name, description) || humanize(name) || 'Subsystem';
    const keys = new Set(tokens(`${name} ${description} ${title}`));
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
    const componentNames = [];
    for (const part of project.cad.bom || []) {
      if (tokens(part.description).some((token) => keys.has(token)) && MOTION.test(part.description)) componentNames.push(part.description);
    }
    for (const tag of project.tags) {
      if (!tokens(`${tag.description} ${tag.name}`).some((token) => keys.has(token))) continue;
      if (SENSOR.test(`${tag.description} ${tag.name}`) && tag.description) componentNames.push(tag.description);
    }
    const motions = groups.map((group) => group.text).filter((text) => MOTION.test(text)).slice(0, 4);
    const sensors = (project.tags || [])
      .filter((tag) => SENSOR.test(`${tag.description} ${tag.name}`) && tokens(`${tag.description} ${humanize(tag.name)}`).some((token) => keys.has(token)))
      .map((tag) => tag.description || humanize(tag.name))
      .filter(Boolean)
      .slice(0, 6);
    const interlocks = [...new Set(groups.map((group) => group.conditions).filter(Boolean))].slice(0, 4);
    const purpose = sanitizeProse(description, project)
      || (groups[0] && groups[0].text)
      || `${title} is part of the equipment. Its exact cycle was inferred from the uploaded files.`;
    const subsystem = {
      name: title,
      purpose,
      components: [...new Set(componentNames)].slice(0, 8),
      motions: motions.slice(0, 4),
      sensors,
      interlocks,
      operator: [],
      groups,
      sources: [source, matched.length ? 'plc' : ''].filter(Boolean),
      inferred: true,
    };
    if (matched.length && description) subsystem.sources = [...new Set(['cad', 'plc', source].filter((item) => item === 'cad' || item === 'plc'))];
    subsystem.hazardIds = hazardsForSubsystem(hazards, subsystem).map((hazard) => hazard.id);
    subsystems.push(subsystem);
  };

  const rankedCad = [...useCad].sort((a, b) => {
    const score = (item) => (item.kind && item.kind !== 'fastener' ? 0 : item.kind === 'fastener' ? 2 : 1);
    return score(a) - score(b);
  });
  const chosen = [];
  const seenNames = new Set();
  for (const assembly of rankedCad) {
    const key = String(assembly.name || '').toLowerCase();
    if (!key || seenNames.has(key)) continue;
    seenNames.add(key);
    chosen.push(assembly);
    if (chosen.length >= 12) break;
  }
  if (chosen.length) {
    for (const assembly of chosen) absorb(assembly.name, assembly.description, 'cad');
  }
  for (const routine of routines) {
    if (usedRoutines.has(routine)) continue;
    if (!(routine.analysis?.groups || []).length && !(routine.units || []).length) continue;
    if (subsystems.length >= 16) break;
    absorb(routineTitle(routine), routine.analysis?.purpose || routine.comment || '', 'plc');
    usedRoutines.add(routine);
  }
  subsystems.sort((a, b) => flowRank(a.name) - flowRank(b.name));
  if (!subsystems.length) return [];
  return subsystems;
}

module.exports = { buildSubsystems, flowRank };
