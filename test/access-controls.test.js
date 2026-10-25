const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { createJobStore, removeTestJobDirectories } = require('../lib/jobs/store');
const { assertCanGenerate, accessFromSession, STARTER_REFUNDED_MESSAGE } = require('../lib/billing');
const { contentDisposition, downloadFileName } = require('../lib/download-name');
const { signAccessToken, verifyAccessToken, ACCESS_TOKEN_TTL_MS } = require('../lib/access-token');

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
  PORTAL_TOKEN_SECRET: 'portal-test-secret',
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

test('download names are ascii slugs with an RFC 5987 filename for non-ASCII', () => {
  assert.equal(downloadFileName(''), 'manualos-manual.pdf');
  assert.equal(downloadFileName('!!!'), 'manualos-manual.pdf');
  assert.equal(downloadFileName('Infeed Line'), 'infeed-line-manual.pdf');
  const long = 'A'.repeat(80);
  assert.equal(downloadFileName(long), `${'a'.repeat(60)}-manual.pdf`);
  assert.equal(contentDisposition('Infeed Line'), 'attachment; filename="infeed-line-manual.pdf"');
  const header = contentDisposition('Förderband');
  assert.match(header, /filename="forderband-manual\.pdf"/);
  assert.match(header, /filename\*=UTF-8''F%C3%B6rderband-manual\.pdf/);
  assert.equal(header.includes('\n'), false);
});

