const { scrubField } = require('../text');
const { displayProductName, fallbackNarrative, notAnAlarmMessage } = require('../presentation');
const { manualDate } = require('../manual/date');
const { matchedHazards } = require('../hazards');
const { buildSubsystems } = require('../subsystems');
const { inspectEquipment, controlPoints, energyTable, homingReleasesBrake, programFacts, canonicalValveLabel, labelIsValve } = require('./equipment');
const { alarmRows: manualAlarmRows } = require('../manual/assemble');
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
    { className: 'signoff', rowInferred: rows.map(() => true), widths: ['18%', '38%', '16%', '12%', '16%'] },
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

function joinList(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

function cleanDeviceLabel(label) {
  let text = String(label || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^(?:open|close)\s*\/\s*(?:open|close)\s+/i, '');
  text = text.replace(/^(?:the\s+)?(?:open|close)\s+(?:the\s+)?/i, '');
  text = text.replace(/\b(?:open|close)\b/ig, ' ');
  return text.replace(/\s+/g, ' ').replace(/^[,.\s]+|[,.\s]+$/g, '').trim();
}

function valvePhrase(label) {
  const text = cleanDeviceLabel(label);
  if (!text || !/\bvalve\b/i.test(text)) return 'the valve';
  return theDevice(text);
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
  if (doc.chapters.length < 2) doc.omitContents = true;
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

function projectHasSteam(project, thermal) {
  if ((thermal.labels || []).some((label) => /\bsteam\b/i.test(label))) return true;
  const facts = programFacts(project);
  if (facts.steamOpen || facts.steamClose || facts.steamVent) return true;
  const bits = [];
  for (const tag of project.tags || []) bits.push(tag.name, tag.description, ...(tag.notes || []));
  for (const routine of project.routines || []) {
    bits.push(routine.name, routine.comment);
    for (const unit of routine.units || []) if (unit) bits.push(unit.comment);
  }
  return /\bsteam\b/i.test(bits.filter(Boolean).join('\n'));
}

function uploadText(project) {
  const parts = [];
  for (const tag of project.tags || []) parts.push(tag.name, tag.description, ...(tag.notes || []));
  for (const part of (project.cad && project.cad.bom) || []) parts.push(part.description, part.partNumber);
  for (const item of (project.cad && project.cad.parts) || []) parts.push(item.name, item.description);
  return parts.filter(Boolean).join('\n');
}

function foundHardware(project, words) {
  const blob = uploadText(project);
  return words.filter((word) => new RegExp(`\\b${word}s?\\b`, 'i').test(blob));
}

function hardwarePhrase(project) {
  const found = foundHardware(project, ['coupling', 'belt', 'cable']);
  if (!found.length) return '';
  const names = found.map((word) => (word === 'belt' ? 'the belts' : `the ${word}${word === 'coupling' ? '' : 's'}`));
  return `, including ${joinList(names)}`;
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
  const valve = equipment.classes.valve;
  const motors = motor.labels.filter((label) => !/agitat|pump|\brotor\b/i.test(label));

  if (safety.present) {
    const rawDevice = safety.labels[0] || '';
    const device = rawDevice ? theDevice(rawDevice) : 'each emergency stop fitted to this equipment, if one is fitted';
    const gate = /\b(gate|guard|interlock|door)\b/i.test(rawDevice)
      && !/\b(e-?stop|emergency stop|knife gate|gate valve)\b/i.test(rawDevice)
      && !labelIsValve(project, rawDevice);
    const daily = gate
      ? `Test ${device}. Motion must stop while it is open and stay stopped until it is closed and the equipment is reset. Resetting does not start motion.`
      : `Test ${device}. Motion must stop and stay stopped until the equipment is reset. Releasing an emergency stop must not start motion.`;
    addTask(rows, daily, 'Daily', 'Operator', '10 min');
    addTask(rows, `Inspect ${device} for damage, loose mounting, and any bypass. Remove a bypass before you return the equipment to production.`, 'Monthly', 'Maintenance technician', '15 min');
    addTask(rows, 'Record a full test of each safety function found on this equipment. The person who signs must be qualified for that safety function.', 'Annual', 'Qualified person', '60 min');
  }
  if (thermal.present) {
    if (projectHasSteam(project, thermal)) {
      addTask(rows, 'Inspect the steam traps, if fitted, with the steam supply in service. A trap that stays cold, or that blows straight through, needs service. This schedule does not name a trap or a pressure.', 'Weekly', 'Maintenance technician', '15 min');
      addTask(rows, 'Inspect the steam supply valve with the equipment stopped. Confirm it opens when heating is commanded and that it closes at the end of the steam step.', 'Monthly', 'Maintenance technician', '20 min');
      addTask(rows, 'Test the steam safety relief valve, if fitted, with the steam supply isolated from the vessel. Confirm the discharge path is clear. This schedule does not state a set pressure.', 'Annual', 'Qualified person', '30 min');
    }
    const probe = thermal.labels.find((label) => /probe|temperature/i.test(label)) || 'the temperature probe';
    addTask(rows, `Calibrate ${theDevice(probe)}. Record the as-found and as-left result. This schedule does not state a tolerance or a setpoint.`, 'Annual', 'Maintenance technician', '30 min');
  }
  if (agitator.present) {
    const name = theDevice(agitator.labels[0] || 'agitator');
    const coupling = foundHardware(project, ['coupling']).length ? ' and the drive coupling' : '';
    addTask(rows, `With ${name} stopped and energy isolated, inspect the shaft seal${coupling}. Confirm the agitator is still before you open the vessel.`, 'Monthly', 'Maintenance technician', '20 min');
  }
  if (process.present) {
    if (process.labels.some((label) => /pump/i.test(label)) || /\bpump/i.test(process.labels.join(' '))) {
      addTask(rows, `With the pumps stopped and locked out, inspect each pump seal${foundHardware(project, ['coupling']).length ? ' and coupling' : ''} for leaks or damage.`, 'Monthly', 'Maintenance technician', '20 min');
    }
    if (process.labels.some((label) => /water/i.test(label))) {
      addTask(rows, 'Inspect the water valves for leaks and confirm each valve opens and closes.', 'Monthly', 'Maintenance technician', '20 min');
    }
    if (!process.labels.some((label) => /pump|water/i.test(label))) {
      addTask(rows, 'Inspect the process-fluid valves and pumps for leaks with the equipment stopped and locked out.', 'Monthly', 'Maintenance technician', '20 min');
    }
  }
  if (valve && valve.present) {
    const name = valvePhrase((valve.labels || []).find((label) => /\bvalve\b/i.test(label)) || 'valve');
    addTask(rows, `With the equipment stopped, confirm ${name} opens on command and closes when the command is removed.`, 'Monthly', 'Maintenance technician', '20 min');
  }
  if (motors.length) {
    const device = theDevice(motors[0]);
    addTask(rows, `Inspect ${device} while it runs. Investigate new noise, heat, or vibration before the next shift.`, 'Weekly', 'Operator', '10 min');
    addTask(rows, `With the equipment locked out, inspect ${device}${hardwarePhrase(project)}.`, 'Monthly', 'Maintenance technician', '20 min');
    addTask(rows, `Have a qualified electrician inspect the power connections for ${device}. Use the torque from the component data sheet. This schedule does not give a torque value.`, 'Annual', 'Qualified electrician', '30 min');
  } else if (motor.present && !agitator.present && !process.present) {
    addTask(rows, `With the equipment locked out, inspect each drive found on this equipment${hardwarePhrase(project)}.`, 'Monthly', 'Maintenance technician', '20 min');
  }
  if (sensor.labels.length) {
    const device = theDevice(sensor.labels[0]);
    const many = sensor.labels.length > 1;
    addTask(rows, `Clean ${device} and confirm ${many ? 'each one changes' : 'it changes'} state when the measured condition changes.`, 'Weekly', 'Maintenance technician', '15 min');
    addTask(rows, `Confirm ${device} ${many ? 'are' : 'is'} aligned and still ${many ? 'detect' : 'detects'} the condition ${many ? 'they were' : 'it was'} installed for.`, 'Annual', 'Maintenance technician', '20 min');
  }
  if (air.present) {
    const cylinder = air.labels.find((label) => /\bcylinder\b/i.test(label));
    const actuator = air.labels.find((label) => /cylinder|valve|actuator/i.test(label));
    const supply = air.labels.find((label) => /supply/i.test(label)) || air.labels[0];
    const leakPoint = theDevice(supply || actuator || 'pneumatic devices found on this equipment');
    addTask(rows, `Look for air leaks at ${leakPoint}. Repair a leak only after the air supply is isolated and exhausted.`, 'Daily', 'Operator', '5 min');
    const airFilter = (filter.labels || []).find((label) => /\b(air|pneumatic|bowl)\b/i.test(label));
    if (airFilter) {
      addTask(rows, `Drain the filter bowl for ${theDevice(airFilter)} and confirm the supply gauge is inside the range marked on the machine. This schedule does not set a supply pressure.`, 'Weekly', 'Maintenance technician', '10 min');
      addTask(rows, `Service the filter element for ${theDevice(airFilter)}. Replace an element when the bowl indicator or the component data sheet says to. This schedule does not set a pressure-drop limit.`, '500 operating hours', 'Maintenance technician', '15 min');
    } else {
      addTask(rows, 'Confirm the supply gauge is inside the range marked on the machine. This schedule does not set a supply pressure.', 'Weekly', 'Maintenance technician', '10 min');
    }
    if (cylinder) {
      const rod = /\bcylinder\b/i.test(cylinder) && /\bvalve\b/i.test(cylinder) ? 'the pneumatic cylinder' : theDevice(cylinder);
      addTask(rows, `Inspect ${rod} for scored rods, cracked tubing, and leaking fittings.`, 'Quarterly', 'Maintenance technician', '20 min');
    } else if (actuator || supply) {
      addTask(rows, `Inspect ${theDevice(actuator || supply)} for cracked tubing and leaking fittings.`, 'Quarterly', 'Maintenance technician', '20 min');
    }
  }
  if (oil.present) {
    const points = oil.labels.length ? theDevice(oil.labels[0]) : 'the hydraulic devices found on this equipment';
    addTask(rows, `Look for hydraulic leaks at ${points}. Confirm the gauge is inside the range marked on the machine. This schedule does not set a pressure.`, 'Weekly', 'Maintenance technician', '10 min');
    addTask(rows, `Inspect hoses and fittings for ${points}. Replace a damaged hose before it weeps.`, 'Monthly', 'Maintenance technician', '20 min');
    addTask(rows, 'Inspect the hydraulic power unit that supplies this equipment: fluid condition, leaks, and the filter indicator. Follow the fluid specification on the data sheet.', 'Annual', 'Maintenance technician', '30 min');
  }
  if (lube.present) {
    const points = lube.labels.length ? theDevice(lube.labels[0]) : 'each lubrication point found on this equipment';
    addTask(rows, `Look at ${points} for a dry fitting or a fresh leak.`, 'Weekly', 'Operator', '10 min');
    addTask(rows, `Lubricate ${points}. Use the lubricant named on the component data sheet. This schedule does not name a grease or oil.`, '500 operating hours', 'Maintenance technician', '20 min');
  }
  if (filter.present) {
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
  const maintainable = equipment.present.some((id) => id !== 'gravity');
  if (maintainable && equipment.powered && !rows.some((item) => /electrician/i.test(item.skill))) {
    const where = agitator.present || process.present ? 'the agitator drive and the pump drives' : 'the cabinet connections and the main disconnect';
    addTask(rows, `Have a qualified electrician inspect ${where} for heat discoloration or looseness. Use torque values from the device data sheet, not from this schedule.`, 'Annual', 'Qualified electrician', '30 min');
  }
  if (hasController(project) && equipment.present.length <= 2) {
    addControllerTasks(rows);
  } else if (!rows.length) {
    addTask(rows, 'The upload did not identify maintainable devices. Add each motor, valve, sensor, safety device, filter, and lubrication point before this schedule is issued.', 'Before issue', 'Maintenance technician', '30 min');
  }
  rows.sort((left, right) => INTERVAL_ORDER.indexOf(left.interval) - INTERVAL_ORDER.indexOf(right.interval));

  const found = equipment.present.length
    ? `Device classes found in this upload: ${equipment.present.map((id) => equipment.classes[id].label).join(', ')}.`
    : 'This upload did not identify a motor, valve, sensor, or other maintainable device.';
  const repeatNote = rows.some((row) => row.interval === '500 operating hours')
    ? ' A task that is already listed for a shorter interval is not repeated at 500 operating hours.'
    : '';
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
        paragraph(`This schedule lists one task table. Rows are grouped by interval.${repeatNote}`),
        note(DEFAULT_NOTE),
        paragraph(found),
        ...howItWorks(project),
        taskTable(rows),
      ],
    }]),
  ]);
}

