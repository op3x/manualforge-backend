const sectionModel = require('../../data/section-model.json');
const { escapeHtml, humanize, sanitizeProse, headingViolations, proseViolations, headingFrom } = require('../text');
const { matchedHazards, hazardsForSection, hazardsForSubsystem, renderHazard } = require('../hazards');
const { buildSubsystems } = require('../subsystems');
const { assertCoverage } = require('../logic');

function productTitle(project) {
  return project.identity.productName || project.identity.model || 'Industrial equipment';
}

function needs(detail) {
  return { type: 'note', label: 'Needs input', text: `NEEDS INPUT: ${detail}` };
}

function paragraph(text, inferred = false) {
  return { type: 'p', text, inferred };
}

function steps(items) {
  return { type: 'steps', items };
}

function bullets(items) {
  return { type: 'ul', items };
}

function table(headers, rows, extra = {}) {
  return { type: 'table', headers, rows, ...extra };
}

function hazardBlocks(hazards, subsystemName) {
  return hazards.map((hazard) => ({ type: 'hazard', hazard: renderHazard(hazard, subsystemName), inferred: true }));
}

function subhead(text, ref) {
  return { type: 'subhead', text, ref };
}

function hasPlc(project) {
  return project.routines.some((routine) => routine.units.length) || project.tags.length > 0;
}

function safetyDevices(project) {
  return project.tags.filter((tag) => /e-?stop|interlock|guard|light curtain|safety|enabling|reset/i.test(`${tag.description} ${tag.name}`));
}

function controlDevices(project) {
  return project.tags.filter((tag) => /pushbutton|button|selector|switch|lamp|indicator|start|stop|reset/i.test(`${tag.description} ${humanize(tag.name)}`));
}

function alarmRows(project) {
  const rows = [];
  for (const routine of project.routines) {
    for (const alarm of routine.analysis?.alarms || []) {
      if (!alarm || !(alarm.text || alarm.code)) continue;
      rows.push([
        alarm.code || '—',
        sanitizeProse(alarm.text || '', project) || 'Alarm',
        alarm.severity || 'Fault',
        sanitizeProse(alarm.cause || '', project) || 'See the condition named in the message.',
        sanitizeProse(alarm.remedy || '', project) || 'Remove the cause, then press Reset.',
      ]);
    }
  }
  for (const tag of project.tags) {
    if (!/alarm|fault/i.test(`${tag.description} ${tag.name}`)) continue;
    const message = tag.description || humanize(tag.name) || 'Alarm';
    if (rows.some((row) => row[1] === message)) continue;
    rows.push([message.slice(0, 12) || '—', message, 'Fault', 'The condition named in the message is present.', 'Correct the condition, then press Reset.']);
  }
  return rows;
}

function layoutSvg(subsystems) {
  const items = subsystems.slice(0, 6);
  if (!items.length) return '';
  const width = 120;
  const boxes = items.map((item, index) => {
    const x = 16 + index * (width + 12);
    const label = escapeHtml(item.name).slice(0, 28);
    return `<rect x="${x}" y="36" width="${width}" height="78" fill="#dfe6ee" stroke="#34495e"/>
      <text x="${x + width / 2}" y="80" text-anchor="middle">${index + 1}</text>
      <text x="${x + width / 2}" y="98" text-anchor="middle" font-size="10">${label}</text>`;
  });
  const total = 16 + items.length * (width + 12);
  return `<svg viewBox="0 0 ${Math.max(total, 320)} 150" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Helvetica" font-size="11">
    <text x="16" y="20" fill="#555">Product flow →</text>
    ${boxes.join('')}
    <rect x="10" y="28" width="${total - 8}" height="96" fill="none" stroke="#c0392b" stroke-dasharray="6 4"/>
  </svg>`;
}

function allGroups(project) {
  return project.routines.flatMap((routine) => (routine.analysis?.groups || []).map((group) => ({
    ...group,
    routineName: routine.scopeKey || routine.name,
    routineTitle: routine.analysis?.title || humanize(routine.name) || 'Machine function',
    safety: Boolean(routine.safety),
  })));
}

function sectionById(id) {
  return sectionModel.sections.find((section) => section.id === id);
}

