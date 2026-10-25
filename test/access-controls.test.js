const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { createJobStore, removeTestJobDirectories } = require('../lib/jobs/store');
const { assertCanGenerate, accessFromSession, STARTER_REFUNDED_MESSAGE } = require('../lib/billing');
const { contentDisposition, downloadFileName } = require('../lib/download-name');
const {
  dropRevokedJti,
  forgetSessionCredential,
  loadRevocations,
  recordTokenExchange,
  signAccessToken,
  tokenExchangeGate,
  verifyAccessToken,
  ACCESS_TOKEN_TTL_MS,
  EXCHANGE_LIMIT,
} = require('../lib/access-token');
const { redactSecrets } = require('../server');

test.after(() => {
  removeTestJobDirectories();
});

const env = {
  NODE_ENV: 'test',
  FRONTEND_URL: 'https://manualos.com',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_PRO: 'price_pro',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STARTER_CREDITS: '3',
  PORTAL_TOKEN_SECRET: 'test-portal-token-secret-32bytes-min',
};

function notFound() {
  const err = new Error('No such checkout.session');
  err.statusCode = 404;
  err.code = 'resource_missing';
  return err;
}

function starterSession(id, meta) {
  return {
    id,
    metadata: { plan: 'starter' },
    payment_status: 'paid',
    payment_intent: { id: 'pi_1', metadata: meta },
    subscription: null,
    customer: 'cus_starter',
  };
}

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

test('download names are the short job id and contain no customer text', () => {
  assert.equal(downloadFileName(''), 'manual.pdf');
  assert.equal(downloadFileName('Infeed Line'), 'manual.pdf');
  assert.equal(downloadFileName('Förderband'), 'manual.pdf');
  assert.equal(downloadFileName('job_abcdef12ffffffffffffffff'), 'manual-abcdef12.pdf');
  const header = contentDisposition('job_abcdef12ffffffffffffffff');
  assert.equal(header, 'attachment; filename="manual-abcdef12.pdf"');
  assert.equal(header.includes('filename*'), false);
  assert.equal(contentDisposition('Förderband Linie').includes('Förder'), false);
  assert.equal(contentDisposition('Förderband Linie').includes('filename*'), false);
  assert.equal(header.includes('\n'), false);
});

