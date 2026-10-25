const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const twilio = require('twilio');
const { WebSocket } = require('ws');
const { createApp } = require('../server');
const { createSupportStore, removeTestSupportDirectories } = require('../lib/support/store');
const {
  CALL_OPENING,
  CALLBACK_SAY,
  SMS_CONSENT_LABEL,
  SMS_CONSENT_VERSION,
  SMS_STOP_CONFIRMATION,
  WELCOME,
  isOptOutMessage,
} = require('../lib/support/http');
const { FIVE_YEARS_MS, purgeExpiredConsents } = require('../lib/support/consent-retention');
const { deliverStatusText, flushStatusQueue } = require('../lib/support/status-sms');
const { supportStorageProblem } = require('../lib/support/storage-gate');
const { nextStatusOpen, timeZoneForPhone, withinStatusWindow } = require('../lib/support/quiet-hours');

const TOKEN = 'twilio-test-auth-token';
const dirs = [];

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  removeTestSupportDirectories();
});

function tempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(directory);
  return directory;
}

function persistDir() {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.support-persist-'));
  dirs.push(directory);
  return directory;
}

function tempStore(now = () => Date.parse('2026-10-25T12:00:00Z')) {
  const directory = tempDir('manualos-support-test-');
  return createSupportStore({ directory, env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: directory }, now });
}

function answer(reply) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          reply,
          confidence: 'high',
          handoff: false,
          reason: '',
          summary: 'answered',
        }),
      },
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  };
}

function allowVerdict() {
  return { choices: [{ message: { content: '{"refund":false,"leak":false}' } }] };
}

