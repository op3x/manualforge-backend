require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const AdmZip = require('adm-zip');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3001;

const _apiKey = process.env.ANTHROPIC_API_KEY || '';
const _hasValidKey = _apiKey && _apiKey !== 'sk-ant-...' && _apiKey.startsWith('sk-ant-api');
const anthropic = _hasValidKey ? new Anthropic({ apiKey: _apiKey }) : null;

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'manualos-backend', aiEnabled: _hasValidKey }));

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { email } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: email,
      success_url: process.env.FRONTEND_URL + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: process.env.FRONTEND_URL + '/cancel',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/verify-session', async (req, res) => {
  try {
    const { session_id } = req.query;
    const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription', 'customer'] });
    res.json({ paid: session.payment_status === 'paid', customer: session.customer_details, subscription: session.subscription });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function calculateCodeReferencePercentage(plcContent, manualText) {
  if (!plcContent || !manualText) return 0;
  const tokenRegex = /\b([A-Za-z_][A-Za-z0-9_]{2,})\b/g;
  const plcTokens = new Set();
  let match;
  while ((match = tokenRegex.exec(plcContent)) !== null) {
    const token = match[1].toLowerCase();
    const skip = new Set(['var','end','for','the','and','not','int','bool','true','false','then','else','begin','function','program','type','struct','array','real','word','byte','string']);
    if (!skip.has(token)) plcTokens.add(token);
  }
  if (plcTokens.size === 0) return 0;
  const manualLower = manualText.toLowerCase();
  let referenced = 0;
  for (const token of plcTokens) { if (manualLower.includes(token)) referenced++; }
  return Math.min(Math.round((referenced / plcTokens.size) * 100), 100);
}

function extractPlcInfo(xml) {
  const info = { controller:'', programs:[], tasks:[], routines:[], tags:[], modules:[] };
  const ctrlM = xml.match(/<Controller[^>]*Name="([^"]+)"/i);
  if (ctrlM) info.controller = ctrlM[1];
  for (const m of xml.matchAll(/<Task[^>]*Name="([^"]+)"[^>]*(?:Period="([^"]*)")?[^>]*(?:Priority="([^"]*)")?/gi))
    info.tasks.push({ name: m[1], period: m[2] || '', priority: m[3] || '' });
  for (const m of xml.matchAll(/<Program[^>]*Name="([^"]+)"/gi))
    if (!info.programs.includes(m[1])) info.programs.push(m[1]);
  for (const m of xml.matchAll(/<Routine[^>]*Name="([^"]+)"[^>]*(?:Type="([^"]*)")?/gi))
    info.routines.push({ name: m[1], type: m[2] || 'Ladder' });
  let tc = 0;
  for (const m of xml.matchAll(/<Tag[^>]*Name="([^"]+)"[^>]*DataType="([^"]+)"[^>]*(?:Description="([^"]*)")?/gi)) {
    if (tc++ >= 50) break;
    info.tags.push({ name: m[1], type: m[2], desc: m[3] || '' });
  }
  for (const m of xml.matchAll(/<Module[^>]*Name="([^"]+)"[^>]*(?:CatalogNumber="([^"]*)")?/gi))
    info.modules.push({ name: m[1], catalog: m[2] || '' });
  return info;
}

// Extract each routine XML block separately, keyed by routine name
function extractRoutineBlocks(xml) {
  const blocks = {};
  // Handle both self-closing and full closing tags
  const routineRegex = /<Routine[^>]*Name="([^"]+)"[^>]*\/?>([\s\S]*?)<\/Routine>|<Routine[^>]*Name="([^"]+)"[^>]*\/>/gi;
  let m;
  // Primary: full blocks
  const fullRegex = /<Routine[^>]*Name="([^"]+)"[^>]*>([\s\S]*?)<\/Routine>/gi;
  while ((m = fullRegex.exec(xml)) !== null) {
    blocks[m[1]] = m[0];
  }
  // Fallback: self-closing (empty routines)
  const emptyRegex = /<Routine[^>]*Name="([^"]+)"[^>]*\/>/gi;
  while ((m = emptyRegex.exec(xml)) !== null) {
    if (!blocks[m[1]]) blocks[m[1]] = m[0];
  }
  return blocks;
}

