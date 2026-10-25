const library = require('../data/hazard-library.json');

function blobOf(project) {
  const parts = [];
  for (const tag of project.tags || []) parts.push(tag.name, tag.description, tag.device);
  for (const moduleNode of project.modules || []) parts.push(moduleNode.name, moduleNode.catalog, moduleNode.description);
  for (const routine of project.routines || []) {
    parts.push(routine.name, routine.comment);
    for (const unit of routine.units || []) parts.push(unit.comment, unit.text);
  }
  const cad = project.cad || {};
  for (const assembly of cad.assemblies || []) parts.push(assembly.name, assembly.description);
  for (const part of cad.bom || []) parts.push(part.description, part.partNumber);
  for (const line of cad.titleBlock || []) parts.push(line);
  return parts.filter(Boolean).join('\n').replace(/[_/]+/g, ' ').toLowerCase()
    .replace(/\bhex\s+drive\b/g, ' ')
    .replace(/\bdrive\s+screws?\b/g, ' ')
    .replace(/\bdrive\s+pulleys?\b/g, ' ')
    .replace(/\bscrewdrivers?\b/g, ' ')
    .replace(/\bknife\s+gates?\b/g, ' ')
    .replace(/\bpress-fit\b/g, ' ')
    .replace(/\bpress\s+fit\b/g, ' ');
}

function evidence(project) {
  const blob = blobOf(project);
  const has = (pattern) => pattern.test(blob);
  const voltage = Number(project.spec.voltage || 0);
  return {
    blob,
    plc: (project.routines || []).length > 0 || (project.tags || []).length > 0,
    cad: (project.cad.assemblies || []).length > 0,
    electrical: (project.modules || []).length > 0 || (project.routines || []).length > 0 || voltage > 0 || has(/electrical|plc|cabinet|disconnect/),
    drive: has(/\b(powerflex|kinetix|servos?|vfds?|inverters?|variable frequency|safe torque|\bsto\b|drive modules?)\b/) || has(/\bdrives?\b/),
    motion: has(/\b(cylinders?|conveyors?|motors?|agitat\w*|feeder screws?|robots?|axes|axis|clamps?|actuators?|solenoids?)\b/),
    rotating: has(/\b(conveyors?|belts?|rollers?|pulleys?|spindles?|motors?|shafts?|agitat\w*)\b/),
    cutting: has(/\b(blades?|saws?|shears?|cutters?|knives|knife)\b/),
    pneumatic: has(/\b(pneumatic|compressed air|air cylinders?|solenoids?|air supply|air valves?)\b/),
    hydraulic: has(/\bhydraulics?\b|\baccumulators?\b/),
    safety: has(/\b(e-?stops?|emergency stop|interlocks?|light curtains?|guards?|safe torque|safety relays?|safe off|\bsto\b)\b/),
    robot: has(/\brobot\b|manipulator|irb|fanuc/),
    vertical: has(/\b(hoists?|counterweights?|vertical axis|z axis|z-axis)\b/),
    hot: has(/\b(heaters?|hot melt|hot water|steam|heating)\b/),
    hotFluid: has(/\b(hot oil|steam|hot water|heating)\b/) || (has(/\btemperature\b/) && has(/\b(setpoint|set point|°)\b/)),
    cold: has(/cryogenic|chiller|refriger/),
    vessel: has(/\b(pressure vessels?|receivers?|oil separators?)\b/),
    processPressure: has(/\b(pressure control|pressure override|process pressure|line pressure|vessel pressure)\b/),
    processChemical: has(/\b(chemicals?|precursors?|caustic|solvents?|sanitizers?|purges?)\b/),
    vacuum: has(/\bvacuum\b/),
    spring: has(/\b(springs?|tensioners?)\b/),
    crush: has(/\b(cylinders?|clamps?|press tooling|\bpress\b|lifts?)\b/),
    spindle: has(/spindle|chuck|grinding wheel/),
    magnet: has(/permanent magnet|magnetic chuck|induction/),
    uv: has(/\buv\b|weld/),
    chemical: has(/coolant|lubricant|oil|adhesive|solvent/),
    dust: has(/dust|fume|extraction|hood/),
    flammable: has(/flammable|magnesium|titanium|fuel/),
    inertGas: has(/nitrogen|argon|inert gas/),
    platform: has(/platform|ladder|stair|height/),
    mode: has(/auto|manual|setup|teach|jog/),
    food: has(/food|pharma|h1 lubricant/),
    externalSupply: has(/host line|external supply|orange wire/),
    autoRestart: has(/auto-?restart|flying restart/),
    laserHigh: /class\s*(3b|4)/i.test(blob),
    laserLow: /class\s*(2|2m|3r)/i.test(blob),
    noiseDb: Number(project.spec.soundPressure || 0),
    vibration: Number(project.spec.vibration || 0) > 2.5,
    voltage,
    heavy: has(/\d{2,}\s*kg/) || (project.cad.assemblies || []).length > 0,
  };
}

