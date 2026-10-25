const MNEMONICS = new Set([
  'A', 'AN', 'O', 'ON', 'X', 'XN', 'LD', 'LDN', 'LDNI', 'ANB', 'ORB', 'ALD', 'OLD',
  'A(', 'O(', ')',
  '=', 'S', 'R', 'L', 'T', 'JU', 'JC', 'JCN', 'JNB', 'JBI', 'JCB', 'CALL',
  'NOP', 'SET', 'CLR', 'NOT', 'SAVE', 'FP', 'FN', 'SD', 'SE', 'SS', 'SF', 'SP',
  'CU', 'CD', 'TON', 'TOF', 'CTU', 'CTD', 'EU', 'ED', 'SI', 'SV', 'TA', 'TAW',
  'MOV', 'MOVW', 'MOVB', 'MOVD',
]);

const SKIP_LINE = /^(?:TITLE|NETWORK|BEGIN|END_VAR|END_STRUCT|VAR|VAR_TEMP|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|STRUCT|VERSION|AUTHOR|FAMILY|NAME|END_ORGANIZATION_BLOCK|END_FUNCTION_BLOCK|END_FUNCTION|END_DATA_BLOCK|END_PROGRAM|ORGANIZATION_BLOCK|FUNCTION_BLOCK|FUNCTION|DATA_BLOCK|PROGRAM)\b/i;

function looksLikeAwl(text) {
  const source = String(text || '');
  if (!/^\s*NETWORK\b/im.test(source) && !/^\s*Network\s+\d+\b/m.test(source)) return false;
  return source.split(/\r?\n/).some((line) => {
    const instruction = parseLine(line);
    return Boolean(instruction && instruction.mnemonic !== ')' && !instruction.mnemonic.endsWith('('));
  });
}

