const { decodeBuffer } = require('../text');
const { isZip } = require('./zip');

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

function detectFormat(buffer, filename = '') {
  if (!buffer || !buffer.length) return 'unknown';
  if (isExecutable(buffer)) return 'executable';
  const ext = extensionOf(filename);
  const text = headText(buffer);
  const sample = text.slice(0, 6000);
  if (isZip(buffer)) {
    if (ext === 'xlsx' || /xl\/workbook/i.test(sample) || ext === 'xls') return 'xlsx';
    return 'zip';
  }
  if (/^\s*ISO-10303-21/i.test(sample)) return 'step';
  if (/\bCONTROLLER\b/.test(sample)) {
    const more = decodeBuffer(buffer.subarray(0, Math.min(buffer.length, 250000)));
    if (/\b(PROGRAM|ROUTINE|END_CONTROLLER|ADD_ON_INSTRUCTION_DEFINITION)\b/.test(more)) return 'l5k';
  }
  if (/<TcPlcObject|<POU[\s>]/i.test(sample)) return 'tcpou';
  if (/RSLogix5000Content|<Controller[\s>]/i.test(sample)) return 'l5x';
  if (/plcopen\.org|<pou[\s>]/i.test(sample) || /<project[\s>]/i.test(sample) && /<pous[\s>]/i.test(text.slice(0, 20000))) return 'plcopen';
  if (/^\s*0\s*(?:\r?\n)\s*SECTION/i.test(sample) || /^\s*999\s*(?:\r?\n)/.test(sample)) return 'dxf';
  if (/^[\s\S]{0,80}.{0,72}S\s+\d+/m.test(text.slice(0, 500)) && /\n.{72}G/m.test(text.slice(0, 2000))) return 'iges';
  if (/\b(PROGRAM|FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\b/i.test(sample) && /\b(VAR|END_VAR|END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION)\b/i.test(text.slice(0, 12000))) {
    return 'st';
  }
  if (/^\s*<\?xml/i.test(sample) || /^\s*</.test(sample.trim())) {
    if (/RSLogix5000Content|<Controller[\s>]/i.test(text.slice(0, 20000))) return 'l5x';
    if (/plcopen|<pou[\s>]/i.test(text.slice(0, 20000))) return 'plcopen';
    if (/<TcPlcObject|<POU[\s>]/i.test(text.slice(0, 20000))) return 'tcpou';
    if (/<Tagtable[\s>]|<Tag\s+[^>]*type=/i.test(text.slice(0, 20000))) return 'tags';
    return 'xml';
  }
  const firstLine = sample.split(/\r?\n/).find((line) => line.trim()) || '';
  if (/,/.test(firstLine) && /tag|address|description|name|symbol/i.test(firstLine)) return 'csv';
  if (ext === 'acd') return 'acd';
  if (['st', 'scl', 'exp'].includes(ext) && /[A-Za-z]/.test(sample)) return 'st';
  if (ext === 'csv') return 'csv';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  return 'unknown';
}

module.exports = { detectFormat, isExecutable, extensionOf };