function harness(extra = {}) {
  const sent = [];
  const now = typeof extra.supportNow === 'function' ? extra.supportNow : () => Date.parse('2026-10-25T12:00:00Z');
  const { supportNow: _supportNow, ...envExtra } = extra;
  const store = tempStore(now);
  const env = {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_ACCOUNT_SID: 'AC_test_account',
    TWILIO_FROM_NUMBER: '+15557654321',
    SUPPORT_PHONE: '+15557654321',
    ESCALATION_PHONE: '+15550001111',
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'sk-test-not-real',
    LLM_MONTHLY_BUDGET_USD: '10',
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    SUPPORT_DATA_DIR: store.directory,
    ...envExtra,
  };
  const completions = [];
  const app = createApp({
    env,
    supportStore: store,
    twilioClient: {
      messages: {
        create: async (params) => {
          sent.push(params);
          return { sid: 'SM_test' };
        },
      },
    },
    supportComplete: async (request) => {
      completions.push(request);
      if (request && request.maxTokens === 60) return allowVerdict();
      return answer('Starter is $39 one-time for 3 manuals.');
    },
    supportNow: now,
  });
  return { app, env, store, sent, completions };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, port, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function postTwilio(base, env, requestPath, params) {
  const signUrl = `${env.PUBLIC_BASE_URL}${requestPath}`;
  const signature = twilio.getExpectedTwilioSignature(TOKEN, signUrl, params);
  return fetch(`${base}${requestPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

function smsText(xml) {
  const match = String(xml).match(/<Message>([\s\S]*)<\/Message>/);
  assert.ok(match, xml);
  return match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function consentRows(store) {
  const file = path.join(store.directory, 'consents.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function rawConsent(store) {
  const file = path.join(store.directory, 'consents.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('MS1 disclosure is gathered before transcription or the AI', async () => {
  assert.match(CALL_OPENING, /operated by Op3x LLC/);
  assert.match(CALL_OPENING, /AI assistant, not a person/);
  assert.match(CALL_OPENING, /transcribed and may be recorded/);
  assert.match(CALL_OPENING, /say 'don't record' or press 9 now/);
  assert.match(CALL_OPENING, /Staying on the line means you agree/);
  assert.equal(WELCOME, 'How can I help? You can ask for a person at any time.');

  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const params = { CallSid: 'CA_MS1', From: '+15551110000', CallStatus: 'ringing' };
    const openingRes = await postTwilio(base, h.env, '/api/twilio/voice', params);
    const opening = await openingRes.text();
    assert.match(opening, /input="dtmf speech"/);
    assert.match(opening, /numDigits="1"/);
    assert.match(opening, /timeout="4"/);
    assert.match(opening, /speechTimeout="auto"/);
    assert.match(opening, /hints="don't record, do not record, no recording"/);
    assert.match(opening, /action="\/api\/twilio\/voice\/consent"/);
    assert.match(opening, /<Redirect method="POST">\/api\/twilio\/voice\/consent<\/Redirect>/);
    assert.ok(opening.includes(CALL_OPENING.replace(/&/g, '&amp;')));
    assert.doesNotMatch(opening, /ConversationRelay|transcriptionProvider|<Record /);

    const other = await postTwilio(base, h.env, '/api/twilio/voice/consent', { ...params, Digits: '1' });
    const relay = await other.text();
    assert.match(relay, /<Connect /);
    assert.ok(relay.includes(`welcomeGreeting="${WELCOME}"`));
    assert.doesNotMatch(relay, /This call is transcribed/);
    const agreed = consentRows(h.store).find((row) => row.event === 'CALL_RECORDING_CONSENT');
    assert.equal(agreed.method, 'implied');
    assert.equal(agreed.consentText, 'implied');
    assert.equal(agreed.consentTextVersion, 'call-open-v1-2026-10-25');
    assert.equal(agreed.alerts, false);

    const silent = await postTwilio(base, h.env, '/api/twilio/voice/consent', {
      CallSid: 'CA_MS1_SILENT',
      From: '+15551110001',
    });
    assert.match(await silent.text(), /ConversationRelay/);
  });
});

test('MS1 declining by digit or speech never starts the relay and drops the speech', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const speech = "don't record this call UNIQUEPHRASE";
    const declined = await postTwilio(base, h.env, '/api/twilio/voice/consent', {
      CallSid: 'CA_DECLINE_SPEECH',
      From: '+15551114001',
      SpeechResult: speech,
    });
    const xml = await declined.text();
    assert.match(xml, /Okay\. This call won't be recorded or transcribed\./);
    assert.match(xml, /action="\/api\/twilio\/voice\/menu\?noRecord=1"/);
    assert.match(xml, /Press 1 for order or manual status/);
    assert.doesNotMatch(xml, /ConversationRelay|<Record |UNIQUEPHRASE/);
    const row = consentRows(h.store).find((item) => item.messageSid === 'CA_DECLINE_SPEECH');
    assert.equal(row.event, 'CALL_RECORDING_DECLINED');
    assert.equal(row.method, 'speech');
    assert.equal(row.consentText, 'speech');
    assert.equal(rawConsent(h.store).includes('UNIQUEPHRASE'), false);

    const digit = await postTwilio(base, h.env, '/api/twilio/voice/consent', {
      CallSid: 'CA_DECLINE_9',
      From: '+15551114002',
      Digits: '9',
      SpeechResult: 'leave this transcript',
    });
    const digitXml = await digit.text();
    assert.doesNotMatch(digitXml, /ConversationRelay|<Record |leave this transcript/);
    const digitRow = consentRows(h.store).find((item) => item.messageSid === 'CA_DECLINE_9');
    assert.equal(digitRow.method, 'dtmf');
    assert.equal(digitRow.consentText, 'dtmf');
    assert.equal(rawConsent(h.store).includes('leave this transcript'), false);
  });
});

test('MS1 saying stop recording ends the relay without another model call', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const voice = await postTwilio(base, h.env, '/api/twilio/voice/consent', {
      CallSid: 'CA_REVOKE',
      From: '+15551114003',
    });
    const xml = await voice.text();
    const match = xml.match(/url="([^"]+)"/);
    assert.ok(match);
    const relay = match[1].replace(/&amp;/g, '&');
    const signature = twilio.getExpectedTwilioSignature(TOKEN, relay, {});
    const ws = new WebSocket(relay, { headers: { 'X-Twilio-Signature': signature } });
    const messages = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay open timed out')), 3000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', reject);
    });
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.send(JSON.stringify({ type: 'setup', callSid: 'CA_REVOKE', from: '+15551114003' }));
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'please stop recording', last: true }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for end')), 3000);
      const timerId = setInterval(() => {
        if (messages.some((item) => item.type === 'end')) {
          clearTimeout(timer);
          clearInterval(timerId);
          resolve();
        }
      }, 20);
    });
    ws.close();
    assert.equal(h.completions.length, 0);
    assert.equal(messages[0].token, "Okay. This call won't be recorded or transcribed.");
    const ended = messages.find((item) => item.type === 'end');
    const data = JSON.parse(ended.handoffData);
    assert.equal(data.reason, 'no_record');
    assert.equal(data.noRecord, true);
    const revoked = consentRows(h.store).find((row) => row.event === 'CALL_RECORDING_REVOKED');
    assert.equal(revoked.consentText, 'speech');
    assert.equal(rawConsent(h.store).includes('please stop recording'), false);

    const menu = await postTwilio(base, h.env, '/api/twilio/voice/handoff', {
      CallSid: 'CA_REVOKE',
      From: '+15551114003',
      CallStatus: 'in-progress',
      HandoffData: ended.handoffData,
    });
    const menuXml = await menu.text();
    assert.match(menuXml, /action="\/api\/twilio\/voice\/menu\?noRecord=1"/);
    assert.doesNotMatch(menuXml, /<Record |ConversationRelay/);
  });
});

test('MS2 the no-AI fallback uses the same consent step', async () => {
  const h = harness({ LLM_API_KEY: '' });
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const opening = await postTwilio(base, h.env, '/api/twilio/voice', {
      CallSid: 'CA_NOAI',
      From: '+15551115000',
    });
    const first = await opening.text();
    assert.match(first, /action="\/api\/twilio\/voice\/consent"/);
    assert.ok(first.includes("say 'don't record' or press 9"));
    assert.doesNotMatch(first, /Press 1 for order|ConversationRelay/);
    const agreed = await postTwilio(base, h.env, '/api/twilio/voice/consent', {
      CallSid: 'CA_NOAI',
      From: '+15551115000',
    });
    const menu = await agreed.text();
    assert.match(menu, /Press 1 for order or manual status/);
    assert.doesNotMatch(menu, /ConversationRelay|noRecord=1/);
    const order = await postTwilio(base, h.env, '/api/twilio/voice/menu', {
      CallSid: 'CA_NOAI',
      From: '+15551115000',
      Digits: '1',
    });
    const recorded = await order.text();
    assert.match(recorded, /<Record /);
    assert.match(recorded, /This message will be recorded and transcribed/);
  });
});

test('MS3 a caller who declines gets a callback and no voicemail', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const from = '+15551116000';
    for (const digit of ['1', '2']) {
      const res = await postTwilio(base, h.env, '/api/twilio/voice/menu?noRecord=1', {
        CallSid: `CA_CB_${digit}`,
        From: from,
        Digits: digit,
        SpeechResult: 'my card is 4111111111111111 and my story',
      });
      const xml = await res.text();
      assert.ok(xml.includes(CALLBACK_SAY));
      assert.match(xml, /<Hangup\/>/);
      assert.doesNotMatch(xml, /<Record |transcribe=|4111|my story/);
    }
    const missed = await postTwilio(base, h.env, '/api/twilio/voice/dial-status?noRecord=1', {
      CallSid: 'CA_CB_DIAL',
      From: from,
      DialCallStatus: 'failed',
    });
    const missedXml = await missed.text();
    assert.match(missedXml, /<Hangup\/>/);
    assert.doesNotMatch(missedXml, /<Record /);

    const transfer = await postTwilio(base, h.env, '/api/twilio/voice/menu?noRecord=1', {
      CallSid: 'CA_CB_0',
      From: from,
      Digits: '0',
    });
    const dial = await transfer.text();
    assert.match(dial, /<Dial [^>]*record="do-not-record"/);
    assert.match(dial, /action="\/api\/twilio\/voice\/dial-status\?noRecord=1"/);
    assert.doesNotMatch(dial, /<Record /);

    const log = fs.readFileSync(path.join(h.store.directory, 'callbacks.jsonl'), 'utf8');
    assert.match(log, /CA_CB_1/);
    assert.match(log, /CA_CB_2/);
    assert.match(log, /CA_CB_DIAL/);
    assert.doesNotMatch(log, /4111|my story|SpeechResult/);
    const rows = log.trim().split('\n').map((line) => JSON.parse(line));
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['at', 'callSid', 'phone']);
      assert.equal(row.phone, from);
    }
    assert.ok(h.sent.some((item) => item.body.includes(`Callback request from ${from}.`)));
    assert.ok(h.sent.every((item) => !/4111|my story/.test(item.body)));
  });

  const quiet = harness({ ESCALATION_PHONE: '' });
  await withServer(quiet.app, async ({ base }) => {
    quiet.env.PUBLIC_BASE_URL = base;
    const res = await postTwilio(base, quiet.env, '/api/twilio/voice/menu?noRecord=1', {
      CallSid: 'CA_CB_NOPHONE',
      From: '+15551116009',
      Digits: '0',
    });
    const xml = await res.text();
    assert.match(xml, /<Hangup\/>/);
    assert.doesNotMatch(xml, /<Record |<Dial /);
    assert.equal(quiet.sent.length, 0);
    const log = fs.readFileSync(path.join(quiet.store.directory, 'callbacks.jsonl'), 'utf8');
    assert.match(log, /CA_CB_NOPHONE/);
  });
});

test('MS4 web consent records userAgent and pageUrl', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    const agent = `ManualOSTest/${'A'.repeat(420)}`;
    const page = 'https://manualos.com/support?plan=pro&token=sekret&session=abc&password=p&code=9&ok=1';
    const res = await fetch(`${base}/api/support/sms-consent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://manualos.com',
        'User-Agent': agent,
      },
      body: JSON.stringify({
        phone: '+15551117000',
        consentTextVersion: SMS_CONSENT_VERSION,
        consentText: SMS_CONSENT_LABEL,
        source: 'website',
        pageUrl: page,
      }),
    });
    assert.equal(res.status, 201);
    const row = consentRows(h.store).find((item) => item.phone === '+15551117000');
    assert.equal(row.userAgent.length, 400);
    assert.equal(row.userAgent, agent.slice(0, 400));
    assert.match(row.pageUrl, /plan=pro/);
    assert.match(row.pageUrl, /ok=1/);
    assert.doesNotMatch(row.pageUrl, /sekret|token=|session=|password=|code=/);
    assert.match(row.occurredAt, /^2026-10-25T07:00:00[+-]\d{2}:\d{2}$/);

    const referred = await fetch(`${base}/api/support/sms-consent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://manualos.com',
        Referer: 'https://manualos.com/pricing?secret=hide-me',
        'User-Agent': '',
      },
      body: JSON.stringify({
        phone: '+15551117001',
        consentTextVersion: SMS_CONSENT_VERSION,
        consentText: SMS_CONSENT_LABEL,
        source: 'website',
      }),
    });
    assert.equal(referred.status, 201);
    const second = consentRows(h.store).find((item) => item.phone === '+15551117001');
    assert.equal(second.pageUrl, 'https://manualos.com/pricing');
    assert.equal(second.userAgent, undefined);

    const script = await fetch(`${base}/api/support/sms-consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://manualos.com' },
      body: JSON.stringify({
        phone: '+15551117002',
        consentTextVersion: SMS_CONSENT_VERSION,
        consentText: SMS_CONSENT_LABEL,
        pageUrl: 'javascript:alert(1)',
      }),
    });
    assert.equal(script.status, 201);
    const third = consentRows(h.store).find((item) => item.phone === '+15551117002');
    assert.equal(third.pageUrl, undefined);
  });
});

