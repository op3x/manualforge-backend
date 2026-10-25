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
  publicAccess,
  recordStarterManual,
  refundStarterCredit,
  reserveStarterCredit,
  verifyCheckoutSession,
} = require('./lib/billing');
const { withCheckoutPolicy } = require('./lib/checkoutPolicy');
const { generateManual } = require('./lib/pipeline');
const { generatePackage } = require('./lib/documents/generate');
const { resolveDocumentBranding } = require('./lib/documents/branding');
const { markDeliveredManual } = require('./lib/delivery-hook');
const {
  selectionFromRequest,
  requestsExtras,
  planAllowsExtraDocuments,
  UPGRADE_MESSAGE,
} = require('./lib/documents/selection');
const { safeFileName } = require('./lib/documents/files');
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
  supportStore,
  twilioClient,
  supportComplete,
  supportNow,
  mailer,
  markDelivered,
} = {}) {
  const stripeClient = stripe !== undefined ? stripe : createStripe(env);
  const anthropicClient = anthropic !== undefined ? anthropic : createAnthropic(env);
  const uploadLimit = limits(env).uploadBytes;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimit, files: 25 } });
  const store = jobs || createJobStore({ env });
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
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'manualos-backend', aiEnabled: Boolean(anthropicClient) });
  });
  app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
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
    return res.json({ received: true });
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

  const deliverManual = markDelivered || markDeliveredManual;

  async function publishManual(access, sessionId) {
    try {
      return await deliverManual(stripeClient, access, sessionId);
    } catch (err) {
      console.error('First manual delivery stamp failed', access && access.plan ? access.plan : 'unknown');
      const wrapped = new Error('Manual generation failed. Please try again.');
      wrapped.status = 500;
      wrapped.expose = true;
      throw wrapped;
    }
  }

  async function runPaid(req, res, { reserveAtStart, respond, documents }) {
    const access = await assertCanGenerate(stripeClient, readSessionId(req), env);
    const files = collectFiles(req);
    if (!files.length) {
      const err = new Error('No file or plcContent provided');
      err.status = 400;
      err.expose = true;
      throw err;
    }
    const project = await parseUploads(files, fieldsFrom(req), env);
    let selection = null;
    if (documents) {
      selection = selectionFromRequest(req);
      if (selection.requestsExtras && !planAllowsExtraDocuments(access.plan)) {
        const err = new Error(UPGRADE_MESSAGE);
        err.status = 403;
        err.expose = true;
        throw err;
      }
    } else if (requestsExtras(req)) {
      const err = new Error('Additional documents are available from POST /jobs.');
      err.status = 400;
      err.expose = true;
      throw err;
    }
    if (!anthropicClient) {
      const err = new Error('Manual generation is temporarily unavailable.');
      err.status = 503;
      err.expose = true;
      err.logMessage = 'ANTHROPIC_API_KEY is not configured';
      throw err;
    }
    let credit = null;
    if (reserveAtStart && access.plan === 'starter') {
      credit = await reserveStarterCredit(stripeClient, access.paymentIntentId, env);
    }
    try {
      // #6 passes branding and #7 passes the document selection. Both travel together.
      const branding = resolveDocumentBranding(access);
      const result = await respond(access, files, credit, project, selection, branding);
      return result;
    } catch (err) {
      if (credit) {
        try {
          await refundStarterCredit(stripeClient, credit.paymentIntentId, credit.token);
        } catch (refundErr) {
          console.error('Starter credit refund failed', refundErr && refundErr.message ? refundErr.message : refundErr);
        }
      }
      throw err;
    }
  }

  app.post('/jobs', upload.fields([{ name: 'file', maxCount: 25 }, { name: 'files', maxCount: 25 }]), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: true,
      documents: true,
      respond: async (access, files, credit, project, selection, branding) => {
        const job = store.create();
        job.documents = selection.entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          kind: entry.kind,
          status: entry.status,
          reason: entry.reason,
        }));
        res.status(202).json(publicJob(job));
        job.status = 'running';
        job.progress = { stage: 'parsing', percent: 5, message: 'Reading project files' };
        try {
          const result = await generatePackage({
            files,
            project,
            fields: fieldsFrom(req),
            anthropic: anthropicClient,
            env,
            renderPdf,
            branding: branding || resolveDocumentBranding(access),
            selection,
            onProgress(stage, percent, message) {
              job.status = 'running';
              job.progress = { stage, percent, message };
            },
          });
          for (const output of result.outputs) store.saveArtifact(job.id, output.id, output.pdf);
          if (result.combined) store.saveArtifact(job.id, 'combined', result.combined);
          if (result.zip) store.saveArtifact(job.id, 'zip', result.zip);
          const manualReady = (result.outputs || []).some((output) => output.kind === 'manual' && output.pdf && output.pdf.length);
          if (manualReady) await publishManual(access, readSessionId(req));
          job.documents = result.documents;
          job.coverage = result.coverage
            ? { units: result.coverage.units, accounted: result.coverage.accounted, percent: result.coverage.percent }
            : null;
          job.warnings = result.warnings || [];
          job.status = 'succeeded';
          job.progress = {
            stage: 'done',
            percent: 100,
            message: selection.requestsExtras ? 'Documents are ready' : 'Manual is ready',
          };
        } catch (err) {
          if (credit) {
            try {
              await refundStarterCredit(stripeClient, credit.paymentIntentId, credit.token);
            } catch (refundErr) {
              console.error('Starter credit refund failed', refundErr && refundErr.message ? refundErr.message : refundErr);
            }
          }
          console.error(redactCustomerLog(err && err.logMessage ? err.logMessage : (err && err.message)));
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

  function sendFile(res, body, type, filename) {
    res.set({
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': body.length,
    });
    return res.send(body);
  }

  function readyJob(req, res) {
    const job = store.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found or expired.' });
      return null;
    }
    if (job.status !== 'succeeded') {
      res.status(409).json({ error: 'Document is not ready.' });
      return null;
    }
    return job;
  }

  app.get('/jobs/:id/pdf', (req, res) => {
    const job = store.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
    if (job.status !== 'succeeded') return res.status(409).json({ error: 'Manual is not ready.' });
    const pdf = store.readPdf(job.id);
    if (!pdf) return res.status(404).json({ error: 'This job does not include the operating manual.' });
    return sendFile(res, pdf, 'application/pdf', 'manual.pdf');
  });

  app.get('/jobs/:id/combined.pdf', (req, res) => {
    const job = readyJob(req, res);
    if (!job) return undefined;
    const pdf = store.readArtifact(job.id, 'combined');
    if (!pdf) return res.status(404).json({ error: 'Combined document is not available.' });
    return sendFile(res, pdf, 'application/pdf', 'all-documents.pdf');
  });

  app.get('/jobs/:id/documents.zip', (req, res) => {
    const job = readyJob(req, res);
    if (!job) return undefined;
    const zip = store.readArtifact(job.id, 'zip');
    if (!zip) return res.status(404).json({ error: 'Document archive is not available.' });
    return sendFile(res, zip, 'application/zip', 'documents.zip');
  });

  app.get('/jobs/:id/documents/:docId', (req, res) => {
    const job = readyJob(req, res);
    if (!job) return undefined;
    const docId = String(req.params.docId || '');
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(docId)) return res.status(404).json({ error: 'Document not found.' });
    const listed = (job.documents || []).find((doc) => doc.id === docId);
    if (!listed || listed.status !== 'ready') return res.status(404).json({ error: 'That document was not generated.' });
    let pdf;
    try {
      pdf = store.readArtifact(job.id, docId);
    } catch (err) {
      if (err && err.expose) return res.status(404).json({ error: 'Document not found.' });
      throw err;
    }
    if (!pdf) return res.status(404).json({ error: 'Document not found or expired.' });
    return sendFile(res, pdf, 'application/pdf', safeFileName(listed.title, docId));
  });

  app.post('/generate-manual', upload.single('file'), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: false,
      respond: async (access, files, credit, project, selection, branding) => {
        const result = await generateManual({
          files,
          project,
          fields: fieldsFrom(req),
          anthropic: anthropicClient,
          env,
          renderPdf,
          branding: branding || resolveDocumentBranding(access),
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
