const sectionModel = require('../../data/section-model.json');
const { escapeHtml, humanize, sanitizeProse, scrubField, isTemplateHeading, deviceTypeLabel } = require('../text');
const { matchedHazards, hazardsForSection, hazardsForSubsystem, renderHazard, isStaticPart } = require('../hazards');
const { buildSubsystems } = require('../subsystems');
const { assertCoverage, containsRawSource } = require('../logic');
const {
  displayProductName, fallbackNarrative, detectKind, mergedRef, cleanAlarm, notAnAlarmMessage, alarmsOverlap, uniqueSentences, wrapWords,
  readablePartName,
} = require('../presentation');
const { manualDate } = require('./date');
const { energyTable } = require('../documents/equipment');

const gaps = [];
let activeProject = null;
const AUTHORING = /read every rung|never paraphrase|table: device, location|plain-language table of conditions|pull from plc safety|prompt_guidance/i;

function productTitle(project) {
  return displayProductName(project);
}

function needs(detail) {
  const text = String(detail || '').replace(/^NEEDS INPUT:\s*/i, '').replace(/\s+/g, ' ').trim();
  if (!text || AUTHORING.test(text)) return null;
  if (activeProject && hasPlc(activeProject) && /upload the plc program/i.test(text)) return null;
  const key = text.toLowerCase();
  if (gaps.some((item) => redundantGap(item, key))) return null;
  gaps.push(text);
  return null;
}

function redundantGap(existing, candidate) {
  const left = String(existing || '').toLowerCase();
  const right = String(candidate || '').toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (/upload the plc program/.test(left) && /upload the plc program/.test(right)) return true;
  if (/emergency[- ]stop/.test(left) && /emergency[- ]stop/.test(right)) return true;
  if (/storage temperature/.test(left) && /storage temperature/.test(right)) return true;
  return false;
}

function shortNeed(spec) {
  const title = String((spec && spec.title) || 'this section').replace(/\{\{[^}]+\}\}/g, '').trim() || 'this section';
  if (/^control logic description$/i.test(title)) return '';
  return `Supply the information for ${title}.`;
}

function pack(blocks) {
  return (blocks || []).flat().filter(Boolean);
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
  return hazards.map((hazard) => ({ type: 'hazard', hazard: renderHazard(hazard, subsystemName) }));
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

function memberPhrase(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!key) return '';
  if (/\b(hh|high high|high high alarm)\b/.test(key)) return 'high-high';
  if (/\b(ll|low low|low low alarm)\b/.test(key)) return 'low-low';
  if (key === 'h' || key === 'hi' || /\bhigh alarm\b/.test(key)) return 'high';
  if (key === 'l' || key === 'lo' || /\blow alarm\b/.test(key)) return 'low';
  return '';
}

function alarmSubject(text, tag) {
  const source = `${text || ''} ${(tag && tag.description) || ''} ${(tag && tag.name) || ''}`.replace(/[_./]+/g, ' ');
  const named = source.match(/\b([A-Za-z][A-Za-z0-9]*)\s+(\d+)\b/);
  const signal = source.match(/\b(level|temperature|pressure|flow|weight|speed)\b/i);
  let device = named ? `${named[1]} ${named[2]}` : '';
  if (!device && tag) device = humanize(String(tag.name).split(/[.]/)[0].split('_')[0]) || '';
  return { device: device || 'Equipment', signal: signal ? signal[1].toLowerCase() : '' };
}

function alarmClass(severity, message, cause) {
  const blob = `${severity || ''} ${message || ''} ${cause || ''}`.toLowerCase();
  if (/warning|alert/.test(blob) && !/fault|trip|emergency/.test(blob)) return 'Warning';
  if (/trip|emergency|e-?stop/.test(blob)) return 'Trip';
  if (/interlock|guard|door/.test(blob) && !/fault|trip/.test(blob)) return 'Interlock';
  return 'Fault';
}

const MANUAL_ALARM_LIMIT = 40;

function isTagOrConfigText(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  if (/^(cfg|config|hmi|sts|inp|out)_/i.test(raw)) return true;
  if (/^(configure|configuration|enable|debounce|alarm timer|udef)\b/i.test(raw)) return true;
  if (/to hmi$/i.test(raw) || /status to hmi/i.test(raw)) return true;
  if (/\bclear fault\b/i.test(raw)) return true;
  if (/\b(last\s*fault\s*code|fault\s*code\s*list|list\s*of\s*fault\s*codes|fsc control)\b/i.test(raw)) return true;
  if (/\b(cfg|udef)\b/i.test(raw) && raw.length < 80) return true;
  if (/alarms in bypass|alarms in out of service|out of service|bypass hmi|alarm bypass/i.test(raw)) return true;
  if (/^(sts|cmd|hmi|inp)\b/i.test(raw)) return true;
  if (/\b(sts|cmd|alm)$/i.test(raw) && raw.split(' ').length <= 5) return true;
  const words = raw.split(' ');
  if (words.length === 1 && /[a-z][A-Z]/.test(words[0]) && !/^pH$/i.test(words[0])) return true;
  if (words.some((token) => tagShapedCamel(token))) return true;
  return false;
}

function tagShapedCamel(token) {
  if (!/[a-z][A-Z]/.test(token) || /^pH$/i.test(token)) return false;
  if (token.includes('_')) return true;
  return /^(sts|cmd|cfg|inp|out|hmi)/i.test(token);
}

function tagDerivedConfig(value) {
  const raw = String(value || '').trim().replace(/[.\s]+$/, '');
  if (!raw) return false;
  if (/(?:setpoint|preset)$/i.test(raw)) return true;
  if (/(?:^|[^A-Za-z])sp$/i.test(raw)) return true;
  if (/acknowledge/i.test(raw)) return true;
  if (/(?:^|[^A-Za-z])ack(?:[^A-Za-z]|$)/i.test(raw)) return true;
  if (/_OK$/i.test(raw)) return true;
  if (/\bpermissive ok\b/i.test(raw)) return true;
  return false;
}

function isConfigCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return false;
  if (/^(cfg|config|hmi|sts|inp|out)_/i.test(raw)) return true;
  if (/\b(cfg|udef)\b/i.test(raw) && raw.length < 80) return true;
  return false;
}

function isConfigAlarm(code, text) {
  return isTagOrConfigText(text) || isConfigCode(code);
}

function stopRemedy(remedy, severity, message) {
  const text = uniqueSentences(remedy || '') || 'Correct the condition, then press Reset.';
  if (/stop reaction/i.test(text)) return text;
  const blob = `${severity || ''} ${message || ''} ${text}`.toLowerCase();
  let reaction = 'Stop reaction: the equipment stops and stays stopped until Reset.';
  if (/warning|alert/.test(blob) && !/fault|trip|emergency/.test(blob)) {
    reaction = 'Stop reaction: the equipment keeps running and the warning stays on until the condition clears.';
  } else if (/trip|emergency|e-?stop/.test(blob)) {
    reaction = 'Stop reaction: hazardous motion stops immediately and stays stopped until the trip is cleared and Reset is pressed.';
  } else if (/interlock|guard|door/.test(blob)) {
    reaction = 'Stop reaction: motion stops while the guard is open and stays stopped until the guard is closed and Reset is pressed.';
  }
  if (/stop/i.test(text) && /reset/i.test(text) && !/warning/.test(blob)) return text;
  return `${text} ${reaction}`;
}

const NEAR_STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'its', 'it', 'this', 'that', 'for', 'with', 'on', 'in', 'at', 'from', 'by', 'into', 'when', 'while', 'after', 'before', 'than', 'then', 'alarm', 'alarms']);
const NEAR_GENERIC = new Set(['status', 'state', 'condition', 'reports', 'reported', 'report', 'given', 'shows', 'detected']);
const FAULT_WORD = /^(fault|faulted|faults|faulting|failed|failure|fail|offline|lost|trip|tripped|tripping)$/;

function nearAlarmParts(text) {
  const raw = String(text || '').toLowerCase();
  let limit = '';
  if (/\b(high[\s-]*high|hi[\s-]*hi)\b/.test(raw)) limit = 'high-high';
  else if (/\blow[\s-]*low\b/.test(raw)) limit = 'low-low';
  else if (/\bhigh\b/.test(raw)) limit = 'high';
  else if (/\blow\b/.test(raw)) limit = 'low';
  let signal = '';
  if (/\btemperature\b/.test(raw)) signal = 'temperature';
  else if (/\blevel\b/.test(raw)) signal = 'level';
  else if (/\bpressure\b/.test(raw)) signal = 'pressure';
  else if (/\bflow\b/.test(raw)) signal = 'flow';
  const numbers = [...raw.matchAll(/\d+/g)].map((match) => match[0]);
  const tokens = raw.replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean).map((token) => {
    if (token === 'communications') return 'communication';
    if (token === 'modules') return 'module';
    if (token === 'drives') return 'drive';
    return token;
  });
  return {
    limit,
    signal,
    numbers,
    fault: tokens.some((token) => FAULT_WORD.test(token)),
    core: tokens.filter((token) => !NEAR_STOP.has(token) && !NEAR_GENERIC.has(token) && !FAULT_WORD.test(token) && !/^\d+$/.test(token)),
  };
}

function nearDuplicateAlarm(left, right) {
  const a = nearAlarmParts(left);
  const b = nearAlarmParts(right);
  if (!a.fault || !b.fault) return false;
  if (a.limit && b.limit && a.limit !== b.limit) return false;
  if (a.signal && b.signal && a.signal !== b.signal) return false;
  if (a.numbers.join(' ') !== b.numbers.join(' ')) return false;
  const shorter = a.core.length <= b.core.length ? a.core : b.core;
  const longer = a.core.length <= b.core.length ? b.core : a.core;
  if (!shorter.length) return false;
  return shorter.every((token) => longer.includes(token));
}

function alarmRows(project) {
  const rows = [];
  const fingerprints = [];
  let serial = 0;
  const push = (row) => {
    if (!row[1] || row[1] === '—' || notAnAlarmMessage(row[1])) return;
    const fingerprint = ['', row[1]];
    if (fingerprints.some((existing) => alarmsOverlap(existing, fingerprint) || nearDuplicateAlarm(existing[1], fingerprint[1]))) return;
    fingerprints.push(fingerprint);
    serial += 1;
    rows.push([`ALM-${serial}`, row[1], row[2], row[3], row[4]]);
  };
  const emit = (code, text, cause, remedy, severity, tag) => {
    if (isConfigAlarm(code, text)) return;
    const phrase = memberPhrase(code) || memberPhrase(text) || memberPhrase(String(text || '').split(/\s+/).pop());
    const subject = alarmSubject(text, tag);
    const message = phrase
      ? [subject.device, subject.signal, phrase].filter(Boolean).join(' ')
      : uniqueSentences(sanitizeProse(text || '', project));
    if (!message || isConfigAlarm(code, message)) return;
    const klass = alarmClass(severity, message, cause);
    const alarm = cleanAlarm({
      code: phrase ? code : (code || ''),
      text: message,
      cause: sanitizeProse(cause || '', project),
      remedy: sanitizeProse(stopRemedy(remedy, klass, message), project),
      severity: klass,
    });
    if (!alarm) return;
    push([
      code || '',
      alarm.text || message,
      alarm.severity || klass,
      alarm.cause || 'See the condition named in the message.',
      alarm.remedy || stopRemedy('', klass, message),
    ]);
  };
  for (const routine of project.routines) {
    for (const raw of routine.analysis?.alarms || []) {
      emit(raw.code, raw.text || raw.message, raw.cause, raw.remedy, raw.severity);
    }
  }
  for (const tag of project.tags) {
    if (!/^BOOL$/i.test(String(tag.dataType || '').trim())) continue;
    if (!/alarm|fault|\bhh\b|high_high/i.test(`${tag.description} ${tag.name}`)) continue;
    if (isConfigAlarm(tag.name, tag.description)) continue;
    if (tagDerivedConfig(tag.name) || tagDerivedConfig(tag.description)) continue;
    const described = String(tag.description || '').trim();
    if (described && !/\b(alarm|fault|trip|high|low|range)\b/i.test(described)) continue;
    if (/^device alarm$/i.test(described)) continue;
    emit(String(tag.name).split('.').pop(), described || tag.name, '', 'Correct the condition, then press Reset.', 'Fault', tag);
  }
  return rows;
}

