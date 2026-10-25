const { exposed } = require('../errors');

const REQUESTED_MAX = 1500;
const CUSTOM_MAX = 5;

const BUILTIN = {
  manual: { title: 'Operating and Maintenance Manual', kind: 'manual' },
  pm_schedule: { title: 'Preventive Maintenance Schedule', kind: 'pm_schedule' },
  shutdown: { title: 'Shutdown Procedure', kind: 'shutdown' },
  startup: { title: 'Startup Procedure', kind: 'startup' },
};

const UPGRADE_MESSAGE = 'Preventive maintenance schedules, shutdown and startup procedures, and other extra documents are included with Pro and Integrator. Starter includes the operating and maintenance manual only. Upgrade to generate these documents.';

const UNRELATED = /\b(poem|poetry|haiku|resume|curriculum vitae|cover letter|stock tip|crypto|bitcoin|homework|essay|love letter|horoscope|tax return|novel|lyrics|joke|dating profile)\b/i;
const DOCUMENT_INTENT = /\b(changeover|clean\w*|sanitat\w*|depositor|checklist|procedure|schedule|troubleshoot\w*|spare|parts list|calibrat\w*|commission\w*|lockout|tagout|loto|maintenance|startup|shutdown|lubric\w*|training)\b/i;
const INDUSTRIAL = /\b(alarm|fault|troubleshoot|diagnostic|spare|parts?\b|training|lubric\w*|clean\w*|sanitat\w*|depositor|calibrat\w*|commission\w*|changeover|electrical|pneumatic|hydraulic|safety|lockout|tagout|loto|operator|maintenance|startup|shutdown|guard|motor|sensor|valve|drive|filter|conveyor|axis|homing|interlock|e-?stop|emergency|signal|i\/o|io list|checklist|procedure|schedule|torque|wiring|list|table|chart)\b/i;

function planAllowsExtraDocuments(plan) {
  return plan === 'pro' || plan === 'integrator';
}

// One paid run produces every document. Extra documents do not add credits.
function creditsForDocumentRun() {
  return 1;
}

function sanitizeRequestedText(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function normalizeRequest(value) {
  return clip(String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .replace(/^[\s\-*•\d.)]+/, '')
    .replace(/\s+/g, ' ')
    .trim(), 180);
}

function splitRequests(text) {
  const items = [];
  const seen = new Set();
  for (const part of String(text || '').split(/\r?\n|;|,/)) {
    const item = normalizeRequest(part);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

function classifyRequest(text) {
  const request = normalizeRequest(text);
  if (!request) return { related: false, title: '', kind: 'custom', request: '' };
  if (UNRELATED.test(request) && !DOCUMENT_INTENT.test(request)) {
    return { related: false, title: clip(request, 80), kind: 'custom', request };
  }
  if (!INDUSTRIAL.test(request)) {
    return { related: false, title: clip(request, 80), kind: 'custom', request };
  }
  let kind = 'general';
  let title = clip(request.charAt(0).toUpperCase() + request.slice(1), 70);
  if (/alarm|troubleshoot|fault|diagnostic/i.test(request)) {
    kind = 'troubleshooting';
    title = 'Alarm and Troubleshooting Guide';
  } else if (/spare|parts list|replacement part/i.test(request)) {
    kind = 'parts';
    title = 'Spare Parts List';
  } else if (/commission/i.test(request)) {
    kind = 'commissioning';
    title = 'Commissioning Checklist';
  } else if (/train|checklist/i.test(request) && !/maintenance checklist/i.test(request)) {
    kind = 'training';
    title = 'Training Checklist';
  } else if (/lubric/i.test(request)) {
    kind = 'lubrication';
    title = 'Lubrication List';
  } else if (/clean/i.test(request)) {
    kind = 'cleaning';
    title = 'Cleaning Procedure';
  } else if (/calibrat/i.test(request)) {
    kind = 'calibration';
    title = 'Calibration Checklist';
  } else if (/changeover/i.test(request)) {
    kind = 'changeover';
    title = 'Changeover Procedure';
  } else if (/lockout|tagout|\bloto\b|safety/i.test(request)) {
    kind = 'safety';
    title = 'Safety Checklist';
  } else if (/pneumatic|compressed air/i.test(request)) {
    kind = 'pneumatic';
    title = 'Pneumatic Service Notes';
  } else if (/hydraulic/i.test(request)) {
    kind = 'hydraulic';
    title = 'Hydraulic Service Notes';
  } else if (/electrical|signal|\bi\/o\b|io list/i.test(request)) {
    kind = 'electrical';
    title = 'Electrical Signal List';
  }
  return { related: true, title, kind, request };
}

function asList(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) return value.flatMap((item) => asList(item) || []);
  const text = String(value).trim();
  if (!text) return null;
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw exposed(400, 'documents must be a list of document names.');
    }
    if (!Array.isArray(parsed)) throw exposed(400, 'documents must be a list of document names.');
    return parsed.map((item) => String(item));
  }
  return text.split(/[\s,]+/).filter(Boolean);
}

function requestedRaw(body) {
  if (!body || body.requested_documents == null || body.requested_documents === '') return '';
  const value = body.requested_documents;
  if (Array.isArray(value)) return value.map((item) => String(item)).join('\n');
  if (typeof value !== 'string') throw exposed(400, 'requested_documents must be text.');
  return value;
}

function selectionFromRequest(req) {
  const body = (req && req.body) || {};
  const rawRequested = requestedRaw(body);
  if (rawRequested.length > REQUESTED_MAX) {
    throw exposed(400, 'Requested documents text is too long.');
  }
  const requested = sanitizeRequestedText(rawRequested);
  const customTexts = splitRequests(requested);
  if (customTexts.length > CUSTOM_MAX) {
    throw exposed(400, 'Name at most 5 additional documents.');
  }
  const listed = asList(body.documents);
  const ids = [];
  const seen = new Set();
  const source = listed == null ? ['manual'] : listed;
  if (!source.length) throw exposed(400, 'Select at least one document.');
  for (const item of source) {
    const id = String(item || '').trim().toLowerCase();
    if (!id) continue;
    if (!BUILTIN[id]) {
      throw exposed(400, `Unknown document "${clip(id, 40)}". Use manual, pm_schedule, shutdown, or startup.`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) throw exposed(400, 'Select at least one document.');
  const entries = ids.map((id) => ({
    id,
    kind: BUILTIN[id].kind,
    title: BUILTIN[id].title,
    status: 'pending',
    reason: null,
  }));
  customTexts.forEach((text, index) => {
    const decision = classifyRequest(text);
    entries.push({
      id: `custom_${index + 1}`,
      kind: decision.related ? decision.kind : 'custom',
      title: decision.related ? decision.title : 'Additional document',
      status: decision.related ? 'pending' : 'skipped',
      reason: decision.related ? null : `Skipped "${decision.title}". This request is not about the uploaded equipment, so it was not generated.`,
      request: decision.request,
      customKind: decision.kind,
      related: decision.related,
    });
  });
  const requestsExtras = ids.some((id) => id !== 'manual') || customTexts.length > 0;
  return { ids, entries, requestsExtras, requested };
}

function requestsExtras(req) {
  return selectionFromRequest(req).requestsExtras;
}

module.exports = {
  BUILTIN,
  REQUESTED_MAX,
  CUSTOM_MAX,
  UPGRADE_MESSAGE,
  planAllowsExtraDocuments,
  creditsForDocumentRun,
  sanitizeRequestedText,
  classifyRequest,
  selectionFromRequest,
  requestsExtras,
};
