const AdmZip = require('adm-zip');
const { exposed } = require('../errors');
const { limits, unpackedTooLargeMessage } = require('../limits');
const { safeName } = require('../text');

function isZip(buffer) {
  return buffer && buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
}

function assertSafePath(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw exposed(400, 'The archive contains an unsafe path and was rejected.');
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw exposed(400, 'The archive contains a path that escapes its folder and was rejected.');
  }
  return normalized;
}

function expandsTooFar(bytes) {
  const err = exposed(400, 'The archive expands too far and was rejected.');
  err.displayMessage = unpackedTooLargeMessage(bytes);
  return err;
}

function chargeUnpacked(tally, cap, bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return;
  tally.total += n;
  if (tally.total > cap.zipMaxBytes) throw expandsTooFar(cap.zipMaxBytes);
}

function unzipSafe(buffer, env, depth = 0, unpacked = null) {
  const cap = limits(env);
  const tally = unpacked || { total: 0 };
  if (depth > cap.zipMaxDepth) {
    throw exposed(400, 'The archive is nested too deeply and was rejected.');
  }
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw exposed(400, 'This ZIP archive could not be opened.');
  }
  const entries = zip.getEntries();
  if (entries.length > cap.zipMaxFiles) {
    throw exposed(400, `The archive has too many files (limit ${cap.zipMaxFiles}).`);
  }
  const files = [];
  for (const entry of entries) {
    const entryName = assertSafePath(entry.entryName);
    if (entry.isDirectory) continue;
    const claimed = Number(entry.header && entry.header.size) || 0;
    const compressed = Number(entry.header && entry.header.compressedSize) || 0;
    if (compressed > 0 && claimed / compressed > cap.zipMaxRatio && claimed > 1_000_000) {
      throw exposed(400, 'The archive expands too far and was rejected.');
    }
    chargeUnpacked(tally, cap, claimed);
    const data = entry.getData();
    chargeUnpacked(tally, cap, Math.max(0, data.length - claimed));
    if (isZip(data)) {
      files.push(...unzipSafe(data, env, depth + 1, tally));
      continue;
    }
    files.push({ name: safeName(entryName.split('/').pop()), buffer: data });
  }
  return files;
}

module.exports = { isZip, unzipSafe };
