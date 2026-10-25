const { parseManualsUsed, withCreditLock } = require('./billing');
const { listPurchaseCredits, redactCreditLog, removePurchaseCredits } = require('./credit-ledger');

const PI = /^pi_[A-Za-z0-9]+$/;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const HOLD = /^[a-f0-9]{16}$/;
const TICKET_VALUE_LIMIT = 500;
const USAGE = 'Usage: npm run support:restore-starter-credit -- --payment-intent <pi_id> [--ticket <id>] [--apply] [--live]';

function liveSecretKey(key) {
  return /^(sk|rk)_live_/.test(String(key || '').trim());
}

function parseRestoreArgs(argv) {
  const args = { apply: false, live: false, paymentIntentId: '', ticket: '' };
  const rest = Array.isArray(argv) ? [...argv] : [];
  while (rest.length) {
    const flag = rest.shift();
    if (flag === '--apply') args.apply = true;
    else if (flag === '--live') args.live = true;
    else if (flag === '--payment-intent') args.paymentIntentId = rest.shift();
    else if (flag === '--ticket') args.ticket = rest.shift();
    else return { ok: false, error: 'usage' };
  }
  if (!args.paymentIntentId) return { ok: false, error: 'usage' };
  if (typeof args.paymentIntentId !== 'string' || !PI.test(args.paymentIntentId)) return { ok: false, error: 'payment_intent' };
  if (args.ticket && (typeof args.ticket !== 'string' || !TICKET.test(args.ticket))) return { ok: false, error: 'ticket' };
  if (args.apply && !args.ticket) return { ok: false, error: 'ticket_required' };
  return { ok: true, args };
}

function ticketList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((part) => part.trim()).filter((part) => TICKET.test(part));
}

function liveRefused() {
  const err = new Error('Refusing to run against live mode without --live');
  err.code = 'live_mode';
  return err;
}

function holdSet(meta) {
  return Boolean((meta && meta.credit_hold) || (meta && meta.credit_hold_at));
}

function describe(paymentIntentId, current, records, ticket) {
  const meta = (current && current.metadata) || {};
  const manualsUsed = parseManualsUsed(meta.manuals_used);
  const tickets = ticketList(meta.restored_tickets);
  const starter = meta.plan === 'starter';
  const alreadyRestored = Boolean(ticket) && tickets.includes(ticket);
  const nextTickets = ticket && !alreadyRestored ? [...tickets, ticket].join(',') : tickets.join(',');
  const listFull = Boolean(ticket) && !alreadyRestored && nextTickets.length > TICKET_VALUE_LIMIT;
  let result = 'dry_run';
  if (records.status === 'unreadable') result = 'unreadable';
  else if (!starter) result = 'not_starter';
  else if (alreadyRestored) result = 'already_restored';
  else if (listFull) result = 'ticket_list_full';
  const change = result === 'unreadable' || result === 'not_starter' || result === 'ticket_list_full' ? null : {
    manualsUsed: alreadyRestored ? manualsUsed : Math.max(0, manualsUsed - 1),
    manualsDelta: alreadyRestored || manualsUsed === 0 ? 0 : -1,
    clearHold: alreadyRestored ? false : holdSet(meta),
    recordTicket: Boolean(ticket) && !alreadyRestored,
    removeOpenHolds: records.status === 'ok' ? records.open.length : 0,
    removeHandbacks: records.status === 'ok' ? records.pending.length : 0,
    ticketRequired: !ticket,
  };
  return {
    paymentIntentId,
    plan: typeof meta.plan === 'string' ? meta.plan : '',
    starter,
    livemode: Boolean(current && current.livemode),
    manualsUsed,
    creditHold: HOLD.test(meta.credit_hold || '') ? meta.credit_hold : '',
    creditHoldSet: holdSet(meta),
    openHolds: records.open,
    handbacks: records.pending,
    supportDataDir: records.status,
    ticket: ticket || null,
    alreadyRestored,
    restoredTickets: tickets,
    change,
    apply: false,
    result,
  };
}

async function commitRestore(stripe, paymentIntentId, ticket, allowLive) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (current && current.livemode && !allowLive) throw liveRefused();
    const meta = (current && current.metadata) || {};
    if (meta.plan !== 'starter') {
      return { result: 'not_starter', manualsUsed: parseManualsUsed(meta.manuals_used) };
    }
    const tickets = ticketList(meta.restored_tickets);
    if (tickets.includes(ticket)) {
      return { result: 'already_restored', manualsUsed: parseManualsUsed(meta.manuals_used), restoredTickets: tickets };
    }
    const used = parseManualsUsed(meta.manuals_used);
    const next = Math.max(0, used - 1);
    const nextTickets = [...tickets, ticket].join(',');
    if (nextTickets.length > TICKET_VALUE_LIMIT) return { result: 'ticket_list_full', manualsUsed: used };
    const nextGen = String(parseManualsUsed(meta.credit_generation) + 1);
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: {
        manuals_used: String(next),
        credit_generation: nextGen,
        credit_hold: '',
        credit_hold_at: '',
        restored_tickets: nextTickets,
      },
    });
    const check = await stripe.paymentIntents.retrieve(paymentIntentId);
    const confirmed = (check && check.metadata) || {};
    if (
      confirmed.plan === 'starter'
      && confirmed.manuals_used === String(next)
      && ticketList(confirmed.restored_tickets).includes(ticket)
      && !confirmed.credit_hold
      && !confirmed.credit_hold_at
      && confirmed.credit_generation === nextGen
    ) {
      return {
        result: 'applied',
        manualsUsed: next,
        previousManualsUsed: used,
        restoredTickets: ticketList(confirmed.restored_tickets),
      };
    }
  }
  const err = new Error('Starter credit restore did not commit');
  err.code = 'not_committed';
  throw err;
}