function cleanOperand(operand) {
  return String(operand || '')
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/\/\/.*$/, '')
    .replace(/"/g, '')
    .replace(/^#/, '')
    .trim();
}

function signalName(operand) {
  const raw = cleanOperand(operand).split(',')[0].replace(/\s+/g, '');
  if (!raw) return 'the signal';
  const io = raw.match(/^([IQM])(\d+(?:\.\d+)?)$/i);
  if (io) {
    const kind = { I: 'input', Q: 'output', M: 'memory' }[io[1].toUpperCase()];
    return `${kind} ${io[2]}`;
  }
  const timer = raw.match(/^T(\d+)$/i);
  if (timer) return `timer ${timer[1]}`;
  const counter = raw.match(/^C(\d+)$/i);
  if (counter) return `counter ${counter[1]}`;
  const words = raw
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .split(/\s+/)
    .filter((word) => /^[A-Za-z]{2,}$/.test(word))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return words.join(' ') || 'the signal';
}

function timePhrase(raw) {
  const match = String(raw || '').replace(/\s+/g, '').match(/S5T#(\d+)(MS|S|M|H)/i);
  if (!match) return '';
  const unit = { MS: 'milliseconds', S: 'seconds', M: 'minutes', H: 'hours' }[match[2].toUpperCase()];
  return `${match[1]} ${unit}`;
}

function parseLine(line) {
  const code = String(line || '').replace(/\/\/.*$/, '').replace(/\(\*[\s\S]*?\*\)/g, '').trim();
  if (!code || SKIP_LINE.test(code)) return null;
  if (/^[AO]\($/i.test(code)) return { mnemonic: `${code[0].toUpperCase()}(`, operand: '' };
  if (code === ')') return { mnemonic: ')', operand: '' };
  const match = code.match(/^([A-Za-z]+|=)\s*(.*)$/);
  if (!match) return null;
  const mnemonic = match[1] === '=' ? '=' : match[1].toUpperCase();
  if (!MNEMONICS.has(mnemonic)) return null;
  if (/:=/.test(match[2] || '')) return null;
  return { mnemonic, operand: (match[2] || '').trim() };
}

function leaf(op, name) {
  return { op, name };
}

function joinExpr(op, left, right) {
  if (!left) return right;
  if (!right) return left;
  return { op, left, right };
}

function renderExpr(node) {
  if (!node) return '';
  if (node.op === 'on') return `${node.name} is on`;
  if (node.op === 'off') return `${node.name} is off`;
  const left = renderExpr(node.left);
  const right = renderExpr(node.right);
  const wrap = (child, text) => (
    child && (child.op === 'and' || child.op === 'or') && child.op !== node.op ? `(${text})` : text
  );
  return `${wrap(node.left, left)} ${node.op} ${wrap(node.right, right)}`;
}

function describeInstructions(instructions) {
  let expr = null;
  const stack = [];
  const results = [];
  let pendingLoad = '';
  const bit = (mnemonic, operand) => (mnemonic.endsWith('N') ? leaf('off', signalName(operand)) : leaf('on', signalName(operand)));
  for (const instruction of instructions) {
    const mnemonic = instruction.mnemonic;
    const name = signalName(instruction.operand);
    if (mnemonic === 'A(' || mnemonic === 'O(') {
      stack.push({ combine: mnemonic === 'A(' ? 'and' : 'or', expr });
      expr = null;
      continue;
    }
    if (mnemonic === ')') {
      const frame = stack.pop();
      if (!frame) continue;
      expr = joinExpr(frame.combine, frame.expr, expr);
      continue;
    }
    if (mnemonic === 'LD' || mnemonic === 'LDN') {
      if (expr) stack.push({ expr });
      expr = bit(mnemonic, instruction.operand);
      continue;
    }
    if (mnemonic === 'ALD' || mnemonic === 'OLD') {
      const frame = stack.pop();
      if (frame && frame.expr) expr = joinExpr(mnemonic === 'ALD' ? 'and' : 'or', frame.expr, expr);
      continue;
    }
    if (mnemonic === 'A' || mnemonic === 'AN' || mnemonic === 'O' || mnemonic === 'ON' || mnemonic === 'X' || mnemonic === 'XN') {
      const term = bit(mnemonic, instruction.operand);
      const op = mnemonic === 'O' || mnemonic === 'ON' || mnemonic === 'X' || mnemonic === 'XN' ? 'or' : 'and';
      expr = joinExpr(op, expr, term);
      continue;
    }
    if (mnemonic === 'L') {
      pendingLoad = timePhrase(instruction.operand) || cleanOperand(instruction.operand);
      continue;
    }
    if (mnemonic === 'NOP') continue;
    if (mnemonic === '=') results.push(`turns on ${name}`);
    else if (mnemonic === 'S') results.push(`sets ${name}`);
    else if (mnemonic === 'R') results.push(`resets ${name}`);
    else if (['SD', 'SE', 'SS', 'SF', 'SP'].includes(mnemonic)) {
      results.push(pendingLoad ? `starts ${name} for ${pendingLoad}` : `starts ${name}`);
      pendingLoad = '';
    } else if (mnemonic === 'TON' || mnemonic === 'TOF') {
      const preset = cleanOperand(instruction.operand).split(',')[1];
      results.push(preset ? `runs ${name} with a preset of ${preset.trim()}` : `runs ${name}`);
    } else if (mnemonic === 'CU' || mnemonic === 'CTU') results.push(`counts up with ${name}`);
    else if (mnemonic === 'CD' || mnemonic === 'CTD') results.push(`counts down with ${name}`);
    else if (mnemonic === 'CALL') results.push(`calls ${name}`);
    else if (mnemonic === 'FP' || mnemonic === 'EU') results.push(`uses the rising edge of ${name}`);
    else if (mnemonic === 'FN' || mnemonic === 'ED') results.push(`uses the falling edge of ${name}`);
    else if (mnemonic === 'JU' || mnemonic === 'JC' || mnemonic === 'JCN') results.push(`jumps to ${name}`);
    else if (mnemonic === 'T' || mnemonic.startsWith('MOV')) results.push(`copies a value into ${name}`);
    else results.push(`applies ${mnemonic} to ${name}`);
  }
  const condition = renderExpr(expr);
  let summary = '';
  if (condition && results.length) summary = `When ${condition}, the control ${results.join(' and ')}.`;
  else if (results.length) summary = `The control ${results.join(' and ')}.`;
  else if (condition) summary = `This network checks that ${condition}.`;
  else summary = 'This network has no instructions.';
  return summary;
}

function networkHeading(line) {
  if (/^\s*NETWORK\b/i.test(line)) {
    const title = (line.match(/TITLE\s*=\s*(.+)$/i) || [])[1] || '';
    return { title: title.trim(), number: null };
  }
  const numbered = line.match(/^\s*Network\s+(\d+)\b(.*)$/);
  if (!numbered) return null;
  const rest = numbered[2] || '';
  const title = ((rest.match(/TITLE\s*=\s*(.+)$/i) || rest.match(/\/\/\s*(.+)$/) || [])[1] || '').trim();
  return { title, number: Number(numbered[1]) };
}

function networksOf(source) {
  const lines = String(source || '').split(/\r?\n/);
  const chunks = [];
  let current = null;
  const push = () => {
    if (current) chunks.push(current);
  };
  for (const line of lines) {
    const heading = networkHeading(line);
    if (heading) {
      push();
      current = { title: heading.title, number: heading.number, lines: [] };
      continue;
    }
    if (!current) continue;
    const title = line.match(/^\s*TITLE\s*=\s*(.+)$/i);
    if (title && !current.title) {
      current.title = title[1].trim();
      continue;
    }
    current.lines.push(line);
  }
  push();
  return chunks.map((chunk, index) => {
    const instructions = chunk.lines.map(parseLine).filter(Boolean);
    const summary = describeInstructions(instructions);
    const comment = chunk.title && chunk.title.length >= 8 ? chunk.title : '';
    return {
      index,
      number: Number.isFinite(chunk.number) ? chunk.number : index + 1,
      kind: 'network',
      text: chunk.lines.map((line) => line.trim()).filter(Boolean).join('\n'),
      comment,
      summary: comment && summary.startsWith('This network has no instructions')
        ? `${comment}. ${summary}`
        : summary,
    };
  }).filter((unit) => unit.text || unit.comment || unit.summary);
}

module.exports = {
  looksLikeAwl,
  parseLine,
  describeInstructions,
  networksOf,
  signalName,
};
