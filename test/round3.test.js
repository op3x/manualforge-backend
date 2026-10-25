const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeRoutine } = require('../lib/logic');
const { proseViolations, scrubField } = require('../lib/text');
const { buildSubsystems, namesClose } = require('../lib/subsystems');
const { applyEquipment } = require('../lib/ai');
const { readablePartName } = require('../lib/presentation');
const { emptyProject } = require('../lib/project');
const { parseUploads } = require('../lib/parsers');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { hazardsForSubsystem } = require('../lib/hazards');
const { corpusRoot } = require('./corpus-env');

const CIC_SENTENCE = 'Data Type Showcase Demonstration Routine: Demonstrates driving each supported data type between its limits.';
const GRFICS_SENTENCE = 'Product Flow Control Positioning Routine: Moves the flow-regulating device in small steps so measured product flow stays on target.';

test('ordinary Routine sentences are not identifier failures', () => {
  const project = emptyProject();
  project.tags = [{ name: 'WT_Level', description: 'cooker level', dataType: 'BOOL' }];
  const pad = 'padding ';
  const padded = `${pad.repeat(80)}${CIC_SENTENCE} ${GRFICS_SENTENCE} WT_Level stays in the sentence. ${pad.repeat(80)}`;
  const hits = proseViolations(padded, project);
  assert.equal(hits.some((hit) => /Routine\s*:/.test(hit) && !/WT_Level/.test(hit)), false);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /WT_Level/);
  assert.ok(hits[0].length < 160, hits[0]);
  assert.equal(hits[0].includes(pad.repeat(20)), false);

  const scrubbed = scrubField(padded, project);
  assert.equal(/WT_Level/i.test(scrubbed.text), false);
  assert.match(scrubbed.text, /Data Type Showcase Demonstration Routine: Demonstrates/);
  assert.match(scrubbed.text, /Product Flow Control Positioning Routine: Moves/);
  assert.ok(scrubbed.snippets.every((snippet) => snippet.length < 160));
  assert.equal(scrubbed.snippets.some((snippet) => snippet.includes(pad.repeat(20))), false);

  project.tags.push({ name: 'Start_PB', description: 'Start pushbutton', dataType: 'BOOL' });
  project.routines = [{
    name: 'DataTypeShowcase',
    type: 'RLL',
    program: 'Main',
    units: [{ index: 0, number: 0, kind: 'rung', text: 'XIC(Start_PB)OTE(WT_Level);', comment: 'Show the data types' }],
  }];
  analyzeRoutine(project.routines[0], project, null);
  project.routines[0].analysis.groups[0].text = `${CIC_SENTENCE} ${GRFICS_SENTENCE}`;
  project.narrative = {
    kind: 'machine',
    overview: `${CIC_SENTENCE} ${GRFICS_SENTENCE}`,
    cycle: 'The equipment runs its cycle.',
    productName: 'Example line',
  };
  const doc = buildDocument(project);
  const html = renderHtml(doc);
  assert.match(html, /Data Type Showcase Demonstration Routine: Demonstrates/);
  assert.match(html, /Product Flow Control Positioning Routine: Moves/);
  assert.equal(/WT_Level/.test(html.replace(/class="tagcol"[^>]*>[^<]*/g, '')), false);
  const logged = (project.warnings || []).join('\n');
  assert.equal(logged.includes(pad.repeat(20)), false);
  assert.ok((project.warnings || []).every((warning) => warning.length < 220));
});

test('empty part-number subsystems are dropped and static parts get no motion hazards', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Barrier Conveyor V3', kind: 'conveyor', role: 'process', leaf: false, description: 'Barrier conveyor' },
    { name: 'Component SB044685-01', kind: '', role: 'structure', leaf: false, description: 'Component SB044685-01' },
    { name: 'Complete Frame', kind: 'frame', role: 'structure', leaf: false, description: 'Frame' },
  ];
  project.narrative = {
    modelSubsystems: [
      { name: 'Component Sb044685-01', role: 'process', function: 'Structural component supporting the frame assembly.', components: ['None'], motion: 'None', sensors: 'None identified' },
      { name: 'Component Sb044686-01', role: 'process', function: 'Structural component supporting the frame assembly.' },
      { name: 'Barrier Conveyor V3', role: 'process', function: 'The belt carries trays.', motion: 'The belt runs.', components: ['Roller'] },
    ],
  };
  const subsystems = buildSubsystems(project, []);
  assert.equal(subsystems.some((item) => /component\s+sb/i.test(item.name)), false);
  const conveyor = subsystems.find((item) => /barrier conveyor/i.test(item.name));
  assert.ok(conveyor);
  assert.match(conveyor.purpose, /belt carries/i);
  const frame = subsystems.find((item) => /frame/i.test(item.name));
  assert.ok(frame);
  const hazards = [
    { id: 'mech.stability', hazard: 'Machine or modules not anchored, or unstable during assembly and dismantling.', applies_to_sections: ['install.mechanical'] },
    { id: 'mech.entanglement', hazard: 'Rotating spindles, shafts, rollers, belts, chains and conveyors.', applies_to_sections: ['product.subsystem_function'] },
    { id: 'ctrl.bypass', hazard: 'Guards or interlocks bypassed.', applies_to_sections: ['product.subsystem_function'] },
  ];
  assert.equal(hazardsForSubsystem(hazards, { name: 'Component Sb044685-01', role: 'process', purpose: 'Structural component supporting the frame assembly.', components: [], motions: [], groups: [] }).length, 0);
  assert.equal(hazardsForSubsystem(hazards, frame).some((item) => item.id === 'mech.stability' || item.id === 'mech.entanglement'), false);
  assert.ok(hazardsForSubsystem(hazards, conveyor).some((item) => item.id === 'mech.entanglement'));
  const html = renderHtml(buildDocument(project));
  assert.equal(/Component Sb/i.test(html), false);
  const theory = html.slice(html.indexOf('Machine description'), html.indexOf('Sequence of operation'));
  assert.equal(/Component Sb044685/.test(theory), false);
  const supply = html.slice(html.indexOf('Information to supply</h2>'), html.indexOf('About this manual</h2>'));
  assert.ok((supply.match(/Upload the PLC program/gi) || []).length <= 1);
  assert.equal((supply.match(/emergency-stop location/gi) || []).length, 0);
});

