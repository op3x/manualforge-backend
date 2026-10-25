const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, PDFName } = require('pdf-lib');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { energyTable, controlPoints } = require('../lib/documents/equipment');
const { buildPmSchedule, buildShutdown, buildStartup, buildCustomDocument, TROUBLE_SKIP } = require('../lib/documents/content');
const { mergePdfs } = require('../lib/documents/files');
const { requestsExtras, selectionFromRequest } = require('../lib/documents/selection');

const COOKER = path.join(__dirname, 'fixtures/corpus/plc/brewery_Cooker_1_AutoLogic_Program.L5X');
const ACD = path.join(__dirname, 'fixtures/corpus/plc/acd_CuteLogix.ACD');
const STEP = '/cursor/stores/bot/manualos-test-corpus/cad/freecadlib_NEMA23_stepper.step';
const VALVE = path.join(__dirname, 'fixtures/formats/tia_LAD_Valve.xml');

function htmlOf(doc) {
  return renderHtml(doc);
}

async function load(file, name) {
  const buffer = fs.readFileSync(file);
  return parseUploads([{ originalname: name, buffer }], {}, { NODE_ENV: 'test' });
}

function energies(project) {
  return energyTable(project).map((row) => row[0]);
}

test('cooker shutdown and the manual share one energy list', async () => {
  const project = await load(COOKER, 'brewery_Cooker_1_AutoLogic_Program.L5X');
  const names = energies(project);
  assert.ok(names.includes('Electrical'));
  assert.ok(names.includes('Steam or heat'));
  assert.ok(names.includes('Process fluid'));
  assert.ok(names.includes('Rotating agitator'));
  assert.equal(names.includes('Pneumatic'), false);
  const shutdown = htmlOf(buildShutdown(project, {}));
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const manual = renderHtml(buildDocument(project));
  for (const name of names) {
    assert.match(shutdown, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(manual, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.equal(/Compressed air/i.test(shutdown), false);
  assert.equal(/Compressed air/i.test(manual), false);
  const steps = shutdown.slice(shutdown.lastIndexOf('<ol class="steps">'));
  const stopAgitator = steps.search(/Stop the agitator and confirm it is no longer turning before you isolate/);
  const closeSteam = steps.search(/Close the steam supply valve/);
  const confirmClosed = steps.search(/Confirm the steam supply valve is closed/);
  const cool = steps.search(/have cooled/);
  const vent = steps.search(/Vent residual steam pressure/);
  const lock = steps.search(/Switch off and lock/);
  assert.ok(stopAgitator > 0 && stopAgitator < lock);
  assert.ok(closeSteam > stopAgitator && closeSteam < lock);
  assert.ok(confirmClosed > closeSteam && confirmClosed < lock);
  assert.ok(cool > confirmClosed && cool < lock);
  assert.ok(vent > cool && vent < lock);
  assert.match(shutdown, /cook sequence advances transfer steps/i);
  assert.equal(/EStop/.test(shutdown), false);
  assert.equal(/Close Interlock/.test(shutdown), false);
});

test('cooker maintenance, alarms, and parts stay specific', async () => {
  const project = await load(COOKER, 'brewery_Cooker_1_AutoLogic_Program.L5X');
  const pm = htmlOf(buildPmSchedule(project, {}));
  assert.match(pm, /steam traps/i);
  assert.match(pm, /steam supply valve/i);
  assert.match(pm, /temperature probe/i);
  assert.match(pm, /agitator/i);
  assert.match(pm, /pump/i);
  assert.match(pm, /water valves/i);
  assert.equal(/Walk the work area/.test(pm), false);
  assert.equal(/Listen to/.test(pm), false);
  assert.equal(/Requesting Grain|Dust Collector|Scenario \d/i.test(pm), false);
  assert.equal((pm.match(/<section class="chapter">/g) || []).length, 1);
  assert.equal(/Daily tasks|Weekly tasks|Run-hour tasks/.test(pm), false);
  assert.equal((pm.match(/Inspect the steam supply valve/g) || []).length, 1);
  assert.match(pm, /1000-PM/);
  assert.equal(/class="maker"/.test(pm), false);
  assert.equal(/<td>Model<\/td>/.test(pm), false);
  assert.equal((pm.match(/does not repeat that description/g) || []).length, 1);
  assert.equal(/The control fills, holds, and discharges/.test(pm), false);

  const points = controlPoints(project);
  assert.equal(points.stops.length <= 1, true);
  assert.equal(points.resets.length <= 1, true);
  assert.equal(points.starts.length <= 1, true);
  assert.equal(points.estops.some((label) => label === 'EStop'), false);
  assert.equal(points.resets.some((label) => /alarm/i.test(label)), false);

  const guide = htmlOf(buildCustomDocument(project, {
    id: 'custom_1',
    title: 'Alarm and Troubleshooting Guide',
    kind: 'troubleshooting',
    customKind: 'troubleshooting',
  }, {}));
  assert.equal(/High high/i.test(guide), false);
  assert.equal(/Control Logic Rung|Lit-2045/i.test(guide), false);
  assert.match(guide, /temperature is high/i);
  assert.match(guide, /steam/i);
  assert.equal((guide.match(/does not repeat that description/g) || []).length, 1);

  const parts = htmlOf(buildCustomDocument(project, {
    id: 'custom_2',
    title: 'Spare Parts List',
    kind: 'parts',
    customKind: 'parts',
  }, {}));
  assert.match(parts, /Part number/);
  assert.equal(/High High Alarm/.test(parts), false);
  assert.equal(/Alarm Reset/.test(parts), false);
});

test('a valve actuator is pneumatic, and empty logic is skipped', async () => {
  const valve = await load(VALVE, 'tia_LAD_Valve.xml');
  const names = energies(valve);
  assert.ok(names.includes('Pneumatic'));
  assert.ok(names.length > 1);
  const shutdown = htmlOf(buildShutdown(valve, {}));
  assert.match(shutdown, /Pneumatic/);
  assert.match(shutdown, /Exhaust residual air/);
  const guide = buildCustomDocument(valve, {
    id: 'custom_1',
    title: 'Alarm and Troubleshooting Guide',
    kind: 'troubleshooting',
    customKind: 'troubleshooting',
  }, {});
  assert.equal(guide.skipped, undefined);
  assert.match(htmlOf(guide), /did not leave the closed position/i);

  const acd = await load(ACD, 'CuteLogix.ACD');
  const skipped = buildCustomDocument(acd, {
    id: 'custom_1',
    title: 'Alarm and Troubleshooting Guide',
    kind: 'troubleshooting',
    customKind: 'troubleshooting',
  }, {});
  assert.equal(skipped.skipped, TROUBLE_SKIP);
});

test('STEP parts merge instance suffixes and requested names split on commas', { skip: fs.existsSync(STEP) ? false : 'private CAD corpus is not in this checkout' }, async () => {
  const project = await load(STEP, 'NEMA23.step');
  const parts = htmlOf(buildCustomDocument(project, {
    id: 'custom_1',
    title: 'Spare Parts List',
    kind: 'parts',
    customKind: 'parts',
  }, {}));
  assert.match(parts, /Part number/);
  assert.equal(/Body001/.test(parts), false);
  assert.equal(/Screw009/.test(parts), false);
  assert.equal(/rear001/i.test(parts), false);
  assert.equal(/solid body/i.test(parts), false);
  assert.match(parts, /Screw/);
  const screw = parts.match(/Screw<\/td><td>[^<]*<\/td><td>(\d+)/);
  assert.ok(screw && Number(screw[1]) > 1, parts);
  const trouble = buildCustomDocument(project, {
    id: 'custom_2',
    title: 'Alarm and Troubleshooting Guide',
    kind: 'troubleshooting',
    customKind: 'troubleshooting',
  }, {});
  assert.equal(trouble.skipped, TROUBLE_SKIP);

  const selected = selectionFromRequest({
    body: { requested_documents: 'alarm and troubleshooting guide, spare parts list' },
  });
  assert.deepEqual(selected.entries.map((entry) => entry.kind), ['manual', 'troubleshooting', 'parts']);
  assert.throws(() => requestsExtras({ body: { documents: '["brochure"]' } }), (err) => err.status === 400);
});

test('a combined PDF has a contents page, bookmarks, and continuous page numbers', async () => {
  const left = await PDFDocument.create();
  left.addPage([612, 792]);
  const right = await PDFDocument.create();
  right.addPage([612, 792]);
  right.addPage([612, 792]);
  const merged = await mergePdfs(
    [Buffer.from(await left.save()), Buffer.from(await right.save())],
    ['Shutdown Procedure', 'Startup Procedure'],
  );
  const pdf = await PDFDocument.load(merged);
  assert.equal(pdf.getPageCount(), 4);
  assert.ok(pdf.catalog.get(PDFName.of('Outlines')));
  const text = decodedPdfText(pdf);
  assert.match(text, /Contents/);
  assert.match(text, /Shutdown Procedure/);
  assert.match(text, /Startup Procedure/);
  assert.match(text, /Page 1 of 4/);
  assert.match(text, /Page 4 of 4/);
  const titles = outlineTitles(pdf);
  assert.ok(titles.includes('Contents'));
  assert.ok(titles.includes('Shutdown Procedure'));
  assert.ok(titles.includes('Startup Procedure'));
});

function decodedPdfText(pdf) {
  const parts = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!object || !object.contents) continue;
    const raw = Buffer.from(object.contents);
    if (raw.length >= 2 && raw[0] === 0x78) {
      try {
        parts.push(zlib.inflateSync(raw).toString('latin1'));
        continue;
      } catch {
        // Fall through to the stored bytes when the stream is not deflate.
      }
    }
    parts.push(raw.toString('latin1'));
  }
  return parts.join('\n').replace(/<([0-9A-Fa-f\s]+)>/g, (_, hex) => {
    const digits = hex.replace(/\s+/g, '');
    let text = '';
    for (let index = 0; index + 1 < digits.length; index += 2) {
      text += String.fromCharCode(parseInt(digits.slice(index, index + 2), 16));
    }
    return text;
  });
}

function outlineTitles(pdf) {
  const titles = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    const title = object && object.dict && object.dict.get && object.dict.get(PDFName.of('Title'));
    if (title && typeof title.decodeText === 'function') titles.push(title.decodeText());
  }
  return titles;
}

test('cell startup warns that homing releases the brake', async () => {
  const project = await load(path.join(__dirname, 'fixtures/cell.scl'), 'cell.scl');
  const startup = htmlOf(buildStartup(project, {}));
  assert.match(startup, /releases the lift brake/);
  assert.match(startup, /Block the load before you request homing/);
  const points = controlPoints(project);
  assert.deepEqual(points.stops, ['Normal stop button']);
  assert.deepEqual(points.resets, ['Fault reset button']);
  assert.deepEqual(points.starts, ['Operator start button']);
  assert.equal(points.estops.length, 1);
});
