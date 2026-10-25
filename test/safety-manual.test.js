const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { emptyProject } = require('../lib/project');
const { analyzeRoutine, acceptModelGroups } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { bannedClaimHits } = require('../lib/text');
const { energyRows } = require('../lib/energy');
const { parseUploads } = require('../lib/parsers');
const { corpusHas, corpusRoot } = require('./corpus-env');

function withLogic(tags, comment = 'Start the motor') {
  const project = emptyProject();
  project.tags = tags;
  project.routines = [{
    name: 'Main',
    type: 'RLL',
    program: 'Main',
    units: [{ index: 0, number: 0, kind: 'rung', text: 'XIC(Start)OTE(Run);', comment }],
    analysis: { groups: [], housekeeping: [] },
  }];
  analyzeRoutine(project.routines[0], project, null);
  return project;
}

function htmlOf(project) {
  return renderHtml(buildDocument(project));
}

function between(html, start, end) {
  const at = html.indexOf(start);
  assert.ok(at >= 0, start);
  const stop = end ? html.indexOf(end, at + start.length) : html.length;
  return html.slice(at, stop < 0 ? html.length : stop);
}

test('safety devices list real devices and do not invent a test interval', () => {
  const project = withLogic([
    { name: 'Preset_1', description: 'Cooker preset', dataType: 'REAL' },
    { name: 'Alarm_Reset', description: 'Alarm reset', dataType: 'BOOL' },
    { name: 'Step_Timer', description: 'Step timer', dataType: 'TIMER' },
    { name: 'Water_Meter', description: 'Cooker water meter', dataType: 'REAL' },
    { name: 'EStop_Ok', description: 'EStop Ok', dataType: 'BOOL' },
    { name: 'SafeOff_Ok', description: 'Safe Off Ok', dataType: 'BOOL' },
  ]);
  const html = htmlOf(project);
  const devices = between(html, 'Safety devices and safety functions</h2>', 'Emergency stop</h2>');
  assert.match(devices, /EStop Ok/);
  assert.match(devices, /Safe Off Ok/);
  assert.equal(/Preset|Alarm reset|Step timer|water meter/i.test(devices), false);
  assert.equal(/Daily/.test(devices), false);
  assert.match(devices, /per the device maker/);
  assert.match(devices, /instructions/);
  assert.equal((devices.match(/Prevents motion while/g) || []).length, 0);
});

test('powered motion is not described as nothing moving', () => {
  const project = withLogic([
    { name: 'Agitator_VFD', description: 'Agitator VFD running', dataType: 'BOOL' },
    { name: 'Motor_Run', description: 'Feeder screw motor', dataType: 'BOOL' },
  ]);
  const html = htmlOf(project);
  assert.equal(/no guarded motion|Nothing moves/i.test(html), false);
  assert.match(html, /powered motion|Powered motion|Stay outside the guards/i);
});

test('steam evidence adds a thermal hazard and a lockout row without an invented discharge time', () => {
  const project = withLogic([
    { name: 'Cooker1_Steam', description: 'Steam supply valve', dataType: 'BOOL' },
    { name: 'Temp_SP', description: 'Temperature setpoint', dataType: 'REAL' },
  ], 'Start the sequence');
  const html = htmlOf(project);
  const loto = between(html, 'Energy isolation and lockout/tagout</h2>', 'Residual risks</h2>');
  assert.match(html, /scald|hot fluid|steam/i);
  assert.match(loto, /Steam or heat/);
  assert.match(loto, /From your files/);
  assert.match(loto, /Typical — confirm/);
  assert.match(loto, /Not found/);
  assert.match(loto, /Confirm on the machine/);
  assert.equal(/5 min/.test(html), false);
  assert.equal(/\b50 V\b/.test(html), false);
  const rows = energyRows(project);
  assert.equal(rows.some((row) => row.energy === 'Steam or heat' && row.source === 'From your files'), true);
  assert.equal(rows.some((row) => row.energy === 'Electrical supply' && row.source === 'Typical — confirm'), true);
  assert.equal(rows.some((row) => row.energy === 'Pneumatic'), false);
});

