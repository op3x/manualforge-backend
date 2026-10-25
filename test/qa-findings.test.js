const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { emptyProject } = require('../lib/project');
const { analyzeRoutine } = require('../lib/logic');
const { buildSubsystems } = require('../lib/subsystems');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { parseUploads } = require('../lib/parsers');
const { generateManual } = require('../lib/pipeline');
const { noMachineContent } = require('../lib/machine-content');
const { corpusHas, corpusRoot } = require('./corpus-env');

function htmlOf(project) {
  return renderHtml(buildDocument(project));
}

function sectionHtml(html, title) {
  const start = html.indexOf(`>${title}</h2>`);
  assert.ok(start >= 0, title);
  const next = html.indexOf('<h2', start + 10);
  return html.slice(start, next < 0 ? html.length : next);
}

function withLogic(tags, comment = 'Start the sequence') {
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

test('tags without routines do not become stations named from prefixes', () => {
  const project = emptyProject();
  project.tags = [
    { name: 'Enet_1', description: 'Ethernet status', dataType: 'BOOL' },
    { name: 'Agi_Run', description: 'Agitator running', dataType: 'BOOL' },
    { name: 'Xfv_1', description: 'Transfer valve open', dataType: 'BOOL' },
    { name: 'Spare_1', description: 'Spare signal', dataType: 'BOOL' },
  ];
  const subsystems = buildSubsystems(project, []);
  assert.equal(subsystems.length, 0);
  assert.equal(subsystems.some((item) => /^(Enet|Agi|Xfv|Signals)$/i.test(item.name)), false);
  const html = htmlOf(project);
  const sequence = sectionHtml(html, 'Sequence of operation');
  const overview = sectionHtml(html, 'What the machine does');
  assert.match(sequence, /No program logic found/);
  assert.match(overview, /No program logic found/);
  assert.equal(/Enet|Agi|Xfv|Signals/.test(sequence), false);
  assert.equal(/That station has finished/.test(sequence), false);
  assert.equal(/<li>/.test(sequence), false);
});

test('brewery tag export with no routines does not invent prefix stations', { skip: !corpusHas('plc/brewery_PLC100_Mashing_COMPLETE.L5X') }, async () => {
  const file = path.join(corpusRoot(), 'plc/brewery_PLC100_Mashing_COMPLETE.L5X');
  const project = await parseUploads([{ name: 'brewery_PLC100_Mashing_COMPLETE.L5X', buffer: fs.readFileSync(file) }]);
  assert.equal(project.routines.some((routine) => (routine.units || []).length), false);
  assert.ok(project.tags.length > 0);
  const names = buildSubsystems(project, []).map((item) => item.name);
  assert.equal(names.some((name) => /^(Enet|Agi|Xfv|Signals)$/i.test(name)), false, names.join(', '));
  const sequence = sectionHtml(htmlOf(project), 'Sequence of operation');
  assert.match(sequence, /No program logic found/);
  assert.equal(/That station has finished/.test(sequence), false);
});

test('each subsystem keeps its own component and sensor', async () => {
  const csv = [
    'Tag,Description,Device',
    'Heater #1,Heater,Heater',
    'Door_SW*,Door switch,Door',
    'Fan°1,Cooling fan,Fan',
    'Pump@A,Transfer pump,Pump',
  ].join('\n');
  const project = await parseUploads([{ name: 'sparse_odd_chars_tags.csv', buffer: Buffer.from(csv) }]);
  project.narrative = {
    kind: 'machine',
    modelSubsystems: [
      { name: 'Fan', function: 'The fan moves air through the cabinet.', components: ['Cooling fan'], sensors: [] },
      { name: 'Pump', function: 'The pump transfers the fluid.', components: ['Transfer pump'], sensors: [] },
      { name: 'Heater', function: 'The heater raises the batch temperature.', components: ['Heater'], sensors: [] },
      { name: 'Door', function: 'The door opens for access.', components: ['Hinge'], sensors: ['Door switch'] },
    ],
  };
  const subsystems = buildSubsystems(project, []);
  const named = (pattern) => subsystems.find((item) => pattern.test(item.name));
  const fan = named(/^fan$/i);
  const pump = named(/^pump$/i);
  const heater = named(/^heater$/i);
  const door = named(/^door$/i);
  assert.ok(fan && pump && heater && door, subsystems.map((item) => item.name).join(', '));
  assert.match(fan.components.join(' '), /fan/i);
  assert.equal(fan.components.some((item) => /heater/i.test(item)), false);
  assert.equal(fan.sensors.some((item) => /door switch/i.test(item)), false);
  assert.match(pump.components.join(' '), /pump/i);
  assert.equal(pump.components.some((item) => /heater/i.test(item)), false);
  assert.equal(pump.sensors.some((item) => /door switch/i.test(item)), false);
  assert.match(heater.components.join(' '), /heater/i);
  assert.equal(heater.sensors.some((item) => /door switch/i.test(item)), false);
  assert.match(door.sensors.join(' '), /door switch/i);
  assert.equal(door.components.some((item) => /heater/i.test(item)), false);
  const html = htmlOf(project);
  const fanBlock = sectionHtml(html, 'Fan');
  assert.match(fanBlock, /Cooling fan/);
  assert.equal(/This part does not move/.test(fanBlock), false);
  assert.equal(/Heater/.test(fanBlock), false);
  assert.equal(/Door switch/.test(fanBlock), false);
  const pumpBlock = sectionHtml(html, 'Pump');
  assert.equal(/Heater/.test(pumpBlock), false);
  assert.equal(/Door switch/.test(pumpBlock), false);
});

const NEMA_STEP = `ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1=PRODUCT('Nema 17','Nema 17','',());
#2=PRODUCT_DEFINITION_FORMATION('','',#1);
#3=PRODUCT_DEFINITION('design','',#2,#9);
#4=PRODUCT('Body','Body','',());
#5=PRODUCT_DEFINITION_FORMATION('','',#4);
#6=PRODUCT_DEFINITION('design','',#5,#9);
#10=NEXT_ASSEMBLY_USAGE_OCCURRENCE('nauo','placement','',#3,#6);
#20=MANIFOLD_SOLID_BREP('body',#21);
ENDSEC;
END-ISO-10303-21;
`;

test('a NEMA 23 file whose model is labelled Nema 17 flags the conflict', async () => {
  const project = await parseUploads([{ name: 'freecadlib_NEMA23_stepper.step', buffer: Buffer.from(NEMA_STEP) }]);
  assert.match(project.identity.productName, /NEMA 23/);
  assert.match(project.warnings.join('\n'), /The file name says NEMA 23, and the model is labelled "Nema 17"/);
  const html = htmlOf(project);
  assert.match(html, /NEMA 23/);
  assert.match(html, />Nema 17</);
  assert.match(html, /The file name says NEMA 23, and the model is labelled (?:&quot;|")Nema 17(?:&quot;|")\. Confirm which name is correct\./);
  const motor = sectionHtml(html, 'Nema 17');
  assert.match(motor, /Confirm which name is correct/);
});

test('the NEMA 23 corpus model flags a Nema 17 label', { skip: !corpusHas('cad/freecadlib_NEMA23_stepper.step') }, async () => {
  const file = path.join(corpusRoot(), 'cad/freecadlib_NEMA23_stepper.step');
  const project = await parseUploads([{ name: 'freecadlib_NEMA23_stepper.step', buffer: fs.readFileSync(file) }]);
  const html = htmlOf(project);
  assert.match(html, /NEMA 23/);
  assert.match(html, /The file name says NEMA 23/);
  assert.match(html, /Nema 17/);
  assert.match(html, /Confirm which name is correct/);
});

test('published chapters and sections are numbered without gaps', () => {
  const project = withLogic([
    { name: 'Motor_Run', description: 'Feeder motor', dataType: 'BOOL' },
  ]);
  const doc = buildDocument(project);
  assert.equal(doc.chapters.some((chapter) => chapter.title === 'Controls and HMI'), false);
  assert.equal(doc.chapters.some((chapter) => chapter.title === 'Spare parts'), false);
  const numbers = doc.chapters.map((chapter) => chapter.number);
  assert.deepEqual(numbers, numbers.map((_, index) => String(index)));
  for (const chapter of doc.chapters) {
    chapter.sections.forEach((section, index) => {
      assert.equal(section.number, `${chapter.number}.${index + 1}`);
    });
  }
  const commissioning = doc.chapters.find((chapter) => chapter.title.startsWith('Commissioning'));
  const operation = doc.chapters.find((chapter) => chapter.title === 'Operation');
  const maintenance = doc.chapters.find((chapter) => chapter.title === 'Maintenance');
  const decommission = doc.chapters.find((chapter) => chapter.title.startsWith('Decommissioning'));
  assert.ok(commissioning && operation && maintenance && decommission);
  assert.equal(Number(operation.number), Number(commissioning.number) + 1);
  assert.equal(Number(decommission.number), Number(maintenance.number) + 1);
  const html = renderHtml(doc);
  const headings = [...html.matchAll(/<h1[^>]*>\s*<span class="num">([^<]*)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(headings, numbers);
  const toc = [...html.matchAll(/<span class="tn">([^<]*)<\/span>/g)].map((match) => match[1]);
  const chapterToc = toc.filter((value) => /^\d+$/.test(value));
  assert.deepEqual(chapterToc, numbers);
});

function gearDxf() {
  return [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '2',
    '0', 'LAYER', '2', 'Gears', '70', '0',
    '0', 'LAYER', '2', 'Title', '70', '0',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'CIRCLE', '8', 'Gears', '10', '0', '20', '0', '40', '12',
    '0', 'LINE', '8', 'Gears', '10', '0', '20', '0', '11', '20', '21', '0',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n');
}

test('a 2D drawing with no machine content is flagged before any model call', async () => {
  const project = await parseUploads([{ name: 'cadzinho_gears.dxf', buffer: Buffer.from(gearDxf()) }]);
  assert.equal(project.cad.assemblies.length, 0);
  assert.ok(project.cad.layers.length > 0);
  assert.equal(noMachineContent(project), true);
  const calls = [];
  const result = await generateManual({
    project,
    anthropic: { messages: { create: async () => { calls.push(1); return { content: [{ type: 'text', text: '{}' }] }; } } },
    env: process.env,
    renderPdf: async () => Buffer.from('%PDF-1.4\n'),
  });
  assert.equal(result.noMachineContent, true);
  assert.equal(calls.length, 0);
  const machine = withLogic([{ name: 'Motor_Run', description: 'Feeder motor', dataType: 'BOOL' }]);
  machine.sources = [{ name: 'line.L5X', format: 'l5x' }];
  assert.equal(noMachineContent(machine), false);
});

test('gear drawings in the corpus are not machine content', { skip: !corpusHas('cad/cadzinho_gears.dxf') }, async () => {
  const file = path.join(corpusRoot(), 'cad/cadzinho_gears.dxf');
  const project = await parseUploads([{ name: 'cadzinho_gears.dxf', buffer: fs.readFileSync(file) }]);
  assert.equal(noMachineContent(project), true);
  assert.equal(project.cad.assemblies.length, 0);
});
