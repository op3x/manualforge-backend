const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeOutput, sanitizeVendors, collapseRepeatedWords } = require('../lib/output-sanitize');
const { deviceTypeLabel } = require('../lib/text');
const { parseUploads } = require('../lib/parsers');
const { analyzeRoutine } = require('../lib/logic');
const { buildDocument } = require('../lib/manual/assemble');
const { renderHtml } = require('../lib/manual/html');
const { renderPdf, findChrome, closeBrowser } = require('../lib/manual/pdf');

const VENDORS = /\b(?:Allen-Bradley|Allen Bradley|Rockwell|PowerFlex\w*|Siemens|SINAMICS\w*|Studio\s*5000|RSLogix\w*|ControlLogix\w*|CompactLogix\w*|TIA\s*Portal|CODESYS|Mitsubishi|GX\s*Works\d*|Omron|Beckhoff|TwinCAT\w*|SolidWorks\w*|AutoCAD\w*|Creo|CATIA|AB)\b/i;
const FIXTURE_EXT = new Set(['l5x', 'acd', 'scl', 'xml', 'awl', 'db', 'l5k', 'dxf', 'step', 'stp', 'stl']);

function vendorSnippet(text) {
  const match = String(text || '').match(VENDORS);
  if (!match) return '';
  const at = match.index || 0;
  return String(text).slice(Math.max(0, at - 48), at + match[0].length + 48).replace(/\s+/g, ' ');
}

test('vendor names and prefixed device tags become neutral terms', () => {
  const samples = [
    ['AB:PowerFlex', /variable frequency drive/i],
    ['AB:PowerFlex525V_E_F6C9C23A:I:0', /variable frequency drive/i],
    ['AB:PowerFlex755_E_73215AC2:O:0', /variable frequency drive/i],
    ['SINAMICS G120', /variable frequency drive/i],
    ['Allen-Bradley', /the controller/i],
    ['Allen Bradley', /the controller/i],
    ['AB', /the controller/i],
    ['Rockwell', /the controller/i],
    ['Siemens', /the controller/i],
    ['ControlLogix', /the controller/i],
    ['CompactLogix', /the controller/i],
    ['Mitsubishi', /the controller/i],
    ['Omron', /the controller/i],
    ['Beckhoff', /the controller/i],
    ['Studio 5000', /the programming software/i],
    ['RSLogix', /the programming software/i],
    ['TIA Portal', /the programming software/i],
    ['CODESYS', /the programming software/i],
    ['GX Works3', /the programming software/i],
    ['TwinCAT', /the programming software/i],
    ['SolidWorks', /the programming software/i],
    ['AutoCAD', /the programming software/i],
    ['Creo', /the programming software/i],
    ['CATIA', /the programming software/i],
    ['AB:1756-L73', /module/i],
    ['AB:5000_String32_Struct:I:0', /module/i],
  ];
  for (const [sample, expect] of samples) {
    const cleaned = sanitizeVendors(sample);
    assert.match(cleaned, expect, sample);
    assert.equal(vendorSnippet(cleaned), '', `${sample} -> ${cleaned}`);
    assert.equal(sanitizeVendors(cleaned), cleaned, sample);
  }
  assert.equal(sanitizeVendors('Use the Allen-Bradley rack'), 'Use the controller rack');
  assert.equal(sanitizeVendors('the PowerFlex starts'), 'the variable frequency drive starts');
  assert.equal(sanitizeVendors('Local:1:I.Data stays'), 'Local:1:I.Data stays');
  assert.equal(deviceTypeLabel('AB:PowerFlex525V_E_F6C9C23A:I:0'), 'Variable frequency drive');
  assert.match(deviceTypeLabel('AB:5000_String32_Struct:I:0'), /^Module$/i);
});

test('repeated adjacent words collapse in prose and stay inside tables', () => {
  assert.equal(collapseRepeatedWords('the the signal'), 'the signal');
  assert.equal(collapseRepeatedWords('the the the motor'), 'the motor');
  assert.equal(collapseRepeatedWords('The the motor motor runs'), 'The motor runs');
  assert.equal(sanitizeOutput('Press the the reset'), 'Press the reset');
  assert.equal(sanitizeOutput('the theory of the operation'), 'the theory of the operation');
  assert.equal(sanitizeOutput('Start_Start stays'), 'Start_Start stays');
  assert.equal(sanitizeOutput('the the', { table: true }), 'the the');
  assert.equal(sanitizeOutput('High High', { table: true }), 'High High');
  assert.equal(sanitizeOutput('Start Start', { table: true }), 'Start Start');
  assert.equal(sanitizeOutput('Low Low', { table: true }), 'Low Low');
  assert.equal(sanitizeOutput('motor motor', { table: false }), 'motor motor'.replace('motor motor', 'motor'));
});

