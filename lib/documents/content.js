const { scrubField } = require('../text');
const { displayProductName, fallbackNarrative } = require('../presentation');
const { manualDate } = require('../manual/date');
const { matchedHazards } = require('../hazards');
const { buildSubsystems } = require('../subsystems');
const { inspectEquipment, controlPoints, named } = require('./equipment');
const { stampDocument } = require('./stamp');

const SIGN = '________';

function paragraph(text, inferred = false) {
  return { type: 'p', text, inferred };
}

function note(text) {
  return { type: 'note', label: 'Note', text };
}

function steps(items) {
  return { type: 'steps', items };
}

function table(headers, rows, extra = {}) {
  return { type: 'table', headers, rows, ...extra };
}

function task(text, interval, skill, time) {
  return { task: text, interval, skill, time, signoff: SIGN };
}

function taskTable(rows) {
  return table(
    ['Task', 'Interval', 'Skill level', 'Estimated time', 'Sign-off'],
    rows.map((row) => [row.task, row.interval, row.skill, row.time, row.signoff]),
    { className: 'signoff', rowInferred: rows.map(() => true), widths: ['36%', '18%', '16%', '14%', '16%'] },
  );
}

function chapter(number, title, sections) {
  return {
    id: `ch${number}`,
    number: String(number),
    title,
    sections: sections.map((section, index) => ({
      id: `s${number}-${index + 1}`,
      anchor: `s${number}-${index + 1}`,
      number: `${number}.${index + 1}`,
      title: section.title,
      inferred: Boolean(section.inferred),
      blocks: section.blocks,
    })),
  };
}

function cleanText(text, project) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const scrubbed = scrubField(value, project).text.replace(/\s+/g, ' ').trim();
  if (!scrubbed) return '';
  if (/[{}]|\b(XIC|XIO|OTE|OTL|JSR)\b|:=/.test(scrubbed)) return '';
  return scrubbed;
}

function joinNames(labels, fallback) {
  return named(labels, fallback);
}

function ensureContext(project) {
  if (!project.narrative) project.narrative = fallbackNarrative(project);
  if (!project.subsystems) {
    try {
      project.subsystems = buildSubsystems(project, matchedHazards(project));
    } catch {
      project.subsystems = [];
    }
  }
  return project;
}

function howItWorks(project) {
  const narrative = project.narrative || fallbackNarrative(project);
  const equipment = inspectEquipment(project);
  const blocks = [];
  let overview = cleanText(narrative.overview, project);
  let cycle = cleanText(narrative.cycle, project);
  const moves = equipment.classes.motor.present || equipment.classes.pneumatic.present || equipment.classes.hydraulic.present;
  if (moves && /does not move|no product path|calculat/i.test(`${overview} ${cycle}`)) {
    const drives = joinNames(equipment.classes.motor.labels, 'its drives');
    overview = `This equipment moves with ${drives}. People stay outside the guards while those drives are enabled.`;
    cycle = '';
  }
  if (overview) blocks.push(paragraph(overview, true));
  if (cycle && cycle !== overview) blocks.push(paragraph(cycle, true));
  const parts = (project.subsystems || []).filter((item) => item && item.name).slice(0, 8);
  if (parts.length) {
    blocks.push(table(
      ['Part of the equipment', 'What it does'],
      parts.map((item) => [
        cleanText(item.name, project) || item.name,
        cleanText(item.purpose, project) || 'This part was identified in the uploaded files.',
      ]),
    ));
  }
  if (!blocks.length) {
    blocks.push(paragraph('The uploaded files did not describe a full operating cycle. The steps in this document use only the devices that were identified.'));
  }
  return blocks;
}

function shell(project, { branding, fields, env, subtitle, docCode, warning }) {
  const title = displayProductName(project);
  const revision = (project.identity && project.identity.revision) || 'A';
  const baseNumber = project.identity && project.identity.docNumber;
  const docNumber = baseNumber ? `${baseNumber}-${docCode}` : docCode;
  const date = manualDate({
    clientDate: fields && fields.date,
    timeZone: env && env.MANUALOS_TZ,
  });
  const doc = {
    meta: {
      title,
      headerLeft: `${title} · ${subtitle}`,
      headerRight: [docNumber, `Rev. ${revision}`].filter(Boolean).join(' · '),
      footerLeft: (project.identity && project.identity.manufacturerName) || title,
    },
    cover: {
      manufacturer: (project.identity && project.identity.manufacturerName) || '—',
      title,
      subtitle,
      model: (project.identity && project.identity.model) || '—',
      docNumber,
      revision,
      date,
      language: (project.identity && project.identity.language) || 'English (original instructions)',
      serial: (project.identity && project.identity.serialPlaceholder) || '________________',
      warning,
      foot: 'Generated from the uploaded engineering files. Recommended intervals and steps must be confirmed before this document is issued. The manufacturer must review every inferred statement.',
    },
    chapters: [],
  };
  return stampDocument(doc, branding, subtitle);
}

