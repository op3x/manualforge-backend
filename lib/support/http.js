const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const { WebSocketServer, WebSocket } = require('ws');
const { createSupportStore } = require('./store');
const { createSmtpMailer } = require('./mail');
const { supportStorageProblem } = require('./storage-gate');
const { isoWithOffset } = require('./quiet-hours');
const { deliverStatusText, flushStatusQueue } = require('./status-sms');
const {
  aiConfigured,
  clip,
  completeOpenAI,
  e164,
  formatCustomerSms,
  formatEscalationSms,
  monthKey,
  monthlyBudgetUsd,
  classify,
  normalizeInbound,
  redactCardNumbers,
  triageTurn,
  SAFE_FALLBACK,
} = require('./policy');

const CALL_SCRIPT_VERSION = 'call-open-v1-2026-10-25';
const CALL_OPENING = "Thanks for calling ManualOS support, operated by Op3x LLC. You're talking with an AI assistant, not a person. To help you, this call is transcribed and may be recorded by us and our service providers. If you don't want that, say 'don't record' or press 9 now. Staying on the line means you agree. You can ask for a person at any time.";
const WELCOME = 'How can I help? You can ask for a person at any time.';
const CALLBACK_SAY = "Since this call isn't being recorded, I've logged a callback request for this number. You can also email support at manualos dot com.";
const VOICEMAIL_RECORDING_NOTICE = 'This message will be recorded and transcribed.';
const SMS_STOP_CONFIRMATION = "ManualOS (Op3x LLC): You're unsubscribed and will get no more texts. Reply START to opt back in.";
const VOICE_ID = 'en-US-Neural2-C';
const GATHER_PROMPT = 'Thanks for calling ManualOS support. Press 1 for order or manual status, press 2 for billing, or press 0 to reach a person.';
// support-sms-v3 is the only version that allows support replies and order/manual-status texts.
// There is no account-alerts scope. The label is the website checkbox; the confirmation is the CTIA opt-in text.
const SMS_CONSENT_VERSION = 'support-sms-v3';
const SMS_CONSENT_LABEL = 'Yes, text me at this number. I agree to receive support replies and order/manual-status texts from ManualOS (Op3x LLC). Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel. Consent is not a condition of purchase. See Terms (/terms.html#sms) and Privacy (/privacy.html#sms).';
const SMS_OPT_IN_CONFIRMATION = "ManualOS (Op3x LLC): You're opted in to support & order-status texts. Msg frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to cancel.";
const ALERT_SCOPE = 'support-replies,order-status';
const CONVERSATION_SCOPE = 'conversation-reply';
const CONVERSATION_CONSENT_VERSION = 'conversation-only-v1';
const CONVERSATION_TTL_MS = 72 * 60 * 60 * 1000;
const OPT_OUT = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT-OUT', 'OPT OUT']);
const OPT_IN = new Set(['START', 'UNSTOP', 'YES']);
const HELP = new Set(['HELP', 'INFO']);
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const CONSENT_LIMIT = 10;
const CONSENT_WINDOW_MS = 60 * 60 * 1000;
const WEB_OPT_IN_LIMIT = 3;
const WEB_OPT_IN_WINDOW_MS = 24 * 60 * 60 * 1000;

