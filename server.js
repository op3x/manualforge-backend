require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const AdmZip = require('adm-zip');
const zlib = require('zlib');
const {
  allowedOrigins,
  anthropicModel,
  frontendConfigProblem,
  isProduction,
} = require('./lib/config');
const {
  assertCanGenerate,
  checkoutParams,
  isStripeNotFound,
  publicAccess,
  recordStarterManual,
  verifyCheckoutSession,
} = require('./lib/billing');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function createStripe(env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !String(key).trim()) return null;
  return new Stripe(String(key).trim());
}

function createAnthropic(env) {
  const apiKey = String(env.ANTHROPIC_API_KEY || '');
  const hasValidKey = apiKey && apiKey !== 'sk-ant-...' && apiKey.startsWith('sk-ant-');
  return hasValidKey ? new Anthropic({ apiKey }) : null;
}

function sendError(res, err) {
  if (err && err.expose) {
    if (err.logMessage) console.error(err.logMessage);
    return res.status(err.status || 500).json({ error: err.message });
  }
  console.error(err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Internal server error' });
}

function readSessionId(req) {
  const fromBody = req.body && typeof req.body.session_id === 'string' ? req.body.session_id.trim() : '';
  if (fromBody) return fromBody;
  const header = req.get('x-session-id');
  return typeof header === 'string' ? header.trim() : '';
}

function extractModelText(message) {
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function anthropicBody(model, prompt) {
  const body = {
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };
  // Haiku 5.5 thinks adaptively and counts thinking toward max_tokens.
  // Routine summaries are high-volume, so keep them on low effort with thinking off.
  if (String(model).startsWith('claude-haiku-5')) {
    body.max_tokens = 2000;
    body.thinking = { type: 'disabled' };
    body.output_config = { effort: 'low' };
  }
  return body;
}

function gunzipAsync(buf) {
  return new Promise((resolve) => { zlib.gunzip(buf, (err, result) => { resolve(err ? null : result); }); });
}

function extractRoutineNamesFromBinary(buffer) {
  const names = new Set();
  const raw = buffer.toString('latin1');
  const patterns = [
    /MainRoutineName="([^"]{1,40})"/g,
    /FaultRoutineName="([^"]{1,40})"/g,
    /EventRoutineName="([^"]{1,40})"/g,
    /Routine Name="([^"]{1,40})"/g,
    /<Routine[\s][^>]*Name="([^"]{1,40})"/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(raw)) !== null) {
      const name = m[1].trim();
      if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  const routineKw = Buffer.from('Routine', 'ascii');
  for (let i = 0; i < buffer.length - 50; i++) {
    if (buffer.slice(i, i + 7).equals(routineKw)) {
      for (let j = i + 7; j < Math.min(i + 80, buffer.length); j++) {
        const c = buffer[j];
        if (c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 95) {
          let end = j;
          while (end < buffer.length && (buffer[end] >= 65 && buffer[end] <= 90 || buffer[end] >= 97 && buffer[end] <= 122 || buffer[end] >= 48 && buffer[end] <= 57 || buffer[end] === 95)) end++;
          const name = buffer.slice(j, end).toString('ascii');
          if (name.length >= 2 && name.length <= 40 && /^[A-Za-z_]/.test(name)) { names.add(name); }
          break;
        }
        if (c < 32 && c !== 9 && c !== 10 && c !== 13) break;
      }
    }
  }
  return Array.from(names);
}
async function extractXmlFromAcdBuffer(buffer) {
  const allXml = [];
  const xmlChunks = [];
  let i = 0;
  let gzipCount = 0;
  // Scan ALL gzip blocks in the file
  while (i < buffer.length - 2) {
    if (buffer[i] === 0x1F && buffer[i + 1] === 0x8B) {
      try {
        const result = await gunzipAsync(buffer.slice(i));
        if (result && result.length > 10) {
          gzipCount++;
          // Try both encodings
          let text = result.toString('utf8');
          if (!text.includes('<') && !text.includes('Routine')) {
            text = result.toString('utf16le');
          }
          if (text.includes('<') && text.length > 20) {
            allXml.push(text);
            console.log('ACD GZIP #' + gzipCount + ' @' + i + ' -> ' + result.length + 'B has XML');
          } else if (result.length > 20) {
            xmlChunks.push(text);
          }
          i += Math.max(4, result.length >> 3);
        } else { i++; }
      } catch(e) { i++; }
    } else { i++; }
  }
  console.log('ACD: found ' + gzipCount + ' gzip blocks, ' + allXml.length + ' with XML');
  const combined = allXml.join('\n') + '\n' + xmlChunks.join('\n');
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
  for (const m of xml.matchAll(/<Task[^>]*Name="([^"]+)"[^>]*(?:Period="([^"]*)")?[^>]*(?:Priority="([^"]*)")?/gi)) info.tasks.push({ name: m[1], period: m[2]||'', priority: m[3]||'' });
  for (const m of xml.matchAll(/<Program[^>]*Name="([^"]+)"/gi)) if (!info.programs.includes(m[1])) info.programs.push(m[1]);
  for (const m of xml.matchAll(/<Routine[^>]*Name="([^"]+)"[^>]*(?:Type="([^"]*)")?/gi)) info.routines.push({ name: m[1], type: m[2]||'Ladder' });
  let tc = 0; for (const m of xml.matchAll(/<Tag[^>]*Name="([^"]+)"[^>]*DataType="([^"]+)"[^>]*(?:Description="([^"]*)")?/gi)) { if (tc++ >= 50) break; info.tags.push({ name: m[1], type: m[2], desc: m[3]||'' }); }
  for (const m of xml.matchAll(/<Module[^>]*Name="([^"]+)"[^>]*(?:CatalogNumber="([^"]*)")?/gi)) info.modules.push({ name: m[1], catalog: m[2]||'' });
  return info;
}
function extractRoutineBlocks(xml) {
  const blocks = {};
  const re = /<Routine[^>]*Name="([^"]+)"[^>]*>([\s\S]*?)<\/Routine>/gi; let m;
  while ((m = re.exec(xml)) !== null) blocks[m[1]] = m[0];
  const re2 = /<Routine[^>]*Name="([^"]+)"[^>]*\/>/gi;
  while ((m = re2.exec(xml)) !== null) if (!blocks[m[1]]) blocks[m[1]] = m[0];
  return blocks;
}
function instrDesc(mn) {
  const map = { XIC:'Examine If Closed', XIO:'Examine If Open', OTE:'Output Energize', OTL:'Output Latch', OTU:'Output Unlatch', TON:'Timer On-Delay', TOF:'Timer Off-Delay', RTO:'Retentive Timer', CTU:'Count Up', CTD:'Count Down', RES:'Reset', MOV:'Move value', COP:'Copy block', CLR:'Clear', ADD:'Add', SUB:'Subtract', MUL:'Multiply', DIV:'Divide', EQU:'Equal', NEQ:'Not Equal', GRT:'Greater Than', GEQ:'Greater/Equal', LES:'Less Than', LEQ:'Less/Equal', AND:'Bitwise AND', OR:'Bitwise OR', JSR:'Jump to Sub', RET:'Return', SBR:'Subroutine', AFI:'Always False', NOP:'No Op', MSG:'Message', GSV:'Get Sys Val', SSV:'Set Sys Val', FLL:'Fill', CMP:'Compare', CPT:'Compute', LIM:'Limit', PID:'PID', PIDE:'Enhanced PID', BTD:'Bit Distribute', IOT:'Immediate Out' };
  return map[mn] || mn;
}
// Rung-level template retained with the PLC parser. Paid generation does not
// substitute this text when the model request fails; that path returns an error.
function summarizeRoutineTemplate(name, type, routineXml) {
  const lines = [];
  lines.push('###ROUTINE### ' + name);
  lines.push('####DETAIL#### Type: ' + (type || 'Ladder'));
  const hasRLContent = routineXml && (routineXml.includes('<Rung') || routineXml.includes('<Text>') || routineXml.includes('<ST>'));
  if (!routineXml || routineXml.length < 20 || !hasRLContent) {
    lines.push('####DETAIL#### Purpose: ACD binary file - ladder logic stored in proprietary format. Routine purpose inferred from name.');
    lines.push('####DETAIL#### Summary: Routine exists in program. Export as L5X for details.');
    return lines.join('\n');
  }
  const rungBlocks = []; const rungRe = /<Rung[^>]*(?:Number="([^"]*)")?[^>]*>([\s\S]*?)<\/Rung>/gi; let rm;
  while ((rm = rungRe.exec(routineXml)) !== null) rungBlocks.push({ num: rm[1]!==undefined?rm[1]:String(rungBlocks.length), xml: rm[2]||'' });
  const allInstrs = new Set(); const iRe = /\b([A-Z]{2,5})\(/g; let im;
  while ((im = iRe.exec(routineXml)) !== null) allInstrs.add(im[1]);
  const tagSet = new Set(); const tRe = /Operand="([^"]+)"/gi; let tm;
  while ((tm = tRe.exec(routineXml)) !== null) { const v = tm[1].trim(); if (v && !/^[\d\.\-]/.test(v) && v.length>1) tagSet.add(v.split('.')[0].split('[')[0]); }
  const il = Array.from(allInstrs);
  const pp = [];
  if (rungBlocks.length > 0) pp.push(rungBlocks.length + ' rung(s)');
  if (il.some(x=>['TON','TOF','RTO'].includes(x))) pp.push('timing');
  if (il.some(x=>['CTU','CTD'].includes(x))) pp.push('counting');
  if (il.includes('JSR')) pp.push('subroutine calls');
  if (il.some(x=>['PID','PIDE'].includes(x))) pp.push('PID');
  if (il.includes('MSG')) pp.push('communications');
  if (il.some(x=>['ADD','SUB','MUL','DIV','CPT'].includes(x))) pp.push('math');
  if (il.some(x=>['MOV','COP','FLL'].includes(x))) pp.push('data moves');
  lines.push('####DETAIL#### Purpose: ' + (pp.join(', ') || 'General ladder logic'));
  if (il.length > 0) lines.push('####DETAIL#### Instructions: ' + il.map(x=>x+' ('+instrDesc(x)+')').join(', '));
  if (tagSet.size > 0) lines.push('####DETAIL#### Key tags: ' + Array.from(tagSet).slice(0,20).join(', '));
  if (rungBlocks.length > 0) {
    lines.push('####DETAIL#### Rung-by-rung functions:');
    for (const rung of rungBlocks) {
      const cdM = rung.xml.match(/<Text[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/Text>/i);
      const comment = cdM ? cdM[1].trim().replace(/\s+/g,' ').substring(0,150) : '';
      const ri = new Set(); const rx = /\b([A-Z]{2,5})\(/g; let rp;
      while ((rp = rx.exec(rung.xml)) !== null) ri.add(rp[1]);
      const desc = comment || Array.from(ri).slice(0,4).map(instrDesc).join('; ') || 'Logic rung';
      const sfx = (comment && ri.size > 0) ? ' [' + Array.from(ri).join(',') + ']' : '';
      lines.push('>>Rung ' + rung.num + ': ' + desc + sfx);
    }
  } else { lines.push('####DETAIL#### No ladder rungs â may be ST/FBD or empty'); }
  lines.push('####DETAIL#### Summary: ' + [name + ' is a ' + (type||'Ladder') + ' routine containing ' + rungBlocks.length + ' rung(s).', pp.length>0?'It performs: '+pp.join(', ')+'.':'', tagSet.size>0?'Key tags: '+Array.from(tagSet).slice(0,5).join(', ')+'.':'', il.length>0?'Main instructions: '+il.slice(0,6).map(x=>instrDesc(x)).join(', ')+'.':''].filter(Boolean).join(' '));
  return lines.join('\n');
}
function generatePDF(manualText, brand, codeRefPercentage) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
    const pageW = doc.page.width, marginL = 50, contentW = pageW - 100;
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
    for (const rawLine of manualText.split('\n')) {
      const t = rawLine.trim();
      if (t === '') { doc.moveDown(0.3); continue; }
      if (t.startsWith('##SECTION##')) { const title = t.slice(11).trim(); doc.moveDown(0.6); doc.moveTo(marginL,doc.y).lineTo(pageW-marginL,doc.y).lineWidth(1.5).strokeColor('#1a1a2e').stroke(); doc.moveDown(0.25); doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a2e').text(title); doc.moveTo(marginL,doc.y).lineTo(pageW-marginL,doc.y).lineWidth(0.5).strokeColor('#aaa').stroke(); doc.moveDown(0.3); doc.fontSize(10).font('Helvetica').fillColor('#222'); continue; }
      if (t.startsWith('###ROUTINE###')) { const rName = t.slice(13).trim(); doc.moveDown(0.5); const boxY = doc.y; doc.rect(marginL,boxY,contentW,22).fillColor('#e3f2fd').fill(); doc.rect(marginL,boxY,contentW,22).strokeColor('#90caf9').lineWidth(0.5).stroke(); doc.fontSize(11).font('Helvetica-Bold').fillColor('#0d47a1').text('Routine: '+rName,marginL+8,boxY+5,{width:contentW-16,lineBreak:false}); doc.y=boxY+28; doc.moveDown(0.2); doc.fontSize(10).font('Helvetica').fillColor('#222'); continue; }
      if (t.startsWith('####DETAIL####')) { const detailText = t.slice(14).trim(); if (detailText.startsWith('Summary:')) { doc.moveDown(0.2); doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a1a2e').text(detailText, marginL+14, doc.y, {width:contentW-14}); doc.moveDown(0.1); } else { doc.fontSize(9).font('Helvetica').fillColor('#444').text(detailText, marginL+14, doc.y, {width:contentW-14}); } doc.fillColor('#222'); continue; }
      if (t.startsWith('>>')) { doc.fontSize(9).font('Helvetica').fillColor('#333').text('\u2022 '+t.slice(2).trim(), marginL+28, doc.y, {width:contentW-28}); doc.fillColor('#222'); continue; }
      if (t.startsWith('>')) { doc.fontSize(10).font('Helvetica').fillColor('#222').text('\u2022 '+t.slice(1).trim(), marginL+14, doc.y, {width:contentW-14}); continue; }
      doc.fontSize(10).font('Helvetica').fillColor('#222').text(t, marginL, doc.y, {width:contentW});
    }
    doc.end();
  });
}
function assembleManual(plcInfo, routineSummaries, brand, filename) {
  const ctrl = plcInfo.controller || filename || 'PLC System';
  const br = brand || 'Unknown';
  const date = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  let t = '##SECTION## OPERATOR MANUAL \u2014 ' + ctrl + '\n';
  t += br + ' PLC System  |  Generated by ManualOS  |  ' + date + '\n\n';
  t += '##SECTION## 1. SYSTEM OVERVIEW\n';
  t += 'Controller: ' + ctrl + '\n';
  t += 'Manufacturer: ' + br + '\n';
  t += 'File: ' + (filename || 'N/A') + '\n';
  t += 'Programs: ' + (plcInfo.programs.join(', ') || 'N/A') + '\n';
  t += 'Total Routines: ' + plcInfo.routines.length + '\n\n';
  t += '##SECTION## 2. SAFETY WARNINGS\n';
  t += '>WARNING: De-energize and LOTO all power before maintenance.\n';
  t += '>DANGER: High voltage \u2014 qualified personnel only.\n';
  t += '>CAUTION: Verify safe state before program changes or forcing I/O.\n\n';
  if (plcInfo.tasks.length) { t += '##SECTION## 3. TASKS\n'; for (const k of plcInfo.tasks) t += '>'+k.name+(k.period?'  Period:'+k.period+'ms':'')+(k.priority?'  Priority:'+k.priority:'')+'\n'; t += '\n'; }
  if (plcInfo.programs.length) { t += '##SECTION## 4. PROGRAMS\n'; for (const p of plcInfo.programs) t += '>'+p+'\n'; t += '\n'; }
  t += '##SECTION## 5. ROUTINE DESCRIPTIONS\n';
  if (routineSummaries.length === 0) {
    t += 'IMPORTANT: This .ACD file stores ladder logic in the Rockwell proprietary binary format.\n';
    t += 'Routine rung content cannot be extracted automatically from .ACD files.\n\n';
    t += 'To generate a full report with rung-by-rung routine details:\n';
    t += '>In Studio 5000 or RSLogix 5000, open this project\n';
    t += '>Go to File > Save As\n';
    t += '>Choose L5X Export as the file format\n';
    t += '>Upload the resulting .L5X file to ManualOS\n\n';
    t += 'The L5X format is standard XML that contains all routine names, rung logic, tag references,\n';
    t += 'and rung comments \u2014 enabling complete rung-by-rung summaries in this report.\n\n';
  } else {
    t += '##SECTION## ROUTINE SUMMARY OVERVIEW\n';
    for (const s of routineSummaries) {
      const nameMatch = s.match(/###ROUTINE###\s+(.+)/);
      const summaryMatch = s.match(/####DETAIL####\s+Summary:\s+(.+)/);
      const purposeMatch = s.match(/####DETAIL####\s+Purpose:\s+(.+)/);
      const rName = nameMatch ? nameMatch[1].trim() : 'Unknown';
      const rSummary = summaryMatch ? summaryMatch[1].trim() : (purposeMatch ? purposeMatch[1].trim() : 'See detailed section below.');
      t += '>' + rName + ': ' + rSummary + '\n';
    }
    t += '\n';
    t += 'Each routine has been read and analyzed separately. Detailed breakdowns are below.\n\n';
    for (const s of routineSummaries) t += s + '\n\n';
  }
  if (plcInfo.modules.length) { t += '##SECTION## 6. I/O MODULES\n'; for (const m of plcInfo.modules) t += '>'+m.name+(m.catalog?'  ('+m.catalog+')':'')+'\n'; t += '\n'; }
  if (plcInfo.tags.length) { t += '##SECTION## 7. TAG REFERENCE\n'; for (const g of plcInfo.tags) t += '>'+g.name+'  ('+g.type+')'+(g.desc?'  \u2014  '+g.desc:'')+'\n'; t += '\n'; }
  t += '##SECTION## 8. OPERATING PROCEDURES\n';
  t += 'STARTUP:\n>Verify all interlocks\n>Inspect I/O wiring\n>Apply power, verify RUN\n>Clear faults\n>Enable outputs\n\n';
  t += 'NORMAL OPERATION:\n>Monitor via HMI\n>Respond to alarms promptly\n>Log abnormal behavior\n\n';
  t += 'SHUTDOWN:\n>Initiate controlled shutdown\n>Verify outputs de-energized\n>Apply LOTO\n\n';
  t += '##SECTION## 9. TROUBLESHOOTING\n';
  t += '>CONTROLLER FAULT: Note fault code, review recent changes, verify I/O comms\n';
  t += '>I/O COMM ERROR: Inspect cables, verify power supply, check node addresses\n';
  t += '>UNEXPECTED LOGIC: Review ladder online, check live tags, verify sensors\n\n';
  t += '##SECTION## 10. MAINTENANCE SCHEDULE\n';
  t += '>DAILY: Check LEDs, review alarm history\n';
  t += '>WEEKLY: Inspect connections, backup program\n';
  t += '>MONTHLY: Clean panel (LOTO), check battery\n';
  t += '>ANNUALLY: Full test, calibration, update docs\n\n';
  t += 'Generated by ManualOS AI Manual Generator.\n';
  return t;
}
async function handleGenerate(req, res, { env, stripeClient, anthropicClient }) {
  if (req.socket) req.socket.setTimeout(0);
  res.setTimeout(0);
  try {
    const access = await assertCanGenerate(stripeClient, readSessionId(req), env);
    const brand = (req.body && req.body.brand) || '';
    const filename = req.file ? req.file.originalname : 'unknown';
    let plcContent = '';
    let fileBuffer = null;
    if (req.file) {
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      const buf = req.file.buffer;
      fileBuffer = buf;
      if (ext === 'l5x' || ext === 'xml') {
        plcContent = buf.toString('utf8');
        console.log('L5X/XML, length:', plcContent.length);
      } else if (ext === 'acd') {
        console.log('ACD binary â scanning GZIP blocks...');
        const xmlFromGzip = await extractXmlFromAcdBuffer(buf);
        if (xmlFromGzip && xmlFromGzip.match(/<Routine[\s][^>]*Name=/)) {
          plcContent = xmlFromGzip;
          console.log('ACD: found Routine XML, length:', plcContent.length);
        } else {
        const ctrlMatch = xmlFromGzip ? xmlFromGzip.match(/Name="([^"]+)"/) : null;
        const ctrlName = ctrlMatch ? ctrlMatch[1] : filename.replace(/\.ACD$/i,'');
        const routineNameSet = new Set();
        if (xmlFromGzip) { for (const rm2 of xmlFromGzip.matchAll(/(?:MainRoutineName|FaultRoutineName|EventRoutineName)="([^"]+)"/gi)) routineNameSet.add(rm2[1]); }
        // Also scan raw binary for routine names
        const binaryNames = extractRoutineNamesFromBinary(buf);
        const JUNK = new Set(['Routine','Program','Controller','Task','Tag','Description','Type','Name','Value','Module','Connection','RLL','ST','FBD','SFC','Data']);
        for (const bn of binaryNames) { if (!JUNK.has(bn)) routineNameSet.add(bn); }
        console.log('ACD binary scan found', binaryNames.length, 'names, routineNameSet size:', routineNameSet.size);
        let routinesXml = '';
        for (const rn of routineNameSet) routinesXml += '<Routine Name="'+rn+'" Type="RLL"/>';
        if (!routinesXml) routinesXml = '<Routine Name="MainRoutine" Type="RLL"/>';
        plcContent = '<RSLogix5000Content><Controller Name="'+ctrlName+'"><Programs><Program Name="MainProgram"><Routines>'+routinesXml+'</Routines></Program></Programs></Controller></RSLogix5000Content>';
        console.log('ACD: built skeleton with', routineNameSet.size||1, 'routines:', Array.from(routineNameSet).join(','));
        }
      } else if (ext === 'zip' || ext === 'zap15') {
        try {
          const zip = new AdmZip(buf);
          const entries = zip.getEntries();
          const xmlEntries = entries.filter(e => e.entryName.endsWith('.xml') || e.entryName.endsWith('.L5X') || e.entryName.endsWith('.l5x'));
          if (xmlEntries.length > 0) { xmlEntries.sort((a,b)=>b.header.size-a.header.size); plcContent = zip.readAsText(xmlEntries[0]); console.log('ZIP: extracted', xmlEntries[0].entryName); }
          else { plcContent = buf.toString('utf8'); }
        } catch(e) { plcContent = buf.toString('utf8'); }
      } else { plcContent = buf.toString('utf8'); }
    } else if (req.body && req.body.plcContent) { plcContent = req.body.plcContent; }
    if (!plcContent) return res.status(400).json({ error: 'No file or plcContent provided' });
    if (plcContent.length > 300000) plcContent = plcContent.substring(0, 300000) + '\n...[truncated]';
    const plcInfo = extractPlcInfo(plcContent);
    const routineBlocks = extractRoutineBlocks(plcContent);
    console.log('Routines:', plcInfo.routines.length, 'Blocks:', Object.keys(routineBlocks).length);
      // ACD fallback: if no routines from XML, use binary scan
      if (plcInfo.routines.length === 0 && req.file && req.file.originalname.toLowerCase().endsWith('.acd')) {
        const fallbackNames = extractRoutineNamesFromBinary(fileBuffer);
        const JUNK2 = new Set(['Routine','Program','Controller','Task','Tag','Description','Type','Name','Value','Module','Connection','RLL','ST','FBD','SFC','Data','RoutineType']);
        const useNames = fallbackNames.filter(n => !JUNK2.has(n) && n.length >= 2 && n.length <= 40);
        console.log('ACD binary fallback found', useNames.length, 'routine names:', useNames.slice(0,10).join(','));
        for (const rn of (useNames.length > 0 ? useNames : ['MainRoutine'])) plcInfo.routines.push({ name: rn, type: 'Ladder' });
      }
    const routineSummaries = [];
    const isAcdFile = req.file && req.file.originalname.toLowerCase().endsWith('.acd');
    if (plcInfo.routines.length > 0) {
      if (!anthropicClient) {
        console.error('ANTHROPIC_API_KEY is not configured');
        const unavailable = new Error('Manual generation is temporarily unavailable.');
        unavailable.status = 503;
        unavailable.expose = true;
        throw unavailable;
      }
      const model = anthropicModel(env);
      for (const r of plcInfo.routines) {
        const xmlBlock = routineBlocks[r.name] || '';
        const hasRealContent = xmlBlock.length > 50 && (xmlBlock.includes('<Rung') || xmlBlock.includes('<Text>') || xmlBlock.includes('Operand='));
        const noXml = !hasRealContent;
        const truncBlock = xmlBlock.length > 8000 ? xmlBlock.substring(0,8000)+'\n...[truncated]' : xmlBlock;
        const isAcdRoutine = isAcdFile && !hasRealContent;
        const acdNote = isAcdRoutine ? 'NOTE: This is from an ACD binary file. Only the routine name and type are available (no ladder logic rungs). Infer the purpose entirely from the routine name and common PLC patterns.\n' : '';
        const routinePrompt = 'You are an industrial automation engineer writing an operator manual.\n' + 'Produce a structured routine summary using ONLY these prefixes (no other formatting):\n' + '  ###ROUTINE### name\n  ####DETAIL#### text\n  >>Rung N: description\n\n' + 'Format:\n###ROUTINE### '+r.name+'\n####DETAIL#### Type: '+(r.type||'Ladder')+'\n####DETAIL#### Purpose: <overall purpose>\n####DETAIL#### Rung-by-rung functions:\n>>Rung 0: <describe>\n(one >>Rung line per rung)\n####DETAIL#### Key tags: <tags>\n####DETAIL#### Summary: <2-3 sentences>\n\n' + 'NO markdown, NO asterisks, NO bullets except >>\n\n' + 'Routine: '+r.name+'  Type: '+(r.type||'Ladder')+'\n' + (noXml ? acdNote + 'NOTE: No XML available. Infer from routine name only based on common PLC patterns.' : 'XML:\n'+truncBlock);
        try {
          const msg = await anthropicClient.messages.create(anthropicBody(model, routinePrompt));
          const text = extractModelText(msg);
          if (!text) throw new Error('Model returned no text');
          routineSummaries.push(text);
          console.log('AI:', model, r.name);
        } catch (e) {
          console.error('AI failed for', r.name, e && e.message ? e.message : e);
          const failed = new Error('Manual generation failed. Please try again.');
          failed.status = 502;
          failed.expose = true;
          throw failed;
        }
      }
    }
    console.log('Summaries:', routineSummaries.length);
    const manualText = assembleManual(plcInfo, routineSummaries, brand, filename);
    const codeRef = calculateCodeReferencePercentage(plcContent, manualText);
    const pdfBuffer = await generatePDF(manualText, brand, codeRef);
    if (access.plan === 'starter') {
      await recordStarterManual(stripeClient, access.paymentIntentId);
    }
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="matrix-manual-report.pdf"', 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);
  } catch (err) {
    return sendError(res, err);
  }
}

function logWebhookEvent(event) {
  const object = event.data && event.data.object ? event.data.object : {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
      console.log(event.type, object.id, object.payment_status);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      console.log(event.type, object.id, object.status);
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'charge.refunded':
    case 'charge.dispute.created':
    case 'radar.early_fraud_warning.created':
      console.log(event.type, object.id);
      break;
    default:
      console.log('Unhandled event:', event.type);
  }
}

function createApp({ env = process.env, stripe, anthropic } = {}) {
  const stripeClient = stripe !== undefined ? stripe : createStripe(env);
  const anthropicClient = anthropic !== undefined ? anthropic : createAnthropic(env);
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins(env).has(origin)) return callback(null, true);
      return callback(null, false);
    },
  }));
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'manualos-backend', aiEnabled: Boolean(anthropicClient) });
  });
  app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!stripeClient || !secret) {
      console.error('Webhook rejected: STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set');
      return res.status(400).send('Webhook signature verification failed');
    }
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err && err.message ? err.message : err);
      return res.status(400).send('Webhook signature verification failed');
    }
    logWebhookEvent(event);
    return res.json({ received: true });
  });
  app.use(express.json({ limit: '1mb' }));
  app.post('/create-checkout-session', async (req, res) => {
    try {
      if (!stripeClient) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      const plan = req.body && req.body.plan;
      const params = checkoutParams(plan, env);
      const session = await stripeClient.checkout.sessions.create(params);
      if (!session || !session.url) {
        console.error('Stripe Checkout Session did not include a URL');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      return res.json({ url: session.url });
    } catch (err) {
      return sendError(res, err);
    }
  });
  app.get('/verify-session', async (req, res) => {
    try {
      const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
      if (!sessionId) return res.status(400).json({ error: 'session_id is required' });
      if (!stripeClient) {
        console.error('STRIPE_SECRET_KEY is not set');
        return res.status(500).json({ error: 'Checkout is temporarily unavailable.' });
      }
      const access = await verifyCheckoutSession(stripeClient, sessionId, env);
      return res.json(publicAccess(access));
    } catch (err) {
      if (isStripeNotFound(err)) return res.json({ valid: false, plan: null, remaining: null });
      return sendError(res, err);
    }
  });
  app.post('/generate-manual', upload.single('file'), (req, res, next) => {
    handleGenerate(req, res, { env, stripeClient, anthropicClient }).catch(next);
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error(err && err.stack ? err.stack : err);
    if (err && err.name === 'MulterError') {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : 'Upload failed.';
      return res.status(400).json({ error: message });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON body.' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function prepareListen(env = process.env, exit = process.exit) {
  const problem = frontendConfigProblem(env);
  if (!problem) return true;
  const line = `FRONTEND_URL problem: ${problem}. Checkout redirects and browser CORS will not work.`;
  if (isProduction(env)) {
    console.error(`FATAL: ${line} Refusing to start.`);
    exit(1);
    return false;
  }
  console.warn(`WARNING: ${line}`);
  return true;
}

function start() {
  if (!prepareListen(process.env)) return null;
  const port = process.env.PORT || 3001;
  const app = createApp();
  return app.listen(port, () => {
    console.log('ManualOS backend running on port ' + port);
  });
}

if (require.main === module) start();

module.exports = { createApp, prepareListen, start };
