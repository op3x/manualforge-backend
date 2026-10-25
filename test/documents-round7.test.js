const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUploads } = require('../lib/parsers');
const { renderHtml } = require('../lib/manual/html');
const { buildDocument, alarmRows } = require('../lib/manual/assemble');
const { buildPmSchedule, buildShutdown, buildStartup, buildCustomDocument } = require('../lib/documents/content');
const { fitHeaderLeft } = require('../lib/documents/stamp');
const { markDeliveredManual } = require('../lib/delivery-hook');
const { emptyProject, addRoutine } = require('../lib/project');

const CELL = path.join(__dirname, 'fixtures/cell.scl');
const COOKER = path.join(__dirname, 'fixtures/corpus/plc/brewery_Cooker_1_AutoLogic_Program.L5X');
const ACD = path.join(__dirname, 'fixtures/corpus/plc/acd_CuteLogix.ACD');
const VALVE = path.join(__dirname, 'fixtures/formats/tia_LAD_Valve.xml');
const STEP = '/cursor/stores/bot/manualos-test-corpus/cad/freecadlib_NEMA23_stepper.step';
const LEAK = 'Make sure the stop button is not pressed. To return the lift to its home position, press the home request while the emergency stop is healthy.';

function htmlOf(doc) {
  return renderHtml(doc);
}