function mountSupport(app, options = {}) {
  const env = options.env || process.env;
  const storageProblem = supportStorageProblem(env);
  if (storageProblem) {
    console.error(`SUPPORT LINE DISABLED: ${storageProblem}. Support routes are not mounted, so checkout keeps running. Mount a persistent volume and set SUPPORT_DATA_DIR to that absolute path.`);
    return {
      attach() {},
      store: null,
      sessions: new Map(),
      disabled: true,
    };
  }
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const store = options.store || createSupportStore({ env, now });
  const twilioClient = resolveTwilioClient(env, options.twilioClient);
  const complete = options.complete || completeOpenAI;
  const sessions = new Map();
  const tooManyConsents = createConsentLimiter({ now });
  let cachedMailer;

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
    xml(res, consentGatherTwiml());
  }

  function postVoiceConsent(req, res) {
    const digits = String(req.twilio.Digits || '').trim();
    const speech = String(req.twilio.SpeechResult || '');
    const declined = digits === '9' || /\b(?:don'?t|do not|no)\s+record/i.test(speech);
    const method = declined ? (digits === '9' ? 'dtmf' : 'speech') : 'implied';
    logCallConsent(req, { declined, method });
    if (declined) {
      xml(res, sayThen(gatherTwiml({ noRecord: true }), "Okay. This call won't be recorded or transcribed."));
      return;
    }
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
    const quiet = declinedRecording(req);
    if (digit === '0') {
      await notifyOnce(
        dedupeKey('menu-0', req.twilio),
        `Caller pressed 0 for a person. From ${caller(req.twilio)}.`,
        {
          category: 'representative',
          from: caller(req.twilio),
          line: 'Caller pressed 0 for a person.',
          interaction: voiceInteraction(req.twilio),
          liveTransfer: Boolean(e164(env.ESCALATION_PHONE)),
        },
      );
      xml(res, dialOrRecord(req, 'Please leave a message after the tone and a person will call you back. Do not leave a card number.'));
      return;
    }
    if (digit === '1') {
      xml(res, await recordOrCallback(req, 'For order or manual status, leave the email you used at checkout and what you need after the tone. A person will follow up. Do not leave a card number.'));
      return;
    }
    if (digit === '2') {
      xml(res, await recordOrCallback(req, 'For billing, leave the email you used at checkout after the tone. Do not leave a card number. Use the website for checkout. A person will follow up.'));
      return;
    }
    xml(res, gatherTwiml({ noRecord: quiet }));
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
      {
        category: reason,
        from,
        line: summary,
        interaction: voiceInteraction(req.twilio),
        liveTransfer: open && Boolean(e164(env.ESCALATION_PHONE)),
      },
    );
    if (!open) {
      xml(res, emptyTwiml());
      return;
    }
    if (data.noRecord || data.reason === 'no_record' || declinedRecording(req)) {
      xml(res, gatherTwiml({ noRecord: true }));
      return;
    }
    xml(res, dialOrRecord(req, 'We could not reach a teammate. Please leave a message after the tone. Do not leave a card number.'));
  }

  async function postDialStatus(req, res) {
    const status = String(req.twilio.DialCallStatus || '').toLowerCase();
    if (status === 'no-answer' || status === 'busy' || status === 'failed') {
      xml(res, await recordOrCallback(req, 'No one is available right now. Please leave a message after the tone. Do not leave a card number.'));
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
      {
        category: 'voicemail',
        from,
        line: transcript || 'Voicemail transcript is empty.',
        interaction: voiceInteraction(req.twilio),
      },
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
      {
        category: 'voicemail',
        from,
        line: 'A voicemail recording is ready.',
        interaction: voiceInteraction(req.twilio),
      },
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
      // Toll-free carriers answer STOP themselves. A failed confirmation must not page anyone.
      try {
        store.addConsent(consentRecord(from, 'keyword', 'sms-stop', {
          event: 'KEYWORD_STOP',
          consentText: body.trim().slice(0, 40),
          alerts: false,
          messageSid: String(req.twilio.MessageSid || '').slice(0, 64),
          occurredAt: isoWithOffset(now()),
        }));
      } catch (err) {
        console.error('STOP history failed', err && err.code ? String(err.code) : 'error');
      }
      try {
        store.optOut(from, 'sms');
      } catch (err) {
        console.error('Opt-out store failed', err && err.code ? String(err.code) : 'error');
      }
      try {
        if (classify(body) === 'billing') {
          const thread = store.getThread(from);
          if (!thread.startedAt) thread.startedAt = new Date(now()).toISOString();
          const summary = `billing: ${clip(redactCardNumbers(body), 140)}`;
          await notifyOnce(
            `sms:${from}:${thread.startedAt}:billing`,
            `SMS billing from ${from}: ${summary}`,
            {
              category: 'billing',
              from,
              line: summary,
              interaction: `sms:${from}:${thread.startedAt}`,
            },
          );
          store.saveThread(from, thread);
        }
      } catch (err) {
        console.error('Opt-out billing check failed', err && err.code ? String(err.code) : 'error');
      }
      try {
        xml(res, messageTwiml(SMS_STOP_CONFIRMATION, { raw: true }));
        noteCustomerText(from);
      } catch (err) {
        console.error('Opt-out reply failed', err && err.code ? String(err.code) : 'error');
        if (!res.headersSent) xml(res, messageTwiml(SAFE_FALLBACK, { footer: false }));
      }
      return;
    }
    if (optType === 'HELP' || HELP.has(keyword)) {
      try {
        store.addConsent(consentRecord(from, 'keyword', 'sms-help', {
          event: 'KEYWORD_HELP',
          consentText: body.trim().slice(0, 40),
          alerts: false,
          messageSid: String(req.twilio.MessageSid || '').slice(0, 64),
          occurredAt: isoWithOffset(now()),
        }));
      } catch (err) {
        console.error('HELP history failed', err && err.code ? String(err.code) : 'error');
      }
      xml(res, messageTwiml(helpReply(env), { raw: true }));
      noteCustomerText(from);
      return;
    }
    if (store.isOptedOut(from) && optType !== 'START' && !OPT_IN.has(keyword)) {
      xml(res, emptyTwiml());
      return;
    }
    if (optType === 'START' || OPT_IN.has(keyword)) {
      store.optIn(from, 'sms-start');
      store.addConsent(alertConsentRecord(from, 'sms-start'));
      xml(res, messageTwiml(SMS_OPT_IN_CONFIRMATION, { raw: true }));
      noteCustomerText(from);
      return;
    }

    // A text consents to replies in this thread only. It is not support-sms-v3 and does not opt the number in.
    const records = store.listConsents();
    const at = now();
    if (!customerAlertsAllowed(records, from, { optedOut: false, nowMs: at }) && !hasFreshConversation(records, from, at)) {
      store.addConsent(consentRecord(from, CONVERSATION_CONSENT_VERSION, 'conversation-only', {
        scope: CONVERSATION_SCOPE,
        alerts: false,
        expiresAt: new Date(at + CONVERSATION_TTL_MS).toISOString(),
      }));
    }
    const thread = store.getThread(from);
    if (!thread.startedAt) thread.startedAt = new Date(now()).toISOString();
    const decision = await runTriage('sms', body, thread);
    store.saveThread(from, thread);
    if (decision.escalate) {
      await notifyOnce(
        `sms:${from}:${thread.startedAt}:${decision.reason}`,
        `SMS ${decision.reason} from ${from}: ${decision.summary}`,
        {
          category: decision.reason,
          from,
          line: decision.summary,
          interaction: `sms:${from}:${thread.startedAt}`,
        },
      );
    }
    xml(res, messageTwiml(decision.reply));
    noteCustomerText(from);
  }

  async function postConsent(req, res) {
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
    if (version !== SMS_CONSENT_VERSION) {
      res.status(400).json({ error: 'consentTextVersion must be support-sms-v3.' });
      return;
    }
    const postedLabel = shortText(body.consentText, 1000);
    if (postedLabel !== SMS_CONSENT_LABEL) {
      res.status(400).json({ error: 'consentText does not match support-sms-v3.' });
      return;
    }
    const source = shortText(body.source, 64) || 'website';
    const at = now();
    const userAgent = shortText(req.get('user-agent'), 400);
    const pageUrl = safePageUrl(body.pageUrl || req.get('referer'));
    const occurredAt = isoWithOffset(at);
    const records = store.listConsents();
    if (recentWebOptIns(records, phone, at).length >= WEB_OPT_IN_LIMIT) {
      res.status(429).json({ error: 'Too many consent requests for this number. Try again later.' });
      return;
    }
    // The form is not proof the handset owner typed the number. An active STOP stays until that phone texts START, UNSTOP, or YES.
    if (store.isOptedOut(phone)) {
      store.addConsent({
        ...alertConsentRecord(phone, source),
        ip,
        userAgent,
        pageUrl,
        occurredAt,
        alerts: false,
        pending: true,
        webOptIn: true,
        confirmationSent: false,
      });
      res.status(201).json({ ok: true, confirmationSent: false, pending: true });
      return;
    }
    const confirmationSent = confirmationSentRecently(records, phone, at)
      ? false
      : await sendOptInConfirmation(phone);
    store.addConsent({
      ...alertConsentRecord(phone, source),
      ip,
      userAgent,
      pageUrl,
      occurredAt,
      pending: false,
      webOptIn: true,
      confirmationSent,
    });
    store.optIn(phone, source);
    res.status(201).json({ ok: true, confirmationSent, pending: false });
  }

  function alertConsentRecord(phone, source) {
    return consentRecord(phone, SMS_CONSENT_VERSION, source, {
      consentText: SMS_CONSENT_LABEL,
      scope: ALERT_SCOPE,
      alerts: true,
    });
  }

  function consentRecord(phone, version, source, extra = {}) {
    return {
      phone,
      consentTextVersion: version,
      timestamp: new Date(now()).toISOString(),
      ip: '',
      source,
      ...extra,
    };
  }

  async function sendOptInConfirmation(phone) {
    const from = e164(env.TWILIO_FROM_NUMBER);
    if (!twilioClient || !twilioClient.messages || typeof twilioClient.messages.create !== 'function' || !from) {
      console.error('Opt-in confirmation SMS skipped: Twilio client or TWILIO_FROM_NUMBER is not configured');
      return false;
    }
    try {
      await twilioClient.messages.create({
        to: phone,
        from,
        body: SMS_OPT_IN_CONFIRMATION,
      });
      return true;
    } catch (err) {
      console.error('Opt-in confirmation SMS failed', err && err.status ? String(err.status) : 'error');
      return false;
    }
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

  async function notifyOnce(key, text, notice) {
    try {
      if (!store.claimOnce(key)) return false;
    } catch {
      console.error('Support dedupe store failed');
    }
    return sendEscalation(key, text, notice || {});
  }

  async function sendEscalation(key, text, notice) {
    const to = e164(env.ESCALATION_PHONE);
    const from = e164(env.TWILIO_FROM_NUMBER);
    if (!twilioClient || !to || !from) {
      console.error('Escalation SMS skipped: Twilio client, TWILIO_FROM_NUMBER, or ESCALATION_PHONE is not configured');
      return false;
    }
    const safe = safeNotice(notice);
    const detail = formatEscalationSms(text);
    const context = {
      ...safe,
      detail,
      interaction: notice.interaction || key,
      liveTransfer: Boolean(notice.liveTransfer),
    };
    const callback = statusCallbackUrl();
    if (!callback) console.warn('Escalation SMS has no status callback: PUBLIC_BASE_URL is not set');
    try {
      const created = await twilioClient.messages.create({
        to,
        from,
        body: detail,
        ...(callback ? { statusCallback: callback, statusCallbackMethod: 'POST' } : {}),
      });
      const sid = created && created.sid ? String(created.sid) : '';
      if (!sid) {
        console.error('Escalation SMS unconfirmed');
        await fallbackEscalation(key, context);
        return false;
      }
      try {
        store.saveSmsNotice(sid, { key, ...context });
      } catch {
        console.error('Escalation SMS status was not saved');
      }
      return true;
    } catch (err) {
      console.error('Escalation SMS failed', err && err.status ? String(err.status) : 'error');
    }
    await fallbackEscalation(key, context);
    return false;
  }

  async function postSmsStatus(req, res) {
    const status = String(req.twilio.MessageStatus || '').toLowerCase();
    const code = String(req.twilio.ErrorCode || '');
    const sid = String(req.twilio.MessageSid || '');
    try {
      if (status === 'failed' || status === 'undelivered') {
        const notice = store.getSmsNotice(sid);
        if (!notice || !notice.key) {
          console.error('Twilio message was not delivered', status, code || 'none');
        } else {
          console.error('Escalation SMS undelivered', status, code || 'none');
          await fallbackEscalation(notice.key, notice);
        }
      }
    } catch {
      console.error('Escalation SMS status store failed');
    }
    if (!res.headersSent) res.status(200).type('text/plain').send('');
  }

  async function fallbackEscalation(key, notice) {
    const safe = safeNotice(notice);
    const detail = clip(redactCardNumbers(notice && notice.detail ? notice.detail : ''), 420);
    const interaction = String((notice && notice.interaction) || key);
    // A live <Dial> already rings this phone. Email only until that transfer ends.
    if (!notice || !notice.liveTransfer) await placeFallbackCall(interaction, safe);
    await sendFallbackEmail(interaction, { ...safe, detail });
  }

  async function placeFallbackCall(key, notice) {
    try {
      if (!store.claimOnce(`fallback-call:${key}`)) return false;
    } catch {
      console.error('Support dedupe store failed');
    }
    const to = e164(env.ESCALATION_PHONE);
    const from = e164(env.TWILIO_FROM_NUMBER);
    if (!twilioClient || !twilioClient.calls || typeof twilioClient.calls.create !== 'function' || !to || !from) {
      console.error('Escalation call skipped: Twilio calls or phone numbers are not configured');
      return false;
    }
    try {
      await twilioClient.calls.create({ to, from, twiml: sayTwiml(spokenEscalation(notice)) });
      return true;
    } catch (err) {
      console.error('Escalation call failed', err && err.status ? String(err.status) : 'error');
      return false;
    }
  }

  async function sendFallbackEmail(key, notice) {
    const to = String(env.ESCALATION_EMAIL || '').trim();
    const mailer = currentMailer();
    if (!to || !mailer) {
      try {
        if (!store.claimOnce(`fallback-email-skip:${key}`)) return false;
      } catch {
        console.error('Support dedupe store failed');
      }
      console.warn(to
        ? 'Escalation email skipped: SMTP is not configured'
        : 'Escalation email skipped: ESCALATION_EMAIL is not set');
      return false;
    }
    try {
      if (!store.claimOnce(`fallback-email:${key}`)) return false;
    } catch {
      console.error('Support dedupe store failed');
    }
    try {
      await mailer.sendMail({
        to,
        subject: `ManualOS escalation: ${notice.category}`,
        text: emailBody(notice),
      });
      return true;
    } catch (err) {
      console.error('Escalation email failed', err && err.code ? String(err.code) : 'error');
      return false;
    }
  }

  function currentMailer() {
    if (options.mailer !== undefined) return options.mailer || null;
    if (cachedMailer) return cachedMailer;
    const created = createSmtpMailer(env);
    if (created) cachedMailer = created;
    return created;
  }

  function statusCallbackUrl() {
    const origin = publicOrigin(env);
    if (!origin) return '';
    return `${origin}/api/twilio/sms/status`;
  }

  function dialOrRecord(req, recordPrompt) {
    const phone = e164(env.ESCALATION_PHONE);
    const quiet = declinedRecording(req);
    if (!phone) return quiet ? callbackOnly(req) : recordTwiml(recordPrompt);
    return dialTwiml(phone, quiet);
  }

  async function recordOrCallback(req, prompt) {
    if (!declinedRecording(req)) return recordTwiml(prompt);
    await logCallback(req);
    return callbackTwiml();
  }

  function callbackOnly(req) {
    logCallback(req);
    return callbackTwiml();
  }

  function logCallConsent(req, { declined, method, event }) {
    try {
      store.addConsent(consentRecord(e164(req.twilio.From) || '', CALL_SCRIPT_VERSION, 'voice', {
        event: event || (declined ? 'CALL_RECORDING_DECLINED' : 'CALL_RECORDING_CONSENT'),
        method,
        consentText: method,
        alerts: false,
        messageSid: String(req.twilio.CallSid || '').slice(0, 64),
        occurredAt: isoWithOffset(now()),
      }));
    } catch (err) {
      console.error('Call consent log failed', err && err.code ? String(err.code) : 'error');
    }
  }

  async function logCallback(req) {
    const phone = e164(req.twilio.From) || '';
    const callSid = String(req.twilio.CallSid || '').slice(0, 64);
    try {
      store.addCallback({ phone, callSid, at: new Date(now()).toISOString() });
    } catch (err) {
      console.error('Callback log failed', err && err.code ? String(err.code) : 'error');
    }
    await notifyOnce(
      `callback:${callSid || phone}`,
      `Callback request from ${phone}. Call ${callSid}.`,
      {
        category: 'callback',
        from: phone || 'unknown',
        line: `Callback request from ${phone || 'unknown'}.`,
        interaction: voiceInteraction(req.twilio),
      },
    );
  }

  function noteCustomerText(phone) {
    try {
      store.noteLastMessage(phone, now());
    } catch (err) {
      console.error('Last-message stamp failed', err && err.code ? String(err.code) : 'error');
    }
  }

  async function sendStatus(phone, body) {
    const from = e164(env.TWILIO_FROM_NUMBER);
    const send = twilioClient && from && typeof twilioClient.messages.create === 'function'
      ? (message) => twilioClient.messages.create({ to: message.to, from, body: message.body })
      : null;
    return deliverStatusText({ store, phone, body, now, send });
  }

  async function flushStatus() {
    const from = e164(env.TWILIO_FROM_NUMBER);
    if (!twilioClient || !from || typeof twilioClient.messages.create !== 'function') {
      return flushStatusQueue({ store, now });
    }
    return flushStatusQueue({
      store,
      now,
      send: (message) => twilioClient.messages.create({ to: message.to, from, body: message.body }),
    });
  }

  function bindRelay(ws, session) {
    const send = (obj) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(obj));
    };
    ws.on('message', (raw) => {
      onRelayMessage(session, raw, send).catch(() => {
        console.error('Relay message failed');
        send({ type: 'text', token: SAFE_FALLBACK, last: true });
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
    if (/\b(?:stop recording|don'?t record|do not record|no recording)\b/i.test(text)) {
      logCallConsent({ twilio: { From: session.from, CallSid: session.callSid } }, { declined: true, method: 'speech', event: 'CALL_RECORDING_REVOKED' });
      if (session.generation !== generation) return;
      send({ type: 'text', token: "Okay. This call won't be recorded or transcribed.", last: true });
      send({
        type: 'end',
        handoffData: JSON.stringify({
          handoff: true,
          reason: 'no_record',
          noRecord: true,
          summary: 'Caller asked to stop recording.',
          from: session.from || '',
        }),
      });
      return;
    }
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
    const timer = setInterval(() => {
      flushStatus().catch(() => console.error('Status queue flush failed'));
    }, 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    flushStatus().catch(() => console.error('Status queue flush failed'));
    const close = server.close;
    server.close = function patchedClose(callback) {
      clearInterval(timer);
      for (const client of wss.clients) client.terminate();
      wss.close();
      return close.call(this, callback);
    };
  }

  function postStaffOptOut(req, res) {
    if (!String(env.SUPPORT_STAFF_TOKEN || '').trim()) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    if (!staffAuthorized(req)) {
      res.status(403).json({ error: 'Invalid staff token.' });
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Expected a JSON object.' });
      return;
    }
    try {
      store.recordStaffOptOut(body.phone, shortText(body.actor, 80) || 'staff');
      res.status(201).json({ ok: true, event: 'OPT_OUT_OTHER' });
    } catch (err) {
      const status = err && err.status === 400 ? 400 : 500;
      res.status(status).json({ error: status === 400 ? 'phone must be E.164.' : 'Could not store the opt-out.' });
    }
  }

  function staffAuthorized(req) {
    const expected = Buffer.from(String(env.SUPPORT_STAFF_TOKEN || ''));
    const got = Buffer.from(String(req.get('x-support-staff-token') || ''));
    if (!expected.length || expected.length !== got.length) return false;
    return crypto.timingSafeEqual(expected, got);
  }

  app.post('/api/twilio/voice', form, requireTwilio, guard(postVoice));
  app.post('/api/twilio/voice/consent', form, requireTwilio, guard(postVoiceConsent));
  app.post('/api/twilio/voice/menu', form, requireTwilio, guard(postMenu));
  app.post('/api/twilio/voice/handoff', form, requireTwilio, guard(postHandoff));
  app.post('/api/twilio/voice/dial-status', form, requireTwilio, guard(postDialStatus));
  app.post('/api/twilio/voice/transcription', form, requireTwilio, guard(postTranscription));
  app.post('/api/twilio/voice/recording-done', form, requireTwilio, guard(postRecordingDone));
  app.post('/api/twilio/voice/recording', form, requireTwilio, guard(postRecording));
  app.post('/api/twilio/voice/status', form, requireTwilio, guard(postVoiceStatus));
  app.post('/api/twilio/sms', form, requireTwilio, guard(postSms));
  app.post('/api/twilio/sms/status', form, requireTwilio, guard(postSmsStatus));
  app.post('/api/support/sms-consent', guard(postConsent));
  app.post('/api/support/opt-out', guard(postStaffOptOut));

  return { attach, store, sessions, disabled: false, sendStatus, flushStatus };
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
        xml(res, messageTwiml(SAFE_FALLBACK));
        return;
      }
      if (req.path === '/api/twilio/sms/status') {
        res.status(200).type('text/plain').send('');
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

const OPT_OUT_BILLING = /\b(?:plans?|subscriptions?|billing|pro|starter|integrator|charges?|payments?|refunds?|cancels?|cancellations?|accounts?|premium|tiers?|services?)\b/i;
const MACHINE_STOP = /^(?:please\s+)?stop\b[\s,.:;/*-]*(?:button|light|code|sequence|circuit|signal|bit|category|time|instruction|mode|start|push-?button|relay|e-?stop)\b/i;

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function normalizeOptOut(body) {
  return normalizeInbound(body)
    .replace(/\btxting\b/gi, 'texting')
    .replace(/\btxts\b/gi, 'texts')
    .replace(/\btxt\b/gi, 'text')
    .replace(/\bpls\b/gi, 'please');
}

function wantsNoTexts(text) {
  if (/\bno more\s+(?:texts?|text messages?|sms|texting|messaging)\b/i.test(text)) return true;
  if (/\bno more\s+messages?\b/i.test(text)) {
    if (wordCount(text) <= 4) return true;
    return /\b(?:texts?|sms|list|number|texting)\b/i.test(text);
  }
  if (/\btake me off\b/i.test(text)) return true;
  if (/\b(?:remove|drop|delete) me from (?:this|the|your) (?:mailing |text |sms |message )?list\b/i.test(text)) return true;
  if (/\bstop\s+(?:texting|messaging|contacting)\s+me\b/i.test(text)) return true;
  if (/\bstop\s+sending\s+(?:me\s+)?(?:any\s+)?(?:more\s+)?(?:texts?|text messages?|messages?|sms)\b/i.test(text)) return true;
  if (/\b(?:do not|don't|dont)\s+(?:text|message|contact|sms)\s+me\b/i.test(text)) return true;
  if (/\b(?:do not|don't|dont)\s+send\s+(?:me\s+)?(?:any\s+)?(?:more\s+)?(?:texts?|text messages?|messages?|sms)\b/i.test(text)) return true;
  if (/\b(?:do not|don't|dont)\s+want\s+(?:to\s+(?:receive|get)\s+)?(?:any\s+|more\s+|these\s+|your\s+)*(?:texts?|text messages?|messages?|sms)\b/i.test(text)) return true;
  if (/\bquit\s+(?:texting|messaging)(?:\s+me)?\b/i.test(text)) return true;
  if (/\bend\s+(?:the\s+|these\s+|all\s+)?(?:texts?|text messages?|messages?|texting)\b/i.test(text)) return true;
  if (/\bleave me alone\b/i.test(text)) return true;
  if (/\blose my number\b/i.test(text)) return true;
  if (/\boff (?:this|your) list\b/i.test(text)) return true;
  if (/\b(?:remove|delete) my number\b/i.test(text)) return true;
  if (/\bcancel\s+texts?\b/i.test(text)) return true;
  if (/\b(?:did not|didn't|didnt) sign up\b/i.test(text) && /\bstop\b/i.test(text)) return true;
  if (/^please stop[.!]?$/i.test(text)) return true;
  if (wordCount(text) <= 3 && /\bstop[.!]?$/i.test(text)) return true;
  return false;
}

function bareRemoveMe(text) {
  if (!/\bremove me\b/i.test(text)) return false;
  if (/\bremove me\s+from\s+(?:the\s+)?(?:pro|starter|integrator|plan|subscription|account)\b/i.test(text)) return false;
  if (/\bremove me\s+from\s+(?:the\s+)?service\b/i.test(text)) return true;
  if (/\bremove me\s+as\b/i.test(text)) {
    if (wordCount(text) <= 4) return true;
    return /\b(?:texts?|sms|list|number|texting|messages?)\b/i.test(text);
  }
  if (wordCount(text) <= 8) return true;
  return /\b(?:texts?|sms|list|number|texting|messages?)\b/i.test(text);
}

function isOptOutMessage(body, keyword, optType) {
  try {
    return optOutDecision(body, keyword, optType);
  } catch (err) {
    console.error('Opt-out check failed');
    const key = keywordOf(body);
    return optType === 'STOP' || OPT_OUT.has(key);
  }
}

function optOutDecision(body, keyword, optType) {
  const text = normalizeOptOut(body);
  const key = keyword == null ? keywordOf(text) : keyword;
  const normalizedKey = keywordOf(text);
  if (optType === 'STOP' || OPT_OUT.has(key) || OPT_OUT.has(normalizedKey)) return true;
  if (MACHINE_STOP.test(text)) return false;
  if (/^stop\b/i.test(text)) return true;
  if (/^unsubscrib\w*/i.test(text) || /^unsub\b/i.test(text)) return true;
  if (/^opt(?:\s+me)?[\s-]+out\b/i.test(text)) return true;
  if (bareRemoveMe(text)) return true;
  // A request to stop texts opts out even when the same message also mentions billing.
  if (wantsNoTexts(text)) return true;
  if (OPT_OUT_BILLING.test(text)) return false;
  if (/\bunsubscrib\w*\b/i.test(text) || /\bunsub\b/i.test(text)) return true;
  if (/\bopt(?:\s+me)?[\s-]+out\b/i.test(text)) return true;
  return false;
}

function voiceInteraction(params) {
  return `call:${params.CallSid || 'na'}`;
}

function caller(params) {
  return e164(params.From) || 'unknown';
}

function safeNotice(notice) {
  const source = notice && typeof notice === 'object' ? notice : {};
  const category = clip(redactCardNumbers(source.category || 'escalation'), 40) || 'escalation';
  const from = e164(source.from) || 'unknown';
  const line = clip(redactCardNumbers(source.line || 'Needs a person.'), 160) || 'Needs a person.';
  return { category, from, line };
}

function spokenEscalation(notice) {
  const callerNumber = notice.from === 'unknown'
    ? 'unknown'
    : String(notice.from).replace(/[^\d+]/g, '').split('').join(' ');
  return clip(redactCardNumbers(`Category ${notice.category}. Caller ${callerNumber}. ${notice.line}`), 280);
}

function emailBody(notice) {
  const lines = [
    `Category: ${notice.category}`,
    `Caller: ${notice.from}`,
    `Reason: ${notice.line}`,
  ];
  if (notice.detail) lines.push('', notice.detail);
  return lines.join('\n');
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
    noRecord: value.noRecord === true,
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
  const raw = req && req.ip ? String(req.ip) : '';
  const address = raw || (req.socket && req.socket.remoteAddress) || '';
  return String(address).replace(/^::ffff:/, '').slice(0, 64);
}

function createConsentLimiter({
  limit = CONSENT_LIMIT,
  windowMs = CONSENT_WINDOW_MS,
  maxKeys = 5000,
  now = () => Date.now(),
} = {}) {
  const hits = new Map();
  return function tooMany(ip) {
    const key = ip || 'unknown';
    const at = now();
    for (const [existing, stamps] of hits) {
      const recent = stamps.filter((ts) => at - ts < windowMs);
      if (!recent.length) hits.delete(existing);
      else if (recent.length !== stamps.length) hits.set(existing, recent);
    }
    const recent = hits.get(key) || [];
    if (recent.length >= limit) {
      hits.set(key, recent);
      return true;
    }
    // A full map rejects new keys. Deleting the oldest would let a flood reset a blocked client.
    if (!hits.has(key) && hits.size >= maxKeys) return true;
    recent.push(at);
    hits.set(key, recent);
    return false;
  };
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

function consentGatherTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf speech" numDigits="1" timeout="4" speechTimeout="auto" hints="don't record, do not record, no recording" method="POST" action="/api/twilio/voice/consent">
    <Say language="en-US">${xmlText(CALL_OPENING)}</Say>
  </Gather>
  <Redirect method="POST">/api/twilio/voice/consent</Redirect>
</Response>`;
}

function gatherTwiml({ noRecord = false } = {}) {
  const action = noRecord ? '/api/twilio/voice/menu?noRecord=1' : '/api/twilio/voice/menu';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" timeout="8" method="POST" action="${action}">
    <Say language="en-US">${xmlText(GATHER_PROMPT)}</Say>
  </Gather>
  <Say language="en-US">We did not receive a selection. Goodbye.</Say>
</Response>`;
}

function sayThen(twiml, sentence) {
  return String(twiml).replace('<Response>', `<Response>\n  <Say language="en-US">${xmlText(sentence)}</Say>`);
}

function callbackTwiml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">${xmlText(CALLBACK_SAY)}</Say>
  <Hangup/>
</Response>`;
}

function declinedRecording(req) {
  const query = req && req.query ? req.query.noRecord : '';
  return String(query || '') === '1';
}

function safePageUrl(value) {
  const text = shortText(value, 500);
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|session|code/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().slice(0, 500);
  } catch {
    return '';
  }
}

function relayTwiml(url) {
  // Deepgram transcribes the call. Do not add speaker identification, diarization, or voiceprints (Illinois BIPA).
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="/api/twilio/voice/handoff">
    <ConversationRelay url="${xmlAttr(url)}" ttsProvider="Google" voice="${VOICE_ID}" language="en-US" transcriptionProvider="Deepgram" welcomeGreeting="${xmlAttr(WELCOME)}"/>
  </Connect>
</Response>`;
}

function dialTwiml(phone, noRecord) {
  const action = noRecord ? '/api/twilio/voice/dial-status?noRecord=1' : '/api/twilio/voice/dial-status';
  const record = noRecord ? ' record="do-not-record"' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" action="${action}"${record}>${xmlText(phone)}</Dial>
</Response>`;
}

function voicemailPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return VOICEMAIL_RECORDING_NOTICE;
  if (text.startsWith(VOICEMAIL_RECORDING_NOTICE)) return text;
  return `${VOICEMAIL_RECORDING_NOTICE} ${text}`;
}

function recordTwiml(prompt) {
  // Record without action re-requests this document and loops the menu. The goodbye lives on the action URL.
  // Transcription is for the support message. Do not add speaker identification or voiceprints (Illinois BIPA).
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">${xmlText(voicemailPrompt(prompt))}</Say>
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

function displaySupportPhone(value) {
  const phone = e164(value);
  if (!phone) return '';
  const digits = phone.slice(1);
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

function helpReply(env) {
  const number = displaySupportPhone(env && env.SUPPORT_PHONE);
  const call = number ? ` or call ${number}` : '';
  return `ManualOS (Op3x LLC) support: email support@manualos.com${call}. Msg&data rates may apply. Reply STOP to cancel.`;
}

function messageTwiml(text, options = {}) {
  const body = options.raw ? String(text || '') : formatCustomerSms(text, options);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${xmlText(body)}</Message>
</Response>`;
}

function isAlertConsent(row, phone, nowMs) {
  if (!row || row.phone !== phone) return false;
  if (row.pending === true) return false;
  if (row.alerts !== true) return false;
  if (row.consentTextVersion !== SMS_CONSENT_VERSION) return false;
  if (row.scope !== ALERT_SCOPE) return false;
  if (row.source === 'conversation-only') return false;
  if (/account/i.test(String(row.scope || ''))) return false;
  if (row.expiresAt) {
    const exp = Date.parse(row.expiresAt);
    if (!Number.isFinite(exp) || exp <= nowMs) return false;
  }
  return true;
}

function customerAlertsAllowed(records, phone, { optedOut = false, nowMs = Date.now() } = {}) {
  if (optedOut || !phone) return false;
  const rows = Array.isArray(records) ? records : [];
  return rows.some((row) => isAlertConsent(row, phone, nowMs));
}

function recentWebOptIns(records, phone, nowMs) {
  const rows = Array.isArray(records) ? records : [];
  return rows.filter((row) => {
    if (!row || row.phone !== phone || row.webOptIn !== true) return false;
    const at = Date.parse(row.timestamp || '');
    return Number.isFinite(at) && nowMs - at < WEB_OPT_IN_WINDOW_MS;
  });
}

function confirmationSentRecently(records, phone, nowMs) {
  const rows = Array.isArray(records) ? records : [];
  return rows.some((row) => {
    if (!row || row.phone !== phone || row.confirmationSent !== true) return false;
    const at = Date.parse(row.timestamp || '');
    return Number.isFinite(at) && nowMs - at < WEB_OPT_IN_WINDOW_MS;
  });
}

function hasFreshConversation(records, phone, nowMs) {
  const rows = Array.isArray(records) ? records : [];
  return rows.some((row) => {
    if (!row || row.phone !== phone) return false;
    if (row.alerts !== false || row.scope !== CONVERSATION_SCOPE) return false;
    const exp = Date.parse(row.expiresAt || '');
    return Number.isFinite(exp) && exp > nowMs;
  });
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
  CALL_OPENING,
  CALL_SCRIPT_VERSION,
  CALLBACK_SAY,
  SMS_STOP_CONFIRMATION,
  VOICEMAIL_RECORDING_NOTICE,
  VOICE_ID,
  SMS_CONSENT_VERSION,
  SMS_CONSENT_LABEL,
  SMS_OPT_IN_CONFIRMATION,
  ALERT_SCOPE,
  CONVERSATION_SCOPE,
  CONVERSATION_CONSENT_VERSION,
  CONVERSATION_TTL_MS,
  CONSENT_LIMIT,
  WEB_OPT_IN_LIMIT,
  WEB_OPT_IN_WINDOW_MS,
  createConsentLimiter,
  isOptOutMessage,
  customerAlertsAllowed,
  helpReply,
  fullPublicUrl,
};
