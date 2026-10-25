const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { createApp } = require('../server');
const { parseUploads } = require('../lib/parsers');
const { renderHtml } = require('../lib/manual/html');
const { findChrome, closeBrowser } = require('../lib/manual/pdf');
const { createJobStore, CLEANUP_INTERVAL_MS } = require('../lib/jobs/store');
const {
  classifyRequest,
  creditsForDocumentRun,
  planAllowsExtraDocuments,
  selectionFromRequest,
  UPGRADE_MESSAGE,
} = require('../lib/documents/selection');
const { buildPmSchedule, buildShutdown, buildStartup, buildCustomDocument } = require('../lib/documents/content');
const { stampDocument } = require('../lib/documents/stamp');
const { resolveDocumentBranding } = require('../lib/documents/branding');

const L5X = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
const SCL = fs.readFileSync(path.join(__dirname, 'fixtures/cell.scl'));
const DAY_MS = 24 * 60 * 60 * 1000;

function env(extra = {}) {
  return {
    NODE_ENV: 'test',
    FRONTEND_URL: 'https://manualos.com',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_PRO: 'price_pro',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STARTER_CREDITS: '3',
    ...extra,
  };
}

function stripeFor(plan, allowanceStart = '0') {
  const calls = { updates: [] };
  const meta = { manuals_used: allowanceStart, plan, credit_generation: '0', credit_hold: '' };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: `cs_test_${plan}`,
          metadata: { plan },
          payment_status: 'paid',
          payment_intent: plan === 'starter' ? { id: 'pi_1', metadata: { ...meta } } : null,
          subscription: plan === 'starter' ? null : 'sub_1',
        }),
      },
    },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_1', metadata: { ...meta } }),
      update: async (id, params) => {
        calls.updates.push(params.metadata);
        for (const [key, value] of Object.entries(params.metadata)) {
          if (value === '') delete meta[key];
          else meta[key] = value;
        }
        return { id, metadata: { ...meta } };
      },
    },
    subscriptions: { retrieve: async () => ({ id: 'sub_1', status: 'active', metadata: { plan } }) },
  };
  return { stripe, meta, calls };
}

