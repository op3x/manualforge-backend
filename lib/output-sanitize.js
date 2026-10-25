// Product and vendor names are matched only with regular expressions.
// Generated sentences use the neutral phrases below.

const CATALOG = String.raw`\b(?:[A-Za-z]{2,12}:|AB_)[A-Za-z0-9][A-Za-z0-9_]*(?:[:._-][A-Za-z0-9_]+)*`;
const SOFTWARE = String.raw`\b(?:Studio\s*5000|TIA\s*Portal|GX\s*Works(?:\s*\d+)?|RSLogix\w*|TwinCAT\w*|SolidWorks\w*|AutoCAD\w*|CODESYS\w*|CATIA|Creo)\b`;
const DRIVE = String.raw`\b(?:PowerFlex|SINAMICS)[\w-]*`;
const CONTROLLER = String.raw`\b(?:Allen-Bradley|Allen\s+Bradley|ControlLogix|CompactLogix|Rockwell|Siemens|Mitsubishi|Beckhoff|Omron)\b`;
const AB_WORD = String.raw`(?<![A-Za-z0-9_])AB(?![A-Za-z0-9_])`;
const VENDOR_PREFIX = /^(?:AB|Allen-Bradley|Rockwell|Siemens|Mitsubishi|Omron|Beckhoff|ControlLogix|CompactLogix)$/i;
const DRIVE_NAME = /PowerFlex|SINAMICS/i;
const DRIVE_WORD = /drive|vfd|inverter|servo/i;
const SOFTWARE_NAME = /Studio\s*5000|TIA\s*Portal|GX\s*Works|RSLogix|TwinCAT|SolidWorks|AutoCAD|CODESYS|CATIA|\bCreo\b/i;
const CONTROLLER_NAME = /Allen-Bradley|Allen\s+Bradley|ControlLogix|CompactLogix|Rockwell|Siemens|Mitsubishi|Beckhoff|Omron/i;

function applyPhrase(before, sample, phrase) {
  let next = phrase;
  if (/\b(?:the|a|an)\s*$/i.test(before)) next = next.replace(/^(?:the|a|an)\s+/i, '');
  else if (!String(before || '').trim() || /[.!?]["')\]]*\s*$/.test(before)) {
    next = next.charAt(0).toUpperCase() + next.slice(1);
  }
  return next;
}

function replaceTerm(text, source, flags, phraseFor) {
  return text.replace(new RegExp(source, flags), (match, offset, sourceText) => {
    const phrase = typeof phraseFor === 'function' ? phraseFor(match) : phraseFor;
    if (!phrase) return match;
    return applyPhrase(sourceText.slice(0, offset), match, phrase);
  });
}

function catalogTerm(token) {
  const prefix = String(token || '').split(':')[0];
  const knownPrefix = /^AB[_:]/i.test(token) || VENDOR_PREFIX.test(prefix);
  const driveName = DRIVE_NAME.test(token);
  const software = SOFTWARE_NAME.test(token);
  const controller = CONTROLLER_NAME.test(token);
  if (!knownPrefix && !driveName && !software && !controller) return '';
  if (driveName || (knownPrefix && DRIVE_WORD.test(token))) return 'variable frequency drive';
  if (software) return 'the programming software';
  if (controller) return 'the controller';
  return 'module';
}

function sanitizeVendors(text) {
  let next = replaceTerm(String(text ?? ''), CATALOG, 'gi', catalogTerm);
  next = replaceTerm(next, SOFTWARE, 'gi', 'the programming software');
  next = replaceTerm(next, DRIVE, 'gi', 'variable frequency drive');
  next = replaceTerm(next, CONTROLLER, 'gi', 'the controller');
  next = replaceTerm(next, AB_WORD, 'g', 'the controller');
  return next;
}

function collapseRepeatedWords(text) {
  let current = String(text ?? '');
  for (let pass = 0; pass < 6; pass += 1) {
    const next = current.replace(/\b([A-Za-z]{2,})\s+\1\b/gi, '$1');
    if (next === current) break;
    current = next;
  }
  return current;
}

function normalizeNemaFrame(text) {
  return String(text ?? '').replace(/\bNEMA[\s_-]*(\d{1,3})\b/gi, (_, size) => `NEMA ${size}`);
}

function sanitizeOutput(text, options = {}) {
  const table = Boolean(options && options.table);
  let next = sanitizeVendors(text);
  if (!table) next = collapseRepeatedWords(next);
  next = normalizeNemaFrame(next);
  return next.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,;])(?=\s|$)/g, '$1');
}

