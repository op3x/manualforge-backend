const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const { WebSocketServer, WebSocket } = require('ws');
const { createSupportStore } = require('./store');
const {
  aiConfigured,
  clip,
  completeOpenAI,
  e164,
  formatCustomerSms,
  formatEscalationSms,
  monthKey,
  monthlyBudgetUsd,
  redactCardNumbers,
  triageTurn,
} = require('./policy');

const WELCOME = "Thanks for calling ManualOS support. You're speaking with an AI assistant; say 'representative' any time to reach a person.";
const VOICE_ID = 'en-US-Neural2-C';
const GATHER_PROMPT = 'Thanks for calling ManualOS support. Press 1 for order or manual status, press 2 for billing, or press 0 to reach a person.';
const OPT_OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT-OUT', 'OPT OUT']);
const OPT_IN = new Set(['START', 'UNSTOP']);
const HELP = new Set(['HELP', 'INFO']);
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const CONSENT_LIMIT = 10;
const CONSENT_WINDOW_MS = 60 * 60 * 1000;

function mountSupport(app, options = {}) {
  const env = options.env || process.env;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const store = options.store || createSupportStore({ env, now });
  const twilioClient = resolveTwilioClient(env, options.twilioClient);
  const complete = options.complete || completeOpenAI;
  const sessions = new Map();
  const consentHits = new Map();

  const form = express.urlencoded({ extended: false, limit: '64kb' });

  function requireTwilio(req, res, next) {
    const token = authToken(env);
    if (!token) {
      console.error('Twilio webhook rejected: TWILIO_AUTH_TOKEN is not set');
      res.status(503).type('text/plain').send('Support line is not configured.');
      return;
    }
    const signature = req.get('x-twilio-signature') || '';
    const url = fullPublicUrl(req, env);
    const params = plainParams(req.body);
    let ok = false;
    try {
      ok = twilio.validateRequest(token, signature, url, params);
    } catch {
      ok = false;
    }
    if (!ok) {
      console.error('Twilio signature rejected', req.path);
      res.status(403).type('text/plain').send('Invalid signature.');
      return;
    }
    req.twilio = params;
    next();
  }

  function spent() {
    try {
      return store.spentUsd(monthKey(now()));
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function rememberUsage(usage) {
    if (!usage) return;
    try {
      store.addUsage(monthKey(now()), usage);
    } catch {
      console.error('LLM usage was not recorded');
    }
  }

  async function runTriage(channel, text, state) {
    const decision = await triageTurn({
      channel,
      text,
      state,
      env,
      spentUsd: spent(),
      complete,
      now,
    });
    rememberUsage(decision.usage);
    return decision;
  }

  function relayAllowed() {
    return aiConfigured(env) && spent() < monthlyBudgetUsd(env);
  }

  function postVoice(req, res) {
    if (!relayAllowed()) {
      xml(res, gatherTwiml());
      return;
    }
    const session = createSession(req.twilio);
    const relayUrl = `${websocketOrigin(req)}/api/twilio/relay?token=${session.token}`;
    xml(res, relayTwiml(relayUrl));
  }

  async function postMenu(req, res) {
    const digit = String(req.twilio.Digits || '').trim();
    if (digit === '0') {
      await notifyOnce(dedupeKey('menu-0', req.twilio), `Caller pressed 0 for a person. From ${caller(req.twilio)}.`, { callFallback: false });
      xml(res, dialOrRecord('Please leave a message after the tone and a person will call you back. Do not leave a card number.'));
      return;
    }
    if (digit === '1') {
      xml(res, recordTwiml('For order or manual status, leave your email and what you need after the tone. A person will follow up. Do not leave a card number.'));
      return;
    }
    if (digit === '2') {
      xml(res, recordTwiml('For billing, leave your account email after the tone. Do not leave a card number. Use the website for checkout. A person will follow up.'));
      return;
    }
    xml(res, gatherTwiml());
  }

  async function postHandoff(req, res) {
    const data = parseHandoff(req.twilio.HandoffData);
    const open = callOpen(req.twilio);
    if (!data.handoff) {
      xml(res, open ? sayTwiml('Thanks for calling ManualOS. Goodbye.') : emptyTwiml());
      return;
    }
    const reason = safeToken(data.reason || 'handoff');
    const summary = clip(redactCardNumbers(data.summary || 'Caller needs a person.'), 180);
    const from = e164(data.from) || caller(req.twilio);
    await notifyOnce(
      `handoff:${req.twilio.CallSid || ''}:${req.twilio.SessionId || ''}`,
      `Handoff (${reason}) from ${from}: ${summary}`,
      { callFallback: !open },
    );
    if (!open) {
      xml(res, emptyTwiml());
      return;
    }
    xml(res, dialOrRecord('We could not reach a teammate. Please leave a message after the tone. Do not leave a card number.'));
  }

  function postDialStatus(req, res) {
    const status = String(req.twilio.DialCallStatus || '').toLowerCase();
    if (status === 'no-answer' || status === 'busy' || status === 'failed') {
      xml(res, recordTwiml('No one is available right now. Please leave a message after the tone. Do not leave a card number.'));
      return;
    }
    xml(res, emptyTwiml());
  }

  async function postTranscription(req, res) {
    const recording = String(req.twilio.RecordingUrl || req.twilio.TranscriptionUrl || '');
    const transcript = clip(redactCardNumbers(req.twilio.TranscriptionText || ''), 240);
    const status = safeToken(req.twilio.TranscriptionStatus || 'unknown');
    const from = caller(req.twilio);
    const callSid = req.twilio.CallSid || '';
    const id = req.twilio.TranscriptionSid || req.twilio.RecordingSid || callSid || 'recording';
    await notifyOnce(
      `voicemail:${id}`,
      `Voicemail from ${from}. Call ${callSid}. Status ${status}. Recording ${recording}. Transcript ${transcript}`,
    );
    xml(res, emptyTwiml());
  }

  function postRecordingDone(req, res) {
    xml(res, goodbyeTwiml());
  }

  async function postRecording(req, res) {
    const status = String(req.twilio.RecordingStatus || '').toLowerCase();
    if (status && status !== 'completed') {
      res.status(200).type('text/plain').send('');
      return;
    }
    const recording = String(req.twilio.RecordingUrl || '');
    const from = caller(req.twilio);
    const callSid = req.twilio.CallSid || '';
    const id = req.twilio.RecordingSid || callSid || 'recording';
    await notifyOnce(
      `recording:${id}`,
      `Voicemail recording from ${from}. Call ${callSid}. Recording ${recording}`,
    );
    res.status(200).type('text/plain').send('');
  }

  function postVoiceStatus(req, res) {
    res.status(200).type('text/plain').send('');
  }

  async function postSms(req, res) {
    const from = e164(req.twilio.From);
    if (!from) {
      xml(res, emptyTwiml());
      return;
    }
    const body = String(req.twilio.Body || '');
    const optType = String(req.twilio.OptOutType || '').toUpperCase();
    const keyword = keywordOf(body);

    if (isOptOutMessage(body, keyword, optType)) {
      store.optOut(from, 'sms');
      xml(res, messageTwiml('You are unsubscribed from ManualOS support texts and will receive no further messages. Reply START to opt back in. Msg&data rates may apply.', { footer: false }));
      return;
    }
    if (optType === 'HELP' || HELP.has(keyword)) {
      const phone = e164(env.SUPPORT_PHONE);
      const call = phone ? ` Call ${phone}.` : '';
      xml(res, messageTwiml(`ManualOS turns PLC and CAD files into operator and maintenance manuals. Email support@manualos.com.${call}`));
      return;
    }
    if (store.isOptedOut(from) && optType !== 'START' && !OPT_IN.has(keyword)) {
      xml(res, emptyTwiml());
      return;
    }
    if (optType === 'START' || OPT_IN.has(keyword)) {
      store.optIn(from, 'sms-start');
      store.addConsent(consentRecord(from, 'sms-start-v1', 'sms-start'));
      xml(res, messageTwiml('You are opted in to ManualOS support texts. Msg frequency varies.'));
      return;
    }

    store.optIn(from, 'inbound-sms');
    if (!store.hasConsent(from, 'inbound-sms')) {
      store.addConsent(consentRecord(from, 'inbound-sms-v1', 'inbound-sms'));
    }
    const thread = store.getThread(from);
    if (!thread.startedAt) thread.startedAt = new Date(now()).toISOString();
    const decision = await runTriage('sms', body, thread);
    store.saveThread(from, thread);
    if (decision.escalate) {
      await notifyOnce(
        `sms:${from}:${thread.startedAt}:${decision.reason}`,
        `SMS ${decision.reason} from ${from}: ${decision.summary}`,
      );
    }
    xml(res, messageTwiml(decision.reply));
  }

  function postConsent(req, res) {
    const ip = clientIp(req);
    if (tooManyConsents(ip)) {
      res.status(429).json({ error: 'Too many consent requests. Try again later.' });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Expected a JSON object.' });
      return;
    }
    const phone = e164(body.phone);
    if (!phone) {
      res.status(400).json({ error: 'phone must be E.164.' });
      return;
    }
    const version = shortText(body.consentTextVersion, 80);
    if (!version) {
      res.status(400).json({ error: 'consentTextVersion is required.' });
      return;
    }
    const source = shortText(body.source, 64) || 'website';
    store.addConsent({
      phone,
      consentTextVersion: version,
      timestamp: new Date(now()).toISOString(),
      ip,
      source,
    });
    res.status(201).json({ ok: true });
  }

  function consentRecord(phone, version, source) {
    return {
      phone,
      consentTextVersion: version,
      timestamp: new Date(now()).toISOString(),
      ip: '',
      source,
    };
  }

  function createSession(params) {
    pruneSessions();
    const token = crypto.randomBytes(24).toString('hex');
    const session = {
      token,
      createdAt: now(),
      callSid: String(params.CallSid || ''),
      from: String(params.From || ''),
      to: String(params.To || ''),
      turns: 0,
      lowConfidence: 0,
      history: [],
      generation: 0,
    };
    sessions.set(token, session);
    return session;
  }

  function pruneSessions() {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [token, session] of sessions) {
      if (session.createdAt < cutoff) sessions.delete(token);
    }
    while (sessions.size > 500) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
  }

  function tooManyConsents(ip) {
    const key = ip || 'unknown';
    const at = now();
    const recent = (consentHits.get(key) || []).filter((ts) => at - ts < CONSENT_WINDOW_MS);
    if (recent.length >= CONSENT_LIMIT) {
      consentHits.set(key, recent);
      return true;
    }
    recent.push(at);
    consentHits.set(key, recent);
    if (consentHits.size > 5000) {
      const oldest = consentHits.keys().next().value;
      consentHits.delete(oldest);
    }
    return false;
  }

  async function notifyOnce(key, text, options) {
    try {
      if (!store.claimOnce(key)) return false;
    } catch {
      console.error('Support dedupe store failed');
    }
    return sendEscalation(text, options || {});
  }

  async function sendEscalation(text, options) {
    const to = e164(env.ESCALATION_PHONE);
    const from = e164(env.TWILIO_FROM_NUMBER);
    if (!twilioClient || !to || !from) {
      console.error('Escalation SMS skipped: Twilio client, TWILIO_FROM_NUMBER, or ESCALATION_PHONE is not configured');
      return false;
    }
    const body = formatEscalationSms(text);
    try {
      await twilioClient.messages.create({ to, from, body });
      return true;
    } catch (err) {
      console.error('Escalation SMS failed', err && err.status ? String(err.status) : 'error');
    }
    if (options && options.callFallback === false) return false;
    if (!twilioClient.calls || typeof twilioClient.calls.create !== 'function') return false;
    const spoken = clip(body.replace(/https?:\/\/\S+/g, 'the recording link'), 280);
    try {
      await twilioClient.calls.create({ to, from, twiml: sayTwiml(spoken) });
      return true;
    } catch (err) {
      console.error('Escalation call failed', err && err.status ? String(err.status) : 'error');
      return false;
    }
  }

  function dialOrRecord(recordPrompt) {
    const phone = e164(env.ESCALATION_PHONE);
    if (!phone) return recordTwiml(recordPrompt);
    return dialTwiml(phone);
  }

  function bindRelay(ws, session) {
    const send = (obj) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(obj));
    };
    ws.on('message', (raw) => {
      onRelayMessage(session, raw, send).catch(() => {
        console.error('Relay message failed');
      });
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      sessions.delete(session.token);
    });
  }

  async function onRelayMessage(session, raw, send) {
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'interrupt') {
      session.generation += 1;
      const heard = typeof msg.utteranceUntilInterrupt === 'string' ? msg.utteranceUntilInterrupt : '';
      if (heard) {
        for (let i = session.history.length - 1; i >= 0; i -= 1) {
          if (session.history[i].role === 'assistant') {
            session.history[i] = { role: 'assistant', content: clip(redactCardNumbers(heard), 500) };
            break;
          }
        }
      }
      return;
    }
    if (msg.type === 'setup') {
      if (typeof msg.callSid === 'string' && msg.callSid) session.callSid = msg.callSid;
      if (typeof msg.from === 'string' && msg.from) session.from = msg.from;
      return;
    }
    if (msg.type === 'error') {
      console.error('ConversationRelay error');
      return;
    }
    if (msg.type !== 'prompt') return;
    if (msg.last === false) return;
    const generation = session.generation + 1;
    session.generation = generation;
    const text = typeof msg.voicePrompt === 'string' ? msg.voicePrompt : '';
    const decision = await runTriage('voice', text, session);
    if (session.generation !== generation) return;
    const spoken = decision.reply || 'I am not sure about that. Email support@manualos.com.';
    send({ type: 'text', token: spoken, last: true });
    if (!decision.handoff) return;
    send({
      type: 'end',
      handoffData: JSON.stringify({
        handoff: true,
        reason: decision.reason || 'handoff',
        summary: clip(redactCardNumbers(decision.summary || spoken), 180),
        from: session.from || '',
      }),
    });
  }

  function signatureOk(request) {
    const token = authToken(env);
    const signature = headerOf(request, 'x-twilio-signature');
    if (!token || !signature) return false;
    let absolute;
    try {
      absolute = relayAbsoluteUrl(request);
      const parsed = new URL(absolute);
      const params = {};
      for (const [key, value] of parsed.searchParams) params[key] = value;
      const bare = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      if (twilio.validateRequest(token, signature, absolute, {})) return true;
      if (Object.keys(params).length && twilio.validateRequest(token, signature, bare, params)) return true;
    } catch {
      return false;
    }
    return false;
  }

  function relayAbsoluteUrl(request) {
    const path = request.url || '/api/twilio/relay';
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${websocketOrigin(request)}${suffix}`;
  }

  function websocketOrigin(request) {
    const base = publicOrigin(env);
    if (base) {
      const url = new URL(base);
      const scheme = url.protocol === 'http:' ? 'ws:' : 'wss:';
      return `${scheme}//${url.host}`;
    }
    const proto = (headerOf(request, 'x-forwarded-proto') || request.protocol || 'https').split(',')[0].trim();
    const host = (headerOf(request, 'x-forwarded-host') || headerOf(request, 'host')).split(',')[0].trim();
    const scheme = proto === 'http' ? 'ws' : 'wss';
    return `${scheme}://${host}`;
  }

  function attach(server) {
    if (!server || server.__manualosSupport) return;
    server.__manualosSupport = true;
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      } catch {
        rejectUpgrade(socket, 400, 'Bad request');
        return;
      }
      if (pathname !== '/api/twilio/relay') {
        rejectUpgrade(socket, 404, 'Not found');
        return;
      }
      if (!authToken(env)) {
        console.error('Twilio relay rejected: TWILIO_AUTH_TOKEN is not set');
        rejectUpgrade(socket, 503, 'Support line is not configured.');
        return;
      }
      if (!signatureOk(request)) {
        console.error('Twilio relay signature rejected');
        rejectUpgrade(socket, 403, 'Invalid signature.');
        return;
      }
      let sessionToken = '';
      try {
        sessionToken = new URL(request.url, 'http://127.0.0.1').searchParams.get('token') || '';
      } catch {
        sessionToken = '';
      }
      const session = sessions.get(sessionToken);
      if (!session || now() - session.createdAt > SESSION_TTL_MS) {
        rejectUpgrade(socket, 403, 'Invalid signature.');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => bindRelay(ws, session));
    });
    const close = server.close;
    server.close = function patchedClose(callback) {
      for (const client of wss.clients) client.terminate();
      wss.close();
      return close.call(this, callback);
    };
  }

  app.post('/api/twilio/voice', form, requireTwilio, guard(postVoice));
  app.post('/api/twilio/voice/menu', form, requireTwilio, guard(postMenu));
  app.post('/api/twilio/voice/handoff', form, requireTwilio, guard(postHandoff));
  app.post('/api/twilio/voice/dial-status', form, requireTwilio, guard(postDialStatus));
  app.post('/api/twilio/voice/transcription', form, requireTwilio, guard(postTranscription));
  app.post('/api/twilio/voice/recording-done', form, requireTwilio, guard(postRecordingDone));
  app.post('/api/twilio/voice/recording', form, requireTwilio, guard(postRecording));
  app.post('/api/twilio/voice/status', form, requireTwilio, guard(postVoiceStatus));
  app.post('/api/twilio/sms', form, requireTwilio, guard(postSms));
  app.post('/api/support/sms-consent', guard(postConsent));

  return { attach, store, sessions };
}