const RULES = {
  'elec.shock_live': (e) => e.electrical,
  'elec.stored_capacitor': (e) => e.drive,
  'elec.arc_flash': (e) => e.voltage >= 208 || (e.electrical && e.drive),
  'elec.residual_voltage_external': (e) => e.externalSupply,
  'elec.unexpected_restart': (e) => e.autoRestart,
  'mech.crushing': (e) => e.crush,
  'mech.shearing_cutting': (e) => e.cutting,
  'mech.entanglement': (e) => e.rotating,
  'mech.ejection': (e) => e.spindle,
  'mech.robot_motion': (e) => e.robot,
  'mech.gravity': (e) => e.vertical,
  'mech.lifting_transport': (e) => e.cad || e.heavy,
  'mech.stability': (e) => e.cad,
  'mech.slip_trip_fall': (e) => e.platform,
  'fluid.hydraulic_pressure': (e) => e.hydraulic,
  'fluid.pneumatic_pressure': (e) => e.pneumatic,
  'fluid.pressure_vessel': (e) => e.vessel,
  'mech.spring_energy': (e) => e.spring,
  'therm.hot_surface': (e) => e.hot,
  'therm.hot_fluids': (e) => e.hotFluid,
  'therm.cold': (e) => e.cold,
  'noise.hearing': (e) => e.noiseDb > 80,
  'vib.hand_arm': (e) => e.vibration,
  'rad.laser': (e) => e.laserHigh,
  'rad.laser_low': (e) => e.laserLow,
  'rad.emf_magnet': (e) => e.magnet,
  'rad.uv_ir': (e) => e.uv,
  'chem.fluids': (e) => e.chemical,
  'chem.dust_fumes': (e) => e.dust,
  'fire.flammable': (e) => e.flammable,
  'chem.asphyxiation': (e) => e.inertGas,
  'ergo.manual_handling': (e) => e.heavy && e.cad,
  'ergo.workstation': () => false,
  'ctrl.bypass': (e) => e.safety,
  'ctrl.program_change': (e) => e.plc,
  'ctrl.manual_mode': (e) => e.mode && e.plc,
  'prop.equipment_damage': (e) => e.plc || e.cad || e.electrical,
  'prop.esd': (e) => e.plc,
  'hyg.food_contact': (e) => e.food,
};

function supplementalHazards(facts) {
  const out = [];
  if (facts.processPressure) {
    out.push({
      id: 'fluid.process_pressure',
      signal_word: 'WARNING',
      hazard: 'Process pressure in lines, vessels, or headers.',
      consequence: 'A release of pressure can cause serious injury.',
      avoidance: [
        'Isolate the source and apply locks and tags before you bleed pressure.',
        'Confirm the pressure is zero before opening a fitting.',
      ],
      applies_to_sections: ['safety.residual_risks', 'safety.energy_isolation', 'maint.safety', 'maint.procedures'],
    });
  }
  if (facts.processChemical) {
    out.push({
      id: 'chem.process_chemical',
      signal_word: 'WARNING',
      hazard: 'Process chemicals, precursors, or purge gas in lines and vessels.',
      consequence: 'Contact, inhalation, or a release can cause serious injury.',
      avoidance: [
        'Close and lock the supply, then drain or purge into the site collection point.',
        'Wear the PPE named by the site chemical procedure.',
      ],
      applies_to_sections: ['safety.residual_risks', 'safety.energy_isolation', 'safety.ppe', 'maint.safety'],
    });
  }
  if (facts.vacuum) {
    out.push({
      id: 'fluid.vacuum',
      signal_word: 'WARNING',
      hazard: 'Vacuum in lines, cups, or process chambers.',
      consequence: 'Opening a fitting under vacuum can pull material or a body part inward, and a sudden vent can throw debris.',
      avoidance: [
        'Shut off the vacuum and vent the line to atmosphere before you open a fitting.',
      ],
      applies_to_sections: ['safety.residual_risks', 'safety.energy_isolation', 'maint.procedures'],
    });
  }
  return out;
}

