const crypto = require('crypto');

function emptyProject() {
  return {
    identity: {
      manufacturerName: '',
      manufacturerAddress: '',
      productName: '',
      model: '',
      docNumber: '',
      revision: '',
      language: 'English (original instructions)',
      serialPlaceholder: '________________',
    },
    controller: '',
    programs: [],
    routines: [],
    tags: [],
    modules: [],
    tasks: [],
    aois: [],
    safetyPrograms: [],
    safetyTasks: [],
    partialExport: false,
    alarms: [],
    cad: {
      assemblies: [],
      parts: [],
      bom: [],
      boundingBox: null,
      layers: [],
      blocks: [],
      titleBlock: [],
    },
    spec: {},
    sources: [],
    warnings: [],
    acdLimited: false,
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function addSource(project, file, format) {
  project.sources.push({
    name: file.name,
    format,
    sha256: sha256(file.buffer).slice(0, 16),
    bytes: file.buffer.length,
  });
}

function applyFields(project, fields = {}) {
  const pick = (key) => (typeof fields[key] === 'string' ? fields[key].trim() : '');
  const brand = pick('brand');
  if (brand && !project.identity.manufacturerName) project.identity.manufacturerName = brand;
  const map = {
    manufacturer_name: 'manufacturerName',
    manufacturer_address: 'manufacturerAddress',
    product_name: 'productName',
    model: 'model',
    doc_number: 'docNumber',
    revision: 'revision',
    language: 'language',
  };
  for (const [from, to] of Object.entries(map)) {
    const value = pick(from);
    if (value) project.identity[to] = value;
    if (value && from === 'product_name') project.identity.productNameFromUser = true;
  }
  const manualDate = pick('date');
  if (manualDate) project.identity.manualDate = manualDate;
}

function upsertTag(project, tag) {
  if (!tag || !tag.name) return;
  const existing = project.tags.find((item) => item.name.toLowerCase() === tag.name.toLowerCase());
  if (!existing) {
    project.tags.push({
      name: tag.name,
      dataType: tag.dataType || '',
      description: tag.description || '',
      address: tag.address || '',
      aliasFor: tag.aliasFor || '',
      direction: tag.direction || '',
      scope: tag.scope || '',
      device: tag.device || '',
    });
    return;
  }
  for (const key of ['dataType', 'description', 'address', 'aliasFor', 'direction', 'scope', 'device']) {
    if (!existing[key] && tag[key]) existing[key] = tag[key];
  }
}

function addRoutine(project, routine) {
  if (!routine || !routine.name) return;
  const key = `${routine.program || ''}::${routine.name}`.toLowerCase();
  const existing = project.routines.find((item) => `${item.program || ''}::${item.name}`.toLowerCase() === key);
  if (!existing) {
    project.routines.push(routine);
    return;
  }
  if ((routine.units || []).length > (existing.units || []).length) existing.units = routine.units;
  if (!existing.comment && routine.comment) existing.comment = routine.comment;
  if (!existing.type && routine.type) existing.type = routine.type;
  if (routine.safety) existing.safety = true;
  if (routine.aoi) existing.aoi = true;
  if (!existing.scopeKey && routine.scopeKey) existing.scopeKey = routine.scopeKey;
}

module.exports = { emptyProject, sha256, addSource, applyFields, upsertTag, addRoutine };
