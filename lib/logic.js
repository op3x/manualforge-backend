const {
  tagIndex, translateLogic, translateStructuredText, commentIsPlain, humanize, sanitizeProse, headingFrom, forbiddenNames,
} = require('./text');
const { uniqueSentences } = require('./presentation');

function instructions(text) {
  const out = [];
  const re = /\b([A-Za-z]{2,6})\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) out.push({ mnemonic: match[1].toUpperCase(), operand: match[2] });
  return out;
}

function isHousekeepingUnit(unit) {
  const text = String(unit.text || '').trim();
  const comment = String(unit.comment || '').trim();
  if (!text && !comment) return true;
  const list = instructions(text);
  if (list.length && list.every((item) => item.mnemonic === 'NOP' || item.mnemonic === 'AFI')) return true;
  if (/^\s*NOP\s*;?\s*$/i.test(text) && !comment) return true;
  return false;
}

function primaryOutput(unit) {
  const list = instructions(unit.text);
  const outputs = list.filter((item) => ['OTE', 'OTL', 'OTU', 'TON', 'TOF', 'RTO', 'CTU', 'CTD', 'JSR'].includes(item.mnemonic));
  if (!outputs.length) return '';
  return outputs[outputs.length - 1].operand.split(',')[0].split('.')[0].split('[')[0].trim();
}

function unitLabel(units) {
  const kind = units[0] && units[0].kind;
  if (kind === 'statement') return ['Statement', 'Statements'];
  if (kind === 'network') return ['Network', 'Networks'];
  if (kind === 'step' || kind === 'transition') return ['Step', 'Steps'];
  return ['Rung', 'Rungs'];
}

function rungRef(units) {
  const numbers = [...new Set(units.map((unit) => unit.number))].sort((a, b) => a - b);
  if (!numbers.length) return '';
  const parts = [];
  let start = numbers[0];
  let prev = numbers[0];
  for (let i = 1; i <= numbers.length; i += 1) {
    const value = numbers[i];
    if (value === prev + 1) { prev = value; continue; }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = value;
  }
  const body = parts.join(', ');
  const [one, many] = unitLabel(units);
  if (numbers.length === 1) return `${one} ${body}`;
  return `${many} ${body}`;
}

function describeUnits(units, project) {
  const tags = tagIndex(project);
  const forbidden = forbiddenNames(project);
  const summaries = units.map((unit) => unit.summary).filter(Boolean);
  if (summaries.length && !units.some((unit) => unit.kind === 'rung')) {
    return { text: sanitizeProse(summaries.join(' '), project), inferred: true };
  }
  const comments = units.map((unit) => unit.comment).filter((comment) => commentIsPlain(comment, forbidden));
  const translated = units.map((unit) => (
    translateLogic(unit.text, tags) || translateStructuredText(unit.text, tags)
  )).filter(Boolean);
  let text = '';
  let inferred = true;
  if (summaries.length && !translated.length && !comments.length) {
    return { text: sanitizeProse(summaries.join(' '), project), inferred: true };
  }
  if (comments.length) {
    text = comments.join(' ');
    inferred = translated.length > 0;
    if (translated.length) text = `${text} ${translated.join(' ')}`;
  } else {
    text = translated.join(' ');
  }
  if (!text) {
    text = 'This part of the program supports the function described above.';
    inferred = true;
  }
  return { text: sanitizeProse(text, project), inferred };
}

function groupUnitList(units, project) {
  const housekeeping = [];
  const functional = [];
  for (const unit of units) {
    if (isHousekeepingUnit(unit)) housekeeping.push(unit);
    else functional.push(unit);
  }
  const groups = [];
  let current = null;
  const close = () => { current = null; };
  for (const unit of functional) {
    const output = primaryOutput(unit);
    const join = current && current.units.length < 12 && (
      (output && output === current.output) || (!output)
    );
    if (!join) {
      current = { units: [], output: output || '' };
      groups.push(current);
    }
    current.units.push(unit);
    if (output) current.output = output;
    if (current.units.length >= 12) close();
  }
  return {
    groups: groups.map((group) => {
      const described = describeUnits(group.units, project);
      const title = headingFrom(group.output, group.units[0] && group.units[0].comment) || 'Machine function';
      return {
        unitIndexes: group.units.map((unit) => unit.index),
        numbers: group.units.map((unit) => unit.number),
        kind: group.units[0] && group.units[0].kind,
        ref: rungRef(group.units),
        title: sanitizeProse(title, project) || 'Machine function',
        text: described.text,
        inferred: described.inferred,
        housekeeping: false,
        output: group.output,
      };
    }),
    housekeeping: housekeeping.map((unit) => unit.index),
  };
}

