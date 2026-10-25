const { execFileSync } = require('child_process');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { graphemeClusters } = require('../text');

const MANUAL_SUBTITLE = 'Operating and Maintenance Manual';

// Chrome margin boxes ignore overflow, so a long @top-left string paints over
// "Rev. A" and can pass the right margin. Widths are pdfkit widthOfString
// measurements at the header size (8pt Helvetica). Chrome paints that face
// with Liberation Sans, whose Latin metrics match Helvetica. A grapheme the
// header face does not contain is measured with the fallback face that does,
// still through widthOfString. Emoji stay one cluster: the color emoji font
// is not a PDF face, so its advance is read from that font. Anything no face
// covers counts as one em, which is the full-width tofu box.
const HEADER_LEFT_MAX_CHARS = 110;
const HEADER_FONT = 'Helvetica';
const HEADER_FONT_SIZE = 8;
const LETTER_WIDTH_PT = 612;
const SIDE_MARGIN_PT = 18 * 72 / 25.4;
// Reserved clear space before "Rev. A". The render test requires 8pt.
const HEADER_REV_GAP_PT = 12;
const RIGHT_LABEL = 'Rev. A';

const KNOWN_FALLBACK_FONTS = [
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

const EMOJI_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
  '/usr/share/fonts/noto/NotoColorEmoji.ttf',
];

let measureDoc = null;
let fallbackFiles = null;
let emojiWidthPt = null;
const clusterCache = new Map();

function pdfDoc() {
  if (measureDoc) return measureDoc;
  measureDoc = new PDFDocument({ autoFirstPage: false });
  measureDoc.on('data', () => {});
  measureDoc.on('error', () => {});
  measureDoc.font(HEADER_FONT).fontSize(HEADER_FONT_SIZE);
  return measureDoc;
}

function fontconfigFiles(pattern) {
  try {
    const out = execFileSync('fc-match', ['-s', '-f', '%{file}\n', pattern], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((line) => line.trim()).filter((line) => line && fs.existsSync(line));
  } catch {
    return [];
  }
}

function fallbackFontFiles() {
  if (fallbackFiles) return fallbackFiles;
  const files = [];
  for (const file of KNOWN_FALLBACK_FONTS) {
    if (fs.existsSync(file)) files.push(file);
  }
  for (const pattern of ['sans:charset=4e2d', 'sans:charset=ac00', 'sans:charset=ff21', 'sans:charset=03a9']) {
    for (const file of fontconfigFiles(pattern)) files.push(file);
  }
  fallbackFiles = [...new Set(files)].slice(0, 16);
  return fallbackFiles;
}

function fontCovers(doc, cluster) {
  const font = doc._font;
  if (!font || !cluster) return false;
  if (typeof font.layout === 'function') {
    try {
      const run = font.layout(cluster, undefined, false);
      if (!run || !Array.isArray(run.glyphs) || run.glyphs.length === 0) return false;
      return run.glyphs.every((glyph) => glyph && glyph.id !== 0 && glyph.name !== '.notdef');
    } catch {
      return false;
    }
  }
  if (font.font && typeof font.font.glyphsForString === 'function') {
    const names = font.font.glyphsForString(cluster);
    return names.length > 0 && names.every((name) => name && name !== '.notdef');
  }
  return false;
}

function widthOn(doc, font, text) {
  doc.font(font).fontSize(HEADER_FONT_SIZE);
  return doc.widthOfString(text);
}

const unreadableFonts = new Set();

function useFallback(doc, file) {
  if (unreadableFonts.has(file)) return false;
  try {
    doc.font(file).fontSize(HEADER_FONT_SIZE);
    return true;
  } catch {
    unreadableFonts.add(file);
    return false;
  }
}

function isEmojiCluster(cluster) {
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(cluster);
}

function readU16(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) return 0;
  return buffer.readUInt16BE(offset);
}

function readU32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return 0;
  return buffer.readUInt32BE(offset);
}

