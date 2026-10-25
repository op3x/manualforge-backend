const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRoutine, containsRawSource } = require('../lib/logic');
const { buildSubsystems } = require('../lib/subsystems');
const { applyEquipment } = require('../lib/ai');
const { sanitizeProse } = require('../lib/text');
const { readablePartName } = require('../lib/presentation');
const { emptyProject } = require('../lib/project');
const { parseUploads } = require('../lib/parsers');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { hazardsForSubsystem, isStaticPart } = require('../lib/hazards');

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

test('same wheel name with different functions stays as left and right', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Pololu Multi Hub Wheel V2', kind: 'robot', role: 'process', leaf: false, description: 'Pololu Multi Hub Wheel V2' },
    { name: 'Pololu Multi Hub Wheel V2', kind: 'robot', role: 'process', leaf: false, description: 'Pololu Multi Hub Wheel V2' },
  ];
  applyEquipment(project, {
    subsystems: [
      {
        assembly: 'Pololu Multi Hub Wheel V2',
        name: 'Pololu Multi Hub Wheel V2',
        role: 'process',
        function: 'Left drive wheel that converts motor rotation into ground travel.',
        motion: 'The wheel turns.',
        components: ['Tire'],
      },
      {
        assembly: 'Pololu Multi Hub Wheel V2',
        name: 'Pololu Multi Hub Wheel V2',
        role: 'process',
        function: 'Right drive wheel that converts motor rotation into ground travel, working with the left wheel.',
        motion: 'The wheel turns.',
        components: ['Tire'],
      },
    ],
  });
  const subsystems = buildSubsystems(project, []);
  const left = subsystems.find((item) => /\bleft\b/i.test(item.name));
  const right = subsystems.find((item) => /\bright\b/i.test(item.name));
  assert.ok(left, subsystems.map((item) => item.name).join(' | '));
  assert.ok(right, subsystems.map((item) => item.name).join(' | '));
  assert.notEqual(normalize(left.name), normalize(right.name));
  assert.match(left.purpose, /left drive wheel/i);
  assert.match(right.purpose, /right drive wheel/i);
});

test('hardware fillers fold together and the motor driver stays', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Servo', kind: 'motor', role: 'process', leaf: false, description: 'Servo' },
    { name: 'Nuts and Bolts', kind: 'fastener', role: 'process', leaf: false, description: 'Nuts and Bolts' },
    { name: 'Beaglebone BLUE Led-0603', kind: '', role: 'process', leaf: false, description: 'LED' },
    { name: 'Strawson Eagle LIB header', kind: '', role: 'process', leaf: false, description: 'header' },
    { name: 'PCB Component', kind: '', role: 'process', leaf: false, description: 'PCB' },
    { name: 'Component Tb6621 FNG', kind: '', role: 'process', leaf: false, description: 'TB6621FNG motor driver' },
    { name: 'Component SB044685-01', kind: '', role: 'structure', leaf: false, description: 'Component SB044685-01' },
  ];
  const subsystems = buildSubsystems(project, []);
  const names = subsystems.map((item) => item.name).join(' | ');
  assert.equal(subsystems.filter(isFillerName).length, 0, names);
  assert.ok(subsystems.some((item) => /electronics and hardware/i.test(item.name)), names);
  assert.ok(subsystems.some((item) => /tb6621|fng/i.test(item.name)), names);
  assert.equal(subsystems.some((item) => /component\s+sb/i.test(item.name)), false);
  assert.ok(subsystems.some((item) => /^servo$/i.test(item.name)));
});

function isFillerName(item) {
  return /nuts and bolts|^led\b|\bheader\b|^pcb\b/i.test(item.name);
}

