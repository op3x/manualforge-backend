const zlib = require('zlib');
const { limits } = require('../limits');
const { addRoutine } = require('../project');

const JUNK = new Set([
  'Routine', 'Program', 'Controller', 'Task', 'Tag', 'Description', 'Type', 'Name', 'Value',
  'Module', 'Data', 'String', 'Element', 'Manager', 'Collection', 'Container', 'Composite',
  'Language', 'Metadata', 'FloatingElement', 'CommentManager', 'EditingCompositeLanguageContainer',
  'CollectionElement', 'Rung', 'Comment', 'Text', 'Operand',
]);

function gunzip(buffer) {
  return new Promise((resolve) => {
    zlib.gunzip(buffer, (err, result) => resolve(err ? null : result));
  });
}

async function extractXmlFromAcdBuffer(buffer, env) {
  const cap = limits(env);
  const started = Date.now();
  const chunks = [];
  let gzipCount = 0;
  let i = 0;
  while (i < buffer.length - 2 && gzipCount < cap.acdMaxGzip && Date.now() - started < cap.acdMaxMs) {
    if (buffer[i] === 0x1f && buffer[i + 1] === 0x8b) {
      const result = await gunzip(buffer.subarray(i));
      gzipCount += 1;
      if (result && result.length > 10) {
        let text = result.toString('utf8');
        if (!text.includes('<') && !text.includes('Routine')) text = result.toString('utf16le');
        if (text.includes('<')) chunks.push(text);
        i += Math.max(4, Math.min(result.length, 4096));
        continue;
      }
    }
    i += 1;
  }
  return chunks.join('\n');
}

function usableName(name) {
  if (!name || JUNK.has(name)) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]{1,40}$/.test(name)) return false;
  if (/Element|Manager|Collection|Container|Metadata|Composite/i.test(name)) return false;
  return true;
}

async function parseAcd(project, buffer, env) {
  project.acdLimited = true;
  project.warnings.push('This is a Rockwell ACD file. Studio 5000 stores the logic in a proprietary format, so rung text cannot be read. Export L5X (File > Save As > L5X) and upload that file for a complete manual.');
  const xml = await extractXmlFromAcdBuffer(buffer, env);
  const names = new Set();
  if (xml) {
    for (const match of xml.matchAll(/(?:MainRoutineName|FaultRoutineName|EventRoutineName|Routine Name)="([^"]+)"/gi)) {
      if (usableName(match[1])) names.add(match[1]);
    }
    const controller = xml.match(/<Controller[^>]*Name="([^"]+)"/i);
    if (controller) project.controller = project.controller || controller[1];
  }
  if (!project.programs.length) project.programs.push('MainProgram');
  for (const name of names) {
    addRoutine(project, {
      name,
      type: 'RLL',
      program: project.programs[0],
      scopeKey: `${project.programs[0]}/${name}`,
      comment: '',
      units: [],
      language: 'acd',
    });
  }
  return project;
}

module.exports = { parseAcd, extractXmlFromAcdBuffer, usableName };
