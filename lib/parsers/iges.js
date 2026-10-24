function parseIges(project, text) {
  const source = String(text || '');
  const lines = source.split(/\r?\n/).filter((line) => line.length >= 73);
  const start = [];
  const globals = [];
  for (const line of lines) {
    const section = line[72];
    const content = line.slice(0, 72).trimEnd();
    if (section === 'S') start.push(content.trim());
    if (section === 'G') globals.push(content.trim());
  }
  const hollerith = [];
  const hollerithRe = /(\d{1,3})H/g;
  let hollerithMatch;
  const globalText = globals.join(' ');
  while ((hollerithMatch = hollerithRe.exec(globalText))) {
    const length = Number(hollerithMatch[1]);
    const start = hollerithMatch.index + hollerithMatch[0].length;
    hollerith.push(globalText.slice(start, start + length).trim());
    hollerithRe.lastIndex = start + length;
  }
  const quoted = [...source.slice(0, 200000).matchAll(/'([^'\r\n]{3,80})'/g)].map((match) => match[1]);
  const names = [...start, ...hollerith, ...quoted].map((item) => item.replace(/\s+/g, ' ').trim()).filter((item) => (
    item && item.length > 2 && item.length < 80
    && !/open cascade|iges processor|filename\.iges|ansi|iso|^iges$/i.test(item)
    && !/^[,;\s.0-9]+$/.test(item)
  ));
  const unique = [...new Set(names)].slice(0, 40);
  if (!unique.length && lines.some((line) => line[72] === 'S' || line[72] === 'G')) {
    unique.push('Imported solid model');
  }
  if (!unique.length) {
    const err = new Error('bad iges');
    err.status = 422;
    err.expose = true;
    err.message = 'This IGES file does not contain a start section or part names. Export IGES again from the CAD system.';
    throw err;
  }
  for (const name of unique) {
    project.cad.assemblies.push({ name, description: '', children: [], source: 'iges' });
    project.cad.bom.push({
      item: project.cad.bom.length + 1,
      partNumber: '',
      description: name,
      qty: 1,
      material: '',
    });
  }
  if (!project.identity.productName && unique[0]) project.identity.productName = unique[0];
  let subfigures = 0;
  for (const line of lines) {
    if (line[72] === 'D' && /^\s*308\b/.test(line)) subfigures += 1;
  }
  if (subfigures) project.cad.bodyCount = Math.ceil(subfigures / 2);
  if (globals.length) project.cad.titleBlock.push(globals.join(' ').slice(0, 240));
  return project;
}

module.exports = { parseIges };