test('gripper functions stay attached and left and right wheels stay distinct', () => {
  assert.equal(namesClose('Gripper', 'Gripper V1'), false);
  assert.equal(namesClose('Left drive wheel', 'Right drive wheel'), false);
  assert.equal(namesClose('Pass-Through Conveyor', 'Pulley Top Side Pass Through Conveyor'), true);
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Gripper', kind: 'gripper', role: 'process', leaf: false, description: 'Gripper' },
    { name: 'Gripper V1', kind: 'gripper', role: 'process', leaf: false, description: 'Gripper V1' },
    { name: 'Left Drive Wheel', kind: 'robot', role: 'process', leaf: false, description: 'Left wheel' },
    { name: 'Right Drive Wheel', kind: 'robot', role: 'process', leaf: false, description: 'Right wheel' },
  ];
  applyEquipment(project, {
    subsystems: [
      { assembly: 'Gripper V1', name: 'Gripper V1', role: 'process', function: 'First revision of the gripper, providing the jaw mechanism that grasps the workpiece.', motion: 'The jaws close.', components: ['Jaw'] },
      { assembly: 'Gripper', name: 'Gripper', role: 'process', function: 'The gripper closes on the workpiece and releases it.', motion: 'The jaws close.', components: ['Jaw'] },
      { assembly: 'Pololu Multi Hub Wheel V2', name: 'Left drive wheel', role: 'process', function: 'The left wheel drives the platform.', motion: 'The wheel turns.', components: ['Wheel'] },
      { assembly: 'Pololu Multi Hub Wheel V2', name: 'Right drive wheel', role: 'process', function: 'The right wheel drives the platform.', motion: 'The wheel turns.', components: ['Wheel'] },
    ],
  });
  const gripper = project.cad.assemblies.find((item) => item.name === 'Gripper');
  const gripperV1 = project.cad.assemblies.find((item) => item.name === 'Gripper V1');
  assert.match(gripper.analysis.function, /closes on the workpiece/i);
  assert.match(gripperV1.analysis.function, /first revision/i);
  const subsystems = buildSubsystems(project, []);
  const shown = (pattern) => subsystems.find((item) => pattern.test(item.name));
  assert.match(shown(/^Gripper$/i).purpose, /closes on the workpiece/i);
  assert.match(shown(/Gripper V1/i).purpose, /first revision/i);
  assert.notEqual(normalize(shown(/Gripper V1/i).purpose), normalize('Gripper V1'));
  assert.ok(shown(/left/i));
  assert.ok(shown(/right/i));
  assert.match(shown(/left/i).purpose, /left wheel/i);
  assert.match(shown(/right/i).purpose, /right wheel/i);
  assert.equal(shown(/left/i).name.toLowerCase() === shown(/right/i).name.toLowerCase(), false);
});

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

