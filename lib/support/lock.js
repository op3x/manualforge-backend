const fs = require('fs');

const LOCK_NAME = '.support.lock';
const LOCK_STALE_MS = 60 * 60 * 1000;
const LOCK_WAIT_MS = 2 * 60 * 1000;

function canonicalizeSupportDir(dir) {
  if (!dir || typeof dir !== 'string') {
    const err = new Error('Support data directory is missing');
    err.code = 'ENOENT';
    throw err;
  }
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function lockFile(dir) {
  return `${dir}/${LOCK_NAME}`;
}

// One process may re-enter the directory it already holds. Another process
// blocks on the O_EXCL file so the script and the server cannot interleave
// a read-modify-write.
const depthByDir = new Map();

function withSupportLock(dir, fn, options = {}) {
  const root = canonicalizeSupportDir(dir);
  const depth = depthByDir.get(root) || 0;
  // A second sweep in this process must not re-enter. Store writes may: an
  // HTTP request can arrive while this process is waiting on Twilio.
  if (depth > 0 && options.reentrant === false) {
    const err = new Error('Support data lock is busy');
    err.code = 'EBUSY';
    throw err;
  }
  if (depth > 0) {
    depthByDir.set(root, depth + 1);
    let result;
    try {
      result = fn();
    } catch (err) {
      depthByDir.set(root, depth - 1);
      throw err;
    }
    if (result && typeof result.then === 'function') {
      return result.finally(() => {
        depthByDir.set(root, Math.max(0, (depthByDir.get(root) || 1) - 1));
      });
    }
    depthByDir.set(root, depth);
    return result;
  }

  const lock = acquireSupportLock(root, options);
  depthByDir.set(root, 1);
  let result;
  try {
    result = fn();
  } catch (err) {
    depthByDir.set(root, 0);
    releaseSupportLock(lock);
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(() => {
      depthByDir.set(root, 0);
      releaseSupportLock(lock);
    });
  }
  depthByDir.set(root, 0);
  releaseSupportLock(lock);
  return result;
}

function acquireSupportLock(dir, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const waitMs = Number.isFinite(options.waitMs) ? options.waitMs : 0;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : LOCK_STALE_MS;
  const root = canonicalizeSupportDir(dir);
  const file = lockFile(root);
  const deadline = now() + Math.max(0, waitMs);
  for (;;) {
    const fd = tryCreate(file, now);
    if (fd != null) return { fd, path: file, dir: root };
    const stolen = stealIfStale(file, now, staleMs);
    if (stolen === 'stolen' || stolen === 'missing') continue;
    if (now() >= deadline) {
      const err = new Error('Support data lock is busy');
      err.code = 'EBUSY';
      throw err;
    }
    sleepSync(Math.min(50, Math.max(1, deadline - now())));
  }
}

function tryCreate(file, now) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    if (err && err.code === 'EEXIST') return null;
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* the fd may already be closed */ }
    try { fs.rmSync(file, { force: true }); } catch { /* another process may own a new lock */ }
    throw err;
  }
  return fd;
}

function stealIfStale(file, now, staleMs) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'missing';
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return 'busy';
  if (now() - stat.mtimeMs < staleMs) return 'busy';
  const grave = `${file}.${process.pid}.${stat.ino}.stale`;
  try {
    const again = fs.lstatSync(file);
    if (again.ino !== stat.ino || again.mtimeMs !== stat.mtimeMs) return 'missing';
    fs.renameSync(file, grave);
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'missing';
    throw err;
  }
  try {
    const moved = fs.lstatSync(grave);
    if (moved.ino !== stat.ino) {
      try { fs.renameSync(grave, file); } catch { /* the path was taken by a new lock */ }
      return 'busy';
    }
    fs.rmSync(grave, { force: true });
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return 'stolen';
}

function releaseSupportLock(lock) {
  if (!lock) return;
  try {
    const mine = fs.fstatSync(lock.fd);
    let current = null;
    try {
      current = fs.lstatSync(lock.path);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    if (current && current.ino === mine.ino) fs.unlinkSync(lock.path);
  } catch (err) {
    if (!err || (err.code !== 'ENOENT' && err.code !== 'EBADF')) {
      try { fs.rmSync(lock.path, { force: true }); } catch { /* best effort */ }
    }
  } finally {
    try { fs.closeSync(lock.fd); } catch { /* already closed */ }
  }
}

function touchSupportLock(dir) {
  try {
    const file = lockFile(canonicalizeSupportDir(dir));
    const when = new Date();
    fs.utimesSync(file, when, when);
  } catch {
    // A missing lock means this process is not the holder.
  }
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

module.exports = {
  LOCK_NAME,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  acquireSupportLock,
  canonicalizeSupportDir,
  releaseSupportLock,
  touchSupportLock,
  withSupportLock,
};
