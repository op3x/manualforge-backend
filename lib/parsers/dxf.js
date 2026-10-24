function pairs(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    if (!/^-?\d+$/.test(code)) continue;
    out.push([Number(code), lines[i + 1].replace(/\s+$/, '')]);
  }
  return out;
}

function parseDxf(project, text) {
  const items = pairs(text);
  if (!items.length || !items.some(([, value]) => value.trim().toUpperCase() === 'SECTION')) {
    const err = new Error('bad dxf');
    err.status = 400;
    err.expose = true;
    err.message = 'This DXF file does not contain a drawing section. Export ASCII DXF and upload it again.';
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
  if (!project.cad.assemblies.length) {
    const named = [...layers].filter((name) => !/^(0|DEFPOINTS)$/i.test(name));
    named.forEach((name) => {
      project.cad.assemblies.push({
        name,
        description: `Drawing layer ${name}`,
        children: [],
        source: 'dxf-layer',
      });
    });
  }
  return project;
}

module.exports = { parseDxf };