// Describe instruction purpose from mnemonic
function instrDescription(mnemonic) {
  const map = {
    XIC:'Examine If Closed (contact ON)', XIO:'Examine If Open (contact OFF)',
    OTE:'Output Energize (coil)', OTL:'Output Latch', OTU:'Output Unlatch',
    TON:'Timer On-Delay', TOF:'Timer Off-Delay', RTO:'Retentive Timer On',
    CTU:'Count Up', CTD:'Count Down', RES:'Reset accumulator',
    MOV:'Move value', COP:'Copy data block', CLR:'Clear to zero',
    ADD:'Add', SUB:'Subtract', MUL:'Multiply', DIV:'Divide',
    EQU:'Equal compare', NEQ:'Not Equal compare', GRT:'Greater Than compare',
    GEQ:'Greater Than or Equal compare', LES:'Less Than compare', LEQ:'Less Than or Equal compare',
    AND:'Bitwise AND', OR:'Bitwise OR', XOR:'Bitwise XOR', NOT:'Bitwise NOT',
    JSR:'Jump to Subroutine', RET:'Return from Subroutine', SBR:'Subroutine label',
    AFI:'Always False Instruction', NOP:'No Operation',
    MSG:'Message (comms read/write)', GSV:'Get System Value', SSV:'Set System Value',
    FLL:'Fill with value', CMP:'Compare expression', CPT:'Compute expression',
    SQI:'Sequencer Input', SQO:'Sequencer Output', SQL:'Sequencer Load',
    BSL:'Bit Shift Left', BSR:'Bit Shift Right', FFL:'FIFO Load', FFU:'FIFO Unload',
    LIM:'Limit test', MEQ:'Masked Equal', BTD:'Bit field Distribute',
    PID:'PID controller', PIDE:'Enhanced PID controller',
    RAMP:'Ramp output', POSP:'Position Proportional',
    IOT:'Immediate Output', IIN:'Immediate Input',
    ENCO:'Encode', DECO:'Decode', TOD:'To BCD', FRD:'From BCD',
    ASC:'ASCII operations', CLOG:'Alarm log',
    ACB:'ASCII chars in buffer', ACL:'ASCII clear buffer',
    AHL:'ASCII handshake', ARD:'ASCII read', AWA:'ASCII write append', AWT:'ASCII write'
  };
  return map[mnemonic] || mnemonic;
}

