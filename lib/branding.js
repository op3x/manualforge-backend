const { LOGO_MAX_BYTES } = require('./config');
const { exposed } = require('./errors');
const { graphemeClusters } = require('./text');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function normalizeCompanyName(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  if (graphemeClusters(text).length > 80) throw exposed(400, 'Company name is too long.');
  if (/[<>]/.test(text)) throw exposed(400, 'Company name contains characters that cannot be printed.');
  return text;
}

function isPng(buffer) {
  return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function assertSafeSvg(svg) {
  const withoutNamespace = svg.replace(/xmlns(?::xlink)?\s*=\s*["']http:\/\/www\.w3\.org\/[^"']+["']/gi, '');
  const banned = [
    /<script\b/i,
    /<\/script/i,
    /<foreignObject\b/i,
    /<iframe\b/i,
    /<embed\b/i,
    /<object\b/i,
    /<link\b/i,
    /<meta\b/i,
    /<handler\b/i,
    /<style\b/i,
    /<!ENTITY/i,
    /<!DOCTYPE/i,
    /javascript:/i,
    /on[a-z]+\s*=/i,
    /data:/i,
    /https?:/i,
    /expression\s*\(/i,
  ];
  for (const pattern of banned) {
    if (pattern.test(withoutNamespace)) throw exposed(400, 'Logo SVG is not allowed.');
  }
  const opens = svg.match(/<svg\b/gi) || [];
  if (opens.length !== 1) throw exposed(400, 'Logo SVG is not allowed.');
}

function sanitizeSvg(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text || text.includes('\0')) throw exposed(400, 'Logo must be a PNG or SVG file.');
  if (!/^<\?xml[\s\S]*?<svg[\s>]/i.test(text) && !/^<svg[\s>]/i.test(text)) {
    throw exposed(400, 'Logo must be a PNG or SVG file.');
  }
  assertSafeSvg(text);
  const match = text.match(/<svg\b[\s\S]*<\/svg>/i);
  if (!match) throw exposed(400, 'Logo must be a PNG or SVG file.');
  const svg = match[0];
  if (Buffer.byteLength(svg) > LOGO_MAX_BYTES) throw exposed(400, 'Logo file is too large.');
  assertSafeSvg(svg);
  return Buffer.from(svg, 'utf8');
}

function validateLogo(buffer) {
  if (!buffer || !buffer.length) throw exposed(400, 'Logo file is empty.');
  if (buffer.length > LOGO_MAX_BYTES) throw exposed(400, 'Logo file is too large.');
  if (isPng(buffer)) return { type: 'png', buffer };
  return { type: 'svg', buffer: sanitizeSvg(buffer) };
}

function logoMarkup(logo) {
  if (!logo || !logo.buffer) return '';
  let clean;
  try {
    clean = validateLogo(logo.buffer);
  } catch {
    return '';
  }
  const mime = clean.type === 'png' ? 'image/png' : 'image/svg+xml';
  return `<img class="brand-logo" alt="" src="data:${mime};base64,${clean.buffer.toString('base64')}">`;
}

function documentBranding(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const companyName = typeof stored.companyName === 'string' ? stored.companyName.trim() : '';
  const logoHtml = logoMarkup(stored.logo);
  if (!companyName && !logoHtml) return null;
  return {
    whiteLabel: true,
    companyName,
    logoHtml,
  };
}

function publicBranding(stored) {
  const logo = stored && stored.logo;
  return {
    company_name: stored && stored.companyName ? stored.companyName : '',
    has_logo: Boolean(logo),
    logo_type: logo ? logo.type : null,
  };
}

module.exports = {
  normalizeCompanyName,
  validateLogo,
  logoMarkup,
  documentBranding,
  publicBranding,
};
