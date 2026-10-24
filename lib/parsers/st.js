const { addRoutine, upsertTag } = require('../project');

const BLOCK_RE = /\b(PROGRAM|FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK)\b\s+"?([A-Za-z_][A-Za-z0-9_]*)"?([\s\S]*?)\bEND_\1\b/gi;

function parseSt(project, text) {
  const source = String(text || '');
  let found = false;
  for (const match of source.matchAll(BLOCK_RE)) {
    found = true;
    const kind = match[1].toUpperCase();
    const name = match[2];
    const body = match[3] || '';
    const varMatch = body.match(/\bVAR(?:_INPUT|_OUTPUT|_IN_OUT|_GLOBAL)?\b([\s\S]*?)\bEND_VAR\b/i);
    if (varMatch) {
      for (const line of varMatch[1].split(/\r?\n/)) {
        const decl = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_]+)/);
        if (!decl) continue;
        const comment = (line.match(/\(\*\s*([\s\S]*?)\s*\*\)/) || line.match(/\/\/\s*(.+)$/) || [])[1] || '';
        upsertTag(project, { name: decl[1], dataType: decl[2], description: comment.trim(), scope: name });
      }
    }
    const code = body.replace(/\bVAR(?:_INPUT|_OUTPUT|_IN_OUT|_GLOBAL)?\b[\s\S]*?\bEND_VAR\b/gi, '').trim();
    const chunks = code.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    const units = (chunks.length ? chunks : [code]).filter(Boolean).map((chunk, index) => ({
      index,
      number: index,
      kind: 'statement',
      text: chunk.replace(/\(\*[\s\S]*?\*\)/g, '').trim(),
      comment: ((chunk.match(/\(\*\s*([\s\S]*?)\s*\*\)/) || [])[1] || '').trim(),
    }));
    if (!project.programs.includes(name)) project.programs.push(name);
    addRoutine(project, {
      name,
      type: kind,
      program: name,
      comment: '',
      units,
      language: 'st',
    });
  }
  if (!found) {
    const err = new Error('no st block');
    err.status = 422;
    err.expose = true;
    err.message = 'This structured-text file does not contain a PROGRAM, FUNCTION, or FUNCTION_BLOCK. Check the export.';
    throw err;
  }
  return project;
}

module.exports = { parseSt };
