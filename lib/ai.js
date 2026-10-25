const { anthropicModel } = require('./config');
const { estimateTokens, sanitizeProse } = require('./text');
const { limits } = require('./limits');
const { analyzeRoutine } = require('./logic');
const { fallbackNarrative, polishName, looksCoded, isStructural } = require('./presentation');
const { energyRows } = require('./energy');
const { geometryOnlyMesh } = require('./machine-content');
const { namesClose, purposeText, markersConflict, withSide, purposesDiffer } = require('./subsystems');

function anthropicBody(model, prompt) {
  const body = {
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };
  if (String(model).startsWith('claude-haiku-5')) {
    body.max_tokens = 8192;
    body.thinking = { type: 'disabled' };
    body.output_config = { effort: 'low' };
  } else {
    body.max_tokens = 8192;
  }
  return body;
}

function extractModelText(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function parseModelJson(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  return JSON.parse(trimmed.slice(start, end + 1));
}

function chunkUnits(units, capTokens) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const unit of units) {
    const cost = estimateTokens(`${unit.comment || ''} ${unit.text || ''}`) + 40;
    if (current.length && (current.length >= 30 || size + cost > capTokens)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(unit);
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [[]];
}

function promptFor(routine, units, tagLines) {
  const payload = units.map((unit) => ({
    index: unit.index,
    number: unit.number,
    kind: unit.kind,
    comment: unit.comment || '',
    logic: String(unit.text || ''),
  }));
  return [
    'You are writing an operator and maintenance manual for industrial equipment.',
    'Describe what the MACHINE does. Do not document code.',
    'Internal routine id (do not copy this identifier into any heading or sentence): ' + routine.name,
    'Return JSON only with this shape:',
    '{"human_title":"","purpose":"","inferred":true,"operator_steps":[{"action":"","expect":""}],"groups":[{"unit_numbers":[],"title":"","function":"","conditions":"","result":"","related_alarm_or_hazard_ids":[],"housekeeping":false,"inferred":true}],"alarms":[{"code":"","text":"","cause":"","remedy":"","inferred":true}],"applicable_hazard_ids":[],"interlocks":[],"what_operator_sees":""}',
    'Group related rungs or statements into one function. Every index in the payload must appear in exactly one group.',
    'Plain English only. No instruction mnemonics, tag names, addresses, braces, or the internal routine id.',
    'Use device descriptions. Mark inference with inferred:true.',
    'Do not write compliant, certified, or meets a named standard. Do not invent alarm codes, stop reactions, test intervals, or numbers that are not in the program.',
    'Do not call an OTE a latch. An OTE turns on while its conditions are true. Do not call a less-than or equal comparison an over-limit.',
    'Device descriptions:',
    tagLines.join('\n') || '(none)',
    'Program units:',
    JSON.stringify(payload),
  ].join('\n');
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, run));
  return results;
}

