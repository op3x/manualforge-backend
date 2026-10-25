const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseUploads } = require('../lib/parsers');
const { ACD_TEMP_MAX_AGE_MS, findPython, logPythonAvailability, sweepStaleAcdTemps } = require('../lib/parsers/acd');
const { corpusHas, corpusRoot } = require('./corpus-env');

const VENDOR = path.join(__dirname, '../third_party/python');

function namedDirs(prefix) {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix));
}

async function assertNoLeak(label, fn) {
  const beforeBuild = new Set(namedDirs('acd-build-'));
  let thrown = null;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  const leaked = namedDirs('acd-build-').filter((name) => !beforeBuild.has(name));
  assert.deepEqual(leaked, [], `${label} left acd-build dirs: ${leaked.join(', ')}`);
  if (thrown) throw thrown;
}

function acdArchive(entries) {
  const chunks = [];
  const records = [];
  let offset = 0;
  for (const entry of entries) {
    chunks.push(entry.data);
    const encoded = Buffer.concat([Buffer.from(entry.name, 'utf16le'), Buffer.from([0, 0])]);
    assert.ok(encoded.length <= 520, entry.name);
    const nameField = Buffer.alloc(520);
    encoded.copy(nameField);
    const meta = Buffer.alloc(8);
    meta.writeUInt32LE(entry.data.length, 0);
    meta.writeUInt32LE(offset, 4);
    records.push(Buffer.concat([nameField, meta]));
    offset += entry.data.length;
  }
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(entries.length, 0);
  return Buffer.concat([...chunks, ...records, footer]);
}

function runUnzip(archive, entryName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-acd-path-'));
  const archivePath = path.join(dir, 'crafted.acd');
  const scriptPath = path.join(dir, 'check.py');
  fs.writeFileSync(archivePath, archive);
  fs.writeFileSync(scriptPath, `import json, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from acd.zip.unzip import Unzip
archive, marker = sys.argv[2], Path(sys.argv[3])
if marker.exists():
    marker.unlink()
result = {"raised": False, "escaped": False, "inside": False, "error": "", "dest": ""}
dest = None
try:
    dest = Path(tempfile.mkdtemp())
    result["dest"] = str(dest)
    Unzip(archive).write_files(dest)
    result["inside"] = any(path.is_file() for path in dest.rglob("*"))
except Exception as exc:
    result["raised"] = True
    result["error"] = str(exc)
finally:
    result["escaped"] = marker.exists()
    if dest is not None:
        shutil.rmtree(dest, ignore_errors=True)
    print(json.dumps(result))
`);
  const marker = path.join(os.tmpdir(), 'manualos-acd-escape-marker.txt');
  const python = findPython();
  assert.ok(python, 'python3 is required');
  try {
    const stdout = execFileSync(python, [scriptPath, VENDOR, archivePath, marker], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
    });
    const result = JSON.parse(stdout);
    assert.equal(typeof result.dest, 'string', entryName);
    assert.equal(result.dest.length > 0, true, entryName);
    assert.equal(fs.existsSync(result.dest), false, entryName);
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ACD runs leave no acd-build directories', async () => {
  const before = new Set(namedDirs('acd-build-'));
  await assertNoLeak('failure', () => parseUploads([{ name: 'junk.ACD', buffer: Buffer.from('not an archive') }]));
  if (corpusHas('plc/acd_CuteLogix.ACD')) {
    const buffer = fs.readFileSync(path.join(corpusRoot(), 'plc/acd_CuteLogix.ACD'));
    await assertNoLeak('success', () => parseUploads([{ name: 'CuteLogix.ACD', buffer }]));
    await assertNoLeak('timeout', () => parseUploads(
      [{ name: 'CuteLogix.ACD', buffer }],
      {},
      { MANUALOS_ACD_CONVERT_MS: '1' },
    ));
  }
  const leaked = namedDirs('acd-build-').filter((name) => !before.has(name));
  console.log(`ACD_BUILD_LEAKS ${leaked.length}`);
  assert.equal(leaked.length, 0);
});

test('an archive entry cannot write outside its output directory', () => {
  const payload = Buffer.from([0x0d, 0x0a, 0x68, 0x69]);
  const safe = runUnzip(acdArchive([{ name: 'Comps.Dat', data: payload }]), 'Comps.Dat');
  assert.equal(safe.raised, false, safe.error);
  assert.equal(safe.inside, true);
  assert.equal(safe.escaped, false);
  for (const name of ['../manualos-acd-escape-marker.txt', '/tmp/manualos-acd-escape-marker.txt', 'nested/../../manualos-acd-escape-marker.txt']) {
    const result = runUnzip(acdArchive([{ name, data: payload }]), name);
    assert.equal(result.raised, true, name);
    assert.equal(result.escaped, false, name);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), 'manualos-acd-escape-marker.txt')), false, name);
  }
});

test('startup sweep removes ACD temp folders older than one hour', () => {
  assert.equal(ACD_TEMP_MAX_AGE_MS, 60 * 60 * 1000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-acd-sweep-'));
  const oldDir = path.join(root, 'manualos-acd-old');
  const freshDir = path.join(root, 'manualos-acd-fresh');
  const otherDir = path.join(root, 'other-temp');
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, 'upload.ACD'), 'project');
  fs.mkdirSync(freshDir);
  fs.mkdirSync(otherDir);
  fs.writeFileSync(path.join(root, 'manualos-acd-not-a-dir'), 'leave');
  const now = Date.now();
  const oldStamp = new Date(now - ACD_TEMP_MAX_AGE_MS - 1000);
  fs.utimesSync(oldDir, oldStamp, oldStamp);
  try {
    assert.equal(sweepStaleAcdTemps({ directory: root, now }), 1);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(freshDir), true);
    assert.equal(fs.existsSync(otherDir), true);
    assert.equal(fs.existsSync(path.join(root, 'manualos-acd-not-a-dir')), true);
    const kept = path.join(root, 'manualos-acd-within-hour');
    fs.mkdirSync(kept);
    const keptStamp = new Date(now - ACD_TEMP_MAX_AGE_MS + 5000);
    fs.utimesSync(kept, keptStamp, keptStamp);
    assert.equal(sweepStaleAcdTemps({ directory: root, now }), 0);
    assert.equal(fs.existsSync(kept), true);
    assert.equal(fs.existsSync(freshDir), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup says when python3 is missing and when it is present', () => {
  const lines = [];
  const logger = {
    log(message) { lines.push(message); },
    error(message) { lines.push(message); },
  };
  assert.equal(logPythonAvailability(logger, ''), false);
  assert.match(lines.join('\n'), /python3 was not found on PATH/);
  lines.length = 0;
  assert.equal(logPythonAvailability(logger, 'python3'), true);
  assert.match(lines.join('\n'), /python3 is available for \.acd conversion/);
});
