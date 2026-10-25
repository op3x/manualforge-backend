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
const { polishName } = require('../lib/presentation');
const { sanitizeOutput } = require('../lib/output-sanitize');
const { emptyProject, addRoutine, upsertTag } = require('../lib/project');

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
      { action: 'Press the stop button to stop the cycle then stop the agitator, or let a shutdown occur.' },
    ],
  };
  const shutdown = plain(buildShutdown(cell, {}));
  assert.equal(shutdown.includes('press the home request while the emergency stop is healthy'), false);
  assert.equal(/stop button is not pressed/i.test(shutdown), false);
  assert.equal(/return the lift to its home position/i.test(shutdown), false);
  assert.equal((shutdown.match(/Press the stop button to stop the cycle/g) || []).length, 1);
  assert.match(shutdown, /Press the stop button to stop the cycle\./);
  assert.match(shutdown, /Stop the agitator/);
  assert.equal(/\. stop the agitator/.test(shutdown), false);
  assert.equal(/let a shutdown occur/i.test(shutdown), false);

  routine.analysis = { operatorSteps: [{ action: LEAK }] };
  const dropped = plain(buildShutdown(cell, {}));
  assert.equal(dropped.includes('press the home request'), false);
  assert.equal(/stop button is not pressed/i.test(dropped), false);

  const cooker = await load(COOKER, 'cooker.L5X');
  const cookerRoutine = cooker.routines.find((item) => (item.units || []).some((unit) => unit && unit.text)) || cooker.routines[0];
  cookerRoutine.analysis = {
    operatorSteps: [
      { action: 'Confirm the emergency stop conditions are satisfied before starting Stop the sequence with the normal stop.' },
      { action: 'Stop the sequence.' },
    ],
  };
  const cookerShutdown = plain(buildShutdown(cooker, {}));
  assert.equal(/conditions are satisfied before starting/i.test(cookerShutdown), false);
  assert.match(cookerShutdown, /Stop the sequence\./);

  const acd = await load(ACD, 'CuteLogix.ACD');
  const acdRoutine = acd.routines.find((item) => (item.units || []).length) || acd.routines[0];
  acdRoutine.analysis = {
    operatorSteps: [
      { action: 'Confirm run conditions are satisfied before starting Stop the program and leave the controller in program mode.' },
      { action: 'Confirm the machine is powered and that no maintenance lockout is in effect.' },
      { action: 'Stop the conveyor and wait until it has stopped before it is started again.' },
    ],
  };
  const acdShutdown = plain(buildShutdown(acd, {}));
  assert.equal(/conditions are satisfied before starting/i.test(acdShutdown), false);
  assert.equal(/leave the controller in program mode/i.test(acdShutdown), false);
  assert.equal(/no maintenance lockout is in effect/i.test(acdShutdown), false);
  assert.match(acdShutdown, /before it is started again/);
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
  assert.equal(rows.some((cells) => /^ALM-(\d+)$/.test(cells[0]) && Number(cells[0].slice(4)) > 40), false);
  assert.equal(/Configure Whether|FSC control for Fault Code|Drive Last Fault Code|LastFaultCode|Description of Drive Fault/i.test(joined), false);
  assert.equal(/LastFaultCode|Description of Drive Fault/i.test([...byCode.values()].join('\n')), false);

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

  const kept = emptyProject();
  const messages = [
    'Cooker 1 level high-high',
    'Cooker 2 level high',
    'Cooker 3 level low',
    'Tank 4 level low-low',
    'Cooker 5 temperature high',
    'Cooker 6 temperature low',
    'Low Low process alarm',
  ];
  addRoutine(kept, {
    name: 'Main',
    units: [],
    analysis: {
      alarms: messages.map((text) => ({ text, cause: 'Not determinable', remedy: 'Correct the condition, then press reset.' })),
      groups: [],
      housekeeping: [],
    },
  });
  kept.alarms = [{ text: 'Cooker 1 level is high', cause: 'The level is above the alarm point.', remedy: 'Stop the inflow.' }];
  const keptManual = alarmRows(kept);
  assert.equal(keptManual[6][0], 'ALM-7');
  const keptGuide = troubleCells(kept);
  const alm7 = keptGuide.find((cells) => cells[0] === 'ALM-7');
  assert.ok(alm7, keptGuide.map((cells) => cells[0]).join(' '));
  assert.equal(alm7[1], keptManual[6][1]);
  assert.equal(keptGuide.some((cells) => cells[0] === '—' && /cooker 1 level is high/i.test(cells[1])), false);

  const many = emptyProject();
  addRoutine(many, {
    name: 'Main',
    units: [],
    analysis: {
      alarms: Array.from({ length: 45 }, (_, index) => ({ text: `Alarm code ${String(index + 1).padStart(2, '0')} on the north vessel`, cause: 'The condition is still true.', remedy: 'Correct it.' })),
      groups: [],
      housekeeping: [],
    },
  });
  const manyGuide = troubleCells(many).map((cells) => cells[0]);
  assert.ok(manyGuide.includes('ALM-40'));
  assert.equal(manyGuide.includes('ALM-41'), false);
});

