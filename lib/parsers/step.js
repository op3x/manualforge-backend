const { Worker } = require('worker_threads');
const path = require('path');

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
      'PRODUCT', 'PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION',
      'NEXT_ASSEMBLY_USAGE_OCCURRENCE',
    ].includes(type)) continue;
    const parsed = readArgs(text, match.index + match[0].length - 1);
    const args = parsed.args;
    if (type === 'PRODUCT') {
      products.set(id, {
        id: decodeStepString(args[0] || ''),
        name: decodeStepString(args[1] || args[0] || ''),
        description: decodeStepString(args[2] || ''),
      });
    } else if (type === 'PRODUCT_DEFINITION_FORMATION') {
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
  const sampleAt = [0, Math.floor(text.length / 2)];
  for (const start of sampleAt) {
    pointRe.lastIndex = start;
    let count = 0;
    let point;
    while (count < 80 && (point = pointRe.exec(text))) {
      points.push([Number(point[1]), Number(point[2]), Number(point[3])]);
      count += 1;
    }
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
  return decodeStepString(value).replace(/\.(stp|step|igs|iges)$/i, '').replace(/[_]+/g, ' ').trim();
}

function partNumberOnly(value) {
  const text = String(value || '').trim();
  if (!text || text.length < 4) return false;
  if (/\s/.test(text) && /[A-Za-z]{4,}/.test(text.replace(/[0-9]/g, ''))) return false;
  return /^[A-Z0-9][A-Z0-9._-]{3,}$/i.test(text) && (/\d/.test(text) && !/[aeiou]{2,}/i.test(text.replace(/\d+/g, '')));
}

function presentPart(node) {
  const name = humanCadName(node.name);
  const description = humanCadName(node.description);
  const described = description && description.toLowerCase() !== name.toLowerCase() && !partNumberOnly(description);
  if (described) return { name: description, description, partNumber: node.id || name };
  if (partNumberOnly(name) || partNumberOnly(node.id)) {
    const number = node.id || name;
    return {
      name: `Part ${number}`,
      description: `Part ${number}. NEEDS INPUT: describe what this part does.`,
      partNumber: number,
    };
  }
  return { name, description: description || name, partNumber: node.id || '' };
}

function classifyPart(name) {
  const text = String(name || '').toLowerCase();
  if (/screw|washer|nut|bolt|shim|rivet/.test(text)) return 'fastener';
  if (/conveyor|pulley|belt/.test(text)) return 'conveyor';
  if (/gripper|jaw/.test(text)) return 'gripper';
  if (/cylinder|piston|boru|kapak/.test(text)) return 'cylinder';
  if (/valve|solenoid|valvula/.test(text)) return 'valve';
  if (/motor|nema|stepper|servo/.test(text)) return 'motor';
  if (/robot|axis|arm/.test(text)) return 'robot';
  if (/guard|door|acrylic|panel/.test(text)) return 'guard';
  if (/frame|extrusion|assembly|asy/.test(text)) return 'frame';
  if (/hotend|heater|nozzle/.test(text)) return 'heater';
  return '';
}

function applyCad(project, extracted, format) {
  const seen = new Set();
  const pushPart = (node) => {
    const presented = presentPart(node);
    const key = presented.name.toLowerCase();
    if (!presented.name || seen.has(key) || /^product$/i.test(presented.name)) return;
    seen.add(key);
    const kind = classifyPart(`${presented.name} ${presented.description}`);
    project.cad.assemblies.push({
      name: presented.name,
      description: presented.description,
      partNumber: presented.partNumber,
      kind,
      children: [],
      source: format,
    });
    project.cad.bom.push({
      item: project.cad.bom.length + 1,
      partNumber: presented.partNumber || 'NEEDS INPUT',
      description: presented.description,
      qty: 1,
      material: '',
    });
  };
  const linked = extracted.occurrences.filter((item) => item.child && item.child.name);
  if (linked.length) {
    const childIds = new Set(linked.map((item) => (item.child.id || item.child.name).toLowerCase()));
    const tops = linked.filter((item) => item.parent && !childIds.has((item.parent.id || item.parent.name).toLowerCase()));
    (tops.length ? tops : linked).forEach((item) => pushPart(item.parent || item.child));
    linked.forEach((item) => pushPart(item.child));
  }
  if (!project.cad.assemblies.length) {
    for (const product of extracted.products) pushPart(product);
  }
  const box = boundingBox(extracted.points);
  if (box) project.cad.boundingBox = box;
  if (extracted.lengthUnit) project.cad.lengthUnit = extracted.lengthUnit;
  if (extracted.bodies) project.cad.bodyCount = extracted.bodies;
  project.cad.assemblyLinks = extracted.occurrences.length;
  if (!project.identity.productName) {
    const top = project.cad.assemblies.find((item) => item.kind && item.kind !== 'fastener') || project.cad.assemblies[0];
    if (top) project.identity.productName = top.name;
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
  applyCad(project, extracted, format);
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
      description: `The file contains ${extracted.bodies} solid bodies and no product names. NEEDS INPUT: name the assembly.`,
      children: [],
      source: format,
    });
  }
  return project;
}

module.exports = { parseStep, productsFromText, boundingBox, decodeStepString, presentPart };
