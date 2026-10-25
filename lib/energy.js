// Energy sources for the lockout table. Ported from the extra-documents
// equipment classifier (cursor/extra-documents-0be1) and limited to the
// manual: a row is emitted only when the upload shows that energy.

function partsOf(project) {
  const parts = [];
  for (const tag of project.tags || []) parts.push(tag.name, tag.description, tag.device, tag.dataType);
  for (const moduleNode of project.modules || []) parts.push(moduleNode.name, moduleNode.catalog, moduleNode.description);
  for (const routine of project.routines || []) {
    parts.push(routine.name, routine.comment);
    for (const unit of routine.units || []) parts.push(unit.comment, unit.text);
  }
  const cad = project.cad || {};
  for (const assembly of cad.assemblies || []) parts.push(assembly.name, assembly.description, assembly.kind);
  for (const part of cad.bom || []) parts.push(part.description, part.partNumber);
  for (const line of cad.titleBlock || []) parts.push(line);
  return parts.filter(Boolean).join('\n');
}

function projectBlob(project) {
  return partsOf(project).replace(/[_/]+/g, ' ').toLowerCase();
}

function neutralBlob(blob) {
  return String(blob || '')
    .replace(/\bhex\s+drive\b/g, ' ')
    .replace(/\bdrive\s+screws?\b/g, ' ')
    .replace(/\bdrive\s+pulleys?\b/g, ' ')
    .replace(/\bscrewdrivers?\b/g, ' ')
    .replace(/\bknife\s+gates?\b/g, ' ');
}

function has(blob, pattern) {
  return pattern.test(blob);
}

function electricalSource(project, blob) {
  const strong = has(blob, /\b(vfds?|inverters?|powerflex|kinetix|servos?|motors?|disconnect|electrical cabinet|variable frequency)\b/)
    || (project.modules || []).length > 0
    || Number((project.spec || {}).voltage || 0) > 0;
  if (strong) return 'From your files';
  const plc = (project.routines || []).some((routine) => (routine.units || []).length) || (project.tags || []).length > 0;
  if (plc) return 'Typical — confirm';
  return '';
}

function row(energy, release, verify, source) {
  return {
    energy,
    isolation: 'Confirm on the machine',
    deviceId: '____________',
    release: `After the lock and tag are on, ${release}`,
    verify,
    source,
  };
}

function energyRows(project) {
  const blob = neutralBlob(projectBlob(project));
  const rows = [];
  const electrical = electricalSource(project, blob);
  if (electrical) {
    rows.push(row(
      'Electrical supply',
      'wait until drives and power supplies have discharged for the time printed on the drive label or in the drive manual, then test for absence of voltage.',
      'The start control does nothing, and a voltage test shows the circuit is de-energized.',
      electrical,
    ));
  }
  const pneumatic = has(blob, /\b(pneumatic|compressed air|air cylinders?|solenoids?|air supply|air valves?)\b/);
  if (pneumatic) {
    rows.push(row(
      'Pneumatic',
      'exhaust residual air. Support a load that a cylinder is holding before you open a fitting.',
      'The supply gauge reads zero.',
      'From your files',
    ));
  }
  if (has(blob, /\bhydraulics?\b|\baccumulators?\b/)) {
    rows.push(row(
      'Hydraulic',
      'stop the pump, isolate the supply, and dump stored pressure, including an accumulator if one is fitted.',
      'Gauges read zero and lines are not holding a load.',
      'From your files',
    ));
  }
  const thermal = has(blob, /\b(steam|steaming|heaters?|heating|hot water|hot oil|heat exchanger)\b/)
    || (has(blob, /\btemperature\b/) && has(blob, /\b(setpoint|set point|°)\b/));
  if (thermal) {
    rows.push(row(
      'Steam or heat',
      'confirm the steam or heat supply is closed. Vent residual steam, drain hot fluid, and wait until the vessel, jackets, and piping have cooled. Treat those surfaces as hot until they have cooled.',
      'The steam or heat supply is isolated, residual pressure is vented, and surfaces have cooled.',
      'From your files',
    ));
  }
  const processFluid = has(blob, /\b(pumps?|process fluids?|mash|feeder screws?)\b/) && !has(blob, /\bhydraulic pump\b/);
  if (processFluid) {
    const hot = thermal || has(blob, /\b(water|steam|hot)\b/);
    rows.push(row(
      'Process fluid',
      hot
        ? 'stop the pump. Drain hot fluid before you open a line.'
        : 'stop the pump before you open a line.',
      'The pump does not start and the line is drained or blocked.',
      'From your files',
    ));
  }
  if (has(blob, /\bvacuum\b/)) {
    rows.push(row(
      'Vacuum',
      'vent the vacuum line to atmosphere before you open a fitting.',
      'The vacuum gauge reads the same as the room.',
      'From your files',
    ));
  }
  if (has(blob, /\b(chemicals?|precursors?|caustic|solvents?|sanitizers?|purges?)\b/)) {
    rows.push(row(
      'Process chemical',
      'drain and flush the line into the site collection point before you open a fitting. Purge only with the gas the site procedure names.',
      'The supply is closed and locked, and the line is drained or purged.',
      'From your files',
    ));
  }
  if (has(blob, /\bagitat/)) {
    rows.push(row(
      'Rotating agitator',
      'confirm the agitator is no longer turning before you open the vessel.',
      'The agitator is still, and its drive does not respond to a start.',
      'From your files',
    ));
  }
  const pressure = has(blob, /\b(pressure control|pressure override|process pressure|line pressure|vessel pressure)\b/);
  if (pressure) {
    rows.push(row(
      'Process pressure',
      'bleed the line or vessel to a safe location. Do not open a fitting while it is under pressure.',
      'The pressure gauge reads zero.',
      'From your files',
    ));
  }
  if (has(blob, /\b(hoists?|counterweights?|vertical axis|z axis|holding brakes?)\b/)) {
    rows.push(row(
      'Gravity or stored mechanical energy',
      'lower the load or block it so it cannot move.',
      'The load cannot move while the block is in place.',
      'From your files',
    ));
  }
  const valve = has(blob, /\bvalves?\b/);
  const knownContents = thermal || processFluid || pneumatic || has(blob, /\bhydraulics?\b/) || has(blob, /\b(chemicals?|precursors?|purges?)\b/);
  if (valve && !knownContents) {
    rows.push(row(
      'Controlled line',
      'release whatever the line holds. Contents were not named in the upload.',
      'The line is isolated. Contents to be confirmed.',
      'Typical — confirm',
    ));
  }
  return rows;
}

function hasRealDrive(project) {
  const blob = neutralBlob(projectBlob(project));
  return /\b(powerflex|kinetix|servos?|vfds?|inverters?|variable frequency|safe torque|\bsto\b|drive modules?)\b/.test(blob)
    || /\bdrives?\b/.test(blob);
}

module.exports = {
  projectBlob,
  neutralBlob,
  energyRows,
  hasRealDrive,
};
