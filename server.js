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
  checkoutParams,
  isStripeNotFound,
  overageCheckoutParams,
  publicAccess,
  recordStarterManual,
  refundStarterCredit,
  reserveStarterCredit,
  verifyCheckoutSession,
} = require('./lib/billing');
const { withCheckoutPolicy } = require('./lib/checkoutPolicy');
const {
  applyWebhookEvent,
  assertOverageConfigured,
  refundIntegratorCredit,
  reserveIntegratorCredit,
} = require('./lib/integrator');
const { createAccountStore } = require('./lib/accounts/store');
const { documentBranding, normalizeCompanyName, publicBranding, validateLogo } = require('./lib/branding');
const { LOGO_MAX_BYTES } = require('./lib/config');
const { exposed } = require('./lib/errors');
const { generateManual } = require('./lib/pipeline');
const { parseUploads } = require('./lib/parsers');
const { logPythonAvailability } = require('./lib/parsers/acd');
const { createJobStore, publicJob } = require('./lib/jobs/store');
const { redactCustomerLog } = require('./lib/redact-log');
const { closeBrowser } = require('./lib/manual/pdf');
const { mountSupport } = require('./lib/support/http');

function createStripe(env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !String(key).trim()) return null;
  return new Stripe(String(key).trim());
}

function logSafe(value) {
  return String(redactCustomerLog(value))
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9]+/g, '[redacted]');
}

