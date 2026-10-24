const library = require('../data/hazard-library.json');

function blobOf(project) {
  const parts = [];
  for (const tag of project.tags || []) parts.push(tag.name, tag.description, tag.device);
  for (const moduleNode of project.modules || []) parts.push(moduleNode.name, moduleNode.catalog, moduleNode.description);
  for (const routine of project.routines || []) {
    parts.push(routine.comment);
    for (const unit of routine.units || []) parts.push(unit.comment);
  }
  for (const assembly of project.cad.assemblies || []) parts.push(assembly.name, assembly.description);
  for (const part of project.cad.bom || []) parts.push(part.description, part.partNumber);
  for (const line of project.cad.titleBlock || []) parts.push(line);
  return parts.filter(Boolean).join('\n').toLowerCase();
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
    drive: has(/powerflex|kinetix|servo|vfd|inverter|\bdrive\b/),
    motion: has(/cylinder|conveyor|motor|solenoid|axis|clamp|actuator|valve/),
    rotating: has(/conveyor|belt|roller|pulley|spindle|motor|shaft/),
    cutting: has(/knife|blade|saw|shear|cutter/),
    pneumatic: has(/valve|pneumatic|vacuum|cylinder|\bair\b|solenoid/),
    hydraulic: has(/hydraulic|accumulator/),
    safety: has(/e-?stop|interlock|light curtain|guard|safe torque|safety/),
    robot: has(/\brobot\b|manipulator|irb|fanuc/),
    vertical: has(/vertical|hoist|brake|\bz[- ]?axis/),
    hot: has(/heater|hot-?melt|glue|exhaust|spindle/),
    hotFluid: has(/hot oil|steam/),
    cold: has(/cryogenic|chiller|refriger/),
    vessel: has(/receiver|pressure vessel|tank/),
    spring: has(/spring|tensioner/),
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
  'mech.crushing': (e) => e.motion,
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

function matchedHazards(project) {
  const facts = evidence(project);
  const hazards = [];
  for (const hazard of library.hazards) {
    const rule = RULES[hazard.id];
    if (rule && rule(facts)) hazards.push({ ...hazard, inferred: true });
  }
  return hazards;
}

function hazardsForSection(hazards, sectionId) {
  return hazards.filter((hazard) => (hazard.applies_to_sections || []).includes(sectionId));
}

const MOTION_OR_GUARD = new Set([
  'mech.crushing', 'mech.shearing_cutting', 'mech.entanglement', 'mech.ejection', 'mech.robot_motion',
  'mech.gravity', 'mech.lifting_transport', 'mech.stability', 'mech.spring_energy', 'ctrl.bypass',
]);

function isStaticPart(subsystem) {
  if (!subsystem) return true;
  if (subsystem.role === 'structure') return true;
  const blob = `${subsystem.name} ${(subsystem.components || []).join(' ')} ${(subsystem.motions || []).join(' ')}`;
  if (/conveyor|belt|roller|motor|cylinder|axis|gripper|wheel|servo|valve|pump|robot|spindle|pulley|actuator|solenoid|heater/i.test(blob)) {
    return false;
  }
  return !(subsystem.groups || []).length;
}

function hazardsForSubsystem(hazards, subsystem) {
  const blob = `${subsystem.name} ${(subsystem.components || []).join(' ')} ${(subsystem.motions || []).join(' ')} ${subsystem.purpose || ''}`.toLowerCase();
  const staticPart = isStaticPart(subsystem);
  return hazards.filter((hazard) => {
    if (staticPart && MOTION_OR_GUARD.has(hazard.id)) return false;
    if (!(hazard.applies_to_sections || []).includes('product.subsystem_function') && !/mech\.|therm\.|fluid\.pneumatic|ctrl\.manual/.test(hazard.id)) {
      return false;
    }
    return (
      /conveyor|belt|roller|motor|pulley|spindle|shaft/.test(blob) && hazard.id === 'mech.entanglement'
    ) || (
      /cylinder|clamp|axis|press/.test(blob) && hazard.id === 'mech.crushing'
    ) || (
      /valve|vacuum|pneumatic|solenoid/.test(blob) && hazard.id === 'fluid.pneumatic_pressure'
    ) || (
      /guard|door|interlock|estop|e-stop/.test(blob) && !staticPart && hazard.id === 'ctrl.bypass'
    ) || (
      /heater|glue|hot/.test(blob) && hazard.id === 'therm.hot_surface'
    );
  });
}

function renderHazard(hazard, subsystemName) {
  const discharge = '5';
  const avoidance = (hazard.avoidance || []).map((step) => step.replace('{discharge_time_min}', discharge));
  let hazardText = hazard.hazard;
  if (subsystemName && !hazardText.toLowerCase().includes(subsystemName.toLowerCase())) {
    hazardText = `${hazardText.replace(/\.$/, '')} on the ${subsystemName}.`;
  }
  return { ...hazard, hazard: hazardText, avoidance };
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
