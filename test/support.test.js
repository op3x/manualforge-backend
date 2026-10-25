const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const twilio = require('twilio');
const { WebSocket } = require('ws');
const { createApp } = require('../server');
const { createSupportStore, removeTestSupportDirectories } = require('../lib/support/store');
const { CONSENT_LIMIT, createConsentLimiter, isOptOutMessage } = require('../lib/support/http');
const { createSmtpMailer } = require('../lib/support/mail');
const policy = require('../lib/support/policy');

const TOKEN = 'twilio-test-auth-token';
const dirs = [];

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  removeTestSupportDirectories();
});

function tempStore(now = () => Date.parse('2026-10-25T12:00:00Z')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-support-test-'));
  dirs.push(directory);
  return createSupportStore({ directory, env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: directory }, now });
}

function answer(reply, extra = {}) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          reply,
          confidence: extra.confidence || 'high',
          handoff: Boolean(extra.handoff),
          reason: extra.reason || '',
          summary: extra.summary || 'answered',
        }),
      },
    }],
    usage: extra.usage || { prompt_tokens: 20, completion_tokens: 10 },
  };
}

function harness(extra = {}) {
  const sent = [];
  const calls = [];
  const completions = [];
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
    ...envExtra,
  };
  let completeImpl = async () => answer('Starter is $39 one-time for 3 manuals.');
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
      calls: {
        create: async (params) => {
          calls.push(params);
          return { sid: 'CA_test' };
        },
      },
    },
    supportComplete: async (request) => {
      completions.push(request);
      return completeImpl(request);
    },
    supportNow: now,
  });
  return {
    app,
    env,
    store,
    sent,
    calls,
    completions,
    setComplete(fn) { completeImpl = fn; },
  };
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

function signedFetch(fetchUrl, signUrl, params, token = TOKEN) {
  const signature = twilio.getExpectedTwilioSignature(token, signUrl, params);
  return fetch(fetchUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

function postTwilio(base, env, path, params, token = TOKEN) {
  const signUrl = `${env.PUBLIC_BASE_URL}${path}`;
  return signedFetch(`${base}${path}`, signUrl, params, token);
}

function openRelay(url, signature) {
  const ws = new WebSocket(url, { headers: { 'X-Twilio-Signature': signature } });
  ws.on('error', () => {});
  const queue = [];
  let waiter = null;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (waiter) {
      const pending = waiter;
      waiter = null;
      pending(msg);
    } else queue.push(msg);
  });
  const client = {
    ws,
    queue,
    send(obj) { ws.send(JSON.stringify(obj)); },
    next(ms = 3000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for relay message')), ms);
        waiter = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
      });
    },
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('relay open timed out'));
    }, 3000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(client);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function relayUrlFrom(xml) {
  const match = xml.match(/url="([^"]+)"/);
  assert.ok(match, xml);
  return match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

function state() {
  return { turns: 0, lowConfidence: 0, history: [] };
}

function aiEnv(extra = {}) {
  return {
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'sk-test-not-real',
    LLM_MODEL: 'gpt-4o-mini',
    LLM_MONTHLY_BUDGET_USD: '10',
    ...extra,
  };
}

test('policy facts, budget math, guardrails, and caps', async () => {
  assert.equal(policy.monthlyBudgetUsd({}), 10);
  assert.equal(policy.llmConfig({}).model, 'gpt-4o-mini');
  assert.equal(policy.aiConfigured({ LLM_API_KEY: 'sk-test' }), true);
  assert.equal(policy.aiConfigured({ LLM_PROVIDER: 'other', LLM_API_KEY: 'sk-test' }), false);
  const prompt = policy.systemPrompt({}, 'voice');
  assert.match(prompt, /Starter is \$39 one-time for 3 manuals/);
  assert.match(prompt, /\$79 per month/);
  assert.match(prompt, /Starter within 30 days of purchase; Pro charges before that billing period ends/);
  assert.match(prompt, /Never promise a refund/);
  assert.doesNotMatch(prompt, /31-day/);
  assert.doesNotMatch(prompt, /Pro and Integrator charges/);
  assert.match(prompt, /support@manualos\.com/);
  assert.match(prompt, /not launched/);
  assert.doesNotMatch(prompt, /2,490/);
  const launched = policy.systemPrompt({ SUPPORT_INTEGRATOR_ENABLED: 'true' }, 'sms');
  assert.match(launched, /\$249 per month or \$2,490 per year/);
  assert.match(launched, /\$9 per extra manual/);
  assert.match(launched, /Pro and Integrator charges before that billing period ends/);

  const cost = policy.tokenCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.ok(Math.abs(cost.usd - 0.75) < 1e-8);
  assert.equal(policy.containsCardNumber('4111 1111 1111 1111'), true);
  assert.equal(policy.containsCardNumber('credit card'), false);
  assert.equal(policy.containsCardNumber('debit card'), false);
  assert.equal(policy.containsCardNumber('card number'), false);
  assert.equal(policy.containsCardNumber('cvv'), false);
  assert.equal(policy.classify('Was my credit card charged twice?'), 'billing');
  assert.equal(policy.containsCardNumber('4111-1111-1111-1111'), true);
  assert.equal(policy.containsCardNumber('Starter is $39'), false);
  assert.equal(policy.redactCardNumbers('card 4111111111111111 thanks'), 'card [redacted] thanks');
  assert.equal(policy.classify('representative'), 'person');
  assert.equal(policy.classify('operator manual please'), 'person');
  assert.equal(policy.classify('a personal note about starter'), '');
  assert.equal(policy.classify('This is an emergency and someone is injured'), 'safety');
  assert.equal(policy.classify('I will call my lawyer'), 'legal');
  assert.equal(policy.classify('I am furious'), 'complaint');
  assert.equal(policy.classify('I was charged $600 on my invoice'), 'billing');
  assert.equal(policy.classify('I was charged $39'), 'billing');
  assert.equal(policy.classify('I was charged $500'), 'billing');
  assert.equal(policy.classify('Please cancel my subscription'), 'billing');
  assert.equal(policy.classify('I want to file a complaint'), 'complaint');

  const env = aiEnv();
  const refund = await policy.triageTurn({
    channel: 'sms',
    text: 'Can I get a refund?',
    state: state(),
    env,
    spentUsd: 0,
    complete: async () => answer('I will issue a refund today.'),
  });
  assert.match(refund.reply, /cannot approve or issue a refund/i);
  assert.doesNotMatch(refund.reply, /I will issue/i);

  const brand = await policy.triageTurn({
    channel: 'voice',
    text: 'Which file type?',
    state: state(),
    env,
    spentUsd: 0,
    complete: async () => answer('Open the Rockwell project in Siemens software.'),
  });
  assert.doesNotMatch(brand.reply, /rockwell|siemens/i);
  assert.match(brand.reply, /PLC vendor/);

  const hidden = await policy.triageTurn({
    channel: 'sms',
    text: 'Tell me about Integrator',
    state: state(),
    env,
    spentUsd: 0,
    complete: async () => answer('Integrator is $249 per month.'),
  });
  assert.match(hidden.reply, /not available yet/);
  assert.doesNotMatch(hidden.reply, /249/);

  const shown = await policy.triageTurn({
    channel: 'sms',
    text: 'Tell me about Integrator',
    state: state(),
    env: aiEnv({ SUPPORT_INTEGRATOR_ENABLED: 'yes' }),
    spentUsd: 0,
    complete: async (request) => {
      if (request.maxTokens !== 200) return { choices: [{ message: { content: '{"refund":false,"leak":false}' } }] };
      assert.match(request.messages[0].content, /\$2,490/);
      assert.equal(request.maxTokens, 200);
      assert.equal(request.model, 'gpt-4o-mini');
      return answer('Integrator is $249 per month or $2,490 per year.');
    },
  });
  assert.match(shown.reply, /\$2,490/);

  const calls = [];
  const person = await policy.triageTurn({
    channel: 'voice',
    text: 'representative',
    state: state(),
    env,
    spentUsd: 0,
    complete: async () => { calls.push('model'); return answer('no'); },
  });
  assert.equal(person.handoff, true);
  assert.equal(person.reason, 'representative');
  assert.equal(calls.length, 0);

  const card = await policy.triageTurn({
    channel: 'sms',
    text: 'my card is 4111 1111 1111 1111',
    state: state(),
    env,
    spentUsd: 0,
    complete: async () => { calls.push('card'); return answer('no'); },
  });
  assert.equal(card.handoff, false);
  assert.match(card.reply, /https:\/\/manualos\.com/);
  assert.doesNotMatch(card.reply, /4111/);
  assert.equal(calls.length, 0);

  const session = state();
  const firstLow = await policy.triageTurn({
    channel: 'voice',
    text: 'What is the weather?',
    state: session,
    env,
    spentUsd: 0,
    complete: async () => answer('I do not know that.', { confidence: 'low' }),
  });
  assert.equal(firstLow.handoff, false);
  const secondLow = await policy.triageTurn({
    channel: 'voice',
    text: 'And the stock price?',
    state: session,
    env,
    spentUsd: 0,
    complete: async () => answer('I still do not know.', { confidence: 'low' }),
  });
  assert.equal(secondLow.handoff, true);
  assert.equal(secondLow.reason, 'low_confidence');

  const capped = state();
  capped.turns = policy.SMS_TURN_CAP;
  const stop = await policy.triageTurn({
    channel: 'sms',
    text: 'one more question',
    state: capped,
    env,
    spentUsd: 0,
    complete: async () => answer('should not run'),
  });
  assert.equal(stop.reason, 'turn_cap');
  assert.equal(stop.handoff, true);

  const voiceCap = state();
  voiceCap.turns = policy.VOICE_TURN_CAP;
  const voiceStop = await policy.triageTurn({
    channel: 'voice',
    text: 'one more question',
    state: voiceCap,
    env,
    spentUsd: 0,
    complete: async () => answer('should not run'),
  });
  assert.equal(voiceStop.reason, 'turn_cap');

  const history = state();
  for (let i = 0; i < 5; i += 1) {
    await policy.triageTurn({
      channel: 'sms',
      text: `question ${i} about starter price`,
      state: history,
      env,
      spentUsd: 0,
      complete: async (request) => {
        assert.ok(request.messages.length <= policy.HISTORY_LIMIT + 2);
        return answer('Starter is $39 one-time for 3 manuals.');
      },
    });
  }
  assert.ok(history.history.length <= policy.HISTORY_LIMIT);

  const paused = await policy.triageTurn({
    channel: 'sms',
    text: 'How much is Pro?',
    state: state(),
    env,
    spentUsd: 10,
    complete: async () => { throw new Error('should not call'); },
  });
  assert.match(paused.reply, /paused/i);
  assert.match(paused.reply, /call you back/i);
  assert.equal(paused.escalate, true);
  assert.equal(paused.handoff, false);

  let seenKey = false;
  await assert.rejects(
    () => policy.completeOpenAI({
      apiKey: 'sk-secret-value',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 200,
      fetchImpl: async (url, options) => {
        seenKey = options.headers.Authorization === 'Bearer sk-secret-value';
        assert.equal(url, 'https://api.openai.com/v1/chat/completions');
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.equal(body.max_tokens, 200);
        assert.equal(body.model, 'gpt-4o-mini');
        return { ok: false, status: 401 };
      },
    }),
    (err) => err.message === 'LLM request failed' && !String(err.message).includes('sk-secret-value'),
  );
  assert.equal(seenKey, true);
});

test('store keeps opt-outs and warns when the data directory is ephemeral', () => {
  const store = tempStore();
  store.optOut('+15551212000', 'sms');
  const revived = createSupportStore({ directory: store.directory, env: { NODE_ENV: 'test' } });
  assert.equal(revived.isOptedOut('+15551212000'), true);
  revived.optIn('+15551212000', 'sms-start');
  assert.equal(revived.isOptedOut('+15551212000'), false);

  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    createSupportStore({ env: { NODE_ENV: 'production' } });
  } finally {
    console.warn = original;
  }
  assert.match(warnings.join('\n'), /SUPPORT_DATA_DIR/);
  assert.match(warnings.join('\n'), /volume/i);
});

