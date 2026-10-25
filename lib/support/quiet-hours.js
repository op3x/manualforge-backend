const ZONES = {
  'America/New_York': '201,202,203,207,212,215,216,220,223,227,229,231,234,239,240,248,252,267,269,272,276,301,302,304,305,315,321,324,326,330,332,336,339,347,351,352,380,386,401,404,407,410,412,413,419,434,436,440,443,445,448,463,470,475,478,484,502,508,513,516,517,518,540,551,561,567,570,571,574,585,586,603,606,607,609,610,614,616,617,631,640,646,656,667,678,680,681,689,703,704,706,716,717,718,724,727,732,734,740,743,754,757,762,765,770,772,774,781,786,802,803,804,810,812,813,814,828,835,838,839,843,845,848,850,854,856,857,859,860,862,863,864,878,904,908,910,912,914,917,919,929,930,934,937,941,947,954,959,973,978,980,984,989',
  'America/Chicago': '205,210,214,217,218,219,224,225,228,251,254,256,262,270,281,308,309,312,314,316,317,318,319,320,325,331,334,337,346,361,364,402,405,409,414,417,430,432,447,464,469,479,501,504,507,512,515,531,534,539,557,563,573,580,601,605,608,612,615,618,620,629,630,636,641,651,659,660,662,682,701,708,712,713,715,726,730,731,737,763,769,773,779,785,806,815,816,817,830,832,847,870,872,901,903,913,915,918,920,931,936,938,940,945,952,956,972,979,985',
  'America/Denver': '208,303,307,385,406,435,505,575,719,720,748,801,970',
  'America/Phoenix': '480,520,602,623,928',
  'America/Los_Angeles': '206,209,213,253,279,310,323,341,360,385,408,415,424,425,442,458,503,509,510,530,541,559,562,564,619,626,628,650,657,661,669,702,707,714,725,747,760,775,805,818,820,831,840,858,909,916,925,949,951,971',
  'America/Anchorage': '907',
  'Pacific/Honolulu': '808',
};

const AREA = new Map();
for (const [zone, list] of Object.entries(ZONES)) {
  for (const code of list.split(',')) {
    if (!code || AREA.has(code)) continue;
    AREA.set(code, zone);
  }
}

function timeZoneForPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  let area = '';
  if (digits.length === 11 && digits.startsWith('1')) area = digits.slice(1, 4);
  else if (digits.length === 10) area = digits.slice(0, 3);
  return AREA.get(area) || 'America/Chicago';
}

function zonedParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(ms));
  const out = {};
  for (const part of parts) out[part.type] = part.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}

function withinStatusWindow(ms, timeZone) {
  const hour = Number(zonedParts(ms, timeZone).hour);
  return hour >= 8 && hour < 20;
}

function utcFromZoned(year, month, day, hour, minute, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 6; i += 1) {
    const got = zonedParts(utc, timeZone);
    const gotAsUtc = Date.UTC(Number(got.year), Number(got.month) - 1, Number(got.day), Number(got.hour), Number(got.minute), 0);
    const want = Date.UTC(year, month - 1, day, hour, minute, 0);
    const delta = want - gotAsUtc;
    if (delta === 0) return utc;
    utc += delta;
  }
  return utc;
}

function nextStatusOpen(ms, timeZone) {
  if (withinStatusWindow(ms, timeZone)) return ms;
  const parts = zonedParts(ms, timeZone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  if (Number(parts.hour) < 8) return utcFromZoned(year, month, day, 8, 0, timeZone);
  let cursor = ms;
  for (let i = 0; i < 36; i += 1) {
    cursor += 60 * 60 * 1000;
    if (!withinStatusWindow(cursor, timeZone)) continue;
    const next = zonedParts(cursor, timeZone);
    return utcFromZoned(Number(next.year), Number(next.month), Number(next.day), 8, 0, timeZone);
  }
  return ms + (12 * 60 * 60 * 1000);
}

function isoWithOffset(ms, timeZone = 'America/Chicago') {
  const parts = zonedParts(ms, timeZone);
  let offset = String(parts.timeZoneName || 'GMT').replace(/^GMT/, '');
  if (!offset) offset = '+00:00';
  if (/^[+-]\d{2}$/.test(offset)) offset = `${offset}:00`;
  if (/^[+-]\d$/.test(offset)) offset = `${offset[0]}0${offset.slice(1)}:00`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

module.exports = {
  timeZoneForPhone,
  withinStatusWindow,
  nextStatusOpen,
  isoWithOffset,
  zonedParts,
};
