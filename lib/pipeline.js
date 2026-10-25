const { exposed } = require('./errors');
const { parseUploads } = require('./parsers');
const { analyzeProject } = require('./ai');
const { buildDocument } = require('./manual/assemble');
const { renderHtml } = require('./manual/html');
const { renderPdf } = require('./manual/pdf');
const { assertCoverage } = require('./logic');
const { noMachineContent, lowContent } = require('./machine-content');

async function generateManual({ files, fields, project: parsed, anthropic, env, onProgress, renderPdf: render }) {
  if (!anthropic) {
    throw exposed(503, 'Manual generation is temporarily unavailable.', 'ANTHROPIC_API_KEY is not configured');
  }
  const report = (stage, percent, message) => {
    if (onProgress) onProgress(stage, percent, message);
  };
  report('parsing', 8, 'Reading project files');
  const project = parsed || await parseUploads(files, fields, env);
  report('analyzing', 30, 'Describing how the equipment works');
  for (const routine of project.routines) {
    if (!routine.analysis) routine.analysis = null;
  }
  await analyzeProject(project, { anthropic, env, onProgress });
  if (project.routines.some((routine) => (routine.units || []).length)) assertCoverage(project);
  report('assembling', 72, 'Writing the manual');
  const document = buildDocument(project, { env, date: fields && fields.date });
  const html = renderHtml(document);
  report('rendering', 88, 'Rendering the PDF');
  const pdf = await (render || renderPdf)(html);
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
    noMachineContent: noMachineContent(project),
    lowContent: lowContent(project),
  };
}

module.exports = { generateManual, noMachineContent, lowContent };