test('voice signature, relay TwiML, and inert fallbacks', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const params = { CallSid: 'CA_LIVE', From: '+15551110000', To: '+15557654321', CallStatus: 'ringing' };
    const ok = await postTwilio(base, h.env, '/api/twilio/voice', params);
    assert.equal(ok.status, 200);
    const xml = await ok.text();
    assert.match(xml, /<Connect action="\/api\/twilio\/voice\/handoff">/);
    assert.match(xml, /ttsProvider="Google"/);
    assert.match(xml, /voice="en-US-Neural2-C"/);
    assert.match(xml, /language="en-US"/);
    assert.match(xml, /transcriptionProvider="Deepgram"/);
    assert.match(xml, /welcomeGreeting="Thanks for calling ManualOS support\. You're speaking with an AI assistant; say 'representative' any time to reach a person\."/);
    assert.match(xml, new RegExp(`url="ws://${base.slice('http://'.length)}/api/twilio/relay\\?token=`));

    const forged = await signedFetch(`${base}/api/twilio/voice`, 'http://evil.example/api/twilio/voice', params);
    assert.equal(forged.status, 403);
    assert.equal(h.sent.length, 0);

    const bad = await fetch(`${base}/api/twilio/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'nope' },
      body: new URLSearchParams(params).toString(),
    });
    assert.equal(bad.status, 403);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'manualos-backend');
  });

  const noKey = harness({ LLM_API_KEY: '   ' });
  await withServer(noKey.app, async ({ base }) => {
    noKey.env.PUBLIC_BASE_URL = base;
    const res = await postTwilio(base, noKey.env, '/api/twilio/voice', { CallSid: 'CA_NOKEY', From: '+15551110000' });
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.match(xml, /<Gather/);
    assert.match(xml, /Press 1 for order or manual status/);
    assert.match(xml, /press 2 for billing/);
    assert.match(xml, /press 0 to reach a person/);
    assert.doesNotMatch(xml, /ConversationRelay/);
  });

  const other = harness({ LLM_PROVIDER: 'other' });
  await withServer(other.app, async ({ base }) => {
    other.env.PUBLIC_BASE_URL = base;
    const res = await postTwilio(base, other.env, '/api/twilio/voice', { CallSid: 'CA_OTHER', From: '+15551110000' });
    assert.match(await res.text(), /<Gather/);
  });

  const broke = createApp({
    env: { NODE_ENV: 'test', FRONTEND_URL: 'https://manualos.com', LLM_API_KEY: 'sk-test' },
    twilioClient: null,
  });
  await withServer(broke, async ({ base }) => {
    const res = await fetch(`${base}/api/twilio/voice`, { method: 'POST' });
    assert.equal(res.status, 503);
    const sms = await fetch(`${base}/api/twilio/sms`, { method: 'POST' });
    assert.equal(sms.status, 503);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });

  const publicHost = harness();
  await withServer(publicHost.app, async ({ base }) => {
    publicHost.env.PUBLIC_BASE_URL = 'https://manualos.example';
    const params = { CallSid: 'CA_PUBLIC', From: '+15551110000', To: '+15557654321' };
    const res = await signedFetch(
      `${base}/api/twilio/voice`,
      'https://manualos.example/api/twilio/voice',
      params,
    );
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.match(xml, /wss:\/\/manualos\.example\/api\/twilio\/relay\?token=/);
  });
});

test('relay answers, refuses cards, and hands off', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const voice = await postTwilio(base, h.env, '/api/twilio/voice', {
      CallSid: 'CA_RELAY',
      From: '+15551110000',
      To: '+15557654321',
    });
    const relay = relayUrlFrom(await voice.text());
    const client = await openRelay(relay, twilio.getExpectedTwilioSignature(TOKEN, relay, {}));
    try {
      await assert.rejects(openRelay(relay, 'bad-signature'));
      client.send({ type: 'setup', callSid: 'CA_RELAY', from: '+15551110000' });
      client.send({ type: 'interrupt', utteranceUntilInterrupt: '', durationUntilInterruptMs: 10 });
      client.send({ type: 'prompt', voicePrompt: 'partial', lang: 'en-US', last: false });
      client.ws.send('not-json');
      client.send({ type: 'prompt', voicePrompt: 'How much is Starter?', lang: 'en-US', last: true });
      const reply = await client.next();
      assert.equal(reply.type, 'text');
      assert.equal(reply.last, true);
      assert.match(reply.token, /\$39/);
      assert.equal(h.completions.length, 2);
      assert.equal(h.completions[0].maxTokens, 200);
      assert.match(h.completions[0].messages[0].content, /Starter is \$39 one-time for 3 manuals/);

      client.send({ type: 'prompt', voicePrompt: 'my card is 4111 1111 1111 1111', last: true });
      const refused = await client.next();
      assert.equal(refused.type, 'text');
      assert.match(refused.token, /cannot take card numbers/);
      assert.doesNotMatch(refused.token, /4111/);
      assert.equal(h.completions.length, 2);

      client.send({ type: 'prompt', voicePrompt: 'I want a representative', last: true });
      const spoken = await client.next();
      const ended = await client.next();
      assert.equal(spoken.type, 'text');
      assert.match(spoken.token, /Connecting you to a person/);
      assert.equal(ended.type, 'end');
      const data = JSON.parse(ended.handoffData);
      assert.equal(data.handoff, true);
      assert.equal(data.reason, 'representative');
      assert.equal(data.from, '+15551110000');
      assert.equal(h.completions.length, 2);
    } finally {
      client.ws.close();
    }
  });

  const low = harness();
  low.setComplete(async () => answer('I do not know that.', { confidence: 'low', summary: 'unsure' }));
  await withServer(low.app, async ({ base }) => {
    low.env.PUBLIC_BASE_URL = base;
    const voice = await postTwilio(base, low.env, '/api/twilio/voice', { CallSid: 'CA_LOW', From: '+15551110009' });
    const relay = relayUrlFrom(await voice.text());
    const client = await openRelay(relay, twilio.getExpectedTwilioSignature(TOKEN, relay, {}));
    try {
      client.send({ type: 'setup', callSid: 'CA_LOW', from: '+15551110009' });
      client.send({ type: 'prompt', voicePrompt: 'What is the weather?', last: true });
      const first = await client.next();
      assert.equal(first.type, 'text');
      assert.match(first.token, /do not know/);
      client.send({ type: 'prompt', voicePrompt: 'What about tomorrow?', last: true });
      const second = await client.next();
      const ended = await client.next();
      assert.equal(second.type, 'text');
      assert.equal(ended.type, 'end');
      assert.equal(JSON.parse(ended.handoffData).reason, 'low_confidence');
    } finally {
      client.ws.close();
    }
  });
});

test('handoff dials, voicemail texts the owner, and the keypad works', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const handoff = await postTwilio(base, h.env, '/api/twilio/voice/handoff', {
      CallSid: 'CA_HAND',
      From: '+15551110000',
      CallStatus: 'in-progress',
      HandoffData: JSON.stringify({
        handoff: true,
        reason: 'safety',
        summary: 'Caller reported an emergency',
        from: '+15551110000',
      }),
    });
    assert.equal(handoff.status, 200);
    const xml = await handoff.text();
    assert.match(xml, /<Dial timeout="25" action="\/api\/twilio\/voice\/dial-status">\+15550001111<\/Dial>/);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].to, '+15550001111');
    assert.equal(h.sent[0].from, '+15557654321');
    assert.match(h.sent[0].body, /^ManualOS Support: /);
    assert.match(h.sent[0].body, /Caller reported an emergency/);
    assert.equal(h.sent[0].body.includes('\n'), false);

    const again = await postTwilio(base, h.env, '/api/twilio/voice/handoff', {
      CallSid: 'CA_HAND',
      From: '+15551110000',
      CallStatus: 'in-progress',
      HandoffData: JSON.stringify({ handoff: true, reason: 'safety', summary: 'duplicate', from: '+15551110000' }),
    });
    assert.match(await again.text(), /<Dial /);
    assert.equal(h.sent.length, 1);

    const hangup = await postTwilio(base, h.env, '/api/twilio/voice/handoff', {
      CallSid: 'CA_DONE',
      From: '+15551110000',
      CallStatus: 'completed',
    });
    assert.match(await hangup.text(), /<Response><\/Response>/);
    assert.equal(h.sent.length, 1);

    const missed = await postTwilio(base, h.env, '/api/twilio/voice/dial-status', {
      CallSid: 'CA_HAND',
      From: '+15551110000',
      DialCallStatus: 'no-answer',
    });
    const missedXml = await missed.text();
    assert.match(missedXml, /<Say/);
    assert.match(missedXml, /<Record [^>]*maxLength="120"/);
    assert.match(missedXml, /playBeep="true"/);
    assert.match(missedXml, /transcribe="true"/);
    assert.match(missedXml, /transcribeCallback="\/api\/twilio\/voice\/transcription"/);
    assert.match(missedXml, /action="\/api\/twilio\/voice\/recording-done"/);
    assert.match(missedXml, /recordingStatusCallback="\/api\/twilio\/voice\/recording"/);
    assert.doesNotMatch(missedXml, /<Gather/);
    const busy = await postTwilio(base, h.env, '/api/twilio/voice/dial-status', { DialCallStatus: 'busy' });
    assert.match(await busy.text(), /<Record /);
    const failed = await postTwilio(base, h.env, '/api/twilio/voice/dial-status', { DialCallStatus: 'failed' });
    assert.match(await failed.text(), /<Record /);
    const completed = await postTwilio(base, h.env, '/api/twilio/voice/dial-status', { DialCallStatus: 'completed' });
    assert.doesNotMatch(await completed.text(), /<Record /);

    const transcript = await postTwilio(base, h.env, '/api/twilio/voice/transcription', {
      CallSid: 'CA_HAND',
      From: '+15551110000',
      TranscriptionSid: 'TR1',
      TranscriptionStatus: 'completed',
      TranscriptionText: 'Please call me. My card is 4111111111111111.',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1',
    });
    assert.equal(transcript.status, 200);
    assert.equal(h.sent.length, 2);
    assert.match(h.sent[1].body, /Recordings\/RE1/);
    assert.doesNotMatch(h.sent[1].body, /4111/);
    assert.match(h.sent[1].body, /^ManualOS Support: /);

    const zero = await postTwilio(base, h.env, '/api/twilio/voice/menu', {
      CallSid: 'CA_MENU',
      From: '+15551110003',
      Digits: '0',
    });
    assert.match(await zero.text(), /<Dial timeout="25"/);
    assert.equal(h.sent.length, 3);
    const order = await postTwilio(base, h.env, '/api/twilio/voice/menu', { Digits: '1', CallSid: 'CA_MENU2' });
    assert.match(await order.text(), /order or manual status/);
    const billing = await postTwilio(base, h.env, '/api/twilio/voice/menu', { Digits: '2', CallSid: 'CA_MENU3' });
    const billingXml = await billing.text();
    assert.match(billingXml, /billing/i);
    assert.match(billingXml, /Do not leave a card number/);
    const status = await postTwilio(base, h.env, '/api/twilio/voice/status', { CallSid: 'CA_MENU', CallStatus: 'completed' });
    assert.equal(status.status, 200);
  });

  const noPhone = harness({ ESCALATION_PHONE: '' });
  await withServer(noPhone.app, async ({ base }) => {
    noPhone.env.PUBLIC_BASE_URL = base;
    const res = await postTwilio(base, noPhone.env, '/api/twilio/voice/handoff', {
      CallSid: 'CA_NOPHONE',
      From: '+15551110000',
      CallStatus: 'in-progress',
      HandoffData: JSON.stringify({ handoff: true, reason: 'representative', summary: 'Caller asked for a person' }),
    });
    const xml = await res.text();
    assert.match(xml, /<Record /);
    assert.doesNotMatch(xml, /<Dial /);
    assert.equal(noPhone.sent.length, 0);
  });
});

test('SMS keywords, opt-in, escalation, budget, and card refusal', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const from = '+15551110999';
    const help = await postTwilio(base, h.env, '/api/twilio/sms', { From: from, Body: 'help', MessageSid: 'SM_HELP' });
    const helpXml = await help.text();
    assert.match(helpXml, /ManualOS Support:/);
    assert.match(helpXml, /support@manualos\.com/);
    assert.match(helpXml, /Reply STOP to opt out, HELP for help\. Msg&amp;data rates may apply\./);

    const keywords = ['STOP', 'stop.', 'STOPALL', 'unsubscribe', 'CANCEL', 'END', 'QUIT'];
    for (const [index, body] of keywords.entries()) {
      const phone = `+1555200${String(index).padStart(4, '0')}`;
      const res = await postTwilio(base, h.env, '/api/twilio/sms', { From: phone, Body: body, MessageSid: `SM_STOP_${index}` });
      const xml = await res.text();
      assert.match(xml, /unsubscribed/i);
      assert.match(xml, /ManualOS Support:/);
      assert.equal(h.store.isOptedOut(phone), true);
      const follow = await postTwilio(base, h.env, '/api/twilio/sms', { From: phone, Body: 'hello there', MessageSid: `SM_AFTER_${index}` });
      assert.doesNotMatch(await follow.text(), /<Message>/);
    }

    const optType = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15552009999',
      Body: 'please stop texting',
      OptOutType: 'STOP',
      MessageSid: 'SM_OPT',
    });
    assert.match(await optType.text(), /unsubscribed/i);
    assert.equal(h.store.isOptedOut('+15552009999'), true);

    const info = await postTwilio(base, h.env, '/api/twilio/sms', { From: '+15552000000', Body: 'INFO', MessageSid: 'SM_INFO' });
    assert.match(await info.text(), /ManualOS Support:/);

    const start = await postTwilio(base, h.env, '/api/twilio/sms', { From: '+15552000000', Body: 'START', MessageSid: 'SM_START' });
    const startXml = await start.text();
    assert.match(startXml, /opted in/);
    assert.match(startXml, /Msg frequency varies/);
    assert.match(startXml, /Reply STOP to opt out/);
    assert.equal(h.store.isOptedOut('+15552000000'), false);
    assert.equal(h.store.listConsents().some((row) => row.phone === '+15552000000' && row.source === 'sms-start'), true);

    const unstop = await postTwilio(base, h.env, '/api/twilio/sms', { From: '+15552000001', Body: 'UNSTOP', MessageSid: 'SM_UNSTOP' });
    assert.match(await unstop.text(), /opted in/);

    const pricing = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551112222',
      Body: 'How much is Starter?',
      MessageSid: 'SM_PRICE',
    });
    const pricingXml = await pricing.text();
    assert.match(pricingXml, /ManualOS Support: Starter is \$39/);
    assert.match(pricingXml, /Reply STOP to opt out, HELP for help\. Msg&amp;data rates may apply\./);
    assert.equal(h.store.listConsents().some((row) => row.phone === '+15551112222' && row.source === 'inbound-sms' && row.consentTextVersion === 'inbound-sms-v1'), true);
    assert.equal(h.completions.length, 2);

    const card = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551113333',
      Body: 'my card is 4111-1111-1111-1111',
      MessageSid: 'SM_CARD',
    });
    const cardXml = await card.text();
    assert.match(cardXml, /cannot take card numbers/);
    assert.match(cardXml, /https:\/\/manualos\.com/);
    assert.doesNotMatch(cardXml, /4111/);
    assert.equal(h.completions.length, 2);
    assert.equal(h.sent.length, 0);

    const angry = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551114444',
      Body: 'I am furious',
      MessageSid: 'SM_ANGRY',
    });
    assert.match(await angry.text(), /person will follow up/);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].body, /furious/);
    assert.equal(h.completions.length, 2);

    h.store.saveThread('+15551115555', { turns: policy.SMS_TURN_CAP, lowConfidence: 0, history: [], updatedAt: '2026-10-25T00:00:00.000Z' });
    const capped = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551115555',
      Body: 'another question about starter',
      MessageSid: 'SM_CAP',
    });
    assert.match(await capped.text(), /person/);
    assert.equal(h.completions.length, 2);
    assert.equal(h.sent.length, 2);
  });

  const budget = harness({ LLM_MONTHLY_BUDGET_USD: '0.5' });
  budget.setComplete(async () => answer('Starter is $39 one-time for 3 manuals.', {
    usage: { prompt_tokens: 10, completion_tokens: 1_000_000 },
  }));
  await withServer(budget.app, async ({ base }) => {
    budget.env.PUBLIC_BASE_URL = base;
    const first = await postTwilio(base, budget.env, '/api/twilio/sms', {
      From: '+15551116666',
      Body: 'How much is Starter?',
      MessageSid: 'SM_BUDGET_1',
    });
    assert.match(await first.text(), /\$39/);
    assert.equal(budget.completions.length, 2);
    assert.ok(budget.store.spentUsd('2026-10') >= 0.5);
    const second = await postTwilio(base, budget.env, '/api/twilio/sms', {
      From: '+15551116666',
      Body: 'What about Pro?',
      MessageSid: 'SM_BUDGET_2',
    });
    const secondXml = await second.text();
    assert.match(secondXml, /paused/i);
    assert.match(secondXml, /call you back/i);
    assert.doesNotMatch(secondXml, /support@manualos\.com/);
    assert.equal(budget.completions.length, 2);
    assert.equal(budget.sent.length, 1);
    const third = await postTwilio(base, budget.env, '/api/twilio/sms', {
      From: '+15551116666',
      Body: 'Please call me back about Pro',
      MessageSid: 'SM_BUDGET_3',
    });
    assert.match(await third.text(), /call you back/i);
    assert.equal(budget.sent.length, 1);
    const call = await postTwilio(base, budget.env, '/api/twilio/voice', { CallSid: 'CA_BUDGET', From: '+15551116666' });
    const xml = await call.text();
    assert.match(xml, /<Gather/);
    assert.doesNotMatch(xml, /ConversationRelay/);
  });

  const seeded = harness();
  seeded.store.addUsage('2026-10', { inputTokens: 0, outputTokens: 0, usd: 10 });
  await withServer(seeded.app, async ({ base }) => {
    seeded.env.PUBLIC_BASE_URL = base;
    const call = await postTwilio(base, seeded.env, '/api/twilio/voice', { CallSid: 'CA_SEED', From: '+15551117777' });
    assert.match(await call.text(), /<Gather/);
    assert.equal(seeded.completions.length, 0);
  });
});

test('website SMS consent stores phone, version, time, IP, and source', async () => {
  const h = harness({ FRONTEND_URL: 'https://www.manualos.com' });
  await withServer(h.app, async ({ base }) => {
    const res = await fetch(`${base}/api/support/sms-consent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://manualos.com',
        'X-Forwarded-For': '203.0.113.9, 10.0.0.4',
      },
      body: JSON.stringify({
        phone: '+15551212000',
        consentTextVersion: 'checkbox-v3',
        source: 'pricing-footer',
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://manualos.com');
    assert.deepEqual(await res.json(), { ok: true });
    const [record] = h.store.listConsents();
    assert.equal(record.phone, '+15551212000');
    assert.equal(record.consentTextVersion, 'checkbox-v3');
    assert.equal(record.source, 'pricing-footer');
    assert.equal(record.ip, '10.0.0.4');
    assert.equal(record.timestamp, '2026-10-25T12:00:00.000Z');

    const badPhone = await fetch(`${base}/api/support/sms-consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://manualos.com' },
      body: JSON.stringify({ phone: '5551212', consentTextVersion: 'checkbox-v3' }),
    });
    assert.equal(badPhone.status, 400);
    const missing = await fetch(`${base}/api/support/sms-consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+15551212000' }),
    });
    assert.equal(missing.status, 400);
  });
});

