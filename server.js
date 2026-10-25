require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const multer = require('multer');
const { createAnthropic } = require('./lib/anthropic');
const { limits } = require('./lib/limits');
const {
  allowedOrigins,
  frontendConfigProblem,
  isProduction,
} = require('./lib/config');
const {
  assertCanGenerate,
  billingPortalParams,
  checkoutParams,
  isStripeNotFound,
  publicAccess,
  recordStarterManual,
  refundStarterCredit,
  reserveStarterCredit,
  verifyCheckoutSession,
} = require('./lib/billing');
const { createSmtpMailer } = require('./lib/mail');
const { createRateLimiter } = require('./lib/rate-limit');
const {
  activeUploadLinks,
  createSentSet,
  deliverSessionLink,
  normalizeEmail,
  sendLinks,
  sentSetDirectory,
} = require('./lib/return-link');
const { generateManual } = require('./lib/pipeline');
const { parseUploads } = require('./lib/parsers');
const { logPythonAvailability } = require('./lib/parsers/acd');
const { createJobStore, newJobId, publicJob } = require('./lib/jobs/store');
const { redactCustomerLog } = require('./lib/redact-log');
const { closeBrowser } = require('./lib/manual/pdf');
function createStripe(env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !String(key).trim()) return null;
  return new Stripe(String(key).trim());
}

function sendError(res, err) {
  if (err && err.expose) {
    if (err.logMessage) console.error(redactCustomerLog(err.logMessage));
    return res.status(err.status || 500).json({ error: err.message });
  }
  console.error(redactCustomerLog(err && err.stack ? err.stack : err));
  return res.status(500).json({ error: 'Internal server error' });
}

function readSessionId(req) {
  const fromBody = req.body && typeof req.body.session_id === 'string' ? req.body.session_id.trim() : '';
  if (fromBody) return fromBody;
  const header = req.get('x-session-id');
  return typeof header === 'string' ? header.trim() : '';
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

const HOUR_MS = 60 * 60 * 1000;

function filenameOf(files) {
  const names = [];
  for (const file of files || []) {
    if (!file || typeof file.originalname !== 'string') continue;
    const cleaned = file.originalname.replace(/[\u0000-\u001F\u007F]/g, '').trim();
    if (cleaned) names.push(cleaned);
  }
  if (!names.length) return null;
  return names.join(', ').slice(0, 180);
}

function sessionHeader(req) {
  const header = req.get('x-session-id');
  return typeof header === 'string' ? header.trim() : '';
}

function ownsJob(job, sessionId) {
  return Boolean(job && sessionId && job.sessionId === sessionId);
}

const REFUND_RETRY_MS = 60 * 1000;

function trustProxyHops(env) {
  const raw = env && env.TRUST_PROXY_HOPS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(String(raw).trim());
    if (Number.isInteger(n) && n >= 0 && n <= 5) return n;
    return 0;
  }
  if (env && (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID)) return 1;
  return 0;
}

function settleStartupRefunds(stripe, store) {
  return async function retryRefunds() {
    const due = store && typeof store.refundsDue === 'function' ? store.refundsDue() : [];
    for (const job of due) {
      const credit = job && job.credit;
      if (!credit || !credit.paymentIntentId || !credit.token) continue;
      try {
        if (!stripe) {
          const err = new Error('stripe missing');
          err.code = 'stripe_missing';
          throw err;
        }
        await refundStarterCredit(stripe, credit.paymentIntentId, credit.token, credit.jobId || job.id);
        if (typeof store.markCreditRefunded === 'function') store.markCreditRefunded(job);
      } catch (err) {
        console.error('Starter credit refund failed', err && err.code ? String(err.code) : 'error');
      }
    }
  };
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
      console.log(event.type, object.id, object.payment_status);
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
    case 'radar.early_fraud_warning.created':
      console.log(event.type, object.id);
      break;
    default:
      console.log('Unhandled event:', event.type);
  }
}

