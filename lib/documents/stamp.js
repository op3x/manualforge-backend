const MANUAL_SUBTITLE = 'Operating and Maintenance Manual';

// Chrome margin boxes ignore overflow, so a long @top-left string paints over
// the revision. The same limit applies to extra-document headers.
const HEADER_LEFT_MAX_CHARS = 110;
const HEADER_LEFT_MAX_ADVANCE = 540;

function headerAdvance(ch) {
  if (ch === ' ' || ch === '\u00a0') return 2.96;
  if (ch === 'i' || ch === 'l' || ch === 'I' || ch === 'j' || ch === '!' || ch === '|' || ch === '.' || ch === ',' || ch === '\u00b7' || ch === "'") return 2.96;
  if (ch === 'f' || ch === 't' || ch === 'r' || ch === '-') return 3.55;
  if (ch === 'm' || ch === 'M') return 8.88;
  if (ch === 'W') return 10.06;
  if (ch === 'w') return 7.7;
  if (ch === '\u2026') return 8;
  if (ch >= 'a' && ch <= 'z') return 5.93;
  if (ch >= '0' && ch <= '9') return 5.93;
  return 7.7;
}

function fitHeaderLeft(value) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  let total = 0;
  for (const ch of chars) total += headerAdvance(ch);
  if (chars.length <= HEADER_LEFT_MAX_CHARS && total <= HEADER_LEFT_MAX_ADVANCE) return text;
  const ellipsis = headerAdvance('\u2026');
  let used = 0;
  let count = 0;
  for (const ch of chars) {
    const width = headerAdvance(ch);
    if (count + 1 >= HEADER_LEFT_MAX_CHARS || used + width + ellipsis > HEADER_LEFT_MAX_ADVANCE) break;
    used += width;
    count += 1;
  }
  const cut = chars.slice(0, count).join('').trimEnd();
  return cut ? `${cut}\u2026` : '\u2026';
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
    const next = company ? `${company} · ${base}` : base;
    if (doc.meta.headerLeft !== next) doc.meta.headerLeft = next;
  } else if (company && !String(doc.meta.headerLeft || '').includes(company)) {
    doc.meta.headerLeft = `${company} · ${doc.meta.headerLeft}`;
  }
  if (doc.meta) doc.meta.headerLeft = fitHeaderLeft(doc.meta.headerLeft);
  if (company) doc.meta.footerLeft = company;
  return doc;
}

module.exports = { stampDocument, MANUAL_SUBTITLE, fitHeaderLeft, HEADER_LEFT_MAX_CHARS };
