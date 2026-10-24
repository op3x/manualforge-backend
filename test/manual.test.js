const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml, headingsIn } = require('../lib/manual/html');

test('a generated manual follows the OEM section conventions', async () => {
  const l5x = fs.readFileSync(path.join(__dirname, 'fixtures/line.L5X'));
  const step = fs.readFileSync(path.join(__dirname, 'fixtures/pulley.stp'));
  const project = await parseUploads([
    { name: 'line.L5X', buffer: l5x },
    { name: 'pulley.stp', buffer: step },
  ]);
  for (const routine of project.routines) analyzeRoutine(routine, project, null);
  const doc = buildDocument(project);
  const html = renderHtml(doc);
  const headings = headingsIn(html);
  assert.equal(headings.some((heading) => /theory of operation/i.test(heading)), true);
  assert.equal(/\bRoutine\s*:/.test(headings.join('\n')), false);
  assert.match(html, /<ol class="steps">/);
  assert.match(html, /Expected result\./);
  assert.match(html, /Symptom/);
  assert.match(html, /Probable cause/);
  assert.match(html, /Remedy/);
  assert.match(html, /Interval/);
  assert.match(html, />Task</);
  assert.match(html, />Who</);
  assert.match(html, /Only qualified personnel/);
  assert.match(html, /Lock out every energy source/);
  assert.match(html, /hz-danger|hz-warning|hz-caution|hz-notice/);
  assert.match(html, />Parameter</);
  assert.match(html, />Part</);
  assert.match(html, /class="callouts"|<figure>/);
  assert.match(html, /Inferred - please confirm/);
  assert.equal(project.coverage.percent, 100);
  assert.equal(doc.chapters.length >= 10, true);
});
