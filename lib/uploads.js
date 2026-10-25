const Busboy = require('busboy');
const { limits } = require('./limits');
const {
  FILE_LIMIT,
  fileTooLargeError,
  tooManyFilesError,
} = require('./upload-errors');

const HEADER_SLACK = 256 * 1024;

function contentLengthOf(req) {
  const raw = req.headers && req.headers['content-length'];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function boundaryOf(type) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type || '');
  if (!match) return '';
  return (match[1] || match[2] || '').trim();
}

function trailerLength(type) {
  const boundary = boundaryOf(type);
  if (!boundary) return 80;
  return Buffer.byteLength(`\r\n--${boundary}--\r\n`);
}

function readMultipart(req, env = process.env) {
  const type = String((req.headers && req.headers['content-type']) || '');
  if (!/multipart\/form-data/i.test(type)) return Promise.resolve(null);
  const limitBytes = limits(env).uploadBytes;
  const declared = contentLengthOf(req);
  const trailer = trailerLength(type);
  if (declared != null && declared > limitBytes * FILE_LIMIT + HEADER_SLACK) {
    return Promise.reject(fileTooLargeError('upload', declared, limitBytes));
  }

  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({ headers: req.headers, defParamCharset: 'utf8' });
    } catch (err) {
      reject(err);
      return;
    }

    const body = Object.create(null);
    const kept = [];
    let fileCount = 0;
    let requestBytes = 0;
    let settled = false;
    let tooMany = false;

    function stop(err) {
      if (settled) return;
      settled = true;
      if (err && typeof err === 'object') err.uploadAbort = true;
      req.unpipe(parser);
      parser.removeAllListeners();
      if (typeof req.pause === 'function') req.pause();
      reject(err);
    }

    req.on('data', (chunk) => {
      requestBytes += chunk.length;
    });
    req.on('error', () => {});

    parser.on('field', (name, value) => {
      if (tooMany || settled) return;
      if (body[name] === undefined) body[name] = value;
      else if (Array.isArray(body[name])) body[name].push(value);
      else body[name] = [body[name], value];
    });

    parser.on('file', (fieldname, stream, info) => {
      if (settled) {
        stream.resume();
        return;
      }
      if (fieldname !== 'file' && fieldname !== 'files') {
        stream.resume();
        stop(Object.assign(new Error('Upload failed.'), { status: 400, expose: true }));
        return;
      }
      fileCount += 1;
      const filename = (info && info.filename) || 'upload';
      if (fileCount > FILE_LIMIT) {
        tooMany = true;
        kept.length = 0;
        stream.resume();
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        if (settled || tooMany) return;
        if (size + chunk.length > limitBytes) {
          size += chunk.length;
          const unread = declared == null ? 0 : Math.max(0, declared - requestBytes);
          const actual = size + Math.max(0, unread - trailer);
          stop(fileTooLargeError(filename, actual, limitBytes));
          return;
        }
        size += chunk.length;
        chunks.push(chunk);
      });
      stream.on('end', () => {
        if (settled || tooMany) return;
        kept.push({
          fieldname,
          originalname: filename,
          buffer: Buffer.concat(chunks),
          size,
        });
      });
      stream.on('error', stop);
    });

    parser.on('error', stop);
    parser.on('close', () => {
      if (settled) return;
      if (tooMany || fileCount > FILE_LIMIT) {
        stop(tooManyFilesError(fileCount));
        return;
      }
      settled = true;
      const files = {
        file: kept.filter((file) => file.fieldname === 'file'),
        files: kept.filter((file) => file.fieldname === 'files'),
      };
      resolve({ body, files });
    });

    req.pipe(parser);
  });
}

function createUpload(env) {
  return function upload(req, res, next) {
    readMultipart(req, env).then((parsed) => {
      if (parsed) {
        req.body = parsed.body;
        req.files = parsed.files;
      }
      next();
    }, (err) => {
      if (err && err.uploadAbort && res && typeof res.on === 'function') {
        res.on('finish', () => {
          if (!req.destroyed && typeof req.destroy === 'function') req.destroy();
        });
      }
      next(err);
    });
  };
}

module.exports = { createUpload, readMultipart, contentLengthOf };
