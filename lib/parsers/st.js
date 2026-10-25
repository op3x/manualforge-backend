const { addRoutine, upsertTag } = require('../project');
const { humanize } = require('../text');
const { looksLikeAwl, networksOf } = require('./awl');

const IO_SYMBOL = /"((?:IX|QX|IW|QW|IB|QB|ID|QD)_[A-Za-z0-9_]+)"/g;
let activeFilename = '';
let exportAsSclHint = false;

const BLOCK_RE = /\b(PROGRAM|FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK|DATA_BLOCK)\b\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_:]*))([\s\S]*?)\bEND_\1\b/gi;

function blockName(match) {
  return (match[2] || match[3] || 'Block').trim();
}

function headerTitle(body) {
  const header = String(body || '').split(/\b(?:BEGIN|NETWORK)\b/i)[0];
  return ((header.match(/TITLE\s*=\s*(.+)/i) || [])[1] || '').trim();
}

function declarations(body) {
  const regions = [];
  const regionRe = /\b(?:STRUCT|VAR(?:_INPUT|_OUTPUT|_IN_OUT|_TEMP|_GLOBAL)?)\b([\s\S]*?)\bEND_(?:STRUCT|VAR)\b/gi;
  for (const match of String(body || '').matchAll(regionRe)) regions.push(match[1]);
  const members = [];
  for (const region of regions) {
    for (const line of region.split(/\r?\n/)) {
      const decl = line.match(/^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::=\s*([^;]*))?\s*;?\s*(?:\/\/\s*(.*))?$/);
      if (!decl) continue;
      const blockComment = (line.match(/\(\*\s*([\s\S]*?)\s*\*\)/) || [])[1] || '';
      members.push({
        name: decl[1],
        dataType: decl[2],
        initial: (decl[3] || '').trim(),
        comment: (decl[4] || blockComment || '').trim(),
      });
    }
  }
  return members;
}

function applyInitials(body, members) {
  const begin = String(body || '').match(/\bBEGIN\b([\s\S]*)$/i);
  if (!begin) return members;
  const byName = new Map(members.map((member) => [member.name.toLowerCase(), member]));
  for (const line of begin[1].split(/\r?\n/)) {
    const assign = line.match(/^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:=\s*([^;]+);?/);
    if (!assign) continue;
    const member = byName.get(assign[1].toLowerCase());
    if (member && !member.initial) member.initial = assign[2].trim();
  }
  return members;
}

function typePhrase(type) {
  const key = String(type || '').toUpperCase();
  if (key === 'BOOL' || key === 'BOOLEAN') return 'a yes or no value';
  if (['INT', 'DINT', 'SINT', 'USINT', 'UINT', 'UDINT', 'WORD', 'DWORD', 'BYTE'].includes(key)) return 'an integer';
  if (key === 'REAL' || key === 'LREAL') return 'a numeric value';
  if (key === 'TIME' || key.startsWith('S5TIME')) return 'a time value';
  if (key === 'STRING') return 'text';
  return `a ${type || 'stored'} value`;
}

function initialPhrase(type, initial) {
  if (!initial) return '';
  if (/BOOL/i.test(type) && /^FALSE$/i.test(initial)) return ' The initial value is off.';
  if (/BOOL/i.test(type) && /^TRUE$/i.test(initial)) return ' The initial value is on.';
  return ` The initial value is ${initial}.`;
}

function addDataBlock(project, name, body) {
  const members = applyInitials(body, declarations(body));
  for (const member of members) {
    upsertTag(project, {
      name: member.name,
      dataType: member.dataType,
      description: member.comment,
      scope: name,
    });
  }
  const units = members.map((member, index) => {
    const label = member.comment || humanize(member.name) || 'The value';
    const summary = `${label} is ${typePhrase(member.dataType)} stored in this data block.${initialPhrase(member.dataType, member.initial)}`;
    return {
      index,
      number: index + 1,
      kind: 'statement',
      text: `${member.name} : ${member.dataType}${member.initial ? ` := ${member.initial}` : ''}`,
      comment: member.comment,
      summary,
    };
  });
  if (!units.length) {
    const summary = gapSummary('members');
    units.push({
      index: 0,
      number: 1,
      kind: 'statement',
      text: summary,
      comment: '',
      summary,
      unread: true,
    });
  }
  if (!project.programs.includes(name)) project.programs.push(name);
  addRoutine(project, {
    name,
    type: 'DATA_BLOCK',
    program: name,
    comment: headerTitle(body),
    units,
    language: 'db',
    unreadReason: units.every((unit) => unit.unread) ? `${units[0].summary}${exportHint('members')}` : '',
  });
}

function codeOf(body) {
  return String(body || '')
    .replace(/\bVAR(?:_INPUT|_OUTPUT|_IN_OUT|_TEMP|_GLOBAL)?\b[\s\S]*?\bEND_VAR\b/gi, '')
    .replace(/\bSTRUCT\b[\s\S]*?\bEND_STRUCT\b/gi, '')
    .replace(/^\s*BEGIN\b/i, '')
    .trim();
}

