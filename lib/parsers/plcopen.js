const { parseXml, child, attr, textOf, asArray } = require('./xml');
const { addRoutine, upsertTag } = require('../project');
const { exposed } = require('../errors');

function variablesFrom(pou) {
  const tags = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const variable of child(node, 'variable')) {
      const typeNode = variable.type || {};
      const typeName = Object.keys(typeNode).find((key) => !key.startsWith('@_')) || '';
      tags.push({
        name: attr(variable, 'name'),
        dataType: typeName,
        description: textOf(variable.documentation || variable.Documentation || ''),
      });
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(pou.interface || pou);
  return tags;
}

function elementId(node) {
  return String(attr(node, 'localId') || '');
}

function expressionText(node) {
  return textOf(node && node.expression).replace(/\s+/g, ' ').trim();
}

function connectionRef(point) {
  if (!point || typeof point !== 'object') return '';
  const connection = point.connection || point;
  const first = asArray(connection).find((item) => item && typeof item === 'object');
  return String(attr(first || connection, 'refLocalId') || '');
}

function inputList(block) {
  const container = block && block.inputVariables;
  if (!container || typeof container !== 'object') return [];
  return asArray(container.variable).filter((item) => item && typeof item === 'object');
}

function indexGraph(sheet) {
  const byId = new Map();
  for (const kind of ['block', 'inVariable', 'outVariable', 'contact', 'coil']) {
    for (const node of child(sheet, kind)) {
      const id = elementId(node);
      if (id) byId.set(id, { kind, node });
    }
  }
  return byId;
}

function blockCall(block, byId, seen) {
  const id = elementId(block);
  if (id) seen.add(id);
  const typeName = attr(block, 'typeName') || 'block';
  const instance = attr(block, 'instanceName');
  const args = [];
  for (const variable of inputList(block)) {
    const param = attr(variable, 'formalParameter');
    const ref = connectionRef(variable.connectionPointIn || variable);
    const value = resolveExpr(ref, byId, seen);
    if (param && value) args.push(`${param}=${value}`);
    else if (value || param) args.push(value || param);
  }
  const call = `${instance || typeName}(${args.join(', ')})`;
  return instance && typeName ? `${typeName} ${call}` : call;
}

function resolveExpr(id, byId, seen) {
  if (!id || seen.has(id) || !byId.has(id)) return '';
  seen.add(id);
  const entry = byId.get(id);
  const negated = String(attr(entry.node, 'negated')) === 'true' ? 'NOT ' : '';
  if (entry.kind === 'inVariable' || entry.kind === 'outVariable' || entry.kind === 'contact' || entry.kind === 'coil') {
    return `${negated}${expressionText(entry.node) || attr(entry.node, 'formalParameter')}`.trim();
  }
  if (entry.kind === 'block') return `${negated}${blockCall(entry.node, byId, seen)}`.trim();
  return '';
}

function outputsFor(id, sheet) {
  const names = [];
  for (const out of child(sheet, 'outVariable').concat(child(sheet, 'coil'))) {
    if (connectionRef(out.connectionPointIn || out) !== id) continue;
    const name = expressionText(out);
    if (name) names.push(name);
  }
  return names;
}

function graphicalUnits(sheet) {
  if (!sheet || typeof sheet !== 'object') return [];
  const byId = indexGraph(sheet);
  if (!byId.size) return [];
  const units = [];
  const push = (node, kind, text, summary) => {
    const body = String(text || '').trim();
    if (!body) return;
    units.push({
      index: units.length,
      number: Number(attr(node, 'localId') || units.length),
      kind,
      text: body,
      comment: '',
      summary: summary || '',
    });
  };
  for (const block of child(sheet, 'block')) {
    const typeName = attr(block, 'typeName') || 'block';
    const call = blockCall(block, byId, new Set());
    const outputs = outputsFor(elementId(block), sheet);
    const text = outputs.length ? `${outputs.join(', ')} := ${call}` : (call || typeName);
    push(block, 'network', text, `A ${typeName} block writes its result to the connected output.`);
  }
  for (const contact of child(sheet, 'contact')) {
    const name = expressionText(contact) || 'contact';
    const negated = String(attr(contact, 'negated')) === 'true';
    push(contact, 'rung', `${negated ? 'NOT ' : ''}${name}`, `${name} is examined.`);
  }
  for (const coil of child(sheet, 'coil')) {
    const name = expressionText(coil) || 'coil';
    const source = resolveExpr(connectionRef(coil.connectionPointIn || coil), byId, new Set([elementId(coil)]));
    push(coil, 'rung', source ? `${name} := ${source}` : name, `${name} is written.`);
  }
  if (!units.length) {
    for (const variable of child(sheet, 'outVariable').concat(child(sheet, 'inVariable'))) {
      const name = expressionText(variable);
      const source = resolveExpr(connectionRef(variable.connectionPointIn || variable), byId, new Set([elementId(variable)]));
      push(variable, 'network', source && name ? `${name} := ${source}` : (name || source), 'A connected variable is read or written.');
    }
  }
  return units;
}

function bodyHasLogic(body) {
  if (!body || typeof body !== 'object') return false;
  return ['LD', 'ld', 'FBD', 'fbd', 'ST', 'st', 'IL', 'il', 'SFC', 'sfc'].some((key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] != null);
}