function anthropic() {
  return {
    messages: {
      create: async (body) => {
        const prompt = body.messages[0].content;
        const indexes = [...prompt.matchAll(/"index":\s*(\d+)/g)].map((match) => Number(match[1]));
        if (!indexes.length) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                equipment_kind: 'machine',
                product_name: 'Cell line',
                overview: 'The cell moves a part on the conveyor when the guard is closed and the emergency stop is healthy.',
                cycle: 'Check the guard, reset faults, home the axis, then start one cycle and watch the conveyor.',
                subsystems: [],
              }),
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              human_title: 'Cell run',
              purpose: 'The conveyor runs when start is requested, the guard is closed, and the emergency stop is healthy. A stop or an open guard drops the run command.',
              inferred: true,
              operator_steps: [{ action: 'Press start.', expect: 'The conveyor runs.' }],
              groups: [{
                unit_numbers: indexes,
                title: 'Conveyor run',
                function: 'The conveyor runs when start is requested and the guard is closed.',
                conditions: 'Guard closed and emergency stop healthy',
                result: 'Conveyor runs',
                housekeeping: false,
                inferred: true,
              }],
              alarms: [{ code: 'ALM', text: 'Guard open', cause: 'The guard door is open.', remedy: 'Close the guard and press reset.', inferred: true }],
              applicable_hazard_ids: [],
              interlocks: ['Guard closed'],
              what_operator_sees: 'The running indication is on.',
            }),
          }],
        };
      },
    },
  };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitJob(base, id) {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/jobs/${id}`);
    const body = await res.json();
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('job did not finish');
}

async function projectFrom(buffer, name) {
  return parseUploads([{ originalname: name, buffer }], { product_name: 'Cell line' }, env());
}

function htmlOf(doc) {
  return renderHtml(doc);
}

test('plan gate, credit cost, and request classification', () => {
  assert.equal(planAllowsExtraDocuments('starter'), false);
  assert.equal(planAllowsExtraDocuments('pro'), true);
  assert.equal(planAllowsExtraDocuments('integrator'), true);
  assert.equal(creditsForDocumentRun(), 1);
  assert.equal(classifyRequest('poem about cats').related, false);
  assert.equal(classifyRequest('write a poem').related, false);
  assert.equal(classifyRequest('chocolate cake recipe').related, false);
  assert.equal(classifyRequest('recipe changeover').related, true);
  assert.equal(classifyRequest('recipe changeover').kind, 'changeover');
  assert.equal(classifyRequest('depositor cleaning').related, true);
  assert.equal(classifyRequest('cookie depositor cleaning').kind, 'cleaning');
  assert.equal(classifyRequest('sanitation checklist').related, true);
  assert.equal(classifyRequest('alarm and troubleshooting guide').related, true);
  assert.equal(classifyRequest('alarm and troubleshooting guide').kind, 'troubleshooting');
  assert.equal(classifyRequest('spare parts list').title, 'Spare Parts List');
  assert.equal(classifyRequest('commissioning checklist').kind, 'commissioning');
  assert.equal(classifyRequest('commissioning checklist').title, 'Commissioning Checklist');
  assert.equal(classifyRequest('torque table').related, true);
  assert.equal(classifyRequest('wiring list').related, true);
  assert.equal(classifyRequest('instrument chart').related, true);
  const selected = selectionFromRequest({
    body: {
      documents: '["manual","pm_schedule","shutdown","startup"]',
      requested_documents: 'alarm and troubleshooting guide, spare parts list',
    },
  });
  assert.equal(selected.requestsExtras, true);
  assert.equal(selected.entries.filter((entry) => entry.kind === 'troubleshooting').length, 1);
  assert.equal(selected.entries.filter((entry) => entry.kind === 'parts').length, 1);
  assert.equal(selected.entries.filter((entry) => entry.status === 'skipped').length, 0);
  assert.equal(creditsForDocumentRun(selected), 1);
  assert.throws(() => selectionFromRequest({ body: { requested_documents: 'x'.repeat(1501) } }), (err) => err.status === 400);
  assert.throws(() => selectionFromRequest({ body: { documents: '["brochure"]' } }), (err) => err.status === 400);
});

test('schedules and procedures follow the equipment that was found', async () => {
  const cell = await projectFrom(SCL, 'cell.scl');
  const pm = htmlOf(buildPmSchedule(cell, {}));
  assert.match(pm, /Preventive Maintenance Schedule/);
  assert.match(pm, /recommended defaults/i);
  assert.match(pm, /Sign-off/);
  assert.match(pm, /Tasks by interval/);
  assert.match(pm, />Daily </);
  assert.match(pm, /500 operating hours/);
  assert.match(pm, /conveyor motor/i);
  assert.equal(/run command/i.test(pm), false);
  assert.match(pm, /pneumatic cylinder valve/i);
  assert.match(pm, /hydraulic pump/i);
  assert.match(pm, /emergency stop circuit/i);
  assert.match(pm, /part present sensor/i);
  assert.match(pm, /gearbox lubrication point/i);
  assert.equal(/Walk the work area/.test(pm), false);
  assert.equal(/Listen to/.test(pm), false);
  assert.match(pm, /data sheet/i);
  assert.equal(/\d+\s*Nm\b/.test(pm), false);
  assert.equal(/\d+\s*psi\b/i.test(pm), false);
  assert.equal(/haas|fanuc|siemens|\babb\b|allen-bradley/i.test(pm), false);

  const line = await projectFrom(L5X, 'line.L5X');
  const linePm = htmlOf(buildPmSchedule(line, {}));
  assert.match(linePm, /conveyor motor/i);
  assert.equal(/Drain filter bowls/.test(linePm), false);
  assert.equal(/Hydraulic pump/.test(linePm), false);

  const shutdown = htmlOf(buildShutdown(cell, {}));
  assert.match(shutdown, /Normal stop/);
  assert.match(shutdown, /Emergency stop/);
  assert.match(shutdown, /normal stop button/i);
  assert.match(shutdown, /Lockout/);
  assert.match(shutdown, /Electrical/);
  assert.match(shutdown, /Pneumatic/);
  assert.match(shutdown, /Hydraulic/);
  assert.match(shutdown, /Verify zero energy/);
  assert.match(shutdown, /Expected result/);

  const startup = htmlOf(buildStartup(cell, {}));
  assert.match(startup, /Pre-start checks/);
  assert.match(startup, /Power-up/);
  assert.match(startup, /Homing and reset/);
  assert.match(startup, /First cycle/);
  assert.match(startup, /Request homing/);
  assert.match(startup, /releases the lift brake/);
  assert.match(startup, /fault reset button/i);
  assert.match(startup, /shutdown procedure/i);
  assert.equal(/EStop/.test(startup), false);
  assert.equal(/Close Interlock/.test(startup), false);

  const guide = htmlOf(buildCustomDocument(cell, {
    id: 'custom_1',
    title: 'Alarm and Troubleshooting Guide',
    kind: 'troubleshooting',
    customKind: 'troubleshooting',
  }, {}));
  assert.match(guide, /Alarm and Troubleshooting Guide/);
  assert.match(guide, /does not repeat that description/);
  assert.match(guide, /guard is open/i);
  assert.equal(/XIC\(/.test(guide), false);
  assert.equal((guide.match(/does not repeat that description/g) || []).length, 1);

  const branded = stampDocument(buildPmSchedule(cell, {}), {
    whiteLabel: true,
    companyName: 'North Line Controls',
    logoHtml: '<svg class="brand-logo" xmlns="http://www.w3.org/2000/svg"></svg>',
  }, 'Preventive Maintenance Schedule');
  const brandedHtml = htmlOf(branded);
  assert.match(brandedHtml, /North Line Controls/);
  assert.match(brandedHtml, /brand-logo/);
  assert.equal(resolveDocumentBranding({ plan: 'integrator', customerId: 'cus_test' }), null);
  assert.equal(resolveDocumentBranding({ plan: 'pro' }), null);
  assert.deepEqual(resolveDocumentBranding({ plan: 'integrator', customerId: 'cus_test' }, { companyName: 'Passed' }), { companyName: 'Passed' });
  assert.equal(resolveDocumentBranding({ plan: 'pro', branding: { companyName: 'Passed' } }), null);

  const { emptyProject, addRoutine, upsertTag } = require('../lib/project');
  const named = emptyProject();
  addRoutine(named, { name: 'PRG_VGR_Axis_vertical', units: [{ index: 0, number: 0, comment: 'Photoeyes and proxes at the infeed', text: '' }], comment: '' });
  upsertTag(named, { name: 'Stop_000', description: '' });
  named.identity.productName = 'Transfer cell';
  named.identity.productNameFromUser = true;
  const fromNames = htmlOf(buildPmSchedule(named, {}));
  assert.match(fromNames, /axis vertical/i);
  assert.match(fromNames, /photoeyes/i);
  assert.equal(/does not move a product/.test(fromNames), false);
  const fromStop = htmlOf(buildShutdown(named, {}));
  assert.match(fromStop, /Stop/);
  assert.match(fromStop, /Gravity/);

  const conversion = emptyProject();
  upsertTag(conversion, { name: 'Dint_Conv', description: '' });
  upsertTag(conversion, { name: 'MathConv', description: '' });
  addRoutine(conversion, { name: 'R033_ASCII_Conv', units: [{ index: 0, number: 0, text: 'DTOS(Dint_Conv[0],Str_Conv[0]);', comment: '' }], comment: '' });
  conversion.identity.productName = 'Instruction sample';
  conversion.identity.productNameFromUser = true;
  const conversionPm = htmlOf(buildPmSchedule(conversion, {}));
  assert.equal(/Conveyor/.test(conversionPm), false);
  assert.match(conversionPm, /did not identify a motor, valve, sensor, or other maintainable device/);
  assert.equal(/no specific device class/.test(conversionPm), false);
});

test('starter extra documents are refused before a credit is reserved', async () => {
  const paid = stripeFor('starter');
  const app = createApp({ env: env(), stripe: paid.stripe, anthropic: anthropic(), renderPdf: async () => Buffer.from('%PDF-1.4\n') });
  await withServer(app, async (base) => {
    const form = new FormData();
    form.set('session_id', 'cs_test_starter');
    form.set('documents', '["manual","pm_schedule"]');
    form.set('file', new Blob([L5X]), 'line.L5X');
    const res = await fetch(`${base}/jobs`, { method: 'POST', body: form });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.error, UPGRADE_MESSAGE);
    assert.match(body.error, /Upgrade/);
    assert.equal(paid.calls.updates.length, 0);

    const only = new FormData();
    only.set('session_id', 'cs_test_starter');
    only.set('documents', 'manual');
    only.set('file', new Blob([L5X]), 'line.L5X');
    const created = await fetch(`${base}/jobs`, { method: 'POST', body: only });
    assert.equal(created.status, 202);
    const done = await waitJob(base, (await created.json()).id);
    assert.equal(done.status, 'succeeded');
    assert.equal(done.documents.length, 1);
    assert.equal(done.documents[0].id, 'manual');
    assert.equal(paid.meta.manuals_used, '1');

    const legacy = await fetch(`${base}/generate-manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'cs_test_starter' },
      body: JSON.stringify({ plcContent: L5X.toString('utf8'), documents: ['shutdown'] }),
    });
    assert.equal(legacy.status, 400);
  });
});