function guard(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      console.error('Support route failed', req.path);
      if (res.headersSent) return;
      if (req.path === '/api/support/sms-consent') {
        res.status(500).json({ error: 'Could not store consent.' });
        return;
      }
      if (req.path === '/api/twilio/sms') {
        xml(res, messageTwiml('Something went wrong. Email support@manualos.com and the team will follow up.'));
        return;
      }
      xml(res, sayTwiml('ManualOS support hit an error. Please email support@manualos.com. Goodbye.'));
    });
  };
}

function resolveTwilioClient(env, twilioClient) {
  if (twilioClient !== undefined) return twilioClient;
  const sid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const token = authToken(env);
  if (!sid || !token) return null;
  return twilio(sid, token);
}

function authToken(env) {
  return String(env.TWILIO_AUTH_TOKEN || '').trim();
}

function publicOrigin(env) {
  const raw = String(env.PUBLIC_BASE_URL || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function fullPublicUrl(req, env) {
  const path = req.originalUrl || req.url || '/';
  const origin = publicOrigin(env);
  if (origin) return origin + path;
  const proto = (headerOf(req, 'x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (headerOf(req, 'x-forwarded-host') || headerOf(req, 'host')).split(',')[0].trim();
  return `${proto}://${host}${path}`;
}

function headerOf(req, name) {
  if (req && typeof req.get === 'function') {
    const value = req.get(name);
    if (value) return String(value);
  }
  const raw = req && req.headers ? req.headers[String(name).toLowerCase()] : '';
  if (Array.isArray(raw)) return raw[0] || '';
  return raw || '';
}

function plainParams(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const out = {};
  for (const key of Object.keys(body)) {
    const value = body[key];
    if (Array.isArray(value)) out[key] = value.map((item) => String(item));
    else if (value == null) out[key] = '';
    else out[key] = String(value);
  }
  return out;
}

function keywordOf(body) {
  return String(body || '').trim().toUpperCase().replace(/[.!,\s]+$/g, '').trim();
}

function isOptOutMessage(body, keyword, optType) {
  if (optType === 'STOP' || OPT_OUT.has(keyword)) return true;
  const text = String(body || '').trim();
  if (/^stop\b/i.test(text)) return true;
  if (/\bstop\s+(?:texting|messaging)\s+me\b/i.test(text)) return true;
  return false;
}

function caller(params) {
  return e164(params.From) || 'unknown';
}

function dedupeKey(name, params) {
  return `${name}:${params.CallSid || params.MessageSid || 'na'}`;
}

function callOpen(params) {
  const status = String(params.CallStatus || 'in-progress').toLowerCase();
  return status === 'in-progress' || status === 'ringing';
}

function parseHandoff(raw) {
  if (!raw || typeof raw !== 'string') return {};
  let value = raw;
  for (let i = 0; i < 2 && typeof value === 'string'; i += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return {
    handoff: Boolean(value.handoff),
    reason: typeof value.reason === 'string' ? value.reason : '',
    summary: typeof value.summary === 'string' ? value.summary : '',
    from: typeof value.from === 'string' ? value.from : '',
  };
}

function safeToken(value) {
  const cleaned = String(value || '').replace(/[^\w.-]+/g, '').slice(0, 40);
  return cleaned || 'handoff';
}

function shortText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.slice(0, max);
}

function clientIp(req) {
  // The first X-Forwarded-For hop is client-supplied. Railway sets X-Real-IP.
  // Without that header, the last forwarded hop is the one the proxy appended.
  const real = String(headerOf(req, 'x-real-ip') || '').split(',')[0].trim();
  if (real) return real.slice(0, 64);
  const forwarded = headerOf(req, 'x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  const address = req.socket && req.socket.remoteAddress;
  return address ? String(address).slice(0, 64) : '';
}

function xml(res, body) {
  res.set('Cache-Control', 'no-store');
  res.type('text/xml; charset=utf-8').send(body);
}

function xmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlAttr(value) {
  return xmlText(value).replace(/"/g, '&quot;');
}

function gatherTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="8" method="POST" action="/api/twilio/voice/menu">
    <Say language="en-US">${xmlText(GATHER_PROMPT)}</Say>
  </Gather>
  <Say language="en-US">We did not receive a selection. Goodbye.</Say>
</Response>`;
}

function relayTwiml(url) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="/api/twilio/voice/handoff">
    <ConversationRelay url="${xmlAttr(url)}" ttsProvider="Google" voice="${VOICE_ID}" language="en-US" transcriptionProvider="Deepgram" welcomeGreeting="${xmlAttr(WELCOME)}"/>
  </Connect>
</Response>`;
}

function dialTwiml(phone) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" action="/api/twilio/voice/dial-status">${xmlText(phone)}</Dial>
</Response>`;
}

function recordTwiml(prompt) {
  // Record without action re-requests this document and loops the menu. The goodbye lives on the action URL.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">${xmlText(prompt)}</Say>
  <Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="/api/twilio/voice/transcription" action="/api/twilio/voice/recording-done" method="POST" recordingStatusCallback="/api/twilio/voice/recording" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>
</Response>`;
}

function goodbyeTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">Thanks. A person will follow up. Goodbye.</Say>
  <Hangup/>
</Response>`;
}

function sayTwiml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">${xmlText(text)}</Say>
</Response>`;
}

function messageTwiml(text, options) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${xmlText(formatCustomerSms(text, options))}</Message>
</Response>`;
}

function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function rejectUpgrade(socket, status, message) {
  const body = String(message);
  const reason = ({ 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' })[status] || 'Error';
  const payload = `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  try {
    socket.write(payload);
  } catch {
    // The socket may already be gone.
  }
  socket.destroy();
}

module.exports = {
  mountSupport,
  WELCOME,
  VOICE_ID,
  CONSENT_LIMIT,
  fullPublicUrl,
};