function buildDocument(project) {
  if (project.routines.some((routine) => routine.units.length)) assertCoverage(project);
  else project.coverage = { units: 0, accounted: 0, percent: 100, missing: [], ok: true };
  const hazards = matchedHazards(project);
  const subsystems = buildSubsystems(project, hazards);
  project.subsystems = subsystems;
  const title = productTitle(project);
  const model = project.identity.model || 'NEEDS INPUT';
  const docNo = project.identity.docNumber || 'NEEDS INPUT';
  const revision = project.identity.revision || 'A';
  const date = new Date().toISOString().slice(0, 10);
  const chapters = [];
  let current = null;
  const pushChapter = (number, name) => {
    current = { number, title: name, id: `ch${number}`, sections: [] };
    chapters.push(current);
  };
  const ordered = [...sectionModel.sections].sort((a, b) => a.order - b.order);
  for (const spec of ordered) {
    if (spec.id === 'front.cover') continue;
    const [number, ...rest] = spec.chapter.split(' ');
    const chapterTitle = rest.join(' ');
    if (!current || current.number !== number) pushChapter(number, chapterTitle);
    const blocks = contentFor(spec, { project, hazards, subsystems, title });
    if (!blocks) continue;
    const sectionTitle = spec.id === 'product.subsystem_function' ? null : spec.title;
    if (spec.id === 'product.subsystem_function') {
      blocks.forEach((entry, index) => {
        current.sections.push({
          id: `${spec.id}.${index + 1}`,
          anchor: `s${number}-${current.sections.length + 1}`,
          number: `${number}.${current.sections.length + 1}`,
          title: entry.title,
          blocks: entry.blocks,
        });
      });
      continue;
    }
    current.sections.push({
      id: spec.id,
      anchor: `s${number}-${current.sections.length + 1}`,
      number: `${number}.${current.sections.length + 1}`,
      title: sectionTitle,
      blocks,
    });
  }
  for (const chapter of chapters) {
    chapter.sections.forEach((section, index) => {
      section.number = `${chapter.number}.${index + 1}`;
      section.anchor = `s${chapter.number}-${index + 1}`;
    });
  }
  const doc = {
    meta: {
      title,
      model,
      docNumber: docNo,
      revision,
      date,
      language: project.identity.language,
      manufacturer: project.identity.manufacturerName || 'NEEDS INPUT',
      headerLeft: `${title} · Operating and Maintenance Manual`,
      headerRight: `${docNo} · Rev. ${revision}`,
      footerLeft: 'Confirm every inferred statement before issue.',
    },
    cover: {
      manufacturer: project.identity.manufacturerName || 'NEEDS INPUT',
      title,
      model,
      docNumber: docNo,
      revision,
      date,
      language: project.identity.language,
      serial: project.identity.serialPlaceholder,
      svg: layoutSvg(subsystems),
    },
    chapters: chapters.filter((chapter) => chapter.sections.length),
  };
  const headings = [];
  const prose = [];
  for (const chapter of doc.chapters) {
    headings.push(chapter.title);
    for (const section of chapter.sections) {
      headings.push(sanitizeProse(section.title, project));
      section.title = headings[headings.length - 1] || section.title;
      for (const block of section.blocks) {
        if (!block.allowIdentifiers) {
          if (block.text) block.text = sanitizeProse(block.text, project);
          if (block.title) block.title = sanitizeProse(block.title, project);
          if (Array.isArray(block.items)) {
            block.items = block.items.map((item) => (
              typeof item === 'string'
                ? sanitizeProse(item, project)
                : { ...item, action: sanitizeProse(item.action || '', project), expect: sanitizeProse(item.expect || '', project) }
            ));
          }
          if (block.type === 'table' && Array.isArray(block.rows)) {
            block.rows = block.rows.map((row) => row.map((cell) => sanitizeProse(cell, project)));
          }
          if (block.type === 'hazard' && block.hazard) {
            block.hazard = {
              ...block.hazard,
              hazard: sanitizeProse(block.hazard.hazard, project),
              consequence: sanitizeProse(block.hazard.consequence, project),
              avoidance: (block.hazard.avoidance || []).map((step) => sanitizeProse(step, project)),
            };
          }
        }
        if (block.type === 'subhead') headings.push(block.text);
        if (block.allowIdentifiers) continue;
        if (block.text) prose.push(block.text);
        if (block.items) prose.push(...block.items.map((item) => (typeof item === 'string' ? item : `${item.action || ''} ${item.expect || ''}`)));
        if (block.rows && block.type !== 'table') continue;
        if (block.type === 'table' && !block.allowIdentifiers) {
          for (const row of block.rows) prose.push(row.join(' '));
        }
      }
    }
  }
  const violations = [...headingViolations(headings, project), ...proseViolations(prose.join('\n'), project)];
  if (violations.length) {
    const err = new Error('headings');
    err.status = 500;
    err.expose = true;
    err.message = 'Manual generation failed because a heading still contained a raw program identifier.';
    err.logMessage = violations.slice(0, 8).join(' | ');
    throw err;
  }
  return doc;
}

