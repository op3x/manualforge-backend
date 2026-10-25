const { XMLParser } = require('fast-xml-parser');
const { exposed } = require('../errors');
const { assertNoDtd } = require('./xml');
const { decodeXmlEntities, humanize } = require('../text');
const { addRoutine, upsertTag } = require('../project');
const { describeInstructions, parseLine } = require('./awl');

function parseOrdered(xml) {
  assertNoDtd(xml);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    removeNSPrefix: true,
    processEntities: false,
    htmlEntities: false,
    trimValues: true,
    cdataPropName: '__cdata',
  });
  try {
    return parser.parse(xml);
  } catch {
    throw exposed(400, 'This XML file could not be parsed. Export the block again as an XML (.xml) block export.');
  }
}

function kids(node) {
  if (!node || typeof node !== 'object') return { name: '', attrs: {}, list: [] };
  const name = Object.keys(node).find((key) => key !== ':@' && key !== '#text' && key !== '__cdata');
  if (!name) return { name: '#text', attrs: node[':@'] || {}, list: [] };
  const list = node[name];
  return { name, attrs: node[':@'] || {}, list: Array.isArray(list) ? list : [] };
}

function attrOf(node, name) {
  const value = (node && node[':@'] ? node[':@'] : {})[`@_${name}`];
  return value == null ? '' : decodeXmlEntities(String(value));
}

function textContent(node) {
  const { list } = kids(node);
  let out = '';
  for (const child of list) {
    if (child && typeof child['#text'] === 'string') out += child['#text'];
    else if (child && typeof child.__cdata === 'string') out += child.__cdata;
    else out += textContent(child);
  }
  return decodeXmlEntities(out).trim();
}

function walk(nodes, visit) {
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') continue;
    if (typeof node['#text'] === 'string' && Object.keys(node).length === 1) continue;
    const info = kids(node);
    if (!info.name || info.name === '#text') continue;
    visit(info, node);
    walk(info.list, visit);
  }
}

function firstChild(node, name) {
  if (!node) return null;
  for (const child of kids(node).list) {
    if (kids(child).name === name) return child;
  }
  return null;
}

function childrenNamed(node, name) {
  if (!node) return [];
  return kids(node).list.filter((child) => kids(child).name === name);
}

function textOfField(node, name) {
  const child = firstChild(node, name);
  return child ? textContent(child) : '';
}

function firstDescendant(node, name) {
  let found = null;
  walk(node ? [node] : [], (info, current) => {
    if (!found && info.name === name) found = current;
  });
  return found;
}

function deepText(node, name) {
  let found = '';
  walk(node ? [node] : [], (info, current) => {
    if (info.name === name) {
      const text = textContent(current);
      if (text) found = text;
    }
  });
  return found;
}

function compositionText(objectList, composition) {
  let found = '';
  for (const node of childrenNamed(objectList, 'MultilingualText')) {
    if (attrOf(node, 'CompositionName') !== composition) continue;
    walk(kids(node).list, (info, current) => {
      if (info.name !== 'MultilingualTextItem') return;
      const culture = deepText(current, 'Culture');
      const text = deepText(current, 'Text');
      if (text && (!found || /en/i.test(culture))) found = text;
    });
  }
  return found;
}

function memberComment(node) {
  let found = '';
  walk(kids(node).list, (info, current) => {
    if (info.name !== 'MultiLanguageText' && info.name !== 'MultilingualTextItem') return;
    const lang = attrOf(current, 'Lang') || deepText(current, 'Culture');
    const text = textContent(current) || deepText(current, 'Text');
    if (text && (!found || /en/i.test(lang))) found = text;
  });
  return found;
}

function interfaceMembers(attrList) {
  const iface = firstChild(attrList, 'Interface');
  if (!iface) return [];
  const members = [];
  walk(kids(iface).list, (info, node) => {
    if (info.name !== 'Member') return;
    const name = attrOf(node, 'Name');
    if (!name) return;
    members.push({
      name,
      dataType: attrOf(node, 'Datatype') || attrOf(node, 'DataType'),
      comment: memberComment(node),
      initial: deepText(node, 'StartValue'),
    });
  });
  return members;
}

