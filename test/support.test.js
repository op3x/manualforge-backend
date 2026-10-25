const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const twilio = require('twilio');
const { WebSocket } = require('ws');
const { createApp } = require('../server');
const { createSupportStore, removeTestSupportDirectories } = require('../lib/support/store');
const policy = require('../lib/support/policy');

const TOKEN = 'twilio-test-auth-token';
const dirs = [];

test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  removeTestSupportDirectories();
});

function tempStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-support-test-'));
  dirs.push(directory);
  return createSupportStore({ directory, env: { NODE_ENV: 'test', SUPPORT_DATA_DIR: directory } });
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
  const completions = [];
  const store = tempStore();
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
    ...extra,
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
    },
    supportComplete: async (request) => {
      completions.push(request);
      return completeImpl(request);
    },
    supportNow: () => Date.parse('2026-10-25T12:00:00Z'),
  });
  return {
    app,
    env,
    store,
    sent,
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
  assert.match(prompt, /31-day policy/);
  assert.match(prompt, /support@manualos\.com/);
  assert.match(prompt, /not launched/);
  assert.doesNotMatch(prompt, /2,490/);
  const launched = policy.systemPrompt({ SUPPORT_INTEGRATOR_ENABLED: 'true' }, 'sms');
  assert.match(launched, /\$249 per month or \$2,490 per year/);
  assert.match(launched, /\$9 per extra manual/);

  const cost = policy.tokenCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  assert.ok(Math.abs(cost.usd - 0.75) < 1e-8);
  assert.equal(policy.containsCardNumber('4111 1111 1111 1111'), true);
  assert.equal(policy.containsCardNumber('4111-1111-1111-1111'), true);
  assert.equal(policy.containsCardNumber('Starter is $39'), false);
  assert.equal(policy.redactCardNumbers('card 4111111111111111 thanks'), 'card [redacted] thanks');
  assert.equal(policy.classify('representative'), 'person');
  assert.equal(policy.classify('operator manual please'), '');
  assert.equal(policy.classify('This is an emergency and someone is injured'), 'safety');
  assert.equal(policy.classify('I will call my lawyer'), 'legal');
  assert.equal(policy.classify('I am furious'), 'angry');
  assert.equal(policy.classify('I was charged $600 on my invoice'), 'billing');
  assert.equal(policy.classify('I was charged $39'), '');
  assert.equal(policy.classify('I was charged $500'), '');

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
      assert.equal(h.completions.length, 1);
      assert.equal(h.completions[0].maxTokens, 200);
      assert.match(h.completions[0].messages[0].content, /Starter is \$39 one-time for 3 manuals/);

      client.send({ type: 'prompt', voicePrompt: 'my card is 4111 1111 1111 1111', last: true });
      const refused = await client.next();
      assert.equal(refused.type, 'text');
      assert.match(refused.token, /cannot take card numbers/);
      assert.doesNotMatch(refused.token, /4111/);
      assert.equal(h.completions.length, 1);

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
      assert.equal(h.completions.length, 1);
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
    assert.match(missedXml, /<Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="\/api\/twilio\/voice\/transcription"\/>/);
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
    assert.equal(h.completions.length, 1);

    const card = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551113333',
      Body: 'my card is 4111-1111-1111-1111',
      MessageSid: 'SM_CARD',
    });
    const cardXml = await card.text();
    assert.match(cardXml, /cannot take card numbers/);
    assert.match(cardXml, /https:\/\/manualos\.com/);
    assert.doesNotMatch(cardXml, /4111/);
    assert.equal(h.completions.length, 1);
    assert.equal(h.sent.length, 0);

    const angry = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551114444',
      Body: 'I am furious',
      MessageSid: 'SM_ANGRY',
    });
    assert.match(await angry.text(), /person will follow up/);
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].body, /furious/);
    assert.equal(h.completions.length, 1);

    h.store.saveThread('+15551115555', { turns: policy.SMS_TURN_CAP, lowConfidence: 0, history: [], updatedAt: '2026-10-25T00:00:00.000Z' });
    const capped = await postTwilio(base, h.env, '/api/twilio/sms', {
      From: '+15551115555',
      Body: 'another question about starter',
      MessageSid: 'SM_CAP',
    });
    assert.match(await capped.text(), /person/);
    assert.equal(h.completions.length, 1);
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
    assert.equal(budget.completions.length, 1);
    assert.ok(budget.store.spentUsd('2026-10') >= 0.5);
    const second = await postTwilio(base, budget.env, '/api/twilio/sms', {
      From: '+15551116666',
      Body: 'What about Pro?',
      MessageSid: 'SM_BUDGET_2',
    });
    assert.match(await second.text(), /paused/i);
    assert.equal(budget.completions.length, 1);
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
    assert.equal(record.ip, '203.0.113.9');
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