function contentFor(spec, ctx) {
  const { project, hazards, subsystems, title } = ctx;
  const id = spec.id;
  if (id === 'product.options' && !/option/i.test(JSON.stringify(project.cad.assemblies))) return null;
  if (id === 'safety.emissions' && !project.spec.soundPressure && !/laser|noise|fume/.test(hazards.map((item) => item.id).join(' '))) return null;
  if (id === 'safety.fire' && !hazards.some((item) => item.id === 'fire.flammable')) return null;
  if (id === 'safety.cyber' && !project.routines.length) return null;
  if (id === 'transport.unpacking' || id === 'install.noise_vibration' || id === 'commission.recommission' || id === 'commission.training' || id === 'ops.cleaning' || id === 'parts.ordering' || id === 'app.warranty') {
    return null;
  }
  if (id === 'ops.setup' && !/recipe|changeover|format/i.test(project.tags.map((tag) => tag.description).join(' '))) return null;
  if (id === 'ops.parameters' && !project.tags.some((tag) => /parameter|setpoint|recipe/i.test(tag.description))) return null;
  if (id === 'maint.adjustment' && !project.routines.length) return null;
  if (id === 'install.controls' && !project.tags.length) return null;
  if (id === 'app.diagrams' && !project.modules.length && !project.cad.layers.length) return null;
  if (id === 'app.io_list' && !project.tags.length) return null;
  if (id === 'app.program_xref' && !project.routines.length) return null;
  if (id === 'product.subsystem_function') return subsystemSections(ctx);

  const builders = {
    'front.revision': () => [table(
      ['Revision', 'Date', 'Description', 'Approved'],
      [[project.identity.revision || 'A', new Date().toISOString().slice(0, 10), `Generated from ${project.sources.map((source) => `${source.name} ${source.sha256}`).join('; ') || 'uploaded files'}`, 'ManualOS']],
      { widths: ['14%', '16%', '50%', '20%'] },
    )],
    'front.about': () => [
      paragraph(`This manual explains how to transport, install, commission, operate, maintain, and decommission the ${title}. It is written for operators, maintenance technicians, and installers.`),
      paragraph('Keep a printed or saved copy with the machine for its whole service life. A digital copy must remain downloadable and printable.'),
      bullets([
        'Read the safety chapter before any other task.',
        'Companion documents you still need to file with this manual: electrical drawings, pneumatic or hydraulic diagrams, the parts catalog, and vendor component manuals.',
        project.acdLimited ? 'The control description is incomplete until you replace the ACD upload with an L5X export. No rung text was invented from the ACD file.' : 'Statements marked Inferred - please confirm were derived from the uploaded engineering files.',
        project.partialExport ? 'This upload did not include routine logic. The manual lists the controller, modules, and tags that were present.' : '',
      ].filter(Boolean)),
    ],
    'front.conventions': () => [
      paragraph('Safety messages follow ANSI Z535.6 and ISO 3864-2. Each message names the hazard, the consequence, and how to avoid it.'),
      table(['Signal word', 'Meaning'], [
        ['DANGER', 'A hazardous situation that will result in death or serious injury if it is not avoided.'],
        ['WARNING', 'A hazardous situation that could result in death or serious injury if it is not avoided.'],
        ['CAUTION', 'A hazardous situation that could result in minor or moderate injury if it is not avoided.'],
        ['NOTICE', 'A practice that can damage the machine or property. It is not about personal injury.'],
      ]),
      paragraph('Numbered steps are actions in order. The line under a step is the expected result. A small grey rung reference points at the program cross-reference appendix. An Inferred - please confirm badge means the statement still needs a person to check it.'),
    ],
    'safety.general': () => [
      bullets([
        'Read this manual before you install, operate, or service the machine.',
        'Only trained and authorized people may operate or service the machine.',
        'Do not run the machine with a guard open, removed, or damaged.',
        'Do not change the machine or its control program without written approval from the manufacturer.',
        'Report damage, unusual noise, or a fault to your supervisor before you continue.',
        'Follow site rules in addition to this manual.',
      ]),
      ...hazardBlocks(hazardsForSection(hazards, 'safety.general').concat(hazards.filter((item) => item.id === 'ctrl.bypass')).slice(0, 2)),
    ],
    'safety.personnel': () => [
      paragraph('Only qualified personnel may operate, set, or maintain this equipment. The owner provides training, PPE, and the site risk assessment.'),
      table(['Role', 'Qualification', 'Permitted tasks'], [
        ['Operator', 'Trained on this machine', 'Start, stop, load material, and do the daily checks'],
        ['Setup technician', 'Operator training plus changeover training', 'Changeover, settings, and setup mode'],
        ['Mechanical maintenance', 'Qualified mechanic with lockout training', 'Mechanical repair, lubrication, and part replacement'],
        ['Electrical maintenance', 'Qualified electrical worker', 'Work inside the electrical cabinet and on drives'],
      ]),
      needs('Add site-specific roles and permissions if they differ from this list.'),
    ],
    'safety.intended_use': () => [
      paragraph(`${title} is industrial equipment. Use it only for the product and limits on the nameplate and in the technical data.`, true),
      paragraph('Any other use is not intended.'),
      needs('Add materials, workpiece size and weight limits, and the temperature, humidity, and atmosphere limits from the specification.'),
    ],
    'safety.misuse': () => [
      paragraph('The following uses are prohibited:'),
      bullets([
        'Defeating, bridging, or removing an interlock, guard, or safety function.',
        'Operating with doors open or with people inside the safeguarded space.',
        'Exceeding the stated capacity, speed, or workpiece limits.',
        'Using unapproved fluids, tools, or attachments.',
        'Use in an explosive atmosphere unless the machine is rated for it.',
        'Climbing on the machine or using it as a work platform or store.',
        'Operation by a person who has not been trained.',
      ]),
    ],
    'safety.danger_zones': () => dangerZones(ctx),
    'safety.devices': () => devicesSection(project),
    'safety.estop': () => estopSection(project),
    'safety.signs': () => [
      paragraph('Fit the labels below. Confirm the part numbers against the machine as built.', true),
      table(['Label', 'Meaning', 'Where to confirm it'], hazards.slice(0, 8).map((hazard) => [
        hazard.signal_word,
        hazard.hazard,
        'On the subsystem named in the theory of operation',
      ])),
      needs('Confirm the actual label part numbers and locations on the machine.'),
    ],
    'safety.ppe': () => ppeSection(hazards),
    'safety.energy_isolation': () => lotoSection(ctx),
    'safety.residual_risks': () => [
      paragraph('These risks remain after the guards and safety functions. Obey each message.'),
      ...hazardBlocks(hazardsForSection(hazards, 'safety.residual_risks').concat(hazards.filter((item) => ['mech.crushing', 'mech.entanglement', 'elec.shock_live'].includes(item.id))).slice(0, 8)),
    ],
    'safety.cyber': () => [
      paragraph('Protect the controller from unauthorized changes. Give each person a unique account. Do not leave remote access open.', true),
      needs('Record the network address, user levels, and the firmware update rule.'),
    ],
    'product.overview': () => overview(ctx),
    'product.layout': () => layoutSection(ctx),
    'product.components': () => componentsSection(ctx),
    'product.sequence': () => sequenceSection(ctx),
    'product.interlocks': () => interlockSection(ctx),
    'product.control_logic': () => controlSection(ctx),
    'product.identification': () => [
      paragraph('The nameplate is on the electrical cabinet unless the general arrangement says otherwise. Quote the model and serial number when you order parts or service.'),
      table(['Field', 'Value'], [
        ['Manufacturer', project.identity.manufacturerName || 'NEEDS INPUT'],
        ['Model', project.identity.model || 'NEEDS INPUT'],
        ['Serial number', 'Write the serial number from the nameplate'],
        ['Supply, full-load current, SCCR', 'NEEDS INPUT'],
        ['Air or hydraulic supply', 'NEEDS INPUT'],
        ['Mass', 'NEEDS INPUT'],
      ]),
    ],
    'transport.lifting': () => [
      paragraph(`Lift ${title} only at the marked points, with gear rated above the mass on the nameplate.`, true),
      ...hazardBlocks(hazardsForSection(hazards, 'transport.lifting').slice(0, 2)),
      needs('Add the mass of each shipping module, the center of gravity, and the lifting points.'),
    ],
    'transport.storage': () => [
      needs('Add the storage temperature and humidity range, preservation method, and the maximum storage time before recommissioning.'),
    ],
    'install.site': () => installSite(ctx),
    'install.mechanical': () => [
      ...hazardBlocks(hazardsForSection(hazards, 'install.mechanical').slice(0, 2)),
      steps([
        { action: 'Place the machine on the prepared foundation in its operating orientation.', expect: 'The frame is supported on all feet and is clear of walkways.' },
        { action: 'Level the machine and anchor it with the specified fasteners.', expect: 'The machine does not rock, and the anchors are tight.' },
        { action: 'Remove the transport locks only after the machine is anchored.', expect: 'Axes and doors can move through their normal travel, and the locks are stored for a later move.' },
      ]),
    ],
    'install.utilities': () => [
      paragraph('Compare the supply with the nameplate before you connect anything.'),
      table(['Utility', 'Requirement'], [
        ['Electrical supply', 'NEEDS INPUT: voltage, phases, frequency, full-load current, and SCCR'],
        ['Protective device', 'NEEDS INPUT: fuse or breaker rating from the electrical design'],
        ['Compressed air or hydraulics', project.tags.some((tag) => /air|pneumatic/i.test(tag.description)) ? 'Connect dry, filtered air at the pressure on the nameplate.' : 'NEEDS INPUT'],
        ['Grounding', 'Connect the protective earth before you switch on.'],
      ]),
      ...hazardBlocks(hazardsForSection(hazards, 'install.utilities').slice(0, 3)),
    ],
    'install.controls': () => [
      paragraph('External control and network connections are listed with the I/O appendix. Confirm the host-line handshake before production.', true),
    ],
    'commission.prestart': () => [
      steps([
        { action: 'Confirm every guard is fitted and closed, and that nobody is inside the safeguarded space.', expect: 'The safeguarded space is empty and every guard is closed.' },
        { action: 'Confirm the supply voltage, phase rotation, and fluid levels against the nameplate.', expect: 'The supplies match the nameplate and motion is in the marked direction.' },
        { action: 'Test each emergency stop and each guard interlock. Record the result.', expect: 'Each device stops motion, and motion does not restart until the device is reset.' },
      ]),
    ],
    'commission.first_start': () => [
      steps([
        { action: 'Switch on the main disconnect.', expect: 'The controller and operator panel power up. The machine does not move.' },
        { action: 'Press Reset, then command the homing or reference sequence if the machine has one.', expect: 'Axes move to their reference positions at the setup speed only.' },
        { action: 'Run a dry cycle with no product, then a short production trial.', expect: 'The automatic cycle completes and the first pieces meet the quality check.' },
      ]),
    ],
    'hmi.controls': () => hmiControls(project),
    'hmi.screens': () => [
      needs('Upload an HMI export or type the screen names, what each screen is for, and the access level required.'),
    ],
    'ops.modes': () => modesSection(ctx),
    'ops.startup': () => [
      ...hazardBlocks(hazardsForSection(hazards, 'ops.startup').slice(0, 1)),
      steps([
        { action: 'Walk the machine and confirm the safeguarded space is clear.', expect: 'Nobody is inside the guards.' },
        { action: 'Switch on the main disconnect and open the energy supplies used in production.', expect: 'The operator panel is on and supplies are at the normal values.' },
        { action: 'Press Reset.', expect: 'The safety circuit resets. The machine does not start by itself.' },
        { action: 'Select the production settings, then press Start.', expect: 'The machine runs. The running indicator comes on.' },
      ]),
    ],
    'ops.normal': () => [
      paragraph(`During production, watch the ${title} from the operator position. Keep material supplied and answer alarms before the machine stops on a fault.`, true),
      bullets((subsystems.length ? subsystems : [{ name: 'the machine', purpose: 'completes its cycle' }]).slice(0, 6).map((item) => `${item.name}: ${item.purpose}`)),
    ],
    'ops.stop': () => [
      table(['Stop', 'What you do', 'How to start again'], [
        ['End of cycle', 'Press the normal stop control.', 'Press Start when you are ready.'],
        ['Guard open', 'Close the guard after the space is clear.', 'Press Reset, then Start.'],
        ['Emergency stop', 'Press a red emergency-stop button.', 'Remove the cause, release the button, press Reset, then Start. Releasing the button never starts the machine.'],
        ['End of shift', 'Stop the cycle, then switch off the supplies you do not leave on.', 'Follow daily start-up on the next shift.'],
      ]),
    ],
    'trouble.alarms': () => alarmSection(project),
    'trouble.table': () => [
      table(['Symptom', 'Probable cause', 'Remedy'], [
        ['The machine will not start and shows no alarm', 'A permissive is missing, or Reset was not pressed.', 'Close the guards, restore air and power, then press Reset.'],
        ['Motion stops as soon as it starts', 'A guard, emergency stop, or sensor is open.', 'Find the device in the alarm list, correct it, and press Reset.'],
        ['Product does not move to the next station', 'A jam, a missing part, or a sensor that does not see the product.', 'Lock out, clear the product, and check the sensor is clean.'],
        ...alarmRows(project).slice(0, 6).map((row) => [row[1], row[3], row[4]]),
      ]),
    ],
    'trouble.emergency': () => [
      paragraph('If a person is trapped, press the nearest emergency stop. Do not enter further until motion has stopped and energy is isolated.'),
      ...hazardBlocks(hazardsForSection(hazards, 'trouble.emergency').slice(0, 2)),
      steps([
        { action: 'Press the nearest emergency stop.', expect: 'Motion stops and drives drop torque or the equivalent safe state.' },
        { action: 'Call for help. Release stored energy only by the method in the lockout section.', expect: 'The person can be freed without a new unexpected motion.' },
        { action: 'Lock out before you clear a jam inside the guards.', expect: 'The machine cannot start while you are inside.' },
      ]),
    ],
    'maint.safety': () => [
      paragraph('Lock out the machine before maintenance. Only the roles in the personnel section may do the work. Refit every guard and test the safety devices before you return the machine to production.'),
      ...hazardBlocks(hazardsForSection(hazards, 'maint.safety').slice(0, 3)),
    ],
    'maint.schedule': () => scheduleSection(ctx),
    'maint.lubrication': () => [
      needs('Add each lubrication point, the lubricant specification, the quantity, and the interval. A bill of materials alone does not name the lubricant.'),
    ],
    'maint.inspection': () => [
      paragraph('Test each safety device at the interval in the maintenance schedule. The device passes only if motion stops and does not restart until the device is reset. Record the result. Take the machine out of service if a test fails.'),
      devicesSection(project).find((block) => block.type === 'table') || needs('Upload the safety I/O list so each device can be named.'),
    ].flat(),
    'maint.procedures': () => [
      ...hazardBlocks(hazardsForSection(hazards, 'maint.procedures').slice(0, 2)),
      steps([
        { action: 'Lock out every energy source.', expect: 'A personal lock is on each isolation point and zero energy is verified.' },
        { action: 'Replace the worn part with the part number from the spare-parts list.', expect: 'The new part is seated and the fasteners are tight.' },
        { action: 'Refit the guards, remove your locks, and test the related motion in setup mode.', expect: 'The function runs and the safety devices still stop the machine.' },
      ]),
    ],
    'parts.list': () => partsSection(project),
    'decom.decommission': () => [
      steps([
        { action: 'Run out product and stop the machine.', expect: 'The process is empty.' },
        { action: 'Lock out and disconnect power, air, hydraulics, and the network.', expect: 'Every supply is isolated and stored energy is released.' },
        { action: 'Fit the transport locks and dismantle in the reverse of the installation order.', expect: 'Each module stays stable while you separate it.' },
      ]),
      ...hazardBlocks(hazardsForSection(hazards, 'decom.decommission').slice(0, 2)),
    ],
    'decom.disposal': () => [
      paragraph('Dispose of the machine under local rules. Separate steel, electrical equipment (WEEE), batteries, oils, and other fluids.', true),
      needs('Add the material breakdown from the CAD bill of materials when material names are available.'),
    ],
    'app.techdata': () => techData(ctx),
    'app.diagrams': () => [
      paragraph('File the electrical, pneumatic, and hydraulic drawings with this manual. The I/O list in the next appendix is the signal index for those drawings.'),
    ],
    'app.io_list': () => [ioTable(project)],
    'app.program_xref': () => [xrefTable(project)],
    'app.compliance': () => [
      needs('Attach the declaration of conformity, or the address where the owner keeps it.'),
      paragraph('The hazards and safeguards in this manual were written against ISO 12100, IEC 60204-1 / NFPA 79, ISO 13850, ISO 14119, and ISO 13849-1 where those topics appear. This list is not a declaration.'),
    ],
    'app.glossary': () => [table(['Term', 'Meaning'], [
      ['E-stop', 'Emergency stop'],
      ['FLA', 'Full-load amperes'],
      ['HMI', 'Human-machine interface, the operator panel'],
      ['LOTO', 'Lockout/tagout'],
      ['PLC', 'Programmable logic controller'],
      ['SCCR', 'Short-circuit current rating'],
      ['STO', 'Safe torque off, a drive function that removes motor torque'],
    ])],
    'app.index': () => [paragraph('Use the contents list at the front of the manual. Each chapter heading and section heading is indexed there.')],
  };
  const builder = builders[id];
  if (!builder) return [needs(spec.prompt_guidance)];
  const blocks = builder();
  if (!spec.required) return blocks;
  if (!blocks || !blocks.length) return [needs(spec.prompt_guidance)];
  return blocks;
}

