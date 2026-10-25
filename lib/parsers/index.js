const { exposed } = require('../errors');
const { decodeBuffer, safeName } = require('../text');
const { emptyFileError, fileHash, unsupportedFileError } = require('../upload-errors');
const { emptyProject, addSource, applyFields } = require('../project');
const { detectFormat, proprietaryKind, proprietaryMessage } = require('./detect');
const { unzipSafe } = require('./zip');
const { parseL5x } = require('./l5x');
const { parseL5k } = require('./l5k');
const { parsePlcopen } = require('./plcopen');
const { parseSt } = require('./st');
const { parseCsvProject, parseXlsxProject, parseTagTable } = require('./tabular');
const { parseDxf } = require('./dxf');
const { parseStep } = require('./step');
const { parseIges } = require('./iges');
const { parseAcd } = require('./acd');
const { parseTia } = require('./tia');
const { parseMeshStl } = require('./mesh-stl');

const EXT_EXPECT = {
  l5x: ['l5x', 'xml', 'plcopen', 'tcpou'],
  xml: ['l5x', 'xml', 'plcopen', 'tcpou', 'tags', 'tia'],
  l5k: ['l5k'],
  st: ['st', 'awl'],
  scl: ['st', 'awl'],
  awl: ['awl', 'st'],
  db: ['st', 'awl'],
  stl: ['stl', 'awl', 'st'],
  exp: ['st', 'awl', 'l5x', 'xml', 'plcopen', 'tia'],
  tcpou: ['tcpou', 'plcopen', 'xml'],
  csv: ['csv'],
  xlsx: ['xlsx'],
  step: ['step'],
  stp: ['step'],
  iges: ['iges'],
  igs: ['iges'],
  dxf: ['dxf'],
  acd: ['acd'],
  zip: ['zip', 'xlsx'],
};

const SUPPORTED = new Set([
  'l5x', 'l5k', 'plcopen', 'tcpou', 'xml', 'st', 'awl', 'tia', 'stl', 'csv', 'xlsx',
  'dxf', 'step', 'iges', 'acd', 'tags',
]);

function describeFile(file) {
  const name = safeName(file.name || file.originalname);
  if (file.container) return `${name} inside ${safeName(file.container)}`;
  return name;
}

function rejectUnsupported(message, file) {
  return unsupportedFileError(message, file);
}

function extensionOf(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

async function parseOne(project, file, env) {
  const label = describeFile(file);
  const blocked = proprietaryKind(file.name, file.buffer);
  if (blocked) throw rejectUnsupported(proprietaryMessage(file.name, blocked), label);
  const format = file.format || detectFormat(file.buffer, file.name);
  const ext = extensionOf(file.name);
  if (format === 'executable' || format === 'unknown') {
    throw rejectUnsupported(`This file is not a supported project format: ${label}.`, label);
  }
  if (ext && EXT_EXPECT[ext] && !EXT_EXPECT[ext].includes(format)) {
    throw rejectUnsupported(`File content does not match its type: ${label}.`, label);
  }
  const text = () => decodeBuffer(file.buffer);
  if (format === 'l5x') parseL5x(project, text());
  else if (format === 'l5k') parseL5k(project, text());
  else if (format === 'plcopen' || format === 'tcpou' || format === 'xml') parsePlcopen(project, text());
  else if (format === 'st' || format === 'awl') parseSt(project, text(), file.name);
  else if (format === 'tia') parseTia(project, text());
  else if (format === 'stl') parseMeshStl(project, file.buffer, file.name);
  else if (format === 'csv') parseCsvProject(project, text());
  else if (format === 'xlsx') parseXlsxProject(project, file.buffer);
  else if (format === 'dxf') parseDxf(project, file.buffer);
  else if (format === 'step') await parseStep(project, file.buffer, 'step', file.name);
  else if (format === 'iges') {
    try {
      await parseStep(project, file.buffer, 'iges', file.name);
    } catch {
      parseIges(project, text());
    }
  } else if (format === 'acd') await parseAcd(project, file.buffer, env);
  else if (format === 'tags') parseTagTable(project, text());
  else throw rejectUnsupported(`File content does not match a supported project format: ${label}.`, label);
  addSource(project, file, format);
}

function rejectZip(zipName, skipped) {
  if (skipped.length) {
    const file = `${safeName(skipped[0])} inside ${safeName(zipName)}`;
    return rejectUnsupported(`${file} is not a supported project format.`, file);
  }
  const file = safeName(zipName);
  return rejectUnsupported(`${file} does not contain a supported project file.`, file);
}

async function parseUploads(fileList, fields = {}, env = process.env) {
  const project = emptyProject();
  applyFields(project, fields);
  const expanded = [];
  const ignored = [];
  const unpacked = { total: 0 };
  for (const file of fileList) {
    const name = file.originalname || file.name || 'upload';
    const buffer = file.buffer;
    if (!buffer || buffer.length === 0) throw emptyFileError(name);
    const blocked = proprietaryKind(name, buffer);
    if (blocked) throw rejectUnsupported(proprietaryMessage(name, blocked), safeName(name));
    const format = detectFormat(buffer, name);
    if (format === 'zip') {
      const members = unzipSafe(buffer, env, 0, unpacked);
      const usable = [];
      const skipped = [];
      for (const inner of members) {
        if (!inner.buffer || inner.buffer.length === 0) throw emptyFileError(inner.name, name);
        const innerBlocked = proprietaryKind(inner.name, inner.buffer);
        const innerFormat = detectFormat(inner.buffer, inner.name);
        if (innerBlocked || !SUPPORTED.has(innerFormat)) {
          skipped.push(inner.name);
          continue;
        }
        usable.push({ name: inner.name, buffer: inner.buffer, format: innerFormat, container: name });
      }
      if (!usable.length) throw rejectZip(name, skipped);
      expanded.push(...usable);
      continue;
    }
    expanded.push({ name, buffer, format });
  }
  const unique = [];
  const seen = new Set();
  for (const file of expanded) {
    const hash = fileHash(file.buffer);
    if (seen.has(hash)) {
      ignored.push(describeFile(file));
      continue;
    }
    seen.add(hash);
    unique.push(file);
  }
  project.ignoredFiles = ignored;
  if (!unique.length) throw exposed(422, 'No project file was provided.');
  for (const file of unique) await parseOne(project, file, env);
  const usable = project.routines.length || project.tags.length || project.cad.assemblies.length
    || project.cad.titleBlock.length || project.cad.layers.length
    || project.modules.length || project.acdLimited;
  if (!usable) {
    throw exposed(422, 'This file does not contain equipment data that can be read. Export .l5x, SCL or an XML (.xml) block export, structured text, a tag list, or a .step, .iges, .dxf, or .stl model.');
  }
  return project;
}

module.exports = { parseUploads, parseOne, detectFormat };
