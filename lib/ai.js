const { anthropicModel } = require('./config');
const { estimateTokens } = require('./text');
const { limits } = require('./limits');
const { analyzeRoutine } = require('./logic');

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
  if (!project.routines.length) return project;
  return project;
}

module.exports = { anthropicBody, extractModelText, parseModelJson, analyzeProject, promptFor };