function acceptModelGroups(units, modelGroups, project) {
  if (!Array.isArray(modelGroups) || !modelGroups.length) return null;
  const byIndex = new Map(units.map((unit) => [unit.index, unit]));
  const seen = new Set();
  const groups = [];
  const housekeeping = [];
  for (const raw of modelGroups) {
    const ids = [...new Set((raw.unit_numbers || raw.unitIndexes || []).map(Number))].filter((id) => byIndex.has(id) && !seen.has(id));
    if (!ids.length) continue;
    ids.forEach((id) => seen.add(id));
    const selected = ids.map((id) => byIndex.get(id));
    if (raw.housekeeping) {
      housekeeping.push(...ids);
      continue;
    }
    const fallback = describeUnits(selected, project);
    const text = sanitizeProse(raw.function || raw.plain_english_function || '', project) || fallback.text;
    const title = sanitizeProse(raw.title || '', project) || headingFrom('', text) || 'Machine function';
    groups.push({
      unitIndexes: ids,
      numbers: selected.map((unit) => unit.number),
      kind: selected[0] && selected[0].kind,
      ref: rungRef(selected),
      title: title || 'Machine function',
      text,
      conditions: uniqueSentences(sanitizeProse(raw.conditions || '', project)),
      result: sanitizeProse(raw.result || '', project),
      hazardIds: Array.isArray(raw.related_alarm_or_hazard_ids) ? raw.related_alarm_or_hazard_ids : [],
      inferred: raw.inferred !== false,
      housekeeping: false,
    });
  }
  if (seen.size !== units.length) return null;
  return { groups, housekeeping };
}

function analyzeRoutine(routine, project, modelGroups) {
  const fromModel = acceptModelGroups(routine.units || [], modelGroups, project);
  const base = fromModel || groupUnitList(routine.units || [], project);
  const title = sanitizeProse((fromModel && modelGroups && modelGroups.title) || '', project)
    || humanize(routine.name)
    || (base.groups[0] && base.groups[0].title)
    || 'Machine function';
  routine.analysis = {
    title: title || 'Machine function',
    groups: base.groups,
    housekeeping: base.housekeeping,
    purpose: '',
    operatorSteps: [],
    alarms: [],
    hazardIds: [],
    interlocks: [],
    operatorSees: '',
  };
  return routine.analysis;
}

function coverageOf(project) {
  let units = 0;
  let accounted = 0;
  const missing = [];
  for (const routine of project.routines) {
    const analysis = routine.analysis || { groups: [], housekeeping: [] };
    const ids = routine.units.map((unit) => unit.index);
    units += ids.length;
    const seen = new Set();
    for (const group of analysis.groups) {
      for (const id of group.unitIndexes) {
        if (!ids.includes(id) || seen.has(id)) {
          missing.push(`${routine.name}:${id}`);
        }
        seen.add(id);
      }
    }
    for (const id of analysis.housekeeping) {
      if (!ids.includes(id) || seen.has(id)) missing.push(`${routine.name}:h${id}`);
      seen.add(id);
    }
    for (const id of ids) if (!seen.has(id)) missing.push(`${routine.name}:${id}`);
    accounted += seen.size;
  }
  const percent = units === 0 ? 100 : Math.round((accounted / units) * 1000) / 10;
  return { units, accounted, percent, missing, ok: missing.length === 0 && accounted === units };
}

function assertCoverage(project) {
  const report = coverageOf(project);
  project.coverage = report;
  if (!report.ok) {
    const err = new Error('coverage');
    err.status = 500;
    err.expose = true;
    err.message = 'Manual generation failed because the control logic could not be fully accounted for.';
    throw err;
  }
  return report;
}

module.exports = {
  isHousekeepingUnit,
  groupUnitList,
  analyzeRoutine,
  coverageOf,
  assertCoverage,
  rungRef,
  acceptModelGroups,
};
