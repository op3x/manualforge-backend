const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseUploads } = require('../lib/parsers');

const BRANDS = /\b(Rockwell|Allen-Bradley|Allen Bradley|Studio 5000|RSLogix|Logix Designer|ControlLogix|Siemens|SIMATIC|TIA Portal|TIA|STEP 7|S7-200|S7-300|S7-400|S7-1200|S7-1500|WinCC|TwinCAT|Beckhoff|PLCopen|AutoCAD|Autodesk|SolidWorks|Dassault|GRAPH sequence)\b/i;

const STANDALONE = /^(?:Rockwell|Allen-Bradley|Allen Bradley|Studio 5000|RSLogix|Logix Designer|ControlLogix|Siemens|SIMATIC|TIA Portal|TIA|STEP 7|S7-200|S7-300|S7-400|S7-1200|S7-1500|WinCC|TwinCAT|Beckhoff|PLCopen|AutoCAD|Autodesk|SolidWorks|Dassault|GRAPH sequence)$/;

const FINGERPRINTS = [
  /AutoCAD Binary DXF/,
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function sentences(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found = [];
  const re = /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
  for (const match of stripped.matchAll(re)) {
    const text = match[0].slice(1, -1);
    if (FINGERPRINTS.some((pattern) => pattern.test(text))) continue;
    const userSentence = text.length >= 20 && /\s/.test(text)
      && /\b(export|upload|file|manual|read|cannot|could not|does not|save|service)\b/i.test(text);
    if (!userSentence && !STANDALONE.test(text.trim())) continue;
    found.push(text);
  }
  return found;
}

test('user-facing messages do not name vendors or products', () => {
  const hits = [];
  for (const file of walk(path.join(__dirname, '../lib'))) {
    for (const sentence of sentences(fs.readFileSync(file, 'utf8'))) {
      const match = sentence.match(BRANDS);
      if (match) hits.push(`${path.relative(path.join(__dirname, '..'), file)}: ${match[0]} in ${sentence.slice(0, 180)}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('unreadable XML block text uses neutral words', async () => {
  const xml = `<?xml version="1.0"?>
<Document>
  <SW.Blocks.FB ID="0">
    <AttributeList>
      <Name>EmptyGraph</Name>
      <ProgrammingLanguage>GRAPH</ProgrammingLanguage>
    </AttributeList>
  </SW.Blocks.FB>
  <SW.Blocks.FC ID="1">
    <AttributeList>
      <Name>EmptyOther</Name>
      <ProgrammingLanguage>CEM</ProgrammingLanguage>
    </AttributeList>
    <ObjectList>
      <SW.Blocks.CompileUnit ID="2" CompositionName="CompileUnits">
        <AttributeList><ProgrammingLanguage>CEM</ProgrammingLanguage></AttributeList>
      </SW.Blocks.CompileUnit>
    </ObjectList>
  </SW.Blocks.FC>
</Document>`;
  const project = await parseUploads([{ name: 'blocks.xml', buffer: Buffer.from(xml) }]);
  const text = project.routines.map((routine) => routine.units.map((unit) => `${unit.summary}\n${unit.text}`).join('\n')).join('\n');
  assert.equal(text.match(BRANDS), null);
  assert.match(text, /This sequence block did not contain a network/);
  assert.match(text, /This block network could not be read/);
  assert.doesNotMatch(text, /\bGRAPH\b/);
  assert.doesNotMatch(text, /\bTIA\b/);
  assert.doesNotMatch(text, /\bSTEP 7\b/);
});
