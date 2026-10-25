const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BRANDS = /\b(Rockwell|Allen-Bradley|Allen Bradley|Studio 5000|RSLogix|Logix Designer|ControlLogix|Siemens|SIMATIC|TIA Portal|STEP 7|TwinCAT|Beckhoff|PLCopen|AutoCAD|Autodesk|SolidWorks|Dassault)\b/i;

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
    if (text.length < 20 || !/\s/.test(text)) continue;
    if (FINGERPRINTS.some((pattern) => pattern.test(text))) continue;
    if (!/\b(export|upload|file|manual|read|cannot|could not|does not|save|service)\b/i.test(text)) continue;
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