test('a door keeps its function and a machined part is not a fan task', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Access Door', kind: 'guard', role: 'structure', leaf: false, description: 'Access door' },
    { name: 'Base Frame', kind: 'frame', role: 'structure', leaf: false, description: 'Frame' },
  ];
  project.cad.bom = [
    { item: 1, partNumber: 'BLOWER-1', description: 'Component, solid body', qty: 1 },
    { item: 2, partNumber: 'LED_0603_G_Pocket002', description: 'LED_0603_G_Pocket002', qty: 1 },
  ];
  applyEquipment(project, {
    subsystems: [
      { assembly: 'Access Door', name: 'Access Door', role: 'guarding', function: 'Provides operator access and closes to guard the moving parts.', motion: 'The door opens.', components: ['Hinge'] },
      { assembly: 'Base Frame', name: 'Frame and guarding', role: 'frame', function: 'The frame supports the equipment.', motion: 'None', components: ['Extrusion'] },
    ],
  });
  const subsystems = buildSubsystems(project, []);
  const door = subsystems.find((item) => /\bdoor\b/i.test(item.name));
  const frame = subsystems.find((item) => /frame and guarding/i.test(item.name));
  assert.ok(door, subsystems.map((item) => `${item.name}: ${item.purpose}`).join(' | '));
  assert.match(door.purpose, /operator access/i);
  assert.ok(frame);
  assert.equal(/operator access/i.test(frame.purpose), false);
  const html = renderHtml(buildDocument(project));
  assert.equal(/Clean the drive fan/.test(html), false);
  assert.equal(/Pocket002|LED_0603/.test(html), false);
  assert.equal(readablePartName('LED_0603_G_Pocket002'), '');
});

test('motion and guard text is not applied to static parts or control functions', () => {
  const crushing = { id: 'mech.crushing', hazard: 'Crushing points between moving and fixed parts (axes, clamps, lifts, press tooling).', applies_to_sections: ['product.subsystem_function'] };
  const air = { id: 'fluid.pneumatic_pressure', hazard: 'Compressed air can be stored in a line.', applies_to_sections: ['product.subsystem_function'] };
  const tangle = { id: 'mech.entanglement', hazard: 'Rotating parts can entangle.', applies_to_sections: ['product.subsystem_function'] };
  const conveyor = { name: 'Transfer Conveyor', role: 'process', components: ['Belt'], motions: ['The belt runs.'], groups: [], purpose: 'Carries trays.' };
  const control = { name: 'Cooker Sequence Master Control', role: 'process', components: [], motions: [], groups: [{ text: 'The control checks pressure and the axis command.' }], purpose: 'Coordinates the cooker. Watch the pressure and the axis.' };
  const nuts = { name: 'Nuts and Bolts', role: 'process', components: [], motions: [], groups: [], purpose: 'Fasteners hold the frame.' };
  assert.equal(hazardsForSubsystem([crushing, air, tangle], conveyor).some((item) => item.id === 'mech.crushing'), false);
  assert.ok(hazardsForSubsystem([crushing, air, tangle], conveyor).some((item) => item.id === 'mech.entanglement'));
  assert.equal(hazardsForSubsystem([crushing, air], control).length, 0);
  assert.equal(isStaticPart(nuts), true);
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'PCB Component', kind: '', role: 'process', leaf: false, description: 'PCB' },
    { name: 'Wheel', kind: 'robot', role: 'process', leaf: false, description: 'Wheel' },
  ];
  const html = renderHtml(buildDocument(project));
  const heading = html.indexOf('>Electronics and hardware</h2>');
  assert.ok(heading >= 0);
  const nutsBlock = html.slice(heading, heading + 1800);
  assert.equal(/Stay outside the guards while it moves/.test(nutsBlock), false);
  assert.match(nutsBlock, /None identified in the upload|does not move/);
});

test('troubleshooting is grounded and a drawing still has rows', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Barrier Conveyor V3', kind: 'conveyor', role: 'process', leaf: false, description: 'Barrier conveyor' },
    { name: 'End Cap', kind: 'frame', role: 'structure', leaf: false, description: 'End cap' },
  ];
  project.narrative = {
    modelSubsystems: [
      { name: 'Barrier Conveyor V3', role: 'process', function: 'The belt carries trays along the barrier.', motion: 'The belt runs.', components: ['Bracket', 'End Cap', 'Pulley'] },
    ],
  };
  const html = renderHtml(buildDocument(project));
  const troubleAt = html.indexOf('Troubleshooting guide</h2>');
  const trouble = html.slice(troubleAt, html.indexOf('Accidents, breakdowns</h2>', troubleAt));
  assert.equal(/does not move/i.test(trouble), false);
  assert.equal(/jammed, loose, or unpowered/i.test(trouble), false);
  assert.equal(/End Cap on /.test(trouble), false);
  assert.match(trouble, /NEEDS INPUT/);
  assert.equal(/does not start/.test(trouble), false);

  const dxf = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n2\n0\nLAYER\n2\nVisible\n70\n0\n0\nLAYER\n2\nSketch1\n70\n0\n0\nENDTAB\n0\nENDSEC\n0\nEOF\n`;
  return parseUploads([{ name: 'onlinerobotics_gripper.dxf', buffer: Buffer.from(dxf) }]).then((drawn) => {
    assert.equal(drawn.cad.assemblies.some((item) => /visible|sketch/i.test(item.name)), false);
    const drawnHtml = renderHtml(buildDocument(drawn));
    assert.equal(/<h2[^>]*>\s*Visible\s*</i.test(drawnHtml), false);
    assert.equal(/Sketch1/.test(drawnHtml), false);
    const drawnTrouble = drawnHtml.slice(drawnHtml.indexOf('Troubleshooting guide</h2>'), drawnHtml.indexOf('Accidents, breakdowns</h2>'));
    assert.match(drawnTrouble, /NEEDS INPUT/);
    assert.equal(/does not start/.test(drawnTrouble), false);
    assert.equal(/does not move/i.test(drawnTrouble), false);
  });
});

test('raw SCL and header metadata are not prose, and alarm codes stay ALM-n', async () => {
  const source = `
