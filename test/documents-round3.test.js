const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUploads } = require('../lib/parsers');
const { renderHtml } = require('../lib/manual/html');
const { inspectEquipment, controlPoints, energyTable } = require('../lib/documents/equipment');
const { buildPmSchedule, buildShutdown, buildStartup, buildCustomDocument, TROUBLE_SKIP, PARTS_SKIP } = require('../lib/documents/content');
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
  return buildCustomDocument(project, {
    id: 'custom_1',
    title,
    kind,
    customKind: kind,
  }, {});
}

test('reset candidates exclude counters, and a data tag is not a start button', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const points = controlPoints(cooker);
  assert.equal(points.resets.some((label) => /\b(counts?|counters?|totalizers?)\b/i.test(label)), false);
  assert.equal(points.resets.some((label) => /cook count/i.test(label)), false);
  assert.equal(points.starts.some((label) => /cook count/i.test(label)), false);

  const ranked = emptyProject();
  upsertTag(ranked, { name: 'CountPB', description: 'Reset cook count pushbutton', dataType: 'BOOL' });
  upsertTag(ranked, { name: 'LineReset', description: 'Line reset', dataType: 'BOOL' });
  assert.deepEqual(controlPoints(ranked).resets, ['Line reset']);

  const acd = await load(ACD, 'CuteLogix.ACD');
  assert.equal(controlPoints(acd).starts.some((label) => /ascii/i.test(label)), false);

  const typed = emptyProject();
  upsertTag(typed, { name: 'ASCII_Start', description: '', dataType: 'DINT' });
  upsertTag(typed, { name: 'Start_PB', description: 'Start pushbutton', dataType: 'BOOL', direction: 'Input' });
  assert.deepEqual(controlPoints(typed).starts, ['Start pushbutton']);
});

test('a plain valve is a device class and drives maintenance and lockout energy', async () => {
  const described = emptyProject();
  upsertTag(described, { name: 'XV1', description: 'Valve' });
  const describedEquipment = inspectEquipment(described);
  assert.equal(describedEquipment.classes.valve.present, true);
  assert.ok(describedEquipment.classes.valve.labels.some((label) => /^valve$/i.test(label)));
  assert.ok(energyTable(described).map((row) => row[0]).includes('Controlled line'));

  const plainValve = emptyProject();
  plainValve.identity.productName = 'Fill head';
  addRoutine(plainValve, {
    name: 'Valve',
    units: [{ index: 0, number: 0, comment: 'Open the valve.', text: '' }],
  });
  const equipment = inspectEquipment(plainValve);
  assert.equal(equipment.classes.valve.present, true);
  assert.equal(equipment.classes.pneumatic.present, false);
  assert.equal(equipment.classes.hydraulic.present, false);
  assert.equal(equipment.classes.process.present, false);
  const names = energyTable(plainValve).map((row) => row[0]);
  assert.ok(names.includes('Controlled line'));
  const schedule = plain(buildPmSchedule(plainValve, {}));
  assert.match(schedule, /opens on command/i);

  const titled = await load(VALVE, 'tia_LAD_Valve.xml');
  const titledEquipment = inspectEquipment(titled);
  assert.equal(titledEquipment.classes.valve.present, true);
  assert.equal(titledEquipment.classes.pneumatic.present, true);
  assert.ok(energyTable(titled).map((row) => row[0]).includes('Pneumatic'));
  assert.match(plain(buildPmSchedule(titled, {})), /opens on command/i);
});