function typePhrase(type) {
  const key = String(type || '').toUpperCase();
  if (key === 'BOOL' || key === 'BOOLEAN') return 'a yes or no value';
  if (['INT', 'DINT', 'SINT', 'USINT', 'UINT', 'UDINT', 'WORD', 'DWORD', 'BYTE'].includes(key)) return 'an integer';
  if (key === 'REAL' || key === 'LREAL' || key === 'FLOAT') return 'a numeric value';
  if (key === 'TIME' || key.startsWith('S5TIME')) return 'a time value';
  if (key === 'STRING') return 'text';
  return `a ${type || 'stored'} value`;
}

function initialPhrase(type, initial) {
  if (!initial) return '';
  if (/^BOOL|BOOLEAN$/i.test(type)) {
    if (/^true$/i.test(initial)) return ' The initial value is on.';
    if (/^false$/i.test(initial)) return ' The initial value is off.';
  }
  return ` The initial value is ${initial}.`;
}

function memberUnit(member, index) {
  const label = member.comment || humanize(member.name) || 'The value';
  const summary = `${label} is ${typePhrase(member.dataType)} stored in this data block.${initialPhrase(member.dataType, member.initial)}`;
  return {
    index,
    number: index + 1,
    kind: 'statement',
    text: `${member.name} : ${member.dataType || 'ANY'}${member.initial ? ` := ${member.initial}` : ''}`,
    comment: member.comment || '',
    summary,
  };
}

function languageName(language) {
  const key = String(language || '').toUpperCase();
  if (key === 'LAD') return 'ladder';
  if (key === 'FBD') return 'function-block';
  if (key === 'SCL') return 'structured-text';
  if (key === 'GRAPH') return 'GRAPH sequence';
  if (key === 'STL' || key === 'AWL') return 'statement-list';
  if (key === 'DB') return 'data-block';
  return 'TIA';
}

function unreadUnit(index, language, note) {
  const summary = `This ${languageName(language)} network could not be read from the XML block export${note ? ` (${note})` : ''}. Export the block again as an XML (.xml) block export or as SCL source.`;
  return {
    index,
    number: index + 1,
    kind: 'network',
    text: summary,
    comment: note || '',
    summary,
    unread: true,
  };
}

function symbolOf(access) {
  const names = [];
  walk(kids(access).list, (info, node) => {
    if (info.name === 'Component') {
      const name = attrOf(node, 'Name');
      if (name) names.push(name);
    }
  });
  return names.join('.');
}

function negated(part) {
  if (/^(?:true|1)$/i.test(attrOf(part, 'Negated'))) return true;
  return kids(part).list.some((child) => kids(child).name === 'Negated');
}

function wireLinks(node) {
  const links = [];
  let power = false;
  for (const child of kids(node).list) {
    const info = kids(child);
    if (info.name === 'Powerrail') power = true;
    if (info.name === 'NameCon') links.push({ uid: attrOf(child, 'UId'), pin: attrOf(child, 'Name') || '' });
    if (info.name === 'IdentCon') links.push({ uid: attrOf(child, 'UId'), ident: true });
  }
  return { power, links };
}

function flgModel(flg) {
  const parts = [];
  const accesses = [];
  const wires = [];
  walk(kids(flg).list, (info, node) => {
    if (info.name === 'Part') parts.push(node);
    else if (info.name === 'Access') accesses.push(node);
    else if (info.name === 'Wire') wires.push(node);
  });
  const accessById = new Map(accesses.map((node) => [attrOf(node, 'UId'), node]));
  const partById = new Map(parts.map((node) => [attrOf(node, 'UId'), node]));
  const pinsOf = new Map();
  const edges = [];
  const powered = [];
  for (const wire of wires) {
    const { power, links } = wireLinks(wire);
    const pins = links.filter((link) => !link.ident);
    const idents = links.filter((link) => link.ident);
    for (const ident of idents) {
      const access = accessById.get(ident.uid);
      const symbol = access ? symbolOf(access) : '';
      if (!symbol) continue;
      for (const pin of pins) {
        const bucket = pinsOf.get(pin.uid) || {};
        bucket[pin.pin || 'operand'] = symbol;
        pinsOf.set(pin.uid, bucket);
      }
    }
    if (power) {
      for (const pin of pins) powered.push(pin.uid);
    }
    for (let i = 0; i < pins.length; i += 1) {
      for (let j = i + 1; j < pins.length; j += 1) edges.push([pins[i], pins[j]]);
    }
  }
  return { parts, partById, pinsOf, edges, powered };
}

