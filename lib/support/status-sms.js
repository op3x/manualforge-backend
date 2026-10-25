const { e164, redactCardNumbers } = require('./policy');
const { nextStatusOpen, timeZoneForPhone, withinStatusWindow } = require('./quiet-hours');

async function deliverStatusText({ store, phone, body, now = Date.now(), send }) {
  const to = e164(phone);
  const at = typeof now === 'function' ? now() : now;
  const text = redactCardNumbers(String(body || '')).slice(0, 320);
  if (!to || !text) return { queued: false, sent: false, reason: 'invalid' };
  const timeZone = timeZoneForPhone(to);
  if (store.isOptedOut(to)) return { queued: false, sent: false, reason: 'opted-out', timeZone };
  if (!withinStatusWindow(at, timeZone)) {
    const notBefore = nextStatusOpen(at, timeZone);
    const item = store.enqueueStatus({ phone: to, body: text, notBefore, at });
    return { queued: true, sent: false, notBefore, timeZone, id: item.id };
  }
  if (typeof send !== 'function') return { queued: false, sent: false, reason: 'not-configured', timeZone };
  await send({ to, body: text });
  store.noteLastMessage(to, at);
  return { queued: false, sent: true, timeZone };
}

async function flushStatusQueue({ store, now = Date.now(), send }) {
  const at = typeof now === 'function' ? now() : now;
  const results = [];
  for (const item of store.dueStatusTexts(at)) {
    const timeZone = timeZoneForPhone(item.phone);
    if (!withinStatusWindow(at, timeZone)) continue;
    if (store.isOptedOut(item.phone)) {
      store.dropStatus(item.id);
      results.push({ id: item.id, sent: false, reason: 'opted-out' });
      continue;
    }
    if (typeof send !== 'function') {
      results.push({ id: item.id, sent: false, reason: 'not-configured' });
      continue;
    }
    try {
      await send({ to: item.phone, body: item.body });
      store.noteLastMessage(item.phone, at);
      store.dropStatus(item.id);
      results.push({ id: item.id, sent: true });
    } catch (err) {
      console.error('Status text failed', err && err.code ? String(err.code) : 'error');
      results.push({ id: item.id, sent: false, reason: 'error' });
    }
  }
  return results;
}

module.exports = {
  deliverStatusText,
  flushStatusQueue,
};
