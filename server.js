require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const AdmZip = require('adm-zip');
const zlib = require('zlib');
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

// ============================================================
// ACD BINARY EXTRACTION
// RSLogix/Studio 5000 .ACD files are a proprietary binary format.
// They contain multiple GZIP-compressed sections embedded in the binary.
// Each compressed section contains UTF-16LE encoded XML.
// This function finds, decompresses, and decodes all GZIP blocks.
// ============================================================
function extractXmlFromAcdBuffer(buffer) {
  const bytes = buffer;
  const allXml = [];
  let i = 0;

  while (i < bytes.length - 2) {
    // Look for GZIP magic bytes: 0x1F 0x8B
    if (bytes[i] === 0x1F && bytes[i + 1] === 0x8B) {
      const slice = bytes.slice(i);
      try {
        // Decompress synchronously
        const decompressed = zlib.gunzipSync(slice);
        // Try UTF-16LE decode first (RSLogix uses UTF-16)
        let text = '';
        if (decompressed.length > 2 && decompressed[0] !== 0x3C) {
          // UTF-16LE: check for BOM or wide chars
          text = decompressed.toString('utf16le');
        }
        if (!text.includes('<') || text.length < 10) {
          text = decompressed.toString('utf8');
        }
        if (text.includes('<') && text.length > 20) {
          allXml.push(text);
          console.log('ACD: decompressed block at', i, 'length', decompressed.length, 'xml chars', text.length);
        }
        // Skip past this block — find next GZIP header
        // The decompressed size tells us nothing about compressed size; scan forward
        i += 10; // skip at least the GZIP header
      } catch (e) {
        i++; // this wasn't a valid gzip block, keep scanning
      }
    } else {
      i++;
    }
  }

  const combined = allXml.join('\n');
  console.log('ACD total XML chars extracted:', combined.length, 'from', allXml.length, 'blocks');
  return combined;
}

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
  const info = { controller: '', programs: [], tasks: [], routines: [], tags: [], modules: [] };
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

function extractRoutineBlocks(xml) {
  const blocks = {};
  const fullRegex = /<Routine[^>]*Name="([^"]+)"[^>]*>([\s\S]*?)<\/Routine>/gi;
  let m;
  while ((m = fullRegex.exec(xml)) !== null) {
    blocks[m[1]] = m[0];
  }
  const emptyRegex = /<Routine[^>]*Name="([^"]+)"[^>]*\/>/gi;
  while ((m = emptyRegex.exec(xml)) !== null) {
    if (!blocks[m[1]]) blocks[m[1]] = m[0];
  }
  return blocks;
}

function instrDescription(mnemonic) {
  const map = {
    XIC: 'Examine If Closed (contact ON)', XIO: 'Examine If Open (contact OFF)',
    OTE: 'Output Energize (coil)', OTL: 'Output Latch', OTU: 'Output Unlatch',
    TON: 'Timer On-Delay', TOF: 'Timer Off-Delay', RTO: 'Retentive Timer On',
    CTU: 'Count Up', CTD: 'Count Down', RES: 'Reset accumulator',
    MOV: 'Move value', COP: 'Copy data block', CLR: 'Clear to zero',
    ADD: 'Add', SUB: 'Subtract', MUL: 'Multiply', DIV: 'Divide',
    EQU: 'Equal compare', NEQ: 'Not Equal compare', GRT: 'Greater Than compare',
    GEQ: 'Greater Than or Equal', LES: 'Less Than compare', LEQ: 'Less Than or Equal',
    AND: 'Bitwise AND', OR: 'Bitwise OR', XOR: 'Bitwise XOR', NOT: 'Bitwise NOT',
    JSR: 'Jump to Subroutine', RET: 'Return from Subroutine', SBR: 'Subroutine label',
    AFI: 'Always False', NOP: 'No Operation',
    MSG: 'Message (comms)', GSV: 'Get System Value', SSV: 'Set System Value',
    FLL: 'Fill with value', CMP: 'Compare expression', CPT: 'Compute expression',
    BSL: 'Bit Shift Left', BSR: 'Bit Shift Right',
    LIM: 'Limit test', MEQ: 'Masked Equal', BTD: 'Bit field Distribute',
    PID: 'PID controller', PIDE: 'Enhanced PID',
    IOT: 'Immediate Output', IIN: 'Immediate Input',
  };
  return map[mnemonic] || mnemonic;
}

