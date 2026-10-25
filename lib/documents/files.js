const AdmZip = require('adm-zip');
const { PDFDocument } = require('pdf-lib');

function safeFileName(title, fallback) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || fallback || 'document'}.pdf`;
}

async function mergePdfs(buffers) {
  const merged = await PDFDocument.create();
  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

function zipDocuments(outputs, combined) {
  const zip = new AdmZip();
  const used = new Set();
  for (const output of outputs) {
    let name = safeFileName(output.title, output.id);
    if (used.has(name)) name = safeFileName(`${output.title}-${output.id}`, output.id);
    used.add(name);
    zip.addFile(name, output.pdf);
  }
  if (combined) zip.addFile('all-documents.pdf', combined);
  return zip.toBuffer();
}

module.exports = { safeFileName, mergePdfs, zipDocuments };