function sendError(res, err) {
  if (err && err.expose) {
    if (err.logMessage) console.error(logSafe(err.logMessage));
    const body = { error: err.message };
    if (err.details && typeof err.details === 'object') {
      for (const [key, value] of Object.entries(err.details)) body[key] = value;
    }
    return res.status(err.status || 500).json(body);
  }
  console.error(logSafe(err && err.stack ? err.stack : err));
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

function createApp({
  env = process.env,
  stripe,
  anthropic,
  renderPdf,
  jobs,
  accounts,
  supportStore,
  twilioClient,
  supportComplete,
  supportNow,
  mailer,
} = {}) {
  const stripeClient = stripe !== undefined ? stripe : createStripe(env);
  const anthropicClient = anthropic !== undefined ? anthropic : createAnthropic(env);
  const uploadLimit = limits(env).uploadBytes;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimit, files: 25 } });
  const brandingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LOGO_MAX_BYTES, files: 1 } });
  const store = jobs || createJobStore({ env });
  const accountStore = accounts || createAccountStore({ env });
  const app = express();
  app.disable('x-powered-by');
  // Railway is one proxy hop. req.ip is the client that hop saw, not a header the client can rotate.
  app.set('trust proxy', 1);
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins(env).has(origin)) return callback(null, true);
      return callback(null, false);
    },
  }));
  function loadBranding(access) {
    if (!access || access.plan !== 'integrator' || !access.customerId) return null;
    try {
      return documentBranding(accountStore.readBranding(access.customerId));
    } catch (err) {
      console.error(logSafe(err && err.expose ? err.message : 'Integrator branding could not be read'));
      return null;
    }
  }

  async function releaseCredit(credit) {
    if (!credit || credit.kind !== 'integrator') return null;
    return refundIntegratorCredit(stripeClient, credit.subscriptionId, credit.token);
  }

  async function refundFailedJob(credit) {
    const failures = [];
    try {
      await releaseCredit(credit);
    } catch (err) {
      failures.push(err);
    }
    try {
      const starterCredit = credit && credit.kind !== 'integrator' ? credit : null;
      await refundStarterCredit(
        stripeClient,
        starterCredit && starterCredit.paymentIntentId,
        starterCredit && starterCredit.token,
      );
    } catch (err) {
      failures.push(err);
    }
    for (const err of failures) {
      console.error(logSafe(err && err.message ? err.message : 'Credit refund failed'));
    }
  }

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
      console.error(logSafe(`Webhook signature verification failed: ${err && err.message ? err.message : err}`));
      return res.status(400).send('Webhook signature verification failed');
    }
    try {
      await applyWebhookEvent(stripeClient, event, env);
    } catch (err) {
      const detail = err && err.stack ? err.stack : (err && err.message ? err.message : err);
      console.error(logSafe(`Webhook handler failed (${event && event.type ? event.type : 'unknown'}): ${detail}`));
      return res.status(500).json({ error: 'Webhook handler failed' });
    }
    logWebhookEvent(event);
    return res.json({ received: true });
  });
  app.use(express.json({ limit: '1mb' }));

  app.post('/create-checkout-session', async (req, res) => {
    try {
      const body = req.body || {};
      const plan = body.plan;
      let params;
      if (plan === 'integrator_overage') {
        const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
        assertOverageConfigured(env);
        if (!stripeClient) {
          console.error('STRIPE_SECRET_KEY is not set');
          return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
        }
        if (!sessionId) throw exposed(400, 'session_id is required');
        let access;
        try {
          access = await verifyCheckoutSession(stripeClient, sessionId, env);
        } catch (err) {
          if (isStripeNotFound(err)) throw exposed(402, 'Payment required. This checkout session is not valid.');
          throw err;
        }
        if (!access.valid || access.plan !== 'integrator' || !access.subscriptionId) {
          throw exposed(402, 'Payment required. This checkout session is not an active Integrator plan.');
        }
        params = overageCheckoutParams(env, {
          subscriptionId: access.subscriptionId,
          customerId: access.customerId,
          sessionId,
        });
      } else {
        params = checkoutParams(plan, env, { interval: body.interval });
        if (!stripeClient) {
          console.error('STRIPE_SECRET_KEY is not set');
          return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
        }
      }
      const session = await stripeClient.checkout.sessions.create(withCheckoutPolicy(params, { plan, env }));
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
      const access = await verifyCheckoutSession(stripeClient, sessionId, env);
      return res.json(publicAccess(access));
    } catch (err) {
      if (isStripeNotFound(err)) return res.json({ valid: false, plan: null, remaining: null });
      return sendError(res, err);
    }
  });

  async function runPaid(req, res, { reserveAtStart, respond }) {
    const access = await assertCanGenerate(stripeClient, readSessionId(req), env);
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
    if (access.plan === 'integrator') {
      credit = await reserveIntegratorCredit(stripeClient, access.subscriptionId, env);
    } else if (reserveAtStart && access.plan === 'starter') {
      credit = await reserveStarterCredit(stripeClient, access.paymentIntentId, env);
    }
    const branding = loadBranding(access);
    try {
      const result = await respond(access, files, credit, project, branding);
      return result;
    } catch (err) {
      await refundFailedJob(credit);
      throw err;
    }
  }

  app.post('/jobs', upload.fields([{ name: 'file', maxCount: 25 }, { name: 'files', maxCount: 25 }]), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: true,
      respond: async (access, files, credit, project, branding) => {
        const job = store.create();
        res.status(202).json(publicJob(job));
        job.status = 'running';
        job.progress = { stage: 'parsing', percent: 5, message: 'Reading project files' };
        try {
          const result = await generateManual({
            files,
            project,
            fields: fieldsFrom(req),
            anthropic: anthropicClient,
            env,
            renderPdf,
            branding,
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
        } catch (err) {
          await refundFailedJob(credit);
          console.error(logSafe(err && err.logMessage ? err.logMessage : (err && err.message)));
          job.status = 'failed';
          job.error = err && err.expose ? err.message : 'Manual generation failed. Please try again.';
          job.progress = { stage: 'failed', percent: job.progress.percent || 0, message: job.error };
        }
        return null;
      },
    }).catch((err) => {
      if (!res.headersSent) sendError(res, err);
    });
  });

  app.get('/jobs/:id', (req, res) => {
    const job = store.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
    return res.json(publicJob(job));
  });

  app.get('/jobs/:id/pdf', (req, res) => {
    const job = store.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
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
      respond: async (access, files, credit, project, branding) => {
        const result = await generateManual({
          files,
          project,
          fields: fieldsFrom(req),
          anthropic: anthropicClient,
          env,
          renderPdf,
          branding,
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

  async function requireIntegrator(req) {
    const fromQuery = req.query && typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
    const sessionId = readSessionId(req) || fromQuery;
    if (!sessionId) throw exposed(400, 'session_id is required');
    if (!stripeClient) {
      console.error('STRIPE_SECRET_KEY is not set');
      throw exposed(500, 'Checkout is temporarily unavailable.', 'STRIPE_SECRET_KEY is not set');
    }
    let access;
    try {
      access = await verifyCheckoutSession(stripeClient, sessionId, env);
    } catch (err) {
      if (isStripeNotFound(err)) throw exposed(402, 'Payment required. This checkout session is not valid.');
      throw err;
    }
    if (!access.valid || access.plan !== 'integrator' || !access.customerId) {
      throw exposed(402, 'Payment required. This checkout session is not an active Integrator plan.');
    }
    return access;
  }

  app.get('/integrator/branding', async (req, res) => {
    try {
      const access = await requireIntegrator(req);
      return res.json(publicBranding(accountStore.readBranding(access.customerId)));
    } catch (err) {
      return sendError(res, err);
    }
  });

  function saveBranding(req, res) {
    Promise.resolve().then(async () => {
      const access = await requireIntegrator(req);
      const companyName = normalizeCompanyName(req.body && req.body.company_name);
      const logo = req.file ? validateLogo(req.file.buffer) : undefined;
      if (companyName === undefined && logo === undefined) throw exposed(400, 'Provide a company name or a logo.');
      const saved = accountStore.writeBranding(access.customerId, { companyName, logo });
      return res.json(publicBranding(saved));
    }).catch((err) => sendError(res, err));
  }

  app.post('/integrator/branding', (req, res, next) => {
    const type = String(req.headers['content-type'] || '');
    if (type.includes('multipart/form-data')) {
      return brandingUpload.single('logo')(req, res, (err) => {
        if (err) return next(err);
        return saveBranding(req, res);
      });
    }
    return saveBranding(req, res);
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
    if (err && err.expose) return sendError(res, err);
    console.error(logSafe(err && err.stack ? err.stack : err));
    if (err && err.name === 'MulterError') {
      const logoRoute = req.path === '/integrator/branding';
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? (logoRoute ? 'Logo file is too large.' : 'File is too large.')
        : 'Upload failed.';
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

module.exports = { createApp, prepareListen, start, installShutdown, fieldsFrom };
