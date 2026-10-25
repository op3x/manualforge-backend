const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine, coverageOf } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml, headingsIn } = require('../lib/manual/html');

const { corpusRoot, corpusAvailable, corpusSkip } = require('./corpus-env');
const ROOT = corpusRoot();
const hasCorpus = corpusAvailable(ROOT);

test('every corpus file produces a manual or a clear rejection', { timeout: 180000, skip: corpusSkip(ROOT) }, async () => {
  assert.ok(hasCorpus, 'MANUALOS_CORPUS is not set and no corpus manifest was found. CI must provide the corpus.');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const rows = [];
  for (const entry of manifest.files) {
    const name = path.basename(entry.file);
    const buffer = fs.readFileSync(path.join(ROOT, entry.file));
    try {
      const project = await parseUploads([{ name, buffer }]);
      for (const routine of project.routines) analyzeRoutine(routine, project, null);
      const coverage = coverageOf(project);
      assert.equal(coverage.ok, true, `${name} coverage`);
      const doc = buildDocument(project);
      const html = renderHtml(doc);
      const headings = headingsIn(html).join('\n');
      assert.equal(/theory of operation/i.test(doc.chapters.map((chapter) => chapter.title).join(' ')), true);
      assert.equal(/\bRoutine\s*:/i.test(headings), false, name);
      assert.equal(/\b(XIC|XIO|OTE|JSR)\b/.test(headings), false, name);
      if (entry.file.endsWith('.ACD')) assert.match(html, /L5X/);
      else assert.equal(/proprietary binary format/i.test(html), false, name);
      if (project.cad.assemblies.length) assert.match(html, /Subsystem|Part |conveyor|frame|gripper|cylinder|motor|valve|solid/i);
      rows.push({ file: entry.file, result: 'pass', units: coverage.units, routines: project.routines.length });
    } catch (err) {
      assert.equal(err.expose, true, name);
      assert.match(err.message, /[A-Za-z]/);
      assert.equal(String(err.message).includes('stack'), false);
      rows.push({ file: entry.file, result: 'rejected', message: err.message });
    }
  }
  const passed = rows.filter((row) => row.result === 'pass').length;
  assert.equal(passed, manifest.files.length);
  fs.mkdirSync('/tmp/manualos-corpus', { recursive: true });
  fs.writeFileSync('/tmp/manualos-corpus/results.json', JSON.stringify({ passed, total: rows.length, rows }, null, 2));
});