async function withRetry(times, fn) {
  let last;
  for (let attempt = 0; attempt < times; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function analyzeProject(project, { anthropic, env, onProgress }) {
  const cap = limits(env);
  const model = anthropicModel(env);
  const tagLines = (project.tags || []).slice(0, 200).map((tag) => (
    tag.description ? `- ${tag.description}` : ''
  )).filter(Boolean);
  const jobs = [];
  for (const routine of project.routines) {
    const chunks = chunkUnits(routine.units || [], Math.min(20000, cap.maxPromptTokens));
    chunks.forEach((units, index) => jobs.push({ routine, units, index }));
  }
  const collected = new Map();
  let done = 0;
  await mapPool(jobs, cap.aiConcurrency, async (job) => {
    const bucket = collected.get(job.routine) || { groups: [], notes: {}, failed: false };
    collected.set(job.routine, bucket);
    if (!job.units.length) return;
    const prompt = promptFor(job.routine, job.units, tagLines);
    if (estimateTokens(prompt) > cap.maxPromptTokens) {
      bucket.failed = true;
      return;
    }
    try {
      const message = await withRetry(cap.aiRetries + 1, () => anthropic.messages.create(anthropicBody(model, prompt)));
      const parsed = parseModelJson(extractModelText(message));
      bucket.groups.push(...(parsed.groups || []));
      bucket.notes = parsed;
    } catch (err) {
      bucket.failed = true;
      project.warnings.push(`One control section could not be rewritten automatically and was described from the project data instead.`);
    } finally {
      done += 1;
      if (onProgress) {
        const percent = 30 + Math.round((done / Math.max(jobs.length, 1)) * 35);
        onProgress('analyzing', percent, 'Describing how the equipment works');
      }
    }
  });
  for (const routine of project.routines) {
    const bucket = collected.get(routine);
    const modelGroups = bucket && !bucket.failed ? bucket.groups : null;
    if (bucket && bucket.notes && bucket.notes.human_title && modelGroups) modelGroups.title = bucket.notes.human_title;
    analyzeRoutine(routine, project, modelGroups);
    if (bucket && bucket.notes) {
      routine.analysis.purpose = bucket.notes.purpose || '';
      routine.analysis.operatorSteps = Array.isArray(bucket.notes.operator_steps) ? bucket.notes.operator_steps : [];
      routine.analysis.alarms = Array.isArray(bucket.notes.alarms) ? bucket.notes.alarms : [];
      routine.analysis.hazardIds = Array.isArray(bucket.notes.applicable_hazard_ids) ? bucket.notes.applicable_hazard_ids : [];
      routine.analysis.interlocks = Array.isArray(bucket.notes.interlocks) ? bucket.notes.interlocks : [];
      routine.analysis.operatorSees = bucket.notes.what_operator_sees || '';
    }
  }
  await analyzeEquipment(project, { anthropic, env, onProgress, model, cap });
  return project;
}

function equipmentPrompt(project, parts, includeOverview) {
  const routines = includeOverview ? (project.routines || []).slice(0, 40).map((routine) => ({
    title: routine.analysis && routine.analysis.title,
    purpose: routine.analysis && routine.analysis.purpose,
    functions: ((routine.analysis && routine.analysis.groups) || []).slice(0, 4).map((group) => group.text).filter(Boolean),
  })) : [];
  const tags = includeOverview ? (project.tags || []).slice(0, 80).map((tag) => tag.description).filter(Boolean) : [];
  const modules = includeOverview ? [...new Set((project.modules || []).map((item) => item.catalog).filter(Boolean))].slice(0, 24) : [];
  return [
    'You are writing the theory-of-operation chapter of an industrial equipment manual.',
    'Describe the equipment. Do not document code, tag names, or instruction mnemonics.',
    'Return JSON only:',
    '{"equipment_kind":"machine|process|calculation|structure","product_name":"","overview":"","cycle":"","subsystems":[{"assembly":"","name":"","role":"process|frame|guarding","function":"","motion":"","sensors":"","interlocks":"","components":[]}]}',
    'assembly and name must be copied verbatim from the Assemblies list. Do not shorten, translate, or paraphrase an assembly name.',
    'function must describe the assembly. Never repeat the assembly name as its function. Keep left and right parts as separate subsystems. Do not invent a subsystem named Component plus a part number.',
    'Structural parts (extrusions, acrylic panels, brackets, frames, fasteners) use role frame or guarding. Never call them process stages or product-flow stations.',
    'Fit the wording to the equipment. A calculation explains inputs and the result. A process uses fill, heat, hold, and discharge. A machine may describe stations. Do not write "carries the product through these stages" unless a discrete product actually moves.',
    'overview is two to four sentences for the whole equipment. cycle is the operating sequence, process, or calculation in order.',
    'Quote comparison direction from the known functions. If a function says a device turns on when a measurement is less than a setpoint, overview and cycle must say less than. Do not reverse it to greater than, above, or higher than.',
    'product_name is a short descriptive name, not an all-caps drawing code.',
    'Do not write compliant, certified, or meets a named standard. Do not invent numbers, test intervals, or energy sources that are not in the parts list.',
    'Do not call an OTE a latch. Do not call a less-than or equal comparison an over-limit.',
    includeOverview ? `Known functions:\n${JSON.stringify(routines)}\nSignals:\n${JSON.stringify(tags)}\nModules:\n${JSON.stringify(modules)}` : 'Describe only the parts in this chunk.',
    includeOverview ? `Bill of materials:\n${JSON.stringify((project.cad.bom || []).slice(0, 40).map((part) => ({ part: part.partNumber, description: part.description, qty: part.qty })))}` : '',
    `Assemblies:\n${JSON.stringify(parts)}`,
  ].join('\n');
}

function cadParts(project) {
  const all = project.cad.assemblies || [];
  const tree = all.filter((item) => !item.leaf);
  return (tree.length ? tree : all).slice(0, 80).map((item) => ({
    name: item.name,
    kind: item.kind || '',
    role: item.role || (isStructural(item.kind) ? 'structure' : 'process'),
    description: item.description || '',
  }));
}

function chunkList(items, size) {
  if (!items.length) return [[]];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const COMPARE_STOP = new Set('than when then with this that less greater above below under over equal turns control measured value setpoint output input device equipment during'.split(' '));

function narrativeEvidence(project) {
  return (project.routines || []).flatMap((routine) => ((routine.analysis && routine.analysis.groups) || []).map((group) => `${group.text || ''} ${group.conditions || ''}`)).join('\n');
}

function directionOf(text) {
  const less = /\bless than\b|\bbelow\b|\blower than\b/i.test(text);
  const greater = /\bgreater than\b|\babove\b|\bhigher than\b/i.test(text);
  if (less && greater) return 'mixed';
  if (less) return 'less';
  if (greater) return 'greater';
  return '';
}

function sharesSubject(left, right) {
  const words = (value) => new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !COMPARE_STOP.has(word)));
  const rightWords = words(right);
  for (const word of words(left)) if (rightWords.has(word)) return true;
  return false;
}

function contradictsEvidence(candidate, evidence) {
  const claims = String(candidate || '').split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const facts = String(evidence || '').split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  for (const fact of facts) {
    const factDir = directionOf(fact);
    if (!factDir || factDir === 'mixed') continue;
    for (const claim of claims) {
      const claimDir = directionOf(claim);
      if (!claimDir || claimDir === 'mixed' || claimDir === factDir) continue;
      if (sharesSubject(claim, fact)) return true;
    }
  }
  return false;
}

function applyEquipment(project, parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  const narrative = project.narrative || fallbackNarrative(project);
  const evidence = narrativeEvidence(project);
  const overview = sanitizeProse(parsed.overview || parsed.purpose || '', project);
  const cycle = sanitizeProse(parsed.cycle || '', project);
  if (overview && overview.length > 40 && !/carries the product through these stages/i.test(overview) && !contradictsEvidence(overview, evidence)) {
    narrative.overview = overview;
  }
  if (cycle && cycle.length > 20 && !contradictsEvidence(cycle, evidence)) narrative.cycle = cycle;
  const productName = polishName(parsed.product_name || '');
  if (productName && productName.length > 3 && !looksCoded(productName)) narrative.productName = productName;
  const detected = narrative.kind;
  const pressurised = energyRows(project).some((row) => row.energy === 'Process pressure' || row.energy === 'Process chemical');
  if (pressurised && parsed.equipment_kind === 'calculation') {
    narrative.kind = detected === 'machine' || detected === 'process' ? detected : 'process';
  } else if (parsed.equipment_kind && /^(machine|process|calculation|structure)$/.test(parsed.equipment_kind)) {
    const locked = detected === 'structure' || detected === 'calculation';
    if (!locked || parsed.equipment_kind === detected) narrative.kind = parsed.equipment_kind;
  }
  if (pressurised) {
    const deniesProcess = /no guarded motion|this calculation|only a calculation/i;
    if (deniesProcess.test(narrative.overview || '')) {
      narrative.overview = 'This equipment is a pressurised process vessel. Isolate the supplies, depressurise the vessel, and drain the lines before you open a fitting.';
    }
    if (deniesProcess.test(narrative.cycle || '')) {
      narrative.cycle = 'Isolate the supplies, depressurise the vessel, and drain the lines. Then follow the control sequence in the uploaded program.';
    }
  }
  project.narrative = narrative;
  const incoming = [];
  for (const item of parsed.subsystems || []) {
    const name = polishName(item.name || item.assembly || '');
    if (!name) continue;
    const role = item.role === 'frame' || item.role === 'guarding' ? 'structure' : 'process';
    const fn = purposeText(sanitizeProse(item.function || '', project), name);
    const analysis = {
      role,
      function: fn,
      motion: sanitizeProse(item.motion || '', project),
      sensors: sanitizeProse(item.sensors || '', project),
      interlocks: sanitizeProse(item.interlocks || '', project),
      components: Array.isArray(item.components) ? item.components.map((value) => sanitizeProse(value, project)).filter(Boolean).slice(0, 8) : [],
    };
    const wanted = item.assembly || name;
    const assembly = (project.cad.assemblies || []).find((entry) => (
      !markersConflict(entry.name, name) && (namesClose(entry.name, wanted) || namesClose(entry.name, name))
    ));
    const priorFn = assembly && assembly.analysis && assembly.analysis.function;
    const distinct = priorFn && fn && purposesDiffer(priorFn, fn);
    if (assembly && !distinct) {
      assembly.analysis = analysis;
      if (role === 'structure' && !/\bdoor\b/i.test(`${name} ${fn}`)) assembly.role = 'structure';
    }
    const shown = withSide(distinct ? name : (assembly ? (polishName(assembly.name) || name) : name), fn);
    incoming.push({
      name: shown,
      assembly: assembly && !distinct ? assembly.name : (item.assembly || ''),
      ...analysis,
    });
  }
  narrative.modelSubsystems = [...(narrative.modelSubsystems || []), ...incoming];
}

async function analyzeEquipment(project, { anthropic, env, onProgress, model, cap }) {
  project.narrative = fallbackNarrative(project);
  if (geometryOnlyMesh(project)) return project;
  const parts = cadParts(project);
  const hasSignals = (project.tags || []).some((tag) => tag.description) || (project.modules || []).length > 0;
  if (!parts.length && !(project.routines || []).length && !hasSignals) return project;
  const chunks = chunkList(parts, 12);
  let failed = 0;
  await mapPool(chunks, cap.aiConcurrency, async (chunk, index) => {
    const prompt = equipmentPrompt(project, chunk, index === 0);
    if (estimateTokens(prompt) > cap.maxPromptTokens) {
      failed += 1;
      return;
    }
    try {
      const message = await withRetry(cap.aiRetries + 1, () => anthropic.messages.create(anthropicBody(model, prompt)));
      applyEquipment(project, parseModelJson(extractModelText(message)));
    } catch (err) {
      failed += 1;
    }
    if (onProgress) onProgress('analyzing', 66, 'Describing the equipment');
  });
  if (failed === chunks.length) {
    project.warnings.push('The equipment overview was written from the uploaded files because the model pass did not return a description.');
  }
  return project;
}

module.exports = {
  anthropicBody, extractModelText, parseModelJson, analyzeProject, promptFor, applyEquipment, equipmentPrompt, contradictsEvidence,
};
