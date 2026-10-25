const XLSX = require('xlsx');
const { upsertTag } = require('../project');

const HEADER_MAP = [
  ['name', /^(tag|tagname|tag name|name|symbol|variable)$/i],
  ['description', /^(description|desc|comment|text)$/i],
  ['dataType', /^(datatype|data type|type)$/i],
  ['address', /^(address|addr|io address|i\/o address|specifier|alias for)$/i],
  ['direction', /^(direction|dir|io|i\/o|in\/out)$/i],
  ['device', /^(device|module|equipment)$/i],
];

function classifyHeader(cell) {
  const text = String(cell || '').trim();
  for (const [key, pattern] of HEADER_MAP) {
    if (pattern.test(text)) return key;
  }
  return '';
}

function rowsFromMatrix(matrix) {
  const headerRow = matrix.findIndex((row) => row.some((cell) => classifyHeader(cell)));
  if (headerRow < 0) return [];
  const columns = matrix[headerRow].map(classifyHeader);
  const tags = [];
  for (const row of matrix.slice(headerRow + 1)) {
    const tag = {};
    columns.forEach((key, index) => {
      if (key && row[index] != null && String(row[index]).trim()) tag[key] = String(row[index]).trim();
    });
    if (tag.name) tags.push(tag);
  }
  return tags;
}

function delimiterOf(text) {
  const lines = String(text || '').split(/\r?\n/).filter((item) => item.trim() && !item.trim().startsWith('//')).slice(0, 8);
  let commas = 0;
  let semis = 0;
  for (const line of lines) {
    commas += (line.match(/,/g) || []).length;
    semis += (line.match(/;/g) || []).length;
  }
  return semis > commas ? ';' : ',';
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  const delimiter = delimiterOf(source);
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch !== '\r') cell += ch;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function rowsFromBare(matrix) {
  const tags = [];
  for (const row of matrix) {
    if (!row || row.length < 3) continue;
    if (!/^\d+$/.test(String(row[0] || '').trim())) continue;
    const path = String(row[2] || row[1] || '').trim();
    const name = path.split('.').filter(Boolean).pop();
    if (!name || /^PLC\d*$/i.test(name)) continue;
    const dataType = String(row[4] || row[3] || '').trim();
    tags.push({
      name,
      dataType,
      description: name.replace(/_/g, ' ').toLowerCase(),
      address: path,
    });
  }
  return tags;
}

function applyTags(project, tags) {
  if (!tags.length) {
    const err = new Error('no tags');
    err.status = 422;
    err.expose = true;
    err.message = 'This spreadsheet does not have a tag or name column. Include a header row with Tag and Description.';
    throw err;
  }
  for (const tag of tags) upsertTag(project, tag);
}

function parseTagTable(project, xml) {
  const { parseXml, attr, textOf } = require('./xml');
  const tree = parseXml(xml);
  const tags = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const tag of [].concat(node.Tag || [])) {
      if (!tag || typeof tag !== 'object') continue;
      const name = textOf(tag).split(/\s+/).pop();
      if (!name) continue;
      tags.push({
        name,
        dataType: attr(tag, 'type'),
        description: attr(tag, 'remark'),
        address: attr(tag, 'addr'),
      });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'Tag' || key.startsWith('@_')) continue;
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(tree);
  applyTags(project, tags);
  return project;
}

function parseCsvProject(project, text) {
  const matrix = parseCsv(text);
  const tags = rowsFromMatrix(matrix);
  applyTags(project, tags.length ? tags : rowsFromBare(matrix));
  return project;
}

function parseXlsxProject(project, buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, dense: true });
  } catch {
    const err = new Error('bad xlsx');
    err.status = 422;
    err.expose = true;
    err.message = 'This spreadsheet could not be read. Upload an .xlsx tag list or a CSV file.';
    throw err;
  }
  const tags = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    tags.push(...rowsFromMatrix(matrix));
  }
  applyTags(project, tags);
  return project;
}

module.exports = { parseCsv, parseCsvProject, parseXlsxProject, parseTagTable, rowsFromMatrix };