function spokenCard() {
  return ['four', ...Array(15).fill('one')].join(' ');
}

function escalationEnv(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_ACCOUNT_SID: 'AC_test_account',
    TWILIO_FROM_NUMBER: '+15557654321',
    SUPPORT_PHONE: '+15557654321',
    ESCALATION_PHONE: '+15550001111',
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'sk-test-not-real',
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    ...extra,
  };
}

function escalationApp({ env, store, calls, mailer, onMessage }) {
  return createApp({
    env,
    supportStore: store,
    mailer,
    twilioClient: {
      messages: { create: onMessage },
      calls: {
        create: async (params) => {
          calls.push(params);
          return { sid: 'CA_fallback' };
        },
      },
    },
    supportComplete: async () => answer('should not call'),
    supportNow: () => Date.parse('2026-10-25T12:00:00Z'),
  });
}

test('review guardrails: cards, handoff words, refunds, brands, and idle threads', async () => {
  const spoken = spokenCard();
  assert.equal(policy.containsCardNumber('4111.1111.1111.1111'), true);
  assert.equal(policy.containsCardNumber('4111,1111/1111.1111'), true);
  assert.equal(policy.containsCardNumber('4111   1111   1111   1111'), true);
  assert.equal(policy.containsCardNumber(spoken), true);
  assert.equal(policy.containsCardNumber('one two three'), false);
  assert.equal(policy.redactCardNumbers(`pay 4111.1111.1111.1111 now`), 'pay [redacted] now');
  assert.equal(policy.redactCardNumbers(`card ${spoken} thanks`), 'card [redacted] thanks');
  assert.equal(policy.redactCardNumbers('4111,,1111//1111  1111'), '[redacted]');
  assert.doesNotMatch(policy.redactCardNumbers(spoken), /four|one|4111/i);

  for (const word of ['person', 'human', 'agent', 'operator', 'real person', 'talk to someone']) {
    assert.equal(policy.classify(word), 'person', word);
  }
  for (const phrase of ['the panel is smoking', 'I see fire', 'someone is injured', 'the guard broken', 'it is sparking']) {
    assert.equal(policy.classify(phrase), 'safety', phrase);
  }
  assert.equal(policy.classify(`representative ${spoken}`), 'card-person');

  const env = aiEnv();
  const both = await policy.triageTurn({
    channel: 'voice',
    text: `representative, card ${spoken}`,
    state: state(),
    env,
    spentUsd: 0,
    complete: async () => { throw new Error('should not call'); },
  });
  assert.equal(both.handoff, true);
  assert.equal(both.escalate, true);
  assert.match(both.reply, /cannot take card numbers/);
  assert.match(both.reply, /Connecting you to a person/);
  assert.doesNotMatch(`${both.reply} ${both.summary}`, /4111|four one/i);

  const smsBoth = await policy.triageTurn({
    channel: 'sms',
    text: `human ${spoken}`,
    state: state(),
    env,
    spentUsd: 0,
    complete: async () => { throw new Error('should not call'); },
  });
  assert.equal(smsBoth.handoff, true);
  assert.match(smsBoth.reply, /A person will follow up by text/);
  assert.doesNotMatch(smsBoth.reply, /4111|four one/i);

  const refundPromises = [
    "I'll refund the charge",
    'I refunded you yesterday',
    'Your refund is on its way',
    'You can get your money back',
    'We can issue a refund',
    "we'll refund you",
    'we will refund you',
    "I've issued a refund",
    'I have issued a refund',
    'Your refund is on the way',
    'You are eligible for a full refund',
    'you will get your money back',
    'You will receive a full refund',
    'Your refund has been processed',
    'I am going to approve a refund',
    'The money will be refunded today',
    "I'm processing your refund",
    'we can give you a refund',
    "I'll get that refunded",
    'your refund has been approved',
    "I've started a refund",
    "we'll credit your card",
    "you'll be reimbursed",
    "I'll reverse the charge",
    'consider it refunded',
    "we'll send your money back",
    'I can refund that for you',
    'refund will be issued',
  ];
  assert.ok(refundPromises.length >= 12);
  for (const phrase of refundPromises) {
    assert.equal(policy.promisesRefund(phrase), true, phrase);
    const cleaned = policy.applyGuardrails(phrase, env);
    assert.match(cleaned, /cannot approve or issue a refund/i, phrase);
    assert.doesNotMatch(cleaned, /I'll refund|we'll refund|issued a refund|on the way|on its way|money back|eligible for a full refund|will be refunded/i, phrase);
  }
  const policyLine = 'A purchase can be refunded only if no manual from it has been delivered: Starter within 30 days of purchase; Pro charges before that billing period ends.';
  assert.equal(policy.promisesRefund(policyLine), false);
  assert.equal(policy.applyGuardrails(policyLine, {}), policyLine);
  assert.equal(policy.promisesRefund('I cannot approve or issue a refund'), false);
  assert.equal(policy.applyGuardrails('I cannot approve or issue a refund', {}), 'I cannot approve or issue a refund');
  for (const safe of [
    'Your manual has been processed and is ready to download',
    "I can't issue refunds",
    'Refunds are handled by a person',
    'You may be eligible; a person will review it',
  ]) {
    assert.equal(policy.promisesRefund(safe), false, safe);
    assert.equal(policy.applyGuardrails(safe, {}), safe, safe);
  }
  assert.doesNotMatch(policy.applyGuardrails("we'll refund you", {}), /Integrator/);
  assert.match(policy.applyGuardrails("we'll refund you", { SUPPORT_INTEGRATOR_ENABLED: 'true' }), /Pro and Integrator charges/);
  assert.equal(policy.classify('please unsubscribe me'), '');

  const branded = policy.applyGuardrails(
    'Open Studio 5000, RSLogix, ControlLogix, CompactLogix, Logix Designer, Simatic, Step 7, TIA Portal, TwinCAT, Beckhoff, FactoryTalk, Inventor, Fusion 360, Fusion, CODESYS, GX Works, Creo, and CATIA. OpenAI, ChatGPT, GPT, Twilio, Google, and Anthropic Claude helped. Ask your PLC vendor TIA Portal.',
    env,
  );
  assert.doesNotMatch(branded, /studio|rslogix|controllogix|compactlogix|logix|simatic|step\s*7|tia|portal|twincat|beckhoff|factorytalk|inventor|fusion|codesys|works|creo|catia|openai|chatgpt|\bgpt\b|twilio|google|anthropic|claude/i);
  assert.doesNotMatch(branded, /vendor\s+your/i);
  assert.match(branded, /your PLC software/);

  const session = state();
  await policy.triageTurn({
    channel: 'sms',
    text: 'How much is Starter?',
    state: session,
    env,
    spentUsd: 0,
    complete: async () => answer('Noted 4111111111111111 already.'),
  });
  let payload = '';
  await policy.triageTurn({
    channel: 'sms',
    text: 'And Pro?',
    state: session,
    env,
    spentUsd: 0,
    complete: async (request) => {
      if (request.maxTokens === 200) payload = JSON.stringify(request.messages);
      return answer('Pro is $79 per month.');
    },
  });
  assert.doesNotMatch(payload, /4111111111111111/);
  assert.match(payload, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(session.history), /4111111111111111/);

  const clock = () => Date.parse('2026-10-25T12:00:00Z');
  const stale = state();
  stale.turns = policy.SMS_TURN_CAP;
  stale.updatedAt = '2026-10-23T12:00:00.000Z';
  let called = 0;
  const resumed = await policy.triageTurn({
    channel: 'sms',
    text: 'How much is Starter?',
    state: stale,
    env,
    spentUsd: 0,
    now: clock,
    complete: async () => {
      called += 1;
      return answer('Starter is $39 one-time for 3 manuals.');
    },
  });
  assert.equal(called, 2);
  assert.notEqual(resumed.reason, 'turn_cap');
  assert.match(resumed.reply, /\$39/);

  const recent = state();
  recent.turns = policy.SMS_TURN_CAP;
  recent.updatedAt = '2026-10-25T00:00:00.000Z';
  const stillCapped = await policy.triageTurn({
    channel: 'sms',
    text: 'one more question',
    state: recent,
    env,
    spentUsd: 0,
    now: clock,
    complete: async () => { throw new Error('should not call'); },
  });
  assert.equal(stillCapped.reason, 'turn_cap');

  const noKey = await policy.triageTurn({
    channel: 'sms',
    text: 'How much is Pro?',
    state: state(),
    env: aiEnv({ LLM_API_KEY: '' }),
    spentUsd: 0,
    complete: async () => { throw new Error('should not call'); },
  });
  assert.equal(noKey.escalate, true);
  assert.match(noKey.reply, /call you back/i);
  assert.doesNotMatch(noKey.reply, /support@manualos\.com/);
});