function summarizeRoutineTemplate(name, type, routineXml) {
  const lines = [];
  lines.push('###ROUTINE### ' + name);
  lines.push('####DETAIL#### Type: ' + (type || 'Ladder'));

  if (!routineXml || routineXml.length < 20) {
    lines.push('####DETAIL#### Purpose: Empty or binary-only routine — no XML ladder content available');
    lines.push('####DETAIL#### Summary: This routine exists in the program but its content could not be read from the file format. Export as L5X for full routine details.');
    return lines.join('\n');
  }

  const rungBlocks = [];
  const rungRegex = /<Rung[^>]*(?:Number="([^"]*)")?[^>]*>([\s\S]*?)<\/Rung>/gi;
  let rm;
  while ((rm = rungRegex.exec(routineXml)) !== null)
    rungBlocks.push({ num: rm[1] !== undefined ? rm[1] : String(rungBlocks.length), xml: rm[2] || '' });

  const allInstrs = new Set();
  const instrRegex = /\b([A-Z]{2,5})\(/g;
  let im;
  while ((im = instrRegex.exec(routineXml)) !== null) allInstrs.add(im[1]);

  const tagSet = new Set();
  const tagRegex = /Operand="([^"]+)"/gi;
  let tm;
  while ((tm = tagRegex.exec(routineXml)) !== null) {
    const val = tm[1].trim();
    if (val && !/^[\d\.\-]/.test(val) && val.length > 1) tagSet.add(val.split('.')[0].split('[')[0]);
  }

  const instrList = Array.from(allInstrs);
  const purposeParts = [];
  if (rungBlocks.length > 0) purposeParts.push(rungBlocks.length + ' rung(s)');
  if (instrList.some(i => ['TON','TOF','RTO'].includes(i))) purposeParts.push('timing logic');
  if (instrList.some(i => ['CTU','CTD'].includes(i))) purposeParts.push('counting');
  if (instrList.includes('JSR')) purposeParts.push('subroutine calls');
  if (instrList.some(i => ['PID','PIDE'].includes(i))) purposeParts.push('PID control');
  if (instrList.includes('MSG')) purposeParts.push('communications');
  if (instrList.some(i => ['ADD','SUB','MUL','DIV','CPT'].includes(i))) purposeParts.push('math/calculation');
  if (instrList.some(i => ['MOV','COP','FLL'].includes(i))) purposeParts.push('data moves');

  lines.push('####DETAIL#### Purpose: ' + (purposeParts.join(', ') || 'General ladder logic'));
  if (instrList.length > 0)
    lines.push('####DETAIL#### Instructions: ' + instrList.map(i => i + ' (' + instrDescription(i) + ')').join(', '));
  if (tagSet.size > 0)
    lines.push('####DETAIL#### Key tags: ' + Array.from(tagSet).slice(0, 20).join(', '));

  if (rungBlocks.length > 0) {
    lines.push('####DETAIL#### Rung-by-rung functions:');
    for (const rung of rungBlocks) {
      const cdataMatch = rung.xml.match(/<Text[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/Text>/i);
      const comment = cdataMatch ? cdataMatch[1].trim().replace(/\s+/g, ' ').substring(0, 160) : '';
      const rungInstrs = new Set();
      const ri = /\b([A-Z]{2,5})\(/g;
      let rp;
      while ((rp = ri.exec(rung.xml)) !== null) rungInstrs.add(rp[1]);
      const rungInstrDesc = Array.from(rungInstrs).slice(0, 5).map(i => instrDescription(i)).join('; ');
      const desc = comment || rungInstrDesc || 'Ladder logic rung';
      const suffix = (comment && rungInstrs.size > 0) ? ' [' + Array.from(rungInstrs).join(', ') + ']' : '';
      lines.push('>>Rung ' + rung.num + ': ' + desc + suffix);
    }
  } else {
    lines.push('####DETAIL#### No ladder rungs found — routine may be ST/FBD type, or export as L5X for full content');
  }

  lines.push('####DETAIL#### Summary: ' + name + ' (' + (type || 'Ladder') + ') — ' + rungBlocks.length + ' rung(s). ' +
    (instrList.length > 0 ? 'Uses: ' + instrList.slice(0, 6).join(', ') + '. ' : '') +
    (tagSet.size > 0 ? 'Tags include: ' + Array.from(tagSet).slice(0, 5).join(', ') + '.' : ''));

  return lines.join('\n');
}

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

    doc.fontSize(22).font('Helvetica-Bold').fillColor('#1a1a2e').text('ManualOS', { align: 'center' });
    doc.fontSize(13).font('Helvetica').fillColor('#555').text('AI-Generated Operator Manual', { align: 'center' });
    doc.moveDown(0.4);
    if (brand) doc.fontSize(11).fillColor('#333').text('Brand / Manufacturer: ' + brand, { align: 'center' });
    doc.moveDown(0.6);

    doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Code Coverage Referenced in This Report:');
    doc.moveDown(0.3);
    const barH = 16, barX = marginL, barY = doc.y;
    const fillW = Math.round((codeRefPercentage / 100) * contentW);
    doc.rect(barX, barY, contentW, barH).fillColor('#e8e8e8').fill();
    if (fillW > 0) doc.rect(barX, barY, fillW, barH).fillColor('#2e7d32').fill();
    doc.rect(barX, barY, contentW, barH).strokeColor('#aaa').lineWidth(0.5).stroke();
    if (fillW > 30) doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(codeRefPercentage + '%', barX + 6, barY + 3, { lineBreak: false });
    doc.fillColor('#333').moveDown(2.2);
    doc.moveTo(marginL, doc.y).lineTo(pageW - marginL, doc.y).lineWidth(1).strokeColor('#ccc').stroke();
    doc.moveDown(0.8);

    const lines = manualText.split('\n');
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed === '') { doc.moveDown(0.3); continue; }

      if (trimmed.startsWith('##SECTION##')) {
        const title = trimmed.slice('##SECTION##'.length).trim();
        doc.moveDown(0.6);
        doc.moveTo(marginL, doc.y).lineTo(pageW - marginL, doc.y).lineWidth(1.5).strokeColor('#1a1a2e').stroke();
        doc.moveDown(0.25);
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a2e').text(title);
        doc.moveTo(marginL, doc.y).lineTo(pageW - marginL, doc.y).lineWidth(0.5).strokeColor('#aaa').stroke();
        doc.moveDown(0.3);
        doc.fontSize(10).font('Helvetica').fillColor('#222');
        continue;
      }

      if (trimmed.startsWith('###ROUTINE###')) {
        const rName = trimmed.slice('###ROUTINE###'.length).trim();
        doc.moveDown(0.5);
        const boxY = doc.y;
        doc.rect(marginL, boxY, contentW, 22).fillColor('#e3f2fd').fill();
        doc.rect(marginL, boxY, contentW, 22).strokeColor('#90caf9').lineWidth(0.5).stroke();
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#0d47a1')
          .text('Routine:  ' + rName, marginL + 8, boxY + 5, { width: contentW - 16, lineBreak: false });
        doc.y = boxY + 28;
        doc.moveDown(0.2);
        doc.fontSize(10).font('Helvetica').fillColor('#222');
        continue;
      }

      if (trimmed.startsWith('####DETAIL####')) {
        const detail = trimmed.slice('####DETAIL####'.length).trim();
        doc.fontSize(9).font('Helvetica').fillColor('#444')
          .text(detail, marginL + 14, doc.y, { width: contentW - 14 });
        doc.fillColor('#222');
        continue;
      }

      if (trimmed.startsWith('>>')) {
        const text = trimmed.slice(2).trim();
        doc.fontSize(9).font('Helvetica').fillColor('#333')
          .text('\u2022 ' + text, marginL + 28, doc.y, { width: contentW - 28 });
        doc.fillColor('#222');
        continue;
      }

      if (trimmed.startsWith('>')) {
        const text = trimmed.slice(1).trim();
        doc.fontSize(10).font('Helvetica').fillColor('#222')
          .text('\u2022 ' + text, marginL + 14, doc.y, { width: contentW - 14 });
        continue;
      }

      doc.fontSize(10).font('Helvetica').fillColor('#222').text(trimmed, marginL, doc.y, { width: contentW });
    }

    doc.end();
  });
}

