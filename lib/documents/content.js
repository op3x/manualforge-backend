const { scrubField } = require('../text');
const { displayProductName, fallbackNarrative } = require('../presentation');
const { manualDate } = require('../manual/date');
const { matchedHazards } = require('../hazards');
const { buildSubsystems } = require('../subsystems');
const { inspectEquipment, controlPoints, energyTable, homingReleasesBrake, programFacts } = require('./equipment');
const { stampDocument } = require('./stamp');

const SIGN = '________';
const TROUBLE_SKIP = 'This troubleshooting guide was not generated. The upload has no alarm text and no fault or interlock logic that describes a failure, so a guide would only repeat generic advice.';
const PARTS_SKIP = 'This spare parts list was not generated. The upload did not name a maintainable part, so a list would only repeat steps, function names, and utilities.';

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
    ['Interval', 'Task', 'Skill level', 'Estimated time', 'Sign-off'],
    rows.map((row) => [row.interval, row.task, row.skill, row.time, row.signoff]),
    { className: 'signoff', rowInferred: rows.map(() => true), widths: ['16%', '40%', '16%', '12%', '16%'] },
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
  const value = String(text || '').replace(/\s*\(\s*value\s+\d+\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const scrubbed = scrubField(value, project).text.replace(/\s+/g, ' ').trim();
  if (!scrubbed) return '';
  if (/[{}]|\b(XIC|XIO|OTE|OTL|JSR)\b|:=/.test(scrubbed)) return '';
  return scrubbed;
}

function knownIdentity(value) {
  const text = String(value || '').trim();
  if (!text || text === '—' || text === '-' || text === '–') return '';
  return text;
}

function theDevice(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return '';
  if (/^(the|a|an)\b/.test(text)) return text;
  return `the ${text}`;
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
  const title = displayProductName(project);
  return [paragraph(`The operating manual describes how ${title} works. This document does not repeat that description.`)];
}

function shell(project, { branding, fields, env, subtitle, docCode, warning }) {
  const title = displayProductName(project);
  const revision = (project.identity && project.identity.revision) || 'A';
  const baseNumber = knownIdentity(project.identity && project.identity.docNumber);
  const docNumber = baseNumber ? `${baseNumber}-${docCode}` : '';
  const date = manualDate({
    clientDate: fields && fields.date,
    timeZone: env && env.MANUALOS_TZ,
  });
  const manufacturer = knownIdentity(project.identity && project.identity.manufacturerName);
  const model = knownIdentity(project.identity && project.identity.model);
  const doc = {
    meta: {
      title,
      headerLeft: `${title} · ${subtitle}`,
      headerRight: [docNumber, `Rev. ${revision}`].filter(Boolean).join(' · '),
      footerLeft: manufacturer || title,
    },
    cover: {
      manufacturer,
      title,
      subtitle,
      model,
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

const INTERVAL_ORDER = ['Daily', 'Weekly', 'Monthly', 'Quarterly', '500 operating hours', '1000 operating hours', 'Annual', 'Before issue'];

function addTask(rows, text, interval, skill, time) {
  const key = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!key || rows.some((item) => item.task.toLowerCase() === key)) return;
  const work = key.replace(/\b(daily|weekly|monthly|quarterly|annual|operating|hours|recommended|default|whichever|comes|first)\b/g, '').replace(/\s+/g, ' ').trim();
  if (rows.some((item) => {
    const other = item.task.toLowerCase().replace(/\b(daily|weekly|monthly|quarterly|annual|operating|hours|recommended|default|whichever|comes|first)\b/g, '').replace(/\s+/g, ' ').trim();
    return other === work;
  })) return;
  rows.push(task(text, interval, skill, time));
}

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
  const thermal = equipment.classes.thermal;
  const process = equipment.classes.process;
  const agitator = equipment.classes.agitator;
  const vacuum = equipment.classes.vacuum;
  const chemical = equipment.classes.chemical;
  const rows = [];
  const motors = motor.labels.filter((label) => !/agitat|pump/i.test(label));

  if (safety.present) {
    const device = safety.labels.length ? theDevice(safety.labels[0]) : 'each emergency stop and guard fitted to this equipment';
    addTask(rows, `Test ${device}. Motion must stop and stay stopped until the equipment is reset. Releasing an emergency stop must not start motion.`, 'Daily', 'Operator', '10 min');
    addTask(rows, `Inspect ${device} for damage, loose mounting, and any bypass. Remove a bypass before you return the equipment to production.`, 'Monthly', 'Maintenance technician', '15 min');
    addTask(rows, 'Record a full test of each safety function found on this equipment. The person who signs must be qualified for that safety function.', 'Annual', 'Qualified person', '60 min');
  }
  if (thermal.present) {
    addTask(rows, 'Inspect the steam traps while the steam supply can be open. A trap that stays cold, or that blows straight through, needs service. This schedule does not name a trap or a pressure.', 'Weekly', 'Maintenance technician', '15 min');
    addTask(rows, 'Inspect the steam supply valve with the equipment stopped. Confirm it opens when heating is commanded and that it closes at the end of the steam step.', 'Monthly', 'Maintenance technician', '20 min');
    const probe = thermal.labels.find((label) => /probe|temperature/i.test(label)) || 'the temperature probe';
    addTask(rows, `Calibrate ${theDevice(probe)}. Record the as-found and as-left result. This schedule does not state a tolerance or a setpoint.`, 'Annual', 'Maintenance technician', '30 min');
  }
  if (agitator.present) {
    const name = theDevice(agitator.labels[0] || 'agitator');
    addTask(rows, `With ${name} stopped and energy isolated, inspect the shaft seal and the drive coupling. Confirm the agitator is still before you open the vessel.`, 'Monthly', 'Maintenance technician', '20 min');
  }
  if (process.present) {
    if (process.labels.some((label) => /pump/i.test(label)) || /\bpump/i.test(process.labels.join(' '))) {
      addTask(rows, 'With the pumps stopped and locked out, inspect each pump seal and coupling for leaks or damage.', 'Monthly', 'Maintenance technician', '20 min');
    }
    if (process.labels.some((label) => /water/i.test(label))) {
      addTask(rows, 'Inspect the water valves for leaks and confirm each valve opens and closes.', 'Monthly', 'Maintenance technician', '20 min');
    }
    if (!process.labels.some((label) => /pump|water/i.test(label))) {
      addTask(rows, 'Inspect the process-fluid valves and pumps for leaks with the equipment stopped and locked out.', 'Monthly', 'Maintenance technician', '20 min');
    }
  }
  if (motors.length) {
    const device = theDevice(motors[0]);
    addTask(rows, `Inspect ${device} while it runs. Investigate new noise, heat, or vibration before the next shift.`, 'Weekly', 'Operator', '10 min');
    addTask(rows, `With the equipment locked out, inspect ${device}, including the coupling, belts, and cables.`, 'Monthly', 'Maintenance technician', '20 min');
    addTask(rows, `Have a qualified electrician inspect the power connections for ${device}. Use the torque from the component data sheet. This schedule does not give a torque value.`, 'Annual', 'Qualified electrician', '30 min');
  } else if (motor.present && !agitator.present && !process.present) {
    addTask(rows, 'With the equipment locked out, inspect each drive, coupling, and cable found on this equipment.', 'Monthly', 'Maintenance technician', '20 min');
  }
  if (sensor.labels.length) {
    const device = theDevice(sensor.labels[0]);
    const many = sensor.labels.length > 1;
    addTask(rows, `Clean ${device} and confirm ${many ? 'each one changes' : 'it changes'} state when the measured condition changes.`, 'Weekly', 'Maintenance technician', '15 min');
    addTask(rows, `Confirm ${device} ${many ? 'are' : 'is'} aligned and still ${many ? 'detect' : 'detects'} the condition ${many ? 'they were' : 'it was'} installed for.`, 'Annual', 'Maintenance technician', '20 min');
  }
  if (air.present) {
    const actuator = air.labels.find((label) => /cylinder|valve|actuator/i.test(label));
    const supply = air.labels.find((label) => /supply/i.test(label)) || air.labels[0];
    const leakPoint = theDevice(supply || actuator || 'pneumatic devices found on this equipment');
    const inspectPoint = theDevice(actuator || supply || 'pneumatic devices found on this equipment');
    addTask(rows, `Look for air leaks at ${leakPoint}. Repair a leak only after the air supply is isolated and exhausted.`, 'Daily', 'Operator', '5 min');
    addTask(rows, 'Drain the air-supply filter bowl and confirm the supply gauge is inside the range marked on the machine. This schedule does not set a supply pressure.', 'Weekly', 'Maintenance technician', '10 min');
    addTask(rows, `Inspect ${inspectPoint} for scored rods, cracked tubing, and leaking fittings.`, 'Quarterly', 'Maintenance technician', '20 min');
    addTask(rows, 'Service the air-preparation filter element found on this equipment. Replace an element when the bowl indicator or the component data sheet says to. This schedule does not set a pressure-drop limit.', '500 operating hours', 'Maintenance technician', '15 min');
  }
  if (oil.present) {
    const points = oil.labels.length ? theDevice(oil.labels[0]) : 'the hydraulic devices found on this equipment';
    addTask(rows, `Look for hydraulic leaks at ${points}. Confirm the gauge is inside the range marked on the machine. This schedule does not set a pressure.`, 'Weekly', 'Maintenance technician', '10 min');
    addTask(rows, `Inspect hoses and fittings for ${points}. Replace a damaged hose before it weeps.`, 'Monthly', 'Maintenance technician', '20 min');
    addTask(rows, 'Inspect the hydraulic power unit that supplies this equipment: fluid condition, leaks, and the filter indicator. Follow the fluid specification on the data sheet.', 'Annual', 'Maintenance technician', '30 min');
    addTask(rows, 'Inspect hydraulic hoses for cracking, rubbing, and wet fittings.', '1000 operating hours', 'Maintenance technician', '20 min');
  }
  if (lube.present) {
    const points = lube.labels.length ? theDevice(lube.labels[0]) : 'each lubrication point found on this equipment';
    addTask(rows, `Look at ${points} for a dry fitting or a fresh leak.`, 'Weekly', 'Operator', '10 min');
    addTask(rows, `Lubricate ${points}. Use the lubricant named on the component data sheet. This schedule does not name a grease or oil.`, '500 operating hours', 'Maintenance technician', '20 min');
  }
  if (filter.present && !air.present) {
    const points = filter.labels.length ? theDevice(filter.labels[0]) : 'each filter found on this equipment';
    addTask(rows, `Inspect ${points}. Clean or replace the element when it is loaded. This schedule does not set a pressure-drop limit.`, 'Monthly', 'Maintenance technician', '15 min');
  }
  if (gravity.present) {
    const points = gravity.labels.length ? theDevice(gravity.labels[0]) : 'each brake, lift, or vertical load found on this equipment';
    addTask(rows, `Inspect ${points}. Confirm a raised load cannot drift when energy is isolated.`, 'Monthly', 'Maintenance technician', '20 min');
    addTask(rows, `Test the holding device for ${points} during a controlled stop. Block the load before anyone works under it.`, 'Annual', 'Maintenance technician', '30 min');
  }
  if (vacuum.present) {
    addTask(rows, 'Inspect vacuum cups, filters, and the vent. A cup that does not release has not been vented.', 'Monthly', 'Maintenance technician', '15 min');
  }
  if (chemical.present) {
    addTask(rows, 'Inspect chemical supply valves and hoses for leaks. Flush only into the site collection point.', 'Monthly', 'Maintenance technician', '20 min');
  }
  if (equipment.powered && !rows.some((item) => /electrician/i.test(item.skill))) {
    const where = agitator.present || process.present ? 'the agitator drive and the pump drives' : 'the cabinet connections and the main disconnect';
    addTask(rows, `Have a qualified electrician inspect ${where} for heat discoloration or looseness. Use torque values from the device data sheet, not from this schedule.`, 'Annual', 'Qualified electrician', '30 min');
  }
  if (!rows.length) {
    addTask(rows, 'The upload did not identify maintainable devices. Add each motor, valve, sensor, safety device, filter, and lubrication point before this schedule is issued.', 'Before issue', 'Maintenance technician', '30 min');
  }
  rows.sort((left, right) => INTERVAL_ORDER.indexOf(left.interval) - INTERVAL_ORDER.indexOf(right.interval));

  const found = equipment.present.length
    ? `Device classes found in this upload: ${equipment.present.map((id) => equipment.classes[id].label).join(', ')}.`
    : 'This upload did not identify a motor, valve, sensor, or other maintainable device.';
  const doc = shell(project, {
    ...options,
    subtitle: 'Preventive Maintenance Schedule',
    docCode: 'PM',
    warning: 'Verify every interval against the component data sheet before this schedule is issued.',
  });
  return finish(doc, [
    chapter('1', 'Preventive maintenance tasks', [{
      title: 'Tasks by interval',
      inferred: true,
      blocks: [
        paragraph('This schedule lists one task table. Rows are grouped by interval. A task that is already listed for a shorter interval is not repeated at 500 operating hours.'),
        note(DEFAULT_NOTE),
        paragraph(found),
        ...howItWorks(project),
        taskTable(rows),
      ],
    }]),
  ]);
}

function shutdownFinding(text) {
  const line = String(text || '');
  if (!/\b(stop|e-?stop|emergency|interlock|guard)\b/i.test(line)) return false;
  if (/\b(permissive|startup|to start|before you start|start command)\b/i.test(line)) return false;
  if (/\bstart\b/i.test(line) && !/\b(does not start|do not start|must not start|not start)\b/i.test(line)) return false;
  return true;
}

function plainFindings(project) {
  const lines = [];
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    const analysis = routine.analysis || {};
    const purpose = cleanText(analysis.purpose, project);
    if (purpose && shutdownFinding(purpose)) lines.push(purpose);
    for (const step of analysis.operatorSteps || []) {
      const action = cleanText(step.action, project);
      if (action && shutdownFinding(action)) lines.push(action);
    }
  }
  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
    if (unique.length >= 2) break;
  }
  return unique;
}

