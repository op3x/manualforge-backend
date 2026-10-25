# ManualOS backend

Node/Express API for [ManualOS](https://manualos.com). It opens Stripe Checkout, checks that a checkout is still paid, and generates a PLC operator-manual PDF.

The website is a separate static site (`op3x/matrixmanual-frontend`). This service only serves the API. Production is `https://manualforge-backend-production.up.railway.app`.

## Pricing

- **Starter** is a $39 one-time payment. It includes `STARTER_CREDITS` manuals (default 3). `POST /jobs` reserves one credit when the job starts and refunds it if generation fails. `POST /generate-manual` is off unless `MANUALOS_LEGACY_GENERATE` is `1`. When that flag is on, it increments `manuals_used` only after a PDF is produced.
- **Pro** is a $79 monthly subscription. Generation stays available while that subscription's status is `active` or `trialing`.

## API

### `POST /create-checkout-session`

Request JSON:

- Starter: `{ "plan": "starter", "termsAccepted": true, "termsVersion": "<terms version>" }`
- Pro: the Starter fields plus `"renewalConsent": true` and `"disclosureVersion": "<auto-renew disclosure version>"`

`termsAccepted` and `renewalConsent` must be the boolean `true`. The version strings are the copy the buyer was shown, trimmed, with no control characters, at most 80 characters. `CHECKOUT_REQUIRE_CONSENT` defaults off. While it is unset, a checkout without those fields still opens, and a complete consent body is stored. Set it to `1` only after the frontend sends the checkboxes. Then a subscription plan (Pro, and Integrator when that checkout exists) is rejected with **400** when Terms, the renewal flag, or `disclosureVersion` is missing. Starter is a one-time payment and does not require the renewal flag. Integrator overage, also one-time, follows the Starter rule.

The server writes `terms_version` on the Checkout Session metadata. A subscription also writes `disclosure_version`, `renewal_consent_at` (ISO-8601), and `plan` on both the session metadata and `subscription_data.metadata`. Starter writes `terms_consent_at` instead of the renewal fields, on the session metadata and on `payment_intent_data.metadata`. `consent_ip` is added on those same objects when the request IP is already available (`req.ip`). New sessions also store `brand` `manualos` on that metadata so cancel links can ignore other products on the shared Stripe account. This does not set `consent_collection` or `custom_text`.

Response JSON: `{ "url": "<hosted Checkout URL>" }`.

Starter uses Checkout `mode: "payment"` and `STRIPE_PRICE_STARTER`. Pro uses `mode: "subscription"` and `STRIPE_PRICE_PRO` (a recurring monthly price). Redirects:

- success: `${FRONTEND_URL}/upload.html?session_id={CHECKOUT_SESSION_ID}`
- cancel: `${FRONTEND_URL}/#pricing`

Checkout requires a billing address. The pay button shows: "Refundable until your first manual is delivered: within 30 days for Starter, or before the billing period ends for Pro. Once a manual is delivered, that purchase is no longer refundable." A subscription adds "Cancel anytime." A one-time payment does not, because there is nothing to cancel. The PaymentIntent or Subscription description names the plan. Starter's description uses `STARTER_CREDITS` (default 3). `CHECKOUT_REQUIRE_TOS` stays unset, so no terms checkbox is sent. Set it to `1` only after a terms of service URL is saved in the Dashboard. Renewal and Terms consent for this API are the request flags above, not that Stripe checkbox.

### `POST /access-link`

Request JSON: `{ "email": "buyer@example.com" }`.

`202` `{ "ok": true }` for every valid address, whether or not a subscription exists. The response is sent before the Stripe lookup, so an unknown address takes the same time as a known one. `400` `{ "error": "A valid email is required." }` for a missing or invalid address. `429` `{ "error": "Too many requests. Try again later." }` after 10 requests from one IP in an hour, or 3 requests for one address in an hour. The 429 body is the same in both cases. `503` `{ "error": "Cancel links are temporarily unavailable." }` when `PORTAL_TOKEN_SECRET` is unset. That response is the same for every caller, including an invalid address, and it is sent before the Stripe lookup.

When the address has a paid ManualOS subscription Checkout Session from the last 12 months, and the customer can use the portal, the server emails `${FRONTEND_URL}/cancel?token=...`. That link is the online cancel path. A session counts when metadata `brand` is `manualos` on the session, subscription, or customer, when the price id is one of this service's `STRIPE_PRICE_*` values, or when a lookup key or integration id matches `manualos_*`. `metadata.plan` alone does not count. Anything else, including an HTS Atlas subscription, is ignored, and an HTS-only buyer is not emailed. No email is sent for an unknown address or a Starter-only buyer. The route does not say which of those happened. The token is an HMAC tied to that session's Stripe customer. It stays valid for one hour and can be used more than once until that hour is over. It is not a Checkout `session_id` and cannot be used to generate a manual. `PORTAL_TOKEN_SECRET` is the only HMAC key. `STRIPE_WEBHOOK_SECRET` is not a fallback.

Cancellation has to stay possible online (ROSCA and California auto-renewal law). The order is the customer portal, then the Link app when that customer's non-canceled ManualOS subscription has `managed_payments.enabled`, and email only as a backup. `MANUALOS_MANAGED_PAYMENTS` is on only when the value is exactly `1`. That flag does not by itself show the Link steps. The portal is refused when the customer has any subscription whose status is not `canceled` and which is not ManualOS, including one that is scheduled to cancel. A scheduled cancellation is `cancel_at` set, or `cancel_at_period_end` true. In that mixed case the response is the Link app when a non-canceled ManualOS subscription has `managed_payments.enabled`, and otherwise `503`. The server logs that the portal was not opened. If neither online path exists, no cancel email is sent. The server logs `ONLINE CANCELLATION UNAVAILABLE` instead of offering email as the only way to cancel. When the Link path is used, the email leads with `https://app.link.com`, the steps below, and a sentence that email is only a backup. Stripe's Managed Payments guide points customers who manage orders to [app.link.com](https://app.link.com).

### `POST /billing-portal`

Request JSON: `{ "token": "<token from the email>" }` or `{ "session_id": "cs_..." }` for the buyer who still has their Checkout Session. Send one of those, not both. An optional `customer` must equal the customer on the token or session; a different customer is rejected and no portal session is created.

The response follows this order. Email is never the only cancellation method.

1. Customer portal, when `STRIPE_PORTAL_CONFIGURATION_ID` is a `bpc_...` id, Stripe returns a session URL, and every non-canceled subscription on the customer is ManualOS. `200` `{ "method": "portal", "url": "<Billing Portal URL>" }`. `return_url` is `${FRONTEND_URL}/cancel`. The configuration id is always sent. Use a separate configuration and leave the account default unchanged. This Stripe account is shared with HTS Atlas. A product list on the configuration limits plan switching. It does not stop the portal from canceling the customer's other subscriptions, so the API refuses the portal when any non-canceled subscription is not ManualOS. The same check runs for the email token and for a Checkout `session_id`. A subscription with `cancel_at` set, or with `cancel_at_period_end` true, is still non-canceled while its status is `active`.
2. Otherwise, when a non-canceled ManualOS subscription on that customer has `managed_payments.enabled` set to true, `200` with `method` `link`, `url` `https://app.link.com`, plain `steps`, `backup` `email`, and `text`. `text` starts with that URL and the steps. The email sentence is only a backup and comes after the link. The cancel page should show that link and those steps. `MANUALOS_MANAGED_PAYMENTS=1` does not turn this path on by itself.
3. Otherwise, `503` `{ "error": "Online cancellation is temporarily unavailable." }`. The server logs `ONLINE CANCELLATION UNAVAILABLE`. It does not send an email and it does not tell the buyer to cancel by email.

`400` `{ "error": "A cancel link is required." }` when the body has neither field or both. `400` `{ "error": "This cancel link is invalid or expired." }` when the token is invalid or expired, the customer has no ManualOS subscription, or the session is unknown, unpaid, older than 24 hours, Starter, HTS Atlas, or otherwise not ManualOS. A `session_id` works only for a Checkout Session created in the last 24 hours. Older buyers use the email link, which still has to include an online cancel URL. The email token can be redeemed more than once during its one-hour life. Token redemption returns `503` `{ "error": "Cancel links are temporarily unavailable." }` when `PORTAL_TOKEN_SECRET` is unset, before the token is treated as invalid. A `session_id` from the last 24 hours does not need that secret. `429` uses the same body as `/access-link` after 10 requests from one IP in an hour.

Link app steps, for a Sold through Link subscription. Stripe documents subscription management at [app.link.com](https://app.link.com):

1. Open https://app.link.com and sign in with the email on the ManualOS receipt.
2. Go to Recurring.
3. Select the subscription. A Sold through Link subscription can be canceled there.
4. Choose Manage subscription and follow the steps to cancel.

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

A job still running after `MANUALOS_JOB_TIMEOUT_MS` fails. The default is 15 minutes. Values outside 1 minute to 30 minutes are brought inside that range, and the process logs one warning that does not include the configured value. The job error is `This run took too long and was stopped. It did not use a credit. Please try again.` A reserved Starter credit is handed back once. A PDF that arrives after the stop is not saved. The model request and the PDF render are given an abort signal.

If that hand-back throws, it is tried three times over about 30 seconds. If it still fails, the PaymentIntent id and the hold token are stored in `SUPPORT_DATA_DIR/credit-handbacks.json`, or only in memory when `SUPPORT_DATA_DIR` is unset. Startup and a pass every 5 minutes try the queue again. A PaymentIntent that Stripe says does not exist is moved to `credit-handbacks-dead.json` and is not tried again. `GET /health` reports how many are waiting as `creditHandbacksPending`, how many were dropped as `creditHandbacksDead`, and `creditLedgerOk`. Those counts are numbers. When the hand-back file cannot be read, `creditHandbacksPending` and `creditHandbacksDead` are null, `creditLedgerOk` is false, and the process logs an error. The response does not include ids.

Reserving a Starter credit writes `credit_hold` and `credit_hold_at` on the PaymentIntent in one update, and writes the same id, token, and time to `SUPPORT_DATA_DIR/open-holds.json` (memory when the directory is unset). A succeeded job clears that hold without lowering `manuals_used`, then removes the open-hold record. A failed job hands the credit back and removes the record. Jobs themselves are not saved. After a restart, startup and the same 5-minute pass hand back a hold this process does not have in memory when `credit_hold_at` is older than the job timeout plus one minute. A newer hold is left alone. The hand-back decrements `manuals_used` only while `credit_hold` is still that token, and it bumps `credit_generation` on that write, so a second pass cannot return another credit. Without `SUPPORT_DATA_DIR`, a restart cannot see the hold. The 15-minute cancellation-claim reclaim does not read credits.

### `POST /generate-manual`

Off unless `MANUALOS_LEGACY_GENERATE` is `1`. Any other value, including omitting it, returns **404** and `{ "error": "not_found" }`. That response does not reserve a credit, spend a credit, or call the model. The current site calls this route only when `POST /jobs` returns 404, and `POST /jobs` is served, so production leaves the flag unset.

Set the flag to `1` to keep the old route. Same body as before (`file`, or JSON `plcContent`, plus `session_id`). Success is `application/pdf` with `Deprecation: true` and `Link: </jobs>; rel="successor-version"`. The Starter counter increments only after the PDF is sent. A missing model key returns **503** and does not spend a credit.

### `POST /webhook`

Raw JSON body. The route verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`. Requests with a bad or missing signature get `400`. A proven HTS Atlas or other-brand event gets a quiet `200` and is not processed. A money event whose brand is still unknown is logged at error level, appended to `DATA_DIR/unknown-events.jsonl`, and is not processed. ManualOS events run the refund, dispute, renewal, and overage handlers, then the event is logged. A handler failure returns `500` so Stripe retries it. The same event id is not applied twice. See [Shared Stripe account](#shared-stripe-account).

Each generate call re-reads the Checkout Session, PaymentIntent, and Subscription, so access stays correct even if a webhook is delayed. The endpoint is still required: subscription renewals, cancellations, and delayed payment methods are asynchronous, and the signature is what shows the call came from Stripe.

`customer.subscription.updated` sends one cancellation confirmation when a ManualOS subscription becomes scheduled to cancel. Scheduled means `cancel_at` is set, which is what the Billing Portal writes while leaving `cancel_at_period_end` false, or `cancel_at_period_end` is true. The message includes the end date and says there are no further charges. It goes out through SMTP. The server claims that subscription and end date under `SUPPORT_DATA_DIR/cancel-confirmations` before it sends, and writes `sent` into that file after the message is accepted. A second delivery of the same cancellation, including two at once or one after a restart, does not send another email. A claim that is still empty after 15 minutes can be taken again. If sending throws, the claim is removed so Stripe can retry. If that removal fails, the send error is the one Stripe sees and the removal error is logged. With `SMTP_HOST` or `SMTP_FROM` unset, nothing is claimed, the webhook still returns 200, and no message is sent. An HTS Atlas subscription does not get this email. A later update that does not change the cancel fields does not send it again. Pro access continues until the subscription status is no longer `active` or `trialing`, including while `cancel_at` or `cancel_at_period_end` says the cancellation is scheduled.

### `GET /health`

`{ "status": "ok", "service": "manualos-backend", "aiEnabled": boolean, "unknownEvents": number, "creditHandbacksPending": number|null, "creditHandbacksDead": number|null, "creditLedgerOk": boolean, "supportDataDirOk": boolean }`. `unknownEvents` is the number of lines in `DATA_DIR/unknown-events.jsonl`. It is `0` when `DATA_DIR` is unset or the file is missing. `creditHandbacksPending` is how many failed Starter hand-backs are still waiting. `creditHandbacksDead` is how many were dropped because Stripe no longer has that PaymentIntent. Both are counts only. When the hand-back file cannot be read they are null, `creditLedgerOk` is false, and an error is logged. `supportDataDirOk` is false when `SUPPORT_DATA_DIR` is unset or not writable. Startup logs one warning in that case and does not print the path.

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
| `MANUALOS_JOB_TIMEOUT_MS` | No | Wall-clock limit for one `POST /jobs` run. Default `900000` (15 minutes). Values below 1 minute or above 30 minutes are brought inside that range. The process logs one warning and does not print the value. |
| `MANUALOS_LEGACY_GENERATE` | No | Set to `1` to enable `POST /generate-manual`. Off by default. Any other value returns **404** and `{ "error": "not_found" }` with no credit change and no model call. The site calls that route only when `POST /jobs` returns 404. |
| `CHECKOUT_REQUIRE_TOS` | No | Set to `1` to send `consent_collection.terms_of_service: required`. Leave unset. Stripe rejects that field unless a terms of service URL is saved in the Dashboard. Renewal consent does not use this flag. |
| `CHECKOUT_REQUIRE_CONSENT` | No | Set to `1` after the frontend sends Terms and auto-renew checkboxes. Until then a missing checkbox is allowed, and a present checkbox is still stored. |
| `PORTAL_TOKEN_SECRET` | For cancel links | HMAC key for `/access-link` tokens. A token can be used more than once during the hour after it was created. If the secret is unset, `/access-link` and token redemption return 503. There is no fallback to `STRIPE_WEBHOOK_SECRET`. Never logged. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | For the customer portal | Billing Portal configuration id (`bpc_...`). Create a separate configuration and do not make it the account default. A product list on that configuration only limits plan switching. The API still refuses the portal when the customer has a non-canceled subscription that is not ManualOS. |
| `MANUALOS_MANAGED_PAYMENTS` | No | On only when the value is exactly `1`. `isManagedPayments()` in `lib/is-managed-payments.js` is the shared check. Checkout uses it. The cancel page offers https://app.link.com only when that customer's non-canceled ManualOS subscription has `managed_payments.enabled`. Email is only a backup. Startup warns when the value is exactly `1` and no separate portal configuration is set. |
| `FRONTEND_URL` | Yes in production | Site origin, for example `https://manualos.com` |
| `PORT` | No | Railway sets this. Local default `3001` |
| `PUPPETEER_EXECUTABLE_PATH` | No | Chrome or Chromium used to render the PDF. On Railway, Nixpacks installs `chromium` and the server finds it on `PATH`. |
| `TWILIO_ACCOUNT_SID` | To send escalation SMS | Account SID. Never logged. |
| `TWILIO_AUTH_TOKEN` | To accept Twilio webhooks | Validates `X-Twilio-Signature`. Voice, SMS, and relay stay **503** until this is set. |
| `TWILIO_FROM_NUMBER` | To send SMS | E.164 sender for escalation texts. |
| `SUPPORT_PHONE` | No | E.164 number customers call. Mentioned in HELP and the model prompt. |
| `ESCALATION_PHONE` | To reach a person | Owner cell, E.164. Dial target, escalation SMS recipient, and fallback call recipient. |
| `ESCALATION_EMAIL` | For escalation email | Inbox used when an escalation text to `ESCALATION_PHONE` fails. |
| `SMTP_HOST` | For escalation email, cancel links, and cancellation confirmations | SMTP server. Unset skips those emails. Startup logs a warning, and each skipped cancel email logs another. A cancellation confirmation is a no-op without SMTP. |
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
| `SUPPORT_DATA_DIR` | Recommended | Directory for opt-outs, consent, the budget counter, cancellation-confirmation claims, open Starter holds, and failed Starter hand-backs. Railway's disk is ephemeral; mount a volume. Without it, a restart cannot hand back a credit left held by a crashed job. |
| `DATA_DIR` | Recommended | Directory for `unknown-events.jsonl`. Mount the same volume. Each unknown money event appends its event id, type, object id, and timestamp so it can be replayed from the Stripe Dashboard. |
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

In the Twilio console, accept the ConversationRelay predictive/generative AI addendum before the live voice path will connect. Leave Messaging Service Advanced Opt-Out off, or STOP may never reach this app. On a toll-free number the carrier handles STOP. If this app's confirmation reply fails, the opt-out is already stored, the failure is logged, and nobody is called or emailed. The webhook treats STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT, OPT-OUT, and OPT OUT as opt-outs, plus a message that starts with STOP. A longer opt-out such as "please unsubscribe me", "opt me out", "stop texting me", or "remove me" also opts out, unless it mentions a plan, subscription, billing, Pro, Starter, Integrator, a charge, a payment, a refund, cancel, or an account. Those are billing questions and are escalated. HELP and INFO are help. START, UNSTOP, and YES opt back in. START and YES confirm with `Msg frequency varies.` Customer texts are prefixed `ManualOS Support:` and include `Reply STOP to opt out, HELP for help. Msg&data rates may apply.` Inbound texts are stored as opt-in. The website checkbox posts `{ "phone", "consentTextVersion", "source" }` to `POST /api/support/sms-consent` (10 requests per IP per hour). The app sets `trust proxy` to 1, one hop for Railway, so the client address is `req.ip` (the address that hop added). A client-supplied `X-Real-IP` or a forged left-most `X-Forwarded-For` value does not change the limit. Confirm that with one staging request before relying on it.

Live answers use OpenAI with a 12-turn cap per call, an 8-turn cap per SMS thread, `max_tokens` 200, and a short history. An SMS thread resets after 24 hours idle, and each escalation reason is texted to Ryan once per thread. The monthly counter is priced as gpt-4o-mini ($0.15 / 1M input, $0.60 / 1M output) unless the rate variables are set. The assistant does not promise refunds, does not give binding legal or safety advice, refuses card numbers (including spaced, punctuated, and spoken digits) before they are stored or sent to OpenAI, and does not name third-party product lines. Asking for a person, an urgent or safety issue, a legal issue, a complaint, or any billing issue (a charge, refund, invoice, payment, subscription, or cancellation) ends the relay and dials `ESCALATION_PHONE` for 25 seconds. Billing and complaints escalate at any hour, including after hours in America/Chicago, and are not held for morning. The same texts are deduped once per thread and reason. The model is only the backup when the deterministic check does not match. A card number plus a request for a person is refused and handed off. No answer, busy, or failed dials a 120-second transcribed voicemail. The recording's `action` plays goodbye and hangs up, and `recordingStatusCallback` texts Ryan when the file is ready even if transcription fails. Integrator pricing ($249/month, $2,490/year, 25 manuals, white-label, $9 extra) is included only when `SUPPORT_INTEGRATOR_ENABLED` is true.

Turn on **Enforce HTTP Auth** for media in the Twilio console so a recording URL is not public. Opening that URL takes the Account SID as the username and the Auth Token as the password (or a logged-in console session). The token is never put in the SMS.

Escalation texts are sent from `TWILIO_FROM_NUMBER` to `ESCALATION_PHONE`. Toll-free verification can take about two weeks. Until Twilio approves it, those texts fail. A failure is a Twilio API error, or a status callback of `failed` or `undelivered` (for example error 30032 or 30034). The app then does both of these, once each:

- It places a short voice call from `TWILIO_FROM_NUMBER` to `ESCALATION_PHONE`. The call speaks the category, the caller's number, and a one-line reason.
- It emails `ESCALATION_EMAIL` through SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`). The message has the same three fields. A voicemail notice also includes the recording link.

The spoken script, the email, and the saved status record never include a customer card number. If `ESCALATION_EMAIL` or `SMTP_HOST` / `SMTP_FROM` is unset, the email is skipped and a warning is logged. One customer call, or one SMS thread, produces at most one fallback call and one fallback email no matter how many alerts that interaction creates. While a live transfer to `ESCALATION_PHONE` is in progress, the fallback is email only so that phone is not rung twice. Until toll-free verification passes, every escalation text fails and uses this call-plus-email fallback. `PUBLIC_BASE_URL` has to be set or the status callback is omitted and only the API error can fall back. A local number avoids the toll-free messaging block. A text Twilio accepts without a message id is treated as unconfirmed and uses the same fallback.

`SUPPORT_DATA_DIR` holds separate files: `opt-outs.json`, append-only `consents.jsonl` (never trimmed), `budget.json`, `threads.json`, `once.json`, `sms-notices.json` (the status-callback payload, with card numbers redacted), `cancel-confirmations/` (one file per cancellation confirmation, created before the email is sent), `open-holds.json` (Starter credits reserved by a job and not yet succeeded or handed back), `credit-handbacks.json` (hand-backs that failed and are waiting to be tried again), and `credit-handbacks-dead.json` (queued hand-backs dropped because the PaymentIntent no longer exists). The queue files are written to a temp file, fsynced, then renamed into place. The hold files store a PaymentIntent id and a hold token, and the open-hold file also stores the time. They do not store an email. A legacy `state.json` is split once and renamed `state.json.migrated`. Without a Railway volume those files disappear on redeploy, the counter is only safe on one replica, and a restart can send the cancellation confirmation again.

## Stripe setup

Do this in the Stripe Dashboard (or with the CLI against your own account). This repository does not create prices or webhook endpoints.

1. Create a Product named **ManualOS Starter** with one one-time Price of **$39 USD**. Copy that price id into `STRIPE_PRICE_STARTER`.
2. Create a separate Product named **ManualOS Pro** with one recurring Price of **$79 USD** billed **monthly**. Copy that price id into `STRIPE_PRICE_PRO`. Separate products keep the Checkout line item names distinct.
3. Add a webhook endpoint:
   `https://manualforge-backend-production.up.railway.app/webhook`
   Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, and `radar.early_fraud_warning.created`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Create a restricted API key with read access to Charges, PaymentIntents, Invoices, Subscriptions, Prices, Products, Checkout Sessions, and Customers, and write access to PaymentIntents, Subscriptions, Checkout Sessions, and Billing Portal sessions. Customers Write is not used. Also grant read access to Invoice payments, because renewal classification lists them. The delivery stamp writes metadata on the period charge, or on the invoice when that invoice has no charge, so Charges write and Invoices write are required for that stamp. Store it as `STRIPE_SECRET_KEY` in Railway. A secret key works too. Use a different key for test and live mode. The server updates subscription metadata only after the brand gate accepts the event. A lost dispute also cancels that subscription with no proration. A refund does not cancel it.
5. On the Starter price set lookup key `manualos_starter`. On the Pro price set lookup key `manualos_pro`. Checkout uses the lookup key when it finds one, and otherwise uses the price id variables above. Setting those lookup keys is a Dashboard change and is not done by this repository.
6. The Stripe account is shared with HTS Atlas. In **Settings → Billing → Customer portal** (test mode and live mode), create a separate portal configuration and leave the account default unchanged. A product list on that configuration only limits which plans a customer can switch to. It does not stop the portal from canceling other subscriptions on the same customer. The API refuses to open the portal when the customer has any non-canceled subscription that is not ManualOS. Turn the separate portal on and allow customers to cancel at the end of the billing period, not immediately. The Billing Portal records that as `cancel_at` with `cancel_at_period_end` false. Save. Copy that configuration id (`bpc_...`) into `STRIPE_PORTAL_CONFIGURATION_ID`. Do this in test mode and live mode. Without this id, a portal session is not created. Buyers are shown https://app.link.com with plain steps only when their ManualOS subscription has `managed_payments.enabled` and that subscription is not canceled. Email is only a backup. If that subscription is not on Managed Payments, `/billing-portal` returns `503` and no cancel email is sent. Set `MANUALOS_MANAGED_PAYMENTS` to exactly `1` only when Checkout itself should use Managed Payments. Startup logs a warning when that value is `1` and the separate portal configuration is unset. Set `PORTAL_TOKEN_SECRET` to its own random value. Do not reuse `STRIPE_WEBHOOK_SECRET`. The cancel token works more than once until it is one hour old. Without `SMTP_HOST` and `SMTP_FROM`, cancel emails and the cancellation confirmation are skipped. A warning is logged at startup and on each skipped send. The confirmation webhook still succeeds.

### Shared Stripe account

This Stripe account is also used by HTS Atlas (`metadata.brand=htsatlas`, price lookup keys prefixed `htsatlas_`). ManualOS Checkout stamps `metadata.brand=manualos` on the Checkout Session, on the Starter PaymentIntent (`payment_intent_data.metadata`), and on `subscription_data.metadata`. Starter Checkout sets `customer_creation: always` and does not pass `customer` or `customer_update`. The pay button still collects a billing address. Managed Payments creates the Customer, and that Customer’s metadata stays empty, so the webhook does not decide from `customer.metadata.brand`.

The webhook returns **200** `{ "received": true }` for a proven other brand (`brand` other than `manualos`, or a lookup key that does not start with `manualos_`). That response does not log the event, write a file, change access, update Stripe, or send mail. Stripe will not retry it.

Checkout, subscription, and invoice events are ManualOS when they have `brand=manualos`, a lookup key prefixed `manualos_`, a price id from `STRIPE_PRICE_*`, or product metadata `brand=manualos`. `metadata.plan` of `starter`, `integrator`, `overage`, or `integrator_overage` is enough on its own. `metadata.plan` of `pro` is not: `plan=pro` counts only together with `brand=manualos`, a configured ManualOS price, or a `manualos_` lookup key. A foreign brand, a non-ManualOS plan, or a lookup key that does not start with `manualos_` wins over those signals. `htsatlas_` is the HTS Atlas prefix and is ignored first.

`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, and `radar.early_fraud_warning.created` (and other `charge.*`, `refund.*`, and `radar.early_fraud_warning.*` events) are classified from the charge, then the PaymentIntent if the charge metadata does not decide. Dispute and early-fraud objects carry no metadata, so the charge is fetched. Refund metadata is ignored, including refunds issued by Stripe or Link support. A subscription renewal often has no brand on the charge or PaymentIntent. Those charges are followed from the charge to the PaymentIntent to Invoice Payments to the invoice, then matched on invoice or subscription metadata, a `STRIPE_PRICE_*` id, a `manualos_` lookup key, or the product. Checkout Session metadata is used when the PaymentIntent has no plan, which is how a Starter or overage purchase is recognized. Customer metadata is consulted only when every one of those is empty.

There is no in-memory charge or customer set. Recognition does not reset on restart.

A money event that is not a proven other brand and is not a positive ManualOS match is logged at error level as `Webhook brand unknown` plus the event type, event id, and object id. The same record is appended to `DATA_DIR/unknown-events.jsonl` with the event id, type, object id, and a timestamp, and nothing else, so the event can be replayed from the Stripe Dashboard. `GET /health` reports that file's line count as `unknownEvents`. The event is not processed. A deleted object or a 404 is that unknown case and returns 200. A 5xx or network error from Stripe returns 500 so Stripe retries. The log line and the JSONL record have no email address, customer id, card data, or API key.

The live endpoint is subscribed to `charge.refunded` and `charge.dispute.created`. It is not subscribed to `charge.dispute.closed`. Restore-on-won and revoke-on-lost do not run in production until that event is added. Adding it is a webhook settings change and is not part of this repository. Do not describe `charge.dispute.closed` as already enabled on the live endpoint.

Before relying on refund, dispute, or early-fraud handling for purchases made before this change:

- Set lookup key `manualos_starter` on the existing Starter price and `manualos_pro` on the existing Pro price. Until the keys exist, Checkout keeps using `STRIPE_PRICE_STARTER` and `STRIPE_PRICE_PRO`. No Railway variable changes.
- Brand on the charge and PaymentIntent is stamped at Checkout. Existing charges that have only `plan=starter` on the PaymentIntent are still recognized. A charge or subscription with only `plan=pro` is not. A configured price or a `manualos_` lookup key is still recognized. Do not backfill `metadata.brand` onto Customers. Customer metadata is not the signal.
- The restricted key needs the read and write scopes above. It does not need Customers Write. This repository does not create prices, webhook endpoints, or live-mode changes.

### Merge notes

The refund, dispute, renewal, and overage handlers from `cursor/starter-refund-disputes-3d59` (PR #9, head `eeb0411`) are on this branch. They run only after the brand gate returns ManualOS. Unbranded fixtures still pass when the PaymentIntent, subscription, price, Checkout Session, or invoice says the purchase is ManualOS. `plan=pro` by itself does not.

Keep removing customer creation and `customer_update` from Starter and Pro checkouts. Starter keeps `customer_creation: always`. `customer_update` conflicts with Managed Payments, which removes it. One exemption: PR #6's Integrator extra-manual and overage Checkouts may pass `customer=<existing ManualOS customer id>` (never `customer_update`, never creating a customer). Classification for them must work from session, charge, and PaymentIntent metadata `brand=manualos` and `plan=integrator`. An HTS customer reused there is ignored. `applyManualosCheckout` deletes `customer` only when it is empty, and always deletes `customer_update`. This branch is PR #15, rebased onto PR #9 (`eeb0411`) and PR #16 (`7149990`). PRs #6, #10, and #11 are not merged here.

Starter stays valid while the Checkout Session is `paid` and the PaymentIntent `credit_status` is not `revoked` or `suspended`. Stripe does not change `payment_status` when a charge is refunded later. `/webhook` does, by writing `credit_status` on the Starter PaymentIntent.

- A full `charge.refunded` (`refunded` is true, or `amount_refunded` is at least `amount`) sets `credit_status` to `revoked`. Remaining Starter credits can no longer generate manuals.
- A partial refund is logged and does not change `credit_status` or the credits. Stripe sends `charge.refunded` again if later partial refunds add up to the full amount, and that later event revokes them.
- `charge.dispute.created` sets `credit_status` to `suspended` unless the purchase is already revoked.
- `charge.dispute.closed` with status `won` (the charge stands) sets `credit_status` back to `active`. Status `lost` sets `credit_status` to `revoked` permanently, and a later `won` does not restore those credits. `warning_closed` and `prevented` do not restore and do not newly suspend: `restoresAccess` is true only for `won`. A purchase that is already `revoked` stays revoked. The closed dispute id is stored in `credit_closed_disputes`. If the opening event for that id arrives later, it does not suspend the purchase. A lost Starter dispute revokes that purchase only. Another paid Checkout for the same customer stays active.
- The handled event id is appended to PaymentIntent `credit_events`. A second delivery of that id does not write again.
- A charge that is not a Starter PaymentIntent is logged and ignored for Starter credits. The handler reads `payment_intent` on the charge or dispute, and if the PaymentIntent has no `plan` it lists Checkout Sessions for that PaymentIntent.

A full refund of the charge that paid for the current billing period sets subscription metadata `period_access` to `revoked`, `period_invoice` to that invoice, and `period_end` to that invoice's period end. The subscription is not cancelled. This applies to ManualOS subscriptions the brand gate has accepted (`metadata.plan` of `pro`, `integrator`, or `integrator_overage`, or another positive ManualOS signal). An HTS Atlas subscription is not updated. `POST /jobs` and `POST /generate-manual` then return **402** until a later paid renewal invoice covers a new period. That invoice must have `billing_reason` of `subscription_cycle`, `subscription_create`, or `subscription_update`, `amount_paid` greater than 0, and a period start at or after the stored `period_end`. A $0 invoice, a `manual` invoice, the same invoice id, or an update that is still inside the refunded period does not clear the block. A refund of an earlier period does not block the current one. A partial refund is logged and does not change `period_access`.

Disputes on a ManualOS subscription charge follow the same rule as Starter, for every plan the brand gate accepted, and they are not limited to the current period. Open dispute ids are stored separately from the refund flag, in `open_disputes` and `open_dispute_count`. Access stays suspended while that set is non-empty, including when the id list was shortened to fit Stripe's metadata limit and the count is still above zero. Only `charge.dispute.closed` removes an id. A refund and a paid renewal never remove it, so winning one dispute, or renewing after a refund, does not restore access while another dispute is open. `won` restores `period_access` only when the set is empty and the period was not revoked. `lost` sets `period_access` to `revoked` and `revoked_dispute_lost` to `true` on that subscription only, and cancels that subscription immediately with `prorate: false` and `invoice_now: false`. It does not set a customer flag and it does not block a later checkout from the same email or customer. The new purchase gets its own access. No later invoice clears `revoked_dispute_lost` on the disputed subscription. A later `won` does not restore it. A dispute id that is already closed is ignored if the opening event arrives later. Integrator checkout is not in this codebase. The block is already plan-agnostic, so an Integrator subscription is covered without a further change here.

A one-time overage Checkout is separate from Starter. Session metadata `kind=overage` (or `purchase` / `credit` of `overage`, or `overage=true`) marks it. A full refund or a lost dispute removes one unused credit, once per purchase: it decrements `credits_remaining` or `overage_credits` when that counter is above zero, and otherwise sets `credit_status` to `revoked`. The same update sets `overage_removed=1` on that PaymentIntent, so a second refund or lost dispute does not remove another credit. An open dispute sets `credit_status` to `suspended` until `won`. A credit that was already used is logged and is not decremented. Integrator overage uses the same events with Checkout metadata `plan: integrator_overage` and `subscription_id`. The count is subscription metadata `overage_remaining`. A full refund or a lost dispute decrements that count by one, and never below zero, once per PaymentIntent. The PaymentIntent is marked `overage_removed=pending` before that decrement. The subscription update then lowers `overage_remaining` and adds the PaymentIntent to `overage_removed_intents`. The marker becomes `overage_removed=1` only after that subscription write succeeds. A retry that finds `1` does not decrement. A retry that finds `pending` and this PaymentIntent already in the list sets the marker to `1` and does not decrement. A retry that finds `pending` without that id decrements once and then sets `1`. A later refund or lost dispute does not take another credit after the marker is `1`, even if the capped id list has rolled off. An open dispute sets `overage_suspended` until `won` and does not change the count. Included Integrator `manuals_used` is not the overage credit.

`POST /jobs` and `POST /generate-manual` reject a refunded Starter purchase with **402** and `This purchase was refunded, so it can no longer generate manuals. Contact support@manualos.com.` A lost Starter dispute returns **402** and `This purchase was lost in a payment dispute, so it can no longer generate manuals. Contact support@manualos.com.` A suspended Starter purchase returns **402** and `This purchase is suspended because of a payment dispute, so it can no longer generate manuals. Contact support@manualos.com.` A refunded billing period returns **402** and `This billing period was refunded, so it can no longer generate manuals until the next paid invoice. Contact support@manualos.com.` A lost subscription dispute returns **402** and `This subscription was lost in a payment dispute, so it can no longer generate manuals. Contact support@manualos.com.` A suspended billing period returns **402** and `This billing period is suspended because of a payment dispute, so it can no longer generate manuals. Contact support@manualos.com.` A job that already started is checked again when it finishes. If the purchase or subscription was revoked or suspended, the PDF is not saved and a reserved Starter credit is refunded. `GET /jobs/:id/pdf` checks access again and returns **402** without deleting a PDF that was already stored, so a dispute that is later won can still be downloaded. `GET /verify-session` reports `valid: false` while Starter credits or the subscription period are revoked or suspended.

The first manual from a purchase is recorded only after a PDF exists and the delivery stamp is written. `POST /jobs` saves the PDF, then stamps, then marks the job succeeded. If the save fails, or the stamp fails after the save, the job fails, a reserved Starter credit is refunded, and a stamp written for that job is removed. `POST /generate-manual` stamps, then counts the Starter credit, then sends the body. If that request fails before the PDF is sent, a stamp created for this request is removed. A stamp that was already there is left in place. A rejected upload (415 or 422), a missing model (503), a failed render, or a job error does not leave a new stamp. Starter stores `first_manual_at` on the PaymentIntent. A subscription stores it on the current period's charge, or on the invoice when that invoice has no charge. A new period is a separate purchase. Generation also writes `generation_started_at` on that same object. Each live run increments `generation_in_progress`. A marker older than 15 minutes is not in progress: eligibility ignores it, and the next run resets the count to 1 and the start time to now. While a run is still going, the server refreshes `generation_started_at` every 5 minutes and leaves `generation_in_progress` unchanged, so a generation longer than 15 minutes stays in progress. A new run also resets that way when this process has no generation still running for that purchase, so a crash or redeploy does not leave the count stuck. The timestamp stays until the last live run finishes, then both are cleared. The delivery stamp clears them as well. If the Stripe write that clears the marker fails, the server retries it a few times and then logs `Generation progress clear failed`. If the stamp cannot be written, the error is logged as `First manual delivery stamp failed` plus the plan, with any API key redacted. The PDF is not served. `POST /generate-manual` returns **500**. A job is marked failed, and a reserved Starter credit is refunded, so a purchase is never both delivered and undownloadable.

Support checks eligibility with the secret already in `STRIPE_SECRET_KEY`. There is no public route and no new environment variable.

```bash
npm run support:refund-check -- pi_...
npm run support:refund-check -- ch_...
npm run support:refund-check -- cs_...
npm run support:refund-check -- in_...
npm run support:refund-check -- buyer@example.com
```

Exit 0 when a purchase is found, 2 when a well-formed id is not found, and 1 on a usage or configuration error. A query that is not a `pi_`, `ch_`, `cs_`, or `in_` id and is not an email prints the usage line and exits 1 before Stripe is called. The JSON has `refund_eligible`, `deadline`, and `reason`. A purchase is eligible only when no manual has been delivered, a generation is not in progress, and the deadline has not passed. A generation start older than 15 minutes does not count as in progress. A live run refreshes that start every 5 minutes. While a job is running, the reason is `generation in progress since <time>; check again after it finishes`. Starter's deadline is 30 days after the payment time, or the Checkout Session creation time when the payment has no creation time. Subscription charges, including a metadata plan of `integrator`, are eligible until that invoice's billing period ends. The period end is the subscription item `current_period_end` (or the legacy subscription `current_period_end`) when this invoice is the subscription's latest invoice, otherwise the invoice line `period.end`, otherwise `invoice.period_end`. The reason is `eligible until <time>`, `past deadline <time>`, or `delivered at <time>`. A one-time overage credit (Checkout metadata `kind=overage`, or `purchase` / `credit` of `overage`, or `overage=true`, or `plan: integrator_overage`) is labeled `overage`. It is refundable only until that credit is used, with reason `eligible until the overage credit is used` or `overage credit already used`, and its deadline is null. For `integrator_overage`, used means subscription `overage_remaining` is not above zero. The email address is not printed. Email lookup searches Customers and also Checkout Sessions by `customer_details.email`, which is how a Starter buyer is found before a Customer existed. A Checkout Session resolves to that session's PaymentIntent or that session's invoice, not a later period on the same subscription. The command does not refund anything.

`npm run support:restore-starter-credit -- --payment-intent pi_... --ticket <id>` prints the current `manuals_used`, the open holds and hand-back queue entries for that PaymentIntent, and the change it would make. It does not write. `--apply` decrements `manuals_used` by 1, never below 0, and only when `metadata.plan` is `starter`. The same command records the ticket in `restored_tickets`, bumps `credit_generation`, and clears `credit_hold`, so the same ticket cannot decrement again and a later hand-back cannot decrement again either. Open-hold and hand-back rows for that PaymentIntent are removed when the write lands. A purchase that is not Starter is left unchanged. A dry run is the default. The command refuses a live secret key, and a PaymentIntent with `livemode` set, unless `--live` is passed. It does not print secret keys or full email addresses.

The restricted key needs Charges Read and Write, Invoices Read and Write, Customers Read, Invoice payments Read, Prices Read, Products Read, and Subscriptions Read and Write, plus Checkout Sessions Read and Write and PaymentIntents Read and Write. It does not need Customers Write. Charges Write stores the first-manual stamp on a subscription period charge. Prices Read resolves a `manualos_` lookup key when the invoice line has only a price id. Products Read reads product metadata on a renewal charge. Charges Read maps a dispute that only has a charge id. Checkout Sessions Read recognizes a Starter PaymentIntent with no `plan` and an overage Checkout Session. Invoice payments Read is used when a charge payload has no `invoice`, which is the current Stripe API shape. Subscriptions Write updates period and overage metadata and, only after a lost dispute, cancels that subscription with no proration. A refund never cancels it. A lost dispute does not write customer metadata. The handler logs `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, and `radar.early_fraud_warning.created`. Of those, only `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, and `invoice.paid` change access, and only after the brand gate returns ManualOS. The checkout, subscription, `invoice.payment_failed`, and early-fraud events are logged and do not change credits or access. No event beyond that list is required. `charge.dispute.closed` is in that list and is not enabled on the live endpoint until it is added in the Dashboard. Starter Checkout is created with `customer_creation: always`.

Stripe Tax is left off. If you sell to US or EU customers, enable [Stripe Tax for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes.md) only after the account has an active registration. Turning on automatic tax without a registration collects no tax and returns no error.

`CHECKOUT_REQUIRE_TOS` stays unset. Stripe rejects Checkout when `consent_collection.terms_of_service` is `required` and the Dashboard has no terms of service URL. Set the variable to `1` only after that URL is saved. Any other value, including omitting it, leaves the checkbox off.

`CHECKOUT_REQUIRE_CONSENT` stays unset until the frontend sends `termsAccepted`, `termsVersion`, and, for subscriptions, `renewalConsent` and `disclosureVersion`. Present consent is stored before the flag is turned on. Set the variable to `1` after that frontend ships. Any other value leaves the requirement off.

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

Run the server as a single replica. Job PDFs and the in-process credit locks live in that process. A second replica would not see the other process's files or locks. The delivery stamp and the refund and dispute flags are on Stripe, so those survive a restart.