test('voicemail goodbye, recording notice, opt-out phrases, and SMS dedupe', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const order = await postTwilio(base, h.env, '/api/twilio/voice/menu', {
      Digits: '1',
      CallSid: 'CA_REC',
      From: '+15551110008',
    });
    const orderXml = await order.text();
    assert.match(orderXml, /action="\/api\/twilio\/voice\/recording-done"/);
    assert.match(orderXml, /recordingStatusCallback="\/api\/twilio\/voice\/recording"/);
    assert.doesNotMatch(orderXml, /<Gather/);

    const done = await postTwilio(base, h.env, '/api/twilio/voice/recording-done', {
      CallSid: 'CA_REC',
      From: '+15551110008',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE9',
    });
    const doneXml = await done.text();
    assert.match(doneXml, /Goodbye/);
    assert.match(doneXml, /<Hangup\/>/);
    assert.doesNotMatch(doneXml, /<Gather|<Record |ConversationRelay/);

    const recorded = await postTwilio(base, h.env, '/api/twilio/voice/recording', {
      CallSid: 'CA_REC',
      From: '+15551110008',
      RecordingSid: 'RE9',
      RecordingStatus: 'completed',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE9',
    });
    assert.equal(recorded.status, 200);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].body, /Recordings\/RE9/);
    const again = await postTwilio(base, h.env, '/api/twilio/voice/recording', {
      CallSid: 'CA_REC',
      From: '+15551110008',
      RecordingSid: 'RE9',
      RecordingStatus: 'completed',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE9',
    });
    assert.equal(again.status, 200);
    assert.equal(h.sent.length, 1);

    const failedTranscript = await postTwilio(base, h.env, '/api/twilio/voice/transcription', {
      CallSid: 'CA_REC',
      From: '+15551110008',
      TranscriptionSid: 'TR_FAIL',
      TranscriptionStatus: 'failed',
      TranscriptionText: '',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE9',
    });
    assert.equal(failedTranscript.status, 200);
    assert.equal(h.sent.length, 2);

    const unsigned = await fetch(`${base}/api/twilio/voice/recording-done`, { method: 'POST' });
    assert.equal(unsigned.status, 403);

    const phrases = [
      ['+15553000001', 'REVOKE'],
      ['+15553000002', 'OPTOUT'],
      ['+15553000003', 'opt-out'],
      ['+15553000004', 'opt out'],
      ['+15553000005', 'STOP texting me now'],
      ['+15553000006', 'please stop messaging me'],
      ['+15553000007', 'stop the machine'],
    ];
    for (const [phone, body] of phrases) {
      const res = await postTwilio(base, h.env, '/api/twilio/sms', { From: phone, Body: body, MessageSid: `SM_${phone}` });
      assert.match(await res.text(), /unsubscribed/i, body);
      assert.equal(h.store.isOptedOut(phone), true, body);
    }
    const keep = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15553000008',
      Body: 'please stop texting',
      MessageSid: 'SM_KEEP',
    });
    assert.doesNotMatch(await keep.text(), /unsubscribed/i);
    assert.equal(h.store.isOptedOut('+15553000008'), false);

    h.store.saveThread('+15553000020', {
      turns: policy.SMS_TURN_CAP,
      lowConfidence: 0,
      history: [],
      startedAt: '2026-10-25T12:00:00.000Z',
    });
    const before = h.sent.length;
    await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15553000020',
      Body: 'another question about starter',
      MessageSid: 'SM_CAP_A',
    });
    await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15553000020',
      Body: 'and one more question about starter',
      MessageSid: 'SM_CAP_B',
    });
    assert.equal(h.sent.length, before + 1);

    const threadsPath = path.join(h.store.directory, 'threads.json');
    const threads = JSON.parse(fs.readFileSync(threadsPath, 'utf8'));
    threads['+15553000021'] = {
      turns: policy.SMS_TURN_CAP,
      lowConfidence: 0,
      history: [],
      startedAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-23T12:00:00.000Z',
    };
    fs.writeFileSync(threadsPath, JSON.stringify(threads));
    assert.equal(h.store.getThread('+15553000021').turns, 0);
    const resumed = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15553000021',
      Body: 'How much is Starter?',
      MessageSid: 'SM_RESUME',
    });
    assert.match(await resumed.text(), /\$39/);
    assert.equal(h.sent.length, before + 1);

    const quiet = harness({ LLM_API_KEY: '' });
    await withServer(quiet.app, async ({ base: quietBase }) => {
      quiet.env.PUBLIC_BASE_URL = quietBase;
      const first = await postTwilio(quietBase, quiet.env, '/api/twilio/sms', {
        From: '+15553000030',
        Body: 'How much is Pro?',
        MessageSid: 'SM_NOKEY_1',
      });
      assert.match(await first.text(), /call you back/i);
      assert.equal(quiet.sent.length, 1);
      assert.match(quiet.sent[0].body, /\+15553000030/);
      const second = await postTwilio(quietBase, quiet.env, '/api/twilio/sms', {
        From: '+15553000030',
        Body: 'Are you there?',
        MessageSid: 'SM_NOKEY_2',
      });
      assert.match(await second.text(), /call you back/i);
      assert.equal(quiet.sent.length, 1);
    });
  });
});

test('consent is rate limited, append-only, and split from the other files', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    const headers = {
      'Content-Type': 'application/json',
      Origin: 'https://manualos.com',
      'X-Real-IP': '198.51.100.77',
      'X-Forwarded-For': '203.0.113.9, 198.51.100.10',
    };
    for (let i = 0; i < CONSENT_LIMIT; i += 1) {
      const res = await fetch(`${base}/api/support/sms-consent`, {
        method: 'POST',
        headers: {
          ...headers,
          'X-Real-IP': `203.0.113.${i}`,
          'X-Forwarded-For': `203.0.113.${i}, 198.51.100.10`,
        },
        body: JSON.stringify({ phone: `+1555400${String(i).padStart(4, '0')}`, consentTextVersion: 'v1', source: 'form' }),
      });
      assert.equal(res.status, 201, `consent ${i}`);
    }
    const blocked = await fetch(`${base}/api/support/sms-consent`, {
      method: 'POST',
      headers: {
        ...headers,
        'X-Real-IP': '198.51.100.99',
        'X-Forwarded-For': '198.51.100.99, 198.51.100.10',
      },
      body: JSON.stringify({ phone: '+15554009999', consentTextVersion: 'v1', source: 'form' }),
    });
    assert.equal(blocked.status, 429);
    assert.equal(h.store.listConsents().length, CONSENT_LIMIT);
    assert.equal(h.store.listConsents()[0].ip, '198.51.100.10');
    const other = await fetch(`${base}/api/support/sms-consent`, {
      method: 'POST',
      headers: {
        ...headers,
        'X-Real-IP': '203.0.113.50',
        'X-Forwarded-For': '203.0.113.50, 198.51.100.11',
      },
      body: JSON.stringify({ phone: '+15554008888', consentTextVersion: 'v1', source: 'form' }),
    });
    assert.equal(other.status, 201);
    assert.equal(h.store.listConsents().at(-1).ip, '198.51.100.11');
  });

  let clock = 0;
  const limiter = createConsentLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, now: () => clock });
  assert.equal(limiter('198.51.100.1'), false);
  assert.equal(limiter('198.51.100.1'), true);
  assert.equal(limiter('198.51.100.2'), false);
  assert.equal(limiter('198.51.100.3'), true);
  assert.equal(limiter('198.51.100.1'), true);
  clock = 1000;
  assert.equal(limiter('198.51.100.3'), false);

  const store = tempStore();
  store.addUsage('2026-10', { inputTokens: 3, outputTokens: 4, usd: 0.2 });
  const budgetPath = path.join(store.directory, 'budget.json');
  const budgetBefore = fs.readFileSync(budgetPath);
  store.optOut('+15551212001', 'sms');
  assert.equal(fs.readFileSync(budgetPath).toString(), budgetBefore.toString());
  assert.equal(fs.existsSync(path.join(store.directory, 'state.json')), false);
  const optBefore = fs.readFileSync(path.join(store.directory, 'opt-outs.json'));
  store.addConsent({
    phone: '+15551212001',
    consentTextVersion: 'v1',
    timestamp: '2026-10-25T12:00:00.000Z',
    ip: '198.51.100.10',
    source: 'website',
  });
  const consentPath = path.join(store.directory, 'consents.jsonl');
  const firstLine = fs.readFileSync(consentPath, 'utf8').split('\n')[0];
  for (let i = 0; i < 40; i += 1) {
    store.addConsent({
      phone: `+15557${String(i).padStart(6, '0')}`,
      consentTextVersion: 'v1',
      timestamp: '2026-10-25T12:00:00.000Z',
      ip: '',
      source: 'website',
    });
  }
  const lines = fs.readFileSync(consentPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 41);
  assert.equal(lines[0], firstLine);
  assert.equal(store.listConsents()[0].phone, '+15551212001');
  assert.equal(store.listConsents().length, 41);
  assert.equal(fs.readFileSync(path.join(store.directory, 'opt-outs.json')).toString(), optBefore.toString());
  assert.equal(fs.readFileSync(budgetPath).toString(), budgetBefore.toString());

  store.saveThread('+15550002222', {
    turns: 1,
    lowConfidence: 0,
    history: [{ role: 'user', content: spokenCard() }],
  });
  assert.equal(store.getThread('+15550002222').history[0].content, '[redacted]');
  assert.doesNotMatch(fs.readFileSync(path.join(store.directory, 'threads.json'), 'utf8'), /four|4111/i);

  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-support-test-'));
  dirs.push(legacyDir);
  fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({
    optOuts: { '+15551219999': { at: '2026-01-01T00:00:00.000Z', source: 'sms' } },
    consents: [{ phone: '+15551219999', consentTextVersion: 'legacy', timestamp: '2026-01-01T00:00:00.000Z', ip: '', source: 'website' }],
    budget: { '2026-10': { inputTokens: 1, outputTokens: 2, usd: 0.25 } },
    threads: { '+15551219999': { turns: 3, lowConfidence: 0, history: [], updatedAt: '2026-10-25T12:00:00.000Z' } },
    once: { sample: 1 },
  }));
  const migrated = createSupportStore({
    directory: legacyDir,
    env: { NODE_ENV: 'test' },
    now: () => Date.parse('2026-10-25T12:00:00.000Z'),
  });
  assert.equal(migrated.isOptedOut('+15551219999'), true);
  assert.equal(migrated.spentUsd('2026-10'), 0.25);
  assert.equal(migrated.listConsents()[0].consentTextVersion, 'legacy');
  assert.equal(migrated.getThread('+15551219999').turns, 3);
  assert.equal(fs.existsSync(path.join(legacyDir, 'state.json')), false);
  assert.equal(fs.existsSync(path.join(legacyDir, 'state.json.migrated')), true);
  assert.equal(fs.existsSync(path.join(legacyDir, 'consents.jsonl')), true);

  fs.writeFileSync(path.join(store.directory, 'opt-outs.json'), '{');
  assert.equal(store.isOptedOut('+15550000000'), true);
  fs.writeFileSync(path.join(store.directory, 'budget.json'), '{');
  assert.equal(store.spentUsd('2026-10'), Number.POSITIVE_INFINITY);
});

test('smtp mailer stays off until host and from are set', () => {
  assert.equal(createSmtpMailer({}), null);
  assert.equal(createSmtpMailer({ SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'smtp-secret' }), null);
  const mailer = createSmtpMailer({
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'alerts',
    SMTP_PASS: 'smtp-secret',
    SMTP_FROM: 'alerts@manualos.com',
  });
  assert.equal(typeof mailer.sendMail, 'function');
});

test('a failed escalation text calls and emails the owner once', async () => {
  const calls = [];
  const emails = [];
  const sent = [];
  const store = tempStore();
  const env = escalationEnv({ ESCALATION_EMAIL: 'ryan@manualos.com' });
  const app = escalationApp({
    env,
    store,
    calls,
    sent,
    mailer: {
      sendMail: async (message) => {
        emails.push(message);
      },
    },
    onMessage: async (params) => {
      sent.push(params);
      const err = new Error('toll-free unverified');
      err.status = 400;
      throw err;
    },
  });
  await withServer(app, async ({ base }) => {
    env.PUBLIC_BASE_URL = base;
    const sms = await postTwilio(base, env, '/api/twilio/sms', {
      From: '+15553000040',
      Body: 'I am furious',
      MessageSid: 'SM_FALLBACK',
    });
    assert.match(await sms.text(), /person will follow up/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '+15550001111');
    assert.equal(sent[0].from, '+15557654321');
    assert.match(sent[0].statusCallback, /\/api\/twilio\/sms\/status$/);
    assert.equal(sent[0].statusCallbackMethod, 'POST');
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 1);
    assert.equal(calls[0].to, '+15550001111');
    assert.equal(calls[0].from, '+15557654321');
    assert.match(calls[0].twiml, /<Say/);
    assert.match(calls[0].twiml, /Category complaint/);
    assert.match(calls[0].twiml, /\+ 1 5 5 5 3 0 0 0 0 4 0/);
    assert.match(calls[0].twiml, /furious/);
    assert.doesNotMatch(calls[0].twiml, /4111|https?:|sk-test|twilio-test-auth-token/);
    assert.equal(emails[0].to, 'ryan@manualos.com');
    assert.match(emails[0].subject, /complaint/);
    assert.match(emails[0].text, /Category: complaint/);
    assert.match(emails[0].text, /Caller: \+15553000040/);
    assert.match(emails[0].text, /furious/);
    assert.doesNotMatch(emails[0].text, /4111|sk-test|twilio-test-auth-token/);

    const again = await postTwilio(base, env, '/api/twilio/sms', {
      From: '+15553000040',
      Body: 'I am still furious',
      MessageSid: 'SM_FALLBACK_2',
    });
    assert.match(await again.text(), /person will follow up/);
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 1);

    const thread = store.getThread('+15553000040');
    store.saveSmsNotice('SM_LATE', {
      key: `sms:+15553000040:${thread.startedAt}:complaint`,
      interaction: `sms:+15553000040:${thread.startedAt}`,
      category: 'complaint',
      from: '+15553000040',
      line: 'complaint: card 4111111111111111',
      detail: 'ManualOS Support: card 4111111111111111',
    });
    const late = await postTwilio(base, env, '/api/twilio/sms/status', {
      MessageSid: 'SM_LATE',
      MessageStatus: 'failed',
      ErrorCode: '30032',
    });
    assert.equal(late.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 1);
    const saved = fs.readFileSync(path.join(store.directory, 'sms-notices.json'), 'utf8');
    assert.doesNotMatch(saved, /4111/);
    assert.match(saved, /\[redacted\]/);

    const dialing = await postTwilio(base, env, '/api/twilio/voice/handoff', {
      CallSid: 'CA_DIALING',
      From: '+15553000040',
      CallStatus: 'in-progress',
      HandoffData: JSON.stringify({
        handoff: true,
        reason: 'safety',
        summary: 'Caller needs help. Card 4111111111111111',
        from: '+15553000040',
      }),
    });
    assert.match(await dialing.text(), /<Dial /);
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 2);
    assert.match(emails[1].text, /Category: safety/);
    assert.match(emails[1].text, /Caller needs help/);
    assert.doesNotMatch(emails[1].text, /4111/);
  });
});