test('pro generates each document in one run without another credit', { timeout: 180000, skip: findChrome() ? false : 'Chrome is not installed' }, async () => {
  const paid = stripeFor('pro');
  const app = createApp({ env: env(), stripe: paid.stripe, anthropic: anthropic() });
  try {
    await withServer(app, async (base) => {
      const form = new FormData();
      form.set('session_id', 'cs_test_pro');
      form.set('documents', JSON.stringify(['manual', 'pm_schedule', 'shutdown', 'startup']));
      form.set('requested_documents', 'alarm and troubleshooting guide\npoem about cats');
      form.set('product_name', 'Cell line');
      form.set('file', new Blob([SCL]), 'cell.scl');
      const created = await fetch(`${base}/jobs`, { method: 'POST', body: form });
      assert.equal(created.status, 202);
      const queued = await created.json();
      assert.equal(queued.documents.some((doc) => doc.status === 'skipped'), true);
      const done = await waitJob(base, queued.id);
      assert.equal(done.status, 'succeeded', done.error);
      assert.equal(paid.calls.updates.length, 0);
      const ready = done.documents.filter((doc) => doc.status === 'ready');
      assert.deepEqual(ready.map((doc) => doc.id), ['manual', 'pm_schedule', 'shutdown', 'startup', 'custom_1']);
      assert.equal(done.documents.some((doc) => doc.status === 'skipped' && /poem about cats/.test(doc.reason)), true);
      assert.ok(done.downloads.combined_pdf);
      assert.ok(done.downloads.zip);
      for (const doc of ready) {
        const pdf = await fetch(`${base}${doc.download_url}`);
        assert.equal(pdf.status, 200, doc.id);
        assert.match(pdf.headers.get('content-type'), /pdf/);
        const bytes = Buffer.from(await pdf.arrayBuffer());
        assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
        assert.ok(bytes.length > 2000, doc.id);
      }
      const combined = await fetch(`${base}${done.downloads.combined_pdf}`);
      const combinedBytes = Buffer.from(await combined.arrayBuffer());
      assert.equal(combinedBytes.subarray(0, 4).toString(), '%PDF');
      const zipRes = await fetch(`${base}${done.downloads.zip}`);
      assert.match(zipRes.headers.get('content-type'), /zip/);
      const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
      const names = zip.getEntries().map((entry) => entry.entryName).sort();
      assert.ok(names.some((name) => /preventive-maintenance-schedule/.test(name)));
      assert.ok(names.some((name) => /shutdown-procedure/.test(name)));
      assert.ok(names.some((name) => /startup-procedure/.test(name)));
      assert.ok(names.includes('all-documents.pdf'));
      const manual = await fetch(`${base}/jobs/${done.id}/pdf`);
      assert.equal(manual.status, 200);
    });
  } finally {
    await closeBrowser();
  }
});