function finish(doc, chapters) {
  doc.chapters = chapters.filter((item) => item.sections.length);
  return doc;
}

const DEFAULT_NOTE = 'Intervals in this schedule are recommended defaults for planning. Verify every interval, lubricant, and replacement limit against the component data sheet before the schedule is issued. This schedule does not state manufacturer service figures.';

function buildPmSchedule(project, options = {}) {
  ensureContext(project);
  const equipment = inspectEquipment(project);
  const motor = equipment.classes.motor;
  const air = equipment.classes.pneumatic;
  const oil = equipment.classes.hydraulic;
  const sensor = equipment.classes.sensor;
  const safety = equipment.classes.safety;
  const lube = equipment.classes.lubrication;
  const filter = equipment.classes.filter;
  const gravity = equipment.classes.gravity;
  const daily = [];
  const weekly = [];
  const monthly = [];
  const quarterly = [];
  const annual = [];
  const runHour = [];

  if (equipment.any) {
    daily.push(task('Walk the work area. Remove scrap, loose tools, and spills before production.', 'Daily', 'Operator', '10 min'));
  }
  if (safety.present) {
    const devices = joinNames(safety.labels, 'each emergency stop, guard, and interlock found on this equipment');
    daily.push(task(`Test ${devices}. Motion must stop and stay stopped until the equipment is reset. Releasing an emergency stop must not start motion.`, 'Daily', 'Operator', '10 min'));
    monthly.push(task(`Inspect ${devices} for damage, loose mounting, and any bypass. Remove a bypass before you return the equipment to production.`, 'Monthly', 'Maintenance technician', '15 min'));
    annual.push(task('Record a full test of each safety function found on this equipment. The person who signs must be qualified for that safety function.', 'Annual', 'Qualified person', '60 min'));
  }
  if (motor.present) {
    const motors = joinNames(motor.labels, 'each motor and drive found on this equipment');
    weekly.push(task(`Listen to ${motors} while they run. Investigate new noise, heat, or vibration before the next shift.`, 'Weekly', 'Operator', '10 min'));
    monthly.push(task(`Inspect ${motors}, including couplings, belts, and cables, with the equipment locked out.`, 'Monthly', 'Maintenance technician', '20 min'));
    quarterly.push(task(`With the equipment locked out, clean the drive cooling path for ${motors} and confirm the drive shows no fault after power is restored.`, 'Quarterly', 'Maintenance technician', '20 min'));
    annual.push(task(`Have a qualified electrician inspect the power connections for ${motors}. Use the torque from the component data sheet. This schedule does not give a torque value.`, 'Annual', 'Qualified electrician', '30 min'));
    runHour.push(task(`Inspect ${motors} and their couplings. Recommended default: every 500 operating hours, or at the monthly task, whichever comes first.`, '500 operating hours', 'Maintenance technician', '20 min'));
  }
  if (sensor.present) {
    const sensors = joinNames(sensor.labels, 'each sensor found on this equipment');
    weekly.push(task(`Clean ${sensors} and confirm each one changes state when the measured condition changes.`, 'Weekly', 'Maintenance technician', '15 min'));
    annual.push(task(`Confirm ${sensors} are aligned and still detect the condition they were installed for.`, 'Annual', 'Maintenance technician', '20 min'));
  }
  if (air.present) {
    const points = joinNames(air.labels, 'the pneumatic devices found on this equipment');
    daily.push(task(`Listen and look for air leaks at ${points}. Repair a leak only after the air supply is isolated and exhausted.`, 'Daily', 'Operator', '5 min'));
    weekly.push(task('Drain filter bowls that this equipment actually has, and confirm the supply gauge is inside the range marked on the machine. This schedule does not set a supply pressure.', 'Weekly', 'Maintenance technician', '10 min'));
    quarterly.push(task(`Inspect ${points} for scored rods, cracked tubing, and leaking fittings.`, 'Quarterly', 'Maintenance technician', '20 min'));
    runHour.push(task('Service the air-preparation filters found on this equipment. Recommended default: every 500 operating hours, or monthly, whichever comes first. Replace an element when the data sheet or the bowl indicator says to.', '500 operating hours', 'Maintenance technician', '15 min'));
  }
  if (oil.present) {
    const points = joinNames(oil.labels, 'the hydraulic devices found on this equipment');
    weekly.push(task(`Look for hydraulic leaks at ${points}. Confirm the gauge is inside the range marked on the machine. This schedule does not set a pressure.`, 'Weekly', 'Maintenance technician', '10 min'));
    monthly.push(task(`Inspect hoses and fittings for ${points}. Replace a damaged hose before it weeps.`, 'Monthly', 'Maintenance technician', '20 min'));
    annual.push(task('Inspect the hydraulic power unit that supplies this equipment: fluid condition, leaks, and the filter indicator. Follow the fluid specification on the data sheet.', 'Annual', 'Maintenance technician', '30 min'));
    runHour.push(task('Inspect hydraulic hoses. Recommended default: every 1,000 operating hours, or quarterly, whichever comes first.', '1000 operating hours', 'Maintenance technician', '20 min'));
  }
  if (lube.present) {
    const points = joinNames(lube.labels, 'each lubrication point found on this equipment');
    weekly.push(task(`Look at ${points} for a dry fitting or a fresh leak.`, 'Weekly', 'Operator', '10 min'));
    monthly.push(task(`Lubricate ${points}. Use the lubricant named on the component data sheet. This schedule does not name a grease or oil.`, 'Monthly', 'Maintenance technician', '20 min'));
    runHour.push(task(`Repeat lubrication of ${points}. Recommended default: every 500 operating hours, or monthly, whichever comes first.`, '500 operating hours', 'Maintenance technician', '20 min'));
  }
  if (filter.present && !air.present) {
    const points = joinNames(filter.labels, 'each filter found on this equipment');
    monthly.push(task(`Inspect ${points}. Clean or replace the element when it is loaded. This schedule does not set a pressure-drop limit.`, 'Monthly', 'Maintenance technician', '15 min'));
    runHour.push(task(`Inspect ${points}. Recommended default: every 500 operating hours, or monthly, whichever comes first.`, '500 operating hours', 'Maintenance technician', '15 min'));
  }
  if (gravity.present) {
    const points = joinNames(gravity.labels, 'each brake, lift, or vertical load found on this equipment');
    monthly.push(task(`Inspect ${points}. Confirm a raised load cannot drift when energy is isolated.`, 'Monthly', 'Maintenance technician', '20 min'));
    annual.push(task(`Test the holding device for ${points} during a controlled stop. Block the load before anyone works under it.`, 'Annual', 'Maintenance technician', '30 min'));
  }
  if (equipment.powered && !annual.some((item) => /electrician/i.test(item.skill))) {
    annual.push(task('Have a qualified electrician inspect cabinet connections and the main disconnect for heat discoloration or looseness. Use torque values from the device data sheet, not from this schedule.', 'Annual', 'Qualified electrician', '30 min'));
  }

  const groups = [
    ['Daily tasks', daily],
    ['Weekly tasks', weekly],
    ['Monthly tasks', monthly],
    ['Quarterly tasks', quarterly],
    ['Annual tasks', annual],
    ['Run-hour tasks', runHour],
  ].filter((item) => item[1].length);

  if (!groups.length) {
    groups.push(['Devices still to identify', [
      task('The upload did not identify maintainable devices. Walk the equipment and add each motor, drive, valve, sensor, safety device, filter, and lubrication point before this schedule is issued.', 'Before issue', 'Maintenance technician', '30 min'),
    ]]);
  }

  const found = equipment.present.length
    ? equipment.present.map((id) => equipment.classes[id].label).join(', ')
    : 'no specific device class';
  const doc = shell(project, {
    ...options,
    subtitle: 'Preventive Maintenance Schedule',
    docCode: 'PM',
    warning: 'Verify every interval against the component data sheet before this schedule is issued.',
  });
  const chapters = [
    chapter('1', 'About this schedule', [{
      title: 'How to use this schedule',
      inferred: true,
      blocks: [
        paragraph('This schedule lists preventive tasks for the equipment identified in the uploaded files. Each row has the task, the interval, who may do it, the estimated time, and a sign-off.'),
        note(DEFAULT_NOTE),
        paragraph(`Device classes found in this upload: ${found}. Tasks for other classes are omitted.`),
        ...howItWorks(project),
      ],
    }]),
  ];
  groups.forEach((group, index) => {
    chapters.push(chapter(String(index + 2), group[0], [{
      title: group[0],
      inferred: true,
      blocks: [taskTable(group[1])],
    }]));
  });
  return finish(doc, chapters);
}