test('shutdown does not repeat a startup sentence or the control-logic line', async () => {
  const project = emptyProject();
  addRoutine(project, {
    name: 'Main',
    units: [],
    analysis: {
      purpose: 'The equipment starts when the operator presses start.',
      operatorSteps: [
        { action: 'From the control logic: Press the stop button to stop the cycle.' },
        { action: 'Press the stop button to stop the cycle.' },
        { action: 'The equipment starts after the start button is pressed.' },
      ],
    },
  });
  const shutdown = plain(buildShutdown(project, {}));
  assert.equal((shutdown.match(/From the control logic/g) || []).length, 0);
  assert.equal((shutdown.match(/Press the stop button to stop the cycle/g) || []).length, 1);
  assert.equal(/equipment starts/i.test(shutdown), false);

  const acd = await load(ACD, 'CuteLogix.ACD');
  const schedule = plain(buildPmSchedule(acd, {}));
  assert.match(schedule, /did not identify a motor, valve, sensor, or other maintainable device/i);
  assert.match(schedule, /Test the emergency stop/i);
  assert.match(schedule, /Back up the controller program/i);
  assert.match(schedule, /cabinet fan, if one is fitted/i);
  assert.match(schedule, /controller battery/i);
  assert.equal(/did not identify maintainable devices/i.test(schedule), false);
  assert.equal(/qualified electrician/i.test(schedule), false);
  assert.equal(/cabinet connections/i.test(schedule), false);
  acd.routines[0].analysis = {
    purpose: 'The equipment starts when power returns.',
    operatorSteps: [
      { action: 'From the control logic: Stop the cycle with the stop control.' },
      { action: 'Stop the cycle with the stop control.' },
      { action: 'The equipment starts when the start command is given.' },
    ],
  };
  const acdShutdown = plain(buildShutdown(acd, {}));
  assert.equal((acdShutdown.match(/From the control logic/g) || []).length, 0);
  assert.equal(/starts when power returns/i.test(acdShutdown), false);
  assert.equal(/starts when the start command/i.test(acdShutdown), false);
});

test('maintenance wording follows the device, the interval, and steam', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const cookerPm = plain(buildPmSchedule(cooker, {}));
  assert.equal(/cooker gate switch/i.test(cookerPm), false);
  assert.equal(/while it is open/i.test(cookerPm), false);
  assert.equal(/\bguards?\b/i.test(cookerPm), false);
  assert.equal(/Releasing an emergency stop/.test(cookerPm), false);
  assert.match(cookerPm, /steam supply in service/i);
  assert.equal(/while the steam supply can be open/i.test(cookerPm), false);
  assert.equal(/not repeated at 500 operating hours/.test(cookerPm), false);
  assert.match(cookerPm, /steam traps, if fitted/i);
  assert.match(cookerPm, /steam safety relief valve, if fitted/i);
  assert.match(cookerPm, /does not state a set pressure/i);
  assert.equal(/\d+\s*psi\b/i.test(cookerPm), false);

  const cell = await load(CELL, 'cell.scl');
  const cellPm = plain(buildPmSchedule(cell, {}));
  assert.match(cellPm, /not repeated at 500 operating hours/);
  assert.match(cellPm, /Inspect hoses and fittings/i);
  assert.equal(/1000 operating hours/.test(cellPm), false);
  assert.equal(/steam safety relief valve/i.test(cellPm), false);
  assert.match(cellPm, /emergency stop circuit/i);

  const motorOnly = emptyProject();
  upsertTag(motorOnly, { name: 'M1', description: 'Conveyor motor' });
  assert.equal(/not repeated at 500 operating hours/.test(plain(buildPmSchedule(motorOnly, {}))), false);

  const probeOnly = emptyProject();
  upsertTag(probeOnly, { name: 'TT1', description: 'Vessel temperature probe' });
  assert.equal(/steam safety relief valve/i.test(plain(buildPmSchedule(probeOnly, {}))), false);
});

