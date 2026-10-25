const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { emptyProject } = require('../lib/project');
const { analyzeRoutine } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { renderPdf, closeBrowser, findChrome } = require('../lib/manual/pdf');
const { DISCLAIMER_TEXT } = require('../lib/manual/disclaimer');

const FOOTER = 'DRAFT — AI-generated with ManualOS from user files. Verify before use.';

function htmlOf(project) {
  return renderHtml(buildDocument(project));
}

function assertDisclaimerClosesHtml(html) {
  const block = `<section class="legal-disclaimer"><p>${DISCLAIMER_TEXT}</p></section>`;
  const at = html.lastIndexOf(block);
  assert.ok(at > html.lastIndexOf('</main>'));
  assert.equal(html.slice(at + block.length).replace(/\s+/g, ''), '</body></html>');
  assert.equal(html.split(DISCLAIMER_TEXT).length - 1, 1);
}

function pageText(pdf) {
  return execFileSync('pdftotext', ['-layout', '-', '-'], {
    input: pdf,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function pagesOf(text) {
  return text.split('\f').map((page) => page.trim()).filter(Boolean);
}

function bodyOf(page) {
  const stripped = page
    .replaceAll(FOOTER, '')
    .replace(/\bPage \d+\b/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/Operating and Maintenance Manual/.test(line) && !/^Rev\.\s+\S+$/.test(line));
  return stripped.join(' ').replace(/\s+/g, ' ').trim();
}

test('the legal disclaimer closes every manual, for each input shape', () => {
  const tags = emptyProject();
  tags.tags = [{ name: 'Motor_Run', description: 'Motor running', dataType: 'BOOL' }];

  const logic = emptyProject();
  logic.routines = [{
    name: 'Main',
    type: 'RLL',
    program: 'Main',
    units: [{ index: 0, number: 0, kind: 'rung', text: 'XIC(Start)OTE(Run);', comment: 'Start the sequence' }],
    analysis: { groups: [], housekeeping: [] },
  }];
  analyzeRoutine(logic.routines[0], logic, null);

  const mesh = emptyProject();
  mesh.cad.meshOnly = true;
  mesh.cad.bodyCount = 1;
  mesh.cad.assemblies = [{ name: 'part', source: 'stl' }];
  mesh.sources = [{ name: 'part.stl', format: 'stl' }];

  const drawing = emptyProject();
  drawing.sources = [{ name: 'gears.dxf', format: 'dxf' }];
  drawing.cad.layers = ['0'];

  const named = emptyProject();
  named.cad.assemblies = [{ name: 'Frame', source: 'step' }];
  named.cad.bodyCount = 1;
  named.sources = [{ name: 'frame.step', format: 'step' }];

  for (const project of [emptyProject(), tags, logic, mesh, drawing, named]) {
    assertDisclaimerClosesHtml(htmlOf(project));
  }
});

test('the legal disclaimer is the last text block in the PDF', { timeout: 120000 }, async () => {
  assert.equal(DISCLAIMER_TEXT, 'LEGAL DISCLAIMER PENDING — do not ship');
  assert.ok(findChrome(), 'Chrome or Chromium is required to render the manual PDF');
  const logic = emptyProject();
  logic.routines = [{
    name: 'Main',
    type: 'RLL',
    program: 'Main',
    units: [{ index: 0, number: 0, kind: 'rung', text: 'XIC(Start)OTE(Run);', comment: 'Start the sequence' }],
    analysis: { groups: [], housekeeping: [] },
  }];
  analyzeRoutine(logic.routines[0], logic, null);
  const pdf = await renderPdf(htmlOf(logic));
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const pages = pagesOf(pageText(pdf));
  const bodies = pages.map(bodyOf);
  const last = bodies[bodies.length - 1];
  assert.equal(last, DISCLAIMER_TEXT, `last page body:\n${pages[pages.length - 1]}`);
  assert.equal(bodies.slice(0, -1).some((body) => body.includes(DISCLAIMER_TEXT)), false);
  const full = pages.join('\n');
  const disclaimerAt = full.lastIndexOf(DISCLAIMER_TEXT);
  const signOffAt = full.lastIndexOf('Sign-off.');
  assert.ok(signOffAt >= 0 && disclaimerAt > signOffAt);
});

test.after(async () => {
  await closeBrowser();
});