function addControllerTasks(rows) {
  addTask(rows, 'Test the emergency stop. Outputs must drop and stay off until the equipment is reset. Resetting does not start the equipment.', 'Daily', 'Operator', '10 min');
  addTask(rows, 'Back up the controller program and keep the copy with the machine record.', 'Monthly', 'Maintenance technician', '20 min');
  addTask(rows, 'Inspect the cabinet fan, if one is fitted. This schedule does not name a filter size.', 'Quarterly', 'Maintenance technician', '15 min');
  addTask(rows, 'Inspect the controller battery. Replace it when the controller reports that it is low. This schedule does not state a replacement interval.', 'Annual', 'Maintenance technician', '15 min');
}

function storedEnergyExpect(equipment) {
  const parts = ['Gauges that apply read zero'];
  if (equipment.classes.thermal.present) parts.push('hot surfaces have cooled');
  if (equipment.classes.gravity.present) parts.push('vertical or spring-held loads are blocked');
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
}

function findingClauses(text) {
  const cleaned = String(text || '')
    .replace(/^from the control logic:\s*/i, '')
    .replace(/,?\s*or let a shutdown occur\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(/(?<=[.!?])\s+|\s+\bthen\b\s+/i)
    .map((part) => part.replace(/^[,.\s]+|[,.\s]+$/g, '').trim())
    .filter(Boolean);
}

function sentenceIntent(sentence) {
  const text = String(sentence || '');
  if (/\b(home|homing)\b/i.test(text)) return 'home';
  if (/\breset(?:ting|s)?\b/i.test(text) && !/\b(does not|do not|must not|will not|not restart)\b/i.test(text)) return 'reset';
  if (/\bnot pressed\b/i.test(text)) return 'start';
  if (/\b(?:is|are|in its|in their)\s+(?:healthy|normal|released)\b/i.test(text) && !/\b(press|operate|push)\b/i.test(text)) return 'start';
  if (/\b(initiating a run|startup|to start|start command|starts?)\b/i.test(text) && !/\b(does not start|do not start|must not start|will not start|not start)\b/i.test(text)) return 'start';
  if (/\b(observe|watch)\b/i.test(text) && /\b(cycle|first)\b/i.test(text)) return 'start';
  if (/\bclose the guard\b/i.test(text)) return 'start';
  if (/\breleased\b/i.test(text)) return 'enable';
  if (/\b(isolate|lock\s*out|lockout|de-?energiz)\b/i.test(text)) return 'isolate';
  if (/\b(shut\s*down|shutdown)\b/i.test(text)) return 'stop';
  if (/\b(press|operate|push)\b/i.test(text) && /\bstop\b/i.test(text)) return 'stop';
  if (/\b(stops?|stopped|stopping)\b/i.test(text)) return 'stop';
  return 'unknown';
}

function logicBlocks(routine) {
  const blocks = [];
  for (const unit of routine.units || []) {
    if (!unit || unit.unread) continue;
    const text = String(unit.text || '');
    const parts = text.match(/\bIF\b[\s\S]*?\bEND_IF\b/gi) || (text.trim() ? [text] : []);
    for (const part of parts) blocks.push(part);
  }
  return blocks;
}

function blockWords(block, routine) {
  const words = new Set();
  const add = (value) => {
    for (const word of String(value || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 2) words.add(word);
    }
  };
  add(block);
  const comments = new Map();
  for (const member of routine.declarations || []) {
    if (member && member.name) comments.set(String(member.name).toLowerCase(), member.comment || '');
  }
  for (const id of block.match(/\b[A-Za-z_]\w*\b/g) || []) add(comments.get(id.toLowerCase()) || '');
  return words;
}

function blockIntent(block, routine) {
  const comments = new Map();
  for (const member of routine.declarations || []) {
    if (member && member.name) comments.set(String(member.name).toLowerCase(), member.comment || '');
  }
  const described = (block.match(/\b[A-Za-z_]\w*\b/g) || []).map((id) => comments.get(id.toLowerCase()) || '').join(' ');
  const blob = `${block}\n${described}`;
  if (/\b(home|homing)\b/i.test(blob)) return 'home';
  if (/\breset\b/i.test(blob) && !/\bstop\b/i.test(block)) return 'reset';
  const setsOn = /:=\s*(?:TRUE|1|ON)\b|\b(?:OTE|OTL)\b/i.test(block);
  const setsOff = /:=\s*(?:FALSE|0|OFF)\b|\bOTU\b/i.test(block);
  const stopCond = /\b(stop|e-?stop|emergency)\b/i.test(blob);
  const startCond = /\b(start|enable|run)\b/i.test(blob);
  if (/\b(isolate|lockout|lock\s*out|de-?energiz)\b/i.test(blob)) return 'isolate';
  if (setsOff && !setsOn) return stopCond ? 'stop' : 'de-energize';
  if (setsOn && !setsOff) return startCond ? 'start' : 'enable';
  if (stopCond && !startCond) return 'stop';
  if (startCond) return 'start';
  return 'unknown';
}

const STOP_INTENT = new Set(['stop', 'de-energize', 'isolate']);
const START_INTENT = new Set(['start', 'reset', 'home', 'enable']);

function sourceScores(sentence, routine) {
  const words = new Set(String(sentence || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  let best = '';
  let bestScore = 0;
  let stop = '';
  let stopScore = 0;
  for (const block of logicBlocks(routine)) {
    let score = 0;
    for (const word of blockWords(block, routine)) if (words.has(word)) score += 1;
    if (score < 2) continue;
    const intent = blockIntent(block, routine);
    if (score > bestScore) {
      bestScore = score;
      best = intent;
    }
    if (STOP_INTENT.has(intent) && score > stopScore) {
      stopScore = score;
      stop = intent;
    }
  }
  return { best, bestScore, stop, stopScore };
}

function clauseIntent(sentence, routine) {
  const spoken = sentenceIntent(sentence);
  if (START_INTENT.has(spoken)) return spoken;
  if (!routine) return spoken;
  const scored = sourceScores(sentence, routine);
  // A start rung that only names the stop button does not reclassify a sentence
  // whose own verb is stop. Home and reset still win when they match more of the words.
  if (spoken === 'stop' && scored.stop && scored.stopScore >= scored.bestScore) return scored.stop;
  if (scored.best && (START_INTENT.has(scored.best) || STOP_INTENT.has(scored.best))) return scored.best;
  return spoken;
}

function plainFindings(project) {
  const lines = [];
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    const analysis = routine.analysis || {};
    for (const step of analysis.operatorSteps || []) {
      const action = cleanText(step.action, project);
      for (const clause of findingClauses(action)) {
        if (STOP_INTENT.has(clauseIntent(clause, routine))) lines.push(clause);
      }
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
      expect: 'People stay outside the guarded space until motion has finished.',
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
    { action: 'Release or block stored energy as the table describes.', expect: storedEnergyExpect(equipment) },
    { action: 'Verify zero energy. Try the start control, and measure voltage where the electrical row says to measure.', expect: 'The equipment does not respond, and the electrical test shows absence of voltage.' },
    { action: 'When the work is finished, remove only the lock and tag you applied, then return the equipment to service with the startup procedure.', expect: 'Each lock is removed by the person who applied it, and the equipment is started only through the startup procedure.' },
  );
  const doc = shell(project, {
    ...options,
    subtitle: 'Shutdown Procedure',
    docCode: 'SD',
    warning: `Follow the site energy-control procedure. This outline is derived from the uploaded ${cadUpload(project) && !hasController(project) ? 'files' : 'program'} and is not a substitute for a reviewed lockout procedure.`,
  });
  const about = [
    paragraph('This procedure shuts the equipment down in three ways: a normal stop, an emergency stop, and an energy-isolation outline. The energy table is the same list used in the operating manual.'),
    ...howItWorks(project),
  ];
  if (findings.length) about.push(paragraph(findings.join(' '), true));
  if (safetyLogic) about.push(paragraph('The program includes safety logic. Treat a trip of that logic as a stop. Resetting the safety logic does not grant a start.'));
  if (!points.stops.length && !points.estops.length) {
    about.push(note('The upload did not name a stop or emergency-stop device. Confirm both on the machine before this procedure is issued.'));
  }
  doc.flow = true;
  return finish(doc, [
    chapter('1', 'Purpose', [{ title: 'What this procedure covers', blocks: about }]),
    chapter('2', 'Normal stop', [{ title: 'Stop at the end of the cycle', inferred: !points.stops.length, blocks: [steps(normal)] }]),
    chapter('3', 'Emergency stop', [{ title: 'Stop when someone is at risk', inferred: !points.estops.length, blocks: [steps(emergency)] }]),
    chapter('4', 'Energy isolation', [{
      title: 'Lockout and tagout outline',
      inferred: true,
      blocks: [
        paragraph(guardName
          ? 'Lock out every energy source below before you enter a guarded space, clean inside the guards, or replace a part. Include only the sources this equipment has.'
          : 'Lock out every energy source below before you enter the equipment, clean inside it, or replace a part. Include only the sources this equipment has.'),
        table(['Energy', 'Isolation point', 'Release stored energy', 'Verify zero energy'], energyTable(project)),
        steps(isolation),
      ],
    }]),
  ]);
}

function controlUnit(label) {
  const text = String(label || '');
  const cooker = text.match(/\bcooker\s*#?\s*(\d+)/i);
  if (cooker) return `Cooker ${cooker[1]}`;
  if (/\bmilling\b/i.test(text)) return 'Milling';
  if (/\bmc\b/i.test(text)) return 'MC';
  return '';
}

function groupedControlSteps(labels, actionFor) {
  const groups = new Map();
  const loose = [];
  for (const label of labels) {
    const unit = controlUnit(label);
    if (!unit) loose.push(label);
    else {
      if (!groups.has(unit)) groups.set(unit, []);
      groups.get(unit).push(label);
    }
  }
  if (groups.size < 2) return [actionFor('', labels)];
  const steps = [];
  for (const [unit, names] of groups) steps.push(actionFor(unit, names));
  if (loose.length) steps.push(actionFor('', loose));
  return steps;
}

function flagKeptSpellings(project, labels) {
  if (!project.warnings) project.warnings = [];
  for (const label of labels) {
    const typo = String(label || '').match(/\bSedquence\b/);
    if (!typo) continue;
    const message = `The upload spells "Sedquence" in "${label}". The document keeps that spelling.`;
    if (!project.warnings.includes(message)) project.warnings.push(message);
  }
}

function buildStartup(project, options = {}) {
  ensureContext(project);
  const equipment = inspectEquipment(project);
  const points = controlPoints(project);
  const startNames = points.starts;
  const resetNames = points.resets;
  const homeName = points.homes[0] || '';
  const guardName = points.guards[0] || '';
  const motors = equipment.classes.motor.labels.filter((label) => !/agitat|pump|\brotor\b/i.test(label));
  const releasesBrake = homingReleasesBrake(project);
  flagKeptSpellings(project, [...startNames, ...resetNames]);
  const prestart = [
    { action: 'Read the shutdown procedure and confirm the previous stop is complete.', expect: 'Nobody is still working on the equipment, and tools are out of the machine.' },
    { action: 'Confirm every lock and tag from energy isolation has been removed by the person who applied it.', expect: 'Isolation points are unlocked only after that person is finished.' },
    { action: guardName ? 'Confirm people are outside the guarded space.' : 'Confirm people are clear of moving parts.', expect: 'The start area is clear.' },
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
  if (equipment.classes.thermal.present && projectHasSteam(project, equipment.classes.thermal)) {
    power.push({
      action: 'Crack the steam valve to warm the line, then open fully.',
      expect: 'The line is warm and the valve is open. This procedure does not state a pressure or a temperature.',
    });
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
  if (resetNames.length) {
    homing.push(...groupedControlSteps(resetNames, (_unit, names) => ({
      action: `Press ${joinList(names)} after the cause of any fault is corrected.`,
      expect: 'Faults that were corrected are clear. Reset does not start the cycle.',
    })));
  }
  if (!homeName && !resetNames.length && !releasesBrake) {
    homing.push({ action: 'Put the equipment in its safe starting position.', expect: 'The upload did not identify a homing or reset command. Confirm the starting position on the machine before issue.' });
  }

  const first = [];
  if (startNames.length) {
    const restores = equipment.classes.pneumatic.present ? 'power or air returns' : 'power returns';
    first.push(...groupedControlSteps(startNames, (unit, names) => ({
      action: unit
        ? `Start the ${unit} cycle with ${joinList(names)}.`
        : `Start the first cycle with ${joinList(names)}.`,
      expect: `The equipment starts only after this start command. It does not start by itself when ${restores}.`,
    })));
  } else {
    first.push({ action: 'Give the normal start command for this equipment.', expect: 'The equipment starts only after that command. The upload did not name the start control.' });
  }
  const watched = [];
  if (equipment.classes.agitator.present) watched.push('the agitator turns only while the step calls for it');
  if (equipment.classes.thermal.present) watched.push('the steam supply opens only for the heat step');
  if (equipment.classes.process.present) watched.push('a pump runs only while a step calls for flow');
  else if (motors.length) watched.push(`${theDevice(motors[0])} runs only while the cycle commands it`);
  const watchedExpect = watched.length
    ? `${watched[0].charAt(0).toUpperCase()}${watched.join(', and ').slice(1)}.`
    : 'The cycle finishes without a new fault. This procedure does not state a speed or a time.';
  first.push(
    { action: guardName ? 'Watch the first cycle from outside the guards.' : 'Watch the first cycle from a safe position.', expect: watchedExpect },
    { action: 'Stop with the normal stop, or press the nearest emergency stop if someone is at risk, if the first cycle is wrong.', expect: 'The shutdown procedure brings the equipment to a stop.' },
  );
  const doc = shell(project, {
    ...options,
    subtitle: 'Startup Procedure',
    docCode: 'SU',
    warning: 'Do not start the equipment until people are clear and energy isolation from the shutdown procedure has been removed.',
  });
  finish(doc, [
    chapter('1', 'Before you start', [{
      title: 'How this pairs with shutdown',
      blocks: [
        paragraph(`Use this procedure to return the equipment to production after a shutdown. It reverses the shutdown procedure for the same equipment: checks, power, ${homeName || releasesBrake ? 'reset or homing' : 'reset'}, then one watched cycle.`),
        ...howItWorks(project),
      ],
    }]),
    chapter('2', 'Pre-start checks', [{ title: 'Checks before power or motion', inferred: !points.guards.length && !points.estops.length, blocks: [steps(prestart)] }]),
    chapter('3', 'Power-up', [{ title: 'Restore energy', inferred: true, blocks: [steps(power)] }]),
    chapter('4', homeName || releasesBrake ? 'Homing and reset' : (resetNames.length ? 'Reset' : 'Starting position'), [{ title: 'Establish a safe starting state', inferred: !homeName && !resetNames.length, blocks: [steps(homing)] }]),
    chapter('5', 'First cycle', [{ title: 'Verify the first cycle', blocks: [steps(first)] }]),
  ]);
  doc.flow = true;
  return doc;
}

function foldAlarm(text) {
  return alarmMeaning(text).split(' ').map((word) => (
    word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
  )).join(' ');
}

function boilerplateAlarm(text) {
  const raw = String(text || '').toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  return raw === 'device or signal fault detected' || raw === 'module communication offline';
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
  const raw = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const instrument = /\b(temperature|level|pressure|flow|steam|valve|motor|pump|agitator)\b/.test(raw);
  if (/\bprocess\s+variable\b/.test(raw) && !instrument) return true;
  if (/\blow\s*-?\s*low\s+limit\b/.test(raw)) return true;
  if (/\bnot communicating\b/.test(raw)) return true;
  if (/\breported a fault\b/.test(raw)) return true;
  if (/\balarm active\b/.test(raw) && !instrument) return true;
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
  text = text.replace(/\b(high-high|low-low|high|low)\b/ig, ' ');
  text = text.replace(/\b(temperature|level|pressure|flow)\b[\s\S]*$/i, '').trim();
  if (text === text.toUpperCase()) text = text.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || /^(the|a)$/i.test(text)) return kind;
  if (new RegExp(`\\b${kind}\\b`, 'i').test(text)) return text;
  return `${text} ${kind}`;
}

function genericProcessAlarm(text) {
  const raw = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /\b(high[\s-]*high|hi[\s-]*hi|low[\s-]*low)\b/.test(raw) && /\bprocess\s+alarms?\b/.test(raw);
}

function bareLimitMessage(text) {
  const raw = String(text || '').toLowerCase().replace(/[.]/g, '').replace(/\s+/g, ' ').trim();
  return /^(high[-\s]?high|high|low[-\s]?low|low)$/.test(raw);
}

function limitKind(text) {
  const raw = String(text || '').toLowerCase();
  if (/\b(high[\s-]*high|hi[\s-]*hi)\b/.test(raw)) return 'high-high';
  if (/\blow[\s-]*low\b/.test(raw)) return 'low-low';
  if (/\bhigh\b/.test(raw)) return 'high';
  if (/\blow\b/.test(raw)) return 'low';
  return '';
}

function meaningTokens(text) {
  return alarmMeaning(text).split(' ').filter((word) => word && !/^(high-high|high|low-low|low|process)$/.test(word));
}

function alarmMatchScore(left, right) {
  const a = foldAlarm(left);
  const b = foldAlarm(right);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const kindA = limitKind(left);
  const kindB = limitKind(right);
  const tokensA = meaningTokens(left).filter((token) => token.length > 2);
  const tokensB = meaningTokens(right).filter((token) => token.length > 2);
  const shared = tokensB.filter((token) => tokensA.includes(token));
  if (kindA && kindA === kindB) {
    if (!tokensA.length && !tokensB.length) return 80;
    if (!tokensA.length || !tokensB.length) return 20;
    if (shared.length && (shared.length === tokensA.length || shared.length === tokensB.length)) return 70 + shared.length;
    return shared.length ? 40 + shared.length * 5 : 0;
  }
  return shared.length >= 2 ? 30 + shared.length * 5 : 0;
}

function addFinding(rows, symptom, cause, remedy) {
  const text = String(symptom || '').replace(/\s*\(\s*value\s+\d+\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!text || notAnAlarmMessage(text) || text.length > 140 || text.split(' ').length > 22 || boilerplateAlarm(text) || genericProcessAlarm(text)) return;
  const key = foldAlarm(text);
  if (!key || rows.some((row) => foldAlarm(row[0]) === key)) return;
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

function americanSpelling(text) {
  return String(text || '').replace(/\bAluminium\b/g, 'Aluminum').replace(/\baluminium\b/g, 'aluminum');
}

function fastenerSpec(text) {
  const match = String(text || '').match(/\bM\d+(?:\.\d+)?\s*[x×]\s*\d+/i);
  return match ? match[0].replace(/\s+/g, '').replace(/×/g, 'x') : '';
}

function assemblyPart(description) {
  const text = String(description || '');
  if (/\b(screw|bolt|nut|washer|pin|bearing|seal|gasket|o-ring|trap|coupling|belt|filter element)\b/i.test(text)) return false;
  return /\b(assembly|housing|frame|body|rotor|stator|rear|front|cover|enclosure|agitator|circuit|pump|drain|suction)\b/i.test(text);
}

function deviceKey(label) {
  return String(label || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(' ');
}

function shoutedLabel(text) {
  const letters = String(text || '').replace(/[^A-Za-z]/g, '');
  if (!letters) return false;
  return letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6;
}

function dedupeDevices(labels) {
  const kept = [];
  for (const label of labels) {
    const clean = cleanDeviceLabel(label);
    if (!clean) continue;
    if (/\b(drain|suction|circuit|enclosure|housing|frame)\b/i.test(clean) && !/\b(filter|cylinder|valve|motor)\b/i.test(clean)) continue;
    const index = kept.findIndex((item) => deviceKey(item) === deviceKey(clean));
    if (index < 0) kept.push(clean);
    else if ((shoutedLabel(kept[index]) && !shoutedLabel(clean)) || (/^pump\b/i.test(kept[index]) && !/^pump\b/i.test(clean))) kept[index] = clean;
  }
  return kept;
}

function serviceParts(project, equipment) {
  const items = [];
  const seen = new Set();
  const add = (description, usedOn) => {
    const name = String(description || '').replace(/\s+/g, ' ').trim();
    const where = String(usedOn || '').replace(/\s+/g, ' ').trim();
    if (!name || !where) return;
    const key = `${name.toLowerCase()}|${where.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ description: name, usedOn: where, partNumber: 'Read the nameplate', qty: 1 });
  };
  const pumps = dedupeDevices([
    ...(equipment.classes.hydraulic.labels || []).filter((label) => /\bpump\b/i.test(label)),
    ...(equipment.classes.process.labels || []).filter((label) => /\bpump\b/i.test(label)),
  ]).slice(0, 6);
  for (const pump of pumps) add(`${pump}: mechanical seal`, pump);
  for (const label of dedupeDevices(equipment.classes.filter.labels || []).slice(0, 4)) {
    add(`${label}: element`, label);
  }
  const valves = dedupeDevices([
    ...((equipment.classes.valve && equipment.classes.valve.labels) || []),
    ...(equipment.classes.pneumatic.labels || []).filter((label) => /\b(cylinder|valve)\b/i.test(label)),
  ]).slice(0, 6);
  for (const label of valves) {
    if (!/\b(valve|cylinder)\b/i.test(label)) continue;
    add(`${label}: seal kit`, label);
  }
  const motors = dedupeDevices((equipment.classes.motor.labels || []).filter((label) => !/agitat|pump|\brotor\b/i.test(label))).slice(0, 4);
  for (const motor of motors) add(`${motor}: bearings, if fitted`, motor);
  if (equipment.classes.agitator.present) {
    const name = dedupeDevices(equipment.classes.agitator.labels || [])[0] || 'Agitator';
    add(`${name}: shaft seal`, name);
    add(`${name}: bearings, if fitted`, name);
  }
  if (projectHasSteam(project, equipment.classes.thermal)) {
    const steam = (equipment.classes.thermal.labels || []).find((label) => /\bsteam\b/i.test(label)) || 'Steam supply';
    const where = cleanDeviceLabel(steam) || 'Steam supply';
    add('Steam trap, if fitted', where);
    add('Relief valve, if fitted', where);
  }
  if (equipment.classes.gravity.present) {
    const brake = (equipment.classes.gravity.labels || []).find((label) => /\bbrake\b/i.test(label)) || (equipment.classes.gravity.labels || [])[0] || 'Lift brake';
    const name = cleanDeviceLabel(brake) || 'Lift brake';
    add(`${name}: friction pad`, name);
  }
  if (equipment.classes.sensor.present) {
    for (const label of dedupeDevices(equipment.classes.sensor.labels || []).slice(0, 4)) {
      add(`${label}: spare`, label);
    }
  }
  if (equipment.classes.lubrication.present) {
    for (const label of dedupeDevices(equipment.classes.lubrication.labels || []).slice(0, 4)) {
      const gearbox = /\bgear\s*box\b/i.test(label);
      const where = gearbox ? 'Gearbox' : (label.replace(/\blubrication point\b/ig, '').replace(/\s+/g, ' ').trim() || 'Lubrication');
      add(gearbox ? 'Gearbox: lubricant or seal' : `${where}: lubricant or seal`, where);
    }
  }
  if (equipment.classes.safety.present && (equipment.classes.safety.labels || []).some((label) => /\b(e-?stop|emergency stop)\b/i.test(label))) {
    add('Emergency stop: contact block', 'Emergency stop');
  }
  if (!equipment.present.length && !(cadUpload(project) && !hasController(project))) {
    add('Controller: battery, if fitted', 'Controller');
    add('Cabinet fan filter, if fitted', 'Controller cabinet');
    add('Emergency stop: contact block', 'Emergency stop');
  }
  return items;
}

function canonicalPart(description) {
  let text = americanSpelling(String(description || '')).replace(/\s+/g, ' ').trim();
  text = text.replace(/^(?:component|fastener),\s+solid body,\s+part\s+/i, '');
  text = text.split(' ').map((word) => word.replace(/([A-Za-z])\d{3,4}$/g, '$1')).join(' ');
  return text.replace(/[-_\s]+$/, '').replace(/\s+/g, ' ').trim();
}

function publishedPartNumber(part, description) {
  const spec = fastenerSpec(`${part.partNumber || ''} ${description}`);
  if (spec) return spec;
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

function rememberPart(merged, description, qty, partNumber, usedOn) {
  if (rejectedPart(description)) return;
  const key = partKey(description);
  if (!key) return;
  const existing = merged.get(key);
  if (existing) {
    existing.qty += qty;
    const shouted = existing.description === existing.description.toUpperCase();
    const nextShouted = description === description.toUpperCase();
    if (shouted && !nextShouted) existing.description = description;
    if (usedOn) existing.usedOn = usedOn;
  } else {
    merged.set(key, { description, qty, partNumber, usedOn: usedOn || 'Assembly' });
  }
}

function partRows(project) {
  const merged = new Map();
  for (const part of (project.cad && project.cad.bom) || []) {
    const raw = cleanText(part.description || part.partNumber || '', project);
    const description = canonicalPart(raw);
    if (!description || assemblyPart(description)) continue;
    const qty = Number(part.qty);
    const count = Number.isFinite(qty) && qty > 0 ? qty : 1;
    rememberPart(merged, description, count, publishedPartNumber(part, description), 'Assembly');
  }
  const equipment = inspectEquipment(project);
  for (const item of serviceParts(project, equipment)) {
    rememberPart(merged, item.description, item.qty, item.partNumber, item.usedOn);
  }
  const rows = [];
  for (const item of merged.values()) {
    rows.push([String(rows.length + 1), item.description, item.usedOn || 'Assembly', item.partNumber, String(item.qty)]);
    if (rows.length >= 40) break;
  }
  return rows;
}

function troubleIntro(equipment, project) {
  const held = [];
  if (equipment.classes.thermal.present) held.push('steam or heat');
  if (equipment.classes.process.present && (equipment.classes.thermal.present || equipment.classes.process.labels.some((label) => /\b(water|steam|hot)\b/i.test(label)))) {
    held.push('hot fluid');
  }
  if (equipment.classes.pneumatic.present) held.push('compressed air');
  if (equipment.classes.hydraulic.present) held.push('hydraulic pressure');
  if (equipment.classes.chemical.present) held.push('process chemical');
  const line = held.length ? `open a line that can hold ${joinList(held)}` : 'open a line that can hold stored energy';
  const entry = project && controlPoints(project).guards.length ? 'enter a guarded space' : 'work on the equipment';
  return `Correct the cause, then reset. Reset does not start the equipment. Use the shutdown procedure if you must ${entry} or ${line}.`;
}

function classFaultRows(equipment) {
  const rows = [];
  if (equipment.classes.safety.present) {
    const labels = (equipment.classes.safety.labels || []).join(' ');
    const guard = /\b(guard|interlock|light curtain|door)\b/i.test(labels) && !/\b(knife gate|gate valve)\b/i.test(labels);
    const estop = /\b(e-?stop|emergency stop)\b/i.test(labels);
    if (guard && estop) {
      rows.push(['Motion stops or will not start', 'A guard is open or an emergency stop is pressed.', 'Close the guard or release the emergency stop, press reset, then start. Reset does not start the equipment.']);
    } else if (guard) {
      rows.push(['Motion stops or will not start', 'A guard is open or its interlock is not proved.', 'Close the guard, confirm the interlock, press reset, then start. Reset does not start the equipment.']);
    } else {
      rows.push(['Motion stops or will not start', 'An emergency stop is pressed or its circuit is open.', 'Release the emergency stop, press reset, then start. Reset does not start the equipment.']);
    }
  }
  if (equipment.classes.motor.present || equipment.classes.agitator.present) {
    rows.push(['A drive shows a fault', 'The drive detected a fault, or a permissive is open.', 'Correct the condition and press reset. Reset does not start the equipment.']);
  }
  if ((equipment.classes.valve && equipment.classes.valve.present) || equipment.classes.pneumatic.present) {
    rows.push(['A valve does not reach the commanded position', 'The command and the open or closed feedback do not agree.', 'Stop the related motion, confirm the valve can move, then press reset.']);
  }
  if (equipment.classes.hydraulic.present) {
    rows.push(['Hydraulic motion does not move', 'The supply is off, or a hose is blocked.', 'Stop the pump and follow the shutdown procedure before you open a fitting.']);
  }
  if (equipment.classes.thermal.present) {
    rows.push(['The steam step does not advance', 'A fault is still active, or the steam supply valve did not move.', 'Clear the fault and confirm the steam supply valve. Reset does not open the steam valve by itself.']);
  }
  if (equipment.classes.process.present) {
    rows.push(['Flow does not start', 'A pump or supply valve did not follow the command.', 'Stop the pump and close the supply before you open a line.']);
  }
  if (equipment.classes.sensor.present) {
    rows.push(['A sensor does not change state', 'The sensor is dirty, misaligned, or not seeing the part.', 'Clean and align the sensor, then try the cycle again.']);
  }
  return rows;
}

function symptomFor(label, action) {
  let text = String(label || '').replace(/\s+/g, ' ').trim().replace(/^(?:the|a|an)\s+/i, '');
  if (!text) return '';
  if (/\bcylinder\b/i.test(text)) text = 'pneumatic cylinder';
  if (text !== text.toUpperCase()) text = text.charAt(0).toLowerCase() + text.slice(1);
  return `The ${text} ${action}`;
}

function deviceAction(label) {
  const text = String(label || '');
  if (/\bcylinder\b/i.test(text)) return 'will not extend';
  if (/\b(valve|actuator)\b/i.test(text)) return 'will not open';
  if (/\b(conveyor|motor)\b/i.test(text)) return 'will not start';
  return '';
}

function sentenceCauses(causes) {
  const items = causes.filter(Boolean);
  if (!items.length) return '';
  const joined = items.length === 1
    ? items[0]
    : (items.length === 2 ? `${items[0]} or ${items[1]}` : `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`);
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

function conditionCause(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/\b(start|reset)\b/i.test(text) && /\b(button|pushbutton|pb)\b/i.test(text)) return '';
  if (/\brelease\b/i.test(text)) {
    const name = text.replace(/\s+is\s+(on|off|made|healthy)$/i, '').trim();
    return `${name} is not made`;
  }
  if (/\b(e-?stop|emergency stop)\b/i.test(text)) return 'the emergency stop is not healthy';
  if (/\b(guard|interlock|door)\b/i.test(text)) return 'the guard is open';
  if (/\b(home|homing)\b/i.test(text)) return 'the homing request is not made';
  if (/\b(air|pneumatic)\b/i.test(text)) return 'compressed air is off';
  if (/\b(part present|part sensor|photo)\b/i.test(text) || (/\bsensor\b/i.test(text) && /\bpart\b/i.test(text))) return 'the part sensor is not made';
  if (/\bsensor\b/i.test(text)) return `${text.charAt(0).toLowerCase()}${text.slice(1)} is not made`;
  return '';
}

function negatedClause(clause) {
  const text = String(clause || '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/\brelease\b/i.test(text)) {
    const name = text.replace(/\s+is\s+(on|off|made|healthy)$/i, '').trim();
    return `${name} is not made`;
  }
  if (/\b(air|pneumatic)\b/i.test(text)) return 'compressed air is off';
  if (/\bis on$/i.test(text)) return `${text.replace(/\s+is on$/i, '')} is off`;
  if (/\bis off$/i.test(text)) return `${text.replace(/\s+is off$/i, '')} is still on`;
  if (/\bhas dropped$/i.test(text)) return `${text.replace(/\s+has dropped$/i, '')} has not dropped`;
  if (/\b(part present|part sensor)\b/i.test(text)) return 'the part sensor is not made';
  return '';
}

function clausesFrom(text) {
  const causes = [];
  for (const part of String(text || '').split(/\band\b/i)) {
    const cause = negatedClause(part);
    if (cause && !causes.some((item) => item.toLowerCase() === cause.toLowerCase())) causes.push(cause);
  }
  return causes;
}

function outputDeviceLabel(name, comments) {
  const raw = comments.get(name) || comments.get(String(name || '').toLowerCase()) || name;
  return String(raw || '').replace(/\b(run|enable)\s+command\b/ig, ' ').replace(/\s+/g, ' ').trim();
}

function causesFromCondition(condition, comments) {
  const causes = [];
  const add = (cause) => {
    if (cause && !causes.some((item) => item.toLowerCase() === cause.toLowerCase())) causes.push(cause);
  };
  for (const part of String(condition || '').split(/\bAND\b/i)) {
    const negated = /\bNOT\b/i.test(part);
    const id = (part.match(/\b([A-Za-z_]\w*)\b/g) || []).find((token) => !/^(IF|THEN|AND|OR|NOT|TRUE|FALSE)$/i.test(token));
    if (!id) continue;
    const label = comments.get(id) || comments.get(id.toLowerCase()) || id;
    if (negated) {
      if (/\bstop\b/i.test(label) && !/\b(e-?stop|emergency)\b/i.test(label)) add('stop is held');
      continue;
    }
    add(conditionCause(label));
  }
  return causes;
}

function interlockRows(project) {
  const rows = [];
  const seen = new Set();
  const push = (symptom, cause) => {
    const text = String(symptom || '').replace(/\s+/g, ' ').trim();
    const why = String(cause || '').replace(/\s+/g, ' ').trim();
    if (!text || !why) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(['—', text, why, 'Correct that condition, then start again. Reset does not start the equipment.']);
  };
  const comments = new Map();
  const addComment = (name, comment) => {
    const text = String(comment || '').replace(/\s+/g, ' ').trim();
    if (!name || !text) return;
    comments.set(String(name), text);
    comments.set(String(name).toLowerCase(), text);
  };
  for (const tag of project.tags || []) addComment(tag.name, tag.description);
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    for (const member of routine.declarations || []) addComment(member.name, member.comment);
    const texts = [];
    if (routine.comment) texts.push(routine.comment);
    if (routine.analysis && routine.analysis.function) texts.push(routine.analysis.function);
    for (const unit of routine.units || []) {
      if (!unit || unit.unread) continue;
      if (unit.text) texts.push(unit.text);
      if (unit.comment) texts.push(unit.comment);
      if (unit.summary) texts.push(unit.summary);
    }
    const blob = texts.join('\n');
    const ifRe = /IF\s+([\s\S]+?)\s+THEN\s+([\s\S]*?)(?=\bEND_IF\b|$)/gi;
    let match;
    while ((match = ifRe.exec(blob))) {
      const condition = match[1];
      const body = match[2];
      const causes = causesFromCondition(condition, comments);
      const trueOutputs = [...body.matchAll(/\b([A-Za-z_]\w*)\s*:=\s*(?:TRUE|1)\b/gi)].map((item) => item[1]);
      const falseOutputs = [...body.matchAll(/\b([A-Za-z_]\w*)\s*:=\s*(?:FALSE|0)\b/gi)].map((item) => item[1]);
      if (/\bhome/i.test(condition)) {
        for (const output of [...trueOutputs, ...falseOutputs]) {
          const label = outputDeviceLabel(output, comments);
          if (!/\b(brake|lift|axis|home)\b/i.test(`${label} ${output}`)) continue;
          const noun = /\blift\b/i.test(`${label} ${output}`) ? 'lift' : 'axis';
          push(`The ${noun} will not home`, sentenceCauses(causes));
        }
      }
      if (!causes.length || !trueOutputs.length) continue;
      for (const output of trueOutputs) {
        const label = canonicalValveLabel(outputDeviceLabel(output, comments));
        const action = deviceAction(label);
        if (!action) continue;
        push(symptomFor(label, action), sentenceCauses(causes));
      }
    }
    const opened = blob.match(/\bopens the ([^.]{3,80}?) when ([^.]{3,180})/i);
    if (opened) {
      const label = canonicalValveLabel(opened[1].replace(/^the\s+/i, '').trim());
      const action = deviceAction(label) || 'will not open';
      const causes = clausesFrom(opened[2]);
      if (causes.length) push(symptomFor(label, action), sentenceCauses(causes));
    }
    const when = blob.match(/When ([^.]{3,180}), the control (?:turns on|sets) ([^.]{2,80})\./i);
    if (when) {
      const label = canonicalValveLabel(when[2].trim());
      const action = deviceAction(label);
      const causes = clausesFrom(when[1]);
      if (action && causes.length) push(symptomFor(label, action), sentenceCauses(causes));
    }
  }
  return rows;
}

function axisFaultRows(project) {
  const rows = [];
  for (const item of project.subsystems || []) {
    const components = Array.isArray(item.components) ? item.components.join(' ') : '';
    if (!/\baxis\b/i.test(`${item.name || ''} ${components}`)) continue;
    const blob = `${item.name || ''} ${item.purpose || ''} ${components}`;
    if (/not determinable|add jxr/i.test(blob)) continue;
    const name = String(item.name || 'Axis').replace(/\s+/g, ' ').trim();
    rows.push(['—', `${name} does not reach its position`, 'An interlock is open, or the axis was not referenced.', 'Correct the interlock and reference the axis before you start. Reset does not start the equipment.']);
  }
  return rows;
}

function copiedManualAlarms(project) {
  let rows = [];
  try {
    rows = manualAlarmRows(project) || [];
  } catch {
    return [];
  }
  return rows.filter((row) => {
    const blob = (row || []).join(' ');
    if (/not determinable/i.test(blob)) return false;
    if (!row[1] || notAnAlarmMessage(row[1]) || placeholderProcessAlarm(row[1]) || boilerplateAlarm(row[1])) return false;
    return true;
  });
}

function messageKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function placeholderProcessAlarm(text) {
  const raw = messageKey(text);
  return raw === 'high high process alarm' || raw === 'low low process alarm'
    || raw === 'high-high process alarm' || raw === 'low-low process alarm';
}

function causeKey(cause) {
  const key = messageKey(cause);
  if (!key || key.length < 40) return '';
  if (/^see the condition named/.test(key)) return '';
  if (/^the condition that raised the alarm is still true/.test(key)) return '';
  if (/^correct the condition then press reset/.test(key)) return '';
  return key;
}

function addTrouble(rows, code, symptom, cause, remedy) {
  let text = String(symptom || '').replace(/\s*\(\s*value\s+\d+\s*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  const why = String(cause || '').replace(/\s+/g, ' ').trim();
  const fix = String(remedy || '').replace(/\s+/g, ' ').trim();
  const coded = Boolean(code && code !== '—');
  const blob = [code, text, why, fix].join(' ');
  if (!text || notAnAlarmMessage(text) || /not determinable|add jxr/i.test(blob)) return;
  if (!coded && (text.length > 180 || text.split(' ').length > 28 || genericProcessAlarm(text) || placeholderProcessAlarm(text))) return;
  if (coded && placeholderProcessAlarm(text)) return;
  text = text.replace(/\b(?:state|status|output)\s+valve\b/ig, 'valve').replace(/\s+/g, ' ').trim();
  const key = messageKey(text);
  if (!key) return;
  const existing = rows.find((row) => messageKey(row[1]) === key);
  if (existing) {
    if ((!existing[0] || existing[0] === '—') && coded) existing[0] = code;
    return;
  }
  rows.push([
    coded ? code : '—',
    text,
    why || 'See the condition named in the message.',
    fix || 'Correct the condition, then press reset. Reset does not start the equipment.',
  ]);
}

const CONTROLLER_FORMAT = /^(l5x|l5k|acd|st|awl|tia|xml|plcopen|tcpou)$/i;

function hasController(project) {
  if (String(project.controller || '').trim()) return true;
  if ((project.modules || []).length > 0) return true;
  if ((project.sources || []).some((source) => CONTROLLER_FORMAT.test(source.format || ''))) return true;
  return (project.routines || []).some((routine) => (routine.units || []).some((unit) => (
    unit && !unit.unread && (/\b(IF|THEN|XIC|XIO|OTE|OTL)\b/.test(unit.text || '') || /:=/.test(unit.text || ''))
  )));
}

function cadUpload(project) {
  const cad = project.cad || {};
  if ((cad.bom || []).length || (cad.parts || []).length) return true;
  return (project.sources || []).some((source) => /^(step|iges|stl|dxf)$/i.test(source.format || ''));
}

function programFaultRows(project) {
  const rows = [];
  const seen = new Set();
  const push = (symptom, cause, remedy) => {
    const key = messageKey(symptom);
    if (!key || seen.has(key)) return;
    seen.add(key);
    rows.push(['—', symptom, cause, remedy]);
  };
  for (const routine of project.routines || []) {
    if (routine.aoi) continue;
    for (const unit of routine.units || []) {
      const text = `${unit && unit.text ? unit.text : ''}`;
      const counter = text.match(/\bCTU\s*\(\s*([A-Za-z_]\w*)\s*,\s*([^,)\s]+)/i);
      if (counter && /fault/i.test(counter[1])) {
        const preset = counter[2];
        const why = preset === '?'
          ? 'The preset was not in the upload, or the count input is not made.'
          : `The count input is not made. The preset in the upload is ${preset}.`;
        push(
          'The fault counter does not reach its preset',
          why,
          'Confirm the preset on the controller and the input that counts. This guide does not invent a preset.',
        );
      }
      if (/\bFirstOutFault\b/.test(text)) {
        push(
          'The first out fault does not update',
          'The fault counter bit that writes the first-out fault is not set.',
          'Confirm the fault counter, then read the first-out fault. Reset does not start the equipment.',
        );
      }
      const close = text.match(/\b([A-Za-z_]\w*Close\w*)\s*:=\s*(?:TRUE|1)\b/i) || text.match(/\bOTE\s*\(\s*([A-Za-z_]\w*Close\w*)\s*\)/i);
      if (close && /valve/i.test(close[1]) && !/alm|alarm|fault/i.test(close[1])) {
        const label = canonicalValveLabel(close[1].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '));
        push(
          symptomFor(label, 'will not close') || 'The valve will not close',
          `${close[1].replace(/([a-z])([A-Z])/g, '$1 $2')} is not commanded.`,
          'Correct that condition, then start again. Reset does not start the equipment.',
        );
      }
    }
  }
  return rows;
}

function mechanicalFaultRows(project, equipment) {
  if (hasController(project) || !cadUpload(project)) return [];
  const rows = [];
  if (equipment.classes.motor.present || /\b(motor|stepper)\b/i.test(`${(project.identity && project.identity.productName) || ''}`)) {
    const name = (equipment.classes.motor.labels || [])[0] || 'motor';
    const device = name.replace(/^(?:the|a|an)\s+/i, '');
    const titled = device.charAt(0).toUpperCase() + device.slice(1);
    const drive = foundHardware(project, ['coupling']).length ? 'the coupling and the motor supply' : 'the motor supply';
    rows.push([`The ${device.charAt(0).toLowerCase()}${device.slice(1)} stalls or loses steps`, 'The load is high, or the motor supply is not present.', `Check ${drive}. This guide does not state a current or a torque.`]);
    rows.push([`${titled} is noisy or a bearing is worn`, 'A bearing is dry or worn.', 'Inspect the bearings. Replace them only with the part named on the nameplate.']);
    rows.push(['A connector is loose or open', 'The motor connector is not seated.', 'Reseat the connector with power removed.']);
  }
  const fasteners = [];
  for (const part of (project.cad && project.cad.bom) || []) {
    const spec = fastenerSpec(`${part.partNumber || ''} ${part.description || ''}`);
    if (spec && !fasteners.includes(spec)) fasteners.push(spec);
  }
  if (fasteners.length) {
    rows.push([`A fastener is loose (${fasteners[0]})`, 'A fastener has backed out.', 'Tighten it to the torque on the component data sheet. This guide does not state a torque.']);
  }
  return rows;
}

const TROUBLE_FILLERS = [
  ['The controller does not go to run', 'The controller is not in run, or the program is not loaded.', 'Put the controller in run only after the startup checks. Reset does not start the equipment.'],
  ['An output stays on after a stop', 'The stop did not drop the output.', 'Stop again and confirm the output is off before anyone enters the machine.'],
  ['The emergency stop does not drop the outputs', 'The emergency-stop circuit did not open the outputs.', 'Test the emergency stop. Outputs must drop and stay off until reset. Resetting does not start the equipment.'],
  ['A fault stays on after reset', 'The condition that raised the fault is still true.', 'Correct the condition, then press reset. Reset does not start the equipment.'],
  ['The program on the machine does not match the backup', 'A change was downloaded and the copy kept with the machine record was not updated.', 'Compare the program with the backup before you start.'],
  ['The cabinet is hotter than usual', 'The cabinet fan, if one is fitted, is stopped or blocked.', 'Stop the equipment before you open the cabinet, and confirm the fan can turn.'],
];

function sameTrouble(left, right) {
  if (foldAlarm(left) === foldAlarm(right)) return true;
  return alarmMatchScore(left, right) >= 70;
}

function coveredByManual(text, manual) {
  const key = messageKey(text);
  for (const row of manual) {
    if (messageKey(row[1]) === key) return true;
    if (alarmMatchScore(text, row[1]) >= 70) return true;
  }
  return false;
}

function buildTroubleshootingRows(project, equipment) {
  const manual = copiedManualAlarms(project);
  const merged = [];
  const causes = new Set();
  for (const row of manual) {
    addTrouble(merged, row[0], row[1], row[3] || row[2], row[4]);
    const key = causeKey(row[3] || row[2]);
    if (key) causes.add(key);
  }
  const extras = [];
  for (const row of alarmRows(project)) extras.push(['—', row[0], row[1], row[2]]);
  for (const row of interlockRows(project)) extras.push(row);
  for (const row of programFaultRows(project)) extras.push(row);
  for (const row of axisFaultRows(project)) extras.push(row);
  for (const row of mechanicalFaultRows(project, equipment)) extras.push(['—', row[0], row[1], row[2]]);
  if (hasController(project) || !cadUpload(project)) {
    for (const row of classFaultRows(equipment)) extras.push(['—', row[0], row[1], row[2]]);
  }
  for (const row of extras) {
    if (coveredByManual(row[1], manual)) continue;
    const repeated = causeKey(row[2]);
    if (repeated && causes.has(repeated)) continue;
    addTrouble(merged, row[0], row[1], row[2], row[3]);
  }
  const realCount = merged.length;
  const tailBudget = !hasController(project) ? 0 : (realCount === 0 ? 2 : (realCount < 3 ? 1 : 0));
  let added = 0;
  for (const filler of TROUBLE_FILLERS) {
    if (added >= tailBudget) break;
    const before = merged.length;
    addTrouble(merged, '—', filler[0], filler[1], filler[2]);
    if (merged.length > before) added += 1;
  }
  return merged.filter((row) => row[1] && !notAnAlarmMessage(row[1]) && !placeholderProcessAlarm(row[1]));
}

function customBody(project, entry) {
  const equipment = inspectEquipment(project);
  const kind = entry.customKind || entry.kind;
  if (kind === 'troubleshooting') {
    const found = alarmRows(project);
    const manual = copiedManualAlarms(project);
    const blocks = [paragraph(troubleIntro(equipment, project))];
    const declaredNone = (project.routines || []).some((routine) => (
      ((routine.analysis && routine.analysis.alarms) || []).some((alarm) => notAnAlarmMessage(alarm.text || alarm.message || ''))
    ));
    if (!manual.length && declaredNone) {
      blocks.push(paragraph('No alarms are defined for this equipment.'));
    } else if (!found.length && !manual.length) {
      blocks.push(note('This upload did not include alarm text. Add the alarm messages from the controller. The rows below are the faults for the devices found in the upload.'));
    }
    blocks.push(table(
      ['Code', 'What you see', 'Probable cause', 'What to do'],
      buildTroubleshootingRows(project, equipment),
      { small: true, widths: ['8%', '32%', '30%', '30%'] },
    ));
    return blocks;
  }
  if (kind === 'parts') {
    const rows = partRows(project);
    const blocks = [
      paragraph('Order a part only after you confirm the nameplate or the bill of materials. Identical parts are listed once with a quantity. This list names wear parts for the devices found in the upload and does not invent part numbers.'),
      note('Add part numbers from the nameplate or the bill of materials for any row that does not already show one.'),
    ];
    if (rows.length) {
      blocks.push(table(
        ['Item', 'Description', 'Used on', 'Part number', 'Qty'],
        rows,
        { small: true, widths: ['8%', '42%', '22%', '20%', '8%'] },
      ));
    }
    else {
      blocks.push(paragraph(projectHasSteam(project, equipment.classes.thermal)
        ? 'The upload did not name a wear part. Add seals, gaskets, bearings, and steam traps where this equipment has them.'
        : 'The upload did not name a wear part. Add seals, gaskets, and bearings where this equipment has them.'));
    }
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
    const guarded = controlPoints(project).guards.length > 0;
    return [steps([
      { action: guarded
        ? 'Stop the equipment with the shutdown procedure and lock out energy before you clean inside a guard.'
        : 'Stop the equipment with the shutdown procedure and lock out energy before you clean inside the equipment.',
      expect: 'Motion has stopped and zero energy is verified.' },
      { action: 'Remove product and scrap from the surfaces that the upload shows are in the process.', expect: 'Those surfaces are clear, and waste is in the site container.' },
      { action: 'Clean a sensor face only with a method that will not scratch the lens.', expect: 'The sensor still changes state.' },
      { action: guarded
        ? 'Remove tools, close the guards, remove locks, and follow the startup procedure.'
        : 'Remove tools, remove locks, and follow the startup procedure.',
      expect: 'The equipment is ready for a first-cycle check.' },
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
  const scope = [
    paragraph(`This ${entry.title.toLowerCase()} was requested with the engineering files for this equipment. Read it with the operating manual, the shutdown procedure, and the startup procedure.`),
    ...howItWorks(project),
    note('Statements inferred from the upload are marked. Confirm them before issue.'),
  ];
  doc.omitContents = true;
  return finish(doc, [
    chapter('1', entry.title, [{ title: customSectionTitle(kind), inferred: true, blocks: [...scope, ...body] }]),
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
