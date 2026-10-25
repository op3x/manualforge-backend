const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { parseUploads } = require('../lib/parsers');
const { applyAcdLibraryNotes } = require('../lib/parsers/acd');
const { generateManual } = require('../lib/pipeline');
const { findChrome, closeBrowser } = require('../lib/manual/pdf');
const { corpusRoot, corpusHas } = require('./corpus-env');

const report = [];

function mockAi() {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    },
  };
}

function pageCount(pdf) {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

function unitCount(project) {
  return project.routines.reduce((sum, routine) => sum + (routine.units || []).filter((unit) => !unit.unread).length, 0);
}

async function renderManual(name, buffer) {
  assert.ok(findChrome(), 'Chrome or Chromium is required to render the manual PDF');
  const project = await parseUploads([{ name, buffer }]);
  const result = await generateManual({
    project,
    anthropic: mockAi(),
    env: { ...process.env, MANUALOS_AI_RETRIES: '0' },
  });
  assert.equal(result.pdf.subarray(0, 4).toString(), '%PDF');
  const pages = pageCount(result.pdf);
  assert.ok(pages >= 2, `${name} rendered ${pages} pages`);
  return { project, html: result.html, pdf: result.pdf, pages };
}

function remember(row) {
  report.push(row);
  console.log(JSON.stringify(row));
}

test.after(async () => {
  console.log(`FORMAT_SUPPORT ${JSON.stringify(report)}`);
  await closeBrowser();
});

test('Siemens TIA block XML reads LAD, FBD, SCL, and GRAPH', { timeout: 120000 }, async () => {
  const buffer = fs.readFileSync(path.join(__dirname, 'fixtures/formats/tia-blocks.xml'));
  const { project, html, pages } = await renderManual('tia-blocks.xml', buffer);
  const belt = project.routines.find((routine) => routine.name === 'BeltRun');
  const scale = project.routines.find((routine) => routine.name === 'ScaleLevel');
  const fill = project.routines.find((routine) => routine.name === 'FillPump');
  const sequence = project.routines.find((routine) => routine.name === 'FillSequence');
  assert.ok(belt && scale && fill && sequence);
  assert.match(belt.units[0].summary, /start button is on/i);
  assert.match(belt.units[0].summary, /stop button is off/i);
  assert.match(belt.units[0].summary, /belt motor/i);
  assert.match(scale.units[0].summary, /function-block network uses Add/i);
  assert.match(fill.units[0].text, /IF Level < 10 THEN Pump := TRUE;/);
  assert.match(html, /less than/i);
  assert.match(html, /fill pump/i);
  assert.equal(sequence.units.filter((unit) => unit.kind === 'step').length, 2);
  assert.equal(sequence.units.filter((unit) => unit.kind === 'transition').length, 1);
  assert.match(sequence.units.map((unit) => unit.summary).join('\n'), /turns on Pump/i);
  assert.match(sequence.units.map((unit) => unit.summary).join('\n'), /Level High is on/i);
  assert.equal(/PLCopen|TwinCAT/.test(html), false);
  remember({
    format: 'Siemens TIA XML (LAD/FBD/SCL/GRAPH)',
    file: 'tia-blocks.xml',
    rungs: unitCount(project),
    pages,
  });
});

test('a Siemens XML shell does not use the PLCopen error', async () => {
  const xml = '<?xml version="1.0"?><Document xmlns="http://www.siemens.com/automation/Openness/SW/v17"></Document>';
  await assert.rejects(
    () => parseUploads([{ name: 'empty-tia.xml', buffer: Buffer.from(xml) }]),
    (err) => err.status === 422 && /XML \(\.xml\) block export/.test(err.message) && !/PLCopen|TwinCAT|Siemens|TIA Portal/.test(err.message),
  );
});

test('Siemens DATA_BLOCK source describes each member', { timeout: 120000 }, async () => {
  const source = `DATA_BLOCK "MachineData"
TITLE = Line setpoints
VERSION : 0.1
STRUCT
  SetpointSpeed : INT := 120; // Belt speed
  EnableRun : BOOL := FALSE; // Run permissive
END_STRUCT
BEGIN
END_DATA_BLOCK
`;
  const { project, html, pages } = await renderManual('machine.db', Buffer.from(source));
  assert.equal(project.routines.length, 1);
  assert.equal(project.routines[0].type, 'DATA_BLOCK');
  assert.equal(project.routines[0].units.length, 2);
  assert.match(project.routines[0].units[0].summary, /Belt speed is an integer/);
  assert.match(project.routines[0].units[0].summary, /120/);
  assert.match(project.routines[0].units[1].summary, /Run permissive/);
  assert.match(project.routines[0].units[1].summary, /off/);
  assert.match(html, /Belt speed/);
  assert.match(html, /120/);
  remember({ format: 'Siemens DATA_BLOCK', file: 'machine.db', rungs: unitCount(project), pages });
});

test('S7-300/400 STL splits networks and states the logic', { timeout: 120000 }, async () => {
  const source = `ORGANIZATION_BLOCK OB1
TITLE = Main cycle
VERSION : 0.1
VAR_TEMP
  Scratch : BOOL;
END_VAR
BEGIN
NETWORK
TITLE = Run the belt
      A     "StartButton"
      AN    "StopButton"
      =     "BeltMotor"
NETWORK
TITLE = Fault lamp
      A     "Fault"
      =     "FaultLamp"
NETWORK
TITLE = Start the dwell
      A     "Run"
      L     S5T#5S
      SD    T1
END_ORGANIZATION_BLOCK
`;
  const { project, html, pages } = await renderManual('ob1.awl', Buffer.from(source));
  assert.equal(project.routines[0].units.length, 3);
  assert.match(project.routines[0].units[0].summary, /When Start Button is on and Stop Button is off, the control turns on Belt Motor/);
  assert.match(project.routines[0].units[1].summary, /Fault is on/);
  assert.match(project.routines[0].units[2].summary, /starts timer 1 for 5 seconds/);
  assert.match(html, /turns on Belt Motor/);
  remember({ format: 'STL/AWL S7-300/400', file: 'ob1.awl', rungs: unitCount(project), pages });
});

test('S7-200 STL reads load and seal-in networks', { timeout: 120000 }, async () => {
  const source = `ORGANIZATION_BLOCK MAIN:OB1
TITLE=Main program
BEGIN
Network 1 // Run the belt
LD     StartButton
O      BeltMotor
AN     StopButton
=      BeltMotor
Network 2 // Fault lamp
LD     Fault
=      FaultLamp
END_ORGANIZATION_BLOCK
`;
  const { project, html, pages } = await renderManual('main.awl', Buffer.from(source));
  assert.equal(project.routines[0].name, 'MAIN:OB1');
  assert.equal(project.routines[0].units.length, 2);
  assert.match(project.routines[0].units[0].summary, /When \(Start Button is on or Belt Motor is on\) and Stop Button is off, the control turns on Belt Motor/);
  assert.match(html, /Belt Motor/);
  remember({ format: 'STL/AWL S7-200', file: 'main.awl', rungs: unitCount(project), pages });
});

function binaryDxf(pairs) {
  const chunks = [Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1')];
  for (const [code, value] of pairs) {
    const head = Buffer.alloc(2);
    head.writeInt16LE(code);
    chunks.push(head);
    if (code >= 60 && code <= 79) {
      const number = Buffer.alloc(2);
      number.writeInt16LE(Number(value));
      chunks.push(number);
    } else {
      chunks.push(Buffer.from(String(value), 'latin1'), Buffer.from([0]));
    }
  }
  return Buffer.concat(chunks);
}

test('binary DXF keeps units, layers, and title text and does not render a manual', async () => {
  const buffer = binaryDxf([
    [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'], [70, 1],
    [0, 'LAYER'], [2, 'TITLE'], [70, 0], [0, 'ENDTAB'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [8, 'TITLE'], [1, 'Conveyor frame'],
    [0, 'ENDSEC'], [0, 'EOF'],
  ]);
  const project = await parseUploads([{ name: 'frame.dxf', buffer }]);
  assert.equal(project.cad.lengthUnit, 'mm');
  assert.equal(project.cad.layers.includes('TITLE'), true);
  assert.equal(project.cad.titleBlock.includes('Conveyor frame'), true);
  let rendered = false;
  await assert.rejects(
    () => generateManual({
      project,
      anthropic: mockAi(),
      env: { ...process.env, MANUALOS_AI_RETRIES: '0' },
      renderPdf: async () => {
        rendered = true;
        return Buffer.from('%PDF-1.4\n');
      },
    }),
    (err) => err.code === 'no_model_result',
  );
  assert.equal(rendered, false);
});

test('ASCII STL reports size and shape only', { timeout: 120000 }, async () => {
  const source = `solid Conveyor plate
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 100 0 0
      vertex 100 80 2
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 100 80 2
      vertex 0 80 0
    endloop
  endfacet
endsolid Conveyor plate
`;
  const { project, html, pages } = await renderManual('plate.stl', Buffer.from(source));
  assert.equal(project.cad.meshOnly, true);
  assert.equal(project.cad.shape, 'a flat plate');
  assert.equal(project.cad.triangleCount, 2);
  assert.match(project.cad.boundingBox.max.join(','), /100/);
  assert.match(html, /triangle mesh/);
  assert.match(html, /flat plate/);
  assert.match(html, /Export STEP/);
  remember({ format: 'ASCII STL', file: 'plate.stl', rungs: 0, pages });
});

function boxTriangles(width, depth, height) {
  const corners = [
    [0, 0, 0], [width, 0, 0], [width, depth, 0], [0, depth, 0],
    [0, 0, height], [width, 0, height], [width, depth, height], [0, depth, height],
  ];
  const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const triangles = [];
  for (const [a, b, c, d] of faces) {
    triangles.push([corners[a], corners[b], corners[c]]);
    triangles.push([corners[a], corners[c], corners[d]]);
  }
  return triangles;
}

function binaryStl(name, triangles) {
  const header = Buffer.alloc(80);
  Buffer.from(`solid ${name}`, 'latin1').copy(header);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(triangles.length);
  const body = Buffer.alloc(triangles.length * 50);
  triangles.forEach((triangle, index) => {
    triangle.forEach((vertex, vertexIndex) => {
      const start = index * 50 + 12 + vertexIndex * 12;
      vertex.forEach((value, axis) => body.writeFloatLE(value, start + axis * 4));
    });
  });
  return Buffer.concat([header, count, body]);
}

test('binary STL reports a compact block and no part names', { timeout: 120000 }, async () => {
  const buffer = binaryStl('Guard block', boxTriangles(10, 10, 10));
  const { project, html, pages } = await renderManual('guard.stl', buffer);
  assert.equal(project.cad.meshOnly, true);
  assert.equal(project.cad.shape, 'a compact block');
  assert.equal(project.cad.triangleCount, 12);
  assert.match(html, /compact block/);
  assert.match(html, /no part names/);
  remember({ format: 'Binary STL', file: 'guard.stl', rungs: 0, pages });
});

test('ACD ladder reaches a PDF and unread languages are named', { timeout: 180000 }, async () => {
  const acdPath = path.join(corpusRoot(), 'plc/acd_CuteLogix.ACD');
  if (corpusHas('plc/acd_CuteLogix.ACD')) {
    const { project, html, pages } = await renderManual('CuteLogix.ACD', fs.readFileSync(acdPath));
    assert.equal(project.acdConverted, true);
    assert.equal(project.routines.length, 29);
    assert.equal(unitCount(project), 132);
    assert.match(html, /converting it to L5X/);
    assert.equal(/rung text cannot be read/.test(html), false);
    remember({ format: 'Rockwell ACD', file: 'CuteLogix.ACD', rungs: 132, pages });
  }
  const mixed = `<?xml version="1.0" encoding="UTF-8"?>
<RSLogix5000Content>
  <Controller Name="Demo">
    <Programs>
      <Program Name="Main">
        <Routines>
          <Routine Name="Ladder" Type="RLL"><RLLContent><Rung Number="0" Type="N"><Text>XIC(Start)OTE(Motor);</Text></Rung></RLLContent></Routine>
          <Routine Name="Sheets" Type="FBD"></Routine>
          <Routine Name="Chart" Type="SFC"></Routine>
          <Routine Name="Text" Type="ST"></Routine>
        </Routines>
      </Program>
    </Programs>
  </Controller>
</RSLogix5000Content>`;
  const project = await parseUploads([{ name: 'mixed.L5X', buffer: Buffer.from(mixed) }]);
  applyAcdLibraryNotes(project, {
    routines: [
      { program: 'Main', name: 'Sheets', type: 'FBD', rungs: [] },
      { program: 'Main', name: 'Chart', type: 'SFC', rungs: [] },
      { program: 'Main', name: 'Text', type: 'ST', rungs: ['Pump := TRUE;'] },
    ],
  });
  project.acdConverted = true;
  const result = await generateManual({
    project,
    anthropic: mockAi(),
    env: { ...process.env, MANUALOS_AI_RETRIES: '0' },
  });
  assert.equal(result.pdf.subarray(0, 4).toString(), '%PDF');
  assert.match(result.html, /function-block routine is in the \.acd file/);
  assert.match(result.html, /sequential function chart routine is in the \.acd file/);
  assert.match(result.html, /turns on Pump/i);
  assert.equal(project.routines.find((routine) => routine.name === 'Text').units[0].unread, undefined);
  remember({
    format: 'ACD unextracted FBD/SFC plus recovered ST',
    file: 'mixed.L5X',
    rungs: unitCount(project),
    pages: pageCount(result.pdf),
  });
});

test('proprietary archives name the export to use', async () => {
  const zip = new AdmZip();
  zip.addFile('part.xml', Buffer.from('<part/>'));
  const packed = zip.toBuffer();
  const cases = [
    ['line.zap15', Buffer.from('PK\x03\x04not-really'), /SCL/, /\.xml/],
    ['plant.ap17', Buffer.from('TIA'), /SCL/, /\.xml/],
    ['cell.s7p', Buffer.from('STEP7'), /SCL/, /\.xml/],
    ['layout.dwg', Buffer.from('AC1027\x00\x00\x00binary'), /\.dxf/],
    ['pump.sldprt', packed, /\.step/],
    ['frame.sldasm', packed, /\.step/],
    ['sheet.slddrw', packed, /\.step/, /\.dxf/],
  ];
  for (const [name, buffer, ...patterns] of cases) {
    await assert.rejects(
      () => parseUploads([{ name, buffer }]),
      (err) => err.status === 415 && patterns.every((pattern) => pattern.test(err.message)) && !/PLCopen|TwinCAT/.test(err.message),
      name,
    );
  }
});