function energyRows(equipment) {
  const rows = [[
    'Electrical',
    'Main disconnect for this equipment',
    'Wait until drives and power supplies have discharged, then test for absence of voltage.',
    'The start control does nothing, and a voltage test shows the circuit is de-energized.',
  ]];
  if (equipment.classes.pneumatic.present) {
    rows.push([
      'Pneumatic',
      'Lockable air shutoff and exhaust',
      'Exhaust residual air. Support a load that a cylinder is holding before you open a fitting.',
      'The supply gauge reads zero. A cylinder moves only when the procedure says it is safe to move it by hand.',
    ]);
  }
  if (equipment.classes.hydraulic.present) {
    rows.push([
      'Hydraulic',
      'Pump isolation and accumulator dump',
      'Stop the pump, isolate the supply, and dump stored pressure, including an accumulator.',
      'Gauges read zero and lines are not holding a load.',
    ]);
  }
  if (equipment.classes.gravity.present) {
    rows.push([
      'Gravity or stored mechanical energy',
      'Mechanical block, prop, or brake',
      'Lower the load or block it before you release a brake or open a coupling.',
      'The load cannot move while the block is in place.',
    ]);
  }
  return rows;
}

function plainFindings(project) {
  const lines = [];
  for (const routine of project.routines || []) {
    const analysis = routine.analysis || {};
    const purpose = cleanText(analysis.purpose, project);
    if (purpose && /stop|estop|e-stop|emergency|interlock|guard/i.test(purpose)) lines.push(purpose);
    for (const step of analysis.operatorSteps || []) {
      const action = cleanText(step.action, project);
      if (action && /stop|reset|start/i.test(action)) lines.push(action);
    }
    for (const group of analysis.groups || []) {
      const text = cleanText(group.text, project);
      if (text && /stop|emergency|interlock/i.test(text)) lines.push(text);
    }
  }
  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
    if (unique.length >= 3) break;
  }
  return unique;
}