function plain(doc) {
  return htmlOf(doc).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

async function load(file, name) {
  return parseUploads([{ originalname: name, buffer: fs.readFileSync(file) }], {}, { NODE_ENV: 'test' });
}

function custom(project, kind, title) {
  return buildCustomDocument(project, { id: 'custom_1', title, kind, customKind: kind }, {});
}

function troubleCells(project) {
  const html = htmlOf(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!body) return [];
  return [...body[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => (
    [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
  ));
}

function causeKey(cause) {
  const key = String(cause || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key || key.length < 40) return '';
  if (/^see the condition named/.test(key)) return '';
  if (/^the condition that raised the alarm is still true/.test(key)) return '';
  return key;
}

test('scl shutdown classifies the home request as startup and omits it', async () => {
  const cell = await load(CELL, 'cell.scl');
  const untouched = plain(buildShutdown(cell, {}));
  assert.equal(untouched.includes('press the home request while the emergency stop is healthy'), false);
  assert.equal(/stop button is not pressed/i.test(untouched), false);

  const routine = cell.routines.find((item) => (item.units || []).some((unit) => /HomeRequest/.test(unit.text || '')));
  assert.ok(routine);
  routine.analysis = {
    operatorSteps: [
      { action: LEAK },
      { action: 'Press the stop button to stop the cycle.' },
      { action: 'Stop the agitator, or let a shutdown occur.' },
    ],
  };
  const shutdown = plain(buildShutdown(cell, {}));
  assert.equal(shutdown.includes('press the home request while the emergency stop is healthy'), false);
  assert.equal(/stop button is not pressed/i.test(shutdown), false);
  assert.equal(/return the lift to its home position/i.test(shutdown), false);
  assert.equal((shutdown.match(/Press the stop button to stop the cycle/g) || []).length, 1);
  assert.match(shutdown, /Stop the agitator/);
  assert.equal(/let a shutdown occur/i.test(shutdown), false);

  routine.analysis = { operatorSteps: [{ action: LEAK }] };
  const dropped = plain(buildShutdown(cell, {}));
  assert.equal(dropped.includes('press the home request'), false);
  assert.equal(/stop button is not pressed/i.test(dropped), false);
});

test('cooker guide alarm codes use the manual message for that code', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const manual = alarmRows(cooker);
  const byCode = new Map(manual.map((row) => [row[0], row[1]]));
  assert.ok(byCode.has('ALM-4'), [...byCode.keys()].join(' '));
  const rows = troubleCells(cooker);
  const seen = new Map();
  const causes = new Map();
  for (const cells of rows) {
    const code = cells[0] || '';
    if (!/^ALM-\d+$/.test(code)) continue;
    assert.equal(cells[1], byCode.get(code), `${code} was labeled with another alarm's text`);
    assert.equal(seen.has(code), false, code);
    seen.set(code, cells[1]);
    const key = causeKey(cells[2]);
    if (!key) continue;
    assert.equal(causes.has(key), false, cells[2]);
    causes.set(key, code);
  }
  for (const [code, message] of byCode) {
    assert.equal(seen.get(code), message, `${code} ${message}`);
  }
  const joined = rows.map((cells) => cells.join(' ')).join('\n');
  assert.equal(/high high process alarm/i.test(joined), false);
  assert.equal(/low low process alarm/i.test(joined), false);

  const swapped = emptyProject();
  addRoutine(swapped, {
    name: 'Main',
    units: [],
    analysis: {
      alarms: [
        { text: 'Equipment high-high (process value)', cause: 'The process value is above the high-high limit.', remedy: 'Lower the process value.' },
        { text: 'Operator panel high', cause: 'The panel alarm is still true.', remedy: 'Clear the panel alarm.' },
        { text: 'Steam valve high', cause: 'The steam valve alarm is still true.', remedy: 'Close the steam valve.' },
        { text: 'Equipment low-low', cause: 'The vessel is below the low-low limit for this product.', remedy: 'Fill the vessel.' },
        { text: 'Equipment level high-high', cause: 'Level instrument alarm conditions remain true after the fill stops.', remedy: 'Stop the fill and drain to the normal band.' },
      ],
    },
  });
  swapped.alarms = [
    { text: 'Level instrument alarm conditions remain true after the fill stops.', cause: 'Level instrument alarm conditions remain true after the fill stops.', remedy: 'Stop the fill and drain to the normal band.' },
  ];
  const swappedManual = new Map(alarmRows(swapped).map((row) => [row[0], row[1]]));
  const coded = troubleCells(swapped).filter((cells) => /^ALM-\d+$/.test(cells[0]));
  for (const cells of coded) assert.equal(cells[1], swappedManual.get(cells[0]), cells[0]);
  assert.match(swappedManual.get('ALM-1'), /Equipment high-high/i);
  assert.equal(/level high-high/i.test(swappedManual.get('ALM-1')), false);
  assert.equal(swappedManual.get('ALM-4'), 'Equipment low-low');
  assert.equal(coded.filter((cells) => /level instrument alarm conditions/i.test(cells[1])).length, 0);
  assert.equal(coded.find((cells) => cells[1] === swappedManual.get('ALM-5'))[0], 'ALM-5');
});

test('a routine that declares no alarms does not invent an alarm code', async () => {
  const project = emptyProject();
  addRoutine(project, {
    name: 'Main',
    units: [],
    analysis: {
      alarms: [{ text: 'No alarms are defined for this routine', cause: 'Not applicable', remedy: 'Not applicable' }],
      groups: [],
      housekeeping: [],
    },
  });
  const manual = plain(buildDocument(project));
  const guide = plain(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(manual, /No alarms are defined for this equipment/);
  assert.match(guide, /No alarms are defined for this equipment/);
  assert.equal(/ALM-\d/.test(manual), false);
  assert.equal(/ALM-\d/.test(guide), false);
  assert.equal(/Not applicable/.test(`${manual} ${guide}`), false);
});

test('a CAD upload with no controller does not get controller maintenance', { skip: fs.existsSync(STEP) ? false : 'private CAD corpus is not in this checkout' }, async () => {
  const step = await load(STEP, 'NEMA23.step');
  const schedule = plain(buildPmSchedule(step, {}));
  assert.match(schedule, /stepper motor/i);
  assert.equal(/Back up the controller program/.test(schedule), false);
  assert.equal(/controller battery/.test(schedule), false);
  assert.equal(/cabinet fan/.test(schedule), false);
  assert.equal(/Test the emergency stop/.test(schedule), false);
  assert.equal(/\bbelts?\b/i.test(schedule), false);
  assert.equal(/\bcouplings?\b/i.test(schedule), false);
  const shutdown = plain(buildShutdown(step, {}));
  assert.match(shutdown, /uploaded files/);
  assert.equal(/uploaded program/.test(shutdown), false);
  const guide = plain(custom(step, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.equal(/does not go to run/i.test(guide), false);
  assert.equal(/\bcouplings?\b/i.test(guide), false);
  assert.match(guide, /stalls or loses steps/i);
});

test('cooker documents do not invent a guard, a relief valve, or a steam trap', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const pm = plain(buildPmSchedule(cooker, {}));
  const shutdown = plain(buildShutdown(cooker, {}));
  const startup = plain(buildStartup(cooker, {}));
  for (const text of [pm, shutdown, startup]) {
    assert.equal(/\bguards?\b/i.test(text), false);
    assert.equal(/gate switch/i.test(text), false);
    assert.equal(/close the guard/i.test(text), false);
  }
  assert.match(pm, /steam traps, if fitted/i);
  assert.match(pm, /steam safety relief valve, if fitted/i);
  assert.match(pm, /Inferred/);
  const guide = plain(custom(cooker, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.equal(/\bguards?\b/i.test(guide), false);
});

test('tia and acd troubleshooting lead with their logic', async () => {
  const valve = await load(VALVE, 'tia_LAD_Valve.xml');
  const valveRows = troubleCells(valve).map((cells) => cells[1]);
  assert.ok(valveRows.some((row) => /pneumatic valve actuator will not open/i.test(row)));
  assert.ok(valveRows.some((row) => /did not leave the closed position/i.test(row)));
  const genericAt = valveRows.findIndex((row) => /does not go to run|stays on after a stop|does not run as commanded/i.test(row));
  assert.ok(genericAt === -1 || genericAt === valveRows.length - 1);

  const acd = await load(ACD, 'CuteLogix.ACD');
  const acdText = troubleCells(acd).map((cells) => cells.join(' ')).join('\n');
  assert.match(acdText, /ALM-1/);
  assert.match(acdText, /ALM-2/);
  assert.match(acdText, /fault counter does not reach its preset/i);
  assert.match(acdText, /first out fault does not update/i);
  assert.equal(/No alarms are defined/i.test(acdText), false);
  assert.equal(/does not go to run|stays on after a stop|does not run as commanded/i.test(acdText), false);
});

test('a one-chapter schedule has no contents page and quarterly rows are inferred', async () => {
  const cell = await load(CELL, 'cell.scl');
  const pm = htmlOf(buildPmSchedule(cell, {}));
  assert.equal(/class="toc"/.test(pm), false);
  assert.match(pm, /Quarterly <span class="inf">Inferred<\/span>/);
  assert.match(htmlOf(buildShutdown(cell, {})), /class="toc"/);
  const css = fs.readFileSync(path.join(__dirname, '../template/style.css'), 'utf8');
  assert.match(css, /table\.signoff td:first-child \.inf \{[^}]*display:\s*block/);
});

test('extra-document headers use the long-header limit', () => {
  assert.equal(fitHeaderLeft('Acme · Cell · Shutdown Procedure'), 'Acme · Cell · Shutdown Procedure');
  const fitted = fitHeaderLeft(`${'North Line Controls '.repeat(12)} · Cell · Shutdown Procedure`);
  assert.match(fitted, /\u2026$/);
  assert.ok(fitted.length <= 110);
  const doc = buildShutdown(emptyProject(), { branding: { whiteLabel: true, companyName: 'Very Long Integrator Name '.repeat(8) } });
  assert.match(doc.meta.headerLeft, /\u2026$/);
  assert.ok(doc.meta.headerLeft.length <= 110);
});

test('the extras job marks the manual delivered and keeps branding with the selection', async () => {
  assert.equal(await markDeliveredManual({}, { plan: 'pro' }, 'sess'), null);
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /respond\(access, files, credit, project, selection, branding\)/);
  assert.match(source, /branding: branding \|\| resolveDocumentBranding\(access\)/);
  assert.match(source, /selection,/);
  assert.match(source, /await markDeliveredManual\(stripeClient, access, readSessionId\(req\)\)/);
});
