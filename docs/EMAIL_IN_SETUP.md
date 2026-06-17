# Email-in (#6) â€” go-live setup

Forward a test report to a per-account address and ServiceCycle parses every line
and auto-creates the asset card(s). The whole pipeline is **built, deployed, and
verified** end-to-end (a simulated inbound report created a SWITCHGEAR card with
6 readings + 4 deficiencies in the West Allis Energy demo account).

The only thing left to make *real email* flow is wiring an inbound provider.
We chose **Resend Inbound** (most accurate + stable: it parses the MIME for you,
signs the webhook, retries with backoff, and retains the email if your endpoint
is down â€” nothing is silently lost). Outbound stays on Brevo; inbound on Resend.

## How routing works (already coded)
- Webhook endpoint: `POST https://servicecycle.app/api/inbound/email`
- It routes by the **local part** of the `to:` address: `reports-<slug>@<anything>`
  matches the account whose `AccountSetting inbound_slug = <slug>`. The domain is
  ignored, so root or subdomain both work.
- Demo account **West Allis Energy** â†’ `reports-westallis@<your-receiving-domain>`.
- Each PDF/photo attachment is stored and auto-committed (no human review).

## One-time setup
1. **Resend â†’ add a receiving domain.** In Resend, add `servicecycle.app` (or a
   subdomain like `in.servicecycle.app` if you'd rather not touch the root) under
   the Receiving tab. Resend gives you an **MX record**.
2. **Cloudflare â†’ add the MX record** Resend shows you. (servicecycle.app has no
   MX today, so adding it on the root is safe; a subdomain also works.)
3. **Resend â†’ Webhooks â†’ Add Webhook.** URL `https://servicecycle.app/api/inbound/email`,
   event type **`email.received`**. Copy the **signing secret** (`whsec_...`).
4. **Set two env vars on the droplet** (`/root/ServiceCycle/.env`), then rebuild:
   - `RESEND_WEBHOOK_SECRET=whsec_...`   (verifies the Svix signature)
   - `RESEND_API_KEY=re_...`            (fetches attachment bytes via Resend's API)
   ```
   # on the droplet
   cd /root/ServiceCycle
   printf '\nRESEND_WEBHOOK_SECRET=whsec_xxx\nRESEND_API_KEY=re_xxx\n' >> .env
   docker compose up -d --build server
   ```
   (The compose file already passes both vars through to the server container, and
   `INBOUND_WEBHOOK_SECRET` is already set for the shared-secret/test path.)

## Test it
Forward (or send) any test-report PDF to **`reports-westallis@<receiving-domain>`**.
Within a few seconds, log in as `admin@westallis.energy` â†’ the asset card appears
under West Allis Works with all the readings and any flagged deficiencies.

## Auth model (defense-in-depth)
The endpoint fails closed. It accepts a request only if **either**:
- the Resend/Svix signature verifies against `RESEND_WEBHOOK_SECRET` (live path), **or**
- an `x-inbound-secret` / `Bearer` header matches `INBOUND_WEBHOOK_SECRET`
  (used for simulation, the CLI, or a non-Resend provider).

## Notes
- Attachments: the webhook is metadata-only by design (Resend stores the bytes);
  the server fetches them via `GET /emails/receiving/:id/attachments` â†’ `download_url`.
  The handler also accepts inline base64 (`data.attachments[].content`) for providers
  that inline, and for local simulation.
- Un-routable mail (no matching `inbound_slug`) is accepted with 202 and dropped â€”
  no bounce, no retry storm.
- To give another account an inbox, set its `inbound_slug` (and optionally
  `inbound_site_id`) AccountSetting.