test('MS5 STOP and HELP history is append-only', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const phone = '+15551118000';
    const first = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: phone,
      Body: 'STOP',
      MessageSid: 'SM_STOP_1',
    });
    assert.equal(smsText(await first.text()), SMS_STOP_CONFIRMATION);
    const afterFirst = rawConsent(h.store);
    const second = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: phone,
      Body: 'stop texting me right now and forever please thanks',
      MessageSid: 'SM_STOP_2',
    });
    assert.equal(smsText(await second.text()), SMS_STOP_CONFIRMATION);
    const afterSecond = rawConsent(h.store);
    assert.ok(afterSecond.startsWith(afterFirst));
    assert.notEqual(afterSecond, afterFirst);
    const stops = consentRows(h.store).filter((row) => row.event === 'KEYWORD_STOP');
    assert.equal(stops.length, 2);
    assert.equal(stops[0].consentText, 'STOP');
    assert.equal(stops[1].consentText.length, 40);
    assert.equal(stops[0].messageSid, 'SM_STOP_1');
    assert.equal(stops[1].messageSid, 'SM_STOP_2');
    const opt = JSON.parse(fs.readFileSync(path.join(h.store.directory, 'opt-outs.json'), 'utf8'));
    assert.equal(Object.keys(opt.optOuts).length, 1);
    assert.ok(opt.optOuts[phone]);

    const help = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551118001',
      Body: 'HELP',
      MessageSid: 'SM_HELP_1',
    });
    const helpBody = smsText(await help.text());
    assert.equal(helpBody, 'ManualOS (Op3x LLC) support: email support@manualos.com or call +1 555-765-4321. Msg&data rates may apply. Reply STOP to cancel.');
    const info = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551118001',
      Body: 'INFO',
      MessageSid: 'SM_INFO_1',
    });
    assert.equal(smsText(await info.text()), helpBody);
    const helps = consentRows(h.store).filter((row) => row.event === 'KEYWORD_HELP');
    assert.equal(helps.length, 2);
    assert.deepEqual(helps.map((row) => row.consentText), ['HELP', 'INFO']);
    assert.equal(rawConsent(h.store).split('\n').filter(Boolean).length, 4);
  });
});

