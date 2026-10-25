const { parseXml, child, attr, textOf } = require('./xml');
const { addRoutine, upsertTag } = require('../project');

function descriptionOf(node) {
  if (!node || typeof node !== 'object') return '';
  const fromAttr = attr(node, 'Description');
  if (fromAttr) return fromAttr;
  const blocks = child(node, 'Description');
  return blocks.map(textOf).join(' ').trim();
}

function lineUnit(line, index) {
  const raw = textOf(line);
  const comment = ((raw.match(/\/\/\s*(.+)$/) || [])[1] || '').trim();
  const code = raw.replace(/\/\/.*$/, '').trim();
  return {
    index,
    number: Number(attr(line, 'Number') || index),
    kind: 'statement',
    text: code,
    comment,
  };
}

function unitsFromRoutine(routine) {
  const units = [];
  const rungs = [
    ...child(routine, 'Rung'),
    ...child(routine.RLLContent, 'Rung'),
  ];
  rungs.forEach((rung, index) => {
    const numberRaw = attr(rung, 'Number');
    const number = numberRaw === '' ? index : Number(numberRaw);
    units.push({
      index,
      number: Number.isFinite(number) ? number : index,
      kind: 'rung',
      text: textOf(child(rung, 'Text')[0] || rung.Text || ''),
      comment: textOf(child(rung, 'Comment')[0] || rung.Comment || ''),
    });
  });
  if (!units.length && routine.FBDContent) {
    child(routine.FBDContent, 'Sheet').forEach((sheet, index) => {
      const blocks = child(sheet, 'Block').map((block) => {
        const type = attr(block, 'Type');
        const operand = attr(block, 'Operand');
        return [type, operand].filter(Boolean).join(' ');
      });
      const inputs = child(sheet, 'IRef').map((node) => attr(node, 'Operand')).filter(Boolean);
      const outputs = child(sheet, 'ORef').map((node) => attr(node, 'Operand')).filter(Boolean);
      const note = child(sheet, 'TextBox').map((node) => textOf(node)).filter(Boolean).join(' ');
      const summary = [
        `Function-block sheet ${attr(sheet, 'Number') || index + 1} combines its inputs and writes the result.`,
        inputs.length ? 'Inputs are read from the connected points.' : '',
        outputs.length ? 'The sheet writes the connected outputs.' : '',
        note,
      ].filter(Boolean).join(' ');
      units.push({
        index,
        number: Number(attr(sheet, 'Number') || index),
        kind: 'network',
        text: blocks.join('; '),
        comment: note,
        summary: summary || 'This function-block sheet combines its inputs and writes the result.',
      });
    });
  }
  if (!units.length && routine.SFCContent) {
    const nodes = [
      ...child(routine.SFCContent, 'Step').map((node) => ({ node, kind: 'step' })),
      ...child(routine.SFCContent, 'Transition').map((node) => ({ node, kind: 'transition' })),
      ...child(routine.SFCContent, 'Stop').map((node) => ({ node, kind: 'step' })),
    ];
    nodes.forEach(({ node, kind }, index) => {
      const operand = attr(node, 'Operand');
      const condition = textOf(node.Condition || node);
      units.push({
        index,
        number: index,
        kind,
        text: condition || operand,
        comment: operand,
        summary: kind === 'transition'
          ? 'The sequence advances when the transition condition is true.'
          : 'The sequence holds this step until the following transition is true.',
      });
    });
  }
  if (!units.length) {
    const lines = [...child(routine, 'Line'), ...child(routine.STContent, 'Line')];
    lines.forEach((line, index) => units.push(lineUnit(line, index)));
  }
  return units.map((unit, index) => ({ ...unit, index, number: Number.isFinite(unit.number) ? unit.number : index }));
}

function memberNotes(tag) {
  const notes = [];
  for (const comment of child(tag.Comments, 'Comment')) {
    const text = textOf(comment).replace(/\s+/g, ' ').trim();
    if (text && !notes.some((item) => item.toLowerCase() === text.toLowerCase())) notes.push(text);
  }
  return notes;
}

function descriptionFromNotes(notes) {
  const cleaned = [];
  for (const note of notes) {
    const text = note.replace(/\s+-\s+.*$/, '').trim();
    if (!text || cleaned.some((item) => item.toLowerCase() === text.toLowerCase())) continue;
    cleaned.push(text);
  }
  return cleaned.length === 1 ? cleaned[0] : '';
}

