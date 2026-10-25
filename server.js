require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { createAnthropic } = require('./lib/anthropic');
const { limits } = require('./lib/limits');
const {
  allowedOrigins,
  frontendConfigProblem,
  isProduction,
} = require('./lib/config');
const {
  accessBlock,
  assertCanGenerate,
  blockForAccess,
  checkoutParams,
  isStripeNotFound,
  publicAccess,
  commitStarterCredit,
  recordStarterManual,
  reserveStarterCredit,
  verifyCheckoutSession,
} = require('./lib/billing');
const {
  clearRawSessionBlock,
  legacySessionAllowed,
  loadRevocations,
  logPortalTokenStatus,
  portalTokensEnabled,
  rawSessionBlocked,
  recordTokenExchange,
  revokeAccessToken,
  signAccessToken,
  tokenExchangeGate,
  tokenSecret,
  verifyAccessToken,
  safeEqual,
} = require('./lib/access-token');
const { contentDisposition, downloadFileName, shortJobId, sourceName } = require('./lib/download-name');
const { assertSessionId, maskSessionId } = require('./lib/session-id');
const { FILE_LIMIT, overLengthField } = require('./lib/field-limits');
const { withCheckoutPolicy } = require('./lib/checkoutPolicy');
const { applyManualosCheckout, classifyStripeEvent } = require('./lib/stripeBrand');
const { withStripeReadCache } = require('./lib/stripe-read-cache');
const { countUnknownEvents, recordUnknownEvent } = require('./lib/unknown-events');
const { applyStarterChargeEvent } = require('./lib/starter-entitlement');
const { applyPeriodAccessEvent } = require('./lib/period-access');
const { applyOverageCreditEvent } = require('./lib/overage-credit');
const {
  GENERATION_REFRESH_MS,
  clearGenerationStarted,
  markFirstManualDelivered,
  markGenerationStarted,
  rollbackFirstManual,
  touchGenerationStarted,
} = require('./lib/delivery');
const { applyCheckoutConsent, withManualosBrand } = require('./lib/checkout-consent');
const { requestIp } = require('./lib/client-ip');
const {
  maybeSendCancellationConfirmation,
  mountBillingPortal,
  warnIfManagedPaymentsWithoutPortal,
  warnIfSmtpUnconfigured,
} = require('./lib/billing-portal');
const { createSmtpMailer } = require('./lib/support/mail');
const { createCreditLedger, redactCreditLog, supportDataDirOk, warnSupportDataDir } = require('./lib/credit-ledger');
const { CREDIT_RETURN_MESSAGE, JOB_TIMEOUT_MESSAGE, jobTimeoutMs } = require('./lib/job-timeout');
const { generateManual } = require('./lib/pipeline');
const { parseUploads } = require('./lib/parsers');
const { logPythonAvailability, sweepStaleAcdTemps } = require('./lib/parsers/acd');
const { createJobStore, publicJob } = require('./lib/jobs/store');
const { redactCustomerLog, redactSecrets } = require('./lib/redact-log');
const { closeBrowser } = require('./lib/manual/pdf');
const { mountSupport } = require('./lib/support/http');
function createStripe(env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !String(key).trim()) return null;
  return new Stripe(String(key).trim());
}

const VERIFY_CACHE_MS = 10 * 1000;
const VERIFY_CACHE_MAX = 5000;

function debugStacks(env) {
  return String(env && env.DEBUG || '') === '1';
}

function logUnexpected(err, env) {
  console.error('Request failed (internal_error)');
  if (debugStacks(env) && err && err.stack) {
    console.error(redactSecrets(redactCustomerLog(err.stack)));
  }
}

function sendError(res, err, env) {
  if (err && err.expose) {
    if (err.logMessage) console.error(redactSecrets(redactCustomerLog(err.logMessage)));
    const body = { error: err.message };
    if (err.publicCode) body.code = err.publicCode;
    return res.status(err.status || 500).json(body);
  }
  logUnexpected(err, env);
  return res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
}

function projectFormat(project) {
  const formats = [];
  for (const source of (project && project.sources) || []) {
    const format = source && typeof source.format === 'string' ? source.format : '';
    if (format && !formats.includes(format)) formats.push(format);
  }
  if (formats.length !== 1) return formats.length ? 'mixed' : 'unknown';
  return /^[a-z0-9]{1,24}$/i.test(formats[0]) ? formats[0].toLowerCase() : 'unknown';
}

function pdfPageCount(pdf) {
  if (!pdf) return 0;
  const text = Buffer.isBuffer(pdf) ? pdf.toString('latin1') : String(pdf);
  const matches = text.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g);
  return matches ? matches.length : 0;
}

function countingAnthropic(client, counter) {
  if (!client || !client.messages || typeof client.messages.create !== 'function') return client;
  return {
    ...client,
    messages: {
      ...client.messages,
      create(...args) {
        counter.count += 1;
        return client.messages.create(...args);
      },
    },
  };
}

function safePlan(plan) {
  return typeof plan === 'string' && /^[a-z0-9_-]{1,32}$/i.test(plan) ? plan : 'unknown';
}

function jobErrorCode(err, timeout) {
  if (timeout) return 'job_timeout';
  const code = err && err.publicCode;
  if (typeof code === 'string' && /^[a-z0-9_]+$/.test(code)) return code;
  return 'generation_failed';
}