function followers(model, uid, pin) {
  const next = [];
  for (const [left, right] of model.edges) {
    if (left.uid === uid && left.pin === pin) next.push(right);
    if (right.uid === uid && right.pin === pin) next.push(left);
  }
  return next;
}

function signalLabel(symbol) {
  return humanize(symbol) || String(symbol || '').replace(/[_.]+/g, ' ') || 'the signal';
}

function describeLadder(model) {
  const conditions = [];
  const results = [];
  const seen = new Set();
  let current = [...model.powered];
  let guard = 0;
  while (current.length && guard < 40) {
    guard += 1;
    const next = [];
    for (const uid of current) {
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      const part = model.partById.get(uid);
      if (!part) continue;
      const name = attrOf(part, 'Name');
      const pins = model.pinsOf.get(uid) || {};
      const signal = signalLabel(pins.operand || '');
      if (/^Contact$/i.test(name)) {
        conditions.push(negated(part) ? `${signal} is off` : `${signal} is on`);
        for (const hop of followers(model, uid, 'out')) next.push(hop.uid);
      } else if (/Coil/i.test(name)) {
        const verb = /SCoil|^S$/i.test(name) ? 'sets' : /RCoil|^R$/i.test(name) ? 'resets' : 'turns on';
        results.push(`${verb} ${signalLabel(pins.operand || '')}`);
      } else if (/^O$/i.test(name)) {
        const inputs = Object.entries(pins)
          .filter(([pin]) => pin !== 'out')
          .map(([, symbol]) => `${signalLabel(symbol)} is on`);
        if (inputs.length) conditions.push(`(${inputs.join(' or ')})`);
        for (const hop of followers(model, uid, 'out')) next.push(hop.uid);
      } else {
        for (const hop of followers(model, uid, 'out')) next.push(hop.uid);
      }
    }
    current = next;
  }
  if (conditions.length && results.length) return `When ${conditions.join(' and ')}, the control ${results.join(' and ')}.`;
  if (results.length) return `The control ${results.join(' and ')}.`;
  if (conditions.length) return `This network checks that ${conditions.join(' and ')}.`;
  return '';
}

function describeFbd(model) {
  const boxes = [];
  const inputs = [];
  const outputs = [];
  for (const part of model.parts) {
    const name = attrOf(part, 'Name') || 'block';
    boxes.push(name);
    const pins = model.pinsOf.get(attrOf(part, 'UId')) || {};
    for (const [pin, symbol] of Object.entries(pins)) {
      const label = signalLabel(symbol);
      if (pin === 'out' || pin === 'eno') outputs.push(label);
      else inputs.push(label);
    }
  }
  if (!boxes.length) return '';
  const inputText = [...new Set(inputs)].join(' and ') || 'its inputs';
  const outputText = [...new Set(outputs)].join(' and ') || 'its outputs';
  return `This function-block network uses ${boxes.join(', ')}. It reads ${inputText} and writes ${outputText}.`;
}

