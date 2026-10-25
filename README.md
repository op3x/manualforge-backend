# ManualOS backend

Node/Express API for [ManualOS](https://manualos.com). It opens Stripe Checkout, checks that a checkout is still paid, and generates a PLC operator-manual PDF.

The website is a separate static site (`op3x/matrixmanual-frontend`). This service only serves the API. Production is `https://manualforge-backend-production.up.railway.app`.

## Pricing

- **Starter** is a $39 one-time payment. It includes `STARTER_CREDITS` manuals (default 3). `POST /jobs` reserves one credit when the job starts and refunds it if generation fails. `POST /generate-manual` still increments `manuals_used` only after a PDF is produced.
- **Pro** is a $79 monthly subscription. Generation stays available while that subscription's status is `active` or `trialing`, and while it is `past_due` for up to 7 days after the failed invoice's `period_start`. `unpaid`, `canceled`, and `incomplete_expired` stay blocked.

## API

### `POST /create-checkout-session`

Request JSON: `{ "plan": "starter" }` or `{ "plan": "pro" }`.

Response JSON: `{ "url": "<hosted Checkout URL>" }`.

Starter uses Checkout `mode: "payment"` and `STRIPE_PRICE_STARTER`. Pro uses `mode: "subscription"` and `STRIPE_PRICE_PRO` (a recurring monthly price). Session metadata is `{ plan }`. Redirects:

- success: `${FRONTEND_URL}/upload.html?session_id={CHECKOUT_SESSION_ID}`
- cancel: `${FRONTEND_URL}/#pricing`

### `GET /verify-session?session_id=cs_...`

Response JSON: `{ "valid": boolean, "plan": "starter" | "pro" | null, "remaining": number | null }`.

Starter is valid when the Checkout Session `payment_status` is `paid`. `remaining` is `STARTER_CREDITS` minus `manuals_used`. Pro is valid when the session's subscription status is `active` or `trialing`, and `remaining` is `null` (unlimited). A paid Starter session with zero manuals left is still `valid: true` with `remaining: 0`; generation then returns 402.

`past_due` is also valid until 7 days after the failed invoice's `period_start` (Unix seconds on `latest_invoice`). The response then includes `payment_issue: true`, which the upload page uses for an "Update your card" banner. When `period_start` is missing, the invoice line's `period.start` is used, then `current_period_start`. If none of those is present, access is blocked. At exactly 7 days, access is blocked. `payment_issue: true` is still added whenever the status is `past_due`, including after the grace window. Other statuses omit `payment_issue`.

### `POST /access-link`

Request JSON: `{ "email": "buyer@example.com" }`.

Response is always `202` `{ "ok": true }` when the address is valid and the rate limit allows it, whether or not that email has a Checkout Session. Invalid or oversized addresses (more than 254 characters) get `400` `{ "error": "A valid email is required." }`. More than 3 requests for one email per hour, or more than 10 requests from one IP per hour, get `429` `{ "error": "Too many requests. Try again later." }`. The limit uses `req.ip` with `trust proxy` set to 1, so the client address is the one added by the single proxy in front of the app.

The lookup is Checkout Sessions with `status: "complete"`, `customer_details.email` set to the normalized address, `created` within the last 12 months, and `limit: 10`. Sessions that are `paid` and still active (Starter with a PaymentIntent, or Pro `active`, `trialing`, or `past_due` inside the grace window) are emailed as upload links. The response does not say how many were sent.

### `POST /billing-portal`

Request JSON: `{ "session_id": "cs_..." }`.

Response JSON: `{ "url": "<Stripe Billing Portal URL>" }` for a paid Pro Checkout Session. `return_url` is `${FRONTEND_URL}/upload.html?session_id=<cs_id>`. A Starter session is `400`. A missing `session_id` is `400`. Any other session (unknown, unpaid, or not Pro) is `402`.

### `POST /jobs`

Preferred upload. Multipart fields `file` and/or `files` (up to 25), plus `session_id` (form field or `X-Session-Id`). Optional fields: `brand`, `manufacturer_name`, `manufacturer_address`, `product_name`, `model`, `doc_number`, `revision`, `language`.

`202` JSON:

```json
{ "id": "job_…", "status": "queued", "progress": { "stage": "queued", "percent": 0, "message": "…" }, "error": null, "warnings": [], "coverage": null, "createdAt": "…", "expiresAt": "…" }
```

Poll `GET /jobs/:id` with header `X-Session-Id` set to the checkout session that created the job. The same header is required for `GET /jobs/:id/pdf`. A missing header, or a header for a different session, is `404` with the same body as an unknown id. A `session_id` query parameter does not authorize the download. `GET /jobs/:id/pdf` returns `application/pdf` when the job succeeded, `409` when it is not ready, and `404` when the id is unknown, owned by someone else, or older than 24 hours. Stages are `queued`, `parsing`, `analyzing`, `assembling`, `rendering`, `done`, and `failed`.

`GET /jobs?mine` with `X-Session-Id` returns `{ "jobs": [ { "id", "status", "created_at", "filename", "pdf_available" } ] }` for that session's jobs from the last 24 hours. `pdf_available` is true only when the job succeeded and the PDF is still on disk. A missing header is `404`.

Job records are written atomically to `jobs.json` under `DATA_DIR` (or the temporary job directory when `DATA_DIR` is unset). PDFs in that directory are still deleted 24 hours after they were written. On startup, a job left `running` is marked `failed`. If it had reserved a Starter credit, that credit is refunded so a redeploy does not keep it. Set `DATA_DIR` to a disk that survives restarts, or the refund cannot see the interrupted job.

Accepted content, detected from the bytes rather than the extension: Rockwell L5X and L5K, Rockwell ACD (converted to L5X with the vendored Apache-2.0 `acd-tools` package; a routine the converter cannot read is named in the manual), Siemens SIMATIC ML block XML (LAD, FBD, SCL, GRAPH, and statement list), Siemens SCL/ST and DATA_BLOCK source, Siemens STL/AWL (S7-300/400 and S7-200), PLCopen XML, TwinCAT TcPOU, CSV and XLSX tag lists, STEP, IGES, ASCII or binary DXF, and ASCII or binary STL (size and approximate shape only). A Zip may contain those files. `.zap` / `.ap` / `.s7p`, `.dwg`, and SolidWorks `.sldprt` / `.sldasm` / `.slddrw` are rejected with the export to use instead (SCL or SIMATIC ML XML, DXF, or STEP). Unknown or mismatched content returns **415**. A file that parses but contains no equipment data returns **422**. Neither spends a credit. Executable uploads are rejected. Zip entries are checked for path traversal, nesting, file count, and uncompressed size.

ACD conversion needs `python3` on PATH. Nixpacks installs it next to Node. The Python packages are vendored under `third_party/python` so the image does not download them at runtime. See `THIRD_PARTY_NOTICES.md`.

One failed model chunk does not fail the job. The manual is still built from the parsed project, and coverage must account for every rung or statement.

### `POST /generate-manual`

Kept for the current site. Same body as before (`file`, or JSON `plcContent`, plus `session_id`). Success is `application/pdf` with `Deprecation: true` and `Link: </jobs>; rel="successor-version"`. The Starter counter increments only after the PDF is sent. A missing model key returns **503** and does not spend a credit.

### `POST /webhook`

Raw JSON body. The route verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` and logs the event. Requests with a bad or missing signature get `400`.

When `checkout.session.completed` arrives for Starter or Pro, the buyer is emailed their upload link: `${FRONTEND_URL}/upload.html?session_id=<cs_id>`. The message is plain text and simple HTML, From `support@manualos.com` (or `SMTP_FROM` when that is set), subject `Your ManualOS upload link`. The body does not name a vendor or a product. The send is idempotent per Checkout Session and is recorded in `return-link-sent.json` under `MANUALOS_ACCOUNT_DIR` when that is set, otherwise under `DATA_DIR`, otherwise in the job directory. A webhook retry does not send a second copy. If `SMTP_HOST` is unset, the server logs `return-link email skipped: SMTP not configured` and still returns `200`. A mail failure is logged and does not fail the webhook.

Each generate call re-reads the Checkout Session, PaymentIntent, and Subscription, so access stays correct even if a webhook is delayed. The endpoint is still required: subscription renewals, cancellations, and delayed payment methods are asynchronous, and the signature is what shows the call came from Stripe.

### `GET /health`

`{ "status": "ok", "service": "manualos-backend", "aiEnabled": boolean }`.

Errors returned to browsers are short JSON messages. Stack traces stay in the server log.

## Environment

Copy `.env.example` to `.env` for local runs. Set the same names on Railway. Never commit real keys.

| Variable | Required | Role |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Yes, to generate manuals | Anthropic Messages API key |
| `ANTHROPIC_MODEL` | No | Model id. Default `claude-haiku-5-5` |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret or restricted key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Signing secret for `/webhook` |
| `STRIPE_PRICE_STARTER` | Yes | Price id for the $39 one-time Starter price |
| `STRIPE_PRICE_PRO` | Yes | Price id for the $79/month Pro price |
| `STARTER_CREDITS` | No | Manuals included with Starter. Default `3` |
| `FRONTEND_URL` | Yes in production | Site origin, for example `https://manualos.com`. Also used in the upload link and the Billing Portal return URL. |
| `DATA_DIR` | No | Persistent directory for `jobs.json`, PDFs, and (unless `MANUALOS_ACCOUNT_DIR` is set) the return-link sent set. Use a volume that survives redeploys. |
| `MANUALOS_ACCOUNT_DIR` | No | When set, the return-link sent set is stored here instead of `DATA_DIR`. |
| `SMTP_HOST` | For upload-link email | SMTP server. Unset skips the email and logs `return-link email skipped: SMTP not configured`. |
| `SMTP_PORT` | No | Default `587`. Port `465` uses implicit TLS. |
| `SMTP_USER` | No | SMTP username. Leave unset for a relay that does not authenticate. |
| `SMTP_PASS` | No | SMTP password. Never logged. |
| `SMTP_FROM` | No | From address. Defaults to `support@manualos.com`. |
| `PORT` | No | Railway sets this. Local default `3001` |
| `PUPPETEER_EXECUTABLE_PATH` | No | Chrome or Chromium used to render the PDF. On Railway, Nixpacks installs `chromium` and the server finds it on `PATH`. |

`STRIPE_PUBLISHABLE_KEY` is not read by this server. Hosted Checkout only needs the URL returned by `/create-checkout-session`. The old `STRIPE_PRICE_ID` variable is unused.

When `FRONTEND_URL` is missing and `NODE_ENV` or `RAILWAY_ENVIRONMENT` is `production`, the process logs a fatal error and exits. In any other environment it logs a warning and still boots.

Browser CORS allows the origin of `FRONTEND_URL` and `https://www.manualos.com`.

## Stripe setup

Do this in the Stripe Dashboard (or with the CLI against your own account). This repository does not create prices or webhook endpoints.

1. Create a Product named **ManualOS Starter** with one one-time Price of **$39 USD**. Copy that price id into `STRIPE_PRICE_STARTER`.
2. Create a separate Product named **ManualOS Pro** with one recurring Price of **$79 USD** billed **monthly**. Copy that price id into `STRIPE_PRICE_PRO`. Separate products keep the Checkout line item names distinct.
3. Add a webhook endpoint:
   `https://manualforge-backend-production.up.railway.app/webhook`
   Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, and `radar.early_fraud_warning.created`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Create a restricted API key that can write Checkout Sessions, read and update PaymentIntents, read Subscriptions and Invoices, list Checkout Sessions, and write Billing Portal sessions. Store it as `STRIPE_SECRET_KEY` in Railway. A secret key works too. Use a different key for test and live mode.
5. Ryan must enable the [Customer Portal](https://dashboard.stripe.com/settings/billing/portal) in the Stripe Dashboard before `POST /billing-portal` will work. Allow customers to cancel at period end and to update their payment method. This service only creates a portal session. It does not turn those settings on.

Starter stays valid while the Checkout Session is `paid`. Stripe does not change that status when you later refund the charge, so a refunded Starter purchase can still generate until refunds are handled explicitly. Pro access follows the live subscription status. A cancellation takes effect on the next generate call once the status is no longer `active`, `trialing`, or `past_due` inside the 7-day grace window. `unpaid`, `canceled`, and `incomplete_expired` are blocked immediately.

## Email deliverability

manualos.com currently has no MX record. Mail addressed to `support@manualos.com` will not arrive, and mail sent from that address can fail authentication, until MX, SPF, DKIM, and DMARC are in place. Set those up before launch. Upload-link messages use that address as From.

Stripe Tax is left off. If you sell to US or EU customers, enable [Stripe Tax for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes.md) only after the account has an active registration. Turning on automatic tax without a registration collects no tax and returns no error.

## Model

The default model is Claude Haiku 5.5, id `claude-haiku-5-5` ([model page](https://platform.claude.com/docs/en/models/haiku-5-5/overview)). `claude-3-5-haiku-20241022` is retired. Haiku 5.5 requests use `output_config.effort: "low"` and `thinking: { "type": "disabled" }` so routine summaries stay cheap, and the server reads `text` content blocks rather than assuming the first block is text. The client is `@anthropic-ai/sdk` 1.3 with Node's native `fetch`. SDK 0.20 bundled `node-fetch` and closed gzip responses early. A failed chunk is retried, then replaced by a deterministic grouping of the parsed rungs. The job still fails, and a reserved credit is refunded, if those groups do not cover every rung. Override the id with `ANTHROPIC_MODEL` (for example `claude-sonnet-5-5` when you want a larger model).

## Local development

Requires Node.js 20 or newer (Stripe Node SDK 23).

```bash
npm install
npm test
npm start
```

`npm test` runs the API tests with a mocked Stripe client and a mocked model. It does not call Stripe or Anthropic.
