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
  loadRevocations,
  signAccessToken,
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
      assert.equal(pdf.headers.get('cache-control'), 'no-store');
      assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(pdf.headers.get('referrer-policy'), 'no-referrer');
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
      assert.equal(exchanged.headers.get('cache-control'), 'no-store');
      assert.equal(exchanged.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(exchanged.headers.get('pragma'), 'no-cache');

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
  const job = first.create({ sessionId: 'cs_owner', customerId: 'cus_owner', nameSource: 'Pump' });
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
    assert.equal(loaded.sessionIdHash, first.hashCredential('cs_owner'));
    assert.equal(loaded.customerIdHash, first.hashCredential('cus_owner'));
    const onDisk = fs.readFileSync(path.join(dir, `${job.id}.json`), 'utf8');
    assert.equal(onDisk.includes('cs_owner'), false);
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
    checkout: { sessions: { retrieve: async () => starterSession('cs_owner', { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '0', plan: 'starter' } }) },
  };
  const app = createApp({ env, stripe, anthropic: null });
  const minted = signAccessToken({ sessionId: 'cs_owner' }, env);
  const [body, sig] = minted.token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  payload.sid = 'cs_other';
  const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
  const otherEnv = { ...env, PORTAL_TOKEN_SECRET: 'another-portal-secret-0123456789abcdef' };
  const wrong = signAccessToken({ sessionId: 'cs_owner' }, otherEnv);
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

test('GET /jobs resolves a compat caller once and does not call Stripe per job', async () => {
  let retrieves = 0;
  const stripe = {
    checkout: { sessions: { retrieve: async (id) => {
      retrieves += 1;
      if (id !== 'cs_real') throw notFound();
      return {
        id,
        metadata: { plan: 'pro' },
        payment_status: 'paid',
        customer: 'cus_real',
        subscription: { id: 'sub_real', status: 'active', customer: 'cus_real' },
      };
    } } },
    subscriptions: { retrieve: async () => ({ id: 'sub_real', status: 'active', customer: 'cus_real' }) },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-amplify-'));
  const store = createJobStore({ directory: dir, env });
  try {
    for (let i = 0; i < 3; i += 1) {
      const job = store.create({
        sessionId: `cs_job_${i}`,
        customerId: 'cus_real',
        subscriptionId: 'sub_real',
        nameSource: `Line ${i}`,
      });
      store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
      job.status = 'succeeded';
      store.persist(job);
    }
    const app = createApp({ env, stripe, jobs: store, anthropic: null });
    await withServer(app, async (base) => {
      const junk = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_made_up' } });
      assert.equal(junk.status, 401);
      assert.equal((await junk.json()).code, 'authorization_required');
      assert.equal(retrieves, 1);
      const owned = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_real' } });
      assert.equal(owned.status, 200);
      assert.equal((await owned.json()).jobs.length, 3);
      assert.equal(retrieves, 2);
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
      last = await fetch(`${base}/verify-session?session_id=cs_rate_${i}`);
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

test('a session can mint only five access tokens an hour', async () => {
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_exchange_limit', { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '0', plan: 'starter' } }) },
  };
  const app = createApp({ env, stripe, anthropic: null });
  await withServer(app, async (base) => {
    for (let i = 0; i < EXCHANGE_LIMIT; i += 1) {
      const ok = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_exchange_limit' }),
      });
      assert.equal(ok.status, 200, String(i));
      await ok.json();
    }
    const blocked = await fetch(`${base}/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'cs_exchange_limit' }),
    });
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: 'Too many requests.' });
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
});

test('LEGACY_SESSION_ID_SUNSET turns off the direct session_id path', async () => {
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_owner', { manuals_used: '1', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '1', plan: 'starter' } }) },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-sunset-'));
  const store = createJobStore({ directory: dir, env });
  const job = store.create({ sessionId: 'cs_owner', nameSource: 'Pump' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
  job.status = 'succeeded';
  store.persist(job);
  const sunsetEnv = { ...env, LEGACY_SESSION_ID_SUNSET: '2000-01-01' };
  const app = createApp({ env: sunsetEnv, stripe, jobs: store, anthropic: null });
  try {
    await withServer(app, async (base) => {
      const listed = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(listed.status, 401);
      const verified = await fetch(`${base}/verify-session?session_id=cs_owner`);
      assert.equal(verified.status, 400);
      const exchanged = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_owner' }),
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

test('a short portal secret disables tokens and a revocation survives a restart', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const shortEnv = { ...env, PORTAL_TOKEN_SECRET: 'too-short' };
  const stripe = {
    checkout: { sessions: { retrieve: async () => starterSession('cs_owner', { manuals_used: '0', plan: 'starter' }) } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_1', metadata: { manuals_used: '0', plan: 'starter' } }) },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-revoke-'));
  const store = createJobStore({ directory: dir, env });
  const job = store.create({ sessionId: 'cs_owner', nameSource: 'Pump' });
  store.savePdf(job.id, Buffer.from('%PDF-1.4\n'));
  job.status = 'succeeded';
  store.persist(job);
  try {
    const shortApp = createApp({ env: shortEnv, stripe, jobs: store, anthropic: null });
    await withServer(shortApp, async (base) => {
      const minted = await fetch(`${base}/access-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'cs_owner' }),
      });
      assert.equal(minted.status, 503);
      const listed = await fetch(`${base}/jobs`, { headers: { 'X-Session-Id': 'cs_owner' } });
      assert.equal(listed.status, 200);
      assert.equal((await listed.json()).jobs.length, 1);
    });
    assert.match(warnings.join('\n'), /shorter than 32 bytes/);

    const supportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manualos-support-'));
    const durableEnv = { ...env, SUPPORT_DATA_DIR: supportDir };
    const minted = signAccessToken({ sessionId: 'cs_owner' }, durableEnv);
    const durable = createApp({ env: durableEnv, stripe, jobs: store, anthropic: null });
    try {
      await withServer(durable, async (base) => {
        const revoked = await fetch(`${base}/access-token/revoke`, {
          method: 'POST',
          headers: authHeaders(minted.token),
        });
        assert.equal(revoked.status, 200);
        const jti = JSON.parse(Buffer.from(minted.token.split('.')[0], 'base64url').toString('utf8')).jti;
        dropRevokedJti(jti);
        assert.ok(verifyAccessToken(minted.token, durableEnv));
        loadRevocations(durableEnv);
        assert.equal(verifyAccessToken(minted.token, durableEnv), null);
        const after = await fetch(`${base}/jobs/${job.id}`, { headers: authHeaders(minted.token) });
        assert.equal(after.status, 401);
        const saved = JSON.parse(fs.readFileSync(path.join(supportDir, 'revoked-tokens.json'), 'utf8'));
        assert.equal(typeof saved[jti], 'number');
      });
    } finally {
      fs.rmSync(supportDir, { recursive: true, force: true });
    }
  } finally {
    console.warn = original;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