test('job routes require the owner and a revoked purchase keeps the access block', async () => {
  const meta = { manuals_used: '1', plan: 'starter', credit_status: 'active' };
  const sessions = {
    cs_test_owner: () => starterSession('cs_test_owner', meta),
    cs_test_other: () => starterSession('cs_test_other', { manuals_used: '0', plan: 'starter' }),
  };
  const updates = [];
  const stripe = {
    checkout: { sessions: { retrieve: async (id) => {
      if (!sessions[id]) throw notFound();
      return sessions[id]();
    } } },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_1', metadata: { ...meta } }),
      update: async (id, params) => {
        updates.push(params.metadata);
        return { id, metadata: { ...meta } };
      },
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-access-'));
  const store = createJobStore({ directory: dir, env: { NODE_ENV: 'test' } });
  const job = store.create({ sessionId: 'cs_test_owner', nameSource: 'Förderband Linie' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n%owned\n'));
  job.status = 'succeeded';
  store.persist(job);
  const stranger = store.create({ sessionId: 'cs_test_other', nameSource: 'Other' });
  store.savePdf(stranger.id, Buffer.from('%PDF-1.4\n%other\n'));
  stranger.status = 'succeeded';
  store.persist(stranger);
  const app = createApp({ env, stripe, jobs: store, anthropic: null });
  try {
    await withServer(app, async (base) => {
      const missing = await fetch(`${base}/jobs/${job.id}`);
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).code, 'authorization_required');

      const unknown = await fetch(`${base}/jobs/job_${'ab'.repeat(12)}`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), { error: 'Job not found or expired.' });

      const query = await fetch(`${base}/jobs/${job.id}/pdf?session_id=cs_test_owner`);
      assert.equal(query.status, 401);
      assert.equal((await query.json()).code, 'authorization_required');

      const other = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_test_other' } });
      assert.equal(other.status, 403);
      assert.equal((await other.json()).code, 'forbidden');
      const otherMissing = await fetch(`${base}/jobs/job_${'ab'.repeat(12)}`, {
        headers: { 'X-Session-Id': 'cs_test_other' },
      });
      assert.equal(otherMissing.status, 404);

      const owned = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_test_owner' } });
      assert.equal(owned.status, 200);
      assert.equal((await owned.json()).status, 'succeeded');
      assert.equal(JSON.stringify(await (await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_test_owner' } })).json()).includes('cs_test_owner'), false);

      const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_owner' } });
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get('cache-control'), 'no-store');
      assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(pdf.headers.get('referrer-policy'), 'no-referrer');
      const short = job.id.slice(4, 12);
      assert.equal(pdf.headers.get('content-disposition'), `attachment; filename="manual-${short}.pdf"`);
      assert.equal(pdf.headers.get('content-disposition').includes('filename*'), false);
      assert.equal(pdf.headers.get('content-disposition').toLowerCase().includes('forder'), false);
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

      const again = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_owner' } });
      assert.equal(again.status, 200);
      await again.arrayBuffer();
      assert.equal(updates.length, 0);

      const listed = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_test_owner' } });
      assert.equal(listed.status, 200);
      const body = await listed.json();
      assert.deepEqual(body.jobs.map((item) => item.id), [job.id]);
      assert.equal(body.jobs[0].filename, `manual-${job.id.slice(4, 12)}.pdf`);
      assert.equal(body.jobs[0].download_path, `/jobs/${job.id}/pdf`);

      const hidden = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_test_other' } });
      assert.deepEqual((await hidden.json()).jobs.map((item) => item.id), [stranger.id]);

      meta.credit_status = 'revoked';
      const revokedPdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_owner' } });
      assert.equal(revokedPdf.status, 402);
      assert.equal((await revokedPdf.json()).error, STARTER_REFUNDED_MESSAGE);
      const revokedStatus = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_test_owner' } });
      assert.equal(revokedStatus.status, 200);
      assert.equal(updates.length, 0);
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bearer token replaces session_id and can be revoked', async () => {
  const meta = { manuals_used: '0', plan: 'starter' };
  const stripe = {
    checkout: { sessions: { retrieve: async (id) => {
      if (id === 'cs_test_tokenowner') return starterSession('cs_test_tokenowner', meta);
      if (id === 'cs_test_gone') throw notFound();
      if (id === 'cs_test_canceled') {
        return {
          id,
          metadata: { plan: 'pro' },
          payment_status: 'paid',
          subscription: { id: 'sub_dead', status: 'canceled', customer: 'cus_dead' },
        };
      }
      throw notFound();
    } } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { ...meta } }) },
    subscriptions: { retrieve: async (id) => ({ id, status: 'active' }) },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-token-'));
  const store = createJobStore({ directory: dir, env: { NODE_ENV: 'test' } });
  const job = store.create({ sessionId: 'cs_test_tokenowner', customerId: 'cus_pro', subscriptionId: 'sub_pro', nameSource: 'Widget' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
  job.status = 'succeeded';
  store.persist(job);
  const app = createApp({ env, stripe, jobs: store, anthropic: null });
  try {
    await withServer(app, async (base) => {
      const missing = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_gone' }),
      });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).code, 'purchase_not_found');

      const inactive = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_canceled' }),
      });
      assert.equal(inactive.status, 403);
      assert.equal((await inactive.json()).code, 'purchase_inactive');

      const exchanged = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_tokenowner' }),
      });
      assert.equal(exchanged.status, 200);
      const tokenBody = await exchanged.json();
      assert.equal(tokenBody.token_type, 'Bearer');
      assert.equal(tokenBody.expires_in, ACCESS_TOKEN_TTL_MS / 1000);
      assert.equal(tokenBody.valid, true);
      assert.equal(tokenBody.plan, 'starter');
      assert.equal(tokenBody.billingIssue, false);
      assert.equal(exchanged.headers.get('cache-control'), 'no-store');
      assert.equal(exchanged.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(exchanged.headers.get('pragma'), 'no-cache');

      const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(tokenBody.access_token) });
      assert.equal(pdf.status, 200);
      await pdf.arrayBuffer();

      const sameSub = signAccessToken({
        sessionId: 'cs_test_second',
        customerId: 'cus_pro',
        subscriptionId: 'sub_pro',
      }, env);
      const shared = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(sameSub.token) });
      assert.equal(shared.status, 200);
      await shared.arrayBuffer();

      const otherSub = signAccessToken({ sessionId: 'cs_test_third', subscriptionId: 'sub_other' }, env);
      const denied = await fetch(`${base}/jobs/${job.id}`, { headers: authHeaders(otherSub.token) });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, 'forbidden');

      const revoked = await fetch(`${base}/access-token/revoke`, {
        method: 'POST',
        headers: authHeaders(tokenBody.access_token),
      });
      assert.equal(revoked.status, 200);
      const after = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(tokenBody.access_token) });
      assert.equal(after.status, 401);
      assert.equal((await after.json()).code, 'access_token_invalid');

      const expired = signAccessToken({ sessionId: 'cs_test_tokenowner' }, env, Date.now() - ACCESS_TOKEN_TTL_MS - 1000);
      assert.equal(verifyAccessToken(expired.token, env), null);
      const stale = await fetch(`${base}/jobs/${job.id}`, { headers: authHeaders(expired.token) });
      assert.equal(stale.status, 401);
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('past_due keeps access and reports billingIssue, and ended statuses do not', async () => {
  const sub = { id: 'sub_1', status: 'past_due', customer: 'cus_1', metadata: {} };
  const stripe = {
    checkout: { sessions: { retrieve: async () => ({
      id: 'cs_test_pro',
      metadata: { plan: 'pro' },
      payment_status: 'paid',
      subscription: sub,
      customer: 'cus_1',
    }) } },
    subscriptions: { retrieve: async () => sub },
  };
  let nowMs = 1700000000000;
  const app = createApp({ env, stripe, anthropic: null, now: () => nowMs });
  await withServer(app, async (base) => {
    const verified = await fetch(`${base}/verify-session?session_id=cs_test_pro`);
    assert.deepEqual(await verified.json(), {
      valid: true,
      plan: 'pro',
      remaining: null,
      billingIssue: true,
    });
    const exchanged = await fetch(`${base}/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_test_pro' }),
    });
    assert.equal(exchanged.status, 200);
    assert.equal((await exchanged.json()).billingIssue, true);
    await assert.doesNotReject(() => assertCanGenerate(stripe, 'cs_test_pro', env));

    for (const status of ['unpaid', 'canceled', 'incomplete_expired']) {
      sub.status = status;
      nowMs += 11000;
      const ended = await fetch(`${base}/verify-session?session_id=cs_test_pro`);
      const body = await ended.json();
      assert.equal(body.valid, false, status);
      assert.equal(body.billingIssue, false, status);
      const token = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_pro' }),
      });
      assert.equal(token.status, 403, status);
      assert.equal((await token.json()).code, 'purchase_inactive');
      await assert.rejects(() => assertCanGenerate(stripe, 'cs_test_pro', env), (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.publicCode, 'purchase_inactive');
        return true;
      });
    }
  });

  const unknown = {
    checkout: { sessions: { retrieve: async () => { throw notFound(); } } },
  };
  await assert.rejects(() => assertCanGenerate(unknown, 'cs_test_missing', env), (err) => {
    assert.equal(err.status, 404);
    assert.equal(err.publicCode, 'purchase_not_found');
    return true;
  });
  assert.equal(accessFromSession(
    { metadata: { plan: 'pro' } },
    null,
    { id: 'sub_1', status: 'past_due' },
    env,
  ).billingIssue, true);
});

test('over-long fields and too many files are rejected before a credit is used', async () => {
  const updates = [];
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_test_owner', { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '0', plan: 'starter' } }),
      update: async (id, params) => {
        updates.push(params);
        return { id };
      },
    },
  };
  const app = createApp({ env, stripe, anthropic: { messages: { create: async () => { throw new Error('should not run'); } } } });
  await withServer(app, async (base) => {
    const tooLong = new FormData();
    tooLong.set('session_id', 'cs_test_owner');
    tooLong.set('manufacturer_name', 'M'.repeat(201));
    tooLong.set('file', new Blob(['<xml/>']), 'line.L5X');
    const rejected = await fetch(`${base}/jobs`, { method: 'POST', body: tooLong });
    assert.equal(rejected.status, 400);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.code, 'field_too_long');
    assert.match(rejectedBody.error, /manufacturer_name/);
    assert.equal(updates.length, 0);

    const doc = new FormData();
    doc.set('session_id', 'cs_test_owner');
    doc.set('doc_number', 'D'.repeat(81));
    doc.set('file', new Blob(['<xml/>']), 'line.L5X');
    assert.equal((await fetch(`${base}/jobs`, { method: 'POST', body: doc })).status, 400);
    const revision = new FormData();
    revision.set('session_id', 'cs_test_owner');
    revision.set('revision', 'R'.repeat(41));
    revision.set('file', new Blob(['<xml/>']), 'line.L5X');
    const revisionRes = await fetch(`${base}/jobs`, { method: 'POST', body: revision });
    assert.equal(revisionRes.status, 400);
    assert.equal((await revisionRes.json()).code, 'field_too_long');

    const many = new FormData();
    many.set('session_id', 'cs_test_owner');
    for (let i = 0; i < 26; i += 1) many.append('file', new Blob(['x']), `f${i}.txt`);
    const limited = await fetch(`${base}/jobs`, { method: 'POST', body: many });
    assert.equal(limited.status, 400);
    assert.equal((await limited.json()).code, 'too_many_files');
    assert.equal(updates.length, 0);
  });
});

test('a malformed JSON body is a generic 400 and the parser detail stays in the log', async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map((arg) => String(arg)).join(' '));
  const app = createApp({ env, stripe: { checkout: { sessions: { create: async () => ({ url: 'https://example.test' }) } } } });
  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/create-checkout-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"plan":',
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_json', code: 'invalid_json' });
    });
  } finally {
    console.error = original;
  }
  const logged = lines.join('\n');
  assert.match(logged, /Invalid request body/);
  assert.match(logged, /entity\.parse\.failed/);
  assert.match(logged, /length=/);
  assert.equal(logged.includes('{"plan":'), false);
  assert.equal(logged.includes('Unexpected'), false);
  assert.equal(redactSecrets('paid cs_live_abc123XYZ and cs_test_Def456').includes('cs_'), false);
  assert.match(redactSecrets('cs_test_Def456'), /\[redacted\]/);
});

test('a ready manual reloads from disk for 24 hours', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-reload-'));
  const first = createJobStore({ directory: dir, env: { NODE_ENV: 'test' } });
  const job = first.create({ sessionId: 'cs_test_owner', customerId: 'cus_owner', nameSource: 'Pump' });
  first.savePdf(job.id, Buffer.from('%PDF-1.4\n%kept\n'));
  job.status = 'succeeded';
  first.persist(job);
  first.close();
  const second = createJobStore({ directory: dir, env: { NODE_ENV: 'test' } });
  try {
    const loaded = second.get(job.id);
    assert.equal(loaded.status, 'succeeded');
    assert.equal(loaded.sessionId, undefined);
    assert.equal(loaded.customerId, undefined);
    assert.equal(loaded.sessionIdHash, first.hashCredential('cs_test_owner'));
    assert.equal(loaded.customerIdHash, first.hashCredential('cus_owner'));
    const onDisk = fs.readFileSync(path.join(dir, `${job.id}.json`), 'utf8');
    assert.equal(onDisk.includes('cs_test_owner'), false);
    assert.equal(onDisk.includes('cus_owner'), false);
    assert.equal((fs.statSync(path.join(dir, `${job.id}.json`)).mode & 0o077), 0);
    assert.equal(second.readPdf(job.id).includes(Buffer.from('%PDF-')), true);
    assert.equal(second.ready()[0].id, job.id);
  } finally {
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered token and a wrong-secret token are rejected', async () => {
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_test_owner', { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '0', plan: 'starter' } }) },
  };
  const app = createApp({ env, stripe, anthropic: null });
  const minted = signAccessToken({ sessionId: 'cs_test_owner' }, env);
  const [body, sig] = minted.token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.sid = 'cs_test_other';
  const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
  const otherEnv = { ...env, PORTAL_TOKEN_SECRET: 'another-portal-secret-0123456789abcdef' };
  const wrong = signAccessToken({ sessionId: 'cs_test_owner' }, otherEnv);
  assert.equal(verifyAccessToken(tampered, env), null);
  assert.equal(verifyAccessToken(wrong.token, env), null);
  assert.equal(verifyAccessToken(`${body}.${sig}.extra`, env), null);
  await withServer(app, async (base) => {
    const tamperedRes = await fetch(`${base}/jobs`, { headers: authHeaders(tampered) });
    assert.equal(tamperedRes.status, 401);
    assert.equal((await tamperedRes.json()).code, 'access_token_invalid');
    const wrongRes = await fetch(`${base}/jobs`, { headers: authHeaders(wrong.token) });
    assert.equal(wrongRes.status, 401);
    assert.equal((await wrongRes.json()).code, 'access_token_invalid');
  });
});

test('job reads do not send a raw or bogus session id to Stripe', async () => {
  let retrieves = 0;
  const stripe = {
    checkout: { sessions: { retrieve: async () => {
      retrieves += 1;
      throw notFound();
    } } },
    subscriptions: { retrieve: async () => {
      retrieves += 1;
      throw notFound();
    } },
    paymentIntents: { retrieve: async () => {
      retrieves += 1;
      throw notFound();
    } },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-amplify-'));
  const store = createJobStore({ directory: dir, env });
  try {
    const jobs = [];
    for (let i = 0; i < 3; i += 1) {
      const job = store.create({
        sessionId: `cs_test_job${i}`,
        customerId: 'cus_real',
        subscriptionId: 'sub_real',
        nameSource: `Line ${i}`,
      });
      store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
      job.status = 'succeeded';
      store.persist(job);
      jobs.push(job);
    }
    const app = createApp({ env, stripe, jobs: store, anthropic: null });
    const token = signAccessToken({
      sessionId: 'cs_test_real',
      customerId: 'cus_real',
      subscriptionId: 'sub_real',
    }, env).token;
    await withServer(app, async (base) => {
      const junkList = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_test_madeup' } });
      assert.equal(junkList.status, 200);
      assert.deepEqual((await junkList.json()).jobs, []);
      const junk = await fetch(`${base}/jobs/${jobs[0].id}`, { headers: { 'X-Session-Id': 'cs_test_madeup' } });
      assert.equal(junk.status, 403);
      assert.equal((await junk.json()).code, 'forbidden');
      const junkPdf = await fetch(`${base}/jobs/${jobs[0].id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_madeup' } });
      assert.equal(junkPdf.status, 403);
      assert.equal(retrieves, 0);
      const owned = await fetch(`${base}/jobs`, { headers: authHeaders(token) });
      assert.equal(owned.status, 200);
      assert.equal((await owned.json()).jobs.length, 3);
      assert.equal(retrieves, 0);
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rate limits return 429 and the webhook stays unlimited', async () => {
  const stripe = {
    checkout: { sessions: { retrieve: async () => { throw notFound(); } } },
  };
  const app = createApp({ env, stripe, anthropic: null });
  await withServer(app, async (base) => {
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await fetch(`${base}/verify-session?session_id=cs_test_rate${i}`);
    }
    assert.equal(last.status, 429);
    const body = await last.json();
    assert.deepEqual(body, { error: 'Too many requests.' });
    assert.ok(Number(last.headers.get('retry-after')) > 0);

    let webhookStatus = 0;
    for (let i = 0; i < 12; i += 1) {
      const hook = await fetch(`${base}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'nope' },
        body: '{}',
      });
      webhookStatus = hook.status;
      await hook.text();
    }
    assert.equal(webhookStatus, 400);
  });
});

test('a session can mint thirty access tokens an hour and the 429 states the wait', async () => {
  assert.equal(EXCHANGE_LIMIT, 30);
  const sessionId = 'cs_test_exchangelimit';
  for (let i = 0; i < EXCHANGE_LIMIT; i += 1) {
    assert.equal(tokenExchangeGate(sessionId, env).ok, true);
    recordTokenExchange(sessionId, env);
  }
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession(sessionId, { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '0', plan: 'starter' } }) },
  };
  const app = createApp({ env, stripe, anthropic: null });
  await withServer(app, async (base) => {
    const blocked = await fetch(`${base}/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    assert.equal(blocked.status, 429);
    const wait = Number(blocked.headers.get('retry-after'));
    assert.ok(wait > 0 && wait <= 3600);
    assert.deepEqual(await blocked.json(), { error: `Too many token exchanges. Try again in ${wait} seconds.` });
  });
});

test('LEGACY_SESSION_ID_SUNSET turns off the direct session_id path', async () => {
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_test_owner', { manuals_used: '1', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '1', plan: 'starter' } }) },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-sunset-'));
  const store = createJobStore({ directory: dir, env });
  const job = store.create({ sessionId: 'cs_test_owner', nameSource: 'Pump' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
  job.status = 'succeeded';
  store.persist(job);
  const sunsetEnv = { ...env, LEGACY_SESSION_ID_SUNSET: '2000-01-01' };
  const app = createApp({ env: sunsetEnv, stripe, jobs: store, anthropic: null });
  try {
    await withServer(app, async (base) => {
      const health = await fetch(`${base}/health`);
      assert.equal((await health.json()).portalTokens, true);
      const listed = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_test_owner' } });
      assert.equal(listed.status, 401);
      assert.equal((await listed.json()).code, 'session_id_retired');
      const verified = await fetch(`${base}/verify-session?session_id=cs_test_owner`);
      assert.equal(verified.status, 401);
      assert.equal((await verified.json()).code, 'session_id_retired');
      const pdfBlocked = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_owner' } });
      assert.equal(pdfBlocked.status, 401);
      assert.equal((await pdfBlocked.json()).code, 'session_id_retired');
      const started = new FormData();
      started.set('session_id', 'cs_test_owner');
      started.set('file', new Blob(['<xml/>']), 'line.L5X');
      const jobStart = await fetch(`${base}/jobs`, { method: 'POST', body: started });
      assert.equal(jobStart.status, 401);
      assert.equal((await jobStart.json()).code, 'session_id_retired');
      const exchanged = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_owner' }),
      });
      assert.equal(exchanged.status, 200);
      const token = (await exchanged.json()).access_token;
      const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(token) });
      assert.equal(pdf.status, 200);
      await pdf.arrayBuffer();
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a short or missing portal secret disables tokens and reports that on health', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const shortEnv = { ...env, PORTAL_TOKEN_SECRET: 'too-short' };
  const { PORTAL_TOKEN_SECRET: _omitted, ...missingEnv } = env;
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_test_short', { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '0', plan: 'starter' } }) },
  };
  try {
    const shortApp = createApp({ env: shortEnv, stripe, anthropic: null });
    await withServer(shortApp, async (base) => {
      const health = await fetch(`${base}/health`);
      const healthBody = await health.json();
      assert.equal(healthBody.portalTokens, false);
      assert.equal(JSON.stringify(healthBody).includes('too-short'), false);
      const minted = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_short' }),
      });
      assert.equal(minted.status, 503);
      const body = await minted.json();
      assert.equal(body.code, 'portal_tokens_disabled');
      assert.equal(JSON.stringify(body).includes('too-short'), false);
      const listed = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_test_short' } });
      assert.equal(listed.status, 200);
    });
    const missingApp = createApp({ env: missingEnv, stripe, anthropic: null });
    await withServer(missingApp, async (base) => {
      const health = await fetch(`${base}/health`);
      assert.equal((await health.json()).portalTokens, false);
      const minted = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_short' }),
      });
      assert.equal(minted.status, 503);
      assert.equal((await minted.json()).code, 'portal_tokens_disabled');
    });
  } finally {
    console.error = original;
  }
  const logged = errors.join('\n');
  assert.match(logged, /PORTAL_TOKEN_SECRET is missing or shorter than 32 bytes\. Portal tokens are disabled\./);
  assert.equal(logged.includes('too-short'), false);
  assert.equal(logged.includes(env.PORTAL_TOKEN_SECRET), false);
});

