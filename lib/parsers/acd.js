const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { limits } = require('../limits');
const { emptyProject, addRoutine } = require('../project');
const { parseL5x } = require('./l5x');

const SCRIPT = path.join(__dirname, '../../scripts/acd_to_l5x.py');
const UNREAD_TYPES = new Set(['FBD', 'SFC', 'ST', 'ENCRYPTED', 'EXTERNAL', 'TYPELESS']);

const JUNK = new Set([
  'Routine', 'Program', 'Controller', 'Task', 'Tag', 'Description', 'Type', 'Name', 'Value',
  'Module', 'Data', 'String', 'Element', 'Manager', 'Collection', 'Container', 'Composite',
  'Language', 'Metadata', 'FloatingElement', 'CommentManager', 'EditingCompositeLanguageContainer',
  'CollectionElement', 'Rung', 'Comment', 'Text', 'Operand',
]);

function gunzip(buffer) {
  return new Promise((resolve) => {
    zlib.gunzip(buffer, (err, result) => resolve(err ? null : result));
  });
}

async function extractXmlFromAcdBuffer(buffer, env) {
  const cap = limits(env);
  const started = Date.now();
  const chunks = [];
  let gzipCount = 0;
  let i = 0;
  while (i < buffer.length - 2 && gzipCount < cap.acdMaxGzip && Date.now() - started < cap.acdMaxMs) {
    if (buffer[i] === 0x1f && buffer[i + 1] === 0x8b) {
      const result = await gunzip(buffer.subarray(i));
      gzipCount += 1;
      if (result && result.length > 10) {
        let text = result.toString('utf8');
        if (!text.includes('<') && !text.includes('Routine')) text = result.toString('utf16le');
        if (text.includes('<')) chunks.push(text);
        i += Math.max(4, Math.min(result.length, 4096));
        continue;
      }
    }
    i += 1;
  }
  return chunks.join('\n');
}

function usableName(name) {
  if (!name || JUNK.has(name)) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]{1,40}$/.test(name)) return false;
  if (/Element|Manager|Collection|Container|Metadata|Composite/i.test(name)) return false;
  return true;
}

function findPython() {
  if (process.env.MANUALOS_PYTHON && fs.existsSync(process.env.MANUALOS_PYTHON)) return process.env.MANUALOS_PYTHON;
  for (const name of ['python3', 'python']) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    const found = String(result.stdout || '').trim().split('\n')[0];
    if (result.status === 0 && found) return found;
  }
  return '';
}

function pythonEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

function unreadReason(type) {
  const kind = String(type || '').toUpperCase();
  if (kind === 'ENCRYPTED') {
    return 'This routine is encrypted in the ACD file, so its logic cannot be read. Export L5X from Studio 5000 with the source included.';
  }
  const label = {
    FBD: 'function-block',
    SFC: 'sequential function chart',
    ST: 'structured-text',
    EXTERNAL: 'external',
    TYPELESS: 'untyped',
  }[kind] || 'controller';
  return `This ${label} routine is in the ACD file, but its logic could not be extracted. Export L5X from Studio 5000 to include this routine.`;
}

function recoveredUnits(type, rungs) {
  const kind = String(type || '').toUpperCase();
  return rungs.map((text, index) => {
    const unitKind = kind === 'ST' ? 'statement' : kind === 'SFC' ? 'step' : 'network';
    const prose = !/[;{}]|:=|\b(XIC|XIO|OTE|IF|THEN)\b/.test(text) && text.length >= 8;
    return {
      index,
      number: index,
      kind: unitKind,
      text,
      comment: '',
      summary: prose ? text.replace(/\s+/g, ' ').trim() : '',
    };
  });
}

