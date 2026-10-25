const crypto = require('crypto');

// Two hours. Long enough to generate a manual, short enough that dropping the
// token is a sign-out. POST /access-token/revoke kills one token immediately.
const ACCESS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const revokedUntil = new Map();

function tokenSecret(env) {
  const value = env && env.PORTAL_TOKEN_SECRET;
  if (value == null) return '';
  const text = String(value).trim();
  return text;
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

function revokeAccessToken(token, env, now = Date.now()) {
  const payload = readPayload(token, env, now);
  if (!payload) return false;
  if (payload.exp > now) revokedUntil.set(payload.jti, payload.exp);
  return true;
}

module.exports = {
  ACCESS_TOKEN_TTL_MS,
  tokenSecret,
  safeEqual,
  signAccessToken,
  verifyAccessToken,
  revokeAccessToken,
};
