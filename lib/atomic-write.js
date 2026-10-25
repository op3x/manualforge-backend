const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function atomicWriteFile(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

module.exports = { atomicWriteFile };
