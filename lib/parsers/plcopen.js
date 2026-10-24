const { parseXml, child, attr, textOf } = require('./xml');
const { addRoutine, upsertTag } = require('../project');

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
  const fbdBlocks = child(fbd, 'block');
  if (!units.length && fbdBlocks.length) {
    fbdBlocks.forEach((block) => {
      const typeName = attr(block, 'typeName');
      const instance = attr(block, 'instanceName');
      units.push({
        index: units.length,
        number: Number(attr(block, 'localId') || units.length),
        kind: 'network',
        text: `${typeName} ${instance}`.trim(),
        comment: '',
        summary: `A ${typeName || 'function'} block writes its result to the connected outputs.`,
      });
    });
  }
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
    err.message = 'This PLCopen or TwinCAT file does not contain a program block. Export the POU again.';
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
    const units = bodies.flatMap((body) => unitsFromBody(body));
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
