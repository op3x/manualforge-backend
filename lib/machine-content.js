function noMachineContent(project) {
  if (!project) return false;
  const sources = project.sources || [];
  if (!sources.length) return false;
  const drawing = sources.every((source) => {
    const format = String(source.format || '').toLowerCase();
    const name = String(source.name || '');
    return format === 'dxf' || /\.dxf$/i.test(name);
  });
  if (!drawing) return false;
  const cad = project.cad || {};
  const machine = (project.routines || []).some((routine) => (routine.units || []).length)
    || (project.tags || []).length > 0
    || (project.modules || []).length > 0
    || (project.programs || []).length > 0
    || (cad.assemblies || []).length > 0
    || (cad.parts || []).length > 0
    || (cad.bom || []).length > 0
    || Boolean(cad.meshOnly)
    || Boolean(cad.bodyCount)
    || Boolean(project.acdLimited);
  return !machine;
}

module.exports = { noMachineContent };