function assembleManual(plcInfo, routineBlocks, routineSummaries, brand, filename) {
  const ctrl = plcInfo.controller || filename || 'PLC System';
  const br = brand || 'Unknown';
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  let t = '';

  t += '##SECTION## OPERATOR MANUAL — ' + ctrl + '\n';
  t += br + ' PLC System  |  Generated by ManualOS  |  ' + date + '\n\n';

  t += '##SECTION## 1. SYSTEM OVERVIEW\n';
  t += 'Controller: ' + ctrl + '\n';
  t += 'Manufacturer: ' + br + '\n';
  t += 'File: ' + (filename || 'N/A') + '\n';
  t += 'Programs: ' + (plcInfo.programs.join(', ') || 'N/A') + '\n';
  t += 'Total Routines: ' + plcInfo.routines.length + '\n\n';

  t += '##SECTION## 2. SAFETY WARNINGS\n';
  t += '>WARNING: De-energize and lock out / tag out (LOTO) all power sources before any maintenance.\n';
  t += '>DANGER: High voltage present — only qualified personnel may work on this system.\n';
  t += '>CAUTION: Verify the system is in a safe state before making program changes or forcing I/O.\n\n';

  if (plcInfo.tasks.length) {
    t += '##SECTION## 3. TASKS\n';
    for (const k of plcInfo.tasks)
      t += '>' + k.name + (k.period ? '  —  Period: ' + k.period + ' ms' : '') + (k.priority ? '  —  Priority: ' + k.priority : '') + '\n';
    t += '\n';
  }

  if (plcInfo.programs.length) {
    t += '##SECTION## 4. PROGRAMS\n';
    for (const p of plcInfo.programs) t += '>' + p + '\n';
    t += '\n';
  }

  t += '##SECTION## 5. ROUTINE DESCRIPTIONS\n';
  t += 'Each routine has been read separately and its functions are documented below.\n\n';
  if (routineSummaries.length === 0) {
    t += 'No routine content could be extracted. If using an .ACD file, please export to L5X format from Studio 5000 (File > Save As > L5X) for full routine details.\n\n';
  } else {
    for (const summary of routineSummaries) {
      t += summary + '\n\n';
    }
  }

  if (plcInfo.modules.length) {
    t += '##SECTION## 6. I/O MODULES\n';
    for (const m of plcInfo.modules)
      t += '>' + m.name + (m.catalog ? '  (' + m.catalog + ')' : '') + '\n';
    t += '\n';
  }

  if (plcInfo.tags.length) {
    t += '##SECTION## 7. TAG REFERENCE\n';
    for (const g of plcInfo.tags)
      t += '>' + g.name + '  (' + g.type + ')' + (g.desc ? '  —  ' + g.desc : '') + '\n';
    t += '\n';
  }

  t += '##SECTION## 8. OPERATING PROCEDURES\n';
  t += 'STARTUP:\n';
  t += '>Verify all safety interlocks are functional before applying power\n';
  t += '>Inspect all I/O wiring and terminal connections\n';
  t += '>Apply power and verify the RUN indicator on the controller\n';
  t += '>Clear any existing faults\n';
  t += '>Enable outputs via the operator interface\n\n';
  t += 'NORMAL OPERATION:\n';
  t += '>Monitor system status via the HMI or programming terminal\n';
  t += '>Respond to all alarms promptly\n';
  t += '>Log any abnormal behavior for maintenance review\n\n';
  t += 'SHUTDOWN:\n';
  t += '>Initiate controlled shutdown via the operator interface\n';
  t += '>Verify all outputs are de-energized\n';
  t += '>Apply LOTO before any maintenance work\n\n';

  t += '##SECTION## 9. TROUBLESHOOTING\n';
  t += '>CONTROLLER FAULT: Note the fault code, review recent changes, verify I/O communications\n';
  t += '>I/O COMM ERROR: Inspect cables and connectors, verify power supply, check node addresses\n';
  t += '>UNEXPECTED LOGIC: Review ladder online, check live tag values, verify sensor inputs\n';
  t += '>OUTPUT NOT ENERGIZING: Verify rung conditions, check module LEDs, inspect field wiring\n\n';

  t += '##SECTION## 10. MAINTENANCE SCHEDULE\n';
  t += '>DAILY: Check status LEDs, review alarm history log\n';
  t += '>WEEKLY: Inspect connections, backup program to maintenance folder\n';
  t += '>MONTHLY: Clean panel (LOTO), check controller battery voltage\n';
  t += '>ANNUALLY: Full functional test, calibration check, update documentation\n\n';

  t += 'Generated by ManualOS AI Manual Generator.\n';
  return t;
}