test('part names and alarm reactions are readable and distinct', () => {
  assert.equal(/solid body/i.test(readablePartName('Component, solid body, part SB044685-01')), false);
  assert.equal(/^component\b/i.test(readablePartName('Component, solid body, part SB044685-01')), false);
  const shaft = readablePartName('Shaft Hollow 0 5 In OD 402 ID L');
  assert.match(shaft, /0\.5 in/i);
  assert.match(shaft, /0\.402/);
  assert.equal(/0 5/.test(shaft), false);

  const project = emptyProject();
  project.tags = [
    { name: 'Cooker_1_Level.high_high_alarm', description: 'Cooker 1 level high_high_alarm', dataType: 'BOOL' },
    { name: 'Start_PB', description: 'Start pushbutton', dataType: 'BOOL' },
  ];
  project.routines = [{
    name: 'Logic',
    type: 'RLL',
    program: 'Main',
    units: [{ index: 0, number: 0, kind: 'rung', text: 'XIC(Start_PB)OTE(Start_PB);', comment: 'Start' }],
    analysis: { groups: [], housekeeping: [], alarms: [] },
  }];
  analyzeRoutine(project.routines[0], project, null);
  project.routines[0].analysis.alarms = [
    { code: 'HH', text: 'Cooker 1 level high_high_alarm', cause: 'The level is too high.', remedy: 'Lower the level.', severity: 'Fault' },
    { code: 'high_high_alarm', text: 'Cooker 1 level HH', cause: 'The level is too high.', remedy: 'Lower the level.', severity: 'Fault' },
    { code: 'W1', text: 'Cooker 1 temperature warning', cause: 'The temperature is rising.', remedy: 'Watch the trend.', severity: 'Warning' },
  ];
  project.cad.assemblies = [
    { name: 'Cooker Vessel', kind: 'heater', role: 'process', leaf: false, description: 'Cooker vessel' },
    { name: 'Frame', kind: 'frame', role: 'structure', leaf: false, description: 'Frame' },
  ];
  project.narrative = {
    modelSubsystems: [
      { name: 'Cooker Vessel', role: 'process', function: 'The vessel heats the batch.', motion: 'The heater raises the temperature.', components: ['Heater', 'Probe'], sensors: ['Level sensor', 'Temperature sensor'] },
    ],
  };
  const html = renderHtml(buildDocument(project));
  const alarms = html.slice(html.indexOf('Alarm and fault messages</h2>'), html.indexOf('Troubleshooting guide</h2>'));
  assert.equal((alarms.match(/ALM-\d+/g) || []).length, 0);
  assert.equal(/high_high_alarm|\bHH\b/.test(alarms), false);
  assert.match(alarms, /Cooker 1 level high-high/);
  assert.match(alarms, /Lower the level/);
  assert.match(alarms, /Watch the trend/);
  assert.equal(/stops and stays stopped|keeps running and the warning stays on/.test(alarms), false);
  const troubleAt = html.indexOf('Troubleshooting guide</h2>');
  const trouble = html.slice(troubleAt, html.indexOf('Accidents, breakdowns</h2>', troubleAt));
  assert.equal(/Frame and guarding|Frame does not start/.test(trouble), false);
  assert.ok((trouble.match(/<tr>/g) || []).length > 4);
  const supply = html.slice(html.indexOf('Information to supply</h2>'), html.indexOf('About this manual</h2>'));
  assert.ok((supply.match(/Upload the PLC program/gi) || []).length <= 1);
});

test('a PLC ladder block is described with its equation', async () => {
  const graphical = `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <types><pous>
    <pou name="scale_to_signed" pouType="functionBlock">
      <body><LD>
        <block localId="3" typeName="DIV">
          <inputVariables>
            <variable formalParameter="IN1"><connectionPointIn><connection refLocalId="4"/></connectionPointIn></variable>
            <variable formalParameter="IN2"><connectionPointIn><connection refLocalId="5"/></connectionPointIn></variable>
          </inputVariables>
        </block>
        <inVariable localId="4"><expression>input_uint</expression></inVariable>
        <inVariable localId="5"><expression>2</expression></inVariable>
        <outVariable localId="7"><connectionPointIn><connection refLocalId="3" formalParameter="OUT"/></connectionPointIn><expression>output_int</expression></outVariable>
      </LD></body>
    </pou>
  </pous></types>
</project>`;
  const project = await parseUploads([{ name: 'scale.xml', buffer: Buffer.from(graphical) }]);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const html = renderHtml(buildDocument(project));
  assert.equal(/writes its result to the connected output/.test(html), false);
  assert.match(html, /is set to/);
  assert.match(html, /DIV/);
});

test('transfer chamber manuals do not publish empty component sections', { skip: !fs.existsSync(path.join(corpusRoot(), 'cad/creator_transfer_chamber_COMPLETE_FRAME_ASY.stp')) }, async () => {
  const file = path.join(corpusRoot(), 'cad/creator_transfer_chamber_COMPLETE_FRAME_ASY.stp');
  const project = await parseUploads([{ name: path.basename(file), buffer: fs.readFileSync(file) }]);
  const html = renderHtml(buildDocument(project));
  assert.equal(/Component Sb/i.test(html), false);
  assert.equal(/the device/i.test(html), false);
  const sections = html.split(/<h2 /).slice(1);
  const empty = sections.filter((section) => {
    const fields = section.match(/None identified in the upload\./g) || [];
    return fields.length >= 4 && /<h2 |^id=/.test('') === false && /fact/.test(section);
  });
  assert.equal(empty.length, 0);
});