function svgText(x, y, lines, size = 10) {
  return lines.map((line, index) => `<tspan x="${x}" y="${y + index * (size + 2)}">${escapeHtml(line)}</tspan>`).join('');
}

function layoutSvg(project, subsystems) {
  const items = subsystems.filter((item) => item.role !== 'structure').slice(0, 6);
  const points = (project.cad && project.cad.points) || [];
  if (points.length >= 12) {
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const dots = points.map((point) => {
      const x = 24 + ((point[0] - minX) / spanX) * 360;
      const y = 28 + (1 - (point[1] - minY) / spanY) * 150;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.4" fill="#2c4a68"/>`;
    }).join('');
    const markers = items.map((item, index) => {
      const point = points[Math.min(points.length - 1, Math.floor(((index + 1) * points.length) / (items.length + 1)))] || points[0];
      const x = 24 + ((point[0] - minX) / spanX) * 360;
      const y = 28 + (1 - (point[1] - minY) / spanY) * 150;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="#ffffff" stroke="#13314f"/>
        <text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="#13314f">${index + 1}</text>`;
    }).join('');
    const leaders = items.map((item, index) => {
      const x = 16 + (index % 2) * 200;
      const y = 196 + Math.floor(index / 2) * 28;
      const lines = wrapWords(`${index + 1}. ${item.name}`, 28).slice(0, 2);
      return `<text font-size="10" fill="#13314f">${svgText(x, y, lines, 10)}</text>`;
    }).join('');
    const legendRows = Math.ceil(items.length / 2) || 0;
    return `<svg viewBox="0 0 420 ${200 + legendRows * 28}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Helvetica" font-size="11">
      <text x="16" y="14" fill="#555">${escapeHtml(items.length ? 'Assembly view' : 'Model view')}</text>
      ${dots}
      ${markers}
      ${leaders}
    </svg>`;
  }
  if (!items.length) return '';
  const width = 132;
  const boxes = items.map((item, index) => {
    const lines = wrapWords(item.name, 16).slice(0, 4);
    const height = 36 + lines.length * 14;
    const x = 16 + index * (width + 14);
    return `<rect x="${x}" y="36" width="${width}" height="${height}" fill="#dfe6ee" stroke="#34495e"/>
      <text x="${x + width / 2}" y="54" text-anchor="middle">${index + 1}</text>
      <text text-anchor="middle" font-size="10">${svgText(x + width / 2, 70, lines)}</text>`;
  });
  const total = 16 + items.length * (width + 14);
  const kind = (project.narrative && project.narrative.kind) || 'machine';
  const caption = kind === 'machine' ? 'Stations' : 'Arrangement';
  return `<svg viewBox="0 0 ${Math.max(total, 320)} 160" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Helvetica" font-size="11">
    <text x="16" y="20" fill="#555">${caption}</text>
    ${boxes.join('')}
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

function documentDate(project, options = {}) {
  const env = options.env || process.env;
  const fromEnv = env && typeof env.MANUALOS_TZ === 'string' ? env.MANUALOS_TZ.trim() : '';
  const timeZone = (options.timeZone && String(options.timeZone).trim()) || fromEnv || 'America/Chicago';
  const requested = options.date != null && String(options.date).trim() !== ''
    ? options.date
    : (project.identity && project.identity.manualDate);
  return manualDate({
    now: options.now != null ? new Date(options.now) : new Date(),
    timeZone,
    clientDate: requested,
  });
}

function buildDocument(project, options = {}) {
  gaps.length = 0;
  activeProject = project;
  if (!project.narrative) project.narrative = fallbackNarrative(project);
  if (project.routines.some((routine) => routine.units.length)) assertCoverage(project);
  else project.coverage = { units: 0, accounted: 0, percent: 100, missing: [], ok: true };
  const hazards = matchedHazards(project);
  const subsystems = buildSubsystems(project, hazards);
  project.subsystems = subsystems;
  const title = productTitle(project);
  const model = project.identity.model || '—';
  const docNo = project.identity.docNumber || '';
  const revision = project.identity.revision || 'A';
  const date = documentDate(project, options);
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
    const beforeGaps = gaps.length;
    const blocks = contentFor(spec, { project, hazards, subsystems, title, date });
    if (!blocks) {
      if (spec.required && gaps.length === beforeGaps) needs(shortNeed(spec));
      continue;
    }
    const sectionTitle = spec.id === 'product.subsystem_function' ? null : spec.title;
    if (spec.id === 'product.subsystem_function') {
      if (!blocks.length) continue;
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
  if (gaps.length) {
    const front = chapters.find((chapter) => chapter.number === '0') || chapters[0];
    if (front) {
      front.sections.splice(Math.min(1, front.sections.length), 0, {
        id: 'front.inputs',
        title: 'Information to supply',
        blocks: [
          paragraph('Supply the items below before this manual is issued. They were not in the uploaded files.'),
          { type: 'ul', items: gaps.slice(0, 12).map((item) => item.replace(/NEEDS INPUT:?/gi, '').trim()) },
        ],
      });
    }
  }
  let figure = 0;
  for (const chapter of chapters) {
    chapter.sections.forEach((section, index) => {
      section.number = `${chapter.number}.${index + 1}`;
      section.anchor = `s${chapter.number}-${index + 1}`;
      section.inferred = section.blocks.some((block) => block.inferred || (block.rowInferred || []).some(Boolean));
      for (const block of section.blocks) {
        if (block.type === 'figure') {
          figure += 1;
          block.caption = `Figure ${figure}. ${block.caption || 'View'}`;
        }
      }
    });
  }
  const doc = {
    meta: {
      title,
      model,
      docNumber: docNo || '',
      revision,
      date,
      language: project.identity.language,
      manufacturer: project.identity.manufacturerName || '—',
      headerLeft: `${title} · Operating and Maintenance Manual`,
      headerRight: [docNo, `Rev. ${revision}`].filter(Boolean).join(' · '),
      footerLeft: project.identity.manufacturerName || title,
    },
    cover: {
      manufacturer: project.identity.manufacturerName || '—',
      title,
      model,
      docNumber: docNo || '',
      revision,
      date,
      language: project.identity.language,
      serial: project.identity.serialPlaceholder,
      svg: layoutSvg(project, subsystems),
    },
    chapters: chapters.filter((chapter) => chapter.sections.length),
  };
  const seen = new Set();
  let removed = 0;
  const scrub = (value) => {
    const result = scrubField(value, project);
    for (const snippet of result.snippets) {
      if (!snippet || seen.has(snippet)) continue;
      seen.add(snippet);
      removed += 1;
    }
    return result.text;
  };
  for (const chapter of doc.chapters) {
    for (const section of chapter.sections) {
      const titleText = isTemplateHeading(section.title) ? section.title : scrub(section.title);
      section.title = titleText || section.title;
      for (const block of section.blocks) {
        if (block.allowIdentifiers) continue;
        if (block.text) block.text = scrub(block.text);
        if (block.title) block.title = scrub(block.title);
        if (Array.isArray(block.items)) {
          block.items = block.items.map((item) => (
            typeof item === 'string'
              ? scrub(item)
              : { ...item, action: scrub(item.action || ''), expect: scrub(item.expect || '') }
          ));
        }
        if (block.type === 'table' && Array.isArray(block.rows)) {
          block.rows = block.rows.map((row) => row.map((cell) => scrub(cell)));
        }
        if (block.type === 'hazard' && block.hazard) {
          block.hazard = {
            ...block.hazard,
            hazard: scrub(block.hazard.hazard),
            consequence: scrub(block.hazard.consequence),
            avoidance: (block.hazard.avoidance || []).map((step) => scrub(step)),
          };
        }
      }
    }
  }
  seen.clear();
  if (!project.warnings) project.warnings = [];
  if (removed) {
    const message = `Raw identifier removed from generated text: count=${removed} category=identifier`;
    project.warnings.push(message);
    console.error(message);
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
      [[project.identity.revision || 'A', ctx.date, `Generated from ${project.sources.map((source) => `${source.name} ${source.sha256}`).join('; ') || 'uploaded files'}`, 'ManualOS']],
      { widths: ['14%', '16%', '50%', '20%'] },
    )],
    'front.about': () => [
      paragraph(`This manual explains how to transport, install, commission, operate, maintain, and decommission the ${title}. It is written for operators, maintenance technicians, and installers.`),
      paragraph('Keep a printed or saved copy with the machine for its whole service life. A digital copy must remain downloadable and printable.'),
      bullets([
        'Read the safety chapter before any other task.',
        'Companion documents you still need to file with this manual: electrical drawings, pneumatic or hydraulic diagrams, the parts catalog, and vendor component manuals.',
        project.acdConverted ? 'The controller program was read from the ACD upload by converting it to L5X.' : '',
        project.acdLimited ? 'The control description is incomplete until you replace the ACD upload with an L5X export. No rung text was invented from the ACD file.' : 'Statements marked Inferred - please confirm were derived from the uploaded engineering files.',
        project.acdConverted && (project.routines || []).some((routine) => routine.unreadReason)
          ? `These routines could not be extracted: ${(project.routines || []).filter((routine) => routine.unreadReason).map((routine) => humanize(routine.name) || routine.name).join(', ')}. Export the project as .l5x to include each one.`
          : '',
        project.cad.meshOnly ? 'The CAD upload is an STL triangle mesh. This manual reports overall size and approximate shape only. It does not name features, holes, or assembly parts. Export STEP for a complete model.' : '',
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
      paragraph(`${title} is industrial equipment. Use it only for the product and limits on the nameplate and in the technical data.`),
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
      paragraph('Fit the labels below. Confirm the part numbers against the machine as built.'),
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
      paragraph('Protect the controller from unauthorized changes. Give each person a unique account. Do not leave remote access open.'),
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
        ['Manufacturer', project.identity.manufacturerName || '—'],
        ['Model', project.identity.model || '—'],
        ['Serial number', 'Write the serial number from the nameplate'],
        ['Supply, full-load current, SCCR', '—'],
        ['Air or hydraulic supply', '—'],
        ['Mass', '—'],
      ]),
    ],
    'transport.lifting': () => [
      paragraph(`Lift ${title} only at the marked points, with gear rated above the mass on the nameplate.`),
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
    'install.utilities': () => {
      const energies = energyTable(project).map((row) => row[0]);
      const rows = [
        ['Electrical supply', '—'],
        ['Protective device', '—'],
      ];
      if (energies.includes('Pneumatic')) rows.push(['Compressed air', 'Connect dry, filtered air at the pressure on the nameplate.']);
      if (energies.includes('Hydraulic')) rows.push(['Hydraulic supply', '—']);
      if (energies.includes('Steam or heat')) rows.push(['Steam or heat', '—']);
      if (energies.includes('Process fluid')) rows.push(['Process fluid', '—']);
      rows.push(['Grounding', 'Connect the protective earth before you switch on.']);
      return [
        paragraph('Compare the supply with the nameplate before you connect anything.'),
        table(['Utility', 'Requirement'], rows),
        ...hazardBlocks(hazardsForSection(hazards, 'install.utilities').slice(0, 3)),
      ];
    },
    'install.controls': () => [
      paragraph('External control and network connections are listed with the I/O appendix. Confirm the host-line handshake before production.'),
    ],
    'commission.prestart': () => [
      steps([
        { action: 'Confirm every guard is fitted and closed, and that nobody is inside the safeguarded space.', expect: 'The safeguarded space is empty and every guard is closed.' },
        { action: 'Confirm the supply voltage, phase rotation, and fluid levels against the nameplate.', expect: 'The supplies match the nameplate and motion is in the marked direction.' },
        { action: 'Test each emergency stop and each guard interlock. Record the result.', expect: 'Each safety device stops motion, and motion does not restart until Reset.' },
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
      paragraph(`During production, watch the ${title} from the operator position. Keep material supplied and answer alarms before the machine stops on a fault.`),
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
    'trouble.table': () => troubleSection(ctx),
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
      paragraph('Test each safety device at the interval in the maintenance schedule. A safety device passes only if motion stops and does not restart until Reset. Record the result. Take the machine out of service if a test fails.'),
      (devicesSection(project).find((block) => block && block.type === 'table')) || needs('Name each safety device and how to test it.'),
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
      paragraph('Dispose of the machine under local rules. Separate steel, electrical equipment (WEEE), batteries, oils, and other fluids.'),
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
  if (!builder) {
    needs(shortNeed(spec));
    return null;
  }
  const blocks = pack(builder());
  if (!blocks.length) return null;
  return blocks;
}

function installSite(ctx) {
  const box = ctx.project.cad.boundingBox;
  const dims = box
    ? box.min.map((value, index) => Math.round((box.max[index] - value) * 1000) / 1000).join(' × ')
    : '';
  return [
    paragraph(`Prepare a level foundation that can carry ${ctx.title} and the dynamic loads of its motion.`),
    table(['Item', 'Requirement'], [
      ['Floor', 'Level, load-bearing, and clear of other equipment by the service access on the general arrangement.'],
      ['Footprint', dims || '—'],
      ['Service access', 'Leave space to open every door and to remove the longest part.'],
      ['Environment', '—'],
    ], { inferred: Boolean(dims) }),
    needs('Add the foundation drawing, the anchor pattern, and the required floor loading.'),
  ];
}

function dangerZones(ctx) {
  if (!ctx.subsystems.length && !ctx.project.cad.boundingBox && !(ctx.project.cad.points || []).length) {
    return [needs('Describe the operator positions and danger zones.')];
  }
  const kind = (ctx.project.narrative && ctx.project.narrative.kind) || detectKind(ctx.project);
  if (kind === 'calculation') {
    return [paragraph(`There is no guarded motion in this calculation. Work on ${ctx.title} with the controller isolated if you open the cabinet.`)];
  }
  return [paragraph(`Stay outside the guarded space during automatic operation. Work on ${ctx.title} only from the operator position unless you have selected setup mode and the procedure allows entry. The assembly view in the machine description shows the callouts.`)];
}

function devicesSection(project) {
  const devices = safetyDevices(project);
  const blocks = [];
  if (project.safetyPrograms.length || project.safetyTasks.length) {
    const safetyNames = [...project.safetyPrograms, ...project.safetyTasks].map((name) => humanize(name)).filter(Boolean);
    blocks.push(paragraph(`A safety task is present${safetyNames.length ? ` (${safetyNames.join(', ')})` : ''}. Treat that logic as a safety function. This manual does not authorise a change to it.`));
  }
  if (!devices.length && !blocks.length) {
    needs('Name each emergency stop, door interlock, light curtain, and safe-torque-off device.');
    return [];
  }
  if (!devices.length) return blocks;
  blocks.push(table(
    ['Device', 'What it does', 'How to test', 'Interval'],
    devices.slice(0, 24).map((tag) => [
      tag.description || humanize(tag.name) || 'Safety device',
      /estop|e-stop|emergency/i.test(`${tag.description} ${tag.name}`) ? 'Stops motion. Reset does not restart the machine.' : 'Prevents motion while the guard or switch is open or interrupted.',
      'Operate it and confirm motion stops and stays stopped until Reset.',
      'Daily',
    ]),
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
  const rows = energyTable(project);
  return [
    paragraph('Lock out every energy source before you enter the guarded space, clean inside the guards, or replace a part.'),
    table(['Energy', 'Isolation point', 'Release stored energy', 'Verify zero energy'], rows),
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
  const { subsystems, project } = ctx;
  if (!subsystems.length && !hasPlc(project) && !(project.cad.assemblies || []).length) {
    return [needs('Upload the PLC program, a CAD assembly, or a specification that says what the machine does.')];
  }
  const narrative = project.narrative || fallbackNarrative(project);
  return [paragraph(narrative.overview, true)];
}

function layoutSection(ctx) {
  const narrative = ctx.project.narrative || fallbackNarrative(ctx.project);
  const kind = narrative.kind || detectKind(ctx.project);
  if (!ctx.subsystems.length && kind !== 'calculation' && !(ctx.project.cad.points || []).length) {
    return [needs('Upload a CAD assembly or a PLC program so the arrangement can be drawn.')];
  }
  const blocks = [paragraph(narrative.cycle || narrative.overview, true)];
  const svg = layoutSvg(ctx.project, ctx.subsystems);
  if (svg) {
    const callouts = ctx.subsystems.filter((item) => item.role !== 'structure').slice(0, 6).map((item) => item.name);
    blocks.push({
      type: 'figure',
      svg,
      caption: ctx.project.cad.meshOnly
        ? 'Overall size of the STL triangle mesh. The file has no features or part names.'
        : kind === 'structure' || (ctx.project.cad.points || []).length
          ? 'View projected from the uploaded solid model. Callouts name the assemblies.'
          : 'Arrangement of the functions found in the upload.',
      callouts,
      inferred: true,
    });
  }
  return blocks;
}

function componentsSection(ctx) {
  if (!ctx.subsystems.length) return [needs('Upload the top-level CAD assembly or the PLC program so each assembly can be named by its function.')];
  return [table(
    ['Item', 'Assembly', 'Function'],
    ctx.subsystems.map((item, index) => [String(index + 1), item.name, item.purpose]),
  )];
}

function operatorLine(item, kind) {
  if (/\bdoor\b/i.test(item.name) && !/frame and guarding/i.test(item.name)) {
    return 'Open the door only after motion has stopped. Close it and confirm the interlock before you start.';
  }
  const blob = `${item.name} ${(item.components || []).join(' ')} ${(item.motions || []).join(' ')}`;
  const moves = !isStaticPart(item) && item.role !== 'structure'
    && /\b(conveyor|belt|roller|motor|cylinder|gripper|wheel|servo|valve|pump|robot|spindle|pulley|actuator|solenoid|heater|axis)\b/i.test(blob);
  if (!moves) return 'This part does not move. Keep every guard fitted while the equipment runs.';
  if (kind === 'calculation') return 'Confirm the measured inputs. No operator action runs during the calculation.';
  if (kind === 'process') return 'Watch the vessels and answer alarms from outside the guarded space.';
  return 'Stay outside the guards while it moves.';
}

function subsystemSections(ctx) {
  if (!ctx.subsystems.length) {
    needs('Describe each subsystem: what it does, how it moves, its sensors, and its interlocks.');
    return [];
  }
  const kind = (ctx.project.narrative && ctx.project.narrative.kind) || detectKind(ctx.project);
  return ctx.subsystems.map((item) => {
    const localHazards = isStaticPart(item) ? [] : hazardsForSubsystem(ctx.hazards, item).slice(0, 2);
    const equationish = (text) => containsRawSource(text) || /\bis set to\b|\bblock with\b|the control (sets|turns|checks|selects|acts)/i.test(text);
    const motionCandidates = [...item.motions].map((text) => String(text || '').trim()).filter((text) => text && !equationish(text));
    const motion = motionCandidates.find((text) => !/www\.|https?:|supports the function described above/i.test(text) && !/^none\.?$/i.test(text))
      || (kind === 'calculation' ? 'The calculation reads the measured inputs and writes the result. Nothing moves.' : '')
      || 'None identified in the upload.';
    const sensors = presentList(item.sensors);
    const components = presentList(item.components);
    const interlocks = presentList(item.interlocks);
    return {
      title: item.name,
      blocks: [
        paragraph(item.purpose, true),
        {
          type: 'table',
          className: 'fact',
          headers: ['', ''],
          rows: [
            ['Main components', components],
            ['How it moves', motion],
            ['Sensors', sensors],
            ['Interlocks', interlocks],
            ['Operator', operatorLine(item, kind)],
            ['Program reference', mergedRef(item.groups) || 'No control logic was linked to this subsystem.'],
          ],
          rowInferred: [false, true, false, true, false, false],
        },
        ...item.groups.slice(0, 3).map((group) => group.text).filter((text) => text && text !== motion && !equationish(text)).map((text) => paragraph(text)),
        ...hazardBlocks(localHazards, item.name),
      ],
    };
  });
}

function sequenceSection(ctx) {
  const kind = (ctx.project.narrative && ctx.project.narrative.kind) || detectKind(ctx.project);
  const narrative = ctx.project.narrative || fallbackNarrative(ctx.project);
  if (!ctx.subsystems.length && !narrative.cycle) {
    return [needs('Upload the PLC main sequence or a CAD assembly so the cycle can be written.')];
  }
  if (kind === 'calculation' || kind === 'structure') {
    return [paragraph(narrative.cycle, true)];
  }
  const stations = ctx.subsystems.filter((item) => item.role !== 'structure');
  const items = [
    { action: 'Confirm the pre-start checks before you start.', expect: 'The equipment is ready and people are clear.' },
    ...stations.slice(0, 8).map((item) => ({
      action: `${item.name}: ${item.purpose}`,
      expect: kind === 'process' ? 'That step of the process is complete.' : 'That station has finished its part of the cycle.',
    })),
    { action: 'Stop with the normal stop, or with an emergency stop if someone is at risk.', expect: 'Motion stops. An emergency-stop reset does not restart the equipment.' },
  ];
  return [paragraph(narrative.cycle || 'Follow the cycle in this order.'), steps(items)];
}

function interlockSection(ctx) {
  const rows = [];
  for (const tag of ctx.project.tags) {
    if (!/door|guard|air|pressure|reset|safety|e-?stop|ready/i.test(`${tag.description} ${tag.name}`)) continue;
    const name = uniqueSentences(tag.description || humanize(tag.name) || '');
    if (!name) continue;
    rows.push([name, 'Prevents a start or stops motion while the condition is not met.', 'All motion', 'Correct the condition, then press Reset.']);
  }
  if (!rows.length) {
    return [needs('Upload the PLC program so start permissives, station interlocks, and machine states can be listed in plain language.')];
  }
  return [table(['Condition', 'Prevents or allows', 'Subsystems', 'How to clear'], rows.slice(0, 16))];
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
    inferred: true,
  }));
}

function hmiControls(project) {
  const devices = controlDevices(project);
  if (!devices.length) return [needs('Upload an I/O list whose descriptions name each pushbutton, selector, and indicator.')];
  return [table(
    ['Control', 'Type', 'Function'],
    devices.slice(0, 30).map((tag) => [tag.description || humanize(tag.name), /lamp|indicator|light/i.test(tag.description) ? 'Indicator' : 'Operator control', tag.description || 'See the description']),
  )];
}

function modesSection(ctx) {
  const blob = ctx.project.tags.map((tag) => `${tag.description} ${tag.name}`).join(' ').toLowerCase();
  const rows = [['Automatic', 'Select automatic and close every guard.', 'Production runs with the safeguards active.']];
  if (/setup|manual|jog|teach/.test(blob)) {
    rows.push(['Setup', 'Select setup.', 'Motion is held-to-run and limited. Do not leave anyone else in the zone.']);
  }
  return [
    table(['Mode', 'How to select it', 'What the machine does'], rows),
    ...hazardBlocks(ctx.hazards.filter((item) => item.id === 'ctrl.manual_mode').slice(0, 1)),
  ];
}

function declaredNoAlarms(project) {
  for (const routine of project.routines || []) {
    for (const raw of (routine.analysis && routine.analysis.alarms) || []) {
      if (notAnAlarmMessage(raw.text || raw.message || '')) return true;
    }
  }
  return false;
}

function alarmSection(project) {
  const rows = alarmRows(project);
  if (!rows.length && declaredNoAlarms(project)) {
    return [paragraph('No alarms are defined for this equipment.')];
  }
  if (!rows.length) return [needs('Upload the PLC alarm list so each message can show its cause and remedy.')];
  return [
    paragraph('Correct the cause, then press Reset. Reset does not start the machine.'),
    table(['Code', 'Message', 'Class', 'Probable cause', 'Remedy'], rows.slice(0, MANUAL_ALARM_LIMIT), { small: true }),
  ];
}

function presentList(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const raw = String(item || '').trim().replace(/[.;\s]+$/g, '').trim();
    const text = readablePartName(raw) || raw;
    if (!text || /^none$/i.test(text) || /^none identified/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.join('; ') || 'None identified in the upload.';
}

function hasPneumatics(project) {
  const blob = [
    ...(project.cad.bom || []).map((part) => `${part.description} ${part.partNumber}`),
    ...(project.cad.assemblies || []).map((item) => `${item.name} ${item.kind} ${item.description}`),
    ...(project.tags || []).map((tag) => `${tag.name} ${tag.description}`),
  ].join(' ');
  return /pneumatic|cylinder|solenoid|compressed air|air preparation/i.test(blob);
}

const MAINT_RULES = [
  { re: /bearing/i, interval: 'Monthly or 500 h', task: 'Inspect the bearing and lubricate it.', who: 'Maintenance', time: '15 min' },
  { re: /pulley/i, interval: 'Monthly or 500 h', task: 'Inspect the pulley and lubricate its bearings.', who: 'Maintenance', time: '15 min' },
  { re: /\bbelt\b/i, interval: 'Monthly or 500 h', task: 'Check belt tension and tracking. Replace the belt if it is cracked or glazed.', who: 'Maintenance', time: '20 min' },
  { re: /roller/i, interval: 'Monthly or 500 h', task: 'Inspect the roller for wear and confirm it turns freely.', who: 'Maintenance', time: '15 min' },
  { re: /acrylic|polycarbonate/i, interval: 'Monthly or 500 h', task: 'Inspect the acrylic guard for cracks and loose fasteners.', who: 'Maintenance', time: '10 min' },
  { re: /hinge/i, interval: 'Monthly or 500 h', task: 'Inspect the hinge and confirm the door closes on the interlock.', who: 'Maintenance', time: '10 min' },
  { re: /interlock/i, interval: 'Weekly', task: 'Test the interlock. Motion must stop and stay stopped until Reset.', who: 'Maintenance', time: '10 min' },
  { re: /\bdoor\b/i, interval: 'Monthly or 500 h', task: 'Inspect the door, its hinge, and its interlock.', who: 'Maintenance', time: '10 min' },
  { re: /servo/i, interval: 'Every 3 months or 1000 h', task: 'Inspect the servo, its coupling, and the cable.', who: 'Maintenance', time: '20 min' },
  { re: /wheel/i, interval: 'Monthly or 500 h', task: 'Inspect the wheel for wear and confirm it tracks.', who: 'Maintenance', time: '15 min' },
  { re: /fan|blower/i, interval: 'Every 3 months or 1000 h', task: 'Clean the drive fan and confirm it turns freely.', who: 'Maintenance', time: '15 min' },
  { re: /filter/i, interval: 'Monthly or 500 h', task: 'Inspect the filter and clean or replace it. Do not drain a bowl unless the part is a pneumatic filter.', who: 'Maintenance', time: '15 min' },
  { re: /shaft/i, interval: 'Monthly or 500 h', task: 'Inspect the shaft and its bearings for play.', who: 'Maintenance', time: '15 min' },
  { re: /panel|guard|\bcover\b/i, interval: 'Monthly or 500 h', task: 'Inspect the guard or panel for cracks, fit, and loose fasteners.', who: 'Maintenance', time: '10 min' },
];

function scheduleSection(ctx) {
  const project = ctx.project;
  const rows = [
    ['Daily', 'Safety devices', 'Test each emergency stop and guard interlock. Motion must stop and stay stopped until Reset.', 'Operator', '10 min'],
    ['Daily', 'Work area', 'Remove scrap from the work area.', 'Operator', '10 min'],
    ['Weekly', 'Sensors', 'Clean the sensor faces and confirm each sensor changes state.', 'Maintenance', '15 min'],
  ];
  if (hasPneumatics(project)) {
    rows.push(['Weekly', 'Air preparation', 'Drain the filters and bowls. Confirm the supply pressure matches the nameplate.', 'Maintenance', '10 min']);
  }
  const seen = new Set();
  for (const part of project.cad.bom || []) {
    const label = `${part.description || ''} ${part.partNumber || ''}`.replace(/\s+/g, ' ').trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    if (/screw|nut|washer|extrusion|bracket|spacer|sketch|bolt|rivet|locknut|bucket|t-slotted|framing|set screw|machine screw/i.test(label)) continue;
    const shown = readablePartName(part.description || part.partNumber);
    if (!shown || /^machined part$/i.test(shown)) continue;
    const rule = MAINT_RULES.find((item) => item.re.test(shown));
    if (!rule) continue;
    seen.add(key);
    rows.push([rule.interval, shown, rule.task, rule.who, rule.time]);
    if (rows.length >= 30) break;
  }
  return [
    table(['Interval', 'Component', 'Task', 'Who', 'Time'], rows),
    needs('Replace the inferred intervals with the vendor intervals for purchased parts.'),
  ];
}

function interlockCause(item) {
  const text = (item.interlocks || [])
    .map((value) => String(value || '').trim())
    .find((value) => value && value.length < 180 && !/configure|preset|\bcfg\b|parameter|does not move|jammed/i.test(value) && /\b(must|until|when|while|unless|prevent|interlock|guard|permissive)\b/i.test(value));
  return text || '';
}

function movingTrouble(name, item) {
  const interlock = interlockCause(item);
  return [
    [name, `${name} does not start`, interlock ? `An interlock is open: ${interlock}` : 'A start permissive is open, or Reset has not been pressed.', 'Close the guards, clear the interlock, and press Reset. The equipment stays stopped until Start.'],
    [name, `${name} stops during the cycle`, interlock ? `The interlock opened while ${name} was running.` : 'A run permissive opened before the function finished.', 'Correct the interlock and press Reset. Motion stays stopped until Reset.'],
    [name, `${name} does not complete its function`, 'A permissive or interlock cleared before the function finished.', 'Lock out, confirm the interlock, then test the function in setup mode.'],
    [name, `${name} does not restart after Reset`, 'Reset was pressed while a start command was still on, or a permissive is open.', 'Release Start, close the guards, press Reset, then press Start.'],
  ];
}

function drawingTrouble(name) {
  return [
    ...movingTrouble(name, {}),
    [name, `The guard on ${name} does not satisfy the interlock`, 'The guard is open or the interlock is out of adjustment.', 'Close the guard and confirm the interlock changes state before Start.'],
    [name, `${name} moves with a guard open`, 'The guard interlock is bypassed or has not been proved.', 'Remove any bypass, close the guard, and test that motion stops while the guard is open.'],
  ];
}

function troubleSection(ctx) {
  const rows = [];
  const seen = new Set();
  const push = (subsystem, symptom, cause, remedy) => {
    if (rows.length >= 30) return;
    if (/does not move|jammed, loose, or unpowered/i.test(`${symptom} ${cause}`)) return;
    const key = `${symptom}|${cause}|${remedy}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push([subsystem, symptom, cause, remedy]);
  };
  const groups = (ctx.subsystems || []).filter((item) => !isStaticPart(item));
  const plc = ctx.project.routines.some((routine) => (routine.units || []).length);
  for (const item of groups) {
    if (rows.length >= 24) break;
    for (const row of movingTrouble(item.name, item)) push(...row);
  }
  if (!rows.length) {
    const blob = `${ctx.title || ''} ${(ctx.project.sources || []).map((source) => source.name).join(' ')} ${(ctx.project.cad.layers || []).join(' ')}`;
    const drawing = (ctx.project.cad.layers || []).length > 0 || (ctx.project.cad.assemblies || []).length > 0;
    if (drawing && /gripper|conveyor|wheel|motor|robot|axis|cylinder|servo|valve|pump|arm|jaw/i.test(blob)) {
      for (const row of drawingTrouble(ctx.title || 'The equipment')) push(...row);
    }
  }
  if (plc && rows.length < 4) {
    push('Control', 'A start command does not energize the output', 'A permissive is open, or the output is not solved.', 'Close the guards, press Reset, then press Start and confirm the output.');
    push('Control', 'The cycle does not advance to the next step', 'A required permissive or timer has not finished.', 'Correct the permissive named by the interlock, then press Reset.');
    push('Control', 'A fault stays on after the condition clears', 'Reset was not pressed, or the condition is still true.', 'Clear the condition and press Reset. Reset does not start the equipment.');
    push('Control', 'Reset does not clear the stop', 'An emergency stop is still pressed, or a guard is open.', 'Release every emergency stop, close the guards, and press Reset.');
  }
  return [table(['Subsystem', 'Symptom', 'Probable cause', 'Remedy'], rows.slice(0, 30), { small: true })];
}

function partsSection(project) {
  const rows = [];
  for (const part of project.cad.bom || []) {
    const description = readablePartName(part.description || part.partNumber);
    if (!description) continue;
    const number = readablePartName(part.partNumber || '') || '—';
    rows.push([String(part.item), number, description, String(part.qty || 1)]);
    if (rows.length >= 40) break;
  }
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
  if (project.cad.bom.length > 40) blocks.push(paragraph(`The model contains ${project.cad.bom.length} parts. The table shows the first 40.`));
  if (project.modules.length > seen.size) blocks.push(paragraph(`The controller export lists ${project.modules.length} modules. The table shows the distinct catalog numbers.`));
  return blocks;
}

function techData(ctx) {
  const box = ctx.project.cad.boundingBox;
  const dims = box ? box.min.map((value, index) => Math.round((box.max[index] - value) * 1000) / 1000).join(' × ') : '—';
  if (!ctx.project.identity.model || !ctx.project.spec.soundPressure) {
    needs('Model number, mass, electrical supply, and ambient limits.');
  }
  return [table(['Parameter', 'Value'], [
    ['Equipment', ctx.title],
    ['Model', ctx.project.identity.model || '—'],
    ['Overall size from the CAD model', dims],
    ['Model units', ctx.project.cad.lengthUnit || '—'],
    ['Solid bodies in the CAD model', ctx.project.cad.bodyCount ? String(ctx.project.cad.bodyCount) : '—'],
    ...(ctx.project.cad.shape ? [['Approximate shape', ctx.project.cad.shape]] : []),
    ...(ctx.project.cad.triangleCount ? [['Triangles in the mesh', String(ctx.project.cad.triangleCount)]] : []),
    ['Mass', '—'],
    ['Electrical supply', '—'],
    ['Pneumatic or hydraulic supply', '—'],
    ['Noise at the workstation', ctx.project.spec.soundPressure ? `${ctx.project.spec.soundPressure} dB(A)` : '—'],
    ['Ambient limits', '—'],
  ])];
}

function ioTable(project) {
  const rows = project.tags.map((tag) => [
    tag.address || '—',
    uniqueSentences(sanitizeProse(tag.description || '', project)) || humanize(tag.name) || '—',
    deviceTypeLabel(tag.device || tag.dataType),
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
    if (routine.unreadReason && (routine.units || []).every((unit) => unit.unread)) {
      rows.push([
        routine.scopeKey || routine.name,
        '—',
        'Not extracted',
        routine.unreadReason,
      ]);
      continue;
    }
    if (analysis.groups.length) {
      const titles = [...new Set(analysis.groups.map((group) => group.title).filter(Boolean))].slice(0, 3).join('; ');
      rows.push([
        routine.scopeKey || routine.name,
        mergedRef(analysis.groups) || '—',
        routine.aoi ? 'Instruction definition' : 'Theory of operation',
        titles || 'Machine function',
      ]);
    }
    if (analysis.housekeeping.length) {
      const numbers = analysis.housekeeping.map((index) => {
        const unit = routine.units.find((item) => item.index === index);
        return unit ? unit.number : index;
      });
      const kind = (routine.units[0] && routine.units[0].kind) || 'rung';
      rows.push([routine.scopeKey || routine.name, mergedRef([{ numbers, kind }]) || '—', 'Housekeeping', 'Spare or unused logic']);
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
  alarmRows,
  MANUAL_ALARM_LIMIT,
  isConfigAlarm,
};