function logJobEvent(fields) {
  console.log(JSON.stringify({
    event: fields.event,
    jobId: fields.jobId,
    plan: fields.plan,
    format: fields.format,
    ms: fields.ms,
    pages: fields.pages,
    modelCalls: fields.modelCalls,
    errorCode: fields.errorCode,
  }));
}

function readSessionId(req) {
  const fromBody = req.body && typeof req.body.session_id === 'string' ? req.body.session_id.trim() : '';
  if (fromBody) return fromBody;
  const header = req.get('x-session-id');
  return typeof header === 'string' ? header.trim() : '';
}

function exposed(status, message, logMessage, publicCode) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (logMessage) err.logMessage = logMessage;
  if (publicCode) err.publicCode = publicCode;
  return err;
}

const PRIVATE_RESPONSE = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  Pragma: 'no-cache',
};

function clientLimiter(max) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    statusCode: 429,
    message: { error: 'Too many requests.' },
  });
}

function tokenSecretProblem(env) {
  const value = env && env.PORTAL_TOKEN_SECRET;
  if (value != null && String(value).trim() && !tokenSecret(env)) {
    return 'PORTAL_TOKEN_SECRET is shorter than 32 bytes. Portal tokens are disabled.';
  }
  return 'PORTAL_TOKEN_SECRET is missing. Portal tokens are disabled.';
}

function rejectPortalTokens(res, env) {
  console.error(tokenSecretProblem(env));
  return res.status(503).json({
    error: 'Access tokens are unavailable.',
    code: 'portal_tokens_disabled',
  });
}

function tooMany(res, retryAfter, error = 'Too many requests.') {
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ error });
}

function bearerToken(req) {
  const header = req.get('authorization');
  if (!header) return '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header).trim());
  if (!match) throw exposed(401, 'Access token is invalid or expired.', null, 'access_token_invalid');
  return match[1];
}

const JOB_NOT_FOUND = { error: 'Job not found or expired.' };

function boundId(value) {
  return typeof value === 'string' && value.length > 0;
}

function collectFiles(req) {
  const files = [];
  const groups = req.files || {};
  for (const group of [groups.file, groups.files]) {
    if (Array.isArray(group)) files.push(...group);
  }
  if (req.file) files.push(req.file);
  if (!files.length && req.body && typeof req.body.plcContent === 'string' && req.body.plcContent.trim()) {
    files.push({
      originalname: 'upload.xml',
      buffer: Buffer.from(req.body.plcContent, 'utf8'),
    });
  }
  return files;
}

function fieldsFrom(req) {
  const body = req.body || {};
  const fields = {};
  for (const key of ['brand', 'manufacturer_name', 'manufacturer_address', 'product_name', 'model', 'doc_number', 'revision', 'language', 'date']) {
    if (typeof body[key] === 'string') fields[key] = body[key];
  }
  return fields;
}

function logWebhookEvent(event) {
  const object = event.data && event.data.object ? event.data.object : {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
      console.log(event.type, maskSessionId(object.id), object.payment_status);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      console.log(event.type, object.id, object.status);
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'charge.refunded':
    case 'charge.dispute.created':
    case 'charge.dispute.closed':
    case 'radar.early_fraud_warning.created':
      console.log(event.type, object.id);
      break;
    default:
      console.log('Unhandled event:', event.type);
  }
}

function safeLogToken(value) {
  if (typeof value !== 'string') return 'unknown';
  if (!/^[A-Za-z0-9_.]{1,80}$/.test(value)) return 'unknown';
  return value;
}

function loggedObjectId(value) {
  if (typeof value === 'string' && value.startsWith('cs_')) return maskSessionId(value);
  return safeLogToken(value);
}

function isLoudUnknown(type) {
  return typeof type === 'string' && (
    type.startsWith('charge.')
    || type.startsWith('refund.')
    || type.startsWith('radar.early_fraud_warning.')
    || type.startsWith('invoice.')
    || type.startsWith('customer.subscription.')
    || type.startsWith('checkout.session.')
  );
}

