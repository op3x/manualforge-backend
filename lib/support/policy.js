const VOICE_TURN_CAP = 12;
const SMS_TURN_CAP = 8;
const MAX_TOKENS = 200;
const HISTORY_LIMIT = 6;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BUDGET_USD = 10;
// gpt-4o-mini public rates. Override when LLM_MODEL is not this model.
const DEFAULT_INPUT_PER_1M = 0.15;
const DEFAULT_OUTPUT_PER_1M = 0.60;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const CARD_REPLY = 'I cannot take card numbers by phone or text. Please use checkout at https://manualos.com.';
const REFUND_REPLY = 'ManualOS has a 31-day refund policy. I cannot approve or issue a refund. The team will follow up at support@manualos.com.';
const INTEGRATOR_REPLY = 'The Integrator plan is not available yet. Starter is $39 one-time for 3 manuals, and Pro is $79 per month.';
const LEGAL_REPLY = 'I cannot give legal advice. Email support@manualos.com and the team will follow up.';
const UNSURE_REPLY = 'I am not sure about that. Please try once more, or say representative to reach a person.';

const BRANDS = [
  [/allen-?bradley/gi, 'your PLC'],
  [/rockwell/gi, 'your PLC vendor'],
  [/siemens/gi, 'your PLC vendor'],
  [/schneider/gi, 'your PLC vendor'],
  [/mitsubishi/gi, 'your PLC vendor'],
  [/omron/gi, 'your PLC vendor'],
  [/beckhoff/gi, 'your PLC vendor'],
  [/automation\s*direct/gi, 'your PLC vendor'],
  [/autodesk/gi, 'your CAD vendor'],
  [/autocad/gi, 'your CAD files'],
  [/solidworks/gi, 'your CAD files'],
  [/fusion\s*360/gi, 'your CAD files'],
  [/onshape/gi, 'your CAD files'],
];

const PERSON_PATTERNS = [
  /\brepresentative\b/i,
  /\b(?:talk|speak|transfer|connect)(?: me)? (?:to|with) (?:a |an )?(?:person|human|someone|somebody|agent|operator|representative|manager|rep)\b/i,
  /\b(?:live|real|actual) (?:agent|person|human|operator|representative)\b/i,
  /\b(?:customer service|support agent|real person)\b/i,
];