test('an undelivered escalation text falls back once from the status callback', async () => {
  const calls = [];
  const emails = [];
  const sent = [];
  let n = 0;
  const store = tempStore();
  const env = escalationEnv({ ESCALATION_EMAIL: 'ryan@manualos.com' });
  const app = escalationApp({
    env,
    store,
    calls,
    sent,
    mailer: {
      sendMail: async (message) => {
        emails.push(message);
      },
    },
    onMessage: async (params) => {
      sent.push(params);
      n += 1;
      return { sid: `SM_STATUS_${n}` };
    },
  });
  await withServer(app, async ({ base }) => {
    env.PUBLIC_BASE_URL = base;
    const sms = await postTwilio(base, env, '/api/twilio/sms', {
      From: '+15553000050',
      Body: 'I want to file a complaint about the manual',
      MessageSid: 'SM_IN_1',
    });
    assert.match(await sms.text(), /person will follow up/);
    assert.equal(calls.length, 0);
    assert.equal(emails.length, 0);
    assert.equal(sent[0].statusCallback, `${base}/api/twilio/sms/status`);

    const delivered = await postTwilio(base, env, '/api/twilio/sms/status', {
      MessageSid: 'SM_STATUS_1',
      MessageStatus: 'delivered',
    });
    assert.equal(delivered.status, 200);
    assert.equal(calls.length, 0);
    assert.equal(emails.length, 0);

    const failed = await postTwilio(base, env, '/api/twilio/sms/status', {
      MessageSid: 'SM_STATUS_1',
      MessageStatus: 'failed',
      ErrorCode: '30032',
    });
    assert.equal(failed.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 1);
    assert.equal(calls[0].to, '+15550001111');
    assert.equal(calls[0].from, '+15557654321');
    assert.match(calls[0].twiml, /Category complaint/);
    assert.match(calls[0].twiml, /\+ 1 5 5 5 3 0 0 0 0 5 0/);
    assert.match(calls[0].twiml, /complaint/);
    assert.doesNotMatch(calls[0].twiml, /https?:/);
    assert.match(emails[0].text, /Caller: \+15553000050/);
    assert.match(emails[0].subject, /complaint/);

    const again = await postTwilio(base, env, '/api/twilio/sms/status', {
      MessageSid: 'SM_STATUS_1',
      MessageStatus: 'undelivered',
      ErrorCode: '30034',
    });
    assert.equal(again.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 1);

    const unknown = await postTwilio(base, env, '/api/twilio/sms/status', {
      MessageSid: 'SM_UNKNOWN',
      MessageStatus: 'failed',
      ErrorCode: '30032',
    });
    assert.equal(unknown.status, 200);
    assert.equal(calls.length, 1);

    const other = await postTwilio(base, env, '/api/twilio/sms', {
      From: '+15553000051',
      Body: 'This charge is wrong',
      MessageSid: 'SM_IN_2',
    });
    assert.match(await other.text(), /cannot approve or issue a refund/i);
    assert.equal(calls.length, 1);
    const noCode = await postTwilio(base, env, '/api/twilio/sms/status', {
      MessageSid: 'SM_STATUS_2',
      MessageStatus: 'undelivered',
    });
    assert.equal(noCode.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(emails.length, 2);
    assert.match(calls[1].twiml, /Category billing/);
    assert.match(emails[1].text, /Caller: \+15553000051/);
  });
});

test('a failed voicemail text emails the recording link and speaks only the summary', async () => {
  const calls = [];
  const emails = [];
  const store = tempStore();
  const env = escalationEnv({ ESCALATION_EMAIL: 'ryan@manualos.com' });
  const app = escalationApp({
    env,
    store,
    calls,
    mailer: {
      sendMail: async (message) => {
        emails.push(message);
      },
    },
    onMessage: async () => {
      const err = new Error('toll-free unverified');
      err.status = 400;
      throw err;
    },
  });
  await withServer(app, async ({ base }) => {
    env.PUBLIC_BASE_URL = base;
    const transcript = await postTwilio(base, env, '/api/twilio/voice/transcription', {
      CallSid: 'CA_VM',
      From: '+15553000060',
      TranscriptionSid: 'TR_VM',
      TranscriptionStatus: 'completed',
      TranscriptionText: 'Please call me. My card is 4111111111111111.',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1',
    });
    assert.equal(transcript.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 1);
    assert.match(calls[0].twiml, /Category voicemail/);
    assert.match(calls[0].twiml, /\+ 1 5 5 5 3 0 0 0 0 6 0/);
    assert.match(calls[0].twiml, /Please call me/);
    assert.doesNotMatch(calls[0].twiml, /4111|https?:/);
    assert.match(emails[0].text, /Recordings\/RE1/);
    assert.match(emails[0].text, /Category: voicemail/);
    assert.doesNotMatch(emails[0].text, /4111/);
  });
});

test('missing SMTP skips the escalation email and still calls', async () => {
  const calls = [];
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  const store = tempStore();
  const env = escalationEnv({
    ESCALATION_EMAIL: 'ryan@manualos.com',
    SMTP_PASS: 'smtp-secret-should-not-log',
  });
  const app = escalationApp({
    env,
    store,
    calls,
    mailer: null,
    onMessage: async () => {
      const err = new Error('toll-free unverified');
      err.status = 400;
      throw err;
    },
  });
  try {
    await withServer(app, async ({ base }) => {
      env.PUBLIC_BASE_URL = base;
      const sms = await postTwilio(base, env, '/api/twilio/sms', {
        From: '+15553000070',
        Body: 'I am furious',
        MessageSid: 'SM_NO_SMTP',
      });
      assert.match(await sms.text(), /person will follow up/);
      assert.equal(calls.length, 1);
      assert.match(calls[0].twiml, /Category complaint/);
      assert.doesNotMatch(calls[0].twiml, /smtp-secret-should-not-log/);
      const thread = store.getThread('+15553000070');
      store.saveSmsNotice('SM_NO_SMTP_LATE', {
        key: `sms:+15553000070:${thread.startedAt}:complaint`,
        interaction: `sms:+15553000070:${thread.startedAt}`,
        category: 'complaint',
        from: '+15553000070',
        line: 'still furious',
      });
      const late = await postTwilio(base, env, '/api/twilio/sms/status', {
        MessageSid: 'SM_NO_SMTP_LATE',
        MessageStatus: 'undelivered',
        ErrorCode: '30034',
      });
      assert.equal(late.status, 200);
      assert.equal(calls.length, 1);

      env.ESCALATION_EMAIL = '';
      const noAddress = await postTwilio(base, env, '/api/twilio/sms', {
        From: '+15553000071',
        Body: 'I am furious',
        MessageSid: 'SM_NO_EMAIL',
      });
      assert.match(await noAddress.text(), /person will follow up/);
      assert.equal(calls.length, 2);
    });
  } finally {
    console.warn = original;
  }
  const logged = warnings.join('\n');
  assert.match(logged, /Escalation email skipped: SMTP is not configured/);
  assert.match(logged, /Escalation email skipped: ESCALATION_EMAIL is not set/);
  assert.equal(logged.split('SMTP is not configured').length - 1, 1);
  assert.doesNotMatch(logged, /smtp-secret-should-not-log/);
});

test('billing and complaint messages that mention a card still reach the owner', async () => {
  const pan = "I'm furious, you charged my card 4111 1111 1111 1111";
  const question = 'Was my credit card charged twice?';
  for (const channel of ['sms', 'voice']) {
    const plain = await policy.triageTurn({
      channel,
      text: question,
      state: state(),
      env: aiEnv(),
      spentUsd: 0,
      complete: async () => { throw new Error('should not call'); },
    });
    assert.equal(plain.reason, 'billing', channel);
    assert.equal(plain.escalate, true, channel);
    assert.equal(plain.handoff, true, channel);
    const digits = await policy.triageTurn({
      channel,
      text: pan,
      state: state(),
      env: aiEnv(),
      spentUsd: 0,
      complete: async () => { throw new Error('should not call'); },
    });
    assert.equal(digits.escalate, true, channel);
    assert.equal(digits.handoff, true, channel);
    assert.match(digits.reply, /cannot take card numbers/i, channel);
    assert.doesNotMatch(`${digits.reply} ${digits.summary}`, /4111/, channel);
  }

  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const first = await postTwilio(base, h.env, '/api/twilio/voice', {
      CallSid: 'CA_CARD_WORDS',
      From: '+15551117001',
      To: '+15557654321',
    });
    const relay = relayUrlFrom(await first.text());
    const client = await openRelay(relay, twilio.getExpectedTwilioSignature(TOKEN, relay, {}));
    try {
      client.send({ type: 'setup', callSid: 'CA_CARD_WORDS', from: '+15551117001' });
      client.send({ type: 'prompt', voicePrompt: question, lang: 'en-US', last: true });
      const spoken = await client.next();
      const ended = await client.next();
      assert.equal(ended.type, 'end');
      assert.equal(JSON.parse(ended.handoffData).reason, 'billing');
      assert.match(spoken.token, /Connecting you now/);
      const handoff = await postTwilio(base, h.env, '/api/twilio/voice/handoff', {
        CallSid: 'CA_CARD_WORDS',
        From: '+15551117001',
        CallStatus: 'in-progress',
        HandoffData: ended.handoffData,
      });
      assert.match(await handoff.text(), /<Dial /);
      assert.equal(h.sent.length, 1);
      assert.match(h.sent[0].body, /billing|charged/i);
    } finally {
      client.ws.close();
    }

    const second = await postTwilio(base, h.env, '/api/twilio/voice', {
      CallSid: 'CA_CARD_DIGITS',
      From: '+15551117002',
      To: '+15557654321',
    });
    const relay2 = relayUrlFrom(await second.text());
    const client2 = await openRelay(relay2, twilio.getExpectedTwilioSignature(TOKEN, relay2, {}));
    try {
      client2.send({ type: 'setup', callSid: 'CA_CARD_DIGITS', from: '+15551117002' });
      client2.send({ type: 'prompt', voicePrompt: pan, lang: 'en-US', last: true });
      const spoken = await client2.next();
      const ended = await client2.next();
      assert.match(spoken.token, /cannot take card numbers/i);
      assert.doesNotMatch(spoken.token, /4111/);
      const data = JSON.parse(ended.handoffData);
      assert.equal(data.handoff, true);
      assert.doesNotMatch(data.summary, /4111/);
      const handoff = await postTwilio(base, h.env, '/api/twilio/voice/handoff', {
        CallSid: 'CA_CARD_DIGITS',
        From: '+15551117002',
        CallStatus: 'in-progress',
        HandoffData: ended.handoffData,
      });
      assert.match(await handoff.text(), /<Dial /);
      assert.equal(h.sent.length, 2);
      assert.doesNotMatch(h.sent[1].body, /4111/);
      assert.match(h.sent[1].body, /furious|charged|billing/i);
    } finally {
      client2.ws.close();
    }
  });

  const texts = harness();
  await withServer(texts.app, async ({ base }) => {
    texts.env.PUBLIC_BASE_URL = base;
    const plain = await postTwilio(base, texts.env, '/api/twilio/sms', {
      From: '+15551117003',
      Body: question,
      MessageSid: 'SM_CARD_WORDS',
    });
    assert.match(await plain.text(), /follow up|cannot approve or issue a refund/i);
    assert.equal(texts.sent.length, 1);
    const furious = await postTwilio(base, texts.env, '/api/twilio/sms', {
      From: '+15551117004',
      Body: pan,
      MessageSid: 'SM_CARD_DIGITS',
    });
    const xml = await furious.text();
    assert.match(xml, /cannot take card numbers/i);
    assert.doesNotMatch(xml, /4111/);
    assert.equal(texts.sent.length, 2);
    assert.doesNotMatch(texts.sent[1].body, /4111/);
    assert.match(texts.sent[1].body, /furious|charged|billing/i);
  });
});

test('one call gets one fallback call and one fallback email', async () => {
  const calls = [];
  const emails = [];
  const store = tempStore();
  const env = escalationEnv({ ESCALATION_EMAIL: 'ryan@manualos.com' });
  const app = escalationApp({
    env,
    store,
    calls,
    mailer: { sendMail: async (message) => { emails.push(message); } },
    onMessage: async () => {
      const err = new Error('toll-free unverified');
      err.status = 400;
      throw err;
    },
  });
  await withServer(app, async ({ base }) => {
    env.PUBLIC_BASE_URL = base;
    const handoff = await postTwilio(base, env, '/api/twilio/voice/handoff', {
      CallSid: 'CA_ONE_CALL',
      From: '+15553000080',
      CallStatus: 'in-progress',
      HandoffData: JSON.stringify({ handoff: true, reason: 'safety', summary: 'Caller needs help', from: '+15553000080' }),
    });
    assert.match(await handoff.text(), /<Dial /);
    assert.equal(calls.length, 0);
    assert.equal(emails.length, 1);

    const busy = await postTwilio(base, env, '/api/twilio/voice/dial-status', {
      CallSid: 'CA_ONE_CALL',
      From: '+15553000080',
      DialCallStatus: 'busy',
    });
    assert.match(await busy.text(), /<Record /);
    assert.equal(calls.length, 0);
    assert.equal(emails.length, 1);

    const transcript = await postTwilio(base, env, '/api/twilio/voice/transcription', {
      CallSid: 'CA_ONE_CALL',
      From: '+15553000080',
      TranscriptionSid: 'TR_ONE',
      TranscriptionStatus: 'completed',
      TranscriptionText: 'Please call me back.',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1',
    });
    assert.equal(transcript.status, 200);
    const recording = await postTwilio(base, env, '/api/twilio/voice/recording', {
      CallSid: 'CA_ONE_CALL',
      From: '+15553000080',
      RecordingSid: 'RE_ONE',
      RecordingStatus: 'completed',
      RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1',
    });
    assert.equal(recording.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 1);
    assert.match(calls[0].twiml, /Category voicemail/);
    assert.doesNotMatch(calls[0].twiml, /https?:/);
  });
});

