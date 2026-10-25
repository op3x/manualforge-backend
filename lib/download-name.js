const SLUG_MAX = 60;
const FALLBACK_SLUG = 'manualos';

function sourceName(project) {
  const identity = project && project.identity ? project.identity : {};
  const product = typeof identity.productName === 'string' ? identity.productName.trim() : '';
  const company = typeof identity.manufacturerName === 'string' ? identity.manufacturerName.trim() : '';
  return product || company || '';
}

function asciiSlug(value) {
  const folded = String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return folded.slice(0, SLUG_MAX).replace(/-+$/g, '');
}

function unicodeStem(value) {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return Array.from(cleaned).slice(0, SLUG_MAX).join('').replace(/[.\s]+$/g, '');
}

function rfc5987Encode(value) {
  return Array.from(Buffer.from(String(value), 'utf8'), (byte) => {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(ch)) return ch;
    return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function fileStem(source) {
  return asciiSlug(source) || FALLBACK_SLUG;
}

function downloadFileName(source) {
  return `${fileStem(source)}-manual.pdf`;
}

function contentDisposition(source) {
  const ascii = downloadFileName(source);
  let header = `attachment; filename="${ascii}"`;
  if (/[^\u0000-\u007f]/.test(String(source || ''))) {
    const unicode = unicodeStem(source);
    if (unicode) header += `; filename*=UTF-8''${rfc5987Encode(`${unicode}-manual.pdf`)}`;
  }
  return header;
}

module.exports = {
  SLUG_MAX,
  sourceName,
  asciiSlug,
  downloadFileName,
  contentDisposition,
};
