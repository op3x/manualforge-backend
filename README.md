# ManualOS backend

Node/Express API for [ManualOS](https://manualos.com). It opens Stripe Checkout, checks that a checkout is still paid, and generates a PLC operator-manual PDF.

The website is a separate static site (`op3x/matrixmanual-frontend`). This service only serves the API. Production is `https://manualforge-backend-production.up.railway.app`.

## Pricing

- **Starter** is a $39 one-time payment. It includes `STARTER_CREDITS` manuals (default 3). `POST /jobs` reserves one credit when the job starts and refunds it if generation fails. `POST /generate-manual` still increments `manuals_used` only after a PDF is produced.
- **Pro** is a $79 monthly subscription. Generation stays available while that subscription's status is `active` or `trialing`.

## API

### `POST /create-checkout-session`

Request JSON: `{ "plan": "starter" }` or `{ "plan": "pro" }`.

Response JSON: `{ "url": "<hosted Checkout URL>" }`.

Starter uses Checkout `mode: "payment"` and `STRIPE_PRICE_STARTER`. Pro uses `mode: "subscription"` and `STRIPE_PRICE_PRO` (a recurring monthly price). Session metadata is `{ plan }`. Redirects:

- success: `${FRONTEND_URL}/upload.html?session_id={CHECKOUT_SESSION_ID}`
- cancel: `${FRONTEND_URL}/#pricing`

Checkout requires a billing address. The pay button shows: "Refundable until your first manual is delivered: within 30 days for Starter, or before the billing period ends for Pro and Integrator. Once a manual is delivered, that purchase is no longer refundable." A subscription adds "Cancel anytime." A one-time payment does not, because there is nothing to cancel. The PaymentIntent or Subscription description names the plan. Starter's description uses `STARTER_CREDITS` (default 3). `CHECKOUT_REQUIRE_TOS` stays unset, so no terms checkbox is sent. Set it to `1` only after a terms of service URL is saved in the Dashboard.

### `GET /verify-session?session_id=cs_...`

Response JSON: `{ "valid": boolean, "plan": "starter" | "pro" | null, "remaining": number | null }`.

Starter is valid when the Checkout Session `payment_status` is `paid`. `remaining` is `STARTER_CREDITS` minus `manuals_used`. Pro is valid when the session's subscription status is `active` or `trialing`, and `remaining` is `null` (unlimited). A paid Starter session with zero manuals left is still `valid: true` with `remaining: 0`; generation then returns 402.

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

Raw JSON body. The route verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET` and logs the event. Requests with a bad or missing signature get `400`.

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
| `CHECKOUT_REQUIRE_TOS` | No | Set to `1` to send `consent_collection.terms_of_service: required`. Leave unset. Stripe rejects that field unless a terms of service URL is saved in the Dashboard. |
| `FRONTEND_URL` | Yes in production | Site origin, for example `https://manualos.com` |
| `PORT` | No | Railway sets this. Local default `3001` |
| `PUPPETEER_EXECUTABLE_PATH` | No | Chrome or Chromium used to render the PDF. On Railway, Nixpacks installs `chromium` and the server finds it on `PATH`. |
| `TWILIO_ACCOUNT_SID` | To send escalation SMS | Account SID. Never logged. |
| `TWILIO_AUTH_TOKEN` | To accept Twilio webhooks | Validates `X-Twilio-Signature`. Voice, SMS, and relay stay **503** until this is set. |
| `TWILIO_FROM_NUMBER` | To send SMS | E.164 sender for escalation texts. |
| `TWILIO_SUPPORT_NUMBER` | For retention | E.164 support number. Twilio deletion is limited to calls and messages for this number. Unset skips Twilio deletion. |
| `SUPPORT_PHONE` | No | E.164 number customers call. HELP shows it formatted for display. The model prompt can mention it. |
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
| `SUPPORT_DATA_DIR` | Recommended | Directory for opt-outs, consent, threads, and the budget counter. Use a subfolder such as `/data/support`, not the volume root. Railway's disk is ephemeral; mount a volume. |
| `SUPPORT_RETENTION_DAYS` | No | Days to keep support data on disk. Default `63`, minimum `1`. A non-numeric value keeps the default. The privacy promise stays 90 days: 63 on disk plus Railway's 27-day weekly backups. |
| `SUPPORT_INTEGRATOR_ENABLED` | No | `true` mentions Integrator pricing. Default off, because that plan is not launched. |

`STRIPE_PUBLISHABLE_KEY` is not read by this server. Hosted Checkout only needs the URL returned by `/create-checkout-session`. The old `STRIPE_PRICE_ID` variable is unused.

When `FRONTEND_URL` is missing and `NODE_ENV` or `RAILWAY_ENVIRONMENT` is `production`, the process logs a fatal error and exits. In any other environment it logs a warning and still boots.

Browser CORS allows the origin of `FRONTEND_URL`, `https://manualos.com`, and `https://www.manualos.com`.

## Phone and SMS support

The support line is off until `TWILIO_AUTH_TOKEN` is set. With the token set and no `LLM_API_KEY`, or once `LLM_MONTHLY_BUDGET_USD` is spent, calls get a keypad (`1` order or manual status, `2` billing, `0` a person). Texts get a short reply that offers a callback, and Ryan gets one deduped escalation text per thread. Nothing here calls Twilio or OpenAI during manual generation.

Configure the Twilio number (HTTP POST):

- Voice, a call comes in: `https://manualforge-backend-production.up.railway.app/api/twilio/voice`
- Voice status, call status changes: `https://manualforge-backend-production.up.railway.app/api/twilio/voice/status`
- Messaging, a message comes in: `https://manualforge-backend-production.up.railway.app/api/twilio/sms`

`PUBLIC_BASE_URL` must be that same origin. The relay URL in the call TwiML is `wss://<that host>/api/twilio/relay`. Handoff, dial result, keypad, voicemail, and recording URLs are returned inside TwiML (`/api/twilio/voice/handoff`, `/api/twilio/voice/dial-status`, `/api/twilio/voice/menu`, `/api/twilio/voice/transcription`, `/api/twilio/voice/recording-done`, `/api/twilio/voice/recording`). Outbound escalation texts set their own status callback to `/api/twilio/sms/status` on that origin. There is no number-level status webhook to configure.

In the Twilio console, accept the ConversationRelay predictive/generative AI addendum before the live voice path will connect. Leave Messaging Service Advanced Opt-Out off, or STOP may never reach this app. On a toll-free number the carrier handles STOP. If this app's confirmation reply fails, the opt-out is already stored, the failure is logged, and nobody is called or emailed. The webhook treats STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT, OPT-OUT, and OPT OUT as opt-outs, plus a message that starts with STOP. A longer opt-out such as "please unsubscribe me", "opt me out", "don't text me", "stop texting me", "no more texts", "take me off this list", or "remove me" also opts out. A plan question such as "How do I unsubscribe from Pro?" or "remove me from the Pro subscription" is not an opt-out; it is escalated as billing. A message that opts out and also mentions a charge, bill, billed amount, refund, money back, cancellation, or dispute opts the sender out and still alerts Ryan once. HELP and INFO are help. HELP and INFO reply with the legally approved text: `ManualOS (Op3x LLC) support: email support@manualos.com or call {number}. Msg&data rates may apply. Reply STOP to cancel.` `{number}` is `SUPPORT_PHONE` formatted for display (`+1 XXX-XXX-XXXX` for a US number). If `SUPPORT_PHONE` is not set, the reply omits ` or call {number}`. START, UNSTOP, and YES opt back in and reply with the v3 confirmation: `ManualOS (Op3x LLC): You're opted in to support & order-status texts. Msg frequency varies. Msg&data rates may apply. Reply HELP for help, STOP to cancel.` Other customer texts are prefixed `ManualOS Support:` and include `Reply STOP to opt out, HELP for help. Msg&data rates may apply.` An inbound text is stored as conversation-only consent to reply in that thread for 72 hours. It is not standing consent for marketing or order-status alerts, and it does not write an opt-in. There is no account-alerts scope. A website opt-in for a number with no STOP, or a START, UNSTOP, or YES from that number, stored as `support-sms-v3`, allows support replies and order/manual-status texts. A website opt-in does not clear an earlier STOP. The form stores a pending request and sends nothing until that number texts START, UNSTOP, or YES. Web opt-ins are limited to 3 per number per 24 hours, and the confirmation text is sent at most once per number per 24 hours. The website checkbox posts `{ "phone", "consentText", "consentTextVersion": "support-sms-v3", "source" }` to `POST /api/support/sms-consent` (10 requests per IP per hour). `consentText` is required and must be the exact `support-sms-v3` label: `Yes, text me at this number. I agree to receive support replies and order/manual-status texts from ManualOS (Op3x LLC). Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel. Consent is not a condition of purchase. See Terms (/terms.html#sms) and Privacy (/privacy.html#sms).` A mismatch returns 400. The app sets `trust proxy` to 1, one hop for Railway, so the client address is `req.ip` (the address that hop added). A client-supplied `X-Real-IP` or a forged left-most `X-Forwarded-For` value does not change the limit. Confirm that with one staging request before relying on it.

<!-- Merge note: keep PR #12's opt-out sentences plus this PR's legally approved HELP reply and its START, inbound-text, and v3 sentences. -->

The live greeting says the caller is speaking with an AI assistant and that the call is transcribed and may be recorded. Every voicemail prompt starts with `This message will be recorded and transcribed.` Transcription is not used to identify a speaker or make a voiceprint. Live answers use OpenAI with a 12-turn cap per call, an 8-turn cap per SMS thread, `max_tokens` 200, and a short history. An SMS thread resets after 24 hours idle, and each escalation reason is texted to Ryan once per thread. The monthly counter is priced as gpt-4o-mini ($0.15 / 1M input, $0.60 / 1M output) unless the rate variables are set. The assistant does not promise refunds, does not give binding legal or safety advice, refuses card numbers (including spaced, punctuated, and spoken digits) before they are stored or sent to OpenAI, and does not name third-party product lines. Asking for a person, an urgent or safety issue, a legal issue, a complaint, or any billing issue (a charge, refund, invoice, payment, subscription, or cancellation) ends the relay and dials `ESCALATION_PHONE` for 25 seconds. Billing and complaints escalate at any hour, including after hours in America/Chicago, and are not held for morning. The same texts are deduped once per thread and reason. The model is only the backup when the deterministic check does not match. A card number plus a request for a person is refused and handed off. No answer, busy, or failed dials a 120-second transcribed voicemail. The recording's `action` plays goodbye and hangs up, and `recordingStatusCallback` texts Ryan when the file is ready even if transcription fails. Integrator pricing ($249/month, $2,490/year, 25 manuals, white-label, $9 extra) is included only when `SUPPORT_INTEGRATOR_ENABLED` is true.

Turn on **Enforce HTTP Auth** for media in the Twilio console so a recording URL is not public. Opening that URL takes the Account SID as the username and the Auth Token as the password (or a logged-in console session). The token is never put in the SMS.

Escalation texts are sent from `TWILIO_FROM_NUMBER` to `ESCALATION_PHONE`. Toll-free verification can take about two weeks. Until Twilio approves it, those texts fail. A failure is a Twilio API error, or a status callback of `failed` or `undelivered` (for example error 30032 or 30034). The app then does both of these, once each:

- It places a short voice call from `TWILIO_FROM_NUMBER` to `ESCALATION_PHONE`. The call speaks the category, the caller's number, and a one-line reason.
- It emails `ESCALATION_EMAIL` through SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`). The message has the same three fields. A voicemail notice also includes the recording link.

The spoken script, the email, and the saved status record never include a customer card number. If `ESCALATION_EMAIL` or `SMTP_HOST` / `SMTP_FROM` is unset, the email is skipped and a warning is logged. One customer call, or one SMS thread, produces at most one fallback call and one fallback email no matter how many alerts that interaction creates. While a live transfer to `ESCALATION_PHONE` is in progress, the fallback is email only so that phone is not rung twice. Until toll-free verification passes, every escalation text fails and uses this call-plus-email fallback. `PUBLIC_BASE_URL` has to be set or the status callback is omitted and only the API error can fall back. A local number avoids the toll-free messaging block. A text Twilio accepts without a message id is treated as unconfirmed and uses the same fallback.

`SUPPORT_DATA_DIR` holds separate files: `opt-outs.json`, append-only `consents.jsonl` (never trimmed), `budget.json`, `threads.json`, `once.json`, and `sms-notices.json` (the status-callback payload, with card numbers redacted). Point it at a subfolder such as `/data/support`, not the volume root. A legacy `state.json` is split once and renamed `state.json.migrated`. Without a Railway volume those files disappear on redeploy, and the counter is only safe on one replica.

## Retention

Support threads, the messages stored on them, call recordings, and transcripts are deleted after 90 days. That is the promise on the privacy policy. On disk the window is 63 days (`SUPPORT_RETENTION_DAYS`, default `63`, minimum `1`) so Railway's 27-day weekly backups do not stretch a deleted thread past 90 days. A non-numeric value keeps the default. The sweep runs when the server starts and every 6 hours after that. `npm run support:retention` runs the same sweep once and exits. The server and that script share a lock file in the data directory. The script exits if the lock is already held, so it cannot overwrite a live write, and two sweeps cannot run at once. A lock left behind for more than an hour is taken over.

Point `SUPPORT_DATA_DIR` at a subfolder such as `/data/support`, not the volume root. The sweep resolves that path with `realpath` so the lock and the files land on the same directory. Files and directories named `lost+found` are left alone.

On disk, the sweep deletes `threads.json` entries older than the window and the message history on those entries. Age is the first of `updatedAt`, `startedAt`, `createdAt`, `timestamp`, `at`, `dateCreated`, or `date`. A record with no timestamp uses the file's modification time, and a missing timestamp is not itself a reason to delete it. If that time is missing too, the record stays. A timestamp in the future is rewritten to the current time and kept. The sweep also deletes message files, transcript files, `sms-notices.json` rows (those rows store the voicemail transcript and the escalation text), and any other support artifact under `SUPPORT_DATA_DIR` older than the window. Any file whose name starts with `opt-outs` or `consents`, at any depth, is left alone, including a backup such as `opt-outs.json.bak`. JSON is replaced by writing a temporary file in the same directory and renaming it into place. Temporary files older than an hour are removed at the start of each sweep. `budget.json` and `once.json` have no message content and are left in place. The log line is counts only: days, threads, messages, transcripts, files, recordings, transcriptions, sms, and errors. Bodies, phone numbers, recording URLs, and transcript text are not logged.

Twilio recordings and transcriptions older than the same window are deleted through the REST API (`client.recordings` and `client.transcriptions`). Those list APIs have no To/From filter, so recording and transcription deletion is account-wide. Message logs are deleted only when `TWILIO_SUPPORT_NUMBER` is set, and only for messages to or from that number. The client retries rate limits (`autoRetry`). If Twilio still returns 429, the rest of that pass stops. A 404 counts as already deleted. A 5xx is counted and the pass continues with the next resource. A recording is deleted only when its `dateCreated` instant is past the window. A message uses `dateSent`. The list filter is calendar-day granularity, so the sweep checks the timestamp before it deletes anything. A resource with no timestamp is left in place. The Twilio step does nothing unless both `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set. With the support line off, the sweep never calls Twilio. This repository does not set those variables and does not turn the line on.

Belt and braces in the Twilio console, an ops step for Ryan: ordinary Programmable Voice recordings stay in the account until something deletes them. Twilio does not offer a 90-day auto-delete switch for non-PCI recordings. In the console, open **Monitor → Logs → Voice → Call recordings** (legacy Console: Programmable Voice → Recording logs), filter a range shorter than 90 days, and choose **Actions → Delete recordings**. A range of 90 days or longer fails in the console. Leave **PCI Mode** off. Its automatic deletion runs at one year, which is longer than this policy. If Voice settings later shows an automatic recording-retention control, set it to 90 days or fewer. That control does not replace this sweep.

Escalation email is a second ops step for Ryan. Mail goes to `ESCALATION_EMAIL`, the Microsoft 365 mailbox, and those messages include the transcript and the recording link. This app cannot delete mail. The mailbox needs an M365 retention policy (on the mailbox, or on the folder those messages land in) that deletes them after 90 days. Until that policy is on, the mailbox copy outlives the promise.

Backups are a third ops step for Ryan, once the support volume is attached. Use Railway **Daily** backups kept **6 days**, and **Weekly** backups kept **27 days**. The sweep keeps support data for 63 days, and a weekly backup can hold that snapshot for another 27 days, which is the 90-day promise. Do not lock backups: a backup lock would outlive that rotation. Delete manual backups within 27 days so a one-off snapshot does not keep a thread past 90 days.

## Stripe setup

Do this in the Stripe Dashboard (or with the CLI against your own account). This repository does not create prices or webhook endpoints.

1. Create a Product named **ManualOS Starter** with one one-time Price of **$39 USD**. Copy that price id into `STRIPE_PRICE_STARTER`.
2. Create a separate Product named **ManualOS Pro** with one recurring Price of **$79 USD** billed **monthly**. Copy that price id into `STRIPE_PRICE_PRO`. Separate products keep the Checkout line item names distinct.
3. Add a webhook endpoint:
   `https://manualforge-backend-production.up.railway.app/webhook`
   Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, and `radar.early_fraud_warning.created`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Create a restricted API key that can write Checkout Sessions, read and update PaymentIntents, and read Subscriptions. Store it as `STRIPE_SECRET_KEY` in Railway. A secret key works too. Use a different key for test and live mode.

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