function buildShutdown(project, options = {}) {
  ensureContext(project);
  const equipment = inspectEquipment(project);
  const points = controlPoints(project);
  const findings = plainFindings(project);
  const facts = programFacts(project);
  const stopName = points.stops[0] || '';
  const guardName = points.guards[0] || '';
  const safetyLogic = (project.safetyPrograms || []).length || (project.safetyTasks || []).length
    || (project.routines || []).some((routine) => routine.safety);
  const normal = [
    { action: 'Tell people at the equipment that it will stop.', expect: 'People are clear of moving parts and know not to restart it.' },
  ];
  if (stopName) {
    normal.push({ action: `Operate ${theDevice(stopName)}.`, expect: 'The run command drops and the cycle comes to the normal stopped state.' });
  } else {
    normal.push({ action: 'Release every start control and do not give a new start.', expect: 'The equipment is no longer being commanded to run. The upload did not name a separate stop control.' });
  }
  if (equipment.classes.agitator.present) {
    normal.push({
      action: 'Stop the agitator and wait until it is no longer turning.',
      expect: 'The agitator is still before anyone approaches the vessel.',
    });
  }
  normal.push({ action: 'Wait until motion and flow have stopped.', expect: 'Drives, actuators, and moving material are still.' });
  if (guardName) {
    const door = /door/i.test(guardName);
    normal.push({
      action: door ? 'Leave the guard door closed until motion has stopped.' : 'Leave the guard closed until motion has stopped.',
      expect: 'The guard stays closed until motion has stopped.',
    });
  }
  const emergency = [
    { action: 'Press the nearest emergency stop.', expect: 'Hazardous motion stops. Resetting or releasing the emergency stop does not start the equipment.' },
    { action: 'Keep people out until motion has stopped and the cause is removed.', expect: 'The area is safe to approach.' },
    { action: 'Reset the emergency stop only after the cause is removed. Then use the normal start procedure if production is to resume.', expect: 'Resetting or releasing the emergency stop does not start the equipment.' },
  ];
  const isolation = [
    { action: 'Tell affected people that the equipment will be locked out.', expect: 'Affected people know not to try to start it.' },
    { action: 'Stop the equipment with the normal stop procedure in this document.', expect: 'The cycle is stopped before isolation.' },
  ];
  if (equipment.classes.agitator.present) {
    isolation.push({
      action: facts.agitatorRunning
        ? 'Stop the agitator and confirm it is no longer turning before you isolate energy. The cook sequence advances transfer steps only while the agitator is running, so that motion has to stop first.'
        : 'Stop the agitator and confirm it is no longer turning before you isolate energy or open the vessel.',
      expect: 'The agitator is still.',
    });
  }
  if (equipment.classes.thermal.present) {
    isolation.push(
      { action: 'Close the steam supply valve.', expect: 'The steam supply is commanded closed.' },
      {
        action: 'Confirm the steam supply valve is closed.',
        expect: facts.steamClose
          ? 'The steam supply valve shows closed. Do not isolate energy while that valve is open.'
          : 'The valve is closed before you isolate energy.',
      },
      { action: 'Wait until the vessel, jackets, and piping have cooled. Treat valves and product lines as hot surfaces until they have cooled.', expect: 'Surfaces have cooled. This procedure does not state a cool-down time or a temperature.' },
      { action: 'Vent residual steam pressure.', expect: facts.steamVent ? 'The vent path used by the heat and cool steps is open and the steam line is not holding pressure.' : 'The steam line is vented and is not holding pressure.' },
    );
  }
  if (equipment.classes.process.present) {
    const hot = equipment.classes.thermal.present || equipment.classes.process.labels.some((label) => /\b(water|steam|hot)\b/i.test(label));
    isolation.push({
      action: hot
        ? 'Stop the pumps and close the supply valves. Drain hot fluid before you open a line.'
        : 'Stop the pumps and close the supply valves before you open a line.',
      expect: 'The pumps are stopped and the lines are not under pressure.',
    });
  }
  if (equipment.classes.vacuum.present) {
    isolation.push({ action: 'Close the vacuum supply and vent it to atmosphere before you open a cup or a fitting.', expect: 'The vacuum gauge reads the same as the room.' });
  }
  if (equipment.classes.chemical.present) {
    isolation.push({ action: 'Close and lock the chemical supply. Drain and flush the line into the site collection point before you open a fitting.', expect: 'The chemical supply is isolated and the line is drained.' });
  }
  isolation.push(
    { action: 'Switch off and lock each isolation point in the energy table. Put your own lock and tag on every point.', expect: 'Each energy source in the table has your lock and tag.' },
    { action: 'Release or block stored energy as the table describes.', expect: 'Gauges that apply read zero, hot surfaces have cooled, and vertical or spring-held loads are blocked.' },
    { action: 'Verify zero energy. Try the start control, and measure voltage where the electrical row says to measure.', expect: 'The equipment does not respond, and the electrical test shows absence of voltage.' },
  );
  const doc = shell(project, {
    ...options,
    subtitle: 'Shutdown Procedure',
    docCode: 'SD',
    warning: 'Follow the site energy-control procedure. This outline is derived from the uploaded program and is not a substitute for a reviewed lockout procedure.',
  });
  const about = [
    paragraph('This procedure shuts the equipment down in three ways: a normal stop, an emergency stop, and an energy-isolation outline. The energy table is the same list used in the operating manual.'),
    ...howItWorks(project),
  ];
  if (findings.length) about.push(paragraph(`From the control logic: ${findings.join(' ')}`, true));
  if (safetyLogic) about.push(paragraph('The program includes safety logic. Treat a trip of that logic as a stop. Resetting the safety logic does not grant a start.'));
  if (!points.stops.length && !points.estops.length) {
    about.push(note('The upload did not name a stop or emergency-stop device. Confirm both on the machine before this procedure is issued.'));
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
        table(['Energy', 'Isolation point', 'Release stored energy', 'Verify zero energy'], energyTable(project)),
        steps(isolation),
      ],
    }]),
  ]);
}

