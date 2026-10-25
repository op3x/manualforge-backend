const { Worker } = require('worker_threads');
const path = require('path');
const { polishName, looksCoded, descriptiveFromFilename, classLabel, isStructural } = require('../presentation');

function decodeStepString(value) {
  let text = String(value || '').replace(/''/g, "'");
  text = text.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/gi, (_, hex) => {
    let out = '';
    for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
  });
  text = text.replace(/\\X\\([0-9A-Fa-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return text.replace(/\s+/g, ' ').trim();
}

function stepText(buffer) {
  const utf8 = buffer.toString('utf8');
  if (utf8.includes('\uFFFD')) return buffer.toString('latin1');
  return utf8;
}

function quoted(source, from) {
  if (source[from] !== "'") return null;
  let i = from + 1;
  let out = '';
  while (i < source.length) {
    if (source[i] === "'" && source[i + 1] === "'") { out += "'"; i += 2; continue; }
    if (source[i] === "'") return { value: out, end: i + 1 };
    out += source[i];
    i += 1;
  }
  return null;
}

function skipSpace(source, index) {
  let i = index;
  while (source[i] === ' ' || source[i] === '\n' || source[i] === '\r' || source[i] === '\t') i += 1;
  return i;
}

function readArgs(source, openParen) {
  const args = [];
  let i = openParen + 1;
  while (i < source.length) {
    i = skipSpace(source, i);
    if (source[i] === ')') return { args, end: i + 1 };
    if (source[i] === "'") {
      const item = quoted(source, i);
      if (!item) return { args, end: i };
      args.push(item.value);
      i = item.end;
    } else if (source[i] === '#') {
      const match = source.slice(i).match(/^#(\d+)/);
      args.push(match ? `#${match[1]}` : '');
      i += match ? match[0].length : 1;
    } else if (source[i] === '(') {
      let depth = 0;
      const start = i;
      do {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') depth -= 1;
        i += 1;
      } while (depth > 0 && i < source.length);
      args.push(source.slice(start, i));
    } else {
      const match = source.slice(i).match(/^[^,)]*/);
      const token = match ? match[0] : '';
      args.push(token.trim());
      i += token.length || 1;
    }
    i = skipSpace(source, i);
    if (source[i] === ',') i += 1;
  }
  return { args, end: i };
}

function productsFromText(text) {
  const products = new Map();
  const formations = new Map();
  const definitions = new Map();
  const occurrences = [];
  const points = [];
  const entity = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(/g;
  let match;
  while ((match = entity.exec(text)) !== null) {
    const id = `#${match[1]}`;
    const type = match[2];
    if (![
      'PRODUCT', 'PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE',
      'PRODUCT_DEFINITION', 'NEXT_ASSEMBLY_USAGE_OCCURRENCE',
    ].includes(type)) continue;
    const parsed = readArgs(text, match.index + match[0].length - 1);
    const args = parsed.args;
    if (type === 'PRODUCT') {
      products.set(id, {
        id: decodeStepString(args[0] || ''),
        name: decodeStepString(args[1] || args[0] || ''),
        description: decodeStepString(args[2] || ''),
      });
    } else if (type === 'PRODUCT_DEFINITION_FORMATION' || type === 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE') {
      formations.set(id, args.find((item) => String(item).startsWith('#')) || '');
    } else if (type === 'PRODUCT_DEFINITION') {
      definitions.set(id, args.find((item) => String(item).startsWith('#')) || '');
    } else if (type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') {
      const refs = args.filter((item) => String(item).startsWith('#'));
      occurrences.push({
        id: decodeStepString(args[0] || ''),
        name: decodeStepString(args[1] || ''),
        description: decodeStepString(args[2] || ''),
        parentDef: refs[0] || '',
        childDef: refs[1] || '',
      });
    }
  }
  const pointRe = /CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)/g;
  let seen = 0;
  let point;
  while ((point = pointRe.exec(text))) {
    const xyz = [Number(point[1]), Number(point[2]), Number(point[3])];
    if (!xyz.every(Number.isFinite)) continue;
    seen += 1;
    if (points.length < 400) points.push(xyz);
    else if (seen % 17 === 0) points[seen % 400] = xyz;
  }
  const productOfDef = (defId) => {
    const formation = definitions.get(defId);
    const productId = formations.get(formation);
    return products.get(productId) || null;
  };
  const links = occurrences.map((item) => ({
    ...item,
    parent: productOfDef(item.parentDef),
    child: productOfDef(item.childDef),
  }));
  let bodies = 0;
  const bodyRe = /\bMANIFOLD_SOLID_BREP\b/g;
  while (bodyRe.exec(text)) bodies += 1;
  let lengthUnit = '';
  if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) lengthUnit = 'inch';
  else if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\./i.test(text)) lengthUnit = 'mm';
  else if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\./i.test(text)) lengthUnit = 'm';
  return {
    products: [...products.values()],
    occurrences: links,
    points,
    bodies,
    lengthUnit,
  };
}