// Build a rich template summary for a single routine — enumerates every rung function
function summarizeRoutineTemplate(name, type, routineXml) {
  const lines = [];
  // Header
  lines.push('###ROUTINE### ' + name);
  lines.push('####DETAIL#### Type: ' + (type || 'Ladder'));

  if (!routineXml || routineXml.length < 10) {
    lines.push('####DETAIL#### (No ladder content extracted for this routine)');
    return lines.join('\n');
  }

  // Count rungs
  const rungBlocks = [];
  const rungRegex = /<Rung[^>]*(?:Number="([^"]*)")?[^>]*>([\s\S]*?)<\/Rung>/gi;
  let rm;
  while ((rm = rungRegex.exec(routineXml)) !== null) rungBlocks.push({ num: rm[1] || String(rungBlocks.length), xml: rm[2] });
  lines.push('####DETAIL#### Total rungs: ' + rungBlocks.length);

  // Collect all unique instructions across routine
  const allInstrs = new Set();
  const instrRegex = /\b([A-Z]{2,5})\(/g;
  let im;
  while ((im = instrRegex.exec(routineXml)) !== null) allInstrs.add(im[1]);
  if (allInstrs.size > 0) {
    lines.push('####DETAIL#### Instructions: ' + Array.from(allInstrs).map(i => i + ' (' + instrDescription(i) + ')').join(', '));
  }

  // Collect key tags
  const tagRegex2 = /Operand="([^"]+)"/gi;
  const tagSet = new Set();
  let tm;
  while ((tm = tagRegex2.exec(routineXml)) !== null) {
    const val = tm[1].trim();
    if (val && !/^\d/.test(val) && val.length > 1) tagSet.add(val.split('.')[0].split('[')[0]);
  }
  if (tagSet.size > 0) {
    const tagList = Array.from(tagSet).slice(0, 25);
    lines.push('####DETAIL#### Key tags: ' + tagList.join(', ') + (tagSet.size > 25 ? ', ...' : ''));
  }

  // Enumerate each rung with its function
  if (rungBlocks.length > 0) {
    lines.push('####DETAIL#### Rung-by-rung functions:');
    for (const rung of rungBlocks) {
      // Extract comment from CDATA
      const cdataMatch = rung.xml.match(/<Text[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/Text>/i);
      const comment = cdataMatch ? cdataMatch[1].trim().replace(/\s+/g, ' ').substring(0, 150) : '';

      // Extract instructions in this rung
      const rungInstrs = new Set();
      const ri = /\b([A-Z]{2,5})\(/g;
      let rp;
      while ((rp = ri.exec(rung.xml)) !== null) rungInstrs.add(rp[1]);
      const instrList = Array.from(rungInstrs).slice(0, 6).map(i => instrDescription(i)).join('; ');

      const desc = comment ? comment : (instrList || 'Logic rung');
      lines.push('>>' + 'Rung ' + rung.num + ': ' + desc + (instrList && comment ? ' [' + Array.from(rungInstrs).slice(0,4).join(',') + ']' : ''));
    }
  }

  return lines.join('\n');
}

// ============================================================
// PDF GENERATION — structured text protocol:
//   ##SECTION## Title       -> bold section header with line
//   ###ROUTINE### Name      -> routine sub-header (blue-ish box style)
//   ####DETAIL#### text     -> indented detail line (gray)
//   >text                   -> bullet point
//   >>text                  -> indented sub-bullet
//   plain text              -> normal body text
// ============================================================
function generatePDF(manualText, brand, codeRefPercentage) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const marginL = 50;
    const contentW = pageW - marginL * 2;

    // --- Cover header ---
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1a1a2e').text('ManualOS', { align: 'center' });
    doc.fontSize(13).font('Helvetica').fillColor('#444').text('AI-Generated Operator Manual', { align: 'center' });
    doc.moveDown(0.4);
    if (brand) doc.fontSize(11).fillColor('#333').text('Brand / Manufacturer: ' + brand, { align: 'center' });
    doc.moveDown(0.6);

    // --- Coverage bar ---
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Code Coverage Referenced in This Report:');
    doc.moveDown(0.3);
    const barW = contentW, barH = 16;
    const barX = marginL;
    const barY = doc.y;
    const fillW = Math.round((codeRefPercentage / 100) * barW);
    doc.rect(barX, barY, barW, barH).fillColor('#e8e8e8').fill();
    if (fillW > 0) doc.rect(barX, barY, fillW, barH).fillColor('#2e7d32').fill();
    doc.rect(barX, barY, barW, barH).strokeColor('#aaa').lineWidth(0.5).stroke();
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff');
    if (fillW > 30) doc.text(codeRefPercentage + '%', barX + 6, barY + 3, { lineBreak: false });
    doc.fillColor('#333').moveDown(2.2);

    // --- Divider ---
    doc.moveTo(marginL, doc.y).lineTo(pageW - marginL, doc.y).lineWidth(1).strokeColor('#ccc').stroke();
    doc.moveDown(0.8);

    // --- Body: parse structured text ---
    const lines = manualText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === '') {
        doc.moveDown(0.3);
        continue;
      }

      // ##SECTION## Major section header
      if (trimmed.startsWith('##SECTION##')) {
        const title = trimmed.replace('##SECTION##', '').trim();
        doc.moveDown(0.5);
        // Section rule above
        doc.moveTo(marginL, doc.y).lineTo(pageW - marginL, doc.y).lineWidth(1.5).strokeColor('#1a1a2e').stroke();
        doc.moveDown(0.3);
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#1a1a2e').text(title);
        doc.moveTo(marginL, doc.y).lineTo(pageW - marginL, doc.y).lineWidth(0.5).strokeColor('#1a1a2e').stroke();
        doc.moveDown(0.4);
        doc.fontSize(10).font('Helvetica').fillColor('#222');
        continue;
      }

      // ###ROUTINE### Routine sub-header
      if (trimmed.startsWith('###ROUTINE###')) {
        const rName = trimmed.replace('###ROUTINE###', '').trim();
        doc.moveDown(0.5);
        // Shaded background box
        const boxY = doc.y;
        doc.rect(marginL, boxY, contentW, 20).fillColor('#e3f2fd').fill();
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#0d47a1')
          .text('Routine: ' + rName, marginL + 6, boxY + 4, { width: contentW - 12, lineBreak: false });
        doc.moveDown(1.5);
        doc.fontSize(10).font('Helvetica').fillColor('#222');
        continue;
      }

      // ####DETAIL#### indented detail line
      if (trimmed.startsWith('####DETAIL####')) {
        const detail = trimmed.replace('####DETAIL####', '').trim();
        doc.fontSize(9).font('Helvetica').fillColor('#555')
          .text(detail, { indent: 16 });
        doc.fillColor('#222');
        continue;
      }

      // >>sub-bullet (rung entries)
      if (trimmed.startsWith('>>')) {
        const text = trimmed.substring(2).trim();
        doc.fontSize(9).font('Helvetica').fillColor('#333')
          .text('\u2022 ' + text, { indent: 32 });
        doc.fillColor('#222');
        continue;
      }

      // >bullet
      if (trimmed.startsWith('>')) {
        const text = trimmed.substring(1).trim();
        doc.fontSize(10).font('Helvetica').fillColor('#222')
          .text('\u2022 ' + text, { indent: 16 });
        continue;
      }

      // Numbered section line: "1. TITLE" or "TITLE:" all caps label
      if (trimmed.match(/^\d+\.\s+[A-Z]/) || trimmed.match(/^[A-Z][A-Z\s]{4,}:?$/) ) {
        doc.moveDown(0.2);
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a2e').text(trimmed);
        doc.fontSize(10).font('Helvetica').fillColor('#222');
        continue;
      }

      // Default body text
      doc.fontSize(10).font('Helvetica').fillColor('#222').text(trimmed);
    }

    doc.end();
  });
}

