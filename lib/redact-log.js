const FILE_EXT = [
  'sldprt', 'sldasm', 'slddrw',
  'step', 'stp', 'iges', 'igs', 'xlsx', 'l5x', 'l5k', 'tcpou',
  'dwg', 'dxf', 'acd', 'awl', 'xml', 'zip', 'xls', 'csv', 'scl', 'exp', 'stl', 'pdf', 'db',
  'zap\\d*', 'ap\\d*', 'st',
].join('|');
const FILE_CHAR = '[\\p{L}\\p{M}\\p{N}._()\\-]';
const CUSTOMER_FILE = new RegExp(
  `(?:[A-Za-z]:[\\\\/])?(?:${FILE_CHAR}+[\\\\/])*[\\p{L}\\p{M}\\p{N}]${FILE_CHAR}*\\.(?:${FILE_EXT})\\b`,
  'giu',
);
const VERSION_FILE = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_])(\\d+(?:\\.\\d+)+\\.(?:${FILE_EXT}))\\b`,
  'giu',
);

function redactCustomerLog(value) {
  const saved = [];
  let text = String(value ?? '').replace(VERSION_FILE, (match) => {
    const token = `\u0000V${saved.length}\u0000`;
    saved.push(match);
    return token;
  });
  text = text
    .replace(CUSTOMER_FILE, '[file]')
    .replace(/Program block\s*:?\s+\S+/giu, 'Program block [redacted]');
  saved.forEach((original, index) => {
    text = text.replace(`\u0000V${index}\u0000`, original);
  });
  return text;
}

module.exports = { redactCustomerLog };