test('a fastener named drive and a knife-gate valve are not drives or blades', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'HEX DRIVE SCREW', kind: 'fastener', role: 'structure', leaf: true, description: 'HEX DRIVE SCREW' },
    { name: 'Drive Pulley Cover', kind: 'cover', role: 'structure', leaf: true, description: 'Drive Pulley' },
    { name: 'KNIFE GATE', kind: 'valve', role: 'process', leaf: false, description: 'KNIFE GATE valve' },
  ];
  project.cad.bom = [
    { item: '1', partNumber: 'SCR', description: 'HEX DRIVE SCREW', qty: 4 },
  ];
  const html = htmlOf(project);
  assert.equal(energyRows(project).some((row) => row.energy === 'Electrical supply'), false);
  assert.equal(/Crushing points|blade|shearing/i.test(html), false);
  assert.match(html, /NEEDS INPUT/);
  assert.equal(/Main disconnect/.test(html), false);
});

test('a door with no interlock is not told to confirm the interlock', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Access Door', kind: 'door', role: 'guarding', leaf: false, description: 'Access door' },
  ];
  project.narrative = {
    kind: 'machine',
    modelSubsystems: [
      { assembly: 'Access Door', name: 'Access Door', role: 'guarding', function: 'The door opens for access.', motion: 'The door opens.', interlocks: 'None specified', components: ['Hinge'] },
    ],
  };
  const html = htmlOf(project);
  assert.match(html, /confirm whether this door is interlocked/i);
  assert.equal(/confirm the interlock/i.test(html), false);
});

test('cover, revision, and lockout sequence use the draft wording and lock before venting', () => {
  const project = withLogic([
    { name: 'Cooker1_Steam', description: 'Steam supply valve', dataType: 'BOOL' },
    { name: 'Water_Meter', description: 'Cooker water meter has reset after the cause of any fault is corrected', dataType: 'BOOL' },
  ], 'Start the sequence');
  project.identity.manufacturerName = 'Example Brewery';
  project.identity.language = 'English (original instructions)';
  const html = htmlOf(project);
  assert.match(html, /DRAFT — GENERATED WITH AI\. NOT VERIFIED\./);
  assert.match(html, /Neither ManualOS nor Op3x LLC is the manufacturer/);
  assert.match(html, /Approved for use by:/);
  assert.match(html, /DRAFT — AI-generated with ManualOS from user files\. Verify before use\./);
  assert.match(html, /Not approved — reviewer name \/ date/);
  assert.match(html, /Draft generated with ManualOS from/);
  assert.equal(/Approved:\s*ManualOS/i.test(html), false);
  assert.equal(/original instructions/i.test(html), false);
  assert.match(html, /GENERIC TEMPLATE — NOT A MACHINE-SPECIFIC ENERGY CONTROL PROCEDURE/);
  assert.match(html, /Generic lockout sequence — template only/);
  assert.match(html, /Standards that may apply/);
  assert.equal(/Declaration of conformity and applied standards/.test(html), false);
  assert.match(html, /is not a declaration of conformity/);
  const sequence = html.slice(html.indexOf('Generic lockout sequence — template only'));
  const prepare = sequence.indexOf('Prepare.');
  const shut = sequence.indexOf('Tell affected people that the equipment will be shut down');
  const isolate = sequence.indexOf('Isolate each energy source');
  const lock = sequence.indexOf('Apply your lock');
  const vent = sequence.indexOf('release or dissipate stored energy');
  const verify = sequence.indexOf('Verify zero energy. Try the start control');
  const clear = sequence.indexOf('Clear the area');
  const remove = sequence.indexOf('Remove each lock');
  const notify = sequence.indexOf('Tell affected people that the lockout is over');
  for (const index of [prepare, shut, isolate, lock, vent, verify, clear, remove, notify]) assert.ok(index >= 0);
  assert.ok(prepare < shut && shut < isolate && isolate < lock && lock < vent && vent < verify && verify < clear && clear < remove && remove < notify);
  assert.match(html, /<td>Language<\/td><td>English<\/td>/);
  assert.match(html, /Device ID: __________/);
  assert.match(html, /Location: __________/);
  const startup = between(html, 'Daily start-up</h2>', 'Normal operation and production</h2>');
  assert.match(startup, /Tell affected people the lockout is over and the equipment is about to start/);
  assert.match(startup, /Correct the cause of any fault, then press Reset/);
  assert.equal(/Press the cooker water meter/i.test(startup), false);
  assert.equal(/compressed air/i.test(startup), false);
  assert.equal(/compressed air/i.test(html), false);
  const pm = between(html, 'Preventive maintenance schedule</h2>', 'Lubrication and fluids</h2>');
  assert.match(pm, /Energized work/);
  assert.match(pm, /1910\.147\(f\)\(1\)/);
  assert.match(pm, /Name __________ Date __________/);
  assert.match(pm, /Energized test/);
  assert.equal(/5 min/.test(pm), false);
  assert.equal(bannedClaimHits(html).length, 0, bannedClaimHits(html).join(','));
});

