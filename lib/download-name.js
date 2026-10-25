function sourceName(project) {
  const identity = project && project.identity ? project.identity : {};
  const product = typeof identity.productName === 'string' ? identity.productName.trim() : '';
  const company = typeof identity.manufacturerName === 'string' ? identity.manufacturerName.trim() : '';
  return product || company || '';
}

// The first 8 hex characters of job_<24 hex>. Anything else, including a
// product or company name, produces no token so it cannot land in the filename.
function shortJobId(id) {
  const match = /^job_([a-f0-9]{8})/i.exec(String(id || ''));
  return match ? match[1].toLowerCase() : '';
}

function downloadFileName(jobId) {
  const short = shortJobId(jobId);
  return short ? `manual-${short}.pdf` : 'manual.pdf';
}

function contentDisposition(jobId) {
  return `attachment; filename="${downloadFileName(jobId)}"`;
}

module.exports = {
  sourceName,
  shortJobId,
  downloadFileName,
  contentDisposition,
};