function createApp({
  env = process.env,
  stripe,
  anthropic,
  renderPdf,
  jobs,
  supportStore,
  twilioClient,
  supportComplete,
  supportNow,
  mailer,
  now,
  onStripeEvent,
  creditLedger,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
} = {}) {
  const stripeClient = stripe !== undefined ? stripe : createStripe(env);
  const anthropicClient = anthropic !== undefined ? anthropic : createAnthropic(env);
  const clock = typeof now === 'function' ? now : () => Date.now();
  const verifyCache = new Map();
  function cachedVerify(sessionId) {
    const hit = verifyCache.get(sessionId);
    if (!hit) return null;
    if (clock() - hit.at >= VERIFY_CACHE_MS) {
      verifyCache.delete(sessionId);
      return null;
    }
    return { ...hit.body };
  }
  function rememberVerify(sessionId, body) {
    if (verifyCache.has(sessionId)) verifyCache.delete(sessionId);
    while (verifyCache.size >= VERIFY_CACHE_MAX) {
      const oldest = verifyCache.keys().next().value;
      verifyCache.delete(oldest);
    }
    verifyCache.set(sessionId, { at: clock(), body: { ...body } });
  }
  const ledger = creditLedger || createCreditLedger({ env });
  jobTimeoutMs(env);
  warnSupportDataDir(env);
  ledger.attach(stripeClient, { now: clock, timeoutMs: () => jobTimeoutMs(env) });
  const mailerClient = mailer !== undefined ? mailer : createSmtpMailer(env);
  const uploadLimit = limits(env).uploadBytes;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimit, files: 25 } });
  const store = jobs || createJobStore({
    env,
    onAbandonedCredit(hold) {
      return ledger.handBack(stripeClient, hold.paymentIntentId, hold.token);
    },
  });
  logPortalTokenStatus(env);
  loadRevocations(env);
  sweepStaleAcdTemps();
  const app = express();
  app.disable('x-powered-by');
  // Railway is one proxy hop. req.ip is the client that hop saw, not a header the client can rotate.
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  const accessLimiter = clientLimiter(10);
  const verifyLimiter = clientLimiter(10);
  const jobReadLimiter = clientLimiter(60);
  const jobWriteLimiter = clientLimiter(5);
  const checkoutLimiter = clientLimiter(10);
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins(env).has(origin)) return callback(null, true);
      return callback(null, false);
    },
  }));
  app.get('/health', (req, res) => {
    let unknownEvents = 0;
    try {
      unknownEvents = countUnknownEvents(env);
    } catch {
      console.error('Unknown event count failed');
    }
    let creditHandbacksPending = 0;
    let creditHandbacksDead = 0;
    let creditHandbacksRejected = 0;
    let creditLedgerOk = true;
    try {
      const ledgerHealth = ledger.health();
      creditLedgerOk = ledgerHealth.ok === true;
      creditHandbacksPending = creditLedgerOk ? ledgerHealth.pending : null;
      creditHandbacksDead = creditLedgerOk ? ledgerHealth.dead : null;
      creditHandbacksRejected = creditLedgerOk ? ledgerHealth.rejected : null;
      if (!creditLedgerOk) console.error('Credit ledger could not be read');
    } catch {
      creditLedgerOk = false;
      creditHandbacksPending = null;
      creditHandbacksDead = null;
      creditHandbacksRejected = null;
      console.error('Credit ledger could not be read');
    }
    let dataDirOk = false;
    try {
      dataDirOk = supportDataDirOk(env);
    } catch {
      console.error('Support data directory check failed');
    }
    res.json({
      status: 'ok',
      service: 'manualos-backend',
      aiEnabled: Boolean(anthropicClient),
      unknownEvents,
      creditHandbacksPending,
      creditHandbacksDead,
      creditHandbacksRejected,
      creditLedgerOk,
      supportDataDirOk: dataDirOk,
      portalTokens: portalTokensEnabled(env),
    });
  });
  app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!stripeClient || !secret) {
      console.error('Webhook rejected: STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set');
      return res.status(400).send('Webhook signature verification failed');
    }
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
      verifyCache.clear();
    } catch (err) {
      console.error('Webhook signature verification failed:', err && err.message ? err.message : err);
      return res.status(400).send('Webhook signature verification failed');
    }
    const stripeForEvent = withStripeReadCache(stripeClient);
    let decision;
    try {
      decision = await classifyStripeEvent(event, { stripe: stripeForEvent, env });
    } catch {
      console.error('Webhook classification failed', safeLogToken(event && event.type), safeLogToken(event && event.id));
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
    if (decision === 'other') return res.json({ received: true });
    if (decision !== 'ours') {
      if (isLoudUnknown(event && event.type)) {
        const object = event.data && event.data.object;
        console.error(
          'Webhook brand unknown',
          safeLogToken(event.type),
          safeLogToken(event.id),
          loggedObjectId(object && object.id),
        );
        try {
          recordUnknownEvent(env, {
            eventId: event && event.id,
            type: event && event.type,
            objectId: object && object.id,
          });
        } catch {
          console.error('Unknown event record failed');
        }
      }
      return res.json({ received: true });
    }
    try {
      if (typeof onStripeEvent === 'function') {
        await onStripeEvent(event);
      } else {
        const starterResult = await applyStarterChargeEvent(stripeForEvent, event);
        await applyPeriodAccessEvent(stripeForEvent, event, starterResult);
        await applyOverageCreditEvent(stripeForEvent, event, starterResult);
        logWebhookEvent(event);
      }
      await maybeSendCancellationConfirmation({
        event,
        stripe: stripeForEvent,
        env,
        mailer: mailerClient,
      });
    } catch (err) {
      const detail = err && err.message ? String(err.message) : 'error';
      console.error(
        'Webhook handler failed',
        safeLogToken(event && event.type),
        redactSecrets(detail),
      );
      return res.status(500).json({ error: 'Webhook handler failed' });
    }
    return res.json({ received: true });
  });
  app.use(express.json({ limit: '1mb' }));

  app.post('/create-checkout-session', checkoutLimiter, async (req, res) => {
    try {
      if (!stripeClient) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      const plan = req.body && req.body.plan;
      // #13 order is withCheckoutPolicy around checkout params. #10's withAttribution
      // wraps that result (either order). #16 applyManualosCheckout may replace the
      // price. Consent metadata is applied after that and only writes metadata, so it
      // does not set consent_collection or custom_text. CHECKOUT_REQUIRE_CONSENT gates
      // the 400; present consent is stored either way. withManualosBrand stamps brand.
      // #17 rebuilds these params from checkoutParams when a product has no tax code.
      // applyCheckoutConsent and withManualosBrand have to run after that rebuild.
      const params = withManualosBrand(applyCheckoutConsent(
        await applyManualosCheckout(
          stripeClient,
          withCheckoutPolicy(checkoutParams(plan, env), { plan, env }),
          plan,
        ),
        req.body,
        { ip: requestIp(req), now: clock(), env },
      ));
      const session = await stripeClient.checkout.sessions.create(params);
      if (!session || !session.url) {
        console.error('Stripe Checkout Session did not include a URL');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      return res.json({ url: session.url });
    } catch (err) {
      return sendError(res, err, env);
    }
  });

  mountBillingPortal(app, {
    env,
    stripe: stripeClient,
    mailer: mailerClient,
    now: clock,
    sendError,
  });

  function verifiedBearer(token) {
    if (!tokenSecret(env)) {
      throw exposed(503, 'Access tokens are unavailable.', tokenSecretProblem(env), 'portal_tokens_disabled');
    }
    const caller = verifyAccessToken(token, env);
    if (!caller) throw exposed(401, 'Access token is invalid or expired.', null, 'access_token_invalid');
    return caller;
  }

  // COMPAT(session-id): manualos.com/upload.html still posts session_id and
  // sends X-Session-Id. Accept that until LEGACY_SESSION_ID_SUNSET (UTC).
  // Authorization: Bearer is the credential after POST /access-token.
  // A bearer token wins when both are sent. Query session_id is not a download
  // credential. POST /access-token still accepts session_id after the sunset.
  function compatCaller(req) {
    const sessionId = readSessionId(req);
    if (!legacySessionAllowed(env)) {
      if (sessionId) throw exposed(401, 'session_id is no longer accepted.', null, 'session_id_retired');
      return null;
    }
    if (!sessionId) return null;
    const header = typeof req.get('x-session-id') === 'string' ? req.get('x-session-id').trim() : '';
    const bodyId = req.body && typeof req.body.session_id === 'string' ? req.body.session_id.trim() : '';
    for (const value of [bodyId, header]) {
      if (!value) continue;
      if (rawSessionBlocked(value, env)) {
        throw exposed(401, 'This sign-in was revoked. Exchange a new access token.', null, 'credential_revoked');
      }
      assertSessionId(value);
    }
    return { sessionId, customerId: '', subscriptionId: '', via: 'compat' };
  }

  function presentedCaller(req) {
    const token = bearerToken(req);
    if (token) return verifiedBearer(token);
    return compatCaller(req);
  }

  async function generationCaller(req) {
    const caller = presentedCaller(req);
    if (caller) return caller;
    throw exposed(402, 'Payment required. Provide session_id in the form body or the X-Session-Id header.');
  }

  function credentialMatches(presented, stored, storedHash) {
    if (!presented) return false;
    if (boundId(stored) && safeEqual(presented, stored)) return true;
    if (!boundId(storedHash) || typeof store.hashCredential !== 'function') return false;
    return safeEqual(store.hashCredential(presented), storedHash);
  }

  function sessionMatches(caller, job) {
    if (!caller || !job) return false;
    return credentialMatches(caller.sessionId, job.sessionId, job.sessionIdHash);
  }

  function identityMatches(caller, job) {
    if (sessionMatches(caller, job)) return true;
    if (!caller || !job) return false;
    if (credentialMatches(caller.customerId, job.customerId, job.customerIdHash)) return true;
    if (credentialMatches(caller.subscriptionId, job.subscriptionId, job.subscriptionIdHash)) return true;
    return false;
  }

  function callerNeedsLookup(caller, job) {
    if (!caller || !job || sessionMatches(caller, job)) return false;
    // Read routes must not send a raw session id to Stripe. A bearer token
    // already carries the customer and subscription ids. A new token is minted
    // at POST /access-token.
    if (caller.via !== 'token') return false;
    const customerBound = boundId(job.customerId) || boundId(job.customerIdHash);
    const subscriptionBound = boundId(job.subscriptionId) || boundId(job.subscriptionIdHash);
    if (!customerBound && !subscriptionBound) return false;
    if (customerBound && !caller.customerId) return true;
    if (subscriptionBound && !caller.subscriptionId) return true;
    return false;
  }

  // One Stripe retrieve for the whole request. Job loops must not call Stripe.
  async function hydrateCaller(caller) {
    if (!caller || caller.hydrated) return caller;
    caller.hydrated = true;
    if (!stripeClient || !caller.sessionId) {
      caller.notFound = true;
      return caller;
    }
    try {
      const access = await verifyCheckoutSession(stripeClient, caller.sessionId, env);
      if (!access || !access.plan) {
        caller.notFound = true;
        return caller;
      }
      caller.customerId = caller.customerId || access.customerId || '';
      caller.subscriptionId = caller.subscriptionId || access.subscriptionId || '';
      return caller;
    } catch (err) {
      if (isStripeNotFound(err)) {
        caller.notFound = true;
        return caller;
      }
      throw err;
    }
  }

  function rememberJob(job) {
    if (!store || typeof store.persist !== 'function') return;
    try {
      store.persist(job);
    } catch (err) {
      const code = err && err.code ? err.code : 'unknown';
      console.error(`Job record save failed (${code})`);
    }
  }

  function jobOwnerFields(access, sessionId, project) {
    const fields = { sessionId, nameSource: sourceName(project).slice(0, 200) };
    if (access && access.plan && access.plan !== 'starter') {
      if (access.customerId) fields.customerId = access.customerId;
      if (access.subscriptionId) fields.subscriptionId = access.subscriptionId;
    }
    return fields;
  }

  function listedJob(job) {
    const filename = downloadFileName(job.id);
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      expiresAt: job.expiresAt,
      filename,
      download_path: `/jobs/${job.id}/pdf`,
    };
  }

  function presentedSessionIds(req) {
    const query = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
    const bodyId = req.body && typeof req.body.session_id === 'string' ? req.body.session_id.trim() : '';
    const header = typeof req.get('x-session-id') === 'string' ? req.get('x-session-id').trim() : '';
    return [query, bodyId, header].filter(Boolean);
  }

  async function sessionForVerify(req) {
    const token = bearerToken(req);
    if (token) return verifiedBearer(token).sessionId;
    const presented = presentedSessionIds(req);
    if (!legacySessionAllowed(env)) {
      if (presented.length) throw exposed(401, 'session_id is no longer accepted.', null, 'session_id_retired');
      return '';
    }
    for (const value of presented) {
      if (rawSessionBlocked(value, env)) {
        throw exposed(401, 'This sign-in was revoked. Exchange a new access token.', null, 'credential_revoked');
      }
      assertSessionId(value);
    }
    return presented[0] || '';
  }

  app.get('/verify-session', verifyLimiter, async (req, res) => {
    try {
      const sessionId = await sessionForVerify(req);
      if (!sessionId) return res.status(400).json({ error: 'session_id is required' });
      assertSessionId(sessionId);
      const cached = cachedVerify(sessionId);
      if (cached) return res.json(cached);
      if (!stripeClient) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      let body;
      try {
        const access = await verifyCheckoutSession(stripeClient, sessionId, env);
        body = publicAccess(access);
      } catch (err) {
        if (!isStripeNotFound(err)) throw err;
        body = { valid: false, plan: null, remaining: null, billingIssue: false };
      }
      rememberVerify(sessionId, body);
      return res.json(body);
    } catch (err) {
      if (isStripeNotFound(err)) return res.json({ valid: false, plan: null, remaining: null, billingIssue: false });
      return sendError(res, err, env);
    }
  });

  app.post('/access-token', accessLimiter, async (req, res) => {
    try {
      const sessionId = req.body && typeof req.body.session_id === 'string' ? req.body.session_id.trim() : '';
      if (!sessionId) return res.status(400).json({ error: 'session_id is required.' });
      assertSessionId(sessionId);
      const gate = tokenExchangeGate(sessionId, env);
      if (!gate.ok) {
        return tooMany(res, gate.retryAfter, `Too many token exchanges. Try again in ${gate.retryAfter} seconds.`);
      }
      if (!stripeClient) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      if (!tokenSecret(env)) return rejectPortalTokens(res, env);
      let access;
      try {
        access = await verifyCheckoutSession(stripeClient, sessionId, env);
      } catch (err) {
        if (isStripeNotFound(err)) {
          return res.status(404).json({ error: 'No purchase was found for this session.', code: 'purchase_not_found' });
        }
        throw err;
      }
      if (!access || !access.plan) {
        return res.status(404).json({ error: 'No purchase was found for this session.', code: 'purchase_not_found' });
      }
      const blocked = blockForAccess(access);
      if (blocked || !access.valid) {
        return res.status(403).json({
          error: blocked ? blocked.message : 'This purchase is not active.',
          code: 'purchase_inactive',
        });
      }
      const minted = signAccessToken({
        sessionId,
        customerId: access.plan === 'starter' ? '' : (access.customerId || ''),
        subscriptionId: access.plan === 'starter' ? '' : (access.subscriptionId || ''),
      }, env);
      recordTokenExchange(sessionId, env);
      clearRawSessionBlock(sessionId, env);
      const sidHash = typeof store.hashCredential === 'function' ? store.hashCredential(sessionId) : '';
      if (sidHash) console.log('access_token_minted', sidHash.slice(0, 12));
      res.set(PRIVATE_RESPONSE);
      return res.json({
        access_token: minted.token,
        token_type: 'Bearer',
        expires_in: minted.expiresIn,
        expires_at: minted.expiresAt,
        ...publicAccess(access),
      });
    } catch (err) {
      return sendError(res, err, env);
    }
  });

  app.post('/access-token/revoke', accessLimiter, (req, res) => {
    try {
      res.set(PRIVATE_RESPONSE);
      const token = bearerToken(req);
      if (!token) return res.status(401).json({ error: 'Access token is invalid or expired.', code: 'access_token_invalid' });
      if (!tokenSecret(env)) return rejectPortalTokens(res, env);
      if (!revokeAccessToken(token, env)) {
        return res.status(401).json({ error: 'Access token is invalid or expired.', code: 'access_token_invalid' });
      }
      return res.json({ ok: true });
    } catch (err) {
      return sendError(res, err, env);
    }
  });

  async function publishManual(access, sessionId) {
    try {
      return await markFirstManualDelivered(stripeClient, access, sessionId);
    } catch (err) {
      console.error(
        'First manual delivery stamp failed',
        access && access.plan ? access.plan : 'unknown',
        redactSecrets(err && err.message),
      );
      const wrapped = new Error('Manual generation failed. Please try again.');
      wrapped.status = 500;
      wrapped.expose = true;
      throw wrapped;
    }
  }

  function blockedError(block) {
    const err = new Error(block.message);
    err.status = block.status;
    err.expose = true;
    return err;
  }

  // Live generations in this process. A Stripe count with no entry here was
  // left by a crash or redeploy, and the next run resets it instead of adding.
  const generationRuns = new Map();

  function generationRunKey(access, sessionId) {
    if (access && access.plan === 'starter' && access.paymentIntentId) return `pi:${access.paymentIntentId}`;
    return `session:${sessionId || ''}`;
  }

  function releaseGenerationRun(key) {
    const next = Math.max(0, (generationRuns.get(key) || 1) - 1);
    if (next === 0) generationRuns.delete(key);
    else generationRuns.set(key, next);
  }

  function watchGeneration(access, sessionId) {
    const timer = setInterval(() => {
      touchGenerationStarted(stripeClient, access, sessionId).catch((err) => {
        const plan = access && access.plan ? access.plan : 'unknown';
        console.error('Generation progress refresh failed', plan, redactSecrets(err && err.message ? err.message : err));
      });
    }, GENERATION_REFRESH_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  async function beginGeneration(access, sessionId) {
    const key = generationRunKey(access, sessionId);
    const active = generationRuns.get(key) || 0;
    generationRuns.set(key, active + 1);
    try {
      await markGenerationStarted(stripeClient, access, sessionId, { resetOrphans: active === 0 });
      return key;
    } catch (err) {
      releaseGenerationRun(key);
      throw err;
    }
  }

  async function runPaid(req, res, { reserveAtStart, respond }) {
    const caller = await generationCaller(req);
    verifyCache.delete(caller.sessionId);
    const access = await assertCanGenerate(stripeClient, caller.sessionId, env);
    const tooLong = overLengthField(req.body);
    if (tooLong) {
      throw exposed(400, `${tooLong.field} must be at most ${tooLong.max} characters.`, null, 'field_too_long');
    }
    const files = collectFiles(req);
    if (files.length > FILE_LIMIT) {
      throw exposed(400, 'Too many files. Send at most 25.', null, 'too_many_files');
    }
    if (!files.length) {
      const err = new Error('No file or plcContent provided');
      err.status = 400;
      err.expose = true;
      throw err;
    }
    const project = await parseUploads(files, fieldsFrom(req), env);
    if (!anthropicClient) {
      const err = new Error('Manual generation is temporarily unavailable.');
      err.status = 503;
      err.expose = true;
      err.logMessage = 'ANTHROPIC_API_KEY is not configured';
      throw err;
    }
    let credit = null;
    if (reserveAtStart && access.plan === 'starter') {
      credit = await reserveStarterCredit(stripeClient, access.paymentIntentId, env, {
        holds: ledger,
        now: clock,
      });
    }
    try {
      const result = await respond(access, files, credit, project, caller);
      return result;
    } catch (err) {
      if (credit) {
        try {
          await ledger.handBack(stripeClient, credit.paymentIntentId, credit.token);
        } catch (refundErr) {
          console.error('Starter credit hand-back failed', redactCreditLog(refundErr && refundErr.message ? refundErr.message : refundErr));
        }
      }
      throw err;
    }
  }

  app.post('/jobs', jobWriteLimiter, upload.fields([{ name: 'file', maxCount: 25 }, { name: 'files', maxCount: 25 }]), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: true,
      respond: async (access, files, credit, project, caller) => {
        const sessionId = caller.sessionId;
        const runStarted = Date.now();
        const modelCounter = { count: 0 };
        const format = projectFormat(project);
        let pageCount = 0;
        let outcomeLogged = false;
        const runKey = await beginGeneration(access, sessionId);
        const refresh = watchGeneration(access, sessionId);
        let job = null;
        let stamp = null;
        let stopped = false;
        let timer = null;
        let returned = false;
        function logOutcome(errorCode) {
          if (outcomeLogged || !job) return;
          outcomeLogged = true;
          verifyCache.delete(sessionId);
          const failed = job.status !== 'succeeded';
          logJobEvent({
            event: failed ? 'job_failed' : 'job_done',
            jobId: shortJobId(job.id) || 'unknown',
            plan: safePlan(access && access.plan),
            format,
            ms: Math.max(0, Date.now() - runStarted),
            pages: pageCount,
            modelCalls: modelCounter.count,
            errorCode: failed ? errorCode : null,
          });
        }
        function stopRefresh() {
          clearInterval(refresh);
        }
        async function returnCredit() {
          if (!credit || returned) return;
          returned = true;
          try {
            await ledger.handBack(stripeClient, credit.paymentIntentId, credit.token);
          } catch (refundErr) {
            console.error('Starter credit hand-back failed', redactCreditLog(refundErr && refundErr.message ? refundErr.message : refundErr));
          }
        }
        async function failJob(err, timeout) {
          stopRefresh();
          if (job && job.status !== 'succeeded') {
            const message = err && err.expose
              ? err.message
              : (credit
                ? CREDIT_RETURN_MESSAGE
                : (timeout
                  ? JOB_TIMEOUT_MESSAGE
                  : 'Manual generation failed. Please try again.'));
            delete job.creditHold;
            job.status = 'failed';
            job.error = message;
            job.progress = { stage: 'failed', percent: (job.progress && job.progress.percent) || 0, message };
            if (typeof store.removePdf === 'function') {
              try {
                store.removePdf(job.id);
              } catch (removeErr) {
                const code = removeErr && removeErr.code ? removeErr.code : 'unknown';
                console.error(`Job PDF removal failed (${code})`);
              }
            }
            rememberJob(job);
            logOutcome(jobErrorCode(err, timeout));
          }
          if (stamp && stamp.created) {
            await rollbackFirstManual(stripeClient, access, sessionId, stamp.delivered_at);
          }
          await clearGenerationStarted(stripeClient, access, sessionId);
          await returnCredit();
          if (!timeout && err) {
            console.error(redactSecrets(redactCustomerLog(err && err.logMessage ? err.logMessage : (err && err.message))));
          }
        }
        try {
          job = store.create(jobOwnerFields(access, sessionId, project));
          res.status(202).json(publicJob(job));
          job.status = 'running';
          job.progress = { stage: 'parsing', percent: 5, message: 'Reading project files' };
          if (credit && credit.paymentIntentId && credit.token) {
            job.creditHold = { paymentIntentId: credit.paymentIntentId, token: credit.token };
          }
          rememberJob(job);
          const abort = new AbortController();
          const timeoutMs = jobTimeoutMs(env);
          timer = scheduleTimeout(() => {
            if (stopped) return;
            stopped = true;
            stopRefresh();
            abort.abort();
            failJob(null, true).catch((err) => {
              console.error('Starter credit hand-back failed', redactCreditLog(err && err.message ? err.message : err));
            });
          }, timeoutMs);
          if (timer && typeof timer.unref === 'function') timer.unref();
          let result;
          try {
            result = await generateManual({
              files,
              project,
              fields: fieldsFrom(req),
              anthropic: countingAnthropic(anthropicClient, modelCounter),
              env,
              renderPdf,
              signal: abort.signal,
              onProgress(stage, percent, message) {
                if (stopped || !job) return;
                job.status = 'running';
                job.progress = { stage, percent, message };
              },
            });
          } catch (err) {
            if (stopped) return null;
            stopped = true;
            if (timer) cancelTimeout(timer);
            await failJob(err, false);
            return null;
          }
          if (stopped) return null;
          stopped = true;
          if (timer) cancelTimeout(timer);
          stopRefresh();
          pageCount = pdfPageCount(result && result.pdf);
          try {
            const block = await accessBlock(stripeClient, sessionId, env);
            if (block) throw blockedError(block);
            store.savePdf(job.id, result.pdf);
            if (result.pdf && result.pdf.length) stamp = await publishManual(access, sessionId);
            if (credit) {
              const committed = await commitStarterCredit(stripeClient, credit.paymentIntentId, credit.token);
              if (!committed) {
                const err = new Error('Manual generation failed. Please try again.');
                err.expose = true;
                throw err;
              }
              try {
                ledger.drop({ paymentIntentId: credit.paymentIntentId, token: credit.token });
              } catch {
                console.error('Open credit hold was not cleared');
              }
            }
            job.coverage = { units: result.coverage.units, accounted: result.coverage.accounted, percent: result.coverage.percent };
            job.warnings = result.warnings || [];
            delete job.creditHold;
            job.status = 'succeeded';
            job.progress = { stage: 'done', percent: 100, message: 'Manual is ready' };
            logOutcome(null);
          } catch (err) {
            await failJob(err, false);
          }
          if (job) delete job.creditHold;
          rememberJob(job);
        } finally {
          if (timer) cancelTimeout(timer);
          stopRefresh();
          releaseGenerationRun(runKey);
        }
        return null;
      },
    }).catch((err) => {
      if (!res.headersSent) sendError(res, err, env);
    });
  });

  async function authorizeJob(req) {
    const caller = presentedCaller(req);
    const job = store.get(req.params.id);
    if (!job) return { status: 404, body: JOB_NOT_FOUND };
    if (!caller) {
      return { status: 401, body: { error: 'Authorization is required.', code: 'authorization_required' } };
    }
    if (!sessionMatches(caller, job) && callerNeedsLookup(caller, job)) await hydrateCaller(caller);
    if (!identityMatches(caller, job)) {
      return { status: 403, body: { error: 'You do not have access to this job.', code: 'forbidden' } };
    }
    return { job, caller };
  }

  app.get('/jobs', jobReadLimiter, async (req, res) => {
    try {
      const caller = presentedCaller(req);
      if (!caller) return res.status(401).json({ error: 'Authorization is required.', code: 'authorization_required' });
      const ready = store.ready();
      if (ready.some((job) => callerNeedsLookup(caller, job))) {
        await hydrateCaller(caller);
        if (caller.notFound) {
          const owned = ready.filter((job) => sessionMatches(caller, job)).map(listedJob);
          if (!owned.length) {
            return res.status(401).json({ error: 'Authorization is required.', code: 'authorization_required' });
          }
          return res.json({ jobs: owned });
        }
      }
      return res.json({ jobs: ready.filter((job) => identityMatches(caller, job)).map(listedJob) });
    } catch (err) {
      return sendError(res, err, env);
    }
  });

  app.get('/jobs/:id', jobReadLimiter, async (req, res) => {
    try {
      const found = await authorizeJob(req);
      if (found.status) return res.status(found.status).json(found.body);
      return res.json(publicJob(found.job));
    } catch (err) {
      return sendError(res, err, env);
    }
  });

  app.get('/jobs/:id/pdf', jobReadLimiter, async (req, res) => {
    try {
      const found = await authorizeJob(req);
      if (found.status) return res.status(found.status).json(found.body);
      const job = found.job;
      const caller = found.caller;
      if (job.status !== 'succeeded') return res.status(409).json({ error: 'Manual is not ready.' });
      const sessionForBlock = job.sessionId || (caller && identityMatches(caller, job) ? caller.sessionId : '');
      if (sessionForBlock) {
        const block = await accessBlock(stripeClient, sessionForBlock, env);
        if (block) return res.status(block.status).json({ error: block.message });
      }
      const pdf = store.readPdf(job.id);
      if (!pdf) return res.status(404).json(JOB_NOT_FOUND);
      res.set({
        ...PRIVATE_RESPONSE,
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition(job.id),
        'Content-Length': pdf.length,
      });
      return res.send(pdf);
    } catch (err) {
      return sendError(res, err, env);
    }
  });

  app.post('/generate-manual', (req, res, next) => {
    if (String(env.MANUALOS_LEGACY_GENERATE || '').trim() !== '1') {
      return res.status(404).json({ error: 'not_found' });
    }
    return next();
  }, jobWriteLimiter, upload.single('file'), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: false,
      respond: async (access, files, credit, project, caller) => {
        const sessionId = caller.sessionId;
        const runKey = await beginGeneration(access, sessionId);
        const refresh = watchGeneration(access, sessionId);
        let stamp = null;
        try {
          const result = await generateManual({
            files,
            project,
            fields: fieldsFrom(req),
            anthropic: anthropicClient,
            env,
            renderPdf,
          });
          const block = await accessBlock(stripeClient, sessionId, env);
          if (block) throw blockedError(block);
          if (!result.pdf || !result.pdf.length) {
            const err = new Error('Manual generation failed. Please try again.');
            err.status = 500;
            err.expose = true;
            throw err;
          }
          stamp = await publishManual(access, sessionId);
          if (access.plan === 'starter') await recordStarterManual(stripeClient, access.paymentIntentId);
          res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': contentDisposition(''),
            'Content-Length': result.pdf.length,
            Deprecation: 'true',
            Link: '</jobs>; rel="successor-version"',
            'X-ManualOS-Replacement': 'POST /jobs',
          });
          res.send(result.pdf);
        } catch (err) {
          if (stamp && stamp.created && !res.headersSent) {
            await rollbackFirstManual(stripeClient, access, sessionId, stamp.delivered_at);
          }
          if (!res.headersSent) await clearGenerationStarted(stripeClient, access, sessionId);
          throw err;
        } finally {
          clearInterval(refresh);
          releaseGenerationRun(runKey);
        }
      },
    }).catch(next);
  });

  const support = mountSupport(app, {
    env,
    store: supportStore,
    twilioClient,
    complete: supportComplete,
    now: supportNow,
    mailer,
  });
  const listen = app.listen.bind(app);
  app.listen = function listenWithRelay(...args) {
    const server = listen(...args);
    support.attach(server);
    return server;
  };

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
      const length = typeof err.body === 'string' || Buffer.isBuffer(err.body) ? err.body.length : 0;
      console.error('Invalid request body', err.type || 'SyntaxError', `length=${length}`);
      return res.status(400).json({ error: 'invalid_json', code: 'invalid_json' });
    }
    if (err && err.type === 'entity.too.large') {
      console.error('Request body too large (payload_too_large)');
      return res.status(413).json({ error: 'Request body is too large.', code: 'payload_too_large' });
    }
    if (err && err.expose) return sendError(res, err, env);
    if (err && err.name === 'MulterError') {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File is too large.' });
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Too many files. Send at most 25.', code: 'too_many_files' });
      }
      return res.status(400).json({ error: 'Upload failed.' });
    }
    logUnexpected(err, env);
    return res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
  });
  return app;
}