FUNCTION_BLOCK "FB_Demo"
AUTHOR : 'A.Schaefer'
{ S7_Optimized_Access := 'TRUE' }
VAR
  Motor : BOOL;
  Start : BOOL;
END_VAR
IF Start THEN
  Motor := TRUE;
END_IF;
END_FUNCTION_BLOCK
`;
  const project = await parseUploads([{ name: 'demo.scl', buffer: Buffer.from(source) }]);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const html = renderHtml(buildDocument(project));
  assert.equal(containsRawSource(html), false);
  assert.equal(/A\.Schaefer/.test(html), false);
  assert.equal(/\bEND_IF\b/.test(html), false);
  assert.equal(/\bAUTHOR\b/.test(html), false);
  assert.match(html, /The control/);

  const cooker = emptyProject();
  cooker.tags = [
    { name: 'ALM', description: 'Device Alarm', dataType: 'BOOL' },
    { name: 'Cfg_HH', description: 'Cfg high-high', dataType: 'REAL' },
    { name: 'Bypass_HMI', description: 'Alarms in Bypass', dataType: 'BOOL' },
  ];
  cooker.routines = [{
    name: 'Logic',
    type: 'RLL',
    program: 'Main',
    units: [{ index: 0, number: 0, kind: 'rung', text: 'XIC(ALM)OTE(ALM);', comment: 'Alarm' }],
    analysis: { groups: [], housekeeping: [], alarms: [] },
  }];
  analyzeRoutine(cooker.routines[0], cooker, null);
  cooker.routines[0].analysis.alarms = [
    { code: 'Device Alarm-1', text: 'Cooker 1 level high-high', cause: 'The level is too high.', remedy: 'Lower the level.', severity: 'Fault' },
    { code: 'Device Alarm-2', text: 'Cfg high-high', cause: 'Configuration value.', remedy: 'Edit the setpoint.', severity: 'Fault' },
    { code: 'Device Alarm-3', text: 'Alarms in Bypass', cause: 'An operator bypassed alarms.', remedy: 'Clear the bypass.', severity: 'Fault' },
    { code: 'W1', text: 'Cooker temperature warning', cause: 'The temperature is rising.', remedy: 'Watch the trend.', severity: 'Warning' },
  ];
  const alarmHtml = renderHtml(buildDocument(cooker));
  const alarms = alarmHtml.slice(alarmHtml.indexOf('Alarm and fault messages</h2>'), alarmHtml.indexOf('Troubleshooting guide</h2>'));
  assert.match(alarms, /Cooker 1 level high-high/);
  assert.equal(/ALM-\d+/.test(alarms), false);
  assert.equal(/Device Alarm/.test(alarms), false);
  assert.equal(sanitizeProse('ALM-1 is the first code.', cooker), 'ALM-1 is the first code.');
  assert.equal(/Cfg high-high|Alarms in Bypass/.test(alarms), false);
  assert.match(alarms, /Warning/);
  assert.match(alarms, /Watch the trend/);
  assert.equal(/keeps running and the warning stays on/.test(alarms), false);
  const supply = alarmHtml.slice(alarmHtml.indexOf('Information to supply</h2>'), alarmHtml.indexOf('About this manual</h2>'));
  assert.equal(/Supply the information for Control logic description/.test(supply), false);
});
