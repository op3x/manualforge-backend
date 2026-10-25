const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUploads } = require('../lib/parsers');
const { renderHtml } = require('../lib/manual/html');
const { buildDocument } = require('../lib/manual/assemble');
const { readablePartName } = require('../lib/presentation');
const { buildPmSchedule, buildShutdown, buildStartup, buildCustomDocument } = require('../lib/documents/content');
const { emptyProject, upsertTag, addRoutine } = require('../lib/project');

const COOKER = path.join(__dirname, 'fixtures/corpus/plc/brewery_Cooker_1_AutoLogic_Program.L5X');
const ACD = path.join(__dirname, 'fixtures/corpus/plc/acd_CuteLogix.ACD');
const CELL = path.join(__dirname, 'fixtures/cell.scl');
const VALVE = path.join(__dirname, 'fixtures/formats/tia_LAD_Valve.xml');
const STEP = '/cursor/stores/bot/manualos-test-corpus/cad/freecadlib_NEMA23_stepper.step';

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

function bodyRows(html) {
  const match = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  return match ? (match[1].match(/<tr>/g) || []).length : 0;
}

test('spare parts name the device and mark inferred parts', async () => {
  const cell = await load(CELL, 'cell.scl');
  const parts = htmlOf(custom(cell, 'parts', 'Spare Parts List'));
  assert.match(parts, /Hydraulic return filter: element/);
  assert.match(parts, /Hydraulic return filter<\/td>/);
  assert.match(parts, /Pneumatic cylinder valve: seal kit/);
  assert.match(parts, /Conveyor motor: bearings, if fitted/);
  assert.match(parts, /Hydraulic pump: mechanical seal/);
  assert.equal(/seal kit, if fitted/.test(parts), false);
  assert.equal(/element, if fitted/.test(parts), false);
  assert.equal(/steam trap/i.test(parts), false);
  assert.match(parts, /Used on/);

  const steam = emptyProject();
  upsertTag(steam, { name: 'Steam1', description: 'Steam supply valve' });
  const steamParts = htmlOf(custom(steam, 'parts', 'Spare Parts List'));
  assert.match(steamParts, /Steam trap, if fitted/);
  assert.match(steamParts, /Relief valve, if fitted/);
});