function structuredText(node) {
  let out = '';
  for (const child of kids(node).list) {
    const info = kids(child);
    if (info.name === 'Token') out += attrOf(child, 'Text') || textContent(child);
    else if (info.name === 'Blank') out += ' ';
    else if (info.name === 'NewLine' || info.name === 'LineBreak') out += '\n';
    else if (info.name === 'Access') out += symbolOf(child);
    else if (info.name === 'Line') out += `${textContent(child)}\n`;
    else if (info.name !== 'Text') out += structuredText(child);
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function statementList(node) {
  const lines = [];
  walk(kids(node).list, (info, current) => {
    if (info.name !== 'StlStatement' && info.name !== 'Statement') return;
    const tokens = [];
    for (const child of kids(current).list) {
      const childInfo = kids(child);
      if (childInfo.name === 'StlToken' || childInfo.name === 'Token') tokens.push(attrOf(child, 'Text') || textContent(child));
      else if (childInfo.name === 'Access') tokens.push(`"${symbolOf(child)}"`);
      else if (childInfo.name === 'Blank') tokens.push(' ');
    }
    const line = tokens.join('').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  });
  return lines;
}

function plainNote(note) {
  const text = String(note || '').replace(/\s+/g, ' ').trim();
  return text.length >= 8 ? text : '';
}

function ladUnit(flg, note, index) {
  const summary = describeLadder(flgModel(flg));
  if (!summary) return unreadUnit(index, 'LAD', note);
  return {
    index,
    number: index + 1,
    kind: 'network',
    text: summary,
    comment: plainNote(note),
    summary,
  };
}

function fbdUnit(flg, note, index) {
  const model = flgModel(flg);
  const summary = describeFbd(model);
  if (!summary) return unreadUnit(index, 'FBD', note);
  return {
    index,
    number: index + 1,
    kind: 'network',
    text: model.parts.map((part) => attrOf(part, 'Name')).filter(Boolean).join(' '),
    comment: plainNote(note),
    summary,
  };
}

function graphUnits(graph) {
  const steps = [];
  const transitions = [];
  walk(kids(graph).list, (info, node) => {
    if (info.name === 'Step') steps.push(node);
    else if (info.name === 'Transition') transitions.push(node);
  });
  const units = [];
  steps.forEach((step, index) => {
    const number = attrOf(step, 'Number') || String(index + 1);
    const name = attrOf(step, 'Name') || `Step ${number}`;
    const actions = [];
    walk(kids(step).list, (info, node) => {
      if (info.name !== 'Action') return;
      const qualifier = (attrOf(node, 'Qualifier') || 'N').toUpperCase();
      const target = signalLabel(structuredText(node) || textContent(node));
      if (!target) return;
      const verb = qualifier === 'S' ? 'sets' : qualifier === 'R' || qualifier === 'D' ? 'resets' : 'turns on';
      actions.push(`${verb} ${target}`);
    });
    const summary = actions.length
      ? `Step ${number} (${signalLabel(name)}) is active in the sequence. While it is active the control ${actions.join(' and ')}.`
      : `Step ${number} (${signalLabel(name)}) is active in the sequence and takes no action.`;
    units.push({
      index: units.length,
      number: Number(number) || index + 1,
      kind: 'step',
      text: `Step ${number} ${name}`,
      comment: signalLabel(name),
      summary,
    });
  });
  transitions.forEach((transition, index) => {
    const number = attrOf(transition, 'Number') || String(index + 1);
    const flg = firstDescendant(transition, 'FlgNet');
    const code = firstDescendant(transition, 'StructuredText');
    let clause = '';
    if (flg) clause = describeLadder(flgModel(flg));
    else if (code) clause = structuredText(code);
    const check = String(clause || '').match(/^This network checks that (.+)\.$/i);
    const when = String(clause || '').match(/^When (.+?), the control /i);
    const condition = (check && check[1]) || (when && when[1]) || String(clause || '').replace(/\.$/, '');
    const summary = condition
      ? `The sequence advances at transition ${number} when ${condition}.`
      : `Transition ${number} is in the sequence, but its condition could not be read.`;
    units.push({
      index: units.length,
      number: Number(number) || index + 1,
      kind: 'transition',
      text: condition || `Transition ${number}`,
      comment: `Transition ${number}`,
      summary,
      unread: !condition,
    });
  });
  return units;
}

function compileUnits(node, blockLanguage) {
  const attrList = firstChild(node, 'AttributeList');
  const language = (textOfField(attrList, 'ProgrammingLanguage') || blockLanguage || 'LAD').toUpperCase();
  const objectList = firstChild(node, 'ObjectList');
  const note = [compositionText(objectList, 'Title'), compositionText(objectList, 'Comment')].filter(Boolean).join('. ');
  const source = firstChild(attrList, 'NetworkSource');
  if (!source) return [unreadUnit(0, language, note)];
  const graph = firstDescendant(source, 'Graph');
  if (graph || language === 'GRAPH') {
    const units = graph ? graphUnits(graph) : [];
    return units.length ? units : [unreadUnit(0, 'GRAPH', note)];
  }
  const statements = firstDescendant(source, 'StatementList');
  if (statements || language === 'STL' || language === 'AWL') {
    const lines = statements ? statementList(statements) : [];
    const instructions = lines.map(parseLine).filter(Boolean);
    if (!instructions.length) return [unreadUnit(0, language, note)];
    const summary = describeInstructions(instructions);
    return [{
      index: 0,
      number: 1,
      kind: 'network',
      text: lines.join('\n'),
      comment: plainNote(note),
      summary,
    }];
  }
  const flg = firstDescendant(source, 'FlgNet');
  if (flg && language !== 'SCL') {
    return [language === 'FBD' ? fbdUnit(flg, note, 0) : ladUnit(flg, note, 0)];
  }
  const structured = firstDescendant(source, 'StructuredText');
  if (structured || language === 'SCL') {
    const code = structured ? structuredText(structured) : '';
    if (!code) return [unreadUnit(0, 'SCL', note)];
    return [{
      index: 0,
      number: 1,
      kind: 'statement',
      text: code,
      comment: plainNote(note),
      summary: '',
    }];
  }
  return [unreadUnit(0, language, note)];
}

const BLOCK_NAME = /^SW\.Blocks\.(FB|FC|OB|GlobalDB|InstanceDB|DB|ArrayDB)$/;

function addBlock(project, blockNode) {
  const attrList = firstChild(blockNode, 'AttributeList');
  const name = textOfField(attrList, 'Name') || 'Block';
  const language = (textOfField(attrList, 'ProgrammingLanguage') || 'LAD').toUpperCase();
  const objectList = firstChild(blockNode, 'ObjectList');
  const comment = compositionText(objectList, 'Comment');
  const members = interfaceMembers(attrList);
  for (const member of members) {
    upsertTag(project, {
      name: member.name,
      dataType: member.dataType,
      description: member.comment,
      scope: name,
    });
  }
  const units = [];
  childrenNamed(objectList, 'SW.Blocks.CompileUnit').forEach((unitNode) => {
    units.push(...compileUnits(unitNode, language));
  });
  if (!units.length && members.length && (language === 'DB' || /DB$/.test(kids(blockNode).name))) {
    members.forEach((member, index) => units.push(memberUnit(member, index)));
  }
  if (!units.length) {
    const summary = `This ${languageName(language)} block did not contain a network that could be read. Export the block again as an XML (.xml) block export or as SCL source.`;
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
  let networkNumber = 0;
  units.forEach((unit, index) => {
    unit.index = index;
    if (unit.kind === 'step' || unit.kind === 'transition') {
      if (!Number.isFinite(unit.number)) unit.number = index + 1;
      return;
    }
    networkNumber += 1;
    unit.number = networkNumber;
  });
  if (!project.programs.includes(name)) project.programs.push(name);
  const unread = units.every((unit) => unit.unread);
  addRoutine(project, {
    name,
    type: language,
    program: name,
    scopeKey: name,
    comment,
    units,
    language: 'tia',
    unreadReason: unread ? units[0].summary : '',
  });
}

function parseTia(project, xml) {
  const tree = parseOrdered(String(xml || ''));
  const blocks = [];
  walk(tree, (info, node) => {
    if (BLOCK_NAME.test(info.name)) blocks.push(node);
  });
  if (!blocks.length) {
    throw exposed(422, 'This XML file does not contain a block. Export the block as an XML (.xml) block export (ladder, function block, SCL, or sequence) and upload that file.');
  }
  for (const block of blocks) addBlock(project, block);
  return project;
}

module.exports = { parseTia };
