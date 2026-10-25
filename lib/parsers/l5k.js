const { addRoutine, upsertTag } = require('../project');

const ROUTINE_RE = /^(?:ST_|RLL_|FBD_|SFC_)?ROUTINE\s+([A-Za-z0-9_]+)/i;
const END_ROUTINE_RE = /^END_(?:ST_|RLL_|FBD_|SFC_)?ROUTINE\b/i;

function parseL5k(project, text) {
  const lines = String(text || '').split(/\r?\n/);
  const controllerMatch = text.match(/\bCONTROLLER\s+([A-Za-z0-9_]+)/i);
  if (controllerMatch) project.controller = project.controller || controllerMatch[1];
  let program = '';
  let routine = null;
  let tagScope = '';
  let pendingComment = '';
  const flush = () => {
    if (routine) {
      routine.units.forEach((unit, index) => {
        unit.index = index;
        if (!Number.isFinite(unit.number)) unit.number = index;
      });
      addRoutine(project, routine);
      routine = null;
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    const programMatch = line.match(/^(?:PROGRAM|ADD_ON_INSTRUCTION_DEFINITION)\s+([A-Za-z0-9_]+)/i);
    if (programMatch) {
      flush();
      program = programMatch[1];
      if (!project.programs.includes(program)) project.programs.push(program);
      if (/^ADD_ON_INSTRUCTION_DEFINITION/i.test(line)) {
        project.aois.push({ name: program, description: '' });
      }
      continue;
    }
    if (/^END_(?:PROGRAM|ADD_ON_INSTRUCTION_DEFINITION)\b/i.test(line)) {
      flush();
      program = '';
      continue;
    }
    const routineMatch = line.match(ROUTINE_RE);
    if (routineMatch) {
      flush();
      const kind = /^ST_ROUTINE/i.test(line) ? 'ST' : 'RLL';
      routine = {
        name: routineMatch[1],
        type: kind,
        program: program || 'Program',
        scopeKey: `${program || 'Program'}/${routineMatch[1]}`,
        comment: (line.match(/Description\s*:=\s*"([^"]*)"/i) || [])[1] || '',
        units: [],
        language: 'l5k',
        aoi: project.aois.some((item) => item.name === program),
      };
      continue;
    }
    if (END_ROUTINE_RE.test(line)) {
      flush();
      continue;
    }
    if (/^(?:TAG|LOCAL_TAGS|PARAMETERS)\b/i.test(line)) {
      tagScope = program || 'controller';
      continue;
    }
    if (/^END_(?:TAG|LOCAL_TAGS|PARAMETERS)\b/i.test(line)) {
      tagScope = '';
      continue;
    }
    if (tagScope) {
      const tagMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_]+)/);
      if (tagMatch) {
        const description = (line.match(/Description\s*:=\s*"([^"]*)"/i) || [])[1] || '';
        upsertTag(project, {
          name: tagMatch[1],
          dataType: tagMatch[2],
          description,
          scope: tagScope,
        });
      }
      continue;
    }
    if (!routine) continue;
    if (/^RC\s*:/i.test(line)) {
      const quoted = (line.match(/"([^"]*)"/) || [])[1] || '';
      pendingComment = quoted.replace(/\$N/g, ' ').trim();
      continue;
    }
    if (/^'/.test(line)) {
      const code = line.replace(/^'+/, '').trim();
      if (!code) continue;
      routine.units.push({
        index: routine.units.length,
        number: routine.units.length,
        kind: 'statement',
        text: code.replace(/\/\/.*$/, '').trim(),
        comment: ((code.match(/\/\/\s*(.+)$/) || [])[1] || pendingComment || '').trim(),
      });
      pendingComment = '';
      continue;
    }
    if (/^[NA]\s*:/i.test(line) || /\b(?:XIC|XIO|OTE|OTL|OTU|TON|JSR|EQU|MOV|COP)\s*\(/i.test(line)) {
      const body = line.replace(/^[NA]\s*:\s*/i, '').trim();
      routine.units.push({
        index: routine.units.length,
        number: routine.units.length,
        kind: 'rung',
        text: body.replace(/\/\/.*$/, '').trim(),
        comment: pendingComment,
      });
      pendingComment = '';
    }
  }
  flush();
  if (!project.routines.length && !project.tags.length) {
    const err = new Error('empty l5k');
    err.status = 422;
    err.expose = true;
    err.message = 'This .l5k file did not contain routines or tags. Export the controller as .l5k or .l5x.';
    throw err;
  }
  return project;
}

module.exports = { parseL5k };
