const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sanitizeProse, translateStructuredText } = require('../lib/text');
const { buildSubsystems } = require('../lib/subsystems');
const { applyEquipment, equipmentPrompt, contradictsEvidence } = require('../lib/ai');
const { alarmsOverlap } = require('../lib/presentation');
const { emptyProject } = require('../lib/project');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine, coverageOf } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { corpusRoot, corpusAvailable, corpusSkip } = require('./corpus-env');

test('dictionary routine names and template headings are not rewritten', () => {
  const project = {
    tags: [{ name: 'PLC', description: '' }, { name: 'WT_Level', description: 'cooker level' }],
    routines: [{ name: 'Logic', units: [], analysis: { groups: [] } }],
  };
  assert.equal(sanitizeProse('Control logic description', project), 'Control logic description');
  assert.equal(sanitizeProse('The PLC starts the Alarm after Logic runs', project), 'The PLC starts the Alarm after Logic runs');
  const replaced = sanitizeProse('WT_Level is high', project);
  assert.equal(replaced.includes('WT_Level'), false);
  assert.match(replaced, /level/i);
  assert.equal(/the device/i.test(sanitizeProse('Control logic description and the PLC', project)), false);
});

test('structured text keeps a less-than comparison', () => {
  const text = translateStructuredText('IF RangeSensor < desiredDistanceFill THEN Pump := 1;', new Map());
  assert.match(text, /less than/i);
  assert.equal(/greater than/i.test(text), false);
  assert.match(text, /pump/i);
});

test('an overview that reverses a group comparison is rejected', () => {
  const evidence = 'The control turns on the pump when the range sensor is less than the desired fill distance.';
  const inverted = 'If the measured distance is greater than the setpoint, the pump is on for the fill.';
  assert.equal(contradictsEvidence(inverted, evidence), true);
  const project = emptyProject();
  project.routines = [{
    name: 'Main',
    units: [],
    analysis: { groups: [{ text: evidence }] },
  }];
  project.narrative = {
    kind: 'process',
    overview: evidence,
    cycle: 'Fill while the measured distance is less than the desired fill distance, then stop the pump.',
    productName: '',
  };
  applyEquipment(project, {
    equipment_kind: 'process',
    overview: inverted,
    cycle: 'The pump runs when the distance is greater than the setpoint during the fill.',
    subsystems: [],
  });
  assert.match(project.narrative.overview, /less than/i);
  assert.equal(/greater than/i.test(`${project.narrative.overview} ${project.narrative.cycle}`), false);
});

test('model subsystems match on word overlap and unmatched ones are kept', () => {
  const project = emptyProject();
  project.cad.assemblies = [
    { name: 'Pulley Top Side Pass Through Conveyor', kind: 'conveyor', role: 'process', leaf: false, description: 'Pass through conveyor' },
    { name: 'Drive Train', kind: 'robot', role: 'process', leaf: false, description: 'Differential drive' },
  ];
  project.narrative = {
    modelSubsystems: [
      {
        name: 'Pass-Through Conveyor',
        role: 'process',
        function: 'The belt carries trays across the chamber.',
        motion: 'The belt runs.',
        sensors: 'None.',
        components: ['None.', 'Roller', 'None.'],
      },
      {
        name: 'Pass-Through Conveyor',
        role: 'process',
        function: 'The belt carries trays across the chamber.',
        sensors: 'None.',
        components: ['Roller'],
      },
      { name: 'Controller', role: 'process', function: 'The controller commands the base.', components: ['BeagleBone'] },
      { name: 'Battery', role: 'process', function: 'The battery supplies the base.', components: ['Battery pack'] },
    ],
  };
  const subsystems = buildSubsystems(project, []);
  const conveyor = subsystems.find((item) => /pass through conveyor/i.test(item.name));
  assert.ok(conveyor);
  assert.match(conveyor.purpose, /belt carries/i);
  assert.equal(conveyor.components.filter((item) => /roller/i.test(item)).length, 1);
  assert.equal(conveyor.sensors.some((item) => /^none/i.test(item)), false);
  assert.ok(subsystems.some((item) => /controller/i.test(item.name)));
  assert.ok(subsystems.some((item) => /battery/i.test(item.name)));
  const prompt = equipmentPrompt(project, project.cad.assemblies.map((item) => ({ name: item.name })), true);
  assert.match(prompt, /verbatim/);
  assert.match(prompt, /Pulley Top Side Pass Through Conveyor/);
  const doc = buildDocument(project);
  const html = renderHtml(doc);
  assert.equal(html.includes('None.;'), false);
});

