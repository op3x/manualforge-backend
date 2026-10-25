const { exposed } = require('../errors');

function mostlyText(buffer) {
  const length = Math.min(buffer.length, 2000);
  if (!length) return false;
  let printable = 0;
  for (let i = 0; i < length; i += 1) {
    const code = buffer[i];
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127)) printable += 1;
  }
  return printable / length > 0.9;
}

function isAsciiStl(text) {
  const sample = String(text || '');
  return /^\s*solid\b/i.test(sample) && /\bfacet\s+normal\b/i.test(sample) && /\bvertex\b/i.test(sample);
}

function isBinaryStl(buffer) {
  if (!buffer || buffer.length < 84) return false;
  const count = buffer.readUInt32LE(80);
  if (!Number.isFinite(count) || count < 1 || count > 5000000) return false;
  const expected = 84 + count * 50;
  return buffer.length === expected || (buffer.length > expected && buffer.length <= expected + 256);
}

function classifyShape(min, max) {
  const dims = max.map((value, index) => Math.abs(value - min[index])).sort((a, b) => a - b);
  const [small, mid, large] = dims;
  if (!(large > 0)) return 'an empty outline';
  const flat = small / large < 0.15;
  const long = mid / large < 0.35;
  if (flat && long) return 'a thin strip';
  if (flat) return 'a flat plate';
  if (long) return 'a long bar';
  if (small / large > 0.7 && mid / large > 0.7) return 'a compact block';
  return 'an irregular solid';
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function consider(bounds, point) {
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function decodeAscii(text) {
  const source = String(text || '');
  const name = ((source.match(/^\s*solid\s+([^\r\n]+)/i) || [])[1] || '').trim();
  const vertices = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const pattern = /vertex\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/gi;
  let match = pattern.exec(source);
  while (match) {
    const point = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (point.every(Number.isFinite)) {
      vertices.push(point);
      consider(bounds, point);
    }
    match = pattern.exec(source);
  }
  const triangles = Math.floor(vertices.length / 3);
  if (!triangles) return null;
  return { name, triangles, vertices, min: bounds.min, max: bounds.max };
}

function decodeBinary(buffer) {
  const count = buffer.readUInt32LE(80);
  const expected = 84 + count * 50;
  if (buffer.length < expected) return null;
  const header = buffer.slice(0, 80).toString('latin1');
  const named = header.match(/^solid\s+([\x20-\x7e]{1,64})/);
  const vertices = [];
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let index = 0; index < count; index += 1) {
    const offset = 84 + index * 50;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const start = offset + 12 + vertex * 12;
      const point = [buffer.readFloatLE(start), buffer.readFloatLE(start + 4), buffer.readFloatLE(start + 8)];
      if (!point.every(Number.isFinite)) return null;
      vertices.push(point);
      consider(bounds, point);
    }
  }
  return {
    name: named ? named[1].trim() : '',
    triangles: count,
    vertices,
    min: bounds.min,
    max: bounds.max,
  };
}

function fileTitle(filename) {
  const base = String(filename || 'Uploaded mesh').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base || 'Uploaded mesh';
}

function parseMeshStl(project, buffer, filename = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const text = bytes.toString('utf8');
  let decoded = null;
  if (isAsciiStl(text.slice(0, 4000)) && mostlyText(bytes)) decoded = decodeAscii(text);
  else if (isBinaryStl(bytes)) decoded = decodeBinary(bytes);
  else if (isAsciiStl(text)) decoded = decodeAscii(text);
  if (!decoded || !decoded.triangles) {
    throw exposed(422, 'This STL file could not be read as an ASCII or binary triangle mesh. Export the mesh again, or export STEP for a model with part names.');
  }
  const shape = classifyShape(decoded.min, decoded.max);
  const dims = decoded.min.map((value, index) => round(decoded.max[index] - value)).join(' × ');
  const note = `This STL file is a triangle mesh with ${decoded.triangles} triangles. The manual can report only the overall size (${dims} file units) and the approximate shape (${shape}). It has no part names, features, holes, or assembly structure. Export STEP for a complete model.`;
  const name = decoded.name && !/^solid$/i.test(decoded.name) ? decoded.name : fileTitle(filename);
  project.cad.meshOnly = true;
  project.cad.shape = shape;
  project.cad.triangleCount = decoded.triangles;
  project.cad.lengthUnit = 'file units';
  project.cad.bodyCount = 1;
  project.cad.boundingBox = { min: decoded.min.map(round), max: decoded.max.map(round) };
  const step = Math.max(1, Math.ceil(decoded.vertices.length / 240));
  project.cad.points = decoded.vertices.filter((_, index) => index % step === 0).slice(0, 240);
  project.cad.assemblies.push({
    name,
    description: note,
    role: 'process',
    leaf: false,
    source: 'stl',
    kind: shape,
  });
  project.cad.titleBlock.push(note);
  if (!project.identity.productName) project.identity.productName = name;
  project.warnings.push(note);
  return project;
}

module.exports = {
  parseMeshStl,
  isAsciiStl,
  isBinaryStl,
  mostlyText,
  classifyShape,
};
