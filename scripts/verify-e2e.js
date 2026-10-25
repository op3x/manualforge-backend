const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp } = require('../server');
const { renderPdf } = require('../lib/manual/pdf');
const { redactCustomerLog } = require('../lib/redact-log');

const ROOT = '/cursor/stores/bot/manualos-test-corpus/';
const OUT = '/opt/cursor/artifacts';

function anthropic() {
  return {
    messages: {
      create: async (body) => {
        const indexes = [...body.messages[0].content.matchAll(/"index":\s*(\d+)/g)].map((match) => Number(match[1]));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              human_title: 'Equipment function',
              purpose: 'The station moves the product when the guards are closed and start is requested.',
              inferred: true,
              operator_steps: [{ action: 'Press Start.', expect: 'The station runs.' }],
              groups: [{
                unit_numbers: indexes,
                title: 'Station run',
                function: 'The station runs when start is requested and the guards are closed.',
                conditions: 'Guards are closed',
                result: 'The station runs',
                housekeeping: false,
                inferred: true,
              }],
              alarms: [{ code: 'ALM', text: 'Station fault', cause: 'A guard opened during the cycle.', remedy: 'Close the guard and press Reset.', inferred: true }],
              applicable_hazard_ids: [],
              interlocks: ['Guards closed'],
              what_operator_sees: 'The running lamp is on.',
            }),
          }],
        };
      },
    },
  };
}

function stripe() {
  const meta = { manuals_used: '0', plan: 'starter', credit_generation: '0' };
  return {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_e2e',
          metadata: { plan: 'pro' },
          payment_status: 'paid',
          payment_intent: null,
          subscription: 'sub_e2e',
        }),
      },
    },
    subscriptions: { retrieve: async () => ({ id: 'sub_e2e', status: 'active' }) },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_e2e', metadata: { ...meta } }),
      update: async () => ({ id: 'pi_e2e', metadata: { ...meta } }),
    },
  };
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel));
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runJob(base, files) {
  const form = new FormData();
  form.set('session_id', 'cs_e2e');
  form.set('manufacturer_name', 'ManualOS');
  form.set('product_name', 'Sample line');
  for (const file of files) form.append('files', new Blob([file.buffer]), file.name);
  const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
  if (created.status !== 202) {
    throw new Error(`upload failed with status ${created.status}: ${redactCustomerLog(await created.text())}`);
  }
  const job = await created.json();
  for (let i = 0; i < 120; i += 1) {
    const headers = { 'X-Session-Id': 'cs_e2e' };
    const body = await (await fetch(`${base}/jobs/${job.id}`, { headers })).json();
    if (body.status === 'succeeded') {
      const pdf = Buffer.from(await (await fetch(`${base}/jobs/${job.id}/pdf`, { headers })).arrayBuffer());
      return { pdf, body };
    }
    if (body.status === 'failed') throw new Error(`${job.id} failed: ${body.error}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timeout');
}

function score(text) {
  const checks = [
    ['Numbered steps with an expected result', /Expected result\./.test(text)],
    ['Troubleshooting symptom / cause / remedy', /Symptom/.test(text) && /Probable cause/.test(text) && /Remedy/.test(text)],
    ['Maintenance interval / task / who', /Interval/.test(text) && /\bTask\b/.test(text) && /\bWho\b/.test(text)],
    ['Signal-word safety boxes', /\bDANGER\b/.test(text) && /\bWARNING\b/.test(text) && /\bCAUTION\b/.test(text)],
    ['Qualified personnel', /qualified personnel/i.test(text)],
    ['Lockout/tagout before the work', /Lock out every energy source/.test(text)],
    ['Specifications table', /Parameter/.test(text) && /Value/.test(text)],
    ['Spare parts item / part / qty', /\bItem\b/.test(text) && /\bPart\b/.test(text) && /\bQty\b/.test(text)],
    ['Figure callouts', /Plan view inferred/.test(text)],
    ['Imperative procedures', /Press Start|Switch on the main disconnect|Confirm every guard/.test(text)],
    ['No Routine: headings', !/Routine\s*:/.test(text)],
    ['Inferred content is marked', /Inferred - please confirm/.test(text)],
  ];
  const passed = checks.filter((item) => item[1]).length;
  return { passed, total: checks.length, checks: checks.map(([name, ok]) => ({ name, ok })) };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = [
    ['l5x', [{ name: 'line.L5X', buffer: read('plc/rockwell_ExampleForCICD_L85E.L5X') }]],
    ['l5k', [{ name: 'line.L5K', buffer: read('plc/swat_PLC1.L5K') }]],
    ['plcopen', [{ name: 'line.xml', buffer: read('plc/candyfactory_CandyFactory_plcopen.xml') }]],
    ['st', [{ name: 'line.st', buffer: read('plc/cybics_openplc.st') }]],
    ['csv', [{ name: 'tags.csv', buffer: read('plc/swat_P1-MainProgram-Tags.CSV') }]],
    ['step', [{ name: 'frame.stp', buffer: read('cad/creator_center_conveyor_pulley.stp') }]],
    ['dxf', [{ name: 'title.dxf', buffer: read('cad/cadzinho_title_a1.dxf') }]],
    ['combined', [
      { name: 'line.L5X', buffer: read('plc/rockwell_ExampleForCICD_L85E.L5X') },
      { name: 'pulley.stp', buffer: read('cad/creator_center_conveyor_pulley.stp') },
    ]],
  ];
  const app = createApp({
    env: {
      NODE_ENV: 'test',
      FRONTEND_URL: 'https://manualos.com',
      STRIPE_PRICE_STARTER: 'price_starter',
      STRIPE_PRICE_PRO: 'price_pro',
      STARTER_CREDITS: '3',
    },
    stripe: stripe(),
    anthropic: anthropic(),
    renderPdf,
  });
  const results = [];
  await withServer(app, async (base) => {
    for (const [label, files] of jobs) {
      const started = Date.now();
      const { pdf, body } = await runJob(base, files);
      const pdfPath = path.join(OUT, `${label}-manual.pdf`);
      fs.writeFileSync(pdfPath, pdf);
      const prefix = path.join(OUT, `${label}-page`);
      execFileSync('pdftoppm', ['-png', '-f', '1', '-l', '3', pdfPath, prefix]);
      results.push({ label, ms: Date.now() - started, bytes: pdf.length, coverage: body.coverage, pages: fs.readdirSync(OUT).filter((name) => name.startsWith(`${label}-page`)) });
      console.log('OK', label, pdf.length, body.coverage && body.coverage.percent);
    }
  });
  const text = execFileSync('pdftotext', ['-layout', path.join(OUT, 'combined-manual.pdf'), '-'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const card = score(text);
  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify({ results, score: card }, null, 2));
  console.log('score', card.passed, '/', card.total);
  for (const item of card.checks) console.log(item.ok ? 'PASS' : 'FAIL', item.name);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