function unitsFromBody(body) {
  const units = [];
  const ld = body.LD || body.ld || {};
  const fbd = body.FBD || body.fbd || {};
  const st = body.ST || body.st || body.IL || body.il;
  for (const rung of child(ld, 'rung')) {
    units.push({
      index: units.length,
      number: Number(attr(rung, 'localId') || units.length),
      kind: 'rung',
      text: textOf(rung.equation || rung),
      comment: textOf(rung.comment || ''),
    });
  }
  for (const network of child(fbd, 'network').concat(child(body, 'network'))) {
    units.push({
      index: units.length,
      number: Number(attr(network, 'localId') || units.length),
      kind: 'network',
      text: textOf(network),
      comment: textOf(network.comment || network.label || ''),
    });
  }
  const sfc = body.SFC || body.sfc;
  if (sfc) {
    for (const step of child(sfc, 'step')) {
      units.push({
        index: units.length,
        number: Number(attr(step, 'localId') || units.length),
        kind: 'step',
        text: attr(step, 'name'),
        comment: attr(step, 'name'),
        summary: `The sequence holds the ${attr(step, 'name') || 'step'} until the next transition is true.`,
      });
    }
    for (const transition of child(sfc, 'transition')) {
      const condition = textOf(transition.condition || transition);
      units.push({
        index: units.length,
        number: Number(attr(transition, 'localId') || units.length),
        kind: 'transition',
        text: condition,
        comment: '',
        summary: 'The sequence advances when the transition condition is true.',
      });
    }
  }
  if (!units.length) units.push(...graphicalUnits(ld));
  if (!units.length) units.push(...graphicalUnits(fbd));
  if (!units.length && st) {
    const source = textOf(st.xhtml || st);
    const blocks = source.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    (blocks.length ? blocks : [source]).forEach((block) => {
      if (!block) return;
      const comment = (block.match(/\(\*\s*([\s\S]*?)\s*\*\)/) || [])[1] || '';
      units.push({
        index: units.length,
        number: units.length,
        kind: 'statement',
        text: block,
        comment: comment.trim(),
      });
    });
  }
  return units.map((unit, index) => ({ ...unit, index }));
}

function parseTwinCat(project, tree) {
  const objects = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.POU) objects.push(...[].concat(node.POU));
    if (node.TcPlcObject) visit(node.TcPlcObject);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object' && value !== node.POU) visit(value);
    }
  };
  visit(tree);
  for (const pou of objects) {
    const name = attr(pou, 'Name') || 'Program';
    const declaration = textOf(pou.Declaration || '');
    const chunks = [];
    const implementation = textOf((pou.Implementation && (pou.Implementation.ST || pou.Implementation)) || '');
    if (implementation.trim()) chunks.push(implementation);
    for (const method of [].concat(pou.Method || [])) {
      const body = textOf((method.Implementation && (method.Implementation.ST || method.Implementation)) || '');
      if (body.trim()) chunks.push(body);
    }
    for (const action of [].concat(pou.Action || [])) {
      const body = textOf((action.Implementation && (action.Implementation.ST || action.Implementation)) || '');
      if (body.trim()) chunks.push(body);
    }
    if (!project.programs.includes(name)) project.programs.push(name);
    addRoutine(project, {
      name,
      type: 'ST',
      program: name,
      scopeKey: name,
      comment: (declaration.match(/\(\*\s*([\s\S]*?)\s*\*\)/) || [])[1] || '',
      units: chunks.map((chunk, index) => ({
        index,
        number: index,
        kind: 'statement',
        text: chunk.replace(/\(\*[\s\S]*?\*\)/g, '').trim(),
        comment: ((chunk.match(/\(\*\s*([\s\S]*?)\s*\*\)/) || [])[1] || '').replace(/\s+/g, ' ').trim(),
      })),
      language: 'tcpou',
    });
  }
}

function parsePlcopen(project, xml) {
  const tree = parseXml(xml);
  if (xml.includes('TcPlcObject') || tree.TcPlcObject) {
    parseTwinCat(project, tree);
    if (project.routines.length) return project;
  }
  const pous = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.pou) pous.push(...[].concat(node.pou));
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(tree);
  if (!pous.length) {
    const err = new Error('no pou');
    err.status = 422;
    err.expose = true;
    err.message = 'This XML program file does not contain a program block. Export the program block again.';
    throw err;
  }
  for (const pou of pous) {
    const name = attr(pou, 'name') || attr(pou, 'Name') || 'Program';
    const pouType = attr(pou, 'pouType') || 'program';
    if (!project.programs.includes(name)) project.programs.push(name);
    for (const tag of variablesFrom(pou)) {
      upsertTag(project, { ...tag, scope: name });
    }
    const bodies = child(pou, 'body');
    const units = [];
    for (const body of bodies) {
      const parsed = unitsFromBody(body);
      if (bodyHasLogic(body) && !parsed.length) {
        throw exposed(422, `Program block ${name} has a logic body but no rungs, networks, or statements were read. Export the POU again.`, 'A program block has a logic body but no rungs, networks, or statements were read.');
      }
      units.push(...parsed);
    }
    units.forEach((unit, index) => { unit.index = index; });
    addRoutine(project, {
      name,
      type: pouType,
      program: name,
      comment: textOf(pou.documentation || ''),
      units,
      language: 'plcopen',
    });
  }
  return project;
}

module.exports = { parsePlcopen };