// pdfkit cannot subset a CBDT/CBLC emoji font. The cluster advance Chrome
// paints is that font's max horizontal advance over its em square.
function emojiFontWidth() {
  if (emojiWidthPt != null) return emojiWidthPt;
  emojiWidthPt = 0;
  const files = [...fontconfigFiles('Noto Color Emoji'), ...EMOJI_FONT_CANDIDATES];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (buffer.length < 12) continue;
    const tables = buffer.readUInt16BE(4);
    let head = -1;
    let hhea = -1;
    for (let index = 0; index < tables; index += 1) {
      const record = 12 + index * 16;
      if (record + 12 > buffer.length) break;
      const tag = buffer.toString('latin1', record, record + 4);
      const offset = readU32(buffer, record + 8);
      if (tag === 'head') head = offset;
      if (tag === 'hhea') hhea = offset;
    }
    if (head < 0 || hhea < 0) continue;
    const units = readU16(buffer, head + 18);
    const advance = readU16(buffer, hhea + 10);
    if (units > 0 && advance > 0) {
      emojiWidthPt = (advance / units) * HEADER_FONT_SIZE;
      break;
    }
  }
  return emojiWidthPt;
}

function measureCluster(cluster) {
  const cached = clusterCache.get(cluster);
  if (cached) return cached;
  const doc = pdfDoc();
  let measured;
  doc.font(HEADER_FONT).fontSize(HEADER_FONT_SIZE);
  if (fontCovers(doc, cluster)) {
    measured = { font: HEADER_FONT, width: doc.widthOfString(cluster) };
  } else if (isEmojiCluster(cluster) && emojiFontWidth() > 0) {
    measured = { font: 'emoji', width: emojiFontWidth() };
  } else {
    measured = { font: '', width: HEADER_FONT_SIZE };
    for (const file of fallbackFontFiles()) {
      if (!useFallback(doc, file)) continue;
      if (!fontCovers(doc, cluster)) continue;
      measured = { font: file, width: doc.widthOfString(cluster) };
      break;
    }
  }
  clusterCache.set(cluster, measured);
  return measured;
}

function widthOfClusters(clusters) {
  if (clusters.length === 0) return 0;
  const measured = clusters.map((cluster) => measureCluster(cluster));
  const font = measured[0].font;
  if (font && font !== 'emoji' && measured.every((item) => item.font === font)) {
    return widthOn(pdfDoc(), font, clusters.join(''));
  }
  let total = 0;
  for (const item of measured) total += item.width;
  return total;
}

function headerBudget() {
  const revision = widthOfClusters(graphemeClusters(RIGHT_LABEL));
  return LETTER_WIDTH_PT - (2 * SIDE_MARGIN_PT) - revision - HEADER_REV_GAP_PT;
}

function fitHeaderLeft(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const parts = graphemeClusters(text);
  const budget = headerBudget();
  if (parts.length <= HEADER_LEFT_MAX_CHARS && widthOfClusters(parts) <= budget) return text;
  const ellipsis = '…';
  let count = 0;
  while (count < parts.length && count + 1 < HEADER_LEFT_MAX_CHARS) {
    const next = parts.slice(0, count + 1);
    if (widthOfClusters(next.concat(ellipsis)) > budget) break;
    count += 1;
  }
  while (count > 0 && /^\s+$/.test(parts[count - 1])) count -= 1;
  const cut = parts.slice(0, count).join('');
  return cut ? `${cut}${ellipsis}` : ellipsis;
}

function stampDocument(doc, branding, subtitle) {
  const sub = subtitle || (doc.cover && doc.cover.subtitle) || '';
  if (sub && doc.cover) doc.cover.subtitle = sub;
  const company = branding && branding.whiteLabel && branding.companyName
    ? String(branding.companyName).trim()
    : '';
  const logo = branding && branding.whiteLabel && branding.logoHtml ? branding.logoHtml : '';
  if (branding && branding.whiteLabel) {
    doc.branding = {
      whiteLabel: true,
      companyName: company || (doc.branding && doc.branding.companyName) || '',
      logoHtml: logo || (doc.branding && doc.branding.logoHtml) || '',
    };
    doc.cover.whiteLabel = true;
    doc.cover.publisherName = doc.branding.companyName;
    doc.cover.logoHtml = doc.branding.logoHtml;
  }
  if (sub) {
    const base = `${doc.meta.title} · ${sub}`;
    doc.meta.headerLeft = company ? `${company} · ${base}` : base;
  } else if (company && !String(doc.meta.headerLeft || '').includes(company)) {
    doc.meta.headerLeft = `${company} · ${doc.meta.headerLeft}`;
  }
  if (doc.meta) doc.meta.headerLeft = fitHeaderLeft(doc.meta.headerLeft);
  if (company) doc.meta.footerLeft = company;
  return doc;
}

module.exports = { stampDocument, MANUAL_SUBTITLE, fitHeaderLeft, HEADER_LEFT_MAX_CHARS };
