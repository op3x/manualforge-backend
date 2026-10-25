const AdmZip = require('adm-zip');
const {
  PDFDocument, StandardFonts, rgb, PDFName, PDFHexString, PDFNumber,
} = require('pdf-lib');

function safeFileName(title, fallback) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || fallback || 'document'}.pdf`;
}

function drawContents(page, font, bold, sections) {
  const width = page.getWidth();
  page.drawText('Contents', { x: 54, y: page.getHeight() - 72, size: 18, font: bold, color: rgb(0.07, 0.19, 0.31) });
  page.drawText('Page numbers continue through every document in this file.', {
    x: 54,
    y: page.getHeight() - 96,
    size: 10,
    font,
    color: rgb(0.2, 0.28, 0.36),
  });
  let y = page.getHeight() - 130;
  sections.forEach((section, index) => {
    const title = `${index + 1}.  ${section.title}`;
    page.drawText(title, { x: 54, y, size: 12, font, color: rgb(0.1, 0.15, 0.2) });
    const label = String(section.page);
    const labelWidth = font.widthOfTextAtSize(label, 12);
    page.drawText(label, { x: width - 54 - labelWidth, y, size: 12, font, color: rgb(0.1, 0.15, 0.2) });
    y -= 22;
  });
}

function stampPageNumbers(pdf, font) {
  const total = pdf.getPageCount();
  pdf.getPages().forEach((page, index) => {
    const label = `Page ${index + 1} of ${total}`;
    const size = 9;
    const width = font.widthOfTextAtSize(label, size);
    const x = page.getWidth() - 36 - width;
    page.drawRectangle({ x: x - 4, y: 10, width: width + 10, height: 14, color: rgb(1, 1, 1) });
    page.drawText(label, { x, y: 14, size, font, color: rgb(0.25, 0.32, 0.4) });
  });
}

function addOutline(pdf, items) {
  if (!items.length) return;
  const context = pdf.context;
  const outlinesRef = context.nextRef();
  const refs = items.map(() => context.nextRef());
  items.forEach((item, index) => {
    const page = pdf.getPage(item.page);
    const entry = {
      Title: PDFHexString.fromText(item.title),
      Parent: outlinesRef,
      Dest: [page.ref, PDFName.of('Fit')],
    };
    if (index > 0) entry.Prev = refs[index - 1];
    if (index < items.length - 1) entry.Next = refs[index + 1];
    context.assign(refs[index], context.obj(entry));
  });
  context.assign(outlinesRef, context.obj({
    Type: PDFName.of('Outlines'),
    First: refs[0],
    Last: refs[refs.length - 1],
    Count: PDFNumber.of(items.length),
  }));
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

async function mergePdfs(buffers, titles = []) {
  const merged = await PDFDocument.create();
  const font = await merged.embedFont(StandardFonts.Helvetica);
  const bold = await merged.embedFont(StandardFonts.HelveticaBold);
  const contents = merged.addPage([612, 792]);
  const sections = [];
  for (let index = 0; index < buffers.length; index += 1) {
    const source = await PDFDocument.load(buffers[index]);
    const start = merged.getPageCount();
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
    sections.push({
      title: titles[index] || `Document ${index + 1}`,
      page: start + 1,
      index: start,
    });
  }
  drawContents(contents, font, bold, sections);
  stampPageNumbers(merged, font);
  addOutline(merged, [
    { title: 'Contents', page: 0 },
    ...sections.map((section) => ({ title: section.title, page: section.index })),
  ]);
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