function buildShutdown(project, options = {}) {
  ensureContext(project);
  const equipment = inspectEquipment(project);
  const points = controlPoints(project);
  const findings = plainFindings(project);
  const stopName = joinNames(points.stops, '');
  const estopName = joinNames(points.estops, '');
  const guardName = joinNames(points.guards, '');
  const safetyLogic = (project.safetyPrograms || []).length || (project.safetyTasks || []).length
    || (project.routines || []).some((routine) => routine.safety);
  const normal = [
    { action: 'Tell people at the equipment that it will stop.', expect: 'People are clear of moving parts and know not to restart it.' },
  ];
  if (stopName) {
    normal.push({ action: `Operate the normal stop: ${stopName}.`, expect: 'The run command drops and the cycle comes to the normal stopped state.' });
  } else {
    normal.push({ action: 'Release every start control and do not give a new start.', expect: 'The equipment is no longer being commanded to run. The upload did not name a separate stop control.' });
  }
  normal.push({ action: 'Wait until motion and flow have stopped.', expect: 'Motors, actuators, and moving material are still.' });
  if (guardName) {
    normal.push({ action: `Leave ${guardName} in the safe state. Do not open a guard until motion has stopped, unless the emergency-stop section says to.`, expect: 'Guards are closed or the area is clear, as this stop requires.' });
  }
  const emergency = [];
  if (estopName) {
    emergency.push({ action: `Press the nearest emergency stop: ${estopName}.`, expect: 'Hazardous motion and energy that the safety circuit removes are off.' });
  } else {
    emergency.push({ action: 'Press the nearest emergency-stop device fitted to the equipment.', expect: 'Hazardous motion stops. The upload did not name an emergency-stop device, so confirm the device on the machine before issue.' });
  }
  emergency.push(
    { action: 'Keep people out until motion has stopped and the cause is removed.', expect: 'The area is safe to approach.' },
    { action: 'Reset the emergency stop only after the cause is removed. Then use the normal start procedure if production is to resume.', expect: 'Resetting or releasing the emergency stop does not start the equipment.' },
  );
  const isolation = [
    { action: 'Tell affected people that the equipment will be locked out.', expect: 'Affected people know not to try to start it.' },
    { action: 'Stop the equipment with the normal stop procedure in this document.', expect: 'The cycle is stopped before isolation.' },
    { action: 'Switch off and lock each isolation point in the energy table. Put your own lock and tag on every point.', expect: 'Each energy source in the table has your lock and tag.' },
    { action: 'Release or block stored energy as the table describes.', expect: 'Gauges that apply read zero, and vertical or spring-held loads are blocked.' },
    { action: 'Verify zero energy. Try the start control, and measure voltage where the electrical row says to measure.', expect: 'The equipment does not respond, and the electrical test shows absence of voltage.' },
  ];
  const doc = shell(project, {
    ...options,
    subtitle: 'Shutdown Procedure',
    docCode: 'SD',
    warning: 'Follow the site energy-control procedure. This outline is derived from the uploaded program and is not a substitute for a reviewed lockout procedure.',
  });
  const about = [
    paragraph('This procedure shuts the equipment down in three ways: a normal stop, an emergency stop, and an energy-isolation outline. It was written from the stop, emergency-stop, and safety logic found in the upload.'),
    ...howItWorks(project),
  ];
  if (findings.length) {
    about.push(paragraph(`From the control logic: ${findings.join(' ')}`, true));
  }
  if (safetyLogic) {
    about.push(paragraph('The program includes safety logic. Treat a trip of that logic as a stop. Resetting the safety logic does not grant a start.'));
  }
  if (!points.stops.length && !points.estops.length) {
    about.push(note('The upload did not name a stop or emergency-stop device. The steps that say so are marked for confirmation against the machine.'));
  }
  return finish(doc, [
    chapter('1', 'Purpose', [{ title: 'What this procedure covers', blocks: about }]),
    chapter('2', 'Normal stop', [{ title: 'Stop at the end of the cycle', inferred: !points.stops.length, blocks: [steps(normal)] }]),
    chapter('3', 'Emergency stop', [{ title: 'Stop when someone is at risk', inferred: !points.estops.length, blocks: [steps(emergency)] }]),
    chapter('4', 'Energy isolation', [{
      title: 'Lockout and tagout outline',
      inferred: true,
      blocks: [
        paragraph('Lock out every energy source below before you enter a guarded space, clean inside the guards, or replace a part. Include only the sources this equipment has.'),
        table(['Energy', 'Isolation point', 'Release stored energy', 'Verify zero energy'], energyRows(equipment)),
        steps(isolation),
      ],
    }]),
  ]);
}

