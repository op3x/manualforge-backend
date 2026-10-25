const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { emptyProject } = require('../lib/project');
const { analyzeRoutine } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { renderPdf, closeBrowser, findChrome } = require('../lib/manual/pdf');
const { generateManual } = require('../lib/pipeline');
const { DISCLAIMER_TITLE, COVER_NOTICE_LINE, DISCLAIMER_TEXT } = require('../lib/manual/disclaimer');

const LEGAL_TEXT = 'This manual is an AI-generated draft provided by ManualOS, operated by Op3x LLC, "as is" and without warranties of any kind, and it must be checked by a qualified person against the actual machine before anyone relies on it. Whoever uses this manual is responsible for reviewing it and for safe operation, maintenance and lockout/tagout, and to the fullest extent the law allows, Op3x LLC is not liable for any injury, damage or loss arising from its use. Use of this manual is governed by the ManualOS Terms at manualos.com/terms, including their limitation of liability.';
const FOOTER = 'DRAFT — AI-generated with ManualOS from user files. Verify before use.';
const PLACEHOLDER = 'LEGAL DISCLAIMER PENDING';

function logicProject() {
  const project = emptyProject();
  project.routines = [{
    name: 'Main',
    type: 'RLL',
    program: 'Main',
    units: [{ index: 0, number: 0, kind: 'rung', text: 'XIC(Start)OTE(Run);', comment: 'Start the sequence' }],
    analysis: { groups: [], housekeeping: [] },
  }];
  analyzeRoutine(project.routines[0], project, null);
  return project;
}

function inputProjects() {
  const tags = emptyProject();
  tags.tags = [{ name: 'Motor_Run', description: 'Motor running', dataType: 'BOOL' }];

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

  return [emptyProject(), tags, logicProject(), mesh, drawing, named];
}

function htmlOf(project) {
  return renderHtml(buildDocument(project));
}

function escaped(text) {
  return text.replace(/"/g, '&quot;');
}

function assertNoticeHtml(html) {
  const block = `<section class="legal-disclaimer"><p class="legal-title"><b>${DISCLAIMER_TITLE}</b></p><p>${escaped(DISCLAIMER_TEXT)}</p></section>`;
  const at = html.lastIndexOf(block);
  assert.ok(at > html.lastIndexOf('</main>'));
  assert.equal(html.slice(at + block.length).replace(/\s+/g, ''), '</body></html>');
  assert.equal(html.split(escaped(DISCLAIMER_TEXT)).length - 1, 1);
  assert.equal(html.includes(PLACEHOLDER), false);
  const cover = html.slice(0, html.indexOf('<section class="toc"'));
  assert.ok(cover.includes(`<p>DRAFT — GENERATED WITH AI. NOT VERIFIED.</p>\n<p>${COVER_NOTICE_LINE}</p>`));
  assert.equal(cover.includes(escaped(DISCLAIMER_TEXT)), false);
  assert.equal(cover.includes(DISCLAIMER_TITLE), false);
  const titleRule = html.match(/\.legal-disclaimer \.legal-title \{([^}]*)\}/);
  assert.ok(titleRule);
  assert.match(titleRule[1], /font-weight:\s*700/);
  const titleSize = Number((titleRule[1].match(/font-size:\s*([\d.]+)pt/) || [])[1]);
  const bodyRule = html.match(/\.legal-disclaimer p \{([^}]*)\}/);
  assert.ok(bodyRule);
  const bodySize = Number((bodyRule[1].match(/font-size:\s*([\d.]+)pt/) || [])[1]);
  assert.ok(titleSize >= 9.8 && bodySize >= 9.8);
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

function assertNoticePdf(pdf) {
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const text = pageText(pdf);
  assert.equal(text.includes(PLACEHOLDER), false);
  const pages = pagesOf(text);
  const bodies = pages.map(bodyOf);
  const last = bodies[bodies.length - 1];
  assert.equal(last, `${DISCLAIMER_TITLE} ${DISCLAIMER_TEXT}`, `last page body:\n${pages[pages.length - 1]}`);
  assert.equal(bodies.slice(0, -1).some((body) => body.includes(DISCLAIMER_TEXT)), false);
  assert.equal(bodies[0].includes(COVER_NOTICE_LINE), true);
  assert.equal(bodies[0].includes(DISCLAIMER_TEXT), false);
  const full = pages.join('\n');
  assert.ok(full.lastIndexOf(DISCLAIMER_TEXT) > full.lastIndexOf('Sign-off.'));
}

test('the legal notice matches the constant and closes every input shape', () => {
  assert.equal(DISCLAIMER_TEXT, LEGAL_TEXT);
  assert.equal(DISCLAIMER_TITLE, 'Important legal notice');
  assert.equal(COVER_NOTICE_LINE, 'Read the important legal notice on the last page before using this manual.');
  for (const project of inputProjects()) assertNoticeHtml(htmlOf(project));
});

test('the legal notice is the last text block of every manual PDF, including a dry model pass', { timeout: 120000 }, async () => {
  assert.ok(findChrome(), 'Chrome or Chromium is required to render the manual PDF');
  for (const project of inputProjects()) {
    assertNoticePdf(await renderPdf(htmlOf(project)));
  }
  const dry = await generateManual({
    project: logicProject(),
    anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: '{}' }] }) } },
    env: process.env,
  });
  assert.equal(dry.html.includes(PLACEHOLDER), false);
  assert.ok(dry.html.includes(COVER_NOTICE_LINE));
  assert.equal(dry.html.split(escaped(DISCLAIMER_TEXT)).length - 1, 1);
  assertNoticePdf(dry.pdf);
});

test.after(async () => {
  await closeBrowser();
});