test('expired jobs delete every document pdf and the zip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-docs-'));
  let now = Date.UTC(2026, 6, 1);
  const store = createJobStore({
    env: { NODE_ENV: 'production', MANUALOS_JOB_TTL_MS: String(DAY_MS) },
    now: () => now,
    directory: dir,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  });
  try {
    const job = store.create();
    store.saveArtifact(job.id, 'manual', Buffer.from('%PDF-1.4'));
    store.saveArtifact(job.id, 'pm_schedule', Buffer.from('%PDF-1.4'));
    store.saveArtifact(job.id, 'combined', Buffer.from('%PDF-1.4'));
    store.saveArtifact(job.id, 'zip', Buffer.from('PK'));
    const agedZip = path.join(dir, 'old-pack.zip');
    fs.writeFileSync(agedZip, 'PK');
    const youngZip = path.join(dir, 'young-pack.zip');
    fs.writeFileSync(youngZip, 'PK');
    fs.utimesSync(agedZip, new Date(now - DAY_MS - 5000), new Date(now - DAY_MS - 5000));
    const clock = {
      time: now,
      advance(ms) { now += ms; },
    };
    clock.advance(DAY_MS);
    assert.equal(store.get(job.id), null);
    assert.equal(fs.existsSync(path.join(dir, `${job.id}.pdf`)), false);
    assert.equal(fs.existsSync(path.join(dir, `${job.id}--pm_schedule.pdf`)), false);
    assert.equal(fs.existsSync(path.join(dir, `${job.id}--combined.pdf`)), false);
    assert.equal(fs.existsSync(path.join(dir, `${job.id}.zip`)), false);
    assert.equal(CLEANUP_INTERVAL_MS, 10 * 60 * 1000);
    store.sweepStartup();
    assert.equal(fs.existsSync(agedZip), false);
    assert.equal(fs.existsSync(youngZip), true);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