test('a normal stop states a result, then lock removal returns the equipment to service', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const shutdown = plain(buildShutdown(cooker, {}));
  assert.equal(/Leave the guard closed/.test(shutdown), false);
  assert.equal(/guarded space/.test(shutdown), false);
  assert.equal(/\bguards?\b/i.test(shutdown), false);
  assert.match(shutdown, /remove only the lock and tag you applied/);
  assert.match(shutdown, /return the equipment to service with the startup procedure/);
  const stillAt = shutdown.search(/moving material are still/);
  const restoreAt = shutdown.search(/remove only the lock and tag you applied/);
  assert.ok(stillAt > 0 && restoreAt > stillAt);

  const cell = await load(CELL, 'cell.scl');
  const cellShutdown = plain(buildShutdown(cell, {}));
  assert.match(cellShutdown, /Leave the guard door closed until motion has stopped/);
  assert.match(cellShutdown, /People stay outside the guarded space until motion has finished/);
  const actionAt = cellShutdown.search(/Leave the guard door closed until motion has stopped/);
  const resultAt = cellShutdown.search(/People stay outside the guarded space until motion has finished/);
  const cellRestore = cellShutdown.search(/remove only the lock and tag you applied/);
  assert.ok(actionAt > 0 && resultAt > actionAt && cellRestore > resultAt);
});

test('cooker startup drains condensate before steam and does not invent homing', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const html = htmlOf(buildStartup(cooker, {}));
  const titles = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => match[1].replace(/<[^>]+>/g, ''));
  assert.equal(titles.some((title) => /Homing/i.test(title)), false);
  assert.equal(/Motion matches the devices found in the upload/.test(html), false);
  const text = plain(buildStartup(cooker, {}));
  assert.match(text, /Crack the steam valve to warm the line, then open fully/);
  assert.match(text, /The line is warm and the valve is open/);
  assert.match(text, /does not state a pressure or a temperature/);
  assert.equal(/Drain condensate from the steam line/.test(text), false);
  assert.equal(/Open the steam supply only after that warm-up/.test(text), false);
  assert.equal(/Homing/.test(text), false);
  assert.equal(/homing/i.test(text), false);

  const cell = await load(CELL, 'cell.scl');
  const cellText = plain(buildStartup(cell, {}));
  assert.match(cellText, /Homing and reset/);
  assert.match(cellText, /Request homing/);
});