function generateTemplateManual(plcContent, brand, filename) {
  const info = extractPlcInfo(plcContent);
  const routineBlocks = extractRoutineBlocks(plcContent);
  const ctrl = info.controller || filename || 'PLC System';
  const br = brand || 'Unknown';
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  let t = '';
  t += '##SECTION## OPERATOR MANUAL — ' + ctrl + '\n';
  t += br + ' PLC System | Generated by ManualOS | ' + date + '\n\n';

  t += '##SECTION## 1. SYSTEM OVERVIEW\n';
  t += 'This manual covers the ' + ctrl + ' PLC system manufactured by ' + br + '.\n';
  t += 'File: ' + (filename || 'N/A') + '\n';
  t += 'Programs: ' + (info.programs.join(', ') || 'N/A') + '\n\n';

  t += '##SECTION## 2. SAFETY WARNINGS\n';
  t += '>WARNING: De-energize and lock out / tag out (LOTO) all power before maintenance.\n';
  t += '>DANGER: High voltage present — only qualified personnel may work on this system.\n';
  t += '>CAUTION: Verify safe state before making program changes or forcing I/O.\n\n';

  if (info.tasks.length) {
    t += '##SECTION## 3. TASKS\n';
    for (const k of info.tasks)
      t += '>' + k.name + (k.period ? '  Period: ' + k.period + ' ms' : '') + (k.priority ? '  Priority: ' + k.priority : '') + '\n';
    t += '\n';
  }

  if (info.programs.length) {
    t += '##SECTION## 4. PROGRAMS\n';
    for (const p of info.programs) t += '>' + p + '\n';
    t += '\n';
  }

  if (info.routines.length) {
    t += '##SECTION## 5. ROUTINE DESCRIPTIONS\n';
    t += 'Each routine is listed below with a full summary of its logic and functions.\n\n';
    for (const r of info.routines) {
      const xmlBlock = routineBlocks[r.name] || '';
      t += summarizeRoutineTemplate(r.name, r.type, xmlBlock) + '\n\n';
    }
  }

  if (info.modules.length) {
    t += '##SECTION## 6. I/O MODULES\n';
    for (const m of info.modules)
      t += '>' + m.name + (m.catalog ? '  (' + m.catalog + ')' : '') + '\n';
    t += '\n';
  }

  if (info.tags.length) {
    t += '##SECTION## 7. TAG REFERENCE\n';
    for (const g of info.tags)
      t += '>' + g.name + '  (' + g.type + ')' + (g.desc ? ' — ' + g.desc : '') + '\n';
    t += '\n';
  }

  t += '##SECTION## 8. OPERATING PROCEDURES\n';
  t += 'STARTUP:\n';
  t += '>Verify all safety interlocks are functional\n';
  t += '>Inspect I/O wiring and connections\n';
  t += '>Apply power and verify RUN indicator\n';
  t += '>Clear any existing faults\n';
  t += '>Enable outputs via operator interface\n\n';
  t += 'NORMAL OPERATION:\n';
  t += '>Monitor system status via HMI\n';
  t += '>Respond to alarms promptly per alarm response procedures\n';
  t += '>Log any unusual behavior for maintenance review\n\n';
  t += 'SHUTDOWN:\n';
  t += '>Initiate controlled shutdown via operator interface\n';
  t += '>Verify all outputs are de-energized\n';
  t += '>Apply LOTO before any maintenance activity\n\n';

  t += '##SECTION## 9. TROUBLESHOOTING\n';
  t += '>CONTROLLER FAULT: Check fault code on controller display, review recent program changes, verify I/O communications\n';
  t += '>I/O COMM ERROR: Inspect cables and connectors, verify power supplies, check node addresses\n';
  t += '>LOGIC ERROR: Review ladder logic online, check tag values, verify sensor inputs\n\n';

  t += '##SECTION## 10. MAINTENANCE SCHEDULE\n';
  t += '>DAILY: Check status LEDs, review alarm history log\n';
  t += '>WEEKLY: Inspect all connections, backup program to maintenance folder\n';
  t += '>MONTHLY: Clean panel interior (with LOTO), check battery backup voltage\n';
  t += '>ANNUALLY: Full functional test, calibration verification, update documentation\n\n';

  t += 'Generated by ManualOS AI Manual Generator.\n';
  return t;
}