test('every generated document is sanitized, including table tags', () => {
  const html = renderHtml({
    meta: {
      title: 'PowerFlex washer',
      headerLeft: 'AB:PowerFlex runs',
      headerRight: 'Rev. A',
      footerLeft: 'the the motor',
    },
    cover: {
      title: 'PowerFlex washer',
      subtitle: 'Operating manual',
      manufacturer: 'Allen-Bradley',
      model: 'SINAMICS',
      serial: '100',
      docNumber: '',
      revision: 'A',
      date: '2026-01-01',
      language: 'English',
      warning: 'Read the the Studio 5000 note',
      foot: 'Siemens panel',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>AB:PowerFlex</text></svg>',
    },
    branding: { whiteLabel: true, companyName: 'Rockwell', logoHtml: '<img alt="Rockwell">' },
    chapters: [{
      id: 'ch1',
      number: '1',
      title: 'Rockwell notes',
      sections: [{
        anchor: 's1',
        number: '1.1',
        title: 'TIA Portal setup',
        blocks: [
          { type: 'p', text: 'Use the the RSLogix and the ControlLogix with CompactLogix.' },
          {
            type: 'table',
            headers: ['Tag', 'Device'],
            rows: [
              ['AB:PowerFlex525V_E_F6C9C23A:I:0', 'High High'],
              ['Start Start', 'SINAMICS G120'],
            ],
          },
          { type: 'ul', items: ['Mitsubishi GX Works3', 'Omron and Beckhoff TwinCAT'] },
          {
            type: 'steps',
            items: [{ action: 'Open SolidWorks and AutoCAD', expect: 'Creo and CATIA stay closed closed' }],
          },
          {
            type: 'hazard',
            hazard: {
              signal_word: 'WARNING',
              hazard: 'CODESYS the the drive',
              consequence: 'Motion can start.',
              avoidance: ['Use the controller.'],
            },
          },
        ],
      }],
    }],
  });
  assert.equal(vendorSnippet(html.replace(/<img alt="Rockwell">/g, '')), '', vendorSnippet(html));
  assert.match(html, /variable frequency drive/i);
  assert.match(html, /the programming software/i);
  assert.match(html, /the controller/i);
  assert.match(html, />High High</);
  assert.match(html, />Start Start</);
  assert.equal(/closed closed/.test(html), false);
  assert.match(html, /stay closed/);
  assert.match(html, /class="hz hz-warning"/);
  assert.match(html, /<img alt="Rockwell">/);
  assert.equal(/the the/.test(html.replace(/<img alt="Rockwell">/g, '')), false);
});

function walkFixtures(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFixtures(full, out);
    else {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (FIXTURE_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

function pdfText(pdf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-pdf-'));
  const file = path.join(dir, 'manual.pdf');
  try {
    fs.writeFileSync(file, pdf);
    return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('fixture PDFs have no vendor names after the sanitizer', { timeout: 600000 }, async () => {
  assert.ok(findChrome(), 'Chrome is required to render fixture PDFs');
  assert.ok(fs.existsSync('/usr/bin/pdftotext'), 'pdftotext is required to read fixture PDFs');
  const files = walkFixtures(path.join(__dirname, 'fixtures'));
  assert.ok(files.length >= 8, `expected fixture manuals, found ${files.length}`);
  const generated = [];
  const skipped = [];
  try {
    for (const file of files) {
      const name = path.relative(path.join(__dirname, 'fixtures'), file);
      let project;
      try {
        project = await parseUploads([{ name: path.basename(file), buffer: fs.readFileSync(file) }]);
      } catch (err) {
        skipped.push(`${name}: ${err.message}`);
        continue;
      }
      for (const routine of project.routines || []) analyzeRoutine(routine, project, null);
      const html = renderHtml(buildDocument(project));
      const pdf = await renderPdf(html);
      const raw = pdfText(pdf);
      const flat = raw.replace(/-\n\s*/g, '').replace(/\s+/g, ' ');
      assert.equal(vendorSnippet(flat), '', `${name} pdf: ${vendorSnippet(flat)}`);
      const cleaned = sanitizeOutput(raw);
      const cleanedFlat = cleaned.replace(/\s+/g, ' ');
      assert.equal(vendorSnippet(cleanedFlat), '', `${name} sanitized pdf: ${vendorSnippet(cleanedFlat)}`);
      generated.push(name);
    }
  } finally {
    await closeBrowser();
  }
  assert.ok(generated.length >= 8, `generated ${generated.length}; skipped ${skipped.join(' | ')}`);
});