function boundingBox(points) {
  if (!points.length) return null;
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const point of points) {
    point.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      box.min[index] = Math.min(box.min[index], value);
      box.max[index] = Math.max(box.max[index], value);
    });
  }
  if (!box.min.every(Number.isFinite)) return null;
  return box;
}

function humanCadName(value) {
  const text = decodeStepString(value).replace(/\.(stp|step|igs|iges)$/i, '').replace(/[_]+/g, ' ').trim();
  if (!text || /^\$+$/.test(text)) return '';
  return text;
}

function partNumberOnly(value) {
  const text = String(value || '').trim();
  if (!text || text.length < 4) return false;
  if (/\s/.test(text) && /[A-Za-z]{4,}/.test(text.replace(/[0-9]/g, ''))) return false;
  return /^[A-Z0-9][A-Z0-9._-]{3,}$/i.test(text) && (/\d/.test(text) && !/[aeiou]{2,}/i.test(text.replace(/\d+/g, '')));
}

function presentPart(node) {
  const rawName = humanCadName(node.name);
  const rawDescription = humanCadName(node.description);
  const kind = classifyPart(`${rawName} ${rawDescription}`);
  const described = rawDescription && rawDescription.toLowerCase() !== rawName.toLowerCase() && !partNumberOnly(rawDescription);
  const number = node.id || rawName;
  const name = described
    ? polishName(rawDescription)
    : (partNumberOnly(rawName) ? `${classLabel(kind)} ${number}` : (polishName(rawName) || classLabel(kind)));
  const description = described
    ? polishName(rawDescription)
    : (partNumberOnly(rawName) || partNumberOnly(number)
      ? `${classLabel(kind)}, solid body, part ${number}`
      : (polishName(rawDescription || rawName) || classLabel(kind)));
  return { name, description, partNumber: number, kind, rawName };
}

function classifyPart(name) {
  const text = String(name || '').toLowerCase();
  if (/screw|washer|nut|bolt|shim|rivet|fastener|standoff/.test(text)) return 'fastener';
  if (/acrylic|panel|window|door|guard|enclosure/.test(text)) return 'guard';
  if (/bracket|plate|spacer|extrusion|8020|sketch|gusset|\bmount\b|bearing|\bframe\b/.test(text)) return 'frame';
  if (/conveyor|pulley|belt|roller/.test(text)) return 'conveyor';
  if (/gripper|\bjaw\b/.test(text)) return 'gripper';
  if (/cylinder|piston|boru|kapak/.test(text)) return 'cylinder';
  if (/valve|solenoid|valvula/.test(text)) return 'valve';
  if (/motor|nema|stepper|servo/.test(text)) return 'motor';
  if (/\brobot\b|\baxis\b|\barm\b/.test(text)) return 'robot';
  if (/hotend|heater|nozzle/.test(text)) return 'heater';
  if (/shaft|\bbar\b|\btube\b|member|structure/.test(text)) return 'frame';
  return '';
}

function nodeKey(node) {
  if (!node) return '';
  return String(node.id || node.name || '').toLowerCase();
}

function occurrenceQty(linked) {
  const childrenOf = new Map();
  const direct = new Map();
  const parentKeys = new Set();
  const childKeys = new Set();
  for (const link of linked) {
    const parent = nodeKey(link.parent);
    const child = nodeKey(link.child);
    if (!parent || !child) continue;
    parentKeys.add(parent);
    childKeys.add(child);
    direct.set(child, (direct.get(child) || 0) + 1);
    if (!childrenOf.has(parent)) childrenOf.set(parent, new Map());
    const bag = childrenOf.get(parent);
    bag.set(child, (bag.get(child) || 0) + 1);
  }
  const roots = [...parentKeys].filter((key) => !childKeys.has(key));
  const rolled = new Map();
  const walk = (key, amount, stack) => {
    const bag = childrenOf.get(key);
    if (!bag) return;
    for (const [child, count] of bag) {
      if (stack.has(child)) continue;
      const nextAmount = count * amount;
      rolled.set(child, (rolled.get(child) || 0) + nextAmount);
      const next = new Set(stack);
      next.add(child);
      walk(child, nextAmount, next);
    }
  };
  for (const root of roots) walk(root, 1, new Set([root]));
  const qty = new Map();
  for (const key of new Set([...direct.keys(), ...rolled.keys()])) {
    qty.set(key, Math.max(direct.get(key) || 0, rolled.get(key) || 0));
  }
  return { qty, parentKeys, childKeys };
}