app.post('/generate-manual', upload.single('file'), async (req, res) => {
  if (req.socket) req.socket.setTimeout(0);
  res.setTimeout(0);
  try {
    let plcContent = '';
    const brand = (req.body && req.body.brand) || '';
    const sections = (req.body && req.body.sections) ? JSON.parse(req.body.sections) : [];
    const filename = req.file ? req.file.originalname : 'unknown.acd';

    if (req.file) {
      const fileExt = req.file.originalname.split('.').pop().toLowerCase();
      if (fileExt === 'acd' || fileExt === 'zip' || fileExt === 'zap15') {
        try {
          const zip = new AdmZip(req.file.buffer);
          const zipEntries = zip.getEntries();
          const xmlEntries = zipEntries.filter(e =>
            e.entryName.endsWith('.xml') || e.entryName.endsWith('.L5X') || e.entryName.endsWith('.l5x'));
          if (xmlEntries.length > 0) {
            xmlEntries.sort((a, b) => b.header.size - a.header.size);
            plcContent = zip.readAsText(xmlEntries[0]);
            if (plcContent.length > 200000) plcContent = plcContent.substring(0, 200000) + '\n... [truncated]';
          } else {
            plcContent = 'ACD Binary File: ' + req.file.originalname + ' - ' + req.file.size + ' bytes. Entries: ' + zipEntries.map(e => e.entryName).join(', ');
          }
        } catch (zipErr) {
          console.error('ZIP error:', zipErr.message);
          try {
            const bufStr = req.file.buffer.toString('latin1');
            const xmlStart = bufStr.indexOf('<RSLogix5000Content');
            const xmlStart2 = bufStr.indexOf('<?xml');
            const start = xmlStart >= 0 ? xmlStart : (xmlStart2 >= 0 ? xmlStart2 : -1);
            if (start >= 0) {
              const xmlEnd = bufStr.lastIndexOf('</RSLogix5000Content>');
              plcContent = xmlEnd >= 0 ? bufStr.substring(start, xmlEnd + 21) : bufStr.substring(start, start + 200000);
              if (plcContent.length > 200000) plcContent = plcContent.substring(0, 200000) + '\n... [truncated]';
              console.log('Extracted XML from raw buffer, length:', plcContent.length);
            } else {
              plcContent = 'ACD Binary File: ' + req.file.originalname + ' - ' + req.file.size + ' bytes.';
            }
          } catch (e2) {
            plcContent = 'ACD Binary File: ' + req.file.originalname + ' - ' + req.file.size + ' bytes.';
          }
        }
      } else {
        plcContent = req.file.buffer.toString('utf8');
      }
    } else if (req.body && req.body.plcContent) {
      plcContent = req.body.plcContent;
    }

    if (!plcContent) return res.status(400).json({ error: 'No file or plcContent provided' });

    let manualText = '';
    let usedAI = false;

    if (_hasValidKey && anthropic) {
      try {
        console.log('Calling Anthropic API with per-routine processing...');
        const plcInfo = extractPlcInfo(plcContent);
        const routineBlocks = extractRoutineBlocks(plcContent);

        // --- Step 1: summarize each routine individually ---
        const routineSummaries = [];
        for (const r of plcInfo.routines) {
          const xmlBlock = routineBlocks[r.name] || '';
          const truncatedBlock = xmlBlock.length > 8000 ? xmlBlock.substring(0, 8000) + '\n... [truncated]' : xmlBlock;

          const routinePrompt =
            'You are an expert industrial automation engineer writing an operator manual.\n' +
            'Analyze the PLC routine below and produce a structured description using EXACTLY this format:\n\n' +
            '###ROUTINE### ' + r.name + '\n' +
            '####DETAIL#### Type: ' + (r.type || 'Ladder') + '\n' +
            '####DETAIL#### Purpose: <one sentence describing the overall purpose>\n' +
            '####DETAIL#### Rung-by-rung functions:\n' +
            '>>Rung N: <describe what this rung does — conditions checked and action taken>\n' +
            '(repeat >>Rung line for every rung)\n' +
            '####DETAIL#### Key tags controlled: <comma-separated list>\n' +
            '####DETAIL#### Summary: <2-3 sentences describing the complete routine behavior>\n\n' +
            'Rules:\n' +
            '- Use ONLY the markers shown (###ROUTINE###, ####DETAIL####, >>, >). No markdown, no asterisks, no hashes except as shown.\n' +
            '- Describe EVERY rung, even if short. If a rung has no comment, infer its function from the instructions and operands.\n' +
            '- Be specific: name actual tag names, timer presets, setpoints found in the XML.\n\n' +
            'Routine Name: ' + r.name + '\n' +
            'Routine Type: ' + (r.type || 'Ladder') + '\n\n' +
            'Routine XML:\n' + (truncatedBlock || '(no content extracted)') + '\n';

          try {
            const msg = await anthropic.messages.create({
              model: 'claude-3-5-haiku-20241022',
              max_tokens: 1024,
              messages: [{ role: 'user', content: routinePrompt }]
            });
            routineSummaries.push(msg.content[0].text.trim());
            console.log('Summarized routine:', r.name);
          } catch (routineErr) {
            console.error('Failed to summarize routine ' + r.name + ':', routineErr.message);
            routineSummaries.push(summarizeRoutineTemplate(r.name, r.type, xmlBlock));
          }
        }

        // --- Step 2: assemble full manual with per-routine summaries ---
        const routineSection = routineSummaries.join('\n\n');
        const systemInfo =
          'Controller: ' + (plcInfo.controller || 'Unknown') + '\n' +
          'Programs: ' + (plcInfo.programs.join(', ') || 'N/A') + '\n' +
          'Tasks: ' + (plcInfo.tasks.map(t => t.name + (t.period ? ' (' + t.period + 'ms)' : '')).join(', ') || 'N/A') + '\n' +
          'Modules: ' + (plcInfo.modules.map(m => m.name + (m.catalog ? ' (' + m.catalog + ')' : '')).join(', ') || 'N/A') + '\n' +
          'Top Tags: ' + (plcInfo.tags.slice(0, 20).map(g => g.name + ' (' + g.type + ')' + (g.desc ? ' — ' + g.desc : '')).join(', ') || 'N/A');

        const fullPrompt =
          'You are an expert industrial automation engineer. Generate a complete operator manual using EXACTLY the structured format below. Use ONLY these markers — no markdown, no asterisks, no hashes except as shown.\n\n' +
          'FORMAT RULES:\n' +
          '  ##SECTION## Title         — major section header\n' +
          '  ###ROUTINE### Name        — routine sub-header (used only in routine section)\n' +
          '  ####DETAIL#### text       — indented detail line\n' +
          '  >text                     — bullet point\n' +
          '  >>text                    — sub-bullet (rung entries)\n' +
          '  plain text                — body paragraph\n\n' +
          'Brand/Manufacturer: ' + (brand || 'Unknown') + '\n' +
          systemInfo + '\n\n' +
          '--- PER-ROUTINE SUMMARIES (already analyzed — use these verbatim in section 5) ---\n' +
          routineSection + '\n' +
          '--- END ROUTINE SUMMARIES ---\n\n' +
          'Generate the full manual with these sections:\n' +
          '##SECTION## 1. SYSTEM OVERVIEW\n' +
          '##SECTION## 2. SAFETY WARNINGS\n' +
          '##SECTION## 3. CONTROLLER & TASKS\n' +
          '##SECTION## 4. PROGRAMS\n' +
          '##SECTION## 5. ROUTINE DESCRIPTIONS  <— insert each routine summary exactly as provided above, one per ###ROUTINE### block\n' +
          '##SECTION## 6. I/O MODULES\n' +
          '##SECTION## 7. TAG REFERENCE\n' +
          '##SECTION## 8. OPERATING PROCEDURES\n' +
          '##SECTION## 9. TROUBLESHOOTING\n' +
          '##SECTION## 10. MAINTENANCE SCHEDULE\n';

        const message = await anthropic.messages.create({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 4096,
          messages: [{ role: 'user', content: fullPrompt }]
        });
        manualText = message.content[0].text;
        usedAI = true;
        console.log('Anthropic API success.');
      } catch (aiErr) {
        console.error('Anthropic failed, using template:', aiErr.message);
        manualText = generateTemplateManual(plcContent, brand, filename);
      }
    } else {
      console.log('No valid Anthropic key — template generation.');
      manualText = generateTemplateManual(plcContent, brand, filename);
    }

    const codeRefPercentage = calculateCodeReferencePercentage(plcContent, manualText);
    const pdfBuffer = await generatePDF(manualText, brand, codeRefPercentage);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="matrix-manual-report.pdf"',
      'Content-Length': pdfBuffer.length,
      'X-Manual-Mode': usedAI ? 'ai-generated' : 'template-generated',
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Manual generation error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send('Webhook signature verification failed');
  }
  switch (event.type) {
    case 'checkout.session.completed': console.log('Payment completed:', event.data.object.customer_email); break;
    case 'customer.subscription.created': console.log('Subscription created:', event.data.object); break;
    case 'customer.subscription.deleted': console.log('Subscription cancelled:', event.data.object); break;
    case 'invoice.payment_failed': console.log('Payment failed:', event.data.object.customer_email); break;
    default: console.log('Unhandled event:', event.type);
  }
  res.json({ received: true });
});

app.listen(PORT, () => console.log('ManualOS backend running on port ' + PORT));
