const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUploads } = require('../lib/parsers');
const { renderHtml } = require('../lib/manual/html');
const { alarmRows } = require('../lib/manual/assemble');
const { buildPmSchedule, buildShutdown, buildStartup, buildCustomDocument } = require('../lib/documents/content');
const { inspectEquipment, energyTable } = require('../lib/documents/equipment');
const { emptyProject, upsertTag, addRoutine } = require('../lib/project');

const CELL = path.join(__dirname, 'fixtures/cell.scl');
const VALVE = path.join(__dirname, 'fixtures/formats/tia_LAD_Valve.xml');
const COOKER = path.join(__dirname, 'fixtures/corpus/plc/brewery_Cooker_1_AutoLogic_Program.L5X');
const ACD = path.join(__dirname, 'fixtures/corpus/plc/acd_CuteLogix.ACD');

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

function tableRows(html) {
  const body = (html.match(/<tbody>([\s\S]*?)<\/tbody>/g) || []).pop() || '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => match[1].replace(/<[^>]+>/g, ' | ').replace(/\s+/g, ' ').trim());
}

test('cad troubleshooting uses the parts and skips controller rows', () => {
  const project = emptyProject();
  project.sources.push({ name: 'motor.step', format: 'step', sha256: 'abc', bytes: 10 });
  project.cad.bom = [
    { description: 'Stepper motor', partNumber: 'Stepper-motor', qty: 1 },
    { description: 'Fastener, solid body, part M2.5x25-Screw', partNumber: 'M2.5x25-Screw', qty: 4 },
  ];
  project.identity.productName = 'Stepper motor';
  const guide = htmlOf(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  const text = plain(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(text, /stalls or loses steps/i);
  assert.match(text, /bearing is worn/i);
  assert.match(text, /M2\.5x25/);
  assert.match(text, /connector is loose or open/i);
  assert.equal(/does not go to run/i.test(guide), false);
  assert.equal(/does not match the backup/i.test(guide), false);
  assert.equal(/program on the machine/i.test(guide), false);
});

test('logic troubleshooting follows interlocks instead of a generic controller row', async () => {
  const cell = await load(CELL, 'cell.scl');
  const text = plain(custom(cell, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(text, /conveyor motor will not start/i);
  assert.match(text, /guard is open/i);
  assert.match(text, /stop is held/i);
  assert.match(text, /lift will not home/i);
  assert.match(text, /homing request is not made/i);
  assert.match(text, /emergency stop is not healthy/i);
  assert.match(text, /pneumatic cylinder will not extend/i);
  assert.equal(/pneumatic cylinder valve will not extend/i.test(text), false);

  const valve = emptyProject();
  addRoutine(valve, {
    name: 'Valve',
    declarations: [
      { name: 'Release', dataType: 'BOOL', comment: 'Release' },
      { name: 'Output', dataType: 'BOOL', comment: 'Output valve' },
    ],
    units: [{ index: 0, text: 'IF Release THEN\n  Output := TRUE;\nEND_IF;', comment: '' }],
  });
  upsertTag(valve, { name: 'StateValve', description: 'State Valve', scope: 'Valve' });
  upsertTag(valve, { name: 'OpenValve', description: 'Open Valve', scope: 'Valve' });
  upsertTag(valve, { name: 'CloseValve', description: 'Close Valve', scope: 'Valve' });
  upsertTag(valve, { name: 'Output', description: 'Output valve', scope: 'Valve' });
  const equipment = inspectEquipment(valve);
  assert.deepEqual(equipment.classes.valve.labels, ['Valve']);
  const trouble = plain(custom(valve, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(trouble, /The valve will not open/i);
  assert.match(trouble, /Release is not made/);
  assert.equal(/state valve/i.test(trouble), false);
  assert.equal(/output valve/i.test(trouble), false);
  const parts = tableRows(htmlOf(custom(valve, 'parts', 'Spare Parts List')));
  const seals = parts.filter((row) => /seal kit/i.test(row));
  assert.equal(seals.length, 1);
  assert.match(seals[0], /Valve: seal kit/);
});

test('cooker alarms keep manual codes and drop generic process rows', () => {
  const project = emptyProject();
  const messages = [
    'Cooker 1 temperature high-high',
    'Steam valve did not move',
    'Guard is open',
    'Pump did not start',
    'Filter is loaded',
    'Brake did not hold',
    'Agitator shaft did not turn',
    'Conveyor belt did not move',
    'Tank 2 level high-high',
  ];
  addRoutine(project, {
    name: 'Main',
    units: [],
    analysis: { alarms: messages.map((text) => ({ text })), groups: [] },
  });
  project.alarms = [
    { text: 'High High process alarm' },
    { text: 'Low Low process alarm' },
    { text: 'Tank 2 level has reached the high-high limit' },
    { text: 'Cooker 1 temperature high-high' },
  ];
  const manual = alarmRows(project);
  assert.equal(manual[0][0], 'ALM-1');
  assert.match(manual[0][1], /Cooker 1 temperature high-high/);
  assert.equal(manual[8][0], 'ALM-9');
  assert.match(manual[8][1], /Tank 2 level high-high/);
  const rows = tableRows(htmlOf(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide')));
  const joined = rows.join('\n');
  assert.equal(/high high process alarm/i.test(joined), false);
  assert.equal(/low low process alarm/i.test(joined), false);
  const reached = rows.find((row) => /tank 2 level/i.test(row) && /high-high/i.test(row));
  assert.ok(reached, joined);
  assert.match(reached, /ALM-9/);
  const cooker = rows.find((row) => /Cooker 1 temperature high-high/.test(row));
  assert.ok(cooker, joined);
  assert.match(cooker, /ALM-1/);
  assert.equal(rows.filter((row) => /high-high/i.test(row)).length, 2);
});

test('spare parts cover each device class that was found', async () => {
  const cell = await load(CELL, 'cell.scl');
  const parts = plain(custom(cell, 'parts', 'Spare Parts List'));
  assert.match(parts, /Vertical lift brake: friction pad/);
  assert.match(parts, /Part present sensor: spare/);
  assert.match(parts, /Gearbox: lubricant or seal/);
  assert.match(parts, /Emergency stop: contact block/);
  assert.match(parts, /Hydraulic pump: mechanical seal/);
  assert.match(parts, /Pneumatic cylinder valve: seal kit/);

  const acd = await load(ACD, 'CuteLogix.ACD');
  const acdParts = plain(custom(acd, 'parts', 'Spare Parts List'));
  assert.match(acdParts, /Controller: battery, if fitted/);
  assert.match(acdParts, /Cabinet fan filter, if fitted/);
  assert.match(acdParts, /Emergency stop: contact block/);
  assert.equal(/steam trap/i.test(acdParts), false);
});

test('shutdown drops startup sentences and stored energy follows the equipment', async () => {
  const project = emptyProject();
  addRoutine(project, {
    name: 'Main',
    units: [],
    analysis: {
      operatorSteps: [
        { action: 'Press the stop button to stop the cycle.' },
        { action: 'Request homing when the emergency stop is healthy.' },
        { action: 'Confirm the cooker area is clear and the emergency stop is in its normal state.' },
        { action: 'Wait, allowing the steam timer, then stop the agitator.' },
      ],
    },
  });
  const shutdown = plain(buildShutdown(project, {}));
  assert.match(shutdown, /Press the stop button to stop the cycle/);
  assert.equal(/request homing/i.test(shutdown), false);
  assert.equal(/area is clear/i.test(shutdown), false);
  assert.equal(/allowing the steam timer/i.test(shutdown), false);

  const cell = await load(CELL, 'cell.scl');
  const cellShutdown = plain(buildShutdown(cell, {}));
  assert.equal(/hot surfaces have cooled/i.test(cellShutdown), false);
  assert.equal(/accumulator/i.test(cellShutdown), false);
  assert.match(cellShutdown, /vertical or spring-held loads are blocked/i);
  assert.match(energyTable(cell).flat().join(' '), /Pump isolation/);
  assert.equal(/accumulator/i.test(energyTable(cell).flat().join(' ')), false);

  const stored = emptyProject();
  upsertTag(stored, { name: 'ACC', description: 'Hydraulic accumulator' });
  upsertTag(stored, { name: 'HP', description: 'Hydraulic pump' });
  assert.match(energyTable(stored).flat().join(' '), /accumulator/i);

  const cooker = await load(COOKER, 'cooker.L5X');
  assert.match(plain(buildShutdown(cooker, {})), /hot surfaces have cooled/i);
});

test('a short device list keeps the controller maintenance baseline', async () => {
  const valve = await load(VALVE, 'tia_LAD_Valve.xml');
  assert.ok(inspectEquipment(valve).present.length <= 2);
  const schedule = plain(buildPmSchedule(valve, {}));
  assert.match(schedule, /opens on command/i);
  assert.match(schedule, /Test the emergency stop/);
  assert.match(schedule, /Back up the controller program/);
  assert.match(schedule, /cabinet fan, if one is fitted/);
  assert.match(schedule, /controller battery/);

  const cell = await load(CELL, 'cell.scl');
  assert.ok(inspectEquipment(cell).present.length > 2);
  assert.equal(/Back up the controller program/.test(plain(buildPmSchedule(cell, {}))), false);
});

test('custom tables are narrow in the code column and share a page with the scope', async () => {
  const cell = await load(CELL, 'cell.scl');
  const guide = htmlOf(custom(cell, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  const parts = htmlOf(custom(cell, 'parts', 'Spare Parts List'));
  assert.match(guide, /<col style="width:8%">/);
  assert.match(parts, /<col style="width:8%">/);
  assert.equal(/class="toc"/.test(guide), false);
  assert.equal(/class="toc"/.test(parts), false);
  assert.match(guide, /was requested with the engineering files/);
  assert.match(guide, /What you see and what to do/);
  assert.equal((guide.match(/<section class="chapter">/g) || []).length, 1);
  const pm = htmlOf(buildPmSchedule(cell, {}));
  assert.equal(/class="toc"/.test(pm), false);
  assert.match(pm, /Quarterly <span class="inf">Inferred<\/span>/);

  const scored = plain(buildPmSchedule(cell, {}));
  const at = scored.search(/scored rods/i);
  assert.match(scored.slice(at - 60, at + 20), /pneumatic cylinder/);
  assert.equal(/cylinder valve/i.test(scored.slice(at - 60, at + 20)), false);
});

test('startup splits each unit and keeps a source spelling', async () => {
  const cooker = await load(COOKER, 'cooker.L5X');
  const html = htmlOf(buildStartup(cooker, {}));
  const text = plain(buildStartup(cooker, {}));
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1].replace(/<[^>]+>/g, ' '));
  const resets = items.filter((item) => /master reset/i.test(item));
  assert.equal(resets.length, 4);
  assert.equal(resets.some((item) => /Cooker 1 Sequence master reset/.test(item) && /Cooker2/.test(item)), false);
  assert.equal(resets.some((item) => /MC Sedquence master reset/.test(item) && /Milling/.test(item)), false);
  const starts = items.filter((item) => /Start the /.test(item));
  assert.ok(starts.length >= 4);
  assert.equal(starts.some((item) => /Cooker 1 Start PB/.test(item) && /Cooker #2/.test(item)), false);
  assert.match(text, /MC Sedquence master reset/);
  assert.match((cooker.warnings || []).join('\n'), /spells "Sedquence"/);
  assert.equal(/spells "Sedquence"/.test(text), false);
});
