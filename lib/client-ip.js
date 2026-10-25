// Same address the SMS consent route stores: req.ip after trust proxy, not a
// client-supplied X-Real-IP or the left-most X-Forwarded-For entry.
function requestIp(req) {
  const raw = req && req.ip ? String(req.ip) : '';
  const address = raw || (req && req.socket && req.socket.remoteAddress) || '';
  return String(address).replace(/^::ffff:/, '').slice(0, 64);
}

module.exports = { requestIp };