function sanitizeSvg(svg) {
  return String(svg || '').replace(/>([^<]+)</g, (all, text) => `>${sanitizeOutput(text)}<`);
}

function paint(object, keys, table) {
  if (!object) return;
  for (const key of keys) {
    if (typeof object[key] === 'string') object[key] = sanitizeOutput(object[key], { table });
  }
}

function sanitizeBlock(block) {
  if (!block || typeof block !== 'object') return;
  if (block.type === 'table') {
    if (Array.isArray(block.headers)) {
      block.headers = block.headers.map((cell) => sanitizeOutput(cell, { table: true }));
    }
    if (Array.isArray(block.rows)) {
      block.rows = block.rows.map((row) => (
        Array.isArray(row) ? row.map((cell) => sanitizeOutput(cell, { table: true })) : row
      ));
    }
    return;
  }
  for (const key of ['text', 'title', 'label', 'caption', 'ref']) {
    if (typeof block[key] === 'string') block[key] = sanitizeOutput(block[key]);
  }
  if (typeof block.svg === 'string') block.svg = sanitizeSvg(block.svg);
  if (Array.isArray(block.items)) {
    block.items = block.items.map((item) => {
      if (typeof item === 'string') return sanitizeOutput(item);
      if (!item || typeof item !== 'object') return item;
      const copy = { ...item };
      if (typeof copy.action === 'string') copy.action = sanitizeOutput(copy.action);
      if (typeof copy.expect === 'string') copy.expect = sanitizeOutput(copy.expect);
      return copy;
    });
  }
  if (Array.isArray(block.callouts)) {
    block.callouts = block.callouts.map((item) => sanitizeOutput(item));
  }
  if (block.hazard && typeof block.hazard === 'object') {
    for (const key of ['signal_word', 'hazard', 'consequence']) {
      if (typeof block.hazard[key] === 'string') block.hazard[key] = sanitizeOutput(block.hazard[key]);
    }
    if (Array.isArray(block.hazard.avoidance)) {
      block.hazard.avoidance = block.hazard.avoidance.map((step) => sanitizeOutput(step));
    }
  }
}

function sanitizeDocument(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  paint(doc.meta, ['title', 'model', 'language', 'manufacturer', 'headerLeft', 'headerRight', 'footerLeft']);
  paint(doc.meta, ['docNumber', 'revision', 'date'], true);
  if (doc.cover) {
    paint(doc.cover, [
      'manufacturer', 'title', 'subtitle', 'model', 'warning', 'foot', 'language', 'publisherName',
    ]);
    paint(doc.cover, ['serial', 'docNumber', 'revision', 'date'], true);
    if (typeof doc.cover.svg === 'string') doc.cover.svg = sanitizeSvg(doc.cover.svg);
  }
  if (doc.branding && typeof doc.branding.companyName === 'string') {
    doc.branding.companyName = sanitizeOutput(doc.branding.companyName);
  }
  for (const chapter of doc.chapters || []) {
    if (typeof chapter.title === 'string') chapter.title = sanitizeOutput(chapter.title);
    for (const section of chapter.sections || []) {
      if (typeof section.title === 'string') section.title = sanitizeOutput(section.title);
      for (const block of section.blocks || []) sanitizeBlock(block);
    }
  }
  return doc;
}

module.exports = {
  sanitizeVendors,
  collapseRepeatedWords,
  normalizeNemaFrame,
  sanitizeOutput,
  sanitizeDocument,
};