function installSite(ctx) {
  const box = ctx.project.cad.boundingBox;
  const dims = box
    ? box.min.map((value, index) => Math.round((box.max[index] - value) * 1000) / 1000).join(' × ')
    : '';
  return [
    paragraph(`Prepare a level foundation that can carry ${ctx.title} and the dynamic loads of its motion.`, true),
    table(['Item', 'Requirement'], [
      ['Floor', 'Level, load-bearing, and clear of other equipment by the service access on the general arrangement.'],
      ['Footprint', dims || 'NEEDS INPUT: overall length, width, and height'],
      ['Service access', 'Leave space to open every door and to remove the longest part.'],
      ['Environment', 'NEEDS INPUT: temperature, humidity, and atmosphere limits'],
    ], { inferred: Boolean(dims) }),
    needs('Add the foundation drawing, the anchor pattern, and the required floor loading.'),
  ];
}

function dangerZones(ctx) {
  if (!ctx.subsystems.length && !ctx.project.cad.boundingBox) {
    return [needs('Upload a CAD assembly, or describe the operator positions and danger zones, so this section can name them.')];
  }
  const blocks = [paragraph(`Stay outside the guarded space during automatic operation. Work on ${ctx.title} only from the operator position unless you have selected setup mode and the procedure allows entry.`, true)];
  const svg = layoutSvg(ctx.subsystems);
  if (svg) {
    blocks.push({
      type: 'figure',
      svg,
      caption: 'Plan view inferred from the uploaded assembly and control functions. Confirm the guard line and the operator position on the machine.',
      callouts: ctx.subsystems.slice(0, 6).map((item, index) => `${index + 1} ${item.name}`),
      inferred: true,
    });
  }
  return blocks;
}