// ============================================================
// FILE CONTENT EXTRACTION — handles ACD, L5X, ZIP, XML
// ============================================================
async function extractPlcContent(file) {
  const fileExt = file.originalname.split('.').pop().toLowerCase();
  let plcContent = '';
  let method = 'unknown';

  if (fileExt === 'l5x' || fileExt === 'xml') {
    // L5X / XML: plain UTF-8 XML — the best format
    plcContent = file.buffer.toString('utf8');
    method = 'l5x-xml';
  } else if (fileExt === 'acd') {
    // ACD: RSLogix/Studio 5000 proprietary binary format
    // Contains GZIP-compressed UTF-16LE XML sections embedded in binary blob
    console.log('ACD file detected — scanning for embedded GZIP blocks...');
    const extracted = extractXmlFromAcdBuffer(file.buffer);
    if (extracted && extracted.length > 100) {
      plcContent = extracted;
      method = 'acd-gzip-utf16';
    } else {
      // Fallback: try raw buffer for any readable text
      const raw = file.buffer.toString('utf8');
      if (raw.includes('<Routine') || raw.includes('<Program')) {
        plcContent = raw;
        method = 'acd-raw-utf8';
      } else {
        plcContent = 'ACD_BINARY: ' + file.originalname + ' (' + file.size + ' bytes). ' +
          'The .ACD file format stores ladder logic in a proprietary binary database. ' +
          'For full routine details, please export to L5X format from Studio 5000: File > Save As > L5X Export.';
        method = 'acd-binary-unreadable';
      }
    }
  } else if (fileExt === 'zip' || fileExt === 'zap15') {
    try {
      const zip = new AdmZip(file.buffer);
      const zipEntries = zip.getEntries();
      const xmlEntries = zipEntries.filter(e =>
        e.entryName.endsWith('.xml') || e.entryName.endsWith('.L5X') || e.entryName.endsWith('.l5x'));
      if (xmlEntries.length > 0) {
        xmlEntries.sort((a, b) => b.header.size - a.header.size);
        plcContent = zip.readAsText(xmlEntries[0]);
        method = 'zip-xml:' + xmlEntries[0].entryName;
      } else {
        plcContent = 'ZIP file with no XML entries: ' + zipEntries.map(e => e.entryName).join(', ');
        method = 'zip-no-xml';
      }
    } catch (e) {
      plcContent = file.buffer.toString('utf8');
      method = 'zip-fallback-utf8';
    }
  } else {
    plcContent = file.buffer.toString('utf8');
    method = 'raw-utf8:' + fileExt;
  }

  if (plcContent.length > 300000) plcContent = plcContent.substring(0, 300000) + '\n... [truncated]';
  console.log('File extraction method:', method, '| content length:', plcContent.length);
  return plcContent;
}

