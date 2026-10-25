# ManualOS backend

Node/Express API for [ManualOS](https://manualos.com). It opens Stripe Checkout, checks that a checkout is still paid, and generates a PLC operator-manual PDF.

The website is a separate static site (`op3x/matrixmanual-frontend`). This service only serves the API. Production is `https://manualforge-backend-production.up.railway.app`.

## Pricing

- **Starter** is a $39 one-time payment. It includes `STARTER_CREDITS` manuals (default 3). `POST /jobs` reserves one credit when the job starts and refunds it if generation fails. `POST /generate-manual` still increments `manuals_used` only after a PDF is produced. Starter generates the operating and maintenance manual only.
- **Pro** is a $79 monthly subscription. Generation stays available while that subscription's status is `active` or `trialing`. Pro can also generate a preventive maintenance schedule, a shutdown procedure, a startup procedure, and up to five other equipment documents in the same run.
- **Integrator** is the $249 monthly plan added on the integrator branch. The same extra documents are allowed when the session plan is `integrator`. Extra documents in that run do not add another manual credit. White-label company name and logo apply to every document when the integrator branding modules are present.

## API

### `POST /create-checkout-session`

Request JSON: `{ "plan": "starter" }`, `{ "plan": "pro" }`, `{ "plan": "integrator", "interval": "month" }`, or `{ "plan": "integrator", "interval": "year" }`. `integrator_monthly` and `integrator_annual` are accepted as plan names. An extra manual is `{ "plan": "integrator_overage", "session_id": "cs_..." }` for an active Integrator checkout.

Response JSON: `{ "url": "<hosted Checkout URL>" }`.

Starter uses Checkout `mode: "payment"` and `STRIPE_PRICE_STARTER`. Pro uses `mode: "subscription"` and `STRIPE_PRICE_PRO` (a recurring monthly price). Integrator is $249 per month or $2,490 per year, with 25 manuals each month and a separate $9 Checkout for an extra manual. This service does not assign seats. Integrator uses Checkout `mode: "subscription"` and `MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY` or `MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL`. The extra manual uses `mode: "payment"` and `MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE` with quantity 1. Session metadata for the subscription is `{ plan: "integrator", interval }`. Redirects:

- success: `${FRONTEND_URL}/upload.html?session_id={CHECKOUT_SESSION_ID}`
- cancel: `${FRONTEND_URL}/#pricing`

The extra-manual success URL sends the browser back to the Integrator subscription session id, not the one-time payment session. Generation keeps using that subscription session.

Integrator checkout stays off until all three price variables are set. A missing `MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY`, `MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL`, or `MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE` makes `POST /create-checkout-session` with `{ "plan": "integrator" }` return **503**. The message is `Integrator monthly checkout is temporarily unavailable.`, `Integrator annual checkout is temporarily unavailable.`, `Integrator overage checkout is temporarily unavailable.`, or `Integrator checkout is temporarily unavailable.` The response does not include the variable name or its value. Starter and Pro do not read those variables. They still return **500** when their own price variables are missing.

Checkout requires a billing address on Starter, Pro, Integrator, and extra-manual sessions. The pay button shows: "Refundable until your first manual is delivered: within 30 days for Starter, or before the billing period ends for Pro and Integrator. Once a manual is delivered, that purchase is no longer refundable." A subscription adds "Cancel anytime." A one-time payment does not, because there is nothing to cancel. The PaymentIntent or Subscription description names the plan. Starter's description uses `STARTER_CREDITS` (default 3). `CHECKOUT_REQUIRE_TOS` stays unset, so no terms checkbox is sent. Set it to `1` only after a terms of service URL is saved in the Dashboard.

### `GET /verify-session?session_id=cs_...`

Response JSON: `{ "valid": boolean, "plan": "starter" | "pro" | "integrator" | null, "remaining": number | null }`. Integrator also includes `overage_remaining`.

Starter is valid when the Checkout Session `payment_status` is `paid`. `remaining` is `STARTER_CREDITS` minus `manuals_used`. Pro is valid when the session's subscription status is `active` or `trialing`, and `remaining` is `null` (unlimited). A paid Starter session with zero manuals left is still `valid: true` with `remaining: 0`; generation then returns 402.

Integrator is valid for the same subscription statuses. `remaining` is how many of the 25 included manuals are left in the current month. `overage_remaining` counts paid extra manuals that have not been used. Included manuals reset when the month changes and do not roll over. Paid extra manuals stay until they are used or the subscription is no longer active. A month is the Stripe billing period for the monthly price. The yearly price is paid once a year and still allows 25 manuals each month, anchored to the subscription period start, because there is no monthly invoice inside that year. The next request in a new month opens that month's 25. The paid invoice grants the first month and each renewal.

### `POST /jobs`

Preferred upload. Multipart fields `file` and/or `files` (up to 25), plus `session_id` (form field or `X-Session-Id`). Optional fields: `brand`, `manufacturer_name`, `manufacturer_address`, `product_name`, `model`, `doc_number`, `revision`, `language`.

`202` JSON:

```json
{ "id": "job_…", "status": "queued", "progress": { "stage": "queued", "percent": 0, "message": "…" }, "error": null, "warnings": [], "coverage": null, "createdAt": "…", "expiresAt": "…" }
```

Poll `GET /jobs/:id` until `status` is `succeeded` or `failed`. `GET /jobs/:id/pdf` returns `application/pdf` when the job succeeded, `409` when it is not ready, and `404` when the id is unknown or older than 24 hours. Stages are `queued`, `parsing`, `analyzing`, `assembling`, `rendering`, `done`, and `failed`.

Accepted content, detected from the bytes rather than the extension: Rockwell L5X and L5K, Rockwell ACD (converted to L5X with the vendored Apache-2.0 `acd-tools` package; a routine the converter cannot read is named in the manual), Siemens SIMATIC ML block XML (LAD, FBD, SCL, GRAPH, and statement list), Siemens SCL/ST and DATA_BLOCK source, Siemens STL/AWL (S7-300/400 and S7-200), PLCopen XML, TwinCAT TcPOU, CSV and XLSX tag lists, STEP, IGES, ASCII or binary DXF, and ASCII or binary STL (size and approximate shape only). A Zip may contain those files. `.zap` / `.ap` / `.s7p`, `.dwg`, and SolidWorks `.sldprt` / `.sldasm` / `.slddrw` are rejected with the export to use instead (SCL or SIMATIC ML XML, DXF, or STEP). Unknown or mismatched content returns **415**. A file that parses but contains no equipment data returns **422**. Neither spends a credit. Executable uploads are rejected. Zip entries are checked for path traversal, nesting, file count, and uncompressed size.

ACD conversion needs `python3` on PATH. Nixpacks installs it next to Node. The Python packages are vendored under `third_party/python` so the image does not download them at runtime. See `THIRD_PARTY_NOTICES.md`.

One failed model chunk does not fail the job. The manual is still built from the parsed project, and coverage must account for every rung or statement.

### `POST /generate-manual`

Kept for the current site. Same body as before (`file`, or JSON `plcContent`, plus `session_id`). Success is `application/pdf` with `Deprecation: true` and `Link: </jobs>; rel="successor-version"`. The Starter counter increments only after the PDF is sent. A missing model key returns **503** and does not spend a credit.

### `POST /webhook`

Raw JSON body. The route verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`, applies Integrator credit changes, and logs the event. Requests with a bad or missing signature get `400`. A handler failure returns `500` so Stripe retries it.

- `invoice.paid` grants 25 included manuals when the subscription is Integrator and is not canceled, unpaid, incomplete_expired, or paused. The same billing window does not reset usage again. Extra-manual credits are left as they are.
- `checkout.session.completed` and `checkout.session.async_payment_succeeded` do that grant when `payment_status` is `paid` and the session plan is `integrator`. When the plan is `integrator_overage`, they add one extra manual, once per Checkout Session id.
- `customer.subscription.deleted`, and `customer.subscription.updated` with status `canceled`, `unpaid`, or `incomplete_expired`, mark the subscription cancelled and set included credits to 0. `cancel_at_period_end` does not remove credits while the status stays `active` or `trialing`.
- Starter and Pro events are logged as before and do not change Integrator credits.

Each generate call re-reads the Checkout Session, PaymentIntent, and Subscription, so access stays correct even if a webhook is delayed. The endpoint is still required: subscription renewals, cancellations, and delayed payment methods are asynchronous, and the signature is what shows the call came from Stripe.

Included credits and extra-manual counts live on the Stripe Subscription metadata, the same way Starter counts live on the PaymentIntent. The credit lock is in this process. Run a single replica. Two replicas can reserve the same manual or grant the same extra manual twice. `POST /jobs` and `POST /generate-manual` reserve one Integrator credit before generation and refund it if generation fails. When no included manuals and no extra manuals remain, generation returns **402** and does not create a charge:

```json
{
  "error": "Integrator credits are used up. Purchase an extra manual for $9 to continue.",
  "overage": { "plan": "integrator_overage", "amount_cents": 900, "currency": "usd" }
}
```

The customer then calls `POST /create-checkout-session` with `integrator_overage`. Nothing is billed until that Checkout is paid.

### `GET /integrator/branding` and `POST /integrator/branding`

Requires an active Integrator `session_id` (query string, form field, or `X-Session-Id`). The POST body is JSON `{ "company_name": "..." }` or multipart with `company_name` and `logo`. The logo must be a PNG or SVG file of at most 256 KiB. SVG files that contain scripts, external links, or embedded documents are rejected. The response is `{ "company_name", "has_logo", "logo_type" }` and does not return the file bytes.

The company name and logo are stored for that Stripe Customer. Integrator manuals and extra documents use them on the cover, in the running header, and in the running footer, and the revision approval line no longer says the product name. Starter and Pro manuals are unchanged. Program uploads stay in memory and are not written to the branding directory.

`POST /jobs` and `POST /generate-manual` load that branding after the upload is parsed and pass it into the manual renderer. Logos are embedded as `data:` image URLs. The PDF renderer drops every other network request. `lib/accounts/store.js` exports `readBranding(customerId, { dir })`. With no directory, the helper uses `MANUALOS_ACCOUNT_DIR` or, outside production, the system temp directory. An empty record returns no white-label object. A missing directory returns no logo and does not throw.

Paid extra-manual Checkout session ids are stored in that customer's `overage-grants.json` with no cap. The subscription records the source PaymentIntent on `overage_last_pi` and a short `overage_pi` list when the extra manual is added. The PaymentIntent is stamped `overage_credit_granted=1` after that credit is stored. A replay adds nothing when the stamp, the ledger, or those subscription ids already record the payment. Before a newer payment replaces `overage_last_pi` or `overage_grant`, the previous grant is settled. If stamping that previous PaymentIntent keeps failing, a newer extra-manual grant for the same customer stays uncommitted and the webhook returns **500** until the earlier stamp succeeds. The new payment is not credited twice. Stripe retries. Checkout for an extra manual sets `kind: overage` on the session and the PaymentIntent, along with `plan: integrator_overage`.

If `overage-grants.json` cannot be parsed, reading it throws **503** `Extra manual records are temporarily unavailable.` The `/webhook` response is still **500** `Webhook handler failed` (Stripe retries either status). The handler does not treat the file as empty. The log says `overage-grants.json` and redacts the customer id. To recover, restore a JSON object that maps each granted Checkout session id to `"done"`. Delete the file only when `overage_pi` on the subscription, or `overage_credit_granted` on the PaymentIntent, already records those payments. An empty ledger lets a replay grant the manual again. The file lives on the same volume as the logo, so the single replica above is also what keeps the ledger and the in-memory credit lock together.

### Branding storage

There is no account database. `createAccountStore` in `lib/accounts/store.js` writes `branding.json` plus `logo.png` or `logo.svg`. Stripe metadata cannot hold a logo (values are limited to 500 characters), and the job store only keeps generated PDFs until they expire.

On Railway the container disk is ephemeral. Run one replica: the credit lock is per process, and a second replica can spend or grant the same manual twice. Mount a volume at `/data/manualos-accounts` and set `MANUALOS_ACCOUNT_DIR` to that path. If the variable is unset outside production, local runs use the system temp directory. If the directory is missing, or the variable is unset in production, manuals and extra documents are generated with no logo. Saving a logo then returns **503** with `Company logo storage is temporarily unavailable.` and does not create the directory.

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
| `MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY` | For Integrator monthly Checkout | Price id for the $249/month price |
| `MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL` | For Integrator yearly Checkout | Price id for the $2,490/year price |
| `MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE` | For extra manuals | Price id for the $9 one-time price |
| `MANUALOS_ACCOUNT_DIR` | For a durable logo | Directory for the Integrator company name and logo. On Railway, mount a volume at `/data/manualos-accounts` and set this to that path. |
| `STARTER_CREDITS` | No | Manuals included with Starter. Default `3` |
| `CHECKOUT_REQUIRE_TOS` | No | Set to `1` to send `consent_collection.terms_of_service: required`. Leave unset. Stripe rejects that field unless a terms of service URL is saved in the Dashboard. |
| `FRONTEND_URL` | Yes in production | Site origin, for example `https://manualos.com` |
| `PORT` | No | Railway sets this. Local default `3001` |
| `PUPPETEER_EXECUTABLE_PATH` | No | Chrome or Chromium used to render the PDF. On Railway, Nixpacks installs `chromium` and the server finds it on `PATH`. |
| `TWILIO_ACCOUNT_SID` | To send escalation SMS | Account SID. Never logged. |
| `TWILIO_AUTH_TOKEN` | To accept Twilio webhooks | Validates `X-Twilio-Signature`. Voice, SMS, and relay stay **503** until this is set. |
| `TWILIO_FROM_NUMBER` | To send SMS | E.164 sender for escalation texts. |
| `SUPPORT_PHONE` | No | E.164 number customers call. Mentioned in HELP and the model prompt. |
| `ESCALATION_PHONE` | To reach a person | Owner cell, E.164. Dial target, escalation SMS recipient, and fallback call recipient. |
| `ESCALATION_EMAIL` | For escalation email | Inbox used when an escalation text to `ESCALATION_PHONE` fails. |
| `SMTP_HOST` | For escalation email | SMTP server. Unset skips the email and logs a warning. |
| `SMTP_PORT` | No | Default `587`. Port `465` uses implicit TLS. |
| `SMTP_USER` | No | SMTP username. Leave unset for a relay that does not authenticate. |
| `SMTP_PASS` | No | SMTP password. Never logged. |
| `SMTP_FROM` | For escalation email | From address. Required together with `SMTP_HOST`. |
| `LLM_PROVIDER` | No | `openai`. Any other value keeps the keypad / canned-text fallback. |
| `LLM_API_KEY` | For live AI answers | OpenAI API key. Missing → `<Gather>` on calls and a canned SMS. |
| `LLM_MODEL` | No | Default `gpt-4o-mini`. |
| `LLM_MONTHLY_BUDGET_USD` | No | ManualOS share of the shared OpenAI budget. Default `10` (the pool is $20 across two businesses). |
| `LLM_USD_PER_1M_INPUT` | No | Default `0.15`, the gpt-4o-mini input rate. Change this if `LLM_MODEL` changes. |
| `LLM_USD_PER_1M_OUTPUT` | No | Default `0.60`, the gpt-4o-mini output rate. |
| `PUBLIC_BASE_URL` | Recommended on Railway | Public origin only, for example `https://manualforge-backend-production.up.railway.app`. Signature checks and the `wss://` relay URL use it. |
| `SUPPORT_DATA_DIR` | Recommended | Directory for opt-outs, consent, and the budget counter. Railway's disk is ephemeral; mount a volume. |
| `SUPPORT_INTEGRATOR_ENABLED` | No | `true` mentions Integrator pricing. Default off, because that plan is not launched. |

`STRIPE_PUBLISHABLE_KEY` is not read by this server. Hosted Checkout only needs the URL returned by `/create-checkout-session`. The old `STRIPE_PRICE_ID` variable is unused. The restricted key needs Checkout Sessions write, PaymentIntents read and write, and Subscriptions read and write. Integrator credit counters are subscription metadata. Customers read is needed when an extra-manual Checkout is attached to the existing customer. Reading Subscriptions is not enough for the credit update.

When `FRONTEND_URL` is missing and `NODE_ENV` or `RAILWAY_ENVIRONMENT` is `production`, the process logs a fatal error and exits. In any other environment it logs a warning and still boots.

Browser CORS allows the origin of `FRONTEND_URL`, `https://manualos.com`, and `https://www.manualos.com`.

## Phone and SMS support

The support line is off until `TWILIO_AUTH_TOKEN` is set. With the token set and no `LLM_API_KEY`, or once `LLM_MONTHLY_BUDGET_USD` is spent, calls get a keypad (`1` order or manual status, `2` billing, `0` a person). Texts get a short reply that offers a callback, and Ryan gets one deduped escalation text per thread. Nothing here calls Twilio or OpenAI during manual generation.

Configure the Twilio number (HTTP POST):

- Voice, a call comes in: `https://manualforge-backend-production.up.railway.app/api/twilio/voice`
- Voice status, call status changes: `https://manualforge-backend-production.up.railway.app/api/twilio/voice/status`
- Messaging, a message comes in: `https://manualforge-backend-production.up.railway.app/api/twilio/sms`

`PUBLIC_BASE_URL` must be that same origin. The relay URL in the call TwiML is `wss://<that host>/api/twilio/relay`. Handoff, dial result, keypad, voicemail, and recording URLs are returned inside TwiML (`/api/twilio/voice/handoff`, `/api/twilio/voice/dial-status`, `/api/twilio/voice/menu`, `/api/twilio/voice/transcription`, `/api/twilio/voice/recording-done`, `/api/twilio/voice/recording`). Outbound escalation texts set their own status callback to `/api/twilio/sms/status` on that origin. There is no number-level status webhook to configure.

In the Twilio console, accept the ConversationRelay predictive/generative AI addendum before the live voice path will connect. Leave Messaging Service Advanced Opt-Out off, or STOP may never reach this app. On a toll-free number the carrier handles STOP. If this app's confirmation reply fails, the opt-out is already stored, the failure is logged, and nobody is called or emailed. The webhook treats STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT, OPT-OUT, and OPT OUT as opt-outs, plus a message that starts with STOP. A longer opt-out such as "please unsubscribe me", "opt me out", "stop texting me", or "remove me" also opts out, unless it mentions a plan, subscription, billing, Pro, Starter, Integrator, a charge, a payment, a refund, cancel, or an account. Those are billing questions and are escalated. HELP and INFO are help. START, UNSTOP, and YES opt back in. START and YES confirm with `Msg frequency varies.` Customer texts are prefixed `ManualOS Support:` and include `Reply STOP to opt out, HELP for help. Msg&data rates may apply.` Inbound texts are stored as opt-in. The website checkbox posts `{ "phone", "consentTextVersion", "source" }` to `POST /api/support/sms-consent` (10 requests per IP per hour). The app sets `trust proxy` to 1, one hop for Railway, so the client address is `req.ip` (the address that hop added). A client-supplied `X-Real-IP` or a forged left-most `X-Forwarded-For` value does not change the limit. Confirm that with one staging request before relying on it.

Live answers use OpenAI with a 12-turn cap per call, an 8-turn cap per SMS thread, `max_tokens` 200, and a short history. An SMS thread resets after 24 hours idle, and each escalation reason is texted to Ryan once per thread. The monthly counter is priced as gpt-4o-mini ($0.15 / 1M input, $0.60 / 1M output) unless the rate variables are set. The assistant does not promise refunds, does not give binding legal or safety advice, refuses card numbers (including spaced, punctuated, and spoken digits) before they are stored or sent to OpenAI, and does not name third-party product lines. Asking for a person, an urgent or safety issue, a legal issue, a complaint, or any billing issue (a charge, refund, invoice, payment, subscription, or cancellation) ends the relay and dials `ESCALATION_PHONE` for 25 seconds. Billing and complaints escalate at any hour, including after hours in America/Chicago, and are not held for morning. The same texts are deduped once per thread and reason. The model is only the backup when the deterministic check does not match. A card number plus a request for a person is refused and handed off. No answer, busy, or failed dials a 120-second transcribed voicemail. The recording's `action` plays goodbye and hangs up, and `recordingStatusCallback` texts Ryan when the file is ready even if transcription fails. Integrator pricing ($249/month, $2,490/year, 25 manuals, white-label, $9 extra) is included only when `SUPPORT_INTEGRATOR_ENABLED` is true.

Turn on **Enforce HTTP Auth** for media in the Twilio console so a recording URL is not public. Opening that URL takes the Account SID as the username and the Auth Token as the password (or a logged-in console session). The token is never put in the SMS.

Escalation texts are sent from `TWILIO_FROM_NUMBER` to `ESCALATION_PHONE`. Toll-free verification can take about two weeks. Until Twilio approves it, those texts fail. A failure is a Twilio API error, or a status callback of `failed` or `undelivered` (for example error 30032 or 30034). The app then does both of these, once each:

- It places a short voice call from `TWILIO_FROM_NUMBER` to `ESCALATION_PHONE`. The call speaks the category, the caller's number, and a one-line reason.
- It emails `ESCALATION_EMAIL` through SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`). The message has the same three fields. A voicemail notice also includes the recording link.

The spoken script, the email, and the saved status record never include a customer card number. If `ESCALATION_EMAIL` or `SMTP_HOST` / `SMTP_FROM` is unset, the email is skipped and a warning is logged. One customer call, or one SMS thread, produces at most one fallback call and one fallback email no matter how many alerts that interaction creates. While a live transfer to `ESCALATION_PHONE` is in progress, the fallback is email only so that phone is not rung twice. Until toll-free verification passes, every escalation text fails and uses this call-plus-email fallback. `PUBLIC_BASE_URL` has to be set or the status callback is omitted and only the API error can fall back. A local number avoids the toll-free messaging block. A text Twilio accepts without a message id is treated as unconfirmed and uses the same fallback.

`SUPPORT_DATA_DIR` holds separate files: `opt-outs.json`, append-only `consents.jsonl` (never trimmed), `budget.json`, `threads.json`, `once.json`, and `sms-notices.json` (the status-callback payload, with card numbers redacted). A legacy `state.json` is split once and renamed `state.json.migrated`. Without a Railway volume those files disappear on redeploy, and the counter is only safe on one replica.

## Stripe setup

Do this in the Stripe Dashboard (or with the CLI against your own account). This repository does not create prices or webhook endpoints.

1. Create a Product named **ManualOS Starter** with one one-time Price of **$39 USD**. Copy that price id into `STRIPE_PRICE_STARTER`.
2. Create a separate Product named **ManualOS Pro** with one recurring Price of **$79 USD** billed **monthly**. Copy that price id into `STRIPE_PRICE_PRO`. Separate products keep the Checkout line item names distinct.
3. Create a separate Product named **ManualOS Integrator** with two recurring Prices:
   - **$249.00 USD** billed **monthly**. Copy that price id into `MANUALOS_STRIPE_PRICE_INTEGRATOR_MONTHLY`.
   - **$2,490.00 USD** billed **yearly**. Copy that price id into `MANUALOS_STRIPE_PRICE_INTEGRATOR_ANNUAL`.
   Monthly and yearly are billing variants of the same plan, so they share this product. Either price includes 25 manuals per month. Unused manuals expire at the month boundary. The yearly price is that same monthly allowance, paid once a year.
4. Create a separate Product named **ManualOS Integrator extra manual** with one one-time Price of **$9.00 USD**. Copy that price id into `MANUALOS_STRIPE_PRICE_INTEGRATOR_OVERAGE`. This is its own product so the Checkout line item is not labeled with the subscription name. The server does not add this price to an invoice by itself. The customer starts Checkout after the included manuals are used.
5. Add a webhook endpoint:
   `https://manualforge-backend-production.up.railway.app/webhook`
   Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, and `radar.early_fraud_warning.created`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
6. Create a restricted API key that can write Checkout Sessions, read and update PaymentIntents, read and update Subscriptions, and Customers read. Store it as `STRIPE_SECRET_KEY` in Railway. A secret key works too. Use a different key for test and live mode. This repository does not create the products, prices, webhook endpoint, or API key.

Starter stays valid while the Checkout Session is `paid`. Stripe does not change that status when you later refund the charge, so a refunded Starter purchase can still generate until refunds are handled explicitly. Pro access follows the live subscription status, so a cancellation takes effect on the next generate call once the status is no longer `active` or `trialing`.

Stripe Tax is left off. If you sell to US or EU customers, enable [Stripe Tax for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes.md) only after the account has an active registration. Turning on automatic tax without a registration collects no tax and returns no error.

`CHECKOUT_REQUIRE_TOS` stays unset. Stripe rejects Checkout when `consent_collection.terms_of_service` is `required` and the Dashboard has no terms of service URL. Set the variable to `1` only after that URL is saved. Any other value, including omitting it, leaves the checkbox off.

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
