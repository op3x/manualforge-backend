const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine } = require('../lib/logic');
const { analyzeProject } = require('../lib/ai');
const { emptyProject } = require('../lib/project');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { formatRange, cleanAlarm, alarmsOverlap, uniqueSentences, polishName } = require('../lib/presentation');

test('ranges merge and alarms drop rulers and truncated codes', () => {
  assert.equal(formatRange([0, 1, 2, 11, 12, 13, 14, 15, 16, 27, 28, 29], 'statement'), 'Statements 0-2, 11-16, 27-29');
  const merged = formatRange([0, 1, 2, 3, 11, 12, 13, 14, 15], 'statement');
  assert.equal(merged.includes('0-3') && merged.includes('11-15'), true);
  assert.equal(formatRange([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'statement'), 'Statements 0-15');
  const cleaned = cleanAlarm({ code: 'ALM-100', text: '------- Guard open', cause: 'Set to 1 if PV is Already Scaled' });
  assert.equal(cleaned.code, 'ALM-100');
  assert.equal(/----|Set to 1/.test(`${cleaned.text} ${cleaned.cause}`), false);
  assert.equal(alarmsOverlap(['—', 'Guard open during the cycle'], ['ALM', 'Guard open during the cycle']), true);
  assert.equal(uniqueSentences('The Fahrenheit selection is active. The Fahrenheit selection is active.'), 'The Fahrenheit selection is active.');
  assert.equal(polishName('conveyor Shaft Barrier conveyor'), 'Conveyor Shaft Barrier');
});

test('a CAD manual describes motion and does not treat the frame as a product stage', async () => {
  const root = process.env.MANUALOS_CORPUS || '/cursor/stores/bot/manualos-test-corpus/';
  const file = path.join(root, 'cad/creator_transfer_chamber_COMPLETE_FRAME_ASY.stp');
  if (!fs.existsSync(file)) return;
  const project = await parseUploads([{ name: 'creator_transfer_chamber_COMPLETE_FRAME_ASY.stp', buffer: fs.readFileSync(file) }]);
  const doc = buildDocument(project);
  const html = renderHtml(doc);
  assert.match(doc.meta.headerRight, /Rev\./);
  assert.equal(/NEEDS INPUT/.test(doc.meta.headerRight + doc.meta.footerLeft), false);
  assert.equal(/carries the product through these stages/i.test(html), false);
  assert.match(html, /does not move|supports the equipment|not a process/i);
  assert.match(html, /Information to supply/);
  assert.match(html, /Figure 1\./);
  assert.equal((html.match(/Inferred - please confirm\./g) || []).length < 20, true);
  assert.equal(project.cad.assemblies.some((item) => !item.leaf && item.role === 'process' && /bracket|acrylic|panel|screw|extrusion|fastener/i.test(item.name)), false);
  const flow = html.slice(html.indexOf('Machine layout'), html.indexOf('Main assemblies'));
  assert.equal(/Product flow/.test(flow), false);
});

test('calculation logic is not described as a packaging line', async () => {
  const root = process.env.MANUALOS_CORPUS || '/cursor/stores/bot/manualos-test-corpus/';
  const file = path.join(root, 'plc/rockwell_WetBulbTemperature_AOI.L5X');
  if (!fs.existsSync(file)) return;
  const project = await parseUploads([{ name: path.basename(file), buffer: fs.readFileSync(file) }]);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const doc = buildDocument(project);
  const html = renderHtml(doc);
  assert.equal(/carries the product through these stages/i.test(html), false);
  assert.match(html, /calculat/i);
  const xref = html.slice(html.lastIndexOf('Control program'));
  assert.equal(/Statements 0-29[\s\S]{0,80}11-15/.test(xref), false);
  assert.equal(project.coverage.ok, true);
});

test('CAD assemblies and tag lists are sent to the model', async () => {
  const prompts = [];
  const anthropic = {
    messages: {
      create: async (body) => {
        prompts.push(body.messages[0].content);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              equipment_kind: 'structure',
              product_name: 'Transfer chamber frame',
              overview: 'The frame supports the transfer chamber. Guards keep people out of the mechanism. It is not a packaging line.',
              cycle: 'There is no product cycle. Keep the guards closed while the built-in mechanisms move.',
              subsystems: [{
                name: 'Frame and guarding',
                role: 'frame',
                function: 'The frame supports the chamber.',
                motion: 'The frame does not move.',
                sensors: 'Door closed',
                interlocks: 'Motion stays off while a guard is open.',
                components: ['Extrusion'],
              }],
            }),
          }],
        };
      },
    },
  };
  const cad = emptyProject();
  cad.cad.assemblies = [{ name: 'Outer Frame Acrylic', kind: 'guard', role: 'structure', leaf: false, description: 'Acrylic panel' }];
  cad.cad.bom = [{ partNumber: 'SB1', description: 'Guard or panel, solid body, part SB1', qty: 4 }];
  cad.sources = [{ name: 'frame.stp' }];
  await analyzeProject(cad, { anthropic, env: {} });
  assert.ok(prompts.some((text) => text.includes('Assemblies') && text.includes('Outer Frame Acrylic') && text.includes('Bill of materials')));
  assert.match(cad.narrative.overview, /frame supports/i);

  const tags = emptyProject();
  tags.tags = [{ name: 'TT_101', description: 'Tank temperature transmitter' }];
  const before = prompts.length;
  await analyzeProject(tags, { anthropic, env: {} });
  assert.ok(prompts.length > before);
  assert.ok(prompts.slice(before).some((text) => text.includes('Tank temperature')));
  const doc = buildDocument(tags);
  const html = renderHtml(doc);
  assert.match(html, /Tank temperature/i);
  assert.equal(/carries the product through these stages/i.test(html), false);
});