function buildStartup(project, options = {}) {
  ensureContext(project);
  const equipment = inspectEquipment(project);
  const points = controlPoints(project);
  const startName = joinNames(points.starts, '');
  const resetName = joinNames(points.resets, '');
  const homeName = joinNames(points.homes, '');
  const estopName = joinNames(points.estops, '');
  const guardName = joinNames(points.guards, '');
  const motorName = joinNames(equipment.classes.motor.labels, 'the drives');
  const prestart = [
    { action: 'Read the shutdown procedure and confirm the previous stop is complete.', expect: 'Nobody is still working on the equipment, and tools are out of the machine.' },
    { action: 'Confirm every lock and tag from energy isolation has been removed by the person who applied it.', expect: 'Isolation points are unlocked only after that person is finished.' },
    { action: 'Confirm people are outside the guarded space.', expect: 'The start area is clear.' },
  ];
  if (guardName) prestart.push({ action: `Close ${guardName}.`, expect: 'Each guard is closed and its interlock is satisfied.' });
  if (estopName) prestart.push({ action: `Confirm ${estopName} is released and has been reset if the circuit requires it.`, expect: 'The emergency-stop circuit is healthy, and the equipment has not started.' });
  else prestart.push({ action: 'Confirm every emergency-stop device is released.', expect: 'The emergency-stop circuit is healthy. The upload did not name the device.' });
  prestart.push({ action: 'Remove scrap and confirm lubrication and fluid levels only if that check is part of the issued schedule.', expect: 'The work area is ready for a start.' });

  const power = [
    { action: 'Close the main disconnect for this equipment.', expect: 'The controller receives power and reaches its ready state.' },
  ];
  if (equipment.classes.pneumatic.present) {
    power.push({ action: 'Restore compressed air only after people are clear. Confirm the gauge is inside the range marked on the machine.', expect: 'Air is present and there is no new leak. This procedure does not set a pressure.' });
  }
  if (equipment.classes.hydraulic.present) {
    power.push({ action: 'Enable the hydraulic supply only after people are clear and hoses are connected. Confirm the gauge is inside the range marked on the machine.', expect: 'The power unit is quiet and there is no new leak. This procedure does not set a pressure.' });
  }
  power.push({ action: `Confirm ${motorName} show no fault before you command motion.`, expect: 'Fault indicators are clear.' });

  const homing = [];
  if (homeName) {
    homing.push({ action: `Request homing with ${homeName}. Keep people clear while the axis moves to its reference.`, expect: 'The axis reaches the home position and the home complete indication is on.' });
  }
  if (resetName) {
    homing.push({ action: `Press ${resetName} after the cause of any fault is corrected.`, expect: 'Faults that were corrected are clear. Reset does not start the cycle.' });
  }
  if (!homeName && !resetName) {
    homing.push({ action: 'Put the equipment in its safe starting position.', expect: 'The upload did not identify a homing or reset command. Confirm the starting position on the machine before issue.' });
  }

  const first = [];
  if (startName) {
    first.push({ action: `Start the first cycle with ${startName}.`, expect: 'The equipment starts only after this start command. It does not start by itself when power or air returns.' });
  } else {
    first.push({ action: 'Give the normal start command for this equipment.', expect: 'The equipment starts only after that command. The upload did not name the start control.' });
  }
  first.push(
    { action: 'Watch the first cycle from outside the guards.', expect: `Motion matches the devices found in the upload${equipment.classes.motor.labels.length ? ` (${joinNames(equipment.classes.motor.labels, '')})` : ''}.` },
    { action: 'Stop with the normal stop, or with an emergency stop if someone is at risk, if the first cycle is wrong.', expect: 'The shutdown procedure brings the equipment to a stop.' },
  );
  const doc = shell(project, {
    ...options,
    subtitle: 'Startup Procedure',
    docCode: 'SU',
    warning: 'Do not start the equipment until people are clear and energy isolation from the shutdown procedure has been removed.',
  });
  return finish(doc, [
    chapter('1', 'Before you start', [{
      title: 'How this pairs with shutdown',
      blocks: [
        paragraph('Use this procedure to return the equipment to production after a shutdown. It reverses the shutdown procedure for the same equipment: checks, power, reset or homing, then one watched cycle.'),
        ...howItWorks(project),
      ],
    }]),
    chapter('2', 'Pre-start checks', [{ title: 'Checks before power or motion', inferred: !points.guards.length && !points.estops.length, blocks: [steps(prestart)] }]),
    chapter('3', 'Power-up', [{ title: 'Restore energy', inferred: true, blocks: [steps(power)] }]),
    chapter('4', 'Homing and reset', [{ title: 'Establish a safe starting state', inferred: !homeName && !resetName, blocks: [steps(homing)] }]),
    chapter('5', 'First cycle', [{ title: 'Verify the first cycle', blocks: [steps(first)] }]),
  ]);
}