function buildStartup(project, options = {}) {
  ensureContext(project);
  const equipment = inspectEquipment(project);
  const points = controlPoints(project);
  const startName = points.starts[0] || '';
  const resetName = points.resets[0] || '';
  const homeName = points.homes[0] || '';
  const guardName = points.guards[0] || '';
  const motors = equipment.classes.motor.labels.filter((label) => !/agitat|pump/i.test(label));
  const releasesBrake = homingReleasesBrake(project);
  const prestart = [
    { action: 'Read the shutdown procedure and confirm the previous stop is complete.', expect: 'Nobody is still working on the equipment, and tools are out of the machine.' },
    { action: 'Confirm every lock and tag from energy isolation has been removed by the person who applied it.', expect: 'Isolation points are unlocked only after that person is finished.' },
    { action: 'Confirm people are outside the guarded space.', expect: 'The start area is clear.' },
  ];
  if (guardName) {
    prestart.push({
      action: /door/i.test(guardName)
        ? 'Close the guard door and confirm its interlock is satisfied.'
        : 'Close the guard and confirm the interlock is satisfied.',
      expect: 'Each guard is closed and its interlock is satisfied.',
    });
  }
  prestart.push({ action: 'Confirm every emergency stop is released, and reset the circuit if it requires a reset.', expect: 'The emergency-stop circuit is healthy, and the equipment has not started.' });
  prestart.push({ action: 'Remove scrap and confirm lubrication and fluid levels only where the issued schedule calls for that check.', expect: 'The work area is ready for a start.' });

  const power = [
    { action: 'Close the main disconnect for this equipment.', expect: 'The controller receives power and reaches its ready state.' },
  ];
  if (equipment.classes.pneumatic.present) {
    power.push({ action: 'Restore compressed air only after people are clear. Confirm the gauge is inside the range marked on the machine.', expect: 'Air is present and there is no new leak. This procedure does not set a pressure.' });
  }
  if (equipment.classes.hydraulic.present) {
    power.push({ action: 'Enable the hydraulic supply only after people are clear and hoses are connected. Confirm the gauge is inside the range marked on the machine.', expect: 'The power unit is quiet and there is no new leak. This procedure does not set a pressure.' });
  }
  if (equipment.classes.thermal.present) {
    power.push({ action: 'Open the steam supply only after people are clear and the startup checks are complete. Confirm the supply valve moves when heating is commanded.', expect: 'Steam is available for the heat step. This procedure does not state a pressure or a temperature.' });
  }
  if (equipment.classes.process.present) {
    const water = equipment.classes.process.labels.some((label) => /\bwater\b/i.test(label));
    power.push(water
      ? { action: 'Open the water valves and start a pump only after people are clear and the lines are connected.', expect: 'There is no new leak. This procedure does not state a flow or a pressure.' }
      : { action: 'Start a pump only after people are clear and the lines are connected.', expect: 'There is no new leak. This procedure does not state a flow or a pressure.' });
  }
  if (motors.length === 1) {
    power.push({ action: `Confirm ${theDevice(motors[0])} shows no fault before you command motion.`, expect: 'The fault indicator is clear.' });
  } else if (motors.length > 1) {
    power.push({ action: `Confirm ${theDevice(motors[0])} and the other drives show no fault before you command motion.`, expect: 'Fault indicators are clear.' });
  } else if (equipment.classes.motor.present || equipment.classes.agitator.present) {
    power.push({ action: 'Confirm the drives show no fault before you command motion.', expect: 'Fault indicators are clear.' });
  }

  const homing = [];
  if (releasesBrake) {
    homing.push({
      action: 'Block the load before you request homing. Homing releases the lift brake, and the load can move when the brake releases.',
      expect: 'The load is blocked or supported, and people are clear of the travel path.',
    });
  }
  if (homeName) {
    homing.push({ action: 'Request homing. Keep people clear while the axis moves to its reference.', expect: 'The axis reaches the home position and the home complete indication is on.' });
  }
  if (resetName) {
    homing.push({ action: `Press ${theDevice(resetName)} after the cause of any fault is corrected.`, expect: 'Faults that were corrected are clear. Reset does not start the cycle.' });
  }
  if (!homeName && !resetName && !releasesBrake) {
    homing.push({ action: 'Put the equipment in its safe starting position.', expect: 'The upload did not identify a homing or reset command. Confirm the starting position on the machine before issue.' });
  }

  const first = [];
  if (startName) {
    const restores = equipment.classes.pneumatic.present ? 'power or air returns' : 'power returns';
    first.push({ action: `Start the first cycle with ${theDevice(startName)}.`, expect: `The equipment starts only after this start command. It does not start by itself when ${restores}.` });
  } else {
    first.push({ action: 'Give the normal start command for this equipment.', expect: 'The equipment starts only after that command. The upload did not name the start control.' });
  }
  const watched = motors.length ? ` Motion includes ${theDevice(motors[0])}.` : '';
  first.push(
    { action: 'Watch the first cycle from outside the guards.', expect: `Motion matches the devices found in the upload.${watched}` },
    { action: 'Stop with the normal stop, or press the nearest emergency stop if someone is at risk, if the first cycle is wrong.', expect: 'The shutdown procedure brings the equipment to a stop.' },
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

function alarmMeaning(text) {
  return String(text || '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bhigh[\s-]*high\b|\bhi[\s-]*hi\b|\bhh\b/g, 'high-high')
    .replace(/\blow[\s-]*low\b|\bll\b/g, 'low-low')
    .replace(/\bprocess\s+(value|variable|reading)\b/g, ' ')
    .replace(/\b(value|variable|reading)\b/g, ' ')
    .replace(/\bhas\s+exceeded\b/g, ' ')
    .replace(/\b(the|a|an|limit|limits|alarm|alarms)\b/g, ' ')
    .replace(/[^a-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function genericAlarm(text) {
  const key = alarmMeaning(text);
  return !key || /^(high-high|high|low-low|low|fault)$/.test(key);
}

function instrumentSource(tag) {
  const candidates = [tag.description, ...(tag.notes || [])]
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter((item) => item && item.length <= 80 && item.split(' ').length <= 12);
  return candidates[0] || '';
}

function plainInstrument(description, kind) {
  let text = String(description || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^(?:[A-Za-z]{2,6}-\d+\s*-\s*)+/i, '');
  text = text.replace(/\d+\s*°[^ ]*/g, '');
  text = text.replace(/#\s*\d+/g, '');
  text = text.replace(/\b\d+\s*-\s*\d+\b/g, '');
  text = text.replace(/\b(temperature|level|pressure|flow)\b[\s\S]*$/i, '').trim();
  if (text === text.toUpperCase()) text = text.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || /^(the|a)$/i.test(text)) return kind;
  if (new RegExp(`\\b${kind}\\b`, 'i').test(text)) return text;
  return `${text} ${kind}`;
}

function addFinding(rows, symptom, cause, remedy) {
  const text = String(symptom || '').replace(/\s*\(\s*value\s+\d+\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 140 || text.split(' ').length > 22) return;
  const key = alarmMeaning(text);
  if (!key || rows.some((row) => alarmMeaning(row[0]) === key)) return;
  rows.push([text, cause, remedy]);
}

function alarmRows(project) {
  const equipment = inspectEquipment(project);
  const logic = [];
  const blocks = [];
  const steam = equipment.classes.thermal.present;
  const skip = new Set((project.aois || []).map((item) => String(item.name || '').toLowerCase()));
  const blockRemedy = 'Correct the condition, then press reset. Reset does not start the equipment.';
  const pushBlock = (alarm) => {
    addFinding(
      blocks,
      cleanText(alarm.text || alarm.message, project),
      cleanText(alarm.cause, project) || 'The condition that raised the alarm is still true.',
      cleanText(alarm.remedy, project) || blockRemedy,
    );
  };
  for (const alarm of project.alarms || []) pushBlock(alarm);
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    for (const alarm of (routine.analysis && routine.analysis.alarms) || []) pushBlock(alarm);
    for (const unit of routine.units || []) {
      if (!unit || unit.unread) continue;
      const blob = `${unit.comment || ''}\n${unit.text || ''}`;
      if (/guard/i.test(blob) && /\b(not|xio)\b/i.test(blob) && /\b(false|ote)\b|:=\s*false|:=\s*0\b/i.test(blob)) {
        addFinding(logic, 'Motion stops or will not start', 'A guard is open or its interlock is not proved.', 'Close the guard, confirm the interlock, press reset, then start. Reset does not start the equipment.');
      }
      if (/(emergency\s*stop|e-?stop)/i.test(blob) && /\b(not|xio|false)\b/i.test(blob)) {
        addFinding(logic, 'Motion stops while the emergency stop is active', 'An emergency-stop device is pressed or its circuit is open.', 'Remove the cause, release the emergency stop, press reset, and start only with the normal start command.');
      }
      if (/steam/i.test(unit.comment || '') && /fault/i.test(unit.comment || '')) {
        addFinding(logic, 'The steam step does not advance', 'A fault is still active, so the steam step stays held.', 'Clear the fault and confirm the steam supply valve is in the state the step expects. Reset does not open the steam valve by itself.');
      }
      if (/did not (open|close|leave|reach)/i.test(unit.comment || '')) {
        const comment = cleanText(unit.comment, project);
        if (comment) addFinding(logic, comment, 'The feedback did not follow the command.', 'Stop the motion, confirm the actuator and its feedback, then press reset. Reset does not start the equipment.');
      }
    }
  }
  let valves = 0;
  for (const tag of project.tags || []) {
    if (skip.has(String(tag.scope || '').toLowerCase())) continue;
    const described = instrumentSource(tag);
    if (!described || /for example|placeholder|configure|udt for/i.test(described)) continue;
    if (/\bdrive temp/i.test(described)) continue;
    if (/\btemperature\b/i.test(described) && !/\blevel\b/i.test(described)) {
      const name = plainInstrument(described, 'temperature');
      addFinding(
        logic,
        `${name} is high`,
        steam
          ? 'Steam is still supplying heat, or the temperature is above the alarm point. This guide does not state that point.'
          : 'The measured temperature is above the alarm point. This guide does not state that point.',
        steam
          ? 'Close the steam supply if the shutdown procedure says to, wait until the temperature falls, then press reset. Reset does not start the equipment.'
          : 'Correct the condition, then press reset. Reset does not start the equipment.',
      );
    } else if (/\blevel\b/i.test(described)) {
      const name = plainInstrument(described, 'level');
      addFinding(logic, `${name} is high`, 'The level is above the alarm point. This guide does not state that point.', 'Stop the inflow, then press reset. Reset does not start the equipment.');
    } else if (valves < 4 && /valve/i.test(`${tag.dataType} ${described}`) && /\b(water|pump|discharge|drain)\b/i.test(described)) {
      valves += 1;
      const name = plainInstrument(described, 'valve');
      addFinding(logic, `${name} did not reach the commanded position`, 'The valve command and the open or closed feedback do not agree.', 'Stop the related flow, confirm the valve can move, then press reset. Reset does not start the equipment.');
    }
  }
  const specific = logic.some((row) => !genericAlarm(row[0]));
  const rows = logic.slice();
  for (const row of blocks) {
    if (specific && genericAlarm(row[0])) continue;
    addFinding(rows, row[0], row[1], row[2]);
  }
  const kept = rows.some((row) => !genericAlarm(row[0]))
    ? rows.filter((row) => !genericAlarm(row[0]))
    : rows;
  return kept.slice(0, 16);
}

function signalRows(project) {
  const rows = [];
  const seen = new Set();
  const skip = new Set((project.aois || []).map((item) => String(item.name || '').toLowerCase()));
  for (const tag of project.tags || []) {
    if (skip.has(String(tag.scope || '').toLowerCase())) continue;
    const description = cleanText(tag.description || '', project);
    if (!description || /\b(alarm|setpoint|permissive|debounce|bypass|has\s+reset|meters?)\b/i.test(description)) continue;
    if (/\bcontrol$/i.test(description)) continue;
    if (/\bcontrol\b/i.test(description) && /\b(conveyor|guard|interlock|clamp)/i.test(description)) continue;
    const key = description.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const role = /start|stop|reset|home/i.test(description)
      ? 'Operator control'
      : (/sensor|switch|interlock|temperature|level/i.test(description) ? 'Input' : 'Device');
    rows.push([description, role]);
    if (rows.length >= 24) break;
  }
  return rows;
}

function canonicalPart(description) {
  return String(description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:component|fastener),\s+solid body,\s+part\s+/i, '')
    .replace(/([A-Za-z])0*\d{3,4}$/, '$1')
    .replace(/[-_\s]+$/, '')
    .trim();
}

function publishedPartNumber(part, description) {
  const number = String(part.partNumber || '').trim();
  if (!number || /^#?\d+$/.test(number)) return 'Read the nameplate';
  const plain = canonicalPart(number.replace(/[_]+/g, ' '));
  if (plain.toLowerCase() === description.toLowerCase()) return 'Read the nameplate';
  if (/([A-Za-z])\d{3,4}$/.test(number) && !/\s/.test(number)) return 'Read the nameplate';
  return number;
}

function rejectedPart(description) {
  const text = String(description || '').trim();
  if (!text) return true;
  if (/\b(alarm|setpoint|permissive|fault bit|signal|command|request)\b/i.test(text)) return true;
  if (/^(close|open|start|stop|press|leave|step)\b/i.test(text)) return true;
  if (/\bcontrol$/i.test(text)) return true;
  if (/\bsupply$/i.test(text)) return true;
  if (/\blubrication point\b/i.test(text)) return true;
  if (/\bcontrol\b/i.test(text) && /\b(conveyor|guard|interlock|clamp)\b/i.test(text)) return true;
  return false;
}

function partKey(description) {
  return String(description || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(' ');
}

function rememberPart(merged, description, qty, partNumber) {
  if (rejectedPart(description)) return;
  const key = partKey(description);
  if (!key) return;
  const existing = merged.get(key);
  if (existing) {
    existing.qty += qty;
    const shouted = existing.description === existing.description.toUpperCase();
    const nextShouted = description === description.toUpperCase();
    if (shouted && !nextShouted) existing.description = description;
  } else {
    merged.set(key, { description, qty, partNumber });
  }
}

function partRows(project) {
  const merged = new Map();
  for (const part of (project.cad && project.cad.bom) || []) {
    const raw = cleanText(part.description || part.partNumber || '', project);
    const description = canonicalPart(raw);
    if (!description) continue;
    const qty = Number(part.qty);
    const count = Number.isFinite(qty) && qty > 0 ? qty : 1;
    rememberPart(merged, description, count, publishedPartNumber(part, description));
  }
  if (!merged.size) {
    const equipment = inspectEquipment(project);
    for (const id of ['thermal', 'agitator', 'process', 'motor', 'pneumatic', 'hydraulic', 'vacuum', 'chemical', 'sensor', 'safety', 'gravity', 'filter', 'lubrication']) {
      const spec = equipment.classes[id];
      if (!spec || !spec.present) continue;
      for (const label of spec.labels) rememberPart(merged, label, 1, 'Read the nameplate');
    }
  }
  const rows = [];
  for (const item of merged.values()) {
    rows.push([String(rows.length + 1), item.description, item.partNumber, String(item.qty)]);
    if (rows.length >= 40) break;
  }
  return rows;
}

function customBody(project, entry) {
  const equipment = inspectEquipment(project);
  const kind = entry.customKind || entry.kind;
  if (kind === 'troubleshooting') {
    const found = alarmRows(project);
    if (!found.length) return null;
    return [
      paragraph('Correct the cause, then reset. Reset does not start the equipment. Use the shutdown procedure if you must enter a guarded space or open a line that can hold steam, hot fluid, or pressure.'),
      table(['What you see', 'Probable cause', 'What to do'], found, { small: true }),
    ];
  }
  if (kind === 'parts') {
    const rows = partRows(project);
    if (!rows.length) return null;
    return [
      paragraph('Order a part only after you confirm the nameplate or the bill of materials. Identical parts are listed once with a quantity. This list does not invent part numbers.'),
      table(['Item', 'Description', 'Part number', 'Qty'], rows, { small: true }),
    ];
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
    const points = labels.length ? labels : ['Lubrication point still to identify'];
    const shown = [];
    const seen = new Set();
    for (const label of points) {
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      shown.push(label);
    }
    const tableRows = shown.map((label) => [
      label,
      'Use the lubricant named on the component data sheet.',
      '500 operating hours. Confirm on the data sheet.',
      SIGN,
    ]);
    return [
      note('This list does not name a grease, oil, or manufacturer interval.'),
      table(['Point', 'Lubricant', 'Recommended default interval', 'Sign-off'], tableRows, { rowInferred: tableRows.map(() => true) }),
    ];
  }
  if (kind === 'cleaning') {
    return [steps([
      { action: 'Stop the equipment with the shutdown procedure and lock out energy before you clean inside a guard.', expect: 'Motion has stopped and zero energy is verified.' },
      { action: 'Remove product and scrap from the surfaces that the upload shows are in the process.', expect: 'Those surfaces are clear, and waste is in the site container.' },
      { action: 'Clean a sensor face only with a method that will not scratch the lens.', expect: 'The sensor still changes state.' },
      { action: 'Remove tools, close the guards, remove locks, and follow the startup procedure.', expect: 'The equipment is ready for a first-cycle check.' },
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
    const labels = kind === 'pneumatic' ? equipment.classes.pneumatic.labels : equipment.classes.hydraulic.labels;
    const blocks = [paragraph(present
      ? `These notes cover the ${label} devices found in the upload${labels.length ? `: ${theDevice(labels[0])}` : ''}.`
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
    paragraph('This document answers the additional request using the equipment found in the upload. It describes the task. It does not copy the control program or the operating narrative.'),
  ];
}

function customSectionTitle(kind) {
  if (kind === 'troubleshooting') return 'What you see and what to do';
  if (kind === 'parts') return 'Parts in this upload';
  if (kind === 'training') return 'Skills to demonstrate';
  if (kind === 'lubrication') return 'Lubrication points';
  if (kind === 'cleaning') return 'Cleaning steps';
  if (kind === 'electrical') return 'Signals in this upload';
  return 'What to do';
}

function buildCustomDocument(project, entry, options = {}) {
  ensureContext(project);
  const kind = entry.customKind || entry.kind;
  const body = customBody(project, entry);
  if (kind === 'troubleshooting' && !body) {
    return { skipped: TROUBLE_SKIP, title: entry.title, kind: 'troubleshooting' };
  }
  if (kind === 'parts' && !body) {
    return { skipped: PARTS_SKIP, title: entry.title, kind: 'parts' };
  }
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
        paragraph(`This ${entry.title.toLowerCase()} was requested with the engineering files for this equipment. Read it with the operating manual, the shutdown procedure, and the startup procedure.`),
        ...howItWorks(project),
        note('Statements inferred from the upload are marked. Confirm them before issue.'),
      ],
    }]),
    chapter('2', entry.title, [{ title: customSectionTitle(kind), inferred: true, blocks: body }]),
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
  TROUBLE_SKIP,
  PARTS_SKIP,
};
