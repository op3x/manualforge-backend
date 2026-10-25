function hasProgram(project) {
  return (project.routines || []).some((routine) => (routine.units || []).length)
    || (project.tags || []).length > 0
    || (project.modules || []).length > 0
    || (project.programs || []).length > 0
    || Boolean(project.acdLimited);
}

function geometryOnlyMesh(project) {
  const cad = (project && project.cad) || {};
  if (!cad.meshOnly) return false;
  if (hasProgram(project)) return false;
  if ((cad.bom || []).length) return false;
  const named = (cad.assemblies || []).some((item) => item && item.source !== 'stl');
  return !named;
}

function drawingWithoutMachine(project) {
  const sources = (project && project.sources) || [];
  if (!sources.length) return false;
  const drawing = sources.every((source) => {
    const format = String(source.format || '').toLowerCase();
    const name = String(source.name || '');
    return format === 'dxf' || /\.dxf$/i.test(name);
  });
  if (!drawing) return false;
  const cad = project.cad || {};
  const machine = hasProgram(project)
    || (cad.assemblies || []).length > 0
    || (cad.parts || []).length > 0
    || (cad.bom || []).length > 0
    || Boolean(cad.bodyCount);
  return !machine;
}

function noMachineContent(project) {
  if (!project) return false;
  return drawingWithoutMachine(project) || geometryOnlyMesh(project);
}

function lowContent(project) {
  return noMachineContent(project);
}

module.exports = { noMachineContent, lowContent, geometryOnlyMesh };