test('alarms name the device, drop raw member codes, and troubleshooting is grouped', () => {
  assert.equal(alarmsOverlap(['HH', 'Cooker 1 level'], ['high_high_alarm', 'Cooker 1 level']), true);
  const project = emptyProject();
  project.tags = [
    { name: 'Cooker_1_Level.high_high_alarm', description: 'Cooker 1 level high_high_alarm', dataType: 'BOOL' },
  ];
  project.tags.push(
    { name: 'Start_PB', description: 'Start pushbutton', dataType: 'BOOL' },
    { name: 'Motor_Run', description: 'Motor run', dataType: 'BOOL' },
  );
  project.routines = [{
    name: 'Logic',
    type: 'RLL',
    program: 'Main',
    units: [{ index: 0, number: 0, kind: 'rung', text: 'XIC(Start_PB)OTE(Motor_Run);', comment: 'Start the motor when the button is on' }],
    analysis: { groups: [], housekeeping: [], alarms: [] },
  }];
  analyzeRoutine(project.routines[0], project, null);
  project.routines[0].analysis.alarms = [
    { code: 'HH', text: 'Cooker 1 level high_high_alarm', cause: 'The level is too high.', remedy: 'Lower the level.' },
    { code: 'high_high_alarm', text: 'Cooker 1 level HH', cause: 'The level is too high.', remedy: 'Lower the level.' },
  ];
  project.cad.assemblies = [
    { name: 'Cooker Vessel', kind: 'tank', role: 'process', leaf: false, description: 'Cooker vessel' },
  ];
  const doc = buildDocument(project);
  const html = renderHtml(doc);
  assert.match(html, /Control logic description/);
  assert.equal(/Control the device/.test(html), false);
  assert.match(html, /Cooker 1 level high-high/);
  assert.match(html, /stops and stays stopped/);
  const alarms = html.slice(html.indexOf('Alarm and fault messages</h2>'), html.indexOf('Troubleshooting guide</h2>'));
  assert.equal(/high_high_alarm|\bHH\b/.test(alarms), false);
  assert.equal((alarms.match(/Cooker 1 level high-high/g) || []).length, 1);
  assert.equal(/Read every rung|Upload the PLC program/i.test(html), false);
  const storage = html.match(/storage temperature/gi) || [];
  assert.equal(storage.length, 1);
  const troubleAt = html.indexOf('Troubleshooting guide</h2>');
  const trouble = html.slice(troubleAt, html.indexOf('Accidents, breakdowns</h2>', troubleAt));
  assert.match(trouble, /Subsystem/);
  assert.equal((trouble.match(/<tr>/g) || []).length >= 4, true);
});

test('Beremiz ladder blocks become units and an empty body fails', async () => {
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
        <contact localId="8"><expression>run_bit</expression></contact>
        <coil localId="9"><connectionPointIn><connection refLocalId="8"/></connectionPointIn><expression>pump</expression></coil>
      </LD></body>
    </pou>
  </pous></types>
</project>`;
  const project = await parseUploads([{ name: 'scale.xml', buffer: Buffer.from(graphical) }]);
  assert.equal(project.routines.length, 1);
  assert.ok(project.routines[0].units.length >= 3);
  const blob = project.routines[0].units.map((unit) => unit.text).join('\n');
  assert.match(blob, /DIV/);
  assert.match(blob, /input_uint/);
  assert.match(blob, /output_int/);
  assert.match(blob, /pump/);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  assert.equal(coverageOf(project).ok, true);

  const empty = `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0201">
  <types><pous><pou name="empty" pouType="program"><body><LD></LD></body></pou></pous></types>
</project>`;
  await assert.rejects(
    () => parseUploads([{ name: 'empty.xml', buffer: Buffer.from(empty) }]),
    (err) => err.status === 422 && err.expose === true && /empty/i.test(err.message),
  );
});

test('GRFICS ladder POUs are all counted', { skip: corpusSkip() }, async () => {
  const root = corpusRoot();
  assert.ok(corpusAvailable(root), 'MANUALOS_CORPUS is not set and no corpus manifest was found. CI must provide the corpus.');
  const file = path.join(root, 'plc/grfics_simplified_te_plcopen.xml');
  const project = await parseUploads([{ name: path.basename(file), buffer: fs.readFileSync(file) }]);
  assert.ok(project.routines.length >= 9);
  assert.equal(project.routines.every((routine) => routine.units.length > 0), true);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const coverage = coverageOf(project);
  assert.equal(coverage.ok, true);
  assert.ok(coverage.units >= 9);
});