function createApp({ env = process.env, stripe, anthropic, renderPdf, jobs, now, mailer, accountDir } = {}) {
  const stripeClient = stripe !== undefined ? stripe : createStripe(env);
  const anthropicClient = anthropic !== undefined ? anthropic : createAnthropic(env);
  const clock = typeof now === 'function' ? now : () => Date.now();
  const mailerClient = mailer !== undefined ? mailer : createSmtpMailer(env);
  const uploadLimit = limits(env).uploadBytes;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimit, files: 25 } });
  const store = jobs || createJobStore({ env, now: clock });
  const sentSet = createSentSet({
    directory: sentSetDirectory({ env, accountDir, jobsDir: store.dir }),
    now: clock,
  });
  const ipLimiter = createRateLimiter({ limit: 10, windowMs: HOUR_MS, now: clock });
  const emailLimiter = createRateLimiter({ limit: 3, windowMs: HOUR_MS, now: clock });
  const retryRefunds = settleStartupRefunds(stripeClient, store);
  const ready = retryRefunds();
  const pending = new Set();
  function track(promise) {
    const run = Promise.resolve(promise).catch((err) => {
      console.error('return-link email failed', err && err.code ? String(err.code) : 'error');
    });
    pending.add(run);
    run.finally(() => pending.delete(run));
    return run;
  }
  const app = express();
  app.ready = ready;
  app.retryRefunds = retryRefunds;
  app.settle = () => Promise.all(Array.from(pending));
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHops(env));
  app.use((req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  const refundTimer = setInterval(() => {
    retryRefunds().catch(() => {});
  }, REFUND_RETRY_MS);
  if (refundTimer && typeof refundTimer.unref === 'function') refundTimer.unref();
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins(env).has(origin)) return callback(null, true);
      return callback(null, false);
    },
  }));
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'manualos-backend', aiEnabled: Boolean(anthropicClient) });
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
    } catch (err) {
      console.error('Webhook signature verification failed:', err && err.message ? err.message : err);
      return res.status(400).send('Webhook signature verification failed');
    }
    logWebhookEvent(event);
    res.json({ received: true });
    if (event.type === 'checkout.session.completed') {
      track(deliverSessionLink({
        session: event.data && event.data.object,
        env,
        mailer: mailerClient,
        sentSet,
      }));
    }
    return;
  });
  app.use(express.json({ limit: '1mb' }));

  app.post('/create-checkout-session', async (req, res) => {
    try {
      if (!stripeClient) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      const plan = req.body && req.body.plan;
      const params = checkoutParams(plan, env);
      const session = await stripeClient.checkout.sessions.create(params);
      if (!session || !session.url) {
        console.error('Stripe Checkout Session did not include a URL');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      return res.json({ url: session.url });
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.get('/verify-session', async (req, res) => {
    try {
      const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
      if (!sessionId) return res.status(400).json({ error: 'session_id is required' });
      if (!stripeClient) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      const access = await verifyCheckoutSession(stripeClient, sessionId, env, clock());
      return res.json(publicAccess(access));
    } catch (err) {
      if (isStripeNotFound(err)) {
        return res.json(publicAccess({ valid: false, plan: null, remaining: null, portal: false }));
      }
      return sendError(res, err);
    }
  });

  app.post('/access-link', async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!ipLimiter.allow(ip)) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'A valid email is required.' });
    if (!emailLimiter.allow(email)) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    res.status(202).json({ ok: true });
    track((async () => {
      try {
        if (!mailerClient) {
          console.log('return-link email skipped: SMTP not configured');
        } else if (!stripeClient) {
          console.error('return-link email skipped: STRIPE_SECRET_KEY is not set');
        } else {
          const links = await activeUploadLinks({ stripe: stripeClient, env, email, now: clock });
          if (links.length) await sendLinks({ mailer: mailerClient, env, to: email, links });
        }
      } catch (err) {
        console.error('return-link email failed', err && err.code ? String(err.code) : 'error');
      }
    })());
    return;
  });

  app.post('/billing-portal', async (req, res) => {
    try {
      const sessionId = req.body && typeof req.body.session_id === 'string' ? req.body.session_id.trim() : '';
      if (!sessionId) return res.status(400).json({ error: 'session_id is required' });
      if (!stripeClient) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      let session;
      try {
        session = await stripeClient.checkout.sessions.retrieve(sessionId);
      } catch (err) {
        if (isStripeNotFound(err)) {
          return res.status(402).json({ error: 'Payment required. This checkout session is not valid.' });
        }
        throw err;
      }
      const params = billingPortalParams(session, env);
      const portal = await stripeClient.billingPortal.sessions.create(params);
      if (!portal || !portal.url) {
        console.error('Stripe Billing Portal session did not include a URL');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      return res.json({ url: portal.url });
    } catch (err) {
      return sendError(res, err);
    }
  });

  async function runPaid(req, res, { reserveAtStart, respond }) {
    const access = await assertCanGenerate(stripeClient, readSessionId(req), env, clock());
    const files = collectFiles(req);
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
      credit = await reserveStarterCredit(stripeClient, access.paymentIntentId, env, newJobId());
    }
    try {
      const result = await respond(access, files, credit, project);
      return result;
    } catch (err) {
      if (credit) {
        try {
          await refundStarterCredit(stripeClient, credit.paymentIntentId, credit.token, credit.jobId);
        } catch (refundErr) {
          console.error('Starter credit refund failed', refundErr && refundErr.code ? String(refundErr.code) : 'error');
        }
      }
      throw err;
    }
  }

  app.post('/jobs', upload.fields([{ name: 'file', maxCount: 25 }, { name: 'files', maxCount: 25 }]), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: true,
      respond: async (access, files, credit, project) => {
        const job = store.create({
          id: credit ? credit.jobId : undefined,
          sessionId: readSessionId(req),
          filename: filenameOf(files),
          credit: credit ? { paymentIntentId: credit.paymentIntentId, token: credit.token, jobId: credit.jobId } : null,
        });
        const queued = publicJob(job);
        job.status = 'running';
        job.progress = { stage: 'parsing', percent: 5, message: 'Reading project files' };
        if (typeof store.commit === 'function') store.commit(job);
        res.status(202).json(queued);
        try {
          const result = await generateManual({
            files,
            project,
            fields: fieldsFrom(req),
            anthropic: anthropicClient,
            env,
            renderPdf,
            onProgress(stage, percent, message) {
              job.status = 'running';
              job.progress = { stage, percent, message };
            },
          });
          store.savePdf(job.id, result.pdf);
          job.coverage = { units: result.coverage.units, accounted: result.coverage.accounted, percent: result.coverage.percent };
          job.warnings = result.warnings || [];
          job.status = 'succeeded';
          job.progress = { stage: 'done', percent: 100, message: 'Manual is ready' };
          job.credit = null;
          job.needsCreditRefund = false;
        } catch (err) {
          if (credit) {
            try {
              await refundStarterCredit(stripeClient, credit.paymentIntentId, credit.token, credit.jobId);
              job.credit = null;
              job.needsCreditRefund = false;
            } catch (refundErr) {
              job.needsCreditRefund = true;
              console.error('Starter credit refund failed', refundErr && refundErr.code ? String(refundErr.code) : 'error');
            }
          }
          console.error(redactCustomerLog(err && err.logMessage ? err.logMessage : (err && err.message)));
          job.status = 'failed';
          job.error = err && err.expose ? err.message : 'Manual generation failed. Please try again.';
          job.progress = { stage: 'failed', percent: job.progress.percent || 0, message: job.error };
        }
        if (typeof store.commit === 'function') store.commit(job);
        return null;
      },
    }).catch((err) => {
      if (!res.headersSent) sendError(res, err);
    });
  });

  app.get('/jobs', (req, res) => {
    if (!Object.prototype.hasOwnProperty.call(req.query, 'mine')) {
      return res.status(404).json({ error: 'Job not found or expired.' });
    }
    const sessionId = sessionHeader(req);
    if (!sessionId) return res.status(404).json({ error: 'Job not found or expired.' });
    const mine = typeof store.listForSession === 'function' ? store.listForSession(sessionId) : [];
    return res.json({ jobs: mine });
  });

  app.get('/jobs/:id', (req, res) => {
    const job = store.get(req.params.id);
    if (!ownsJob(job, sessionHeader(req))) return res.status(404).json({ error: 'Job not found or expired.' });
    return res.json(publicJob(job));
  });

  app.get('/jobs/:id/pdf', (req, res) => {
    const job = store.get(req.params.id);
    if (!ownsJob(job, sessionHeader(req))) return res.status(404).json({ error: 'Job not found or expired.' });
    if (job.status !== 'succeeded') return res.status(409).json({ error: 'Manual is not ready.' });
    const pdf = store.readPdf(job.id);
    if (!pdf) return res.status(404).json({ error: 'Job not found or expired.' });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="manual.pdf"',
      'Content-Length': pdf.length,
    });
    return res.send(pdf);
  });

  app.post('/generate-manual', upload.single('file'), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: false,
      respond: async (access, files, credit, project) => {
        const result = await generateManual({
          files,
          project,
          fields: fieldsFrom(req),
          anthropic: anthropicClient,
          env,
          renderPdf,
        });
        if (access.plan === 'starter') await recordStarterManual(stripeClient, access.paymentIntentId);
        res.set({
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="manual.pdf"',
          'Content-Length': result.pdf.length,
          Deprecation: 'true',
          Link: '</jobs>; rel="successor-version"',
          'X-ManualOS-Replacement': 'POST /jobs',
        });
        res.send(result.pdf);
      },
    }).catch(next);
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.expose) return sendError(res, err);
    console.error(redactCustomerLog(err && err.stack ? err.stack : err));
    if (err && err.name === 'MulterError') {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : 'Upload failed.';
      return res.status(400).json({ error: message });
    }
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    if (err && err.type === 'entity.too.large') return res.status(400).json({ error: 'File is too large.' });
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function prepareListen(env = process.env, exit = process.exit) {
  const problem = frontendConfigProblem(env);
  if (!String(env.DATA_DIR || '').trim() && !problem) {
    console.warn('WARNING: DATA_DIR is not set. Job records stay on local disk, so a redeploy cannot refund an in-flight Starter credit.');
  }
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

module.exports = { createApp, prepareListen, start, installShutdown, fieldsFrom, trustProxyHops };