function e164(value) {
  const compact = String(value || '').trim().replace(/[\s()-]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  return '';
}

function llmConfig(env) {
  const rawProvider = env.LLM_PROVIDER;
  const provider = String(rawProvider == null || String(rawProvider).trim() === '' ? 'openai' : rawProvider).trim().toLowerCase();
  return {
    providerOk: provider === 'openai',
    apiKey: String(env.LLM_API_KEY || '').trim(),
    model: String(env.LLM_MODEL || '').trim() || DEFAULT_MODEL,
  };
}

function aiConfigured(env) {
  const llm = llmConfig(env);
  return Boolean(llm.providerOk && llm.apiKey);
}

function monthlyBudgetUsd(env) {
  const raw = env.LLM_MONTHLY_BUDGET_USD;
  if (raw == null || String(raw).trim() === '') return DEFAULT_BUDGET_USD;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return DEFAULT_BUDGET_USD;
  return amount;
}

function integratorEnabled(env) {
  const raw = String(env.SUPPORT_INTEGRATOR_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function monthKey(ms) {
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}

function perToken(env, name, perMillion) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return perMillion / 1_000_000;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return perMillion / 1_000_000;
  return amount / 1_000_000;
}

function tokenCost(usage, env = {}) {
  const prompt = nonNeg(usage && usage.prompt_tokens);
  const completion = nonNeg(usage && usage.completion_tokens);
  const total = nonNeg(usage && usage.total_tokens);
  let input = prompt;
  let output = completion;
  if (!input && !output && total) output = total;
  const usd = (input * perToken(env, 'LLM_USD_PER_1M_INPUT', DEFAULT_INPUT_PER_1M))
    + (output * perToken(env, 'LLM_USD_PER_1M_OUTPUT', DEFAULT_OUTPUT_PER_1M));
  return { inputTokens: input, outputTokens: output, usd: roundMoney(usd) };
}

function nonNeg(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return amount;
}

function roundMoney(value) {
  return Math.round(value * 1e8) / 1e8;
}

function clip(text, max) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, Math.max(0, max - 3))}...`;
}

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function walkDigitRuns(text, onRun) {
  let digits = '';
  let raw = '';
  let pending = '';
  let overflow = false;
  let out = '';
  const flush = () => {
    if (digits) {
      const replacement = onRun(digits, raw, overflow);
      out += replacement == null ? '' : replacement;
    }
    out += pending;
    digits = '';
    raw = '';
    pending = '';
    overflow = false;
  };
  for (const ch of String(text || '')) {
    if (ch >= '0' && ch <= '9') {
      if (overflow) {
        raw += pending;
        pending = '';
        raw += ch;
        continue;
      }
      if (pending) {
        raw += pending;
        pending = '';
      }
      digits += ch;
      raw += ch;
      if (digits.length > 19) overflow = true;
      continue;
    }
    if ((ch === ' ' || ch === '-') && digits && !overflow && !pending) {
      pending = ch;
      continue;
    }
    flush();
    out += ch;
  }
  flush();
  return out;
}

function cardRuns(text) {
  const found = [];
  walkDigitRuns(text, (digits, raw, overflow) => {
    if (!overflow && digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.push(digits);
    return raw;
  });
  return found;
}

function containsCardNumber(text) {
  const raw = String(text || '');
  if (cardRuns(raw).length) return true;
  return /\b(?:cvv|cvc|security code|card number|credit card|debit card)\b/i.test(raw);
}

function redactCardNumbers(text) {
  return walkDigitRuns(text, (digits, raw, overflow) => {
    if (!overflow && digits.length >= 13 && digits.length <= 19 && luhn(digits)) return '[redacted]';
    return raw;
  });
}

function wantsPerson(text) {
  return PERSON_PATTERNS.some((pattern) => pattern.test(text));
}

function isSafety(text) {
  return /\b(?:emergenc(?:y|ies)|injured|injury|electrocute[sd]?|electric shock|ambulance|on fire|unsafe|safety (?:issue|hazard|problem)|killed|dying|cannot breathe|can't breathe)\b/i.test(text)
    || /\b(?:someone|somebody) (?:is |was )?(?:hurt|injured)\b/i.test(text);
}

function isLegal(text) {
  return /\b(?:lawyer|attorney|lawsuit|legal action|sue you|suing|take you to court)\b/i.test(text);
}

function isAngry(text) {
  return /\b(?:furious|so angry|really angry|i am angry|i'm angry|unacceptable|this is a scam|rip-?off|worst (?:company|service|product))\b/i.test(text);
}

function amountsOver(text, limit) {
  const patterns = [
    /\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?/g,
    /\b([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?\s*(?:dollars|usd)\b/gi,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      const amount = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(amount) && amount > limit) return true;
      match = pattern.exec(text);
    }
  }
  return false;
}

function bigBilling(text) {
  if (!/\b(?:bill|billing|charg(?:e|ed|es)|invoice|refund|payment|overcharg\w*|subscription)\b/i.test(text)) return false;
  return amountsOver(text, 500);
}

function classify(text) {
  const raw = String(text || '');
  if (containsCardNumber(raw)) return 'card';
  if (wantsPerson(raw)) return 'person';
  if (isSafety(raw)) return 'safety';
  if (isLegal(raw)) return 'legal';
  if (isAngry(raw)) return 'angry';
  if (bigBilling(raw)) return 'billing';
  return '';
}

function systemPrompt(env, channel) {
  const phone = e164(env.SUPPORT_PHONE);
  const lines = [
    'You are the ManualOS support assistant on a live phone or text line. Answer only from the facts below. If you are unsure, say so.',
    'ManualOS turns PLC and CAD files into operator and maintenance manuals.',
    'Starter is $39 one-time for 3 manuals.',
    'Pro is $79 per month: unlimited manuals, plus a PM schedule, startup and shutdown procedures, and other documents on request.',
  ];
  if (integratorEnabled(env)) {
    lines.push('Integrator is $249 per month or $2,490 per year, 25 manuals per month, white-label, and $9 per extra manual.');
  } else {
    lines.push('The Integrator plan is not launched and is not available. Do not mention Integrator pricing. If asked, say it is not available yet.');
  }
  lines.push(
    'Refunds follow a 31-day policy. You never promise, approve, or issue a refund. Say the team will follow up.',
    'Support email is support@manualos.com.',
    phone ? `The support phone line is ${phone}.` : 'Do not invent a phone number.',
    'You cannot see orders, manuals, or payments. Never invent status. Offer support@manualos.com or a person.',
    'No binding legal advice. No safety instructions for equipment. Urgent or safety issues are handed to a person.',
    'Never accept, repeat, or store card numbers, CVV, or bank details. Refuse and send the caller to checkout at https://manualos.com.',
    'Do not use real third-party brand names. Say "your PLC files" or "your CAD files".',
    'Admit when you are unsure.',
    `Channel: ${channel === 'sms' ? 'sms' : 'voice'}. Keep the reply short enough to speak aloud.`,
    'Respond with one JSON object and nothing else: {"reply":"what the caller hears","confidence":"high|medium|low","handoff":false,"reason":"","summary":"one line for a teammate"}.',
    'Set handoff to true when the caller asks for a person, reports an urgent or safety issue, raises a legal issue, is angry, or has a billing dispute over $500.',
    'Set confidence to low when the question is outside these facts.',
  );
  return lines.join('\n');
}

function promisesRefund(text) {
  return /\b(?:i (?:will|can|'ll|am going to) (?:issue|process|give|grant|approve) (?:you )?a refund|refund (?:is|has been) (?:issued|processed|approved)|i promise [\s\S]{0,40}refund|you will (?:get|receive) a refund)\b/i.test(text);
}

function stripBrands(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of BRANDS) out = out.replace(pattern, replacement);
  return out;
}

function applyGuardrails(reply, env) {
  const text = redactCardNumbers(String(reply || '')).trim();
  if (!text) return 'I am not sure about that. Email support@manualos.com if you want a person to follow up.';
  if (promisesRefund(text)) return REFUND_REPLY;
  if (!integratorEnabled(env) && /\bintegrator\b/i.test(text)) return INTEGRATOR_REPLY;
  const cleaned = stripBrands(text);
  if (/\b(?:you should sue|you are legally entitled|you have a legal right to)\b/i.test(cleaned)) return LEGAL_REPLY;
  return cleaned;
}

function parseModelJson(raw) {
  const text = messageText(raw).trim();
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = tryJson(stripped) || tryJson(sliceObject(stripped));
  if (parsed) return parsed;
  return {
    reply: text,
    confidence: text ? 'medium' : 'low',
    handoff: false,
    reason: '',
    summary: '',
    parsed: false,
  };
}

function tryJson(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const confidence = ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : 'medium';
    return {
      reply: String(value.reply || '').trim(),
      confidence,
      handoff: Boolean(value.handoff),
      reason: String(value.reason || '').slice(0, 60),
      summary: String(value.summary || '').slice(0, 200),
      parsed: true,
    };
  } catch {
    return null;
  }
}

function sliceObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return '';
}

function handoffReply(reason, channel) {
  if (channel === 'sms') {
    if (reason === 'safety') return 'I cannot give safety advice. A person will follow up by text.';
    if (reason === 'legal') return 'I cannot give legal advice. A person will follow up by text.';
    if (reason === 'billing') return 'A billing issue over $500 needs a person. The team will follow up. I cannot approve a refund.';
    if (reason === 'angry') return 'I am sorry this has been frustrating. A person will follow up by text.';
    if (reason === 'turn_cap') return 'I need a person to continue this conversation. The team will follow up.';
    if (reason === 'low_confidence') return 'I am not sure about that. A person will follow up.';
    if (reason === 'budget') return 'Automated replies are paused. Email support@manualos.com and the team will follow up.';
    return 'A person will follow up by text.';
  }
  if (reason === 'safety') return 'I cannot give safety advice. Connecting you to a person now.';
  if (reason === 'legal') return 'I cannot give legal advice. Connecting you to a person now.';
  if (reason === 'billing') return 'A billing issue over $500 needs a person. Connecting you now. I cannot approve a refund.';
  if (reason === 'angry') return 'I am sorry this has been frustrating. Connecting you to a person now.';
  if (reason === 'turn_cap') return 'I need a person to keep going. Connecting you now.';
  if (reason === 'low_confidence') return 'I am not confident I can answer that. Connecting you to a person.';
  if (reason === 'budget') return 'Automated help is unavailable right now. Connecting you to a person.';
  return 'Connecting you to a person now.';
}

function finish(decision) {
  return {
    handoff: Boolean(decision.handoff),
    escalate: Boolean(decision.escalate),
    reason: String(decision.reason || '').slice(0, 40),
    reply: clip(decision.reply, 500),
    summary: clip(redactCardNumbers(decision.summary || ''), 180),
    usage: decision.usage || null,
  };
}

async function triageTurn({
  channel,
  text,
  state,
  env,
  spentUsd,
  complete,
}) {
  const cap = channel === 'sms' ? SMS_TURN_CAP : VOICE_TURN_CAP;
  const kind = classify(text);
  if (kind === 'card') {
    state.turns += 1;
    return finish({
      handoff: false,
      escalate: false,
      reason: 'card',
      reply: CARD_REPLY,
      summary: 'Payment details were refused.',
    });
  }
  if (kind) {
    state.turns += 1;
    return finish({
      handoff: true,
      escalate: true,
      reason: kind === 'person' ? 'representative' : kind,
      reply: handoffReply(kind === 'person' ? 'representative' : kind, channel),
      summary: `${kind}: ${clip(redactCardNumbers(text), 140)}`,
    });
  }
  if (state.turns >= cap) {
    return finish({
      handoff: true,
      escalate: true,
      reason: 'turn_cap',
      reply: handoffReply('turn_cap', channel),
      summary: 'Turn cap reached.',
    });
  }
  const llm = llmConfig(env);
  if (!llm.providerOk || !llm.apiKey || spentUsd >= monthlyBudgetUsd(env)) {
    const reason = 'budget';
    return finish({
      handoff: channel === 'voice',
      escalate: channel === 'voice',
      reason,
      reply: handoffReply(reason, channel),
      summary: 'AI unavailable or monthly budget reached.',
    });
  }

  state.turns += 1;
  const history = Array.isArray(state.history) ? state.history.slice(-HISTORY_LIMIT) : [];
  const messages = [
    { role: 'system', content: systemPrompt(env, channel) },
    ...history,
    { role: 'user', content: clip(redactCardNumbers(text), 1000) },
  ];
  let response;
  try {
    response = await (complete || completeOpenAI)({
      apiKey: llm.apiKey,
      model: llm.model,
      messages,
      maxTokens: MAX_TOKENS,
    });
  } catch (err) {
    console.error('Support model call failed', err && err.status ? String(err.status) : 'error');
    state.lowConfidence += 1;
    if (state.lowConfidence >= 2) {
      return finish({
        handoff: true,
        escalate: true,
        reason: 'low_confidence',
        reply: handoffReply('low_confidence', channel),
        summary: 'Model failed twice.',
      });
    }
    return finish({
      handoff: false,
      escalate: false,
      reason: 'error',
      reply: UNSURE_REPLY,
      summary: 'Model error.',
    });
  }

  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  const parsed = parseModelJson(content);
  const reply = applyGuardrails(parsed.reply, env);
  const usage = usageFrom(response, messages, content, env);
  state.history = history.concat([
    { role: 'user', content: clip(redactCardNumbers(text), 500) },
    { role: 'assistant', content: clip(reply, 500) },
  ]).slice(-HISTORY_LIMIT);
  if (parsed.confidence === 'low') state.lowConfidence += 1;
  else state.lowConfidence = 0;

  if (state.lowConfidence >= 2) {
    return finish({
      handoff: true,
      escalate: true,
      reason: 'low_confidence',
      reply: handoffReply('low_confidence', channel),
      summary: parsed.summary || 'Low confidence after 2 tries.',
      usage,
    });
  }
  if (parsed.handoff) {
    return finish({
      handoff: true,
      escalate: true,
      reason: parsed.reason || 'handoff',
      reply: reply || handoffReply('representative', channel),
      summary: parsed.summary || reply,
      usage,
    });
  }
  return finish({
    handoff: false,
    escalate: false,
    reason: '',
    reply,
    summary: parsed.summary || '',
    usage,
  });
}

function usageFrom(response, messages, content, env) {
  const raw = response && response.usage;
  if (raw && (raw.prompt_tokens || raw.completion_tokens || raw.total_tokens)) return tokenCost(raw, env);
  const promptChars = messages.map((message) => String(message.content || '')).join('').length;
  const outChars = messageText(content).length;
  return tokenCost({
    prompt_tokens: Math.max(1, Math.ceil(promptChars / 4)),
    completion_tokens: Math.max(1, Math.ceil(outChars / 4)),
  }, env);
}

async function completeOpenAI({ apiKey, model, messages, maxTokens, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });
    if (!response.ok) {
      const err = new Error('LLM request failed');
      err.status = response.status;
      throw err;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const SMS_FOOTER = 'Reply STOP to opt out, HELP for help. Msg&data rates may apply.';

function formatCustomerSms(body, { footer = true } = {}) {
  let text = clip(body, 320);
  if (footer && !/reply stop to opt out/i.test(text)) text = `${text} ${SMS_FOOTER}`;
  if (!text.startsWith('ManualOS Support:')) text = `ManualOS Support: ${text}`;
  return text;
}

function formatEscalationSms(body) {
  const text = clip(redactCardNumbers(body), 420);
  if (text.startsWith('ManualOS Support:')) return text;
  return `ManualOS Support: ${text}`;
}

module.exports = {
  VOICE_TURN_CAP,
  SMS_TURN_CAP,
  MAX_TOKENS,
  HISTORY_LIMIT,
  DEFAULT_MODEL,
  DEFAULT_BUDGET_USD,
  DEFAULT_INPUT_PER_1M,
  DEFAULT_OUTPUT_PER_1M,
  CARD_REPLY,
  SMS_FOOTER,
  e164,
  llmConfig,
  aiConfigured,
  monthlyBudgetUsd,
  integratorEnabled,
  monthKey,
  tokenCost,
  clip,
  containsCardNumber,
  redactCardNumbers,
  classify,
  systemPrompt,
  applyGuardrails,
  triageTurn,
  completeOpenAI,
  formatCustomerSms,
  formatEscalationSms,
};