test('troubleshooting rows come from the interlocks in the logic', async () => {
  const cell = await load(CELL, 'cell.scl');
  const html = htmlOf(custom(cell, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  const text = plain(custom(cell, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.ok(bodyRows(html) >= 3, String(bodyRows(html)));
  assert.match(text, /pneumatic cylinder will not extend/i);
  assert.equal(/pneumatic cylinder valve will not extend/i.test(text), false);
  assert.match(text, /compressed air is off/i);
  assert.match(text, /part sensor is not made/i);

  const release = emptyProject();
  addRoutine(release, {
    name: 'Move',
    declarations: [
      { name: 'Release', dataType: 'BOOL', comment: 'Release' },
      { name: 'FeedValve', dataType: 'BOOL', comment: 'Feed valve' },
    ],
    units: [{ index: 0, text: 'IF Release THEN\n  FeedValve := TRUE;\nEND_IF;', comment: '' }],
  });
  const releasedHtml = htmlOf(custom(release, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  const released = plain(custom(release, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(released, /feed valve will not open/i);
  assert.match(released, /Release is not made/);
  assert.ok(bodyRows(releasedHtml) < 6, String(bodyRows(releasedHtml)));

  const valve = await load(VALVE, 'tia_LAD_Valve.xml');
  const valveGuide = plain(custom(valve, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(valveGuide, /pneumatic valve actuator will not open/i);
  assert.equal((valveGuide.match(/does not go to run|stays on after a stop|does not run as commanded/gi) || []).length <= 1, true);
});

test('controller maintenance and manual alarms fill a project with no field devices', async () => {
  const acd = await load(ACD, 'CuteLogix.ACD');
  const schedule = plain(buildPmSchedule(acd, {}));
  assert.match(schedule, /Test the emergency stop/);
  assert.match(schedule, /Back up the controller program/);
  assert.match(schedule, /cabinet fan, if one is fitted/);
  assert.match(schedule, /controller battery/);
  assert.equal(/The upload did not identify maintainable devices/.test(schedule), false);
  assert.equal(/steam trap/i.test(schedule), false);

  const guide = htmlOf(custom(acd, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(guide, /ALM-1/);
  assert.match(guide, /ALM-2/);
  assert.match(guide, /fault counter does not reach its preset/i);
  assert.match(guide, /first out fault does not update/i);
  assert.equal(/does not go to run/i.test(guide), false);
  assert.equal(/stays on after a stop/i.test(guide), false);
  assert.equal(/does not run as commanded/i.test(guide), false);
  assert.equal(/No alarms are defined/i.test(guide), false);
  assert.equal(/Not determinable/i.test(guide), false);

  const parts = plain(custom(acd, 'parts', 'Spare Parts List'));
  assert.match(parts, /Controller: battery, if fitted/);
  assert.equal(/steam trap/i.test(parts), false);

  const thin = emptyProject();
  thin.alarms = [{ text: 'Not determinable', cause: 'Not determinable', remedy: 'Not determinable' }];
  thin.subsystems = [
    { name: 'Axis vertical', purpose: 'Not determinable', components: ['Axis'] },
    { name: 'Lift axis', purpose: 'The lift axis raises the part.', components: ['Axis'] },
  ];
  const thinGuide = plain(custom(thin, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.equal(/Not determinable/i.test(thinGuide), false);
  assert.match(thinGuide, /Lift axis does not reach its position/);
  assert.equal(/Axis vertical does not reach/.test(thinGuide), false);
});

test('shutdown keeps stop sentences and drops startup sentences', () => {
  const project = emptyProject();
  addRoutine(project, {
    name: 'Main',
    units: [],
    analysis: {
      operatorSteps: [
        { action: 'From the control logic: Press the stop button to stop the cycle.' },
        { action: 'Press the stop button to stop the cycle.' },
        { action: 'Check the guards before initiating a run.' },
        { action: 'Close the guard.' },
        { action: 'The brake is released.' },
        { action: 'Observe the first cycle.' },
      ],
    },
  });
  const shutdown = plain(buildShutdown(project, {}));
  assert.equal((shutdown.match(/From the control logic/g) || []).length, 0);
  assert.equal((shutdown.match(/Press the stop button to stop the cycle/g) || []).length, 1);
  assert.equal(/before initiating a run/i.test(shutdown), false);
  assert.equal(/Close the guard/.test(shutdown), false);
  assert.equal(/\breleased\b/i.test(shutdown), false);
  assert.equal(/Observe the first cycle/.test(shutdown), false);
  assert.match(htmlOf(buildShutdown(project, {})), /<body class="flow">/);
});

test('generic alarm lines are dropped and manual alarm codes are kept', async () => {
  const project = emptyProject();
  upsertTag(project, { name: 'TT', description: 'Vessel temperature probe' });
  project.alarms = [
    { text: 'Process variable is out of range' },
    { text: 'The level is under the low low limit' },
    { text: 'Module is not communicating' },
    { text: 'Drive reported a fault' },
    { text: 'Unit alarm active' },
    { text: 'The steam valve did not move' },
  ];
  project.routines = [{
    name: 'Main',
    units: [],
    analysis: { alarms: [{ code: 'INLET', text: 'The inlet is blocked', cause: 'The inlet is blocked.', remedy: 'Clear the inlet.' }] },
  }];
  const guide = plain(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(guide, /steam valve did not move/i);
  assert.match(guide, /ALM-1/);
  assert.match(guide, /inlet is blocked/i);
  assert.equal(/process variable/i.test(guide), false);
  assert.equal(/low low limit/i.test(guide), false);
  assert.equal(/not communicating/i.test(guide), false);
  assert.equal(/reported a fault/i.test(guide), false);
  assert.equal(/alarm active/i.test(guide), false);
});

test('maintenance uses the valve, the cylinder, and the filter that were found', async () => {
  const close = emptyProject();
  upsertTag(close, { name: 'CV', description: 'Close valve' });
  const closePm = plain(buildPmSchedule(close, {}));
  assert.match(closePm, /confirm the valve opens on command/i);
  assert.equal(/the close valve/i.test(closePm), false);
  assert.equal(/\bclose valve\b/i.test(closePm), false);
  assert.equal(/scored rods/i.test(closePm), false);

  const named = emptyProject();
  upsertTag(named, { name: 'CV2', description: 'the close valve' });
  assert.equal(/the close valve/i.test(plain(buildPmSchedule(named, {}))), false);

  const cell = await load(CELL, 'cell.scl');
  const cellPm = plain(buildPmSchedule(cell, {}));
  assert.match(cellPm, /hydraulic return filter/i);
  assert.match(cellPm, /scored rods/i);
  assert.equal(/air-preparation/i.test(cellPm), false);
  assert.equal(/air-supply filter/i.test(cellPm), false);

  const valve = await load(VALVE, 'tia_LAD_Valve.xml');
  assert.equal(/scored rods/i.test(plain(buildPmSchedule(valve, {}))), false);
});

test('startup names the real controls and cracks the steam valve', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const text = plain(buildStartup(cooker, {}));
  assert.match(text, /Crack the steam valve to warm the line, then open fully/);
  assert.match(text, /Cooker 1 Sequence master reset/);
  assert.match(text, /Cooker2 Sequence master reset/);
  assert.match(text, /Cooker #1 Steaming Start PB/);
  assert.match(text, /Cooker #2 Steaming Start PB/);
  assert.equal(/\bstart pushbutton\b/i.test(text), false);
  assert.equal(/\bhoming\b/i.test(text), false);
  const introAt = text.search(/checks, power/);
  assert.match(text.slice(introAt, introAt + 80), /checks, power, reset, then one watched cycle/);

  const cell = await load(CELL, 'cell.scl');
  const cellText = plain(buildStartup(cell, {}));
  assert.match(cellText, /reset or homing/);
  assert.match(cellText, /Operator start button/);
  assert.match(cellText, /Fault reset button/);

  const probe = emptyProject();
  upsertTag(probe, { name: 'TT1', description: 'Vessel temperature probe' });
  assert.equal(/crack the steam valve/i.test(plain(buildStartup(probe, {}))), false);
});

test('list grammar, shared procedure pages, and one aluminum spelling', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const guide = plain(custom(cooker, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  const introAt = guide.search(/Correct the cause/);
  const intro = guide.slice(introAt, introAt + 360);
  assert.match(intro, /steam or heat and hot fluid/);
  assert.equal(/steam or heat, hot fluid/.test(intro), false);

  const cell = await load(CELL, 'cell.scl');
  assert.match(htmlOf(buildStartup(cell, {})), /<body class="flow">/);
  assert.match(htmlOf(buildShutdown(cell, {})), /<body class="flow">/);
  assert.equal(/<body class="flow">/.test(htmlOf(buildPmSchedule(cell, {}))), false);
  assert.equal(/<body class="flow">/.test(renderHtml(buildDocument(emptyProject()))), false);
  const css = fs.readFileSync(path.join(__dirname, '../template/style.css'), 'utf8');
  assert.match(css, /body\.flow \.chapter \{[^}]*page-break-before:\s*auto/);

  assert.equal(readablePartName('Aluminium rear001'), 'Aluminum rear');
  assert.equal(readablePartName('Body001'), 'Body');
  assert.equal(readablePartName('Aluminum front001'), 'Aluminum front');
  assert.equal(/Aluminium/.test(readablePartName('Aluminium rear001')), false);

  if (!fs.existsSync(STEP)) return;
  const step = await load(STEP, 'NEMA23.step');
  const manual = renderHtml(buildDocument(step));
  assert.match(manual, /Aluminum/);
  assert.equal(/Aluminium/.test(manual), false);
  assert.equal(/Body001/.test(manual), false);
  assert.equal(/rear001/i.test(manual), false);
});