function devicesSection(project) {
  const devices = safetyDevices(project);
  const blocks = [];
  if (project.safetyPrograms.length || project.safetyTasks.length) {
    const safetyNames = [...project.safetyPrograms, ...project.safetyTasks].map((name) => humanize(name)).filter(Boolean);
    blocks.push(paragraph(`A safety task is present${safetyNames.length ? ` (${safetyNames.join(', ')})` : ''}. Treat that logic as a safety function. This manual does not authorise a change to it.`));
  }
  if (!devices.length && !blocks.length) {
    return [needs('Upload the safety I/O list (emergency stops, door interlocks, light curtains, enabling devices, and safe torque off) so each device can be named.')];
  }
  if (!devices.length) return blocks;
  blocks.push(table(
    ['Device', 'What it does', 'How to test', 'Interval'],
    devices.slice(0, 24).map((tag) => [
      tag.description || humanize(tag.name) || 'Safety device',
      /estop|e-stop|emergency/i.test(`${tag.description} ${tag.name}`) ? 'Stops motion. Reset does not restart the machine.' : 'Prevents motion while the device is open or interrupted.',
      'Operate the device and confirm motion stops and stays stopped until Reset.',
      'Daily',
    ]),
    { inferred: true },
  ));
  return blocks;
}

function estopSection(project) {
  const stops = project.tags.filter((tag) => /e-?stop|emergency stop/i.test(`${tag.description} ${tag.name}`));
  const blocks = [
    paragraph('Press any red emergency-stop button to stop the machine. Resetting or releasing the button never starts the machine by itself.'),
    steps([
      { action: 'Press the nearest emergency-stop button.', expect: 'Hazardous motion stops. Drives go to the safe state described for this machine.' },
      { action: 'Remove the cause.', expect: 'The area is safe to reset.' },
      { action: 'Release the emergency-stop button, press Reset, then press Start only when everyone is clear.', expect: 'The machine starts only after Start. It does not start when the button is released.' },
    ]),
  ];
  if (!stops.length) blocks.push(needs('Name each emergency-stop location. The upload did not identify emergency-stop devices.'));
  return blocks;
}