test('process chemical, pressure, precursor, and vacuum are rows only when the input shows them', () => {
  const chemical = withLogic([
    { name: 'Purge_Chem', description: 'Process chemical purge', dataType: 'BOOL' },
    { name: 'Line_P', description: 'Process pressure override', dataType: 'REAL' },
  ]);
  const chemicalHtml = htmlOf(chemical);
  assert.match(chemicalHtml, /Process chemical/);
  assert.match(chemicalHtml, /Process pressure/);
  assert.equal(/Crushing points/.test(chemicalHtml), false);
  const ald = withLogic([
    { name: 'Precursor_1', description: 'Precursor delivery', dataType: 'BOOL' },
    { name: 'Chamber_Vac', description: 'Vacuum valve', dataType: 'BOOL' },
  ]);
  const aldHtml = htmlOf(ald);
  assert.match(aldHtml, /Process chemical/);
  assert.match(aldHtml, /Vacuum/);
  assert.equal(/Crushing points/.test(aldHtml), false);
  assert.equal(energyRows(ald).every((row) => row.source === 'From your files' || row.source === 'Typical — confirm'), true);
});

test('status-only alarms are not faults and do not invent a stop or an ALM code', () => {
  const project = withLogic([
    { name: 'Level_Alarm', description: 'Tank level alarm status indication only', dataType: 'BOOL' },
  ]);
  project.routines[0].analysis.alarms = [
    { code: 'ALM-10', text: 'Tank level alarm status indication only', cause: 'Status only.', remedy: 'Stop reaction: the machine stops.', severity: 'Fault' },
  ];
  const html = htmlOf(project);
  const alarms = between(html, 'Alarm and fault messages</h2>', 'Troubleshooting guide</h2>');
  assert.match(alarms, /Status/);
  assert.equal(/ALM-\d+/.test(alarms), false);
  assert.equal(/Stop reaction|stops and stays stopped/i.test(alarms), false);
  assert.match(alarms, /Please confirm/);
});

test('a drawing with no control program does not invent troubleshooting or startup', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Transfer Conveyor', kind: 'conveyor', role: 'process', leaf: false, description: 'Transfer conveyor' },
  ];
  const html = htmlOf(project);
  const trouble = between(html, 'Troubleshooting guide</h2>', 'Accidents, breakdowns</h2>');
  assert.match(trouble, /NEEDS INPUT/);
  assert.equal(/does not start/.test(trouble), false);
  const startup = between(html, 'Daily start-up</h2>', 'Normal operation and production</h2>');
  assert.match(startup, /NEEDS INPUT/);
  assert.equal(/compressed air/i.test(html), false);
});

test('EnableIn is omitted and a SPECIFIER column is the address', async () => {
  const project = withLogic([
    { name: 'EnableIn', description: 'system defined parameter', dataType: 'BOOL' },
    { name: 'Start_PB', description: 'Start pushbutton', dataType: 'BOOL', address: 'Local:1:I.Data.0' },
  ]);
  const html = htmlOf(project);
  const io = between(html, 'PLC I/O and tag list</h2>', 'Control program cross-reference</h2>');
  assert.match(io, /Start pushbutton/);
  assert.equal(/EnableIn|system defined parameter/i.test(io), false);
  const csv = await parseUploads([{
    name: 'io.csv',
    buffer: Buffer.from('Tag,Description,SPECIFIER\nStart_PB,Start pushbutton,I:0/1\n'),
  }]);
  assert.equal(csv.tags.find((tag) => tag.name === 'Start_PB').address, 'I:0/1');
});

test('placeholder comments and product names stay out of visible copy', () => {
  const project = withLogic([
    { name: 'Temp_1', description: 'for example temparutre probe', dataType: 'REAL' },
    { name: 'PF525_VFD', description: 'PowerFlex 525 drive', dataType: 'BOOL' },
  ]);
  const html = htmlOf(project);
  assert.equal(/temparutre/i.test(html), false);
  assert.equal(/\bPowerFlex\b|\bPF525\b/.test(html), false);
});