app.post('/parse-test', upload.single('file'), async (req, res) => {
  try {
    const plcContent = await extractPlcContent(req.file);
    const plcInfo = extractPlcInfo(plcContent);
    const routineBlocks = extractRoutineBlocks(plcContent);
    const blockNames = Object.keys(routineBlocks);
    const firstBlockSample = blockNames.length > 0 ? routineBlocks[blockNames[0]].substring(0, 400) : 'NO BLOCKS';
    const rungMatch = blockNames.length > 0 ? (routineBlocks[blockNames[0]].match(/<Rung/gi) || []).length + ' rungs in first block' : 'N/A';
    res.json({
      filename: req.file.originalname, fileSize: req.file.size,
      contentLength: plcContent.length, contentSample: plcContent.substring(0, 300),
      plcInfo: { controller: plcInfo.controller, programs: plcInfo.programs, routineCount: plcInfo.routines.length, routines: plcInfo.routines.slice(0,15), tagCount: plcInfo.tags.length },
      routineBlocksFound: blockNames.length, routineBlockNames: blockNames.slice(0,15),
      firstBlockSample, rungMatch,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate-manual', upload.single('file'), async (req, res) => {
  if (req.socket) req.socket.setTimeout(0);
  res.setTimeout(0);
  try {
    const brand = (req.body && req.body.brand) || '';
    const filename = req.file ? req.file.originalname : 'unknown';

    const plcContent = req.file
      ? await extractPlcContent(req.file)
      : (req.body && req.body.plcContent) || '';

    if (!plcContent) return res.status(400).json({ error: 'No file or plcContent provided' });

    const plcInfo = extractPlcInfo(plcContent);
    const routineBlocks = extractRoutineBlocks(plcContent);
    console.log('Routines found:', plcInfo.routines.length, '| Blocks with XML:', Object.keys(routineBlocks).length);

    const routineSummaries = [];
    let usedAI = false;

    if (_hasValidKey && anthropic) {
      console.log('Using AI for per-routine summaries...');
      for (const r of plcInfo.routines) {
        const xmlBlock = routineBlocks[r.name] || '';
        const truncatedBlock = xmlBlock.length > 8000 ? xmlBlock.substring(0, 8000) + '\n...[truncated]' : xmlBlock;

        const routinePrompt =
          'You are an expert industrial automation engineer writing an operator manual.\n' +
          'Analyze the PLC routine and produce a structured summary. Use ONLY these line prefixes — no other formatting:\n' +
          '  ###ROUTINE### name\n' +
          '  ####DETAIL#### text\n' +
          '  >>Rung N: description\n\n' +
          'Required output format:\n' +
          '###ROUTINE### ' + r.name + '\n' +
          '####DETAIL#### Type: ' + (r.type || 'Ladder') + '\n' +
          '####DETAIL#### Purpose: <one sentence overall purpose>\n' +
          '####DETAIL#### Rung-by-rung functions:\n' +
          '>>Rung 0: <conditions checked and action taken>\n' +
          '(one >>Rung line per rung — cover EVERY rung)\n' +
          '####DETAIL#### Key tags: <comma-separated tag names>\n' +
          '####DETAIL#### Summary: <2-3 sentences of complete description>\n\n' +
          'Routine Name: ' + r.name + '  Type: ' + (r.type || 'Ladder') + '\n\n' +
          'Routine XML:\n' + (truncatedBlock || '(no XML content — ACD binary format; describe based on routine name only)') + '\n';

        try {
          const msg = await anthropic.messages.create({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 1200,
            messages: [{ role: 'user', content: routinePrompt }]
          });
          routineSummaries.push(msg.content[0].text.trim());
          usedAI = true;
          console.log('AI summarized:', r.name);
        } catch (e) {
          console.error('AI failed for', r.name, e.message);
          routineSummaries.push(summarizeRoutineTemplate(r.name, r.type, xmlBlock));
        }
      }
    } else {
      for (const r of plcInfo.routines) {
        routineSummaries.push(summarizeRoutineTemplate(r.name, r.type, routineBlocks[r.name] || ''));
      }
    }

    console.log('Summaries built:', routineSummaries.length);
    const manualText = assembleManual(plcInfo, routineBlocks, routineSummaries, brand, filename);
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