test('job routes require the owner and a revoked purchase keeps the access block', async () => {
  const meta = { manuals_used: '1', plan: 'starter', credit_status: 'active' };
  const sessions = {
    cs_owner: () => starterSession('cs_owner', meta),
    cs_other: () => starterSession('cs_other', { manuals_used: '0', plan: 'starter' }),
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
  const job = store.create({ sessionId: 'cs_owner', nameSource: 'Förderband Linie' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n%owned\n'));
  job.status = 'succeeded';
  store.persist(job);
  const stranger = store.create({ sessionId: 'cs_other', nameSource: 'Other' });
  store.savePdf(stranger.id, Buffer.from('%PDF-1.4\n%other\n'));
  stranger.status = 'succeeded';
  store.persist(stranger);
  const app = createApp({ env, stripe, jobs: store, anthropic: null });
  try {
    await withServer(app, async (base) => {
      const missing = await fetch(`${base}/jobs/${job.id}`);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'Job not found or expired.' });

      const query = await fetch(`${base}/jobs/${job.id}/pdf?session_id=cs_owner`);
      assert.equal(query.status, 404);
      assert.deepEqual(await query.json(), { error: 'Job not found or expired.' });

      const other = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_other' } });
      assert.equal(other.status, 404);
      assert.deepEqual(await other.json(), await (await fetch(`${base}/jobs/job_${'ab'.repeat(12)}`, {
        headers: { 'X-Session-Id': 'cs_other' },
      })).json());

      const owned = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(owned.status, 200);
      assert.equal((await owned.json()).status, 'succeeded');
      assert.equal(JSON.stringify(await (await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_owner' } })).json()).includes('cs_owner'), false);

      const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(pdf.status, 200);
      assert.match(pdf.headers.get('content-disposition'), /filename="forderband-linie-manual\.pdf"/);
      assert.match(pdf.headers.get('content-disposition'), /filename\*=UTF-8''/);
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');

      const again = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(again.status, 200);
      await again.arrayBuffer();
      assert.equal(updates.length, 0);

      const listed = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(listed.status, 200);
      const body = await listed.json();
      assert.deepEqual(body.jobs.map((item) => item.id), [job.id]);
      assert.equal(body.jobs[0].filename, 'forderband-linie-manual.pdf');
      assert.equal(body.jobs[0].download_path, `/jobs/${job.id}/pdf`);

      const hidden = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_other' } });
      assert.deepEqual((await hidden.json()).jobs.map((item) => item.id), [stranger.id]);

      meta.credit_status = 'revoked';
      const revokedPdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(revokedPdf.status, 402);
      assert.equal((await revokedPdf.json()).error, STARTER_REFUNDED_MESSAGE);
      const revokedStatus = await fetch(`${base}/jobs/${job.id}`, { headers: { 'X-Session-Id': 'cs_owner' } });
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
      if (id === 'cs_owner') return starterSession('cs_owner', meta);
      if (id === 'cs_gone') throw notFound();
      if (id === 'cs_canceled') {
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
  const job = store.create({ sessionId: 'cs_owner', customerId: 'cus_pro', subscriptionId: 'sub_pro', nameSource: 'Widget' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
  job.status = 'succeeded';
  store.persist(job);
  const app = createApp({ env, stripe, jobs: store, anthropic: null });
  try {
    await withServer(app, async (base) => {
      const missing = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_gone' }),
      });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).code, 'purchase_not_found');

      const inactive = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_canceled' }),
      });
      assert.equal(inactive.status, 403);
      assert.equal((await inactive.json()).code, 'purchase_inactive');

      const exchanged = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_owner' }),
      });
      assert.equal(exchanged.status, 200);
      const tokenBody = await exchanged.json();
      assert.equal(tokenBody.token_type, 'Bearer');
      assert.equal(tokenBody.expires_in, ACCESS_TOKEN_TTL_MS / 1000);
      assert.equal(tokenBody.valid, true);
      assert.equal(tokenBody.plan, 'starter');
      assert.equal(tokenBody.billingIssue, false);

      const pdf = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(tokenBody.access_token) });
      assert.equal(pdf.status, 200);
      await pdf.arrayBuffer();

      const sameSub = signAccessToken({
        sessionId: 'cs_second',
        customerId: 'cus_pro',
        subscriptionId: 'sub_pro',
      }, env);
      const shared = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(sameSub.token) });
      assert.equal(shared.status, 200);
      await shared.arrayBuffer();

      const otherSub = signAccessToken({ sessionId: 'cs_third', subscriptionId: 'sub_other' }, env);
      const denied = await fetch(`${base}/jobs/${job.id}`, { headers: authHeaders(otherSub.token) });
      assert.equal(denied.status, 404);

      const revoked = await fetch(`${base}/access-token/revoke`, {
        method: 'POST',
        headers: authHeaders(tokenBody.access_token),
      });
      assert.equal(revoked.status, 200);
      const after = await fetch(`${base}/jobs/${job.id}/pdf`, { headers: authHeaders(tokenBody.access_token) });
      assert.equal(after.status, 401);
      assert.equal((await after.json()).code, 'access_token_invalid');

      const expired = signAccessToken({ sessionId: 'cs_owner' }, env, Date.now() - ACCESS_TOKEN_TTL_MS - 1000);
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
      id: 'cs_pro',
      metadata: { plan: 'pro' },
      payment_status: 'paid',
      subscription: sub,
      customer: 'cus_1',
    }) } },
    subscriptions: { retrieve: async () => sub },
  };
  const app = createApp({ env, stripe, anthropic: null });
  await withServer(app, async (base) => {
    const verified = await fetch(`${base}/verify-session?session_id=cs_pro`);
    assert.deepEqual(await verified.json(), {
      valid: true,
      plan: 'pro',
      remaining: null,
      billingIssue: true,
    });
    const exchanged = await fetch(`${base}/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_pro' }),
    });
    assert.equal(exchanged.status, 200);
    assert.equal((await exchanged.json()).billingIssue, true);
    await assert.doesNotReject(() => assertCanGenerate(stripe, 'cs_pro', env));

    for (const status of ['unpaid', 'canceled', 'incomplete_expired']) {
      sub.status = status;
      const ended = await fetch(`${base}/verify-session?session_id=cs_pro`);
      const body = await ended.json();
      assert.equal(body.valid, false, status);
      assert.equal(body.billingIssue, false, status);
      const token = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_pro' }),
      });
      assert.equal(token.status, 403, status);
      assert.equal((await token.json()).code, 'purchase_inactive');
      await assert.rejects(() => assertCanGenerate(stripe, 'cs_pro', env), (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.publicCode, 'purchase_inactive');
        return true;
      });
    }
  });

  const unknown = {
    checkout: { sessions: { retrieve: async () => { throw notFound(); } } },
  };
  await assert.rejects(() => assertCanGenerate(unknown, 'cs_missing', env), (err) => {
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
    checkout: { sessions: { retrieve: async () => starterSession('cs_owner', { manuals_used: '0', plan: 'starter' }) } },
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
    tooLong.set('session_id', 'cs_owner');
    tooLong.set('manufacturer_name', 'M'.repeat(201));
    tooLong.set('file', new Blob(['<xml/>']), 'line.L5X');
    const rejected = await fetch(`${base}/jobs`, { method: 'POST', body: tooLong });
    assert.equal(rejected.status, 400);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.code, 'field_too_long');
    assert.match(rejectedBody.error, /manufacturer_name/);
    assert.equal(updates.length, 0);

    const doc = new FormData();
    doc.set('session_id', 'cs_owner');
    doc.set('doc_number', 'D'.repeat(81));
    doc.set('file', new Blob(['<xml/>']), 'line.L5X');
    assert.equal((await fetch(`${base}/jobs`, { method: 'POST', body: doc })).status, 400);
    const revision = new FormData();
    revision.set('session_id', 'cs_owner');
    revision.set('revision', 'R'.repeat(41));
    revision.set('file', new Blob(['<xml/>']), 'line.L5X');
    const revisionRes = await fetch(`${base}/jobs`, { method: 'POST', body: revision });
    assert.equal(revisionRes.status, 400);
    assert.equal((await revisionRes.json()).code, 'field_too_long');

    const many = new FormData();
    many.set('session_id', 'cs_owner');
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
      assert.deepEqual(await res.json(), { error: 'Invalid request body.' });
    });
  } finally {
    console.error = original;
  }
  const logged = lines.join('\n');
  assert.match(logged, /Invalid request body/);
  assert.match(logged, /JSON/);
  assert.equal(logged.includes('{"plan":'), false);
});

test('a ready manual reloads from disk for 24 hours', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-reload-'));
  const first = createJobStore({ directory: dir, env: { NODE_ENV: 'test' } });
  const job = first.create({ sessionId: 'cs_owner', nameSource: 'Pump' });
  first.savePdf(job.id, Buffer.from('%PDF-1.4\n%kept\n'));
  job.status = 'succeeded';
  first.persist(job);
  first.close();
  const second = createJobStore({ directory: dir, env: { NODE_ENV: 'test' } });
  try {
    const loaded = second.get(job.id);
    assert.equal(loaded.status, 'succeeded');
    assert.equal(second.readPdf(job.id).includes(Buffer.from('%PDF-')), true);
    assert.equal(second.ready()[0].id, job.id);
  } finally {
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