function addScope(project, scopeNode, scopeName, { aoi = false, safety = false } = {}) {
  if (!project.programs.includes(scopeName)) project.programs.push(scopeName);
  const tagNodes = [
    ...child(scopeNode.Tags, 'Tag'),
    ...child(scopeNode, 'Tag'),
    ...child(scopeNode.Parameters, 'Parameter'),
    ...child(scopeNode.LocalTags, 'LocalTag'),
    ...child(scopeNode.LocalTags, 'Tag'),
  ];
  for (const tag of tagNodes) {
    const notes = memberNotes(tag);
    const described = descriptionOf(tag);
    upsertTag(project, {
      name: attr(tag, 'Name'),
      dataType: attr(tag, 'DataType'),
      description: described || descriptionFromNotes(notes),
      notes,
      address: attr(tag, 'AliasFor') || '',
      aliasFor: attr(tag, 'AliasFor') || '',
      scope: scopeName,
    });
  }
  for (const routineNode of child(scopeNode.Routines, 'Routine').concat(child(scopeNode, 'Routine'))) {
    const routineName = attr(routineNode, 'Name');
    addRoutine(project, {
      name: routineName,
      type: attr(routineNode, 'Type') || 'RLL',
      program: scopeName,
      scopeKey: `${scopeName}/${routineName}`,
      comment: descriptionOf(routineNode),
      units: unitsFromRoutine(routineNode),
      language: 'l5x',
      aoi,
      safety,
    });
  }
}

function parseL5x(project, xml) {
  const tree = parseXml(xml);
  const controllers = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.Controller) controllers.push(...[].concat(node.Controller));
    if (node['RSLogix5000Content']) visit(node['RSLogix5000Content']);
  };
  visit(tree);
  const controller = controllers[0] || tree.Controller;
  if (!controller) {
    const err = new Error('no controller');
    err.expose = true;
    err.status = 422;
    err.message = 'This .l5x file does not contain a controller. Export the full project as .l5x.';
    throw err;
  }
  project.controller = project.controller || attr(controller, 'Name');
  for (const task of child(controller.Tasks, 'Task').concat(child(controller, 'Task'))) {
    const taskClass = attr(task, 'Class');
    const taskRecord = {
      name: attr(task, 'Name'),
      type: attr(task, 'Type'),
      period: attr(task, 'Rate') || attr(task, 'Period'),
      priority: attr(task, 'Priority'),
      watchdog: attr(task, 'Watchdog'),
      className: taskClass,
      safety: /safety/i.test(taskClass),
    };
    project.tasks.push(taskRecord);
    if (taskRecord.safety) project.safetyTasks.push(taskRecord.name);
  }
  const programs = child(controller.Programs, 'Program').concat(child(controller, 'Program'));
  for (const program of programs) {
    const programName = attr(program, 'Name') || 'Program';
    const safety = /safety/i.test(attr(program, 'Class'));
    if (safety) project.safetyPrograms.push(programName);
    addScope(project, program, programName, { safety });
  }
  for (const aoi of child(controller.AddOnInstructionDefinitions, 'AddOnInstructionDefinition')) {
    const name = attr(aoi, 'Name') || 'Instruction';
    project.aois.push({ name, description: descriptionOf(aoi) });
    addScope(project, aoi, name, { aoi: true });
  }
  for (const tag of child(controller.Tags, 'Tag')) {
    const notes = memberNotes(tag);
    const described = descriptionOf(tag);
    upsertTag(project, {
      name: attr(tag, 'Name'),
      dataType: attr(tag, 'DataType'),
      description: described || descriptionFromNotes(notes),
      notes,
      address: attr(tag, 'AliasFor') || '',
      aliasFor: attr(tag, 'AliasFor') || '',
      scope: 'controller',
    });
  }
  for (const tag of project.tags) {
    if (!tag.aliasFor || tag.description) continue;
    const baseName = tag.aliasFor.split('.')[0];
    const base = project.tags.find((item) => item.name.toLowerCase() === baseName.toLowerCase());
    if (base && base.description) tag.description = base.description;
  }
  if (project.programs.length && !project.routines.some((routine) => routine.units.length)) {
    project.partialExport = true;
    project.warnings.push('This export has no routine logic. Upload the full controller export, or the program export that contains the routines, for the theory of operation.');
  }
  for (const moduleNode of child(controller.Modules, 'Module').concat(child(controller, 'Module'))) {
    project.modules.push({
      name: attr(moduleNode, 'Name'),
      catalog: attr(moduleNode, 'CatalogNumber'),
      vendor: attr(moduleNode, 'Vendor'),
      description: descriptionOf(moduleNode),
    });
  }
  return project;
}

module.exports = { parseL5x };