function matchedHazards(project) {
  const facts = evidence(project);
  const hazards = [];
  const seen = new Set();
  const push = (hazard) => {
    if (!hazard || seen.has(hazard.id)) return;
    seen.add(hazard.id);
    hazards.push({ ...hazard, inferred: true });
  };
  for (const hazard of library.hazards) {
    const rule = RULES[hazard.id];
    if (rule && rule(facts)) push(hazard);
  }
  for (const hazard of supplementalHazards(facts)) push(hazard);
  return hazards;
}

function hazardsForSection(hazards, sectionId) {
  return hazards.filter((hazard) => (hazard.applies_to_sections || []).includes(sectionId));
}

function energyBlob(subsystem) {
  return `${subsystem.name || ''} ${(subsystem.components || []).join(' ')} ${(subsystem.motions || []).join(' ')}`.toLowerCase();
}

function isStaticPart(subsystem) {
  if (!subsystem) return true;
  if (subsystem.role === 'structure') return true;
  const blob = energyBlob(subsystem);
  if (/\b(conveyor|belt|roller|motor|cylinder|gripper|wheel|servo|valve|pump|robot|spindle|pulley|actuator|solenoid|heater|axis)\b/.test(blob)) {
    return false;
  }
  return !(subsystem.groups || []).length;
}

function hazardsForSubsystem(hazards, subsystem) {
  if (isStaticPart(subsystem)) return [];
  const blob = energyBlob(subsystem);
  const crushing = /\bcylinder\b|\bclamp\b/.test(blob) || (/\bpress\b/.test(blob) && !/\bpressure\b/.test(blob));
  const pneumatic = /\bpneumatic\b|\bcompressed air\b|\bvacuum\b|\bsolenoid\b|\bcylinder\b/.test(blob);
  const entanglement = /\bconveyor\b|\bbelt\b|\broller\b|\bmotor\b|\bpulley\b|\bspindle\b|\bshaft\b|\bwheel\b/.test(blob);
  const guard = /\bguard\b|\bdoor\b|\binterlock\b|\bestop\b|\be-stop\b/.test(blob);
  const hot = /\b(heater|steam|hot water|heating|hot)\b/.test(blob);
  const hotFluid = /\b(steam|hot water|hot oil|heating)\b/.test(blob);
  return hazards.filter((hazard) => {
    if (!(hazard.applies_to_sections || []).includes('product.subsystem_function') && !/mech\.|therm\.|fluid\.pneumatic|fluid\.process_pressure|chem\.process_chemical|ctrl\.manual/.test(hazard.id)) {
      return false;
    }
    if (hazard.id === 'mech.entanglement') return entanglement;
    if (hazard.id === 'mech.crushing') return crushing;
    if (hazard.id === 'fluid.pneumatic_pressure') return pneumatic;
    if (hazard.id === 'ctrl.bypass') return guard;
    if (hazard.id === 'therm.hot_surface') return hot;
    if (hazard.id === 'therm.hot_fluids') return hotFluid;
    if (hazard.id === 'fluid.process_pressure') return /\bpressure\b/.test(blob);
    if (hazard.id === 'chem.process_chemical') return /\b(chemical|precursor|purge|caustic|solvent)\b/.test(blob);
    return false;
  });
}

function renderHazard(hazard, subsystemName) {
  const avoidance = (hazard.avoidance || []).map((step) => String(step)
    .replace(/\{discharge_time_min\}/g, 'the discharge time printed on the drive label or in the drive manual')
    .replace(/\(\s*5\s*min\s*\)/gi, '')
    .replace(/\bbelow 50 V\b/gi, 'below the voltage stated on the drive label or in the drive manual')
    .replace(/\s{2,}/g, ' ')
    .trim());
  let hazardText = hazard.hazard;
  const name = String(subsystemName || '');
  const softwareName = /\b(control|sequence|logic|routine)\b/i.test(name);
  if (name && !softwareName && !hazardText.toLowerCase().includes(name.toLowerCase())) {
    hazardText = `${hazardText.replace(/\.$/, '')} on the ${name}.`;
  }
  return { ...hazard, hazard: hazardText, avoidance, inferred: true };
}

module.exports = {
  library,
  evidence,
  matchedHazards,
  hazardsForSection,
  hazardsForSubsystem,
  isStaticPart,
  renderHazard,
};
