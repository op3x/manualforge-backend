const FILE_EXT = 'l5x|l5k|xml|zip|zap15|st|scl|exp|tcpou|csv|xlsx|xls|step|stp|iges|igs|dxf|acd|pdf';
const CUSTOMER_FILE = new RegExp(
  `(?:[A-Za-z]:[\\\\/])?(?:[A-Za-z0-9 ._()\\-]+[\\\\/])*[A-Za-z0-9][A-Za-z0-9 ._()\\-]*\\.(?:${FILE_EXT})\\b`,
  'gi',
);

function redactCustomerLog(value) {
  return String(value ?? '')
    .replace(CUSTOMER_FILE, '[file]')
    .replace(/Program block\s+\S+/g, 'Program block [redacted]');
}

module.exports = { redactCustomerLog };
