const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine, coverageOf } = require('../lib/logic');

const { corpusRoot, corpusAvailable, corpusSkip } = require('./corpus-env');
const ROOT = corpusRoot();
const hasCorpus = corpusAvailable(ROOT);

async function load(rel) {
  assert.ok(hasCorpus, 'MANUALOS_CORPUS is not set and no corpus manifest was found. CI must provide the corpus.');
  const buffer = fs.readFileSync(path.join(ROOT, rel));
  return parseUploads([{ name: path.basename(rel), buffer }]);
}

test('L5X keeps AOI routines, languages, aliases, and full coverage', { skip: corpusSkip(ROOT) }, async () => {
  assert.ok(hasCorpus, 'MANUALOS_CORPUS is not set and no corpus manifest was found. CI must provide the corpus.');
  const project = await load('plc/acd_ACDTestsWithAOI.L5X');
  assert.equal(project.routines.length, 5);
  assert.equal(project.aois.length, 1);
  const types = project.routines.map((routine) => routine.type).sort();
  assert.deepEqual(types, ['FBD', 'RLL', 'RLL', 'SFC', 'ST']);
  assert.equal(project.routines.some((routine) => routine.aoi && routine.scopeKey.endsWith('/Logic')), true);
  assert.equal(project.tags.some((tag) => tag.aliasFor), true);
  assert.equal(project.tags.some((tag) => tag.description), true);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const coverage = coverageOf(project);
  assert.equal(coverage.ok, true);
  assert.equal(coverage.accounted, coverage.units);
  assert.ok(coverage.units >= 4);
});

test('duplicate routine names stay distinct and safety tasks are flagged', { skip: corpusSkip(ROOT) }, async () => {
  const project = await load('plc/emulator_Plc_emulator.L5X');
  assert.equal(project.routines.length, 58);
  assert.ok(project.safetyPrograms.length > 0);
  assert.ok(project.safetyTasks.length > 0);
  const logic = project.routines.filter((routine) => routine.name === 'Logic');
  assert.ok(logic.length > 1);
  assert.equal(new Set(logic.map((routine) => routine.scopeKey)).size, logic.length);
});

test('Cooker AutoLogic keeps every program routine and AOI', { skip: corpusSkip(ROOT) }, async () => {
  const project = await load('plc/brewery_Cooker_1_AutoLogic_Program.L5X');
  assert.equal(project.routines.length, 15);
  assert.equal(project.aois.length, 4);
  const units = project.routines.reduce((sum, routine) => sum + routine.units.length, 0);
  assert.ok(units >= 432);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  assert.equal(coverageOf(project).ok, true);
});

test('STEP assembly records bodies, units, and part-number names', { skip: corpusSkip(ROOT) }, async () => {
  const frame = await load('cad/creator_transfer_chamber_COMPLETE_FRAME_ASY.stp');
  assert.equal(frame.cad.bodyCount, 111);
  assert.equal(frame.cad.lengthUnit, 'mm');
  assert.ok(frame.cad.assemblyLinks >= 200);
  assert.match(frame.identity.productName, /Transfer Chamber Frame/);
  assert.match(frame.cad.drawingName, /COMPLETE FRAME ASY/);
  assert.ok(frame.cad.bom.some((part) => part.qty > 1));
  assert.equal(frame.cad.bom.some((part) => /COMPLETE FRAME ASY/i.test(part.partNumber) || /COMPLETE FRAME ASY/i.test(part.description)), false);
  assert.equal(frame.cad.bom.some((part) => /NEEDS INPUT/.test(part.description)), false);
  const inch = await load('cad/nist_ftc_08_asme1_rc.stp');
  assert.equal(inch.cad.lengthUnit, 'inch');
  const motor = await load('cad/freecadlib_NEMA23_stepper.step');
  assert.match(motor.identity.productName, /NEMA 23/);
  assert.match(motor.warnings.join(' '), /NEMA 23/);
});

test('DXF title block records drawing units', { skip: corpusSkip(ROOT) }, async () => {
  const project = await load('cad/cadzinho_title_a1.dxf');
  assert.equal(project.cad.lengthUnit, 'mm');
  assert.ok(project.cad.assemblies.length || project.cad.titleBlock.length);
});

test('rejects XXE, mismatched content, and zip paths without reading secrets', async () => {
  const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><RSLogix5000Content><Controller Name="&xxe;"></Controller></RSLogix5000Content>`;
  await assert.rejects(
    () => parseUploads([{ name: 'bad.L5X', buffer: Buffer.from(xxe) }]),
    (err) => err.status === 422 && !String(err.message).includes('/etc/passwd'),
  );
  await assert.rejects(
    () => parseUploads([{ name: 'notes.L5X', buffer: Buffer.from('this is not a controller export') }]),
    (err) => err.status === 415,
  );
  const zip = new AdmZip();
  zip.addFile('secret.L5X', Buffer.from('nope'));
  zip.getEntries()[0].entryName = '../secret.L5X';
  await assert.rejects(
    () => parseUploads([{ name: 'pack.zip', buffer: zip.toBuffer() }]),
    (err) => err.status === 400 && /path/i.test(err.message),
  );
  const bomb = new AdmZip();
  bomb.addFile('big.L5X', Buffer.alloc(8000, 0x41));
  await assert.rejects(
    () => parseUploads([{ name: 'bomb.zip', buffer: bomb.toBuffer() }], {}, { MANUALOS_ZIP_MAX_BYTES: '1000' }),
    (err) => err.status === 400 && /expands too far/i.test(err.message),
  );
});

test('ACD advice is limited to ACD files and does not invent routine names', { skip: corpusSkip(ROOT) }, async () => {
  const project = await load('plc/acd_CuteLogix.ACD');
  assert.equal(project.acdLimited, true);
  assert.equal(project.routines.some((routine) => /FloatingElement|CommentManager/.test(routine.name)), false);
  assert.equal(project.routines.every((routine) => routine.units.length === 0), true);
});