function prepareListen(env = process.env, exit = process.exit) {
  const problem = frontendConfigProblem(env);
  if (!problem) return true;
  const line = `FRONTEND_URL problem: ${problem}. Checkout redirects and browser CORS will not work.`;
  if (isProduction(env)) {
    console.error(`FATAL: ${line} Refusing to start.`);
    exit(1);
    return false;
  }
  console.warn(`WARNING: ${line}`);
  return true;
}

function installShutdown(server, {
  closeBrowser: close = closeBrowser,
  exit = process.exit,
  on = (signal, listener) => process.on(signal, listener),
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout,
  forceMs = 10000,
} = {}) {
  let shuttingDown = false;
  const handler = () => new Promise((resolve) => {
    if (shuttingDown) return resolve();
    shuttingDown = true;
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) cancel(timer);
      Promise.resolve()
        .then(() => close())
        .then(() => exit(0), () => exit(0))
        .then(resolve, resolve);
    };
    timer = schedule(finish, forceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (server && typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
    if (server && typeof server.close === 'function') server.close(finish);
    else finish();
  });
  on('SIGTERM', handler);
  on('SIGINT', handler);
  on('SIGHUP', handler);
  return handler;
}

function start() {
  if (!prepareListen(process.env)) return null;
  warnIfSmtpUnconfigured(process.env);
  warnIfManagedPaymentsWithoutPortal(process.env);
  logPythonAvailability();
  const port = process.env.PORT || 3001;
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`ManualOS backend running on port ${port}`);
  });
  installShutdown(server);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, prepareListen, start, installShutdown, fieldsFrom, redactSecrets };
