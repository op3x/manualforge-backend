const { decodeBuffer } = require('../text');

function textPairs(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (!/^-?\d+$/.test(code)) continue;
    out.push([Number(code), lines[i + 1].replace(/\s+$/, '')]);
  }
  return out;
}

function isBinaryDxf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 22 && buffer.slice(0, 18).toString('latin1') === 'AutoCAD Binary DXF';
}

function dxfValueKind(code) {
  if ((code >= 0 && code <= 9) || code === 100 || code === 102 || code === 105 || code === 999) return 'string';
  if ((code >= 10 && code <= 59) || (code >= 110 && code <= 149) || (code >= 210 && code <= 239) || (code >= 460 && code <= 469) || (code >= 1010 && code <= 1059)) return 'double';
  if ((code >= 60 && code <= 79) || (code >= 170 && code <= 179) || (code >= 270 && code <= 279) || (code >= 370 && code <= 389) || (code >= 400 && code <= 409) || (code >= 1060 && code <= 1070)) return 'i16';
  if ((code >= 90 && code <= 99) || (code >= 420 && code <= 429) || (code >= 440 && code <= 459) || code === 1071) return 'i32';
  if (code >= 160 && code <= 169) return 'i64';
  if ((code >= 280 && code <= 299)) return 'i8';
  if (code >= 310 && code <= 319) return 'chunk';
  if ((code >= 300 && code <= 309) || (code >= 320 && code <= 369) || (code >= 390 && code <= 399) || (code >= 410 && code <= 419) || (code >= 430 && code <= 439) || (code >= 470 && code <= 481) || (code >= 1000 && code <= 1009)) return 'string';
  return 'string';
}

function binaryPairs(buffer) {
  let offset = 22;
  const out = [];
  while (offset + 2 <= buffer.length) {
    const code = buffer.readInt16LE(offset);
    offset += 2;
    const kind = dxfValueKind(code);
    let value = '';
    if (kind === 'string') {
      const end = buffer.indexOf(0, offset);
      if (end < 0) break;
      value = buffer.toString('latin1', offset, end);
      offset = end + 1;
    } else if (kind === 'double') {
      if (offset + 8 > buffer.length) break;
      value = String(buffer.readDoubleLE(offset));
      offset += 8;
    } else if (kind === 'i16') {
      if (offset + 2 > buffer.length) break;
      value = String(buffer.readInt16LE(offset));
      offset += 2;
    } else if (kind === 'i32') {
      if (offset + 4 > buffer.length) break;
      value = String(buffer.readInt32LE(offset));
      offset += 4;
    } else if (kind === 'i64') {
      if (offset + 8 > buffer.length) break;
      value = buffer.readBigInt64LE(offset).toString();
      offset += 8;
    } else if (kind === 'i8') {
      if (offset + 1 > buffer.length) break;
      value = String(buffer.readUInt8(offset));
      offset += 1;
    } else if (kind === 'chunk') {
      if (offset + 1 > buffer.length) break;
      const length = buffer.readUInt8(offset);
      offset += 1;
      if (offset + length > buffer.length) break;
      value = buffer.slice(offset, offset + length).toString('hex');
      offset += length;
    }
    out.push([code, value]);
    if (code === 0 && value.trim().toUpperCase() === 'EOF') break;
  }
  return out;
}

function parseDxf(project, source) {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(String(source || ''), 'utf8');
  const items = isBinaryDxf(buffer) ? binaryPairs(buffer) : textPairs(decodeBuffer(buffer));
  if (!items.length || !items.some(([, value]) => value.trim().toUpperCase() === 'SECTION')) {
    const err = new Error('bad dxf');
    err.status = 400;
    err.expose = true;
    err.message = 'This DXF file does not contain a drawing section. Export ASCII or binary DXF and upload it again.';
    throw err;
  }
  let section = '';
  let headerVar = '';
  let inBlock = '';
  let entity = '';
  let layer = '';
  let value = '';
  const layers = new Set();
  const blocks = new Set();
  const texts = [];
  const flush = () => {
    if ((entity === 'TEXT' || entity === 'MTEXT' || entity === 'ATTRIB') && value.trim()) {
      texts.push({ layer, text: value.trim().replace(/\\P/g, ' '), block: inBlock });
    }
    if (entity === 'INSERT' && value.trim()) blocks.add(value.trim());
    entity = '';
    layer = '';
    value = '';
  };
  for (const [code, raw] of items) {
    const token = raw.trim();
    if (code === 0 && token === 'ENDSEC') { flush(); section = ''; continue; }
    if (code === 0 && token === 'SECTION') { flush(); section = ''; continue; }
    if (code === 2 && !section && token) { section = token.toUpperCase(); continue; }
    if (section === 'HEADER' && code === 9) { headerVar = token.toUpperCase(); continue; }
    if (section === 'HEADER' && headerVar === '$INSUNITS' && code === 70) {
      const units = { 1: 'inch', 4: 'mm', 5: 'cm', 6: 'm' };
      project.cad.lengthUnit = units[Number(token)] || project.cad.lengthUnit;
    }
    if (section === 'TABLES' && code === 0 && token === 'LAYER') { entity = 'LAYER'; continue; }
    if (section === 'TABLES' && entity === 'LAYER' && code === 2 && token) { layers.add(token); entity = ''; continue; }
    if (section === 'BLOCKS' && code === 0 && token === 'BLOCK') { flush(); inBlock = ''; entity = 'BLOCK'; continue; }
    if (section === 'BLOCKS' && entity === 'BLOCK' && code === 2) { inBlock = token; blocks.add(token); entity = ''; continue; }
    if (code === 0 && token === 'ENDBLK') { flush(); inBlock = ''; continue; }
    if (code === 0) { flush(); entity = token.toUpperCase(); continue; }
    if ((entity === 'TEXT' || entity === 'ATTRIB') && code === 1) value = token;
    if (entity === 'MTEXT' && (code === 1 || code === 3)) value = `${value}${token}`;
    if (entity === 'INSERT' && code === 2) value = token;
    if (code === 8 && token) layer = token;
  }
  flush();
  project.cad.layers.push(...layers);
  project.cad.blocks.push(...blocks);
  const title = texts.filter((item) => /title/i.test(item.layer) || /title/i.test(item.block) || /title/i.test(item.text));
  project.cad.titleBlock.push(...(title.length ? title : texts).map((item) => item.text));
  for (const item of texts) {
    if (!project.identity.productName && item.text.length > 3 && item.text.length < 80 && !/^[0-9.#$]+$/.test(item.text) && !item.text.startsWith('#')) {
      if (/title/i.test(item.layer) || /title/i.test(item.block)) project.identity.productName = item.text;
    }
  }
  return project;
}

module.exports = { parseDxf, isBinaryDxf, binaryPairs, textPairs };