function ppeSection(hazards) {
  const tasks = [
    ['Production', 'Safety glasses', '—', '—', 'Safety shoes', 'Hearing protection if the declared noise exceeds 80 dB(A)'],
    ['Lockout and electrical work', 'Face shield when required', '—', 'Voltage-rated gloves', 'Safety shoes', 'Arc-rated clothing when the label requires it'],
    ['Mechanical maintenance', 'Safety glasses', '—', 'As the task requires', 'Safety shoes', '—'],
  ];
  return [
    table(['Task', 'Eyes', 'Hearing', 'Hands', 'Feet', 'Other'], tasks),
    ...hazardBlocks(hazardsForSection(hazards, 'safety.ppe').slice(0, 2)),
  ];
}

function lotoSection(ctx) {
  const { hazards, project } = ctx;
  const rows = [['Electrical supply', 'Main disconnect', 'Wait for drives to discharge, then test for absence of voltage', 'Attempt to start, then measure']];
  if (project.tags.some((tag) => /air|pneumatic|valve/i.test(`${tag.description} ${tag.name}`)) || ctx.subsystems.some((item) => /air|pneumatic|valve|cylinder/i.test(item.name))) {
    rows.push(['Compressed air', 'Lockable air isolation and dump', 'Exhaust residual air and support loads held by cylinders', 'Gauge reads zero']);
  }
  if (hazards.some((item) => item.id === 'fluid.hydraulic_pressure')) {
    rows.push(['Hydraulic pressure', 'Pump isolation and accumulator dump', 'Depressurize and confirm the gauge', 'Gauge reads zero']);
  }
  rows.push(['Gravity or springs', 'Mechanical block', 'Lower or block the load before you release a brake', 'The load cannot move']);
  return [
    paragraph('Lock out every energy source before you enter the guarded space, clean inside the guards, or replace a part.'),
    table(['Energy', 'Isolation point', 'Release stored energy', 'Verify zero energy'], rows, { inferred: true }),
    ...hazardBlocks(hazardsForSection(hazards, 'safety.energy_isolation').slice(0, 2)),
    steps([
      { action: 'Tell affected people that the machine will be shut down and locked out.', expect: 'Affected people know not to try to start the machine.' },
      { action: 'Stop the machine with the normal stop control.', expect: 'The cycle is stopped.' },
      { action: 'Switch off and lock each isolation point in the table.', expect: 'Your personal lock and tag are on every point.' },
      { action: 'Release or block stored energy, including the capacitor discharge wait.', expect: 'Gauges read zero and vertical loads are blocked.' },
      { action: 'Verify zero energy. Try the start control and measure voltage where the table says to measure.', expect: 'The machine does not respond and electrical tests show absence of voltage.' },
      { action: 'Do the work.', expect: 'The task is complete and tools are removed.' },
      { action: 'Refit guards, confirm people are clear, remove locks, and tell affected people.', expect: 'The machine can be started only by the normal start procedure.' },
    ]),
  ];
}