function applyAcdLibraryNotes(project, meta = {}) {
  const extras = new Map((meta.routines || []).map((routine) => (
    [`${routine.program || ''}::${routine.name || ''}`.toLowerCase(), routine]
  )));
  for (const routine of project.routines) {
    const hasText = (routine.units || []).some((unit) => String(unit.text || '').trim() && !unit.unread);
    if (hasText) continue;
    const extra = extras.get(`${routine.program || ''}::${routine.name || ''}`.toLowerCase());
    const type = String((extra && extra.type) || routine.type || '').toUpperCase();
    const rungs = ((extra && extra.rungs) || []).map((rung) => String(rung || '').trim()).filter(Boolean);
    if (rungs.length) {
      routine.units = recoveredUnits(type, rungs);
      routine.type = routine.type || type;
      continue;
    }
    if (!UNREAD_TYPES.has(type)) continue;
    const reason = unreadReason(type);
    routine.unreadReason = reason;
    routine.type = routine.type || type;
    routine.units = [{
      index: 0,
      number: 0,
      kind: 'network',
      text: reason,
      comment: 'Could not extract this routine',
      summary: reason,
      unread: true,
    }];
  }
  const real = project.routines.some((routine) => (routine.units || []).some((unit) => !unit.unread && String(unit.text || '').trim()));
  project.acdLimited = !real;
  if (real) {
    project.partialExport = false;
    project.warnings = (project.warnings || []).filter((warning) => !/no routine logic/i.test(warning));
  }
  return project;
}

function convertAcd(buffer, env) {
  const python = findPython();
  if (!python || !fs.existsSync(SCRIPT)) return null;
  const cap = limits(env);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-acd-'));
  const acdPath = path.join(dir, 'upload.ACD');
  const l5xPath = path.join(dir, 'upload.L5X');
  try {
    fs.writeFileSync(acdPath, buffer);
    const result = spawnSync(python, [SCRIPT, acdPath, l5xPath], {
      timeout: cap.acdConvertMs,
      encoding: 'utf8',
      env: pythonEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !fs.existsSync(l5xPath)) return null;
    const l5x = fs.readFileSync(l5xPath, 'utf8');
    let meta = { routines: [] };
    try {
      meta = JSON.parse(result.stdout || '{}');
    } catch {
      meta = { routines: [] };
    }
    if (!l5x.includes('<Controller')) return null;
    return { l5x, meta };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function resetParsed(project) {
  const fresh = emptyProject();
  project.controller = fresh.controller;
  project.programs = fresh.programs;
  project.routines = fresh.routines;
  project.tags = fresh.tags;
  project.modules = fresh.modules;
  project.tasks = fresh.tasks;
  project.aois = fresh.aois;
  project.safetyPrograms = fresh.safetyPrograms;
  project.safetyTasks = fresh.safetyTasks;
  project.partialExport = false;
  project.warnings = [];
  project.acdLimited = false;
  project.acdConverted = false;
}

async function parseAcdLimited(project, buffer, env) {
  project.acdLimited = true;
  project.acdConverted = false;
  project.warnings.push('This is a Rockwell ACD file. Studio 5000 stores the logic in a proprietary format, so rung text cannot be read. Export L5X (File > Save As > L5X) and upload that file for a complete manual.');
  const xml = await extractXmlFromAcdBuffer(buffer, env);
  const names = new Set();
  if (xml) {
    for (const match of xml.matchAll(/(?:MainRoutineName|FaultRoutineName|EventRoutineName|Routine Name)="([^"]+)"/gi)) {
      if (usableName(match[1])) names.add(match[1]);
    }
    const controller = xml.match(/<Controller[^>]*Name="([^"]+)"/i);
    if (controller) project.controller = project.controller || controller[1];
  }
  if (!project.programs.length) project.programs.push('MainProgram');
  for (const name of names) {
    addRoutine(project, {
      name,
      type: 'RLL',
      program: project.programs[0],
      scopeKey: `${project.programs[0]}/${name}`,
      comment: '',
      units: [],
      language: 'acd',
    });
  }
  return project;
}

async function parseAcd(project, buffer, env) {
  const converted = convertAcd(buffer, env);
  if (converted) {
    try {
      parseL5x(project, converted.l5x);
      applyAcdLibraryNotes(project, converted.meta);
      project.acdConverted = true;
      if (project.acdLimited) {
        project.warnings.push('The ACD file was converted, but no routine logic could be read. Export L5X (File > Save As > L5X) and upload that file for a complete manual.');
      }
      return project;
    } catch {
      resetParsed(project);
    }
  }
  return parseAcdLimited(project, buffer, env);
}

module.exports = {
  parseAcd,
  extractXmlFromAcdBuffer,
  usableName,
  applyAcdLibraryNotes,
  convertAcd,
};