test('revoking a token blocks the checkout session until a new token is exchanged', async () => {
  const updates = [];
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_test_bug27', { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: {
      retrieve: async () => ({ id: 'pi_bug27', metadata: { manuals_used: '0', plan: 'starter' } }),
      update: async (id, params) => {
        updates.push(params);
        return { id };
      },
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-bug27-'));
  const supportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-bug27-support-'));
  const bugEnv = { ...env, SUPPORT_DATA_DIR: supportDir };
  const store = createJobStore({ directory: dir, env: bugEnv });
  const job = store.create({ sessionId: 'cs_test_bug27', nameSource: 'Pump' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
  job.status = 'succeeded';
  store.persist(job);
  const app = createApp({ env: bugEnv, stripe, jobs: store, anthropic: { messages: { create: async () => { throw new Error('should not run'); } } } });
  try {
    await withServer(app, async (base) => {
      const first = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_bug27' }),
      });
      assert.equal(first.status, 200);
      const firstToken = (await first.json()).access_token;
      const second = signAccessToken({ sessionId: 'cs_test_bug27' }, bugEnv);
      const rawPdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_bug27' } });
      assert.equal(rawPdf.status, 200);
      await rawPdf.arrayBuffer();

      const revoked = await fetch(`${base}/access-token/revoke`, {
        method: 'POST',
        headers: authHeaders(firstToken),
      });
      assert.equal(revoked.status, 200);
      const old = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(firstToken) });
      assert.equal(old.status, 401);
      const sibling = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(second.token) });
      assert.equal(sibling.status, 401);
      const rawAfter = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_bug27' } });
      assert.equal(rawAfter.status, 401);
      assert.equal((await rawAfter.json()).code, 'credential_revoked');
      const started = new FormData();
      started.set('session_id', 'cs_test_bug27');
      started.set('file', new Blob(['<xml/>']), 'line.L5X');
      const jobStart = await fetch(`${base}/jobs`, { method: 'POST', body: started });
      assert.equal(jobStart.status, 401);
      assert.equal((await jobStart.json()).code, 'credential_revoked');
      assert.equal(updates.length, 0);

      const jti = JSON.parse(Buffer.from(firstToken.split('.')[0], 'base64url').toString('utf8')).jti;
      dropRevokedJti(jti);
      forgetSessionCredential('cs_test_bug27', bugEnv);
      assert.ok(verifyAccessToken(firstToken, bugEnv));
      loadRevocations(bugEnv);
      assert.equal(verifyAccessToken(firstToken, bugEnv), null);
      const persisted = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_bug27' } });
      assert.equal(persisted.status, 401);
      assert.equal((await persisted.json()).code, 'credential_revoked');
      const saved = fs.readFileSync(path.join(supportDir, 'revoked-tokens.json'), 'utf8');
      assert.equal(saved.includes('cs_test_bug27'), false);
      const parsed = JSON.parse(saved);
      assert.equal(typeof parsed.tokens[jti], 'number');
      assert.equal(Object.values(parsed.sessions).some((state) => state.rawBlocked === true), true);

      const fresh = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_bug27' }),
      });
      assert.equal(fresh.status, 200);
      const freshToken = (await fresh.json()).access_token;
      const again = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(freshToken) });
      assert.equal(again.status, 200);
      await again.arrayBuffer();
      const rawAgain = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_bug27' } });
      assert.equal(rawAgain.status, 200);
      await rawAgain.arrayBuffer();
      const stale = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(firstToken) });
      assert.equal(stale.status, 401);
      assert.equal(updates.length, 0);
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(supportDir, { recursive: true, force: true });
  }
});

