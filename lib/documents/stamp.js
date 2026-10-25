const MANUAL_SUBTITLE = 'Operating and Maintenance Manual';

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
  if (company) doc.meta.footerLeft = company;
  return doc;
}

module.exports = { stampDocument, MANUAL_SUBTITLE };