function applyCad(project, extracted, format, filename = '') {
  const linked = extracted.occurrences.filter((item) => item.parent && item.child && (item.child.name || item.child.id));
  const { qty, parentKeys, childKeys } = occurrenceQty(linked);
  const nodes = [];
  if (linked.length) {
    for (const link of linked) {
      if (link.parent) nodes.push(link.parent);
      if (link.child) nodes.push(link.child);
    }
  } else {
    nodes.push(...extracted.products);
  }
  const seenAsm = new Set();
  const seenBom = new Set();
  const topNode = linked.map((link) => link.parent).find((node) => node && !childKeys.has(nodeKey(node)));
  const usable = (value) => {
    const text = String(value || '').trim();
    if (!text || /^\$+$/.test(text)) return '';
    return text;
  };
  const rawOf = (node) => {
    if (!node) return '';
    const description = usable(node.description);
    const name = usable(node.name);
    if (looksCoded(description)) return description;
    if (looksCoded(name)) return name;
    return description || name || usable(node.id) || '';
  };
  let rawTop = rawOf(topNode);
  for (const node of nodes) {
    const presented = presentPart(node);
    if (!presented.name || /^product$/i.test(presented.name)) continue;
    const key = nodeKey(node);
    const assembly = Boolean(key) && parentKeys.has(key);
    if (key && !seenAsm.has(key)) {
      seenAsm.add(key);
      const structural = !presented.kind || isStructural(presented.kind);
      project.cad.assemblies.push({
        name: presented.name,
        description: presented.description,
        partNumber: presented.partNumber,
        kind: presented.kind,
        role: structural ? 'structure' : 'process',
        leaf: linked.length ? !assembly : false,
        children: [],
        source: format,
      });
    }
    if (!key || assembly || seenBom.has(key)) continue;
    seenBom.add(key);
    project.cad.bom.push({
      item: project.cad.bom.length + 1,
      partNumber: presented.partNumber || presented.rawName || presented.name,
      description: presented.description,
      qty: qty.get(key) || 1,
      material: '',
    });
  }
  const box = boundingBox(extracted.points);
  if (box) project.cad.boundingBox = box;
  if (extracted.points.length) project.cad.points = extracted.points;
  if (extracted.lengthUnit) project.cad.lengthUnit = extracted.lengthUnit;
  if (extracted.bodies) project.cad.bodyCount = extracted.bodies;
  project.cad.assemblyLinks = extracted.occurrences.length;
  if (!rawTop && extracted.products[0]) rawTop = rawOf(extracted.products[0]);
  const titled = extracted.products.find((node) => /(?:COMPLETE\s+)?FRAME\s+ASY|ASSY/i.test(node.description || ''))
    || extracted.products.find((node) => looksCoded(node.description) && /\b(FRAME|ASY|ASSY|COMPLETE)\b/.test(node.description || ''));
  project.cad.drawingName = titled ? (titled.description || titled.name) : rawTop;
  if (!project.identity.productNameFromUser && !project.identity.productName) {
    const coded = looksCoded(rawTop);
    project.identity.productName = coded
      ? (descriptiveFromFilename(filename) || polishName(rawTop))
      : (polishName(rawTop) || descriptiveFromFilename(filename));
  }
}

function filenameHint(name) {
  const base = String(name || '').replace(/\.(stp|step|igs|iges)$/i, '');
  const nema = base.match(/NEMA[\s_-]*(\d{2})/i);
  return { base, nema: nema ? nema[1] : '' };
}

function occtAvailable() {
  try {
    require.resolve('occt-import-js');
    return true;
  } catch {
    return false;
  }
}

function readWithOcct(buffer, format) {
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'occt-worker.js'), { workerData: { buffer, format } });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve(null);
    }, 20000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      resolve(message && message.ok ? message : null);
    });
    worker.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function parseStep(project, buffer, format = 'step', filename = '') {
  const text = stepText(buffer);
  if (format === 'step' && !/ISO-10303-21/i.test(text.slice(0, 400))) {
    const err = new Error('bad step');
    err.status = 422;
    err.expose = true;
    err.message = 'This file is not a STEP model (ISO-10303-21). Export STEP AP203, AP214, or AP242 and upload it again.';
    throw err;
  }
  const extracted = productsFromText(text);
  if (occtAvailable()) {
    const occt = await readWithOcct(buffer, format);
    if (occt && occt.boundingBox) extracted.points.push(occt.boundingBox.min, occt.boundingBox.max);
  }
  applyCad(project, extracted, format, filename);
  const hint = filenameHint(filename);
  if (hint.nema && project.identity.productName && !project.identity.productName.includes(hint.nema)) {
    project.warnings.push(`The file name says NEMA ${hint.nema}, and the model is labelled "${project.identity.productName}". Confirm which name is correct.`);
    project.identity.productName = `NEMA ${hint.nema} stepper`;
  }
  if (!project.cad.assemblies.length && !extracted.bodies) {
    const err = new Error('empty step');
    err.status = 422;
    err.expose = true;
    err.message = 'This STEP file did not contain product or assembly names. Export the assembly, not an empty geometry file.';
    throw err;
  }
  if (!project.cad.assemblies.length && extracted.bodies) {
    project.cad.assemblies.push({
      name: project.identity.productName || 'Solid model',
      description: `The file contains ${extracted.bodies} solid bodies and no product names.`,
      children: [],
      source: format,
    });
  }
  return project;
}

module.exports = { parseStep, productsFromText, boundingBox, decodeStepString, presentPart };