test('a routine that declares no alarms does not invent an alarm code', async () => {
  const phrases = [
    'No alarms are defined for this routine',
    'No alarms are defined.',
    'No alarm codes are defined in the supplied program units.',
  ];
  for (const phrase of phrases) {
    const project = emptyProject();
    addRoutine(project, {
      name: 'Main',
      units: [],
      analysis: {
        alarms: [{ text: phrase, cause: 'Not applicable', remedy: 'Not applicable' }],
        groups: [],
        housekeeping: [],
      },
    });
    const manual = plain(buildDocument(project));
    const guide = plain(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
    assert.match(manual, /No alarms are defined for this equipment/, phrase);
    assert.match(guide, /No alarms are defined for this equipment/, phrase);
    assert.equal(/ALM-\d/.test(manual), false, phrase);
    assert.equal(/ALM-\d/.test(guide), false, phrase);
    assert.equal(/Not applicable/.test(`${manual} ${guide}`), false, phrase);
    assert.equal(/Stop reaction/.test(`${manual} ${guide}`), false, phrase);
  }
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
  const startup = plain(buildStartup(step, {}));
  assert.equal(/controller receives power/i.test(startup), false);
  assert.equal(/fault indicator is clear/i.test(startup), false);
  const guide = plain(custom(step, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.equal(/does not go to run/i.test(guide), false);
  assert.equal(/\bcouplings?\b/i.test(guide), false);
  assert.equal(/from the controller/i.test(guide), false);
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
  assert.equal(valveRows.some((row) => /^The actuator will not open$/i.test(row)), false);
  assert.equal(valveRows.some((row) => /valve does not reach the commanded position/i.test(row)), false);
  assert.equal(/does not go to run|stays on after a stop|does not run as commanded/i.test(valveRows.join(' ')), false);
  const valvePm = plain(buildPmSchedule(valve, {}));
  assert.equal(/Test the emergency stop/.test(valvePm), false);
  assert.match(valvePm, /Back up the controller program/);

  const acd = await load(ACD, 'CuteLogix.ACD');
  const acdText = troubleCells(acd).map((cells) => cells.join(' ')).join('\n');
  const acdManual = alarmRows(acd).map((row) => `${row[0]} ${row[1]}`).join('\n');
  assert.match(acdText, /ALM-1/);
  assert.match(acdText, /First Out Fault/);
  assert.equal(/I count stuff/i.test(`${acdText}\n${acdManual}`), false);
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

test('real alarm messages stay and tag-shaped rows do not', () => {
  const project = emptyProject();
  addRoutine(project, {
    name: 'Main',
    units: [],
    analysis: {
      alarms: [
        { text: 'Cooker temperature high-high', cause: 'The cooker temperature is above the high-high setpoint.', remedy: 'Reduce the heat.' },
        { text: 'Start permissive lost', cause: 'The start permissive is open.', remedy: 'Restore the permissive.' },
        { text: 'Steam valve failed to open', cause: 'The valve did not leave the closed position before the alarm timer expired.', remedy: 'Open the steam supply.' },
        { text: 'Conveyor motor overload', cause: 'The motor overload is tripped.', remedy: 'Reset the overload.' },
        { text: 'Alarm Status To HMI', cause: 'The bit is on.', remedy: 'Clear it.' },
        { text: 'AOI Device Clear Fault', cause: 'A command bit.', remedy: 'Do not list this as an alarm.' },
        { text: 'Zone Master Clear Fault Enable', cause: 'A configuration bit.', remedy: 'Leave it.' },
        { text: 'Sts Fault Alm', cause: 'A status mirror.', remedy: 'Read the device alarm instead.' },
        { text: 'Module Communication Offline', cause: 'The module is offline.', remedy: 'Restore communication.' },
        { text: 'Communication to an I/O module is lost.', cause: 'The module does not answer.', remedy: 'Check the cable.' },
        { text: 'Drive faulted status', cause: 'The drive is faulted.', remedy: 'Reset the drive.' },
        { text: 'The drive reports a fault condition.', cause: 'A drive fault is present.', remedy: 'Clear the drive fault.' },
      ],
      groups: [],
      housekeeping: [],
    },
  });
  upsertTag(project, { name: 'HMI_Alarmed', dataType: 'BOOL', description: 'Alarm Status To HMI' });
  upsertTag(project, { name: 'Cmd_ClearFault', dataType: 'BOOL', description: 'AOI Device Clear Fault' });
  upsertTag(project, { name: 'Sts_FaultAlm', dataType: 'BOOL', description: 'Sts Fault Alm' });
  upsertTag(project, { name: 'Cfg_ZoneEnable', dataType: 'BOOL', description: 'Zone Master Clear Fault Enable' });
  const messages = alarmRows(project).map((row) => row[1]);
  const joined = messages.join('\n');
  for (const kept of [/temperature high-high/i, /start permissive lost/i, /steam valve failed to open/i, /conveyor motor overload/i]) {
    assert.equal(messages.some((row) => kept.test(row)), true, String(kept));
  }
  assert.equal(/Alarm Status To HMI|AOI Device Clear Fault|Zone Master Clear Fault Enable|Sts Fault Alm/i.test(joined), false);
  assert.equal(messages.filter((row) => /communication|module/i.test(row)).length, 1);
  assert.equal(messages.filter((row) => /\bdrive\b/i.test(row)).length, 1);
  const guide = plain(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.match(guide, /temperature high-high/i);
  assert.match(guide, /Start permissive lost/i);
  assert.match(guide, /Steam valve failed to open/i);
  assert.match(guide, /Conveyor motor overload/i);
  assert.equal(/Alarm Status To HMI|Device Clear Fault|Sts Fault Alm/i.test(guide), false);
});

test('a virtual axis does not get a position-fault row', () => {
  const project = emptyProject();
  upsertTag(project, { name: 'VAxis', dataType: 'AXIS_VIRTUAL', description: '' });
  upsertTag(project, { name: 'InfeedAxis', dataType: 'AXIS_SERVO', description: 'Infeed axis' });
  project.subsystems = [
    { name: 'VAxis', purpose: 'A virtual axis used by the program.', components: ['axis'], motions: [], sensors: [] },
    { name: 'Infeed Axis', purpose: 'The infeed axis moves the product.', components: ['axis'], motions: [], sensors: [] },
  ];
  const guide = plain(custom(project, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.equal(/VAxis does not reach its position/i.test(guide), false);
  assert.match(guide, /Infeed Axis does not reach its position/i);

  const onlyVirtual = emptyProject();
  upsertTag(onlyVirtual, { name: 'VAxis', dataType: 'AXIS_VIRTUAL', description: '' });
  onlyVirtual.subsystems = [
    { name: 'Axis', purpose: 'The axis is virtual.', components: ['VAxis'], motions: [], sensors: [] },
  ];
  const virtualGuide = plain(custom(onlyVirtual, 'troubleshooting', 'Alarm and Troubleshooting Guide'));
  assert.equal(/does not reach its position/i.test(virtualGuide), false);
});

test('a NEMA frame size stays and is spelled NEMA', () => {
  assert.equal(polishName('Nema 17'), 'NEMA 17');
  assert.equal(polishName('nema-23 stepper'), 'NEMA 23 Stepper');
  assert.equal(sanitizeOutput('The frame is Nema 17.'), 'The frame is NEMA 17.');
  assert.equal(/siemens/i.test(sanitizeOutput('Siemens Nema 17 drive')), false);
  assert.match(sanitizeOutput('Siemens Nema 17 drive'), /NEMA 17/);
});

test('extra-document headers use the long-header limit', () => {
  assert.equal(fitHeaderLeft('Acme · Cell · Shutdown Procedure'), 'Acme · Cell · Shutdown Procedure');
  const fitted = fitHeaderLeft(`${'North Line Controls '.repeat(12)} · Cell · Alarm and Troubleshooting Guide`);
  assert.match(fitted, /Alarm and Troubleshooting Guide$/);
  assert.match(fitted, /\u2026/);
  assert.equal(/Gui…$/.test(fitted), false);
  assert.ok(Array.from(fitted).length <= 110);
  const doc = buildShutdown(emptyProject(), { branding: { whiteLabel: true, companyName: 'Very Long Integrator Name '.repeat(8) } });
  assert.match(doc.meta.headerLeft, /Shutdown Procedure$/);
  assert.match(doc.meta.headerLeft, /\u2026/);
  assert.ok(Array.from(doc.meta.headerLeft).length <= 110);
});

test('the extras job marks the manual delivered and keeps branding with the selection', async () => {
  assert.equal(await markDeliveredManual({}, { plan: 'pro' }, 'sess'), null);
  const calls = [];
  const locked = await markDeliveredManual({ id: 'stripe' }, { plan: 'pro' }, 'sess', () => ({
    markFirstManualDelivered: async (...args) => {
      calls.push(args);
      return { delivered: true };
    },
  }));
  assert.deepEqual(locked, { delivered: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].plan, 'pro');
  assert.equal(calls[0][2], 'sess');
  const missingOther = new Error("Cannot find module 'other-package'");
  missingOther.code = 'MODULE_NOT_FOUND';
  await assert.rejects(() => markDeliveredManual({}, { plan: 'pro' }, 'sess', () => { throw missingOther; }));
  const missingDelivery = new Error("Cannot find module './delivery'");
  missingDelivery.code = 'MODULE_NOT_FOUND';
  assert.equal(await markDeliveredManual({}, { plan: 'pro' }, 'sess', () => { throw missingDelivery; }), null);
});
