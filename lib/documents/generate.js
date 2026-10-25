const { exposed } = require('../errors');
const { prepareProject, renderManualPdf, paintPdf } = require('../pipeline');
const { renderHtml } = require('../manual/html');
const { buildExtraDocument } = require('./content');
const { mergePdfs, zipDocuments } = require('./files');

function progressLabel(entry) {
  if (entry.kind === 'pm_schedule') return 'Writing the preventive maintenance schedule';
  if (entry.kind === 'shutdown') return 'Writing the shutdown procedure';
  if (entry.kind === 'startup') return 'Writing the startup procedure';
  if (entry.kind === 'manual') return 'Writing the manual';
  return 'Writing an additional document';
}

async function generatePackage({
  files,
  fields,
  project: parsed,
  anthropic,
  env,
  onProgress,
  renderPdf: render,
  branding,
  selection,
}) {
  if (!selection || !Array.isArray(selection.entries) || !selection.entries.length) {
    throw exposed(400, 'Select at least one document.');
  }
  const project = await prepareProject({ files, fields, project: parsed, anthropic, env, onProgress });
  const outputs = [];
  const documents = [];
  const warnings = [];
  const pending = selection.entries.length;
  let index = 0;
  for (const entry of selection.entries) {
    index += 1;
    if (entry.status === 'skipped' || entry.related === false) {
      documents.push({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        status: 'skipped',
        reason: entry.reason || 'This request is not about the uploaded equipment, so it was not generated.',
      });
      warnings.push(documents[documents.length - 1].reason);
      continue;
    }
    const percent = 70 + Math.round((index / pending) * 25);
    if (onProgress) onProgress('assembling', Math.min(percent, 94), progressLabel(entry));
    let pdf;
    let title = entry.title;
    if (entry.kind === 'manual') {
      const rendered = await renderManualPdf(project, { env, fields, branding, render, onProgress: null });
      pdf = rendered.pdf;
      title = 'Operating and Maintenance Manual';
    } else {
      const document = buildExtraDocument(project, entry, { branding, fields, env });
      title = (document.cover && document.cover.subtitle) || entry.title;
      if (onProgress) onProgress('rendering', Math.min(percent + 2, 96), 'Rendering a PDF');
      pdf = await paintPdf(render, renderHtml(document));
    }
    outputs.push({ id: entry.id, kind: entry.kind, title, pdf });
    documents.push({ id: entry.id, kind: entry.kind, title, status: 'ready', reason: null });
  }
  if (!outputs.length) {
    throw exposed(422, 'No document could be generated from this request. Extra requests must describe the uploaded equipment.');
  }
  const combined = outputs.length === 1 ? outputs[0].pdf : await mergePdfs(outputs.map((item) => item.pdf));
  const zip = zipDocuments(outputs, outputs.length > 1 ? combined : null);
  for (const warning of project.warnings || []) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  if (onProgress) onProgress('done', 100, selection.requestsExtras ? 'Documents are ready' : 'Manual is ready');
  return {
    project,
    outputs,
    documents,
    combined,
    zip,
    warnings,
    coverage: project.coverage,
  };
}

module.exports = { generatePackage };