function statementUnits(code) {
  const chunks = code.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  return (chunks.length ? chunks : [code]).filter(Boolean).map((chunk, index) => ({
    index,
    number: index,
    kind: 'statement',
    text: chunk.replace(/\(\*[\s\S]*?\*\)/g, '').trim(),
    comment: ((chunk.match(/\(\*\s*([\s\S]*?)\s*\*\)/) || [])[1] || '').trim(),
  }));
}

function addLogicBlock(project, kind, name, body) {
  const code = codeOf(body);
  const awl = looksLikeAwl(code) || /^\s*NETWORK\b/im.test(code) || /^\s*Network\s+\d+/m.test(code);
  const units = awl ? networksOf(code) : statementUnits(code);
  if (!units.length) {
    const summary = gapSummary('routine');
    units.push({
      index: 0,
      number: 1,
      kind: 'network',
      text: summary,
      comment: '',
      summary,
      unread: true,
    });
  }
  if (!project.programs.includes(name)) project.programs.push(name);
  addRoutine(project, {
    name,
    type: kind,
    program: name,
    comment: headerTitle(body),
    units,
    language: awl ? 'awl' : 'st',
    unreadReason: units.every((unit) => unit.unread) ? `${units[0].summary}${exportHint('routine')}` : '',
  });
}

function fileRoutineName(filename) {
  const base = String(filename || 'StatementList').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_');
  return base || 'StatementList';
}

function gapSummary(kind) {
  const scl = /\.scl$/i.test(activeFilename);
  if (kind === 'members') {
    return scl
      ? 'This data block names a type and does not repeat its members in this SCL source.'
      : 'This data block did not contain any members.';
  }
  return 'This routine did not contain any networks or statements.';
}

function exportHint(kind) {
  if (/\.scl$/i.test(activeFilename) || exportAsSclHint) return '';
  exportAsSclHint = true;
  if (kind === 'members') return ' Export the block again as SCL or as a DATA_BLOCK source.';
  return ' Export the block again as SCL or as STL with one NETWORK per rung.';
}

function ioDataType(name) {
  const prefix = String(name || '').slice(0, 2).toUpperCase();
  if (prefix === 'IX' || prefix === 'QX') return 'BOOL';
  if (prefix === 'IW' || prefix === 'QW') return 'WORD';
  if (prefix === 'IB' || prefix === 'QB') return 'BYTE';
  if (prefix === 'ID' || prefix === 'QD') return 'DWORD';
  return '';
}

function ioDescription(name) {
  const words = String(name || '').split('_').filter(Boolean);
  const station = words.length > 1 && /^(MPO|VGR|HBW|SLD|SSC)$/i.test(words[1]) ? words[1].toUpperCase() : '';
  const kept = words.filter((word, index) => {
    if (index === 0 && /^(IX|QX|IW|QW|IB|QB|ID|QD)$/i.test(word)) return false;
    if (station && index === 1 && word.toUpperCase() === station) return false;
    if (/^[IQAB]\d+$/i.test(word)) return false;
    if (/^M\d+$/i.test(word)) return false;
    return true;
  });
  const text = kept.join(' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return text || humanize(name) || name;
}

function collectIoSymbols(project, source) {
  const seen = new Set();
  IO_SYMBOL.lastIndex = 0;
  for (const match of String(source || '').matchAll(IO_SYMBOL)) {
    const name = match[1];
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    upsertTag(project, {
      name,
      dataType: ioDataType(name),
      description: ioDescription(name),
      direction: /^Q/i.test(name) ? 'output' : 'input',
    });
  }
}

function parseSt(project, text, filename = '') {
  activeFilename = filename || '';
  exportAsSclHint = false;
  const source = String(text || '');
  BLOCK_RE.lastIndex = 0;
  let found = false;
  for (const match of source.matchAll(BLOCK_RE)) {
    found = true;
    const kind = match[1].toUpperCase();
    const name = blockName(match);
    const body = match[4] || '';
    if (kind === 'DATA_BLOCK') addDataBlock(project, name, body);
    else addLogicBlock(project, kind, name, body);
  }
  if (!found && looksLikeAwl(source)) {
    const name = fileRoutineName(filename);
    if (!project.programs.includes(name)) project.programs.push(name);
    addRoutine(project, {
      name,
      type: 'STL',
      program: name,
      comment: '',
      units: networksOf(source),
      language: 'awl',
    });
    found = true;
  }
  if (found) collectIoSymbols(project, source);
  if (!found) {
    const err = new Error('no st block');
    err.status = 422;
    err.expose = true;
    err.message = 'This structured-text file does not contain a PROGRAM, FUNCTION, FUNCTION_BLOCK, ORGANIZATION_BLOCK, or DATA_BLOCK. For statement list, export STL or AWL with a NETWORK for each rung.';
    throw err;
  }
  return project;
}

module.exports = { parseSt };
