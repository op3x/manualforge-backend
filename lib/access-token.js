const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Two hours. Long enough to generate a manual, short enough that dropping the
// token is a sign-out. POST /access-token/revoke kills one token immediately.
const ACCESS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_TOKEN_SECRET_BYTES = 32;
const EXCHANGE_LIMIT = 5;
const EXCHANGE_WINDOW_MS = 60 * 60 * 1000;

const revokedUntil = new Map();
const exchangeHits = new Map();
let sunsetWarningLogged = false;

function rawTokenSecret(env) {
  const value = env && env.PORTAL_TOKEN_SECRET;
  if (value == null) return '';
  return String(value).trim();
}

function tokenSecret(env) {
  const text = rawTokenSecret(env);
  if (Buffer.byteLength(text, 'utf8') < MIN_TOKEN_SECRET_BYTES) return '';
  return text;
}

function warnIfTokenSecretShort(env) {
  const text = rawTokenSecret(env);
  if (!text || Buffer.byteLength(text, 'utf8') >= MIN_TOKEN_SECRET_BYTES) return;
  console.warn('PORTAL_TOKEN_SECRET is shorter than 32 bytes. Access tokens are off, and the legacy session_id path stays on.');
}

function legacySessionAllowed(env, now = Date.now()) {
  const raw = env && env.LEGACY_SESSION_ID_SUNSET;
  if (raw == null || !String(raw).trim()) return true;
  const text = String(raw).trim();
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? Date.parse(`${text}T00:00:00.000Z`)
    : Date.parse(text);
  if (!Number.isFinite(stamp)) {
    if (!sunsetWarningLogged) {
      sunsetWarningLogged = true;
      console.warn('LEGACY_SESSION_ID_SUNSET is not a date. The legacy session_id path stays on.');
    }
    return true;
  }
  return now < stamp;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  const len = Math.max(a.length, b.length, 1);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  a.copy(padA);
  b.copy(padB);
  return crypto.timingSafeEqual(padA, padB) && a.length === b.length;
}

function sweepRevoked(now) {
  for (const [jti, exp] of revokedUntil) {
    if (exp <= now) revokedUntil.delete(jti);
  }
}

function signPayload(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function signAccessToken(claims, env, now = Date.now()) {
  const secret = tokenSecret(env);
  if (!secret || !claims || typeof claims.sessionId !== 'string' || !claims.sessionId) return null;
  const exp = now + ACCESS_TOKEN_TTL_MS;
  const payload = {
    v: 1,
    sid: claims.sessionId,
    jti: crypto.randomBytes(16).toString('hex'),
    iat: now,
    exp,
  };
  if (claims.customerId) payload.cus = claims.customerId;
  if (claims.subscriptionId) payload.sub = claims.subscriptionId;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    token: `${body}.${signPayload(body, secret)}`,
    expiresAt: new Date(exp).toISOString(),
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}

function readPayload(token, env, now) {
  const secret = tokenSecret(env);
  if (!secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, signPayload(body, secret))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (typeof payload.sid !== 'string' || !payload.sid) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
  sweepRevoked(now);
  return payload;
}

function callerFromPayload(payload) {
  return {
    sessionId: payload.sid,
    customerId: typeof payload.cus === 'string' ? payload.cus : '',
    subscriptionId: typeof payload.sub === 'string' ? payload.sub : '',
    jti: payload.jti,
    exp: payload.exp,
    via: 'token',
  };
}

function verifyAccessToken(token, env, now = Date.now()) {
  const payload = readPayload(token, env, now);
  if (!payload || payload.exp <= now) return null;
  if (revokedUntil.has(payload.jti)) return null;
  return callerFromPayload(payload);
}

function revocationPath(env) {
  const root = env && env.SUPPORT_DATA_DIR && String(env.SUPPORT_DATA_DIR).trim();
  if (!root) return '';
  return path.join(root, 'revoked-tokens.json');
}

function loadRevocations(env, now = Date.now()) {
  const file = revocationPath(env);
  if (!file || !fs.existsSync(file)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const code = err && err.code ? err.code : 'unknown';
    console.error(`Revocation list could not be read (${code})`);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  for (const [jti, exp] of Object.entries(parsed)) {
    if (typeof jti !== 'string' || !jti) continue;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) continue;
    revokedUntil.set(jti, exp);
  }
}

function saveRevocations(env) {
  const file = revocationPath(env);
  if (!file) return;
  sweepRevoked(Date.now());
  const body = {};
  for (const [jti, exp] of revokedUntil) body[jti] = exp;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      const code = err && err.code ? err.code : 'unknown';
      console.error(`Revocation list mode was not set (${code})`);
    }
  }
  fs.renameSync(tmp, file);
}

function dropRevokedJti(jti) {
  revokedUntil.delete(jti);
}

function revokeAccessToken(token, env, now = Date.now()) {
  const payload = readPayload(token, env, now);
  if (!payload) return false;
  if (payload.exp > now) revokedUntil.set(payload.jti, payload.exp);
  try {
    saveRevocations(env);
  } catch (err) {
    const code = err && err.code ? err.code : 'unknown';
    console.error(`Revocation list save failed (${code})`);
  }
  return true;
}

function exchangeKey(sessionId, env) {
  const secret = tokenSecret(env) || 'manualos-exchange';
  return crypto.createHmac('sha256', secret).update(String(sessionId)).digest('hex');
}

function pruneExchanges(key, now) {
  const hits = (exchangeHits.get(key) || []).filter((at) => now - at < EXCHANGE_WINDOW_MS);
  if (hits.length) exchangeHits.set(key, hits);
  else exchangeHits.delete(key);
  return hits;
}

function tokenExchangeGate(sessionId, env, now = Date.now()) {
  const hits = pruneExchanges(exchangeKey(sessionId, env), now);
  if (hits.length < EXCHANGE_LIMIT) return { ok: true };
  const retryAfter = Math.max(1, Math.ceil((hits[0] + EXCHANGE_WINDOW_MS - now) / 1000));
  return { ok: false, retryAfter };
}

function recordTokenExchange(sessionId, env, now = Date.now()) {
  const key = exchangeKey(sessionId, env);
  const hits = pruneExchanges(key, now);
  hits.push(now);
  exchangeHits.set(key, hits);
}

module.exports = {
  ACCESS_TOKEN_TTL_MS,
  EXCHANGE_LIMIT,
  MIN_TOKEN_SECRET_BYTES,
  tokenSecret,
  warnIfTokenSecretShort,
  legacySessionAllowed,
  safeEqual,
  signAccessToken,
  verifyAccessToken,
  revokeAccessToken,
  loadRevocations,
  dropRevokedJti,
  tokenExchangeGate,
  recordTokenExchange,
};
