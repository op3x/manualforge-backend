const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { emptyProject } = require('../lib/project');
const { parseSt } = require('../lib/parsers/st');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { energyRows } = require('../lib/energy');
const { matchedHazards } = require('../lib/hazards');
const { equipmentMoves } = require('../lib/presentation');
const { corpusHas, corpusRoot } = require('./corpus-env');

function htmlOf(project) {
  for (const routine of project.routines || []) {
    if ((routine.units || []).length) analyzeRoutine(routine, project, null);
  }
  return renderHtml(buildDocument(project));
}

const PLANT_SCL = `
DATA_BLOCK "EmptyOne"
BEGIN
END_DATA_BLOCK
DATA_BLOCK "EmptyTwo"
BEGIN
END_DATA_BLOCK
FUNCTION "FC_Plant" : Void
BEGIN
"QX_MPO_M3_Saw_Q4" := TRUE;
"QX_MPO_Compressor_Q10" := TRUE;
"QX_MPO_M2_ConveyorBeltForward_Q3" := TRUE;
"QX_VGR_M1_VerticalAxisUp_Q1" := TRUE;
"QX_MPO_M1_TurnTableClockwise_Q1" := TRUE;
"IX_MPO_LightBarrierEndOfConBelt_I3" := FALSE;
"IX_VGR_RefSwitchVerticalAxis_I1" := FALSE;
END_FUNCTION
`;

test('SCL I/O symbols become tags, motion, air, the saw, and the I/O list', () => {
  const project = emptyProject();
  parseSt(project, PLANT_SCL, 'plant.scl');
  const names = new Set(project.tags.map((tag) => tag.name));
  assert.equal(names.has('QX_MPO_M3_Saw_Q4'), true);
  assert.equal(names.has('QX_MPO_Compressor_Q10'), true);
  assert.equal(names.has('IX_MPO_LightBarrierEndOfConBelt_I3'), true);
  assert.equal(project.tags.find((tag) => tag.name === 'QX_MPO_Compressor_Q10').direction, 'output');
  assert.equal(project.tags.find((tag) => tag.name === 'IX_VGR_RefSwitchVerticalAxis_I1').direction, 'input');
  assert.equal(equipmentMoves(project), true);
  assert.ok(energyRows(project).some((row) => row.energy === 'Pneumatic'));
  assert.ok(matchedHazards(project).some((hazard) => hazard.id === 'mech.shearing_cutting'));
  const html = htmlOf(project);
  assert.equal((html.match(/Export the block again as SCL/g) || []).length, 0);
  assert.match(html, /QX_MPO_M3_Saw_Q4/);
  assert.match(html, /Light barrier|Ref switch/i);
  assert.equal(/no guarded motion/i.test(html), false);
  assert.equal(/Nothing moves/i.test(html), false);
  const sensors = [...html.matchAll(/<td>Sensors<\/td><td>([^<]*)<\/td>/g)].map((match) => match[1]);
  assert.ok(sensors.some((cell) => /barrier|switch|sensor/i.test(cell)));
});

test('an export-as-SCL note is printed for one empty block, and never for an SCL file', () => {
  const scl = emptyProject();
  parseSt(scl, PLANT_SCL, 'plant.scl');
  assert.equal((htmlOf(scl).match(/Export the block again as SCL/g) || []).length, 0);

  const oneBlock = 'DATA_BLOCK "EmptyOne"\nBEGIN\nEND_DATA_BLOCK\n';
  const twoBlocks = `${oneBlock}DATA_BLOCK "EmptyTwo"\nBEGIN\nEND_DATA_BLOCK\n`;
  const copies = (name, source) => {
    const project = emptyProject();
    parseSt(project, source, name);
    return (htmlOf(project).match(/Export the block again as SCL/g) || []).length;
  };
  const once = copies('one.db', oneBlock);
  assert.ok(once >= 1);
  assert.equal(copies('two.db', twoBlocks), once);
});

test('a laser with no class gets its own hazard, PPE, and an interlock note', () => {
  const unknown = emptyProject();
  unknown.tags = [{ name: 'Marker_1', description: 'Laser marker marking head', dataType: 'BOOL' }];
  const unknownHtml = htmlOf(unknown);
  assert.match(unknownHtml, /Laser radiation\. Class: Please confirm\./);
  assert.match(unknownHtml, /Laser safety eyewear rated for the wavelength/);
  assert.match(unknownHtml, /laser interlock must stop the beam/);
  assert.equal(/Class 3B or Class 4/.test(unknownHtml), false);

  const known = emptyProject();
  known.tags = [{ name: 'Beam_1', description: 'Class 3B laser source', dataType: 'BOOL' }];
  const knownHtml = htmlOf(known);
  assert.match(knownHtml, /Class 3B or Class 4/);
  assert.equal(/Laser radiation\. Class: Please confirm\./.test(knownHtml), false);
  assert.match(knownHtml, /Laser safety eyewear rated for the wavelength/);
});

test('the cover keeps a free-text language and drops original instructions', () => {
  const spanish = emptyProject();
  spanish.identity.language = 'Spanish';
  assert.match(htmlOf(spanish), /<td>Language<\/td><td>Spanish<\/td>/);
  const original = emptyProject();
  original.identity.language = 'English (original instructions)';
  const html = htmlOf(original);
  assert.match(html, /<td>Language<\/td><td>English<\/td>/);
  assert.equal(/original instructions/i.test(html), false);
});

test('the fischertechnik SCL source lists its I/O symbols and does not deny motion', { skip: !corpusHas('plc/fischertechnik_TP_Main.scl') }, async () => {
  const buffer = fs.readFileSync(path.join(corpusRoot(), 'plc/fischertechnik_TP_Main.scl'));
  const project = await parseUploads([{ name: 'fischertechnik_TP_Main.scl', buffer }]);
  const io = project.tags.filter((tag) => /^(IX|QX|IW|QW)_/i.test(tag.name));
  const inputs = io.filter((tag) => tag.direction === 'input');
  const outputs = io.filter((tag) => tag.direction === 'output');
  assert.ok(io.length >= 80, `I/O symbols ${io.length}`);
  assert.ok(inputs.length >= 30, `inputs ${inputs.length}`);
  assert.ok(outputs.length >= 40, `outputs ${outputs.length}`);
  assert.equal(equipmentMoves(project), true);
  assert.ok(energyRows(project).some((row) => row.energy === 'Pneumatic'));
  assert.ok(matchedHazards(project).some((hazard) => hazard.id === 'mech.shearing_cutting'));
  const html = htmlOf(project);
  assert.equal((html.match(/Export the block again as SCL/g) || []).length, 0);
  assert.match(html, /Saw/);
  assert.match(html, /Compressor|Pneumatic/);
  assert.equal(/no guarded motion/i.test(html), false);
  assert.equal(/Nothing moves/i.test(html), false);
});

test('the mecco marker is a laser with the class left to confirm', { skip: !corpusHas('plc/mecco_laser_dotpeen_Eip_test.L5K') }, async () => {
  const buffer = fs.readFileSync(path.join(corpusRoot(), 'plc/mecco_laser_dotpeen_Eip_test.L5K'));
  const project = await parseUploads([{ name: 'mecco_laser_dotpeen_Eip_test.L5K', buffer }]);
  const html = htmlOf(project);
  assert.match(html, /Laser radiation\. Class: Please confirm\./);
  assert.match(html, /Laser safety eyewear rated for the wavelength/);
  assert.match(html, /laser interlock must stop the beam/);
  assert.equal(/Class 3B or Class 4/.test(html), false);
});