test('a revoked session cannot bypass the access-token rate limit', async () => {
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_test_bug27limit', { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_bug27_limit', metadata: { manuals_used: '0', plan: 'starter' } }) },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-bug27-limit-'));
  const store = createJobStore({ directory: dir, env });
  const job = store.create({ sessionId: 'cs_test_bug27limit', nameSource: 'Pump' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
  job.status = 'succeeded';
  store.persist(job);
  const app = createApp({ env, stripe, jobs: store, anthropic: null });
  try {
    await withServer(app, async (base) => {
      const minted = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_bug27limit' }),
      });
      assert.equal(minted.status, 200);
      const token = (await minted.json()).access_token;
      for (let i = 1; i < EXCHANGE_LIMIT; i += 1) recordTokenExchange('cs_test_bug27limit', env);
      const revoked = await fetch(`${base}/access-token/revoke`, {
        method: 'POST',
        headers: authHeaders(token),
      });
      assert.equal(revoked.status, 200);
      const blocked = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_test_bug27limit' }),
      });
      assert.equal(blocked.status, 429);
      const wait = Number(blocked.headers.get('retry-after'));
      assert.ok(wait > 0 && wait <= 3600);
      assert.deepEqual(await blocked.json(), { error: `Too many token exchanges. Try again in ${wait} seconds.` });
      const raw = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_test_bug27limit' } });
      assert.equal(raw.status, 401);
      assert.equal((await raw.json()).code, 'credential_revoked');
    });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
