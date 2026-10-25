const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { createAnthropic } = require('../lib/anthropic');

test('Anthropic client uses native fetch and reads a gzip response', async () => {
  const payload = Buffer.from(JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: '{"human_title":"Infeed"}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
  }));
  const gzipped = zlib.gzipSync(payload);
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': gzipped.length,
    });
    res.end(gzipped);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    const client = createAnthropic({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    const message = await client.messages.create({
      model: 'claude-haiku-5-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(message.content[0].text.includes('Infeed'), true);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});
