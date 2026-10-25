const { exposed } = require('./errors');
const { parseUploads } = require('./parsers');
const { analyzeProject } = require('./ai');
const { buildDocument } = require('./manual/assemble');
const { renderHtml } = require('./manual/html');
const { renderPdf } = require('./manual/pdf');
const { assertCoverage } = require('./logic');

function throwIfStopped(signal) {
  if (!signal || !signal.aborted) return;
  const err = new Error('The run was stopped.');
  err.name = 'AbortError';
  throw err;
}

async function generateManual({ files, fields, project: parsed, anthropic, env, onProgress, renderPdf: render, signal }) {
  if (!anthropic) {
    throw exposed(503, 'Manual generation is temporarily unavailable.', 'ANTHROPIC_API_KEY is not configured');
  }
  const report = (stage, percent, message) => {
    if (onProgress) onProgress(stage, percent, message);
  };
  throwIfStopped(signal);
  report('parsing', 8, 'Reading project files');
  const project = parsed || await parseUploads(files, fields, env);
  throwIfStopped(signal);
  report('analyzing', 30, 'Describing how the equipment works');
  for (const routine of project.routines) {
    if (!routine.analysis) routine.analysis = null;
  }
  await analyzeProject(project, { anthropic, env, onProgress, signal });
  throwIfStopped(signal);
  if (project.routines.some((routine) => (routine.units || []).length)) assertCoverage(project);
  report('assembling', 72, 'Writing the manual');
  const document = buildDocument(project, { env, date: fields && fields.date });
  const html = renderHtml(document);
  throwIfStopped(signal);
  report('rendering', 88, 'Rendering the PDF');
  const pdf = await (render || renderPdf)(html, { signal });
  if (!pdf || pdf.length < 5 || pdf.subarray(0, 4).toString() !== '%PDF') {
    throw exposed(503, 'PDF rendering is temporarily unavailable.', 'Renderer did not return a PDF');
  }
  report('done', 100, 'Manual is ready');
  return {
    pdf,
    html,
    project,
    warnings: project.warnings,
    coverage: project.coverage,
  };
}

module.exports = { generateManual };