test('an escalation text with no message id falls back', async () => {
  const calls = [];
  const emails = [];
  const store = tempStore();
  const env = escalationEnv({ ESCALATION_EMAIL: 'ryan@manualos.com' });
  const app = escalationApp({
    env,
    store,
    calls,
    mailer: { sendMail: async (message) => { emails.push(message); } },
    onMessage: async () => ({}),
  });
  await withServer(app, async ({ base }) => {
    env.PUBLIC_BASE_URL = base;
    const sms = await postTwilio(base, env, '/api/twilio/sms', {
      From: '+15553000090',
      Body: 'I am furious',
      MessageSid: 'SM_NO_SID',
    });
    assert.match(await sms.text(), /person will follow up/);
    assert.equal(calls.length, 1);
    assert.equal(emails.length, 1);
    assert.match(calls[0].twiml, /Category complaint/);
    assert.equal(emails[0].to, 'ryan@manualos.com');
  });
});

test('free-text opt-out does not escalate and YES opts back in', async () => {
  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const before = h.sent.length;
    const opt = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15553000100',
      Body: 'please unsubscribe me',
      MessageSid: 'SM_UNSUB',
    });
    assert.match(await opt.text(), /unsubscribed/i);
    assert.equal(h.store.isOptedOut('+15553000100'), true);
    assert.equal(h.sent.length, before);
    const yes = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15553000100',
      Body: 'YES',
      MessageSid: 'SM_YES',
    });
    assert.match(await yes.text(), /Msg frequency varies/);
    assert.equal(h.store.isOptedOut('+15553000100'), false);
    assert.equal(h.sent.length, before);
  });
});

test('a toll-free STOP reply failure is logged and does not page', async () => {
  const calls = [];
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const store = tempStore();
  const env = escalationEnv({ ESCALATION_EMAIL: 'ryan@manualos.com' });
  const app = escalationApp({
    env,
    store,
    calls,
    mailer: { sendMail: async () => { throw new Error('mail should not be called'); } },
    onMessage: async () => {
      const err = new Error('toll-free unverified');
      err.status = 400;
      throw err;
    },
  });
  try {
    await withServer(app, async ({ base }) => {
      env.PUBLIC_BASE_URL = base;
      const stop = await postTwilio(base, env, '/api/twilio/sms', {
        From: '+15553000110',
        Body: 'STOP',
        MessageSid: 'SM_STOP_TOLL',
      });
      assert.equal(stop.status, 200);
      assert.match(await stop.text(), /unsubscribed/i);
      assert.equal(store.isOptedOut('+15553000110'), true);
      assert.equal(calls.length, 0);
      const status = await postTwilio(base, env, '/api/twilio/sms/status', {
        MessageSid: 'SM_STOP_TOLL',
        MessageStatus: 'undelivered',
        ErrorCode: '30034',
      });
      assert.equal(status.status, 200);
      assert.equal(calls.length, 0);
    });
  } finally {
    console.error = original;
  }
  const logged = errors.join('\n');
  assert.match(logged, /Twilio message was not delivered/);
  assert.doesNotMatch(logged, /twilio-test-auth-token|sk-test/);
});

test('card windows, opt-out billing, refund promises, and vendor names', async () => {
  assert.equal(policy.redactCardNumbers('4111 1111 1111 1111 123'), '[redacted] 123');
  assert.doesNotMatch(policy.redactCardNumbers('4111 1111 1111 1111 123'), /4111/);
  assert.equal(policy.redactCardNumbers('4111 1111 1111 1111 04 29 cvv 123'), '[redacted] [redacted]');
  assert.equal(policy.containsCardNumber('4111 1111 1111 1111 123'), true);
  assert.equal(policy.containsCardNumber('credit card'), false);
  assert.equal(policy.containsCardNumber('card number'), false);
  assert.equal(policy.classify('Was my credit card charged twice?'), 'billing');
  const buried = await policy.triageTurn({
    channel: 'sms',
    text: 'I was charged 4111 1111 1111 1111 04 29 cvv 123',
    state: state(),
    env: aiEnv(),
    spentUsd: 0,
    complete: async () => { throw new Error('should not call'); },
  });
  assert.equal(buried.reason, 'billing');
  assert.equal(buried.escalate, true);
  assert.doesNotMatch(`${buried.reply} ${buried.summary}`, /4111|cvv\s*123|04\s*29/);
  const saved = { turns: 0, lowConfidence: 0, history: [] };
  await policy.triageTurn({
    channel: 'sms',
    text: '4111 1111 1111 1111 123',
    state: saved,
    env: aiEnv(),
    spentUsd: 0,
    complete: async () => { throw new Error('should not call'); },
  });
  assert.doesNotMatch(JSON.stringify(saved), /4111/);

  assert.equal(isOptOutMessage('How do I unsubscribe from Pro?'), false);
  assert.equal(policy.classify('How do I unsubscribe from Pro?'), 'billing');
  assert.equal(isOptOutMessage('remove me from the Pro subscription'), false);
  assert.equal(policy.classify('remove me from the Pro subscription'), 'billing');
  assert.equal(isOptOutMessage('opt me out'), true);
  assert.equal(isOptOutMessage('please unsubscribe me'), true);
  assert.equal(isOptOutMessage('unsubscribe'), true);

  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const before = h.sent.length;
    const pro = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551118001',
      Body: 'How do I unsubscribe from Pro?',
      MessageSid: 'SM_UNSUB_PRO',
    });
    assert.doesNotMatch(await pro.text(), /unsubscribed/i);
    assert.equal(h.store.isOptedOut('+15551118001'), false);
    assert.equal(h.sent.length, before + 1);
    const removed = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551118002',
      Body: 'remove me from the Pro subscription',
      MessageSid: 'SM_REMOVE_PRO',
    });
    assert.doesNotMatch(await removed.text(), /unsubscribed/i);
    assert.equal(h.store.isOptedOut('+15551118002'), false);
    assert.equal(h.sent.length, before + 2);
    const opt = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551118003',
      Body: 'opt me out',
      MessageSid: 'SM_OPT_ME',
    });
    assert.match(await opt.text(), /unsubscribed/i);
    assert.equal(h.store.isOptedOut('+15551118003'), true);
    assert.equal(h.sent.length, before + 2);
  });

  for (const phrase of [
    'Go to step 7',
    'fusion welding',
    'The inventor of this machine',
    'Google it',
    'Hi, this is Claude Schneider',
    'Inventory stays on the shelf',
  ]) {
    assert.equal(policy.applyGuardrails(phrase, aiEnv()), phrase, phrase);
  }
  for (const phrase of [
    'Siemens Step 7',
    'STEP 7',
    'Fusion 360',
    'Autodesk Inventor',
    'Inventor file',
    'NX file',
    'TwinCAT3',
    'TwinCAT 3',
    'Allen Bradley',
    'Allen-Bradley',
    'Solid Edge',
    'Siemens NX',
    'Rockwell',
    'Mitsubishi',
    'Omron',
    'Schneider Electric',
    'Codesys',
  ]) {
    const cleaned = policy.applyGuardrails(phrase, aiEnv());
    assert.notEqual(cleaned, phrase, phrase);
    assert.doesNotMatch(cleaned, /step\s*7|fusion|inventor|nx|twincat|allen|bradley|solid\s*edge|siemens|rockwell|mitsubishi|omron|schneider|codesys/i, phrase);
  }
});

test('after-hours billing calls and complaint texts escalate', async () => {
  const afterHours = () => Date.parse('2026-10-25T07:30:00.000Z');
  assert.equal(policy.isAfterHours(afterHours()), true);
  assert.equal(policy.isAfterHours(Date.parse('2026-10-25T17:00:00.000Z')), false);
  assert.equal(policy.escalatesAtThisHour('billing', afterHours()), true);
  assert.equal(policy.escalatesAtThisHour('complaint', afterHours()), true);

  const missed = await policy.triageTurn({
    channel: 'sms',
    text: 'the balance on my account looks off',
    state: state(),
    env: aiEnv(),
    spentUsd: 0,
    now: afterHours,
    complete: async () => answer('I can check that.', {
      handoff: false,
      reason: 'billing',
      summary: 'Account balance looks wrong.',
    }),
  });
  assert.equal(missed.reason, 'billing');
  assert.equal(missed.escalate, true);
  assert.equal(missed.handoff, true);
  assert.match(missed.reply, /cannot approve or issue a refund/i);

  const h = harness({ supportNow: afterHours });
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    const voice = await postTwilio(base, h.env, '/api/twilio/voice', {
      CallSid: 'CA_BILL_NIGHT',
      From: '+15551118000',
      To: '+15557654321',
    });
    const relay = relayUrlFrom(await voice.text());
    const client = await openRelay(relay, twilio.getExpectedTwilioSignature(TOKEN, relay, {}));
    try {
      client.send({ type: 'setup', callSid: 'CA_BILL_NIGHT', from: '+15551118000' });
      client.send({ type: 'prompt', voicePrompt: 'I was charged $39 and I need an invoice', lang: 'en-US', last: true });
      const spoken = await client.next();
      const ended = await client.next();
      assert.equal(spoken.type, 'text');
      assert.match(spoken.token, /Connecting you now/);
      assert.match(spoken.token, /cannot approve or issue a refund/i);
      assert.equal(ended.type, 'end');
      const data = JSON.parse(ended.handoffData);
      assert.equal(data.handoff, true);
      assert.equal(data.reason, 'billing');
      assert.equal(h.completions.length, 0);

      const handoff = await postTwilio(base, h.env, '/api/twilio/voice/handoff', {
        CallSid: 'CA_BILL_NIGHT',
        From: '+15551118000',
        CallStatus: 'in-progress',
        HandoffData: JSON.stringify(data),
      });
      const xml = await handoff.text();
      assert.match(xml, /<Dial timeout="25" action="\/api\/twilio\/voice\/dial-status">\+15550001111<\/Dial>/);
      assert.equal(h.sent.length, 1);
      assert.equal(h.sent[0].to, '+15550001111');
      assert.match(h.sent[0].body, /charged \$39|billing/i);
    } finally {
      client.ws.close();
    }
  });

  const texts = harness({ supportNow: afterHours });
  await withServer(texts.app, async ({ base }) => {
    texts.env.PUBLIC_BASE_URL = base;
    const first = await postTwilio(base, texts.env, '/api/twilio/sms', {
      From: '+15551118001',
      Body: 'I want to file a complaint about the manual',
      MessageSid: 'SM_COMPLAINT_1',
    });
    const firstXml = await first.text();
    assert.match(firstXml, /person will follow up/);
    assert.equal(texts.completions.length, 0);
    assert.equal(texts.sent.length, 1);
    assert.equal(texts.sent[0].to, '+15550001111');
    assert.match(texts.sent[0].body, /complaint/i);
    const second = await postTwilio(base, texts.env, '/api/twilio/sms', {
      From: '+15551118001',
      Body: 'This complaint is still unresolved',
      MessageSid: 'SM_COMPLAINT_2',
    });
    assert.match(await second.text(), /person will follow up/);
    assert.equal(texts.sent.length, 1);
    assert.equal(texts.completions.length, 0);
  });
});

