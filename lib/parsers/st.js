const { addRoutine, upsertTag } = require('../project');
const { humanize } = require('../text');
const { looksLikeAwl, networksOf } = require('./awl');

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
    const summary = 'This data block did not contain any members. Export the block again as SCL or as a DATA_BLOCK source.';
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
    unreadReason: units.every((unit) => unit.unread) ? units[0].summary : '',
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
    const summary = 'This routine did not contain any networks or statements. Export the block again as SCL or as STL with one NETWORK per rung.';
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
  });
}

function fileRoutineName(filename) {
  const base = String(filename || 'StatementList').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_');
  return base || 'StatementList';
}

function parseSt(project, text, filename = '') {
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
