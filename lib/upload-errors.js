const crypto = require('crypto');
const { exposed } = require('./errors');
const { safeName } = require('./text');
const { flagOn } = require('./limits');

const FILE_LIMIT = 25;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

function coded(err, code, extra = {}) {
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function megabyteText(bytes, digits) {
  const mb = bytes / (1024 * 1024);
  if (digits <= 0) return String(Math.round(mb));
  return mb.toFixed(digits);
}

function fileTooLargeMessage(name, sizeBytes, limitBytes) {
  const limitMb = limitBytes / (1024 * 1024);
  const limitIsWhole = Math.abs(limitMb - Math.round(limitMb)) < 1e-8;
  let sizeText = '0';
  let limitText = limitIsWhole ? String(Math.round(limitMb)) : megabyteText(limitBytes, 1);
  for (let digits = 0; digits <= 6; digits += 1) {
    const sizeDigits = Math.abs(sizeBytes / (1024 * 1024) - Math.round(sizeBytes / (1024 * 1024))) < 1e-8
      ? 0
      : Math.max(digits, 1);
    const limitDigits = limitIsWhole ? 0 : Math.max(digits, 1);
    sizeText = megabyteText(sizeBytes, sizeDigits);
    limitText = megabyteText(limitBytes, limitDigits);
    const sizeShown = Number(sizeText);
    const limitShown = Number(limitText);
    if (sizeShown === 0 && sizeBytes > 0) continue;
    if (sizeBytes > limitBytes && sizeShown <= limitShown) continue;
    break;
  }
  return `${safeName(name)} is ${sizeText} MB; the limit is ${limitText} MB.`;
}

function fileTooLargeError(name, sizeBytes, limitBytes) {
  const file = safeName(name);
  return coded(
    exposed(413, fileTooLargeMessage(file, sizeBytes, limitBytes)),
    'file_too_large',
    { file, sizeBytes, limitBytes },
  );
}

function tooManyFilesError(received) {
  return coded(
    exposed(400, `Too many files. The limit is ${FILE_LIMIT} and ${received} were received.`),
    'too_many_files',
    { limit: FILE_LIMIT, received },
  );
}

function emptyFileError(name, container) {
  const file = container ? `${safeName(name)} inside ${safeName(container)}` : safeName(name);
  return coded(exposed(400, `${file} is empty.`), 'empty_file', { file });
}

function unsupportedFileError(message, file) {
  return coded(exposed(415, message), 'unsupported_file', { file: file || null });
}

function duplicateUploadError(jobId) {
  return coded(
    exposed(409, 'This upload matches a manual already requested for this purchase. Confirm to generate it again.'),
    'duplicate_upload',
    { jobId },
  );
}

function fileHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function uploadSetHash(files) {
  const parts = [];
  for (const file of files) {
    const hash = fileHash(file.buffer);
    if (!parts.includes(hash)) parts.push(hash);
  }
  parts.sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function dedupeUploadFiles(files) {
  const seen = new Set();
  const kept = [];
  const ignored = [];
  for (const file of files) {
    const hash = fileHash(file.buffer);
    const name = file.originalname || file.name || 'upload';
    if (seen.has(hash)) {
      ignored.push(safeName(name));
      continue;
    }
    seen.add(hash);
    kept.push(file);
  }
  return { files: kept, ignored };
}

function confirmDuplicate(body) {
  if (!body) return false;
  return flagOn(body.confirmDuplicate);
}

module.exports = {
  FILE_LIMIT,
  DUPLICATE_WINDOW_MS,
  coded,
  fileTooLargeMessage,
  fileTooLargeError,
  tooManyFilesError,
  emptyFileError,
  unsupportedFileError,
  duplicateUploadError,
  fileHash,
  uploadSetHash,
  dedupeUploadFiles,
  confirmDuplicate,
};
