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
  accessBlock,
  assertCanGenerate,
  checkoutParams,
  isStripeNotFound,
  publicAccess,
  commitStarterCredit,
  recordStarterManual,
  reserveStarterCredit,
  verifyCheckoutSession,
} = require('./lib/billing');
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
const { createCreditLedger, redactCreditLog } = require('./lib/credit-ledger');
const { JOB_TIMEOUT_MESSAGE, jobTimeoutMs } = require('./lib/job-timeout');
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

function sendError(res, err) {
  if (err && err.expose) {
    if (err.logMessage) console.error(redactSecrets(redactCustomerLog(err.logMessage)));
    return res.status(err.status || 500).json({ error: err.message });
  }
  console.error(redactSecrets(redactCustomerLog(err && err.stack ? err.stack : err)));
  return res.status(500).json({ error: 'Internal server error' });
}

function redactSecrets(value) {
  return String(value || '').replace(/sk_(live|test)_[A-Za-z0-9]+|rk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g, '[redacted]');
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
  const ledger = creditLedger || createCreditLedger({ env });
  jobTimeoutMs(env);
  ledger.attach(stripeClient, { now: clock, timeoutMs: () => jobTimeoutMs(env) });
  const mailerClient = mailer !== undefined ? mailer : createSmtpMailer(env);
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
    let unknownEvents = 0;
    try {
      unknownEvents = countUnknownEvents(env);
    } catch {
      console.error('Unknown event count failed');
    }
    let creditHandbacksPending = 0;
    try {
      creditHandbacksPending = ledger.pending();
    } catch {
      console.error('Credit hand-back count failed');
    }
    res.json({
      status: 'ok',
      service: 'manualos-backend',
      aiEnabled: Boolean(anthropicClient),
      unknownEvents,
      creditHandbacksPending,
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
          safeLogToken(object && object.id),
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
        detail.replace(/sk_(live|test)_[A-Za-z0-9]+|rk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g, '[redacted]'),
      );
      return res.status(500).json({ error: 'Webhook handler failed' });
    }
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
      return sendError(res, err);
    }
  });

  mountBillingPortal(app, {
    env,
    stripe: stripeClient,
    mailer: mailerClient,
    now: clock,
    sendError,
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
    if (reserveAtStart && access.plan === 'starter') {
      credit = await reserveStarterCredit(stripeClient, access.paymentIntentId, env, {
        holds: ledger,
        now: clock,
      });
    }
    try {
      const result = await respond(access, files, credit, project);
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

  app.post('/jobs', upload.fields([{ name: 'file', maxCount: 25 }, { name: 'files', maxCount: 25 }]), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: true,
      respond: async (access, files, credit, project) => {
        const sessionId = readSessionId(req);
        const runKey = await beginGeneration(access, sessionId);
        const refresh = watchGeneration(access, sessionId);
        let job = null;
        let stamp = null;
        let stopped = false;
        let timer = null;
        let returned = false;
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
          if (stamp && stamp.created) {
            await rollbackFirstManual(stripeClient, access, sessionId, stamp.delivered_at);
          }
          await clearGenerationStarted(stripeClient, access, sessionId);
          await returnCredit();
          if (!job) return;
          const message = timeout
            ? JOB_TIMEOUT_MESSAGE
            : (err && err.expose ? err.message : 'Manual generation failed. Please try again.');
          job.status = 'failed';
          job.error = message;
          job.progress = { stage: 'failed', percent: (job.progress && job.progress.percent) || 0, message };
          if (!timeout) {
            console.error(redactSecrets(redactCustomerLog(err && err.logMessage ? err.logMessage : (err && err.message))));
          }
        }
        try {
          job = store.create({ sessionId });
          res.status(202).json(publicJob(job));
          job.status = 'running';
          job.progress = { stage: 'parsing', percent: 5, message: 'Reading project files' };
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
              anthropic: anthropicClient,
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
            job.status = 'succeeded';
            job.progress = { stage: 'done', percent: 100, message: 'Manual is ready' };
          } catch (err) {
            await failJob(err, false);
          }
        } finally {
          if (timer) cancelTimeout(timer);
          stopRefresh();
          releaseGenerationRun(runKey);
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

  app.get('/jobs/:id/pdf', async (req, res) => {
    try {
      const job = store.get(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
      if (job.status !== 'succeeded') return res.status(409).json({ error: 'Manual is not ready.' });
      if (job.sessionId) {
        const block = await accessBlock(stripeClient, job.sessionId, env);
        if (block) return res.status(block.status).json({ error: block.message });
      }
      const pdf = store.readPdf(job.id);
      if (!pdf) return res.status(404).json({ error: 'Job not found or expired.' });
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="manual.pdf"',
        'Content-Length': pdf.length,
      });
      return res.send(pdf);
    } catch (err) {
      return sendError(res, err);
    }
  });

  app.post('/generate-manual', upload.single('file'), (req, res, next) => {
    runPaid(req, res, {
      reserveAtStart: false,
      respond: async (access, files, credit, project) => {
        const sessionId = readSessionId(req);
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
            'Content-Disposition': 'attachment; filename="manual.pdf"',
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
    if (err && err.expose) return sendError(res, err);
    console.error(redactSecrets(redactCustomerLog(err && err.stack ? err.stack : err)));
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

module.exports = { createApp, prepareListen, start, installShutdown, fieldsFrom };