test('round 4 promise bypasses, card separators, opt-out billing, and vendor leaks', async () => {
  const env = aiEnv();
  const blocked = [
    "I can't promise anything, but I'll refund you today.",
    "I'll refund you and a person will follow up.",
    "We're going to refund you",
    "I'll process the refund now",
    'Refund approved!',
    "I'll reimburse you.",
  ];
  for (const phrase of blocked) {
    assert.equal(policy.promisesRefund(phrase), true, phrase);
    const cleaned = policy.applyGuardrails(phrase, env);
    assert.match(cleaned, /cannot approve or issue a refund/i, phrase);
    assert.doesNotMatch(cleaned, /I'll refund|going to refund|process the refund|Refund approved|reimburse/i, phrase);
  }
  for (const phrase of [
    'Only the team can issue a refund',
    'The team decides whether to issue a refund',
    'To get a refund, email support…',
  ]) {
    assert.equal(policy.promisesRefund(phrase), false, phrase);
    assert.equal(policy.applyGuardrails(phrase, env), phrase, phrase);
  }

  const groups = ['4111', '1111', '1111', '1111'];
  for (const sep of ['_', '*', ':', '|', '\u2013', '\u2014']) {
    const raw = groups.join(sep);
    assert.equal(policy.containsCardNumber(raw), true, JSON.stringify(raw));
    assert.equal(policy.redactCardNumbers(`pay ${raw} now`), 'pay [redacted] now', JSON.stringify(raw));
    assert.doesNotMatch(policy.redactCardNumbers(raw), /4111/);
  }
  for (const sep of [' \u2013 ', ' \u2014 ', ' _ ', ' * ', ' : ', ' | ']) {
    const raw = groups.join(sep);
    assert.equal(policy.containsCardNumber(raw), true, JSON.stringify(raw));
    assert.equal(policy.redactCardNumbers(raw), '[redacted]', JSON.stringify(raw));
  }
  assert.equal(policy.redactCardNumbers('cvv two three four'), '[redacted]');
  assert.equal(policy.redactCardNumbers('the cvv two three four is here'), 'the [redacted] is here');
  assert.equal(policy.containsCardNumber('cvv two three four'), false);
  assert.equal(policy.containsCardNumber('credit card'), false);
  for (const phrase of ['order 4111-1111-1111-1111', 'ref: 4111_1111_1111_1111', 'Order #4111111111111111']) {
    assert.equal(policy.containsCardNumber(phrase), false, phrase);
    let seen = '';
    const decision = await policy.triageTurn({
      channel: 'sms',
      text: phrase,
      state: state(),
      env,
      spentUsd: 0,
      complete: async (request) => {
        if (request.maxTokens === 200) seen = JSON.stringify(request.messages);
        return answer('Email support@manualos.com and the team can look up that order.');
      },
    });
    assert.doesNotMatch(decision.reply, /cannot take card numbers/, phrase);
    assert.doesNotMatch(seen, /4111/, phrase);
    assert.match(seen, /\[redacted\]/, phrase);
  }

  const seeded = state();
  seeded.history = [
    { role: 'user', content: '4111\u20131111\u20131111\u20131111' },
    { role: 'assistant', content: '4111*1111*1111*1111' },
  ];
  let seededPayload = '';
  await policy.triageTurn({
    channel: 'sms',
    text: 'How much is Pro? cvv two three four',
    state: seeded,
    env,
    spentUsd: 0,
    complete: async (request) => {
      if (request.maxTokens === 200) seededPayload = JSON.stringify(request.messages);
      return answer('Pro is $79 per month.');
    },
  });
  assert.doesNotMatch(seededPayload, /4111|two three four/);
  assert.match(seededPayload, /\[redacted\]/);
  const cardStore = tempStore();
  cardStore.saveThread('+15551119100', {
    turns: 1,
    history: [{ role: 'user', content: '4111|1111|1111|1111 cvv two three four' }],
  });
  assert.doesNotMatch(fs.readFileSync(path.join(cardStore.directory, 'threads.json'), 'utf8'), /4111|two three four/);

  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    h.setComplete(async () => answer('Noted 4111_1111_1111_1111 and cvv two three four already.'));
    const opener = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119110',
      Body: 'How much is Starter?',
      MessageSid: 'SM_CARD_OPEN',
    });
    const openerXml = await opener.text();
    assert.match(openerXml, /\[redacted\]/);
    assert.doesNotMatch(openerXml, /4111|two three four/);
    const threadsPath = path.join(h.store.directory, 'threads.json');
    assert.doesNotMatch(fs.readFileSync(threadsPath, 'utf8'), /4111|two three four/);
    assert.match(fs.readFileSync(threadsPath, 'utf8'), /\[redacted\]/);

    let payload = '';
    h.setComplete(async (request) => {
      if (request.maxTokens === 200) payload = JSON.stringify(request.messages);
      return answer('Pro is $79 per month.');
    });
    const follow = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119110',
      Body: 'And Pro? cvv two three four',
      MessageSid: 'SM_CARD_FOLLOW',
    });
    assert.match(await follow.text(), /\$79/);
    assert.doesNotMatch(payload, /4111|two three four/);
    assert.match(payload, /\[redacted\]/);
    assert.doesNotMatch(fs.readFileSync(threadsPath, 'utf8'), /4111|two three four/);

    const before = h.completions.length;
    for (const [sid, body] of [
      ['SM_CARD_US', '4111_1111_1111_1111'],
      ['SM_CARD_STAR', '4111*1111*1111*1111'],
      ['SM_CARD_COLON', '4111:1111:1111:1111'],
      ['SM_CARD_PIPE', '4111|1111|1111|1111'],
      ['SM_CARD_EN', '4111\u20131111\u20131111\u20131111'],
      ['SM_CARD_EM', '4111\u20141111\u20141111\u20141111'],
    ]) {
      const refused = await postTwilio(base, h.env, '/api/twilio/sms', {
        From: '+15551119111',
        Body: body,
        MessageSid: sid,
      });
      assert.match(await refused.text(), /cannot take card numbers/, body);
    }
    assert.equal(h.completions.length, before);
    assert.doesNotMatch(fs.readFileSync(threadsPath, 'utf8'), /4111/);

    const order = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119112',
      Body: 'order 4111-1111-1111-1111',
      MessageSid: 'SM_ORDER_ID',
    });
    assert.doesNotMatch(await order.text(), /cannot take card numbers/);
    const orderCall = h.completions.filter((request) => request.maxTokens === 200).at(-1);
    assert.doesNotMatch(JSON.stringify(orderCall.messages), /4111/);
    assert.match(JSON.stringify(orderCall.messages), /order \[redacted\]/);
    assert.doesNotMatch(fs.readFileSync(threadsPath, 'utf8'), /4111/);
  });

  const bills = harness();
  await withServer(bills.app, async ({ base }) => {
    bills.env.PUBLIC_BASE_URL = base;
    const samples = [
      ['+15551119201', 'Unsubscribe. Also I was charged twice.', /charged twice/],
      ['+15551119202', 'remove me, I was charged twice', /charged twice/],
      ['+15551119203', 'Stop, I want a refund', /refund/],
      ['+15551119204', 'STOP charging my card', /charg/],
    ];
    for (const [phone, body, pattern] of samples) {
      assert.equal(isOptOutMessage(body), true, body);
      assert.equal(policy.classify(body), 'billing', body);
      const res = await postTwilio(base, bills.env, '/api/twilio/sms', {
        From: phone,
        Body: body,
        MessageSid: `SM_${phone}`,
      });
      assert.match(await res.text(), /unsubscribed/i, body);
      assert.equal(bills.store.isOptedOut(phone), true, body);
    }
    assert.equal(bills.sent.length, samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      assert.equal(bills.sent[i].to, '+15550001111', samples[i][1]);
      assert.match(bills.sent[i].body, /billing/i, samples[i][1]);
      assert.match(bills.sent[i].body, samples[i][2], samples[i][1]);
    }
    const pro = await postTwilio(base, bills.env, '/api/twilio/sms', {
      From: '+15551119205',
      Body: 'How do I unsubscribe from Pro?',
      MessageSid: 'SM_PRO_Q',
    });
    assert.doesNotMatch(await pro.text(), /unsubscribed/i);
    assert.equal(bills.store.isOptedOut('+15551119205'), false);
    assert.equal(bills.sent.length, samples.length + 1);
    const removed = await postTwilio(base, bills.env, '/api/twilio/sms', {
      From: '+15551119206',
      Body: 'remove me from the Pro subscription',
      MessageSid: 'SM_PRO_REMOVE',
    });
    assert.doesNotMatch(await removed.text(), /unsubscribed/i);
    assert.equal(bills.store.isOptedOut('+15551119206'), false);
  });

  for (const phrase of [
    'Step 7: tighten the bolts',
    'Fusion splicing',
    'Rockwell hardness test',
    'Go to step 7',
    'fusion welding',
    'The inventor of this machine',
    'Google it',
    'Hi, this is Claude Schneider',
    'Inventory stays on the shelf',
  ]) {
    assert.equal(policy.applyGuardrails(phrase, env), phrase, phrase);
  }
  const scrubbed = [
    ['I\'m Claude', /claude/i],
    ['I am Claude', /claude/i],
    ['I was made by Anthropic', /anthropic/i],
    ['This model was built by OpenAI', /openai/i],
    ['I was trained by Google', /google/i],
    ['GOOGLE', /google/i],
    ['google', /google/i],
    ['gpt4', /gpt/i],
    ['Allen\u2013Bradley', /allen|bradley/i],
    ['inventor files', /inventor/i],
    ['Schneider Electric', /schneider/i],
    ['Modicon', /modicon/i],
    ['EcoStruxure', /ecostruxure/i],
  ];
  for (const [phrase, pattern] of scrubbed) {
    const cleaned = policy.applyGuardrails(phrase, env);
    assert.notEqual(cleaned, phrase, phrase);
    assert.doesNotMatch(cleaned, pattern, phrase);
  }
});

test('round 5 redaction, refund allowlist, opt-out, billing, and vendor context', async () => {
  const env = aiEnv();
  const prompt = policy.systemPrompt({}, 'sms');
  assert.match(prompt, /You are the ManualOS support assistant/);
  assert.match(prompt, /Never say you are a named AI model, and never name an AI company/);

  const labeled = [
    'ref 4111 1111 1111 1111',
    'order 4111111111111111',
    'ref 3782 822463 10005 exp 04/29',
  ];
  for (const phrase of labeled) {
    assert.equal(policy.containsCardNumber(phrase), false, phrase);
    const redacted = policy.redactCardNumbers(phrase);
    assert.doesNotMatch(redacted, /4111|3782|822463|10005|04\/29/, phrase);
    assert.match(redacted, /\[redacted\]/, phrase);
    const session = state();
    let seen = '';
    const decision = await policy.triageTurn({
      channel: 'sms',
      text: phrase,
      state: session,
      env,
      spentUsd: 0,
      complete: async (request) => {
        if (request.maxTokens === 200) seen = JSON.stringify(request.messages);
        return answer('Email support@manualos.com and the team can look up that order.');
      },
    });
    assert.doesNotMatch(decision.reply, /cannot take card numbers/, phrase);
    assert.doesNotMatch(seen, /4111|3782|822463|10005|04\/29/, phrase);
    assert.match(seen, /\[redacted\]/, phrase);
    assert.doesNotMatch(JSON.stringify(session.history), /4111|3782|822463|10005|04\/29/, phrase);
  }
  assert.equal(policy.containsCardNumber('4111 x 1111 x 1111 x 1111'), true);
  assert.equal(policy.redactCardNumbers('4111 x 1111 x 1111 x 1111'), '[redacted]');
  assert.equal(policy.redactCardNumbers('4111x1111x1111x1111'), '[redacted]');
  assert.equal(policy.redactCardNumbers('4111ab1111ab1111ab1111'), '[redacted]');

  const cardStore = tempStore();
  cardStore.saveThread('+15551119300', {
    turns: 1,
    history: [
      { role: 'user', content: 'ref 4111 1111 1111 1111' },
      { role: 'assistant', content: 'order 4111111111111111 and ref 3782 822463 10005 exp 04/29' },
    ],
  });
  const storedCards = fs.readFileSync(path.join(cardStore.directory, 'threads.json'), 'utf8');
  assert.doesNotMatch(storedCards, /4111|3782|822463|10005|04\/29/);
  assert.match(storedCards, /\[redacted\]/);

  const blocked = [
    "I'm happy to issue a refund now",
    "Our team is sorry. I'll refund you now",
    "Don't worry. We'll refund you",
    'Never fear — we will refund you',
    "I've refunded your purchase",
    'We are refunding your order',
    'Not only will I refund you',
    'You will get your credit back',
  ];
  for (const phrase of blocked) {
    assert.equal(policy.promisesRefund(phrase), true, phrase);
    const cleaned = policy.applyGuardrails(phrase, env);
    assert.match(cleaned, /cannot approve or issue a refund/i, phrase);
    assert.doesNotMatch(cleaned, /happy to issue|I'll refund|We'll refund|we will refund|refunded your|refunding your|will I refund|credit back/i, phrase);
  }
  const policyText = 'A purchase can be refunded only if no manual from it has been delivered: Starter within 30 days of purchase; Pro charges before that billing period ends. I cannot approve or issue a refund. The team will follow up at support@manualos.com.';
  for (const phrase of [
    'Only the team can issue a refund',
    'The team decides whether to issue a refund',
    'To request a refund, email support…',
    'To get a refund, email support…',
    policyText,
  ]) {
    assert.equal(policy.promisesRefund(phrase), false, phrase);
    assert.equal(policy.applyGuardrails(phrase, {}), phrase, phrase);
  }

  for (const phrase of [
    "don't text me",
    'stop texting me',
    'no more texts',
    'take me off this list',
    'remove me',
    "don't text me, I cancelled my account",
    'STOP',
    'STOPALL',
    'UNSUBSCRIBE',
    'CANCEL',
    'END',
    'QUIT',
    'OPTOUT',
    'REVOKE',
  ]) {
    assert.equal(isOptOutMessage(phrase), true, phrase);
  }
  assert.equal(isOptOutMessage('please stop texting'), false);
  assert.equal(isOptOutMessage('How do I unsubscribe from Pro?'), false);
  assert.equal(isOptOutMessage('remove me from the Pro subscription'), false);
  assert.equal(policy.classify('you billed me again'), 'billing');
  assert.equal(policy.classify('send me the bill'), 'billing');
  assert.equal(policy.classify('I want my money back'), 'billing');
  assert.equal(policy.classify('I cancelled my account'), 'billing');
  assert.equal(policy.classify('I canceled the plan'), 'billing');
  assert.equal(policy.classify('I was overcharged'), 'billing');
  assert.equal(policy.classify('I want to dispute this charge'), 'billing');

  const bills = harness();
  await withServer(bills.app, async ({ base }) => {
    bills.env.PUBLIC_BASE_URL = base;
    const samples = [
      ['+15551119301', 'unsubscribe, you billed me again', /billed/],
      ['+15551119302', 'please stop texting me, and I want my money back', /money back/],
      ['+15551119303', "don't text me, I cancelled my account", /cancelled/],
    ];
    for (const [phone, body] of samples) {
      const res = await postTwilio(base, bills.env, '/api/twilio/sms', {
        From: phone,
        Body: body,
        MessageSid: `SM_${phone}`,
      });
      assert.match(await res.text(), /unsubscribed/i, body);
      assert.equal(bills.store.isOptedOut(phone), true, body);
    }
    assert.equal(bills.sent.length, samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      assert.equal(bills.sent[i].to, '+15550001111', samples[i][1]);
      assert.match(bills.sent[i].body, /billing/i, samples[i][1]);
      assert.match(bills.sent[i].body, samples[i][2], samples[i][1]);
    }
    const again = await postTwilio(base, bills.env, '/api/twilio/sms', {
      From: '+15551119302',
      Body: 'please stop texting me, and I want my money back',
      MessageSid: 'SM_MONEY_AGAIN',
    });
    assert.match(await again.text(), /unsubscribed/i);
    assert.equal(bills.sent.length, samples.length);

    const plain = await postTwilio(base, bills.env, '/api/twilio/sms', {
      From: '+15551119304',
      Body: 'no more texts',
      MessageSid: 'SM_NO_MORE',
    });
    assert.match(await plain.text(), /unsubscribed/i);
    assert.equal(bills.store.isOptedOut('+15551119304'), true);
    assert.equal(bills.sent.length, samples.length);
    assert.equal(bills.completions.length, 0);
  });

  const h = harness();
  await withServer(h.app, async ({ base }) => {
    h.env.PUBLIC_BASE_URL = base;
    let payload = '';
    h.setComplete(async (request) => {
      if (request.maxTokens === 200) payload = JSON.stringify(request.messages);
      return answer('Email support@manualos.com and the team can look that up.');
    });
    const order = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119310',
      Body: 'order 4111111111111111',
      MessageSid: 'SM_ORDER_PAN',
    });
    assert.doesNotMatch(await order.text(), /cannot take card numbers/);
    assert.doesNotMatch(payload, /4111/);
    assert.match(payload, /\[redacted\]/);
    const threads = fs.readFileSync(path.join(h.store.directory, 'threads.json'), 'utf8');
    assert.doesNotMatch(threads, /4111/);
    const amex = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119311',
      Body: 'ref 3782 822463 10005 exp 04/29',
      MessageSid: 'SM_REF_AMEX',
    });
    assert.doesNotMatch(await amex.text(), /cannot take card numbers|3782|04\/29/);
    assert.doesNotMatch(payload, /3782|822463|10005|04\/29/);
    assert.doesNotMatch(fs.readFileSync(path.join(h.store.directory, 'threads.json'), 'utf8'), /3782|822463|10005|04\/29/);
    const split = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551119312',
      Body: '4111 x 1111 x 1111 x 1111',
      MessageSid: 'SM_SPLIT_CARD',
    });
    assert.match(await split.text(), /cannot take card numbers/);
    assert.doesNotMatch(fs.readFileSync(path.join(h.store.directory, 'threads.json'), 'utf8'), /4111/);
  });

  for (const phrase of [
    'Claude from your team called',
    'Ask Schneider in shipping',
    'A Google search',
    'gpt partition table',
    'STEP 7:',
    'Step 7 - tighten the bolts',
    'Step 7. Tighten the bolts',
    'Go to step 7',
    'Fusion splicing',
    'fusion welding',
    'Hi, this is Claude Schneider',
    'Google it',
  ]) {
    assert.equal(policy.applyGuardrails(phrase, env), phrase, phrase);
  }
  for (const [phrase, pattern] of [
    ['step7', /step7/i],
    ['fusion files from autodesk', /fusion|autodesk/i],
    ['a model from Open AI', /open\s*ai/i],
    ['I\'m Claude', /claude/i],
    ['Schneider Electric', /schneider/i],
  ]) {
    const cleaned = policy.applyGuardrails(phrase, env);
    assert.notEqual(cleaned, phrase, phrase);
    assert.doesNotMatch(cleaned, pattern, phrase);
  }
  assert.doesNotMatch(policy.applyGuardrails('A Google search', env), /the speech service/);
});