test('troubleshooting follows detected energy and drops generic duplicates', async () => {
  const cell = await load(CELL, 'cell.scl');
  const cellGuide = plain(custom(cell, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  const introAt = cellGuide.search(/Correct the cause/);
  const intro = cellGuide.slice(introAt, introAt + 320);
  assert.match(intro, /compressed air/i);
  assert.match(intro, /hydraulic pressure/i);
  assert.equal(/steam|hot fluid/i.test(intro), false);

  const generic = emptyProject();
  generic.alarms = [
    { text: 'Device or signal fault detected.' },
    { text: 'Module Communication Offline' },
    { text: 'Module Communication Offline on the conveyor motor' },
  ];
  upsertTag(generic, { name: 'M1', description: 'Conveyor motor' });
  const genericGuide = plain(custom(generic, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.equal(/Device or signal fault detected/.test(genericGuide), false);
  assert.equal((genericGuide.match(/Module Communication Offline/g) || []).length, 1);
  assert.match(genericGuide, /conveyor motor/i);

  const cooker = await load(COOKER, 'cooker.L5X');
  const cookerGuide = plain(custom(cooker, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(cookerGuide, /Fermenter level is high/);
  assert.equal(/Fermenter High level is high/.test(cookerGuide), false);
  assert.equal((cookerGuide.match(/Mash Water To Cooker/gi) || []).length, 1);
});

test('spare parts list wear parts, US spelling, and specified fasteners', async () => {
  const project = emptyProject();
  upsertTag(project, { name: 'Steam1', description: 'Steam supply valve' });
  project.cad = {
    bom: [
      { description: 'Aluminium pin', partNumber: 'Aluminium pin', qty: 1 },
      { description: 'Fastener, solid body, part M2.5x25-Screw', partNumber: 'M2.5x25-Screw', qty: 4 },
      { description: 'Cooker Agitator', partNumber: 'Cooker Agitator', qty: 1 },
      { description: 'Emergency stop circuit', partNumber: 'ESTOP', qty: 1 },
      { description: 'Drop Tub Pump Suction Drain', partNumber: 'DRAIN', qty: 1 },
    ],
  };
  const parts = htmlOf(custom(project, 'parts', 'Spare Parts List'));
  assert.match(parts, /Aluminum pin/);
  assert.equal(/Aluminium/.test(parts), false);
  assert.match(parts, /M2\.5x25-Screw<\/td><td>Assembly<\/td><td>M2\.5x25<\/td>/);
  assert.match(parts, /Cooker Agitator: shaft seal/);
  assert.equal(/Emergency stop circuit/.test(parts), false);
  assert.equal(/Suction Drain/.test(parts), false);
  assert.match(parts, /shaft seal/i);
  assert.match(parts, /Steam trap, if fitted/);
  assert.match(parts, /Relief valve, if fitted/);
});

test('a rotor is not treated as the motor', { skip: fs.existsSync(STEP) ? false : 'private CAD corpus is not in this checkout' }, async () => {
  const step = await load(STEP, 'NEMA23.step');
  const equipment = inspectEquipment(step);
  assert.deepEqual(equipment.classes.motor.labels, ['Stepper motor']);
  assert.equal(equipment.classes.motor.labels.some((label) => /rotor/i.test(label)), false);
  const schedule = plain(buildPmSchedule(step, {}));
  assert.match(schedule, /stepper motor/i);
  assert.equal(/\brotor\b/i.test(schedule), false);

  const named = emptyProject();
  named.identity.productName = 'NEMA 23 stepper';
  named.cad = { bom: [{ description: 'Rotor', partNumber: 'Rotor001', qty: 1 }] };
  assert.deepEqual(inspectEquipment(named).classes.motor.labels, ['Stepper motor']);
  assert.equal(/\brotor\b/i.test(plain(buildPmSchedule(named, {}))), false);
});

test('troubleshooting and spare parts are still delivered when alarm text or part numbers are missing', async () => {
  assert.equal(typeof TROUBLE_SKIP, 'string');
  assert.equal(typeof PARTS_SKIP, 'string');
  const samples = [
    ['tia', await load(VALVE, 'tia_LAD_Valve.xml')],
    ['acd', await load(ACD, 'CuteLogix.ACD')],
  ];
  if (fs.existsSync(STEP)) samples.push(['step', await load(STEP, 'NEMA23.step')]);
  for (const [name, project] of samples) {
    const guide = custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide');
    const parts = custom(project, 'parts', 'Spare Parts List');
    assert.equal(guide.skipped, undefined, name);
    assert.equal(parts.skipped, undefined, name);
    const guideHtml = htmlOf(guide);
    const partsHtml = htmlOf(parts);
    assert.match(guideHtml, /What you see/);
    assert.match(partsHtml, /Parts in this upload/);
    assert.match(partsHtml, /Add part numbers/);
    if (name === 'acd') {
      assert.equal(/ALM-\d+/.test(guideHtml), false);
      assert.match(guideHtml, /did not include alarm text/i);
      assert.match(guideHtml, /fault counter does not reach its preset/i);
      assert.match(guideHtml, /first out fault does not update/i);
    } else if (name !== 'tia') assert.match(guideHtml, /did not include alarm text/i);
  }

  const empty = emptyProject();
  const guide = custom(empty, 'troubleshooting', 'Alarm and Troubleshooting Guide');
  const parts = custom(empty, 'parts', 'Spare Parts List');
  assert.equal(guide.skipped, undefined);
  assert.equal(parts.skipped, undefined);
  assert.match(plain(guide), /did not include alarm text/i);
  assert.equal(/does not run as commanded/i.test(plain(guide)), false);
  assert.equal(/does not go to run/i.test(plain(guide)), false);
  assert.match(plain(parts), /Add part numbers/);
  assert.match(plain(parts), /Controller: battery, if fitted/);
  assert.equal(/steam traps/i.test(plain(parts)), false);
  assert.equal(/did not name a wear part/i.test(plain(parts)), false);
});