test('MS6 the STOP reply is the approved sentence', () => {
  assert.equal(
    SMS_STOP_CONFIRMATION,
    "ManualOS (Op3x LLC): You're unsubscribed and will get no more texts. Reply START to opt back in.",
  );
  assert.equal(SMS_STOP_CONFIRMATION.length, 96);
  assert.equal(SMS_STOP_CONFIRMATION.includes('\u2019'), false);
  assert.equal(SMS_STOP_CONFIRMATION.includes("'"), true);
});

test('MS9 free-text opt-outs are honored and PLC phrases are not', async () => {
  assert.equal(isOptOutMessage('stop texting me'), true);
  assert.equal(isOptOutMessage('unsubscribe me'), true);
  assert.equal(isOptOutMessage('Stop please'), true);
  assert.equal(isOptOutMessage('Stop button broken'), false);
  assert.equal(isOptOutMessage('STOP mode'), false);
  assert.equal(isOptOutMessage('Stop bit is high'), false);
  assert.equal(isOptOutMessage('please stop the conveyor'), false);

  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const stopText = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119010',
      Body: 'stop texting me',
      MessageSid: 'SM_FREE_1',
    });
    assert.equal(smsText(await stopText.text()), SMS_STOP_CONFIRMATION);
    assert.equal(h.store.isOptedOut('+15551119010'), true);
    const unsub = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119011',
      Body: 'unsubscribe me',
      MessageSid: 'SM_FREE_2',
    });
    assert.equal(smsText(await unsub.text()), SMS_STOP_CONFIRMATION);
    assert.equal(h.store.isOptedOut('+15551119011'), true);
    const plc = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119012',
      Body: 'Stop button broken',
      MessageSid: 'SM_PLC',
    });
    assert.doesNotMatch(await plc.text(), /unsubscribed/i);
    assert.equal(h.store.isOptedOut('+15551119012'), false);
    assert.equal(h.sent.length, 0);

    const missing = await fetch(`${base}/api/support/opt-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-support-staff-token': 'nope' },
      body: JSON.stringify({ phone: '+15551119020', actor: 'email:ada' }),
    });
    assert.equal(missing.status, 404);
  });

  const staff = harness({ SUPPORT_STAFF_TOKEN: 'staff-test-token' });
  await withServer(staff.app, async ({ base }) => {
    const wrong = await fetch(`${base}/api/support/opt-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-support-staff-token': 'wrong-token' },
      body: JSON.stringify({ phone: '+15551119021', actor: 'email:ada' }),
    });
    assert.equal(wrong.status, 403);
    const res = await fetch(`${base}/api/support/opt-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-support-staff-token': 'staff-test-token' },
      body: JSON.stringify({ phone: '+15551119021', actor: 'email:ada' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, event: 'OPT_OUT_OTHER' });
    assert.equal(JSON.stringify(body).includes('+15551119021'), false);
    assert.equal(staff.store.isOptedOut('+15551119021'), true);
    const row = consentRows(staff.store).find((item) => item.phone === '+15551119021');
    assert.equal(row.event, 'OPT_OUT_OTHER');
    assert.equal(row.actor, 'staff:email:ada');
    assert.equal(staff.sent.length, 0);
  });

  const dir = tempDir('manualos-cli-opt-');
  const cli = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'support-opt-out.js'),
    '--phone', '+15551119030',
    '--actor', 'email:sam',
  ], {
    env: { ...process.env, NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), 'opt-out recorded');
  const stored = createSupportStore({ directory: dir, env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: dir } });
  assert.equal(stored.isOptedOut('+15551119030'), true);
  const cliRow = stored.listConsents().find((item) => item.phone === '+15551119030');
  assert.equal(cliRow.event, 'OPT_OUT_OTHER');
  assert.equal(cliRow.actor, 'staff:email:sam');
  const usage = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'support-opt-out.js')], {
    env: { ...process.env, NODE_ENV: 'test', SUPPORT_DATA_DIR: dir },
    encoding: 'utf8',
  });
  assert.equal(usage.status, 1);
});

test('MS10 production refuses a missing persistent support directory without stopping checkout', async () => {
  assert.equal(supportStorageProblem({ NODE_ENV: 'test' }), '');
  assert.equal(supportStorageProblem({ NODE_ENV: 'production' }), 'SUPPORT_DATA_DIR is not set');
  assert.equal(supportStorageProblem({ RAILWAY_ENVIRONMENT: 'production' }), 'SUPPORT_DATA_DIR is not set');
  assert.match(supportStorageProblem({ NODE_ENV: 'production', SUPPORT_DATA_DIR: 'data/support' }), /absolute path/);
  assert.match(supportStorageProblem({ NODE_ENV: 'production', SUPPORT_DATA_DIR: os.tmpdir() }), /temporary directory/);
  const kept = persistDir();
  assert.equal(supportStorageProblem({ NODE_ENV: 'production', SUPPORT_DATA_DIR: kept }), '');

  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
  assert.match(readme, /Required in production/);
  assert.match(readme, /support routes stay unmounted/);
  assert.match(readme, /purgeExpiredConsents/);

  const errors = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args.map((item) => String(item)).join(' '));
  };
  try {
    const app = createApp({
      env: {
        NODE_ENV: 'production',
        FRONTEND_URL: 'https://manualos.com',
        TWILIO_AUTH_TOKEN: TOKEN,
        PUBLIC_BASE_URL: 'http://127.0.0.1',
      },
    });
    await withServer(app, async ({ base }) => {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      const sms = await fetch(`${base}/api/twilio/sms`, { method: 'POST' });
      assert.equal(sms.status, 404);
      const voice = await fetch(`${base}/api/twilio/voice`, { method: 'POST' });
      assert.equal(voice.status, 404);
    });
    const railway = createApp({
      env: {
        NODE_ENV: 'test',
        RAILWAY_ENVIRONMENT: 'production',
        FRONTEND_URL: 'https://manualos.com',
        TWILIO_AUTH_TOKEN: TOKEN,
      },
    });
    await withServer(railway, async ({ base }) => {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      const sms = await fetch(`${base}/api/twilio/sms`, { method: 'POST' });
      assert.equal(sms.status, 404);
    });
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) => line.startsWith('SUPPORT LINE DISABLED:')));
  assert.equal(process.exitCode, undefined);

  const mounted = createApp({
    env: {
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://manualos.com',
      TWILIO_AUTH_TOKEN: TOKEN,
      SUPPORT_DATA_DIR: kept,
      PUBLIC_BASE_URL: 'http://127.0.0.1',
    },
  });
  await withServer(mounted, async ({ base }) => {
    const sms = await fetch(`${base}/api/twilio/sms`, { method: 'POST' });
    assert.equal(sms.status, 403);
  });
});

test('MS11 consent rows expire five years after the later of the last text and the opt-out', () => {
  const dir = tempDir('manualos-retention-');
  const now = Date.parse('2026-10-25T12:00:00Z');
  const old = new Date(now - FIVE_YEARS_MS - (24 * 60 * 60 * 1000)).toISOString();
  const edge = new Date(now - FIVE_YEARS_MS).toISOString();
  const recent = new Date(now - (24 * 60 * 60 * 1000)).toISOString();
  const optOuts = {
    optOuts: {
      '+15551110001': { at: old, source: 'sms' },
      '+15551110002': { at: recent, source: 'sms' },
      '+15551110004': { at: old, source: 'sms' },
    },
    optIns: {},
    lastMessages: {
      '+15551110003': recent,
      '+15551110004': old,
    },
    statusQueue: [{ id: 'keep-me', phone: '+15551110004', body: 'queued', notBefore: now }],
  };
  fs.writeFileSync(path.join(dir, 'opt-outs.json'), JSON.stringify(optOuts));
  const lines = [
    JSON.stringify({ phone: '+15551110001', timestamp: old, source: 'sms-stop', event: 'KEYWORD_STOP' }),
    JSON.stringify({ phone: '+15551110002', timestamp: old, source: 'sms-stop', event: 'KEYWORD_STOP' }),
    JSON.stringify({ phone: '+15551110003', timestamp: old, source: 'website', event: 'WEB' }),
    JSON.stringify({ phone: '+15551110004', timestamp: old, source: 'sms-stop', event: 'KEYWORD_STOP' }),
    JSON.stringify({ phone: '+15551110005', timestamp: edge, source: 'website' }),
    'not-json',
  ];
  fs.writeFileSync(path.join(dir, 'consents.jsonl'), `${lines.join('\n')}\n`);
  const result = purgeExpiredConsents(dir, now);
  assert.equal(result.dropped, 2);
  const kept = fs.readFileSync(path.join(dir, 'consents.jsonl'), 'utf8').trim().split('\n');
  const phones = kept.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line).phone);
  assert.deepEqual(phones, ['+15551110002', '+15551110003', '+15551110005']);
  assert.equal(kept.includes('not-json'), true);
  assert.equal(fs.readFileSync(path.join(dir, 'opt-outs.json'), 'utf8'), JSON.stringify(optOuts));
  const again = purgeExpiredConsents(dir, now);
  assert.equal(again.dropped, 0);

  const store = createSupportStore({ directory: dir, env: { NODE_ENV: 'test' }, now: () => now });
  assert.equal(store.purgeConsents(now).dropped, 0);
  assert.equal(store.isOptedOut('+15551110001'), true);
});

test('MS12 status texts wait for 8 AM to 8 PM in the recipient time zone', async () => {
  assert.equal(timeZoneForPhone('+12125550100'), 'America/New_York');
  assert.equal(timeZoneForPhone('+13125550100'), 'America/Chicago');
  assert.equal(timeZoneForPhone('+13855550100'), 'America/Denver');
  assert.equal(timeZoneForPhone('+18085550100'), 'Pacific/Honolulu');
  assert.equal(timeZoneForPhone('+19995550100'), 'America/Chicago');
  assert.equal(timeZoneForPhone('+15015550100'), 'America/Chicago');

  const noon = Date.parse('2026-10-25T12:00:00Z');
  const store = tempStore(() => noon);
  const sent = [];
  const send = async (message) => {
    sent.push(message);
    return { sid: 'SM_status' };
  };
  const eastern = await deliverStatusText({
    store,
    phone: '+12125550100',
    body: 'Order 100 is ready',
    now: noon,
    send,
  });
  assert.equal(eastern.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+12125550100');

  const central = await deliverStatusText({
    store,
    phone: '+13125550100',
    body: 'Manual 200 is ready',
    now: noon,
    send,
  });
  assert.equal(central.queued, true);
  assert.equal(central.timeZone, 'America/Chicago');
  assert.equal(central.notBefore, Date.parse('2026-10-25T13:00:00Z'));
  assert.equal(sent.length, 1);

  const unknown = await deliverStatusText({
    store,
    phone: '+19995550100',
    body: 'Status for an unknown area code',
    now: noon,
    send,
  });
  assert.equal(unknown.queued, true);
  assert.equal(unknown.timeZone, 'America/Chicago');
  assert.equal(unknown.notBefore, Date.parse('2026-10-25T13:00:00Z'));

  const mountain = await deliverStatusText({
    store,
    phone: '+13855550100',
    body: 'Utah status',
    now: Date.parse('2026-10-25T14:00:00Z'),
    send,
  });
  assert.equal(mountain.sent, true);
  assert.equal(mountain.timeZone, 'America/Denver');

  const honolulu = await deliverStatusText({
    store,
    phone: '+18085550100',
    body: 'Island status',
    now: Date.parse('2026-10-25T17:00:00Z'),
    send,
  });
  assert.equal(honolulu.queued, true);
  assert.equal(honolulu.timeZone, 'Pacific/Honolulu');
  assert.equal(honolulu.notBefore, Date.parse('2026-10-25T18:00:00Z'));
  assert.equal(withinStatusWindow(Date.parse('2026-10-26T00:30:00Z'), 'America/New_York'), false);
  assert.equal(nextStatusOpen(Date.parse('2026-10-26T02:00:00Z'), 'America/Chicago'), Date.parse('2026-10-26T13:00:00Z'));

  const early = await flushStatusQueue({ store, now: noon, send });
  assert.equal(early.length, 0);
  const opened = await flushStatusQueue({ store, now: Date.parse('2026-10-25T13:00:00Z'), send });
  assert.equal(opened.filter((item) => item.sent).length, 2);
  assert.equal(store.dueStatusTexts(Date.parse('2026-10-25T13:00:00Z')).some((item) => item.phone === '+13125550100'), false);

  store.optOut('+18085550100', 'sms');
  const dropped = await flushStatusQueue({ store, now: Date.parse('2026-10-25T18:00:00Z'), send });
  assert.equal(dropped.some((item) => item.reason === 'opted-out'), true);
  assert.equal(sent.some((item) => item.to === '+18085550100'), false);

  const held = await deliverStatusText({
    store,
    phone: '+13125550100',
    body: 'card 4111111111111111 ready',
    now: noon,
  });
  assert.equal(held.queued, true);
  assert.doesNotMatch(store.dueStatusTexts(Date.parse('2026-10-26T00:00:00Z')).find((item) => item.phone === '+13125550100').body, /4111/);
  const unsent = await flushStatusQueue({ store, now: Date.parse('2026-10-25T13:00:00Z') });
  assert.equal(unsent[0].reason, 'not-configured');
  assert.equal(store.dueStatusTexts(Date.parse('2026-10-25T13:00:00Z')).some((item) => item.phone === '+13125550100'), true);

  const blocked = await deliverStatusText({
    store,
    phone: '+18085550100',
    body: 'should not send',
    now: Date.parse('2026-10-25T18:00:00Z'),
    send,
  });
  assert.equal(blocked.reason, 'opted-out');
  assert.equal(blocked.sent, false);
});

test('MS12 a customer reply at 3 AM is not queued, and an owner page still goes out', async () => {
  const at = Date.parse('2026-10-25T08:00:00Z');
  const h = harness({ supportNow: () => at });
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    assert.equal(withinStatusWindow(at, 'America/Chicago'), false);
    const reply = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+13125550199',
      Body: 'How much is Starter?',
      MessageSid: 'SM_NIGHT',
    });
    assert.match(await reply.text(), /\$39/);
    const queued = JSON.parse(fs.readFileSync(path.join(h.store.directory, 'opt-outs.json'), 'utf8'));
    assert.deepEqual(queued.statusQueue, []);
    assert.equal(h.sent.length, 0);

    const cancel = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+13125550198',
      Body: 'CANCEL',
      MessageSid: 'SM_NIGHT_CANCEL',
    });
    assert.equal(smsText(await cancel.text()), SMS_STOP_CONFIRMATION);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].to, '+15550001111');
    const after = JSON.parse(fs.readFileSync(path.join(h.store.directory, 'opt-outs.json'), 'utf8'));
    assert.deepEqual(after.statusQueue, []);
  });
});