async function restoreStarterCredit(stripe, options = {}) {
  const paymentIntentId = options.paymentIntentId;
  const ticket = typeof options.ticket === 'string' ? options.ticket : '';
  const apply = Boolean(options.apply);
  const allowLive = Boolean(options.allowLive);
  const env = options.env || {};
  if (liveSecretKey(options.key) && !allowLive) throw liveRefused();
  if (typeof paymentIntentId !== 'string' || !PI.test(paymentIntentId)) {
    const err = new Error('Payment intent id is not valid');
    err.code = 'payment_intent';
    throw err;
  }
  if (ticket && !TICKET.test(ticket)) {
    const err = new Error('Ticket id is not valid');
    err.code = 'ticket';
    throw err;
  }
  if (apply && !ticket) {
    const err = new Error('A ticket id is required to apply a restore');
    err.code = 'ticket_required';
    throw err;
  }
  const current = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (current && current.livemode && !allowLive) throw liveRefused();
  const records = listPurchaseCredits(env, paymentIntentId);
  const preview = describe(paymentIntentId, current, records, ticket);
  preview.apply = apply;
  if (!apply || preview.result === 'unreadable' || preview.result === 'not_starter' || preview.result === 'ticket_list_full') {
    return preview;
  }
  const committed = await withCreditLock(paymentIntentId, () => commitRestore(stripe, paymentIntentId, ticket, allowLive));
  const after = await stripe.paymentIntents.retrieve(paymentIntentId);
  let removed = { status: records.status, removedOpen: 0, removedPending: 0 };
  let recordsRemove = records.status === 'unset' ? 'unset' : 'skipped';
  if (committed.result === 'applied' || committed.result === 'already_restored') {
    if (records.status === 'ok' || records.status === 'unset') {
      try {
        removed = removePurchaseCredits(env, paymentIntentId);
        recordsRemove = removed.status === 'unset' ? 'unset' : 'ok';
      } catch {
        recordsRemove = 'failed';
      }
    }
  }
  const report = describe(paymentIntentId, after, {
    status: records.status === 'unreadable' ? 'unreadable' : (recordsRemove === 'ok' ? 'ok' : records.status),
    open: recordsRemove === 'ok' ? [] : records.open,
    pending: recordsRemove === 'ok' ? [] : records.pending,
  }, ticket);
  report.apply = true;
  report.result = committed.result;
  report.manualsUsed = committed.manualsUsed != null ? committed.manualsUsed : report.manualsUsed;
  report.recordsRemove = recordsRemove;
  report.removedOpenHolds = removed.removedOpen || 0;
  report.removedHandbacks = removed.removedPending || 0;
  if (committed.result === 'applied') {
    report.change = {
      manualsUsed: committed.manualsUsed,
      manualsDelta: committed.manualsUsed - committed.previousManualsUsed,
      clearHold: preview.creditHoldSet,
      recordTicket: true,
      removeOpenHolds: removed.removedOpen || 0,
      removeHandbacks: removed.removedPending || 0,
      ticketRequired: false,
    };
  }
  return report;
}

function exitCodeFor(report, apply) {
  if (!report) return 1;
  if (report.recordsRemove === 'failed') return 1;
  if (apply && (report.result === 'not_starter' || report.result === 'unreadable' || report.result === 'ticket_list_full')) return 1;
  return 0;
}

async function runRestore({ argv, args, stripe, key, env, stripeFactory } = {}) {
  const parsed = args ? { ok: true, args } : parseRestoreArgs(argv || []);
  if (!parsed.ok) return { exitCode: 1, stdout: '', stderr: `${USAGE}\n` };
  const secret = key != null ? key : (env && env.STRIPE_SECRET_KEY);
  if (liveSecretKey(secret) && !parsed.args.live) {
    return { exitCode: 1, stdout: '', stderr: 'Refusing to run against live mode without --live\n' };
  }
  let client = stripe;
  if (!client) {
    if (!secret || !String(secret).trim() || typeof stripeFactory !== 'function') {
      return { exitCode: 1, stdout: '', stderr: 'STRIPE_SECRET_KEY is not set\n' };
    }
    client = stripeFactory(String(secret).trim());
  }
  try {
    const report = await restoreStarterCredit(client, {
      paymentIntentId: parsed.args.paymentIntentId,
      ticket: parsed.args.ticket,
      apply: parsed.args.apply,
      allowLive: parsed.args.live,
      env: env || {},
      key: secret,
    });
    return {
      exitCode: exitCodeFor(report, parsed.args.apply),
      stdout: `${JSON.stringify(report, null, 2)}\n`,
      stderr: report.recordsRemove === 'failed' ? 'Credit record could not be updated\n' : '',
    };
  } catch (err) {
    const text = err && err.message ? err.message : err;
    return { exitCode: 1, stdout: '', stderr: `${redactCreditLog(text)}\n` };
  }
}

module.exports = {
  USAGE,
  liveSecretKey,
  parseRestoreArgs,
  restoreStarterCredit,
  runRestore,
};