function alarmRows(project) {
  const rows = [];
  const seen = new Set();
  const push = (message, cause, remedy) => {
    const text = cleanText(message, project);
    const why = cleanText(cause, project) || 'The condition that raised the alarm is still true.';
    const fix = cleanText(remedy, project) || 'Correct the condition, then press Reset. Reset does not start the equipment.';
    if (!text) return;
    const key = `${text}|${why}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push([text, why, fix]);
  };
  for (const alarm of project.alarms || []) push(alarm.text || alarm.message, alarm.cause, alarm.remedy);
  for (const routine of project.routines || []) {
    for (const alarm of (routine.analysis && routine.analysis.alarms) || []) {
      push(alarm.text || alarm.message, alarm.cause, alarm.remedy);
    }
  }
  const points = controlPoints(project);
  if (points.estops.length) {
    push('Emergency stop is active', 'An emergency-stop device is pressed or its circuit is open.', 'Remove the cause, release the emergency stop, press Reset, and start only with the normal start command.');
  }
  if (points.guards.length) {
    push('A guard or interlock is open', `${joinNames(points.guards, 'A guard')} is open or has not been proved.`, 'Close the guard, confirm the interlock, press Reset, then start.');
  }
  return rows.slice(0, 24);
}

function signalRows(project) {
  const rows = [];
  for (const tag of project.tags || []) {
    const description = cleanText(tag.description || '', project);
    if (!description) continue;
    const role = /start|stop|reset|home/i.test(description)
      ? 'Operator control'
      : (/sensor|switch|interlock|alarm|fault/i.test(description) ? 'Input' : 'Device');
    rows.push([description, role]);
    if (rows.length >= 30) break;
  }
  return rows;
}

function customBody(project, entry) {
  const equipment = inspectEquipment(project);
  const kind = entry.customKind || entry.kind;
  if (kind === 'troubleshooting') {
    const rows = alarmRows(project);
    const blocks = [paragraph('Correct the cause, then reset. Reset does not start the equipment. Use the shutdown procedure if you must enter a guarded space.')];
    if (rows.length) blocks.push(table(['What you see', 'Probable cause', 'What to do'], rows, { small: true }));
    else blocks.push(paragraph('The upload did not include alarm text. Confirm each fault message on the operator panel and add its cause and remedy before this guide is issued.'));
    return blocks;
  }
  if (kind === 'parts') {
    const rows = [];
    for (const part of (project.cad && project.cad.bom) || []) {
      const description = cleanText(part.description || '', project);
      if (!description) continue;
      rows.push([String(rows.length + 1), description, part.partNumber ? String(part.partNumber) : 'Read the nameplate', String(part.qty || '1')]);
      if (rows.length >= 40) break;
    }
    if (!rows.length) {
      for (const id of equipment.present) {
        const item = equipment.classes[id];
        for (const label of item.labels) rows.push([String(rows.length + 1), label, 'Read the nameplate', '—']);
      }
    }
    const blocks = [paragraph('Order a part only after you confirm the nameplate or the bill of materials. This list does not invent part numbers.')];
    if (rows.length) blocks.push(table(['Item', 'Description', 'Part', 'Qty'], rows, { small: true }));
    else blocks.push(paragraph('The upload did not include a bill of materials or a named device. Add the part identity from the nameplate before this list is issued.'));
    return blocks;
  }
  if (kind === 'training') {
    return [
      paragraph('A person is qualified for a task only after a competent person watches them do it on this equipment and signs the row.'),
      table(
        ['Skill', 'Demonstration', 'Sign-off'],
        [
          ['Pre-start checks', 'Complete the startup pre-start checks without prompting.', SIGN],
          ['Normal start and first cycle', 'Start one cycle and say what a normal result looks like.', SIGN],
          ['Normal stop', 'Stop the equipment with the normal stop and state the expected result.', SIGN],
          ['Emergency stop', 'Show which device to press and state that reset does not restart the equipment.', SIGN],
          ['Energy isolation', 'Point out each energy source on this equipment and the zero-energy check. Do not apply a lock until site training allows it.', SIGN],
          ['Alarm response', 'Given an alarm that this equipment can raise, state the cause and the remedy without starting the equipment.', SIGN],
        ],
        { rowInferred: [true, true, true, true, true, true] },
      ),
    ];
  }
  if (kind === 'lubrication') {
    const labels = equipment.classes.lubrication.labels;
    const rows = (labels.length ? labels : ['Lubrication point still to identify']).map((label) => [
      label,
      'Use the lubricant named on the component data sheet.',
      '500 operating hours or monthly, whichever comes first. Confirm on the data sheet.',
      SIGN,
    ]);
    return [
      note('This list does not name a grease, oil, or manufacturer interval.'),
      table(['Point', 'Lubricant', 'Recommended default interval', 'Sign-off'], rows, { rowInferred: rows.map(() => true) }),
    ];
  }
  if (kind === 'cleaning') {
    return [steps([
      { action: 'Stop the equipment with the shutdown procedure and lock out energy before you clean inside a guard.', expect: 'Motion has stopped and zero energy is verified.' },
      { action: 'Remove product and scrap from the surfaces that the upload shows are in the process.', expect: 'Those surfaces are clear, and waste is in the site container.' },
      { action: 'Clean sensor faces only with a method that will not scratch the lens.', expect: 'Each sensor still changes state.' },
      { action: 'Remove tools, close guards, remove locks, and follow the startup procedure.', expect: 'The equipment is ready for a first-cycle check.' },
    ])];
  }
  if (kind === 'calibration' || kind === 'commissioning' || kind === 'changeover' || kind === 'safety') {
    return [steps([
      { action: 'Identify the device on the equipment. Use the nameplate if the upload did not give a range or setpoint.', expect: 'The device matches this document, and no numeric limit was invented.' },
      { action: 'Do the work only after the shutdown and energy-isolation steps that the task requires.', expect: 'People are clear and stored energy is controlled.' },
      { action: 'Record the as-found and as-left result on the issued form.', expect: 'The result is signed. This generated document does not fill in a measurement.' },
      { action: 'Return the equipment to production with the startup procedure.', expect: 'The first cycle matches the expected result.' },
    ])];
  }
  if (kind === 'pneumatic' || kind === 'hydraulic') {
    const present = kind === 'pneumatic' ? equipment.classes.pneumatic.present : equipment.classes.hydraulic.present;
    const label = kind === 'pneumatic' ? 'pneumatic' : 'hydraulic';
    const blocks = [paragraph(present
      ? `These notes cover the ${label} devices found in the upload: ${joinNames(kind === 'pneumatic' ? equipment.classes.pneumatic.labels : equipment.classes.hydraulic.labels, `the ${label} devices`)}.`
      : `The upload did not identify ${label} devices. Confirm the fluid power on the machine before this note is issued.`)];
    blocks.push(steps([
      { action: `Isolate and exhaust the ${label} supply before you open a fitting or support a load.`, expect: 'The gauge reads zero and the load is blocked if it can fall.' },
      { action: 'Repair only the leak or damaged part you found. Do not change a pressure setting that is not on the issued data sheet.', expect: 'The device is tight, and no pressure value was taken from this note.' },
      { action: 'Restore the supply during startup and watch the first cycle.', expect: 'There is no new leak, and motion is correct.' },
    ]));
    return blocks;
  }
  if (kind === 'electrical') {
    const rows = signalRows(project);
    const blocks = [paragraph('Descriptions come from the uploaded project. Addresses and program names are omitted from this list.')];
    if (rows.length) blocks.push(table(['Description', 'Role'], rows, { small: true }));
    else blocks.push(paragraph('The upload did not include device descriptions. Add them from the electrical drawings before this list is issued.'));
    return blocks;
  }
  return [
    paragraph('This document answers the additional request using the equipment found in the upload. It describes how that equipment works. It does not copy the control program.'),
    ...howItWorks(project),
  ];
}

function buildCustomDocument(project, entry, options = {}) {
  ensureContext(project);
  const doc = shell(project, {
    ...options,
    subtitle: entry.title,
    docCode: `C${String(entry.id || '').replace(/\D/g, '') || '1'}`,
    warning: 'Review this document against the equipment before it is issued. Requests that are not about the equipment are not generated.',
  });
  return finish(doc, [
    chapter('1', 'About this document', [{
      title: 'Scope',
      blocks: [
        paragraph(`This ${entry.title.toLowerCase()} was requested with the engineering files for this equipment. It stands alone. Read it with the operating manual, the shutdown procedure, and the startup procedure.`),
        note('Statements inferred from the upload are marked. Confirm them before issue.'),
      ],
    }]),
    chapter('2', 'The equipment', [{ title: 'How this equipment works', inferred: true, blocks: howItWorks(project) }]),
    chapter('3', entry.title, [{ title: entry.title, inferred: true, blocks: customBody(project, entry) }]),
  ]);
}

function buildExtraDocument(project, entry, options = {}) {
  if (entry.kind === 'pm_schedule') return buildPmSchedule(project, options);
  if (entry.kind === 'shutdown') return buildShutdown(project, options);
  if (entry.kind === 'startup') return buildStartup(project, options);
  return buildCustomDocument(project, entry, options);
}

module.exports = {
  buildPmSchedule,
  buildShutdown,
  buildStartup,
  buildCustomDocument,
  buildExtraDocument,
  DEFAULT_NOTE,
};