function overview(ctx) {
  const { subsystems, title, project } = ctx;
  if (!subsystems.length && !hasPlc(project)) {
    return [needs('Upload the PLC program, a CAD assembly, or a specification that says what the machine does.')];
  }
  const stages = subsystems.map((item) => item.name).join(', ');
  return [
    paragraph(`${title} carries the product through these stages: ${stages || 'the functions found in the control program'}.`, true),
    paragraph('The description below is how the equipment behaves. Program names are not used here. Confirm each inferred sentence against the machine.', true),
  ];
}

function layoutSection(ctx) {
  if (!ctx.subsystems.length) return [needs('Upload a CAD assembly or a PLC program so the product flow can be drawn.')];
  return dangerZones(ctx);
}

function componentsSection(ctx) {
  if (!ctx.subsystems.length) return [needs('Upload the top-level CAD assembly or the PLC program so each assembly can be named by its function.')];
  return [table(
    ['Item', 'Assembly', 'Function'],
    ctx.subsystems.map((item, index) => [String(index + 1), item.name, item.purpose]),
    { inferred: true },
  )];
}

function subsystemSections(ctx) {
  if (!ctx.subsystems.length) {
    return [{ title: 'Subsystem function', blocks: [needs('Upload a PLC program or a CAD assembly. Each subsystem is then described by what it does, how it moves, its sensors, and its interlocks.')] }];
  }
  return ctx.subsystems.map((item) => {
    const localHazards = hazardsForSubsystem(ctx.hazards, item).slice(0, 3);
    return {
      title: item.name,
      blocks: [
        paragraph(item.purpose, true),
        {
          type: 'table',
          className: 'fact',
          headers: ['', ''],
          rows: [
            ['Main components', item.components.join('; ') || 'NEEDS INPUT: name the motors, cylinders, and guides.'],
            ['How it moves', item.motions.join(' ') || item.groups[0]?.text || 'NEEDS INPUT: describe the motion.'],
            ['Sensors', item.sensors.join('; ') || 'NEEDS INPUT: name what each sensor tells the control.'],
            ['Interlocks', item.interlocks.join(' ') || 'See Interlocks, permissives and machine states.'],
            ['Operator', 'Load, watch, and clear this station from outside the guards unless a procedure says otherwise.'],
            ['Program reference', item.groups.map((group) => group.ref).filter(Boolean).join('; ') || 'No PLC rungs were linked to this subsystem.'],
          ],
          inferred: true,
        },
        ...item.groups.slice(0, 4).map((group) => paragraph(`${group.text} ${group.ref ? `(${group.ref})` : ''}`, true)),
        ...hazardBlocks(localHazards, item.name),
      ],
    };
  });
}

function sequenceSection(ctx) {
  if (!ctx.subsystems.length) return [needs('Upload the PLC main sequence or a CAD assembly so the cycle can be written in product-flow order.')];
  const items = [
    { action: 'Start the machine only after the pre-start checks pass.', expect: 'The machine is ready and the safeguarded space is clear.' },
    ...ctx.subsystems.map((item) => ({
      action: `${item.name}: ${item.purpose}`,
      expect: `The product is handed to the next station, or this station has finished its part of the cycle.`,
      inferred: true,
    })),
    { action: 'Stop with the normal stop at the end of the cycle, or with an emergency stop if someone is at risk.', expect: 'Motion stops. An emergency-stop reset does not restart the machine.' },
  ];
  return [paragraph('Follow the cycle from the product’s point of view.', true), steps(items)];
}

function interlockSection(ctx) {
  const rows = [];
  for (const tag of ctx.project.tags) {
    if (!/door|guard|air|pressure|reset|safety|e-?stop|ready/i.test(`${tag.description} ${tag.name}`)) continue;
    const name = tag.description || humanize(tag.name);
    if (!name) continue;
    rows.push([name, 'Prevents a start or stops motion while the condition is not met.', 'All motion', 'Correct the condition, then press Reset.']);
  }
  if (!rows.length) {
    return [needs('Upload the PLC program so start permissives, station interlocks, and machine states can be listed in plain language.')];
  }
  return [table(['Condition', 'Prevents or allows', 'Subsystems', 'How to clear'], rows.slice(0, 16), { inferred: true })];
}

function controlSection(ctx) {
  const groups = allGroups(ctx.project);
  if (!groups.length) {
    return [needs('Upload the PLC program to generate this section.')];
  }
  const rank = (group) => {
    const text = `${group.title} ${group.text}`.toLowerCase();
    if (/start|stop|mode|permissive/.test(text)) return 0;
    if (/alarm|fault/.test(text)) return 2;
    return 1;
  };
  const ordered = [...groups].sort((a, b) => rank(a) - rank(b));
  return ordered.map((group) => ({
    type: 'group',
    title: group.title || group.routineTitle || 'Machine function',
    ref: group.ref,
    text: `${group.safety ? 'Safety function. Only a qualified safety engineer may change it. ' : ''}${group.text}`,
    inferred: group.inferred !== false,
  }));
}

function hmiControls(project) {
  const devices = controlDevices(project);
  if (!devices.length) return [needs('Upload an I/O list whose descriptions name each pushbutton, selector, and indicator.')];
  return [table(
    ['Control', 'Type', 'Function'],
    devices.slice(0, 30).map((tag) => [tag.description || humanize(tag.name), /lamp|indicator|light/i.test(tag.description) ? 'Indicator' : 'Operator control', tag.description || 'See the description']),
    { inferred: true },
  )];
}

