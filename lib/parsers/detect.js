const { decodeBuffer, safeName } = require('../text');
const { isZip } = require('./zip');
const { isBinaryDxf } = require('./dxf');
const { isAsciiStl, isBinaryStl, mostlyText } = require('./mesh-stl');
const { looksLikeAwl } = require('./awl');

function headText(buffer, length = 8000) {
  return decodeBuffer(buffer.subarray(0, Math.min(buffer.length, length)));
}

function isExecutable(buffer) {
  if (buffer.length > 4 && buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return true;
  if (buffer.length > 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return true;
  return false;
}

function extensionOf(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function isDwg(buffer) {
  if (!buffer || buffer.length < 6) return false;
  const head = buffer.slice(0, 6).toString('latin1');
  if (!/^AC10\d\d$/.test(head)) return false;
  let nuls = 0;
  for (let i = 0; i < Math.min(buffer.length, 200); i += 1) if (buffer[i] === 0) nuls += 1;
  return nuls > 0;
}

function proprietaryKind(filename, buffer) {
  const ext = extensionOf(filename);
  if (/^zap\d*$/.test(ext) || /^ap\d*$/.test(ext) || ext === 's7p') return 'siemens-project';
  const known = new Set(['l5x', 'xml', 'l5k', 'st', 'scl', 'exp', 'acd', 'dxf', 'step', 'stp', 'iges', 'igs', 'csv', 'xlsx', 'xls', 'zip', 'stl', 'awl', 'db', 'tcpou']);
  if (ext === 'dwg' || (isDwg(buffer) && !known.has(ext))) return 'dwg';
  if (ext === 'sldprt' || ext === 'sldasm' || ext === 'slddrw') return 'solidworks';
  return '';
}

function proprietaryMessage(name, kind) {
  const label = safeName(name);
  if (kind === 'siemens-project') {
    return `${label} is a project archive (.zap, .ap, or .s7p). This service cannot open that archive. Export the blocks as SCL or as an XML (.xml) block export, then upload the .scl or .xml file.`;
  }
  if (kind === 'dwg') {
    return `${label} is a .dwg drawing. This service does not read .dwg. Save the drawing as .dxf, then upload the .dxf file.`;
  }
  if (kind === 'solidworks') {
    const ext = extensionOf(name);
    const what = ext === 'sldasm' ? 'assembly' : ext === 'slddrw' ? 'drawing' : 'part';
    const drawing = ext === 'slddrw' ? ' For the drawing sheet, you can also save it as .dxf.' : '';
    return `${label} is a native ${what} file (.${ext}). This service does not read that file. Save it as .step, then upload the .step or .stp file.${drawing}`;
  }
  return '';
}

function looksLikeTia(text) {
  return /<SW\.Blocks\./.test(text) || /siemens\.com\/automation\/Openness/.test(text);
}

function detectFormat(buffer, filename = '') {
  if (!buffer || !buffer.length) return 'unknown';
  if (isExecutable(buffer)) return 'executable';
  const ext = extensionOf(filename);
  const blocked = proprietaryKind(filename, buffer);
  if (blocked) return blocked;
  if (ext === 'acd') return 'acd';
  if (isBinaryDxf(buffer)) return 'dxf';
  if (isZip(buffer)) {
    const head = buffer.subarray(0, Math.min(buffer.length, 8000)).toString('latin1');
    const tail = buffer.subarray(Math.max(0, buffer.length - 65536)).toString('latin1');
    if (ext === 'xlsx' || ext === 'xls' || /xl\/workbook/i.test(head) || /xl\/workbook/i.test(tail)) return 'xlsx';
    return 'zip';
  }
  const text = headText(buffer);
  const sample = text.slice(0, 6000);
  const wider = text.slice(0, 20000);
  if (isAsciiStl(sample) && mostlyText(buffer)) return 'stl';
  if (ext === 'stl' && !mostlyText(buffer) && isBinaryStl(buffer)) return 'stl';
  if (/^\s*ISO-10303-21/i.test(sample)) return 'step';
  if (/\bCONTROLLER\b/.test(sample)) {
    const more = decodeBuffer(buffer.subarray(0, Math.min(buffer.length, 250000)));
    if (/\b(PROGRAM|ROUTINE|END_CONTROLLER|ADD_ON_INSTRUCTION_DEFINITION)\b/.test(more)) return 'l5k';
  }
  if (looksLikeTia(sample) || looksLikeTia(wider)) return 'tia';
  if (/<TcPlcObject|<POU[\s>]/i.test(sample)) return 'tcpou';
  if (/RSLogix5000Content|<Controller[\s>]/i.test(sample)) return 'l5x';
  if (/plcopen\.org|<pou[\s>]/i.test(sample) || /<project[\s>]/i.test(sample) && /<pous[\s>]/i.test(wider)) return 'plcopen';
  if (/^\s*0\s*(?:\r?\n)\s*SECTION/i.test(sample) || /^\s*999\s*(?:\r?\n)/.test(sample)) return 'dxf';
  if (/^[\s\S]{0,80}.{0,72}S\s+\d+/m.test(text.slice(0, 500)) && /\n.{72}G/m.test(text.slice(0, 2000))) return 'iges';
  if (looksLikeAwl(wider)) return 'awl';
  if (/\bDATA_BLOCK\b/i.test(sample) && /\bEND_DATA_BLOCK\b/i.test(wider)) return 'st';
  if (/\b(PROGRAM|FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\b/i.test(sample) && /\b(VAR|END_VAR|END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION|END_ORGANIZATION_BLOCK|NETWORK)\b/i.test(wider)) {
    return looksLikeAwl(wider) ? 'awl' : 'st';
  }
  if (/^\s*<\?xml/i.test(sample) || /^\s*</.test(sample.trim())) {
    if (looksLikeTia(wider)) return 'tia';
    if (/RSLogix5000Content|<Controller[\s>]/i.test(wider)) return 'l5x';
    if (/plcopen|<pou[\s>]/i.test(wider)) return 'plcopen';
    if (/<TcPlcObject|<POU[\s>]/i.test(wider)) return 'tcpou';
    if (/<Tagtable[\s>]|<Tag\s+[^>]*type=/i.test(wider)) return 'tags';
    return 'xml';
  }
  const firstLine = sample.split(/\r?\n/).find((line) => line.trim()) || '';
  if (/,/.test(firstLine) && /tag|address|description|name|symbol/i.test(firstLine)) return 'csv';
  if (ext === 'db') return 'st';
  if (ext === 'awl') return 'awl';
  if (ext === 'stl' && isBinaryStl(buffer)) return 'stl';
  if (['st', 'scl', 'exp'].includes(ext) && /[A-Za-z]/.test(sample)) return 'st';
  if (ext === 'csv') return 'csv';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  return 'unknown';
}

module.exports = {
  detectFormat,
  isExecutable,
  extensionOf,
  proprietaryKind,
  proprietaryMessage,
};
