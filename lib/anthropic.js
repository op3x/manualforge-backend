const Anthropic = require('@anthropic-ai/sdk');

function createAnthropic(env = process.env, fetchImpl = globalThis.fetch) {
  const apiKey = String(env.ANTHROPIC_API_KEY || '');
  const hasValidKey = apiKey && apiKey !== 'sk-ant-...' && apiKey.startsWith('sk-ant-');
  if (!hasValidKey) return null;
  return new Anthropic({ apiKey, fetch: fetchImpl });
}

module.exports = { createAnthropic };
