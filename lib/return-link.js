const fs = require('fs');
const path = require('path');
const { frontendBase } = require('./config');
const { verifyCheckoutSession, isStripeNotFound } = require('./billing');
const { planRecord } = require('./plans');
const { atomicWriteFile } = require('./atomic-write');
const { DEFAULT_FROM } = require('./mail');

const SUBJECT = 'Your ManualOS upload link';
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const SENT_FILE = 'return-link-sent.json';
const RETAIN_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SENT = 5000;

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX) return null;
  if (/[\u0000-\u001F\u007F]/.test(email)) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

function buyerEmail(session) {
  if (!session || typeof session !== 'object') return null;
  const details = session.customer_details;
  const raw = (details && details.email) || session.customer_email || '';
  return normalizeEmail(typeof raw === 'string' ? raw : '');
}

function uploadLink(env, sessionId) {
  const base = frontendBase(env);
  if (!base || !sessionId) return null;
  return `${base}/upload.html?session_id=${encodeURIComponent(sessionId)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderUploadEmail(links) {
  const label = links.length === 1 ? 'Your upload link:' : 'Your upload links:';
  const text = `${label}\n\n${links.join('\n')}\n`;
  const html = [`<p>${escapeHtml(label)}</p>`]
    .concat(links.map((link) => `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`))
    .join('');
  return { subject: SUBJECT, text, html };
}

function fromAddress(env) {
  const configured = String((env && env.SMTP_FROM) || '').trim();
  return configured || DEFAULT_FROM;
}

function twelveMonthsAgoSeconds(nowMs) {
  const when = new Date(nowMs);
  when.setUTCMonth(when.getUTCMonth() - 12);
  return Math.floor(when.getTime() / 1000);
}

function createSentSet({ directory, now = () => Date.now() }) {
  const file = path.join(directory, SENT_FILE);
  let chain = Promise.resolve();

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const sessions = parsed && parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
      return { sessions };
    } catch (err) {
      if (!err || err.code !== 'ENOENT') console.error('return-link sent-set could not be read');
      return { sessions: {} };
    }
  }

  function write(data) {
    const cutoff = now() - RETAIN_MS;
    const entries = Object.entries(data.sessions).filter(([, ts]) => ts >= cutoff);
    entries.sort((a, b) => a[1] - b[1]);
    const kept = entries.slice(Math.max(0, entries.length - MAX_SENT));
    atomicWriteFile(file, JSON.stringify({ sessions: Object.fromEntries(kept) }));
  }

  function claimSync(sessionId) {
    const data = read();
    if (data.sessions[sessionId]) return false;
    data.sessions[sessionId] = now();
    write(data);
    return true;
  }

  function releaseSync(sessionId) {
    const data = read();
    if (!data.sessions[sessionId]) return;
    delete data.sessions[sessionId];
    write(data);
  }

  function enqueue(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    file,
    claim(sessionId) { return enqueue(() => claimSync(sessionId)); },
    release(sessionId) { return enqueue(() => releaseSync(sessionId)); },
  };
}

function sentSetDirectory({ env = {}, accountDir, jobsDir }) {
  if (accountDir) return accountDir;
  const account = String(env.MANUALOS_ACCOUNT_DIR || '').trim();
  if (account) return account;
  const data = String(env.DATA_DIR || '').trim();
  if (data) return data;
  return jobsDir;
}

async function sendLinks({ mailer, env, to, links }) {
  if (!mailer) {
    console.log('return-link email skipped: SMTP not configured');
    return false;
  }
  if (!to || !links.length) return false;
  const rendered = renderUploadEmail(links);
  await mailer.sendMail({
    from: fromAddress(env),
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  return true;
}

async function deliverSessionLink({ session, env, mailer, sentSet }) {
  const plan = planRecord(session && session.metadata && session.metadata.plan);
  if (!plan || !plan.returnLink) return;
  const sessionId = session && session.id;
  if (!sessionId || !sentSet) return;
  const to = buyerEmail(session);
  const link = uploadLink(env, sessionId);
  if (!to || !link) {
    console.log('return-link email skipped: checkout session has no email');
    return;
  }
  if (!mailer) {
    console.log('return-link email skipped: SMTP not configured');
    return;
  }
  let claimed = false;
  try {
    claimed = await sentSet.claim(sessionId);
  } catch (err) {
    console.error('return-link email failed', err && err.code ? String(err.code) : 'error');
    return;
  }
  if (!claimed) return;
  try {
    await sendLinks({ mailer, env, to, links: [link] });
  } catch (err) {
    try { await sentSet.release(sessionId); } catch { /* a later retry can claim again */ }
    console.error('return-link email failed', err && err.code ? String(err.code) : 'error');
  }
}

async function activeUploadLinks({ stripe, env, email, now }) {
  const listed = await stripe.checkout.sessions.list({
    limit: 10,
    status: 'complete',
    customer_details: { email },
    created: { gte: twelveMonthsAgoSeconds(now()) },
  });
  const sessions = listed && Array.isArray(listed.data) ? listed.data : [];
  const links = [];
  for (const session of sessions) {
    if (!session || session.payment_status !== 'paid') continue;
    const plan = planRecord(session.metadata && session.metadata.plan);
    if (!plan || !plan.returnLink) continue;
    if (!session.id) continue;
    let access;
    try {
      access = await verifyCheckoutSession(stripe, session.id, env, now());
    } catch (err) {
      if (isStripeNotFound(err)) continue;
      throw err;
    }
    if (!access.valid && !access.portal) continue;
    const link = uploadLink(env, session.id);
    if (link) links.push(link);
  }
  return links;
}

module.exports = {
  SUBJECT,
  EMAIL_MAX,
  SENT_FILE,
  normalizeEmail,
  buyerEmail,
  uploadLink,
  renderUploadEmail,
  fromAddress,
  twelveMonthsAgoSeconds,
  createSentSet,
  sentSetDirectory,
  deliverSessionLink,
  activeUploadLinks,
  sendLinks,
};