test('an OTE is not titled as a latch and real logic is not housekeeping', () => {
  const units = [
    { index: 2, number: 2, kind: 'rung', text: 'XIC(Start)OTE(Run);', comment: 'Run output' },
    { index: 6, number: 6, kind: 'rung', text: 'LEQ(Temp,SP)OTE(Heat);', comment: 'Under limit' },
  ];
  const accepted = acceptModelGroups(units, [
    { unit_numbers: [2], title: 'Run latch', function: 'The run output latches.', housekeeping: false },
    { unit_numbers: [6], title: 'Temperature over-limit', function: 'Heat turns on under the setpoint.', housekeeping: true },
  ], emptyProject());
  assert.equal(accepted.housekeeping.length, 0);
  assert.match(accepted.groups[0].title, /turns on|output/i);
  assert.equal(/latch/i.test(accepted.groups[0].title), false);
  assert.match(accepted.groups[1].title, /under-limit/i);
});

function corpusFile(rel) {
  return path.join(corpusRoot(), rel);
}

test('brewery, transfer chamber, grfics, and SWaT manuals follow the energy evidence', async (t) => {
  const files = [
    ['plc/brewery_Cooker_1_AutoLogic_Program.L5X', 'brewery'],
    ['cad/creator_transfer_chamber_COMPLETE_FRAME_ASY.stp', 'transfer'],
    ['plc/grfics_simplified_te_plcopen.xml', 'grfics'],
    ['plc/swat_PLC1.L5X', 'swat'],
  ];
  if (!files.some(([rel]) => corpusHas(rel))) {
    t.skip('corpus files are not on this machine');
    return;
  }
  for (const [rel, label] of files) {
    if (!corpusHas(rel)) continue;
    const project = await parseUploads([{ name: path.basename(rel), buffer: fs.readFileSync(corpusFile(rel)) }]);
    for (const routine of project.routines) analyzeRoutine(routine, project, null);
    const html = htmlOf(project);
    assert.equal(bannedClaimHits(html).length, 0, `${label}: ${bannedClaimHits(html).join(',')}`);
    assert.match(html, /GENERIC TEMPLATE — NOT A MACHINE-SPECIFIC ENERGY CONTROL PROCEDURE/);
    assert.match(html, /DRAFT — AI-generated with ManualOS from user files\. Verify before use\./);
    assert.equal(/5 min/.test(html), false, label);
    assert.equal(/Approved:\s*ManualOS/i.test(html), false, label);
    if (label === 'brewery') {
      assert.match(html, /steam|scald|hot/i);
      assert.match(between(html, 'Energy isolation and lockout/tagout</h2>', 'Residual risks</h2>'), /Steam or heat/);
      assert.equal(/no guarded motion/i.test(html), false);
    }
    if (label === 'grfics') {
      assert.equal(/no guarded motion|this calculation/i.test(html), false);
      assert.match(html, /pressurised process vessel/);
      assert.match(html, /Isolate the supplies, depressurise the vessel, and drain the lines/);
      const loto = between(html, 'Energy isolation and lockout/tagout</h2>', 'Residual risks</h2>');
      const table = loto.slice(loto.indexOf('<table'), loto.indexOf('Generic lockout sequence'));
      assert.match(table, /Process chemical/);
      assert.match(table, /Process pressure/);
      assert.match(table, /Electrical supply/);
      assert.equal(/<td>Pneumatic<\/td>|<td>Gravity or stored mechanical energy<\/td>|<td>Compressed air<\/td>/.test(table), false);
      assert.match(loto, /Isolate each energy source/);
      assert.match(loto, /Depressurise the vessel and lines, and drain them/);
      assert.equal((html.match(/Crushing points/g) || []).length, 0);
      project.narrative = { ...(project.narrative || {}), kind: 'calculation' };
      const relabelled = htmlOf(project);
      assert.equal(/no guarded motion|this calculation/i.test(relabelled), false);
    }
    if (label === 'transfer') {
      assert.equal(/no guarded motion/i.test(html), false);
      assert.match(between(html, 'Troubleshooting guide</h2>', 'Accidents, breakdowns</h2>'), /NEEDS INPUT/);
    }
    if (label === 'swat') {
      assert.match(html, /From your files|Typical — confirm|Not found/);
    }
  }
});