test('round 6 cards, split history, refund promises, opt-out, billing, and identity', async () => {
  const env = aiEnv();
  const gaps = [
    'card 4111 -- 1111 -- 1111 -- 1111',
    'card 4111 ••• 1111 ••• 1111 ••• 1111',
    'card 4111    1111    1111    1111',
    'card 4111 \r\n 1111 \r\n 1111 \r\n 1111',
    'card 4111\n\n\n\n1111\n\n\n\n1111\n\n\n\n1111',
    'card 4111 - - 1111 - - 1111 - - 1111',
    `card 4111${'\u200b'.repeat(4)}1111${'\u200b'.repeat(4)}1111${'\u200b'.repeat(4)}1111`,
    'card 4111 and 1111 and 1111 and 1111',
    'card 4111      ,      1111 1111 1111',
    'card ４１１１ １１１１ １１１１ １１１１',
    'card ４１１１１１１１１１１１１１１１',
    'card ٤١١١ ١١١١ ١١١١ ١١١١',
    'card ४०१२८८८८८८८८१८८१',
    'card 𝟒𝟐𝟒𝟐𝟒𝟐𝟒𝟐𝟒𝟐𝟒𝟐𝟒𝟐𝟒𝟐',
    'card 4111 1111 １１１１ 1111',
  ];
  for (const raw of gaps) {
    assert.equal(policy.containsCardNumber(raw), true, raw);
    assert.doesNotMatch(policy.redactCardNumbers(raw), /4111|４１１１|٤١١١|४०१२|𝟒𝟐𝟒𝟐/);
    assert.match(policy.redactCardNumbers(raw), /\[redacted\]/, raw);
  }
  const echo = policy.applyGuardrails('Your card ４１１１ １１１１ １１１１ １１１１ is on file.', env);
  assert.doesNotMatch(echo, /４|4111/);
  assert.match(echo, /\[redacted\]/);

  for (const phrase of [
    'my order number is 1234 5678 9012 3456',
    'job id 20261025170000 failed',
    'serial 1756102520260001 on the PLC',
    'tracking 9400 1000 0000 0000 0000 00',
  ]) {
    assert.equal(policy.containsCardNumber(phrase), false, phrase);
    const decision = await policy.triageTurn({
      channel: 'sms',
      text: phrase,
      state: state(),
      env,
      spentUsd: 0,
      complete: async () => answer('Email support@manualos.com and the team can look that up.'),
    });
    assert.doesNotMatch(decision.reply, /cannot take card numbers/, phrase);
  }
  assert.equal(policy.redactCardNumbers('Your job ran at 2026-10-25 17:00:00 and finished.'), 'Your job ran at 2026-10-25 17:00:00 and finished.');
  assert.equal(policy.redactCardNumbers('Serial 2026-1025-1700-0012 is installed.'), 'Serial 2026-1025-1700-0012 is installed.');

  const split = state();
  let splitCalls = 0;
  await policy.triageTurn({
    channel: 'sms',
    text: 'first part 4111 1111',
    state: split,
    env,
    spentUsd: 0,
    complete: async () => {
      splitCalls += 1;
      return answer('What is the rest of that number?');
    },
  });
  const rest = await policy.triageTurn({
    channel: 'sms',
    text: '1111 1111 is the rest',
    state: split,
    env,
    spentUsd: 0,
    complete: async () => {
      splitCalls += 1;
      return answer('should not run');
    },
  });
  assert.match(rest.reply, /cannot take card numbers/);
  assert.doesNotMatch(JSON.stringify(split.history), /4111/);
  assert.equal(splitCalls, 2);
  const amex = state();
  await policy.triageTurn({
    channel: 'sms',
    text: '3782',
    state: amex,
    env,
    spentUsd: 0,
    complete: async () => answer('Go on.'),
  });
  await policy.triageTurn({
    channel: 'sms',
    text: '822463',
    state: amex,
    env,
    spentUsd: 0,
    complete: async () => answer('Go on.'),
  });
  const amexLast = await policy.triageTurn({
    channel: 'sms',
    text: '10005',
    state: amex,
    env,
    spentUsd: 0,
    complete: async () => answer('should not run'),
  });
  assert.match(amexLast.reply, /cannot take card numbers/);
  assert.doesNotMatch(JSON.stringify(amex.history), /3782|822463|10005/);

  const cardStore = tempStore();
  cardStore.saveThread('+15551119400', {
    turns: 2,
    history: [
      { role: 'user', content: 'first part 4111 1111' },
      { role: 'user', content: '1111 1111 is the rest' },
    ],
  });
  assert.doesNotMatch(fs.readFileSync(path.join(cardStore.directory, 'threads.json'), 'utf8'), /4111/);

  const indirect = [
    "We'll make it right.",
    "You'll get your $39 back.",
    "I've processed a reversal.",
    "I've reversed the charge.",
    "I'll reverse your payment.",
    'The $79 will be returned to your card within 5 days.',
    "I'll send you a credit for the full amount.",
    "I've voided the charge.",
    "I'll waive this month's charge.",
    "Consider the charge cancelled; you won't pay a cent.",
    "We'll return your payment.",
    "I'll get your money right back to you.",
    "I've issued a chargeback on your behalf.",
    "You'll see the $39 back on your statement.",
    "I'll comp your account for this month.",
    "No charge. I've zeroed out your invoice.",
    "We'll make you whole.",
    'Your money is on its way back.',
    "I'll pay you back.",
    "I'll credit $39 to your card.",
    'I put the $39 back on your Visa.',
    'Rest assured, the $79 charge has been reversed.',
    'R-e-f-u-n-d approved.',
    'Your re\u200bfund is on its way.',
    'A full rëfund is coming.',
    'Your reimbursment is on the way.',
    "I can't issue a refund, but I've already sent your $39 back.",
    'Only the team can issue a refund, and they already approved yours.',
    'To request a refund, email support. Actually, done: it is approved.',
    'Refunds are handled by a person, and that person has approved yours.',
    'I cannot issue a refund. I have already issued it.',
    'Your money will be returned to your card.',
    'I will send the $39 back to your card.',
  ];
  for (const phrase of indirect) {
    assert.equal(policy.promisesRefund(phrase), true, phrase);
    const cleaned = policy.applyGuardrails(phrase, env);
    assert.match(cleaned, /cannot approve or issue a refund/i, phrase);
    assert.doesNotMatch(cleaned, /\$39 back|\$79|reversal|chargeback|make it right|make you whole/i, phrase);
  }
  const guarded = await policy.triageTurn({
    channel: 'sms',
    text: 'Can you help with my manual?',
    state: state(),
    env,
    spentUsd: 0,
    complete: async (request) => {
      if (request.maxTokens === 60) return { choices: [{ message: { content: '{"refund":true,"leak":false}' } }] };
      return answer('Sounds good, the drawing is ready.');
    },
  });
  assert.match(guarded.reply, /cannot approve or issue a refund/i);
  const leaked = await policy.triageTurn({
    channel: 'sms',
    text: 'Who is this?',
    state: state(),
    env,
    spentUsd: 0,
    complete: async (request) => {
      if (request.maxTokens === 60) return { choices: [{ message: { content: '{"refund":false,"leak":true}' } }] };
      return answer('The drawing is ready.');
    },
  });
  assert.match(leaked.reply, /support@manualos\.com/);
  assert.doesNotMatch(leaked.reply, /drawing is ready/);
  const failed = await policy.triageTurn({
    channel: 'sms',
    text: 'Where is my manual?',
    state: state(),
    env: aiEnv({ LLM_GUARD_TIMEOUT_MS: '20' }),
    spentUsd: 0,
    complete: async (request) => {
      if (request.maxTokens === 60) return new Promise(() => {});
      return answer('The manual is in your account.');
    },
  });
  assert.match(failed.reply, /support@manualos\.com/);
  assert.doesNotMatch(failed.reply, /in your account/);

  for (const phrase of [
    "don’t text me again",
    'Please don’t message me anymore',
    'Please stop',
    'leave me alone',
    'lose my number',
    'unsub',
    'I want off this list',
    'Remove my number',
    'delete my number',
    "I didn't sign up for this, stop",
    "I don't want to receive texts from you",
    'Cancel texts',
    'pls stop txting me',
  ]) {
    assert.equal(isOptOutMessage(phrase), true, phrase);
  }
  for (const phrase of [
    'Stop button on the HMI does not work',
    'Stop light is flashing red on the PLC',
    'STOP code F0003 on the drive, what does it mean?',
    'No more messages show up in the alarm log',
    'Remove me as the contact on the manual cover and use Bob instead',
    'please stop texting',
  ]) {
    assert.equal(isOptOutMessage(phrase), false, phrase);
  }
  assert.equal(policy.classify('take me off the Pro plan'), 'billing');
  assert.equal(policy.classify('take me off auto-renew'), 'billing');
  assert.equal(isOptOutMessage('take me off the Pro plan'), true);
  for (const phrase of [
    'why did you take $79 from my account',
    'unauthorized transaction from ManualOS',
    "I didn't authorize this purchase",
    "I'm filing a chargeback",
    'Cancel my order',
    'Why is there a $79 debit on my statement?',
    'Can I get a receipt for my purchase?',
    'Please turn off auto-renew',
    'Your company stole $39 from me',
    'My card got hit twice',
    'I paid but never got my manual',
    'Downgrade me from Pro to Starter',
    'how do I cancel',
    'You took $79 again this month',
  ]) {
    assert.equal(policy.classify(phrase), 'billing', phrase);
  }

  for (const phrase of [
    'Schneider PLCs are supported.',
    'Schneider-Electric Modicon exports work.',
    'Schneider EcoStruxure',
    'Claude.',
    'Powered by Claude.',
    'Claude here!',
    'I am an Open-AI model.',
    'I am GPT4o.',
    "I'm Gemini, by Google.",
    'I run on Llama from Meta.',
    'Mistral powers me.',
  ]) {
    const cleaned = policy.applyGuardrails(phrase, env);
    assert.doesNotMatch(cleaned, /schneider|claude|open-?ai|gpt\s*4|gemini|llama|\bmeta\b|mistral|\bgoogle\b/i, phrase);
  }
});