function modesSection(ctx) {
  const blob = ctx.project.tags.map((tag) => `${tag.description} ${tag.name}`).join(' ').toLowerCase();
  const rows = [['Automatic', 'Select automatic and close every guard.', 'Production runs with the safeguards active.']];
  if (/setup|manual|jog|teach/.test(blob)) {
    rows.push(['Setup', 'Select setup.', 'Motion is held-to-run and limited. Do not leave anyone else in the zone.']);
  }
  return [
    table(['Mode', 'How to select it', 'What the machine does'], rows, { inferred: true }),
    ...hazardBlocks(ctx.hazards.filter((item) => item.id === 'ctrl.manual_mode').slice(0, 1)),
  ];
}

function alarmSection(project) {
  const rows = alarmRows(project);
  if (!rows.length) return [needs('Upload the PLC alarm list so each message can show its cause and remedy.')];
  return [
    paragraph('Correct the cause, then press Reset. Reset does not start the machine.'),
    table(['Code', 'Message', 'Class', 'Probable cause', 'Remedy'], rows.slice(0, 40), { small: true, inferred: true }),
  ];
}

function scheduleSection(ctx) {
  const rows = [
    ['Daily', 'Safety devices', 'Test each emergency stop and guard interlock.', 'Operator'],
    ['Daily', 'Work area', 'Remove product scrap. Do not use compressed air on dust.', 'Operator'],
    ['Weekly', 'Filters and sensors', 'Drain filters and clean sensor faces.', 'Maintenance'],
  ];
  for (const part of ctx.project.cad.bom.slice(0, 8)) {
    if (/belt|filter|cup|seal|nozzle/i.test(part.description)) {
      rows.push(['Monthly or 500 h', part.description, 'Inspect and replace if worn.', 'Maintenance']);
    }
  }
  return [
    table(['Interval', 'Component', 'Task', 'Who'], rows, { inferred: true }),
    needs('Replace the inferred intervals with the vendor intervals for purchased parts.'),
  ];
}

function partsSection(project) {
  const rows = project.cad.bom.slice(0, 40).map((part) => [String(part.item), part.partNumber || 'NEEDS INPUT', part.description, String(part.qty || 1)]);
  const seen = new Set();
  for (const moduleNode of project.modules) {
    const part = moduleNode.catalog || '';
    if (!part || seen.has(part)) continue;
    seen.add(part);
    rows.push([String(rows.length + 1), part, moduleNode.description || moduleNode.name, '1']);
    if (rows.length >= 48) break;
  }
  if (!rows.length) return [needs('Upload a CAD bill of materials or a controller export with module catalog numbers.')];
  const blocks = [table(['Item', 'Part', 'Description', 'Qty'], rows)];
  if (project.cad.bom.length > 40) blocks.push(paragraph(`The model contains ${project.cad.bom.length} parts. The table shows the first 40. Confirm descriptions for every part that is named only by a part number.`, true));
  if (project.modules.length > seen.size) blocks.push(paragraph(`The controller export lists ${project.modules.length} modules. The table shows the distinct catalog numbers.`, true));
  return blocks;
}

function techData(ctx) {
  const box = ctx.project.cad.boundingBox;
  const dims = box ? box.min.map((value, index) => Math.round((box.max[index] - value) * 1000) / 1000).join(' × ') : 'NEEDS INPUT';
  return [table(['Parameter', 'Value'], [
    ['Equipment', ctx.title],
    ['Model', ctx.project.identity.model || 'NEEDS INPUT'],
    ['Overall size from the CAD model', dims],
    ['Model units', ctx.project.cad.lengthUnit || 'NEEDS INPUT'],
    ['Solid bodies in the CAD model', ctx.project.cad.bodyCount ? String(ctx.project.cad.bodyCount) : 'NEEDS INPUT'],
    ['Mass', 'NEEDS INPUT'],
    ['Electrical supply', 'NEEDS INPUT'],
    ['Pneumatic or hydraulic supply', 'NEEDS INPUT'],
    ['Noise at the workstation', ctx.project.spec.soundPressure ? `${ctx.project.spec.soundPressure} dB(A)` : 'NEEDS INPUT'],
    ['Ambient limits', 'NEEDS INPUT'],
  ], { inferred: Boolean(box) })];
}

function ioTable(project) {
  const rows = project.tags.map((tag) => [
    tag.address || '—',
    tag.description || humanize(tag.name) || '—',
    tag.device || tag.dataType || '—',
    tag.name,
  ]);
  return table(['Address', 'Description', 'Device', 'Tag'], rows, {
    small: true,
    allowIdentifiers: true,
    widths: ['18%', '40%', '22%', '20%'],
  });
}

function xrefTable(project) {
  const rows = [];
  for (const routine of project.routines) {
    const analysis = routine.analysis || { groups: [], housekeeping: [] };
    for (const group of analysis.groups) {
      rows.push([routine.scopeKey || routine.name, group.ref || '—', routine.aoi ? 'Instruction definition' : 'Theory of operation', group.title]);
    }
    if (analysis.housekeeping.length) {
      const numbers = analysis.housekeeping.map((index) => {
        const unit = routine.units.find((item) => item.index === index);
        return unit ? unit.number : index;
      });
      rows.push([routine.scopeKey || routine.name, `Rungs ${numbers.join(', ')}`, 'Housekeeping', 'Spare or unused logic']);
    }
    if (!routine.units.length) {
      rows.push([
        routine.scopeKey || routine.name,
        '—',
        routine.language === 'acd' ? 'Not readable in ACD' : 'Empty routine',
        routine.language === 'acd' ? 'Export L5X to include the logic' : 'The export contains no logic for this routine',
      ]);
    }
  }
  const coverage = project.coverage || { accounted: 0, units: 0 };
  rows.push(['Total', `${coverage.accounted} of ${coverage.units}`, '', '']);
  return table(['Routine', 'Rungs', 'Described in', 'Function group'], rows, { small: true, allowIdentifiers: true });
}

module.exports = {
  buildDocument,
  productTitle,
  sectionById,
};
