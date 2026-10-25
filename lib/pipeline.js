const { exposed } = require('./errors');
const { parseUploads } = require('./parsers');
const { analyzeProject } = require('./ai');
const { buildDocument } = require('./manual/assemble');
const { renderHtml } = require('./manual/html');
const { renderPdf } = require('./manual/pdf');
const { assertCoverage } = require('./logic');
const { stampDocument } = require('./documents/stamp');

function paintPdf(render, html) {
  return (render || renderPdf)(html).then((pdf) => {
    if (!pdf || pdf.length < 5 || pdf.subarray(0, 4).toString() !== '%PDF') {
      throw exposed(503, 'PDF rendering is temporarily unavailable.', 'Renderer did not return a PDF');
    }
    return pdf;
  });
}

async function prepareProject({ files, fields, project: parsed, anthropic, env, onProgress }) {
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
  return project;
}

async function renderManualPdf(project, { env, fields, branding, render, onProgress }) {
  if (onProgress) onProgress('assembling', 72, 'Writing the manual');
  const document = buildDocument(project, { env, date: fields && fields.date, branding });
  if (branding && branding.whiteLabel) stampDocument(document, branding);
  const html = renderHtml(document);
  if (onProgress) onProgress('rendering', 88, 'Rendering the PDF');
  const pdf = await paintPdf(render, html);
  return { pdf, html, document };
}

async function generateManual({ files, fields, project: parsed, anthropic, env, onProgress, renderPdf: render, branding }) {
  const project = await prepareProject({ files, fields, project: parsed, anthropic, env, onProgress });
  const rendered = await renderManualPdf(project, { env, fields, branding, render, onProgress });
  if (onProgress) onProgress('done', 100, 'Manual is ready');
  return {
    pdf: rendered.pdf,
    html: rendered.html,
    project,
    warnings: project.warnings,
    coverage: project.coverage,
  };
}

module.exports = { generateManual, prepareProject, renderManualPdf, paintPdf };
