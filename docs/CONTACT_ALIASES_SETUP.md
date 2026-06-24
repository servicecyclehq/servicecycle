# Contact email aliases — setup guide

Two customer-facing addresses are referenced throughout the app:

| Address | Where used |
|---|---|
| `support@servicecycle.app` | Landing page error recovery, early access form, in-app feedback, GDPR deletion requests, user export notes |
| `sales@servicecycle.app` | Register page "need an account?" copy |

Neither address receives mail until two things are in place: Cloudflare Email Routing
(DNS-level, free) and one `.env` variable on the droplet.

---

## Step 1 — Cloudflare Email Routing (2 minutes)

1. Log in to Cloudflare → select the `servicecycle.app` zone → **Email Routing**.
2. If Email Routing is not yet enabled, click **Enable Email Routing**. Cloudflare
   adds the required MX records automatically.
   > **Note:** if you have an existing MX record pointing elsewhere, Cloudflare will
   > warn you. The inbound report pipeline (`reports-*@servicecycle.app`) uses Resend
   > inbound, NOT this MX, so there is no conflict unless you separately configured
   > an MX for `servicecycle.app`. If Resend's MX is on a subdomain
   > (`in.servicecycle.app`), there is no conflict.
3. Under **Routing rules → Custom addresses**, add two forwarding rules:
   - `support@servicecycle.app` → **Forward to** `claudedussy@gmail.com`
   - `sales@servicecycle.app` → **Forward to** `claudedussy@gmail.com`
4. Cloudflare will send a verification email to `claudedussy@gmail.com` — confirm it.
5. That's it. Emails sent to either alias will arrive in your Gmail inbox with the
   original `from:` preserved, so you can reply directly.

---

## Step 2 — Set the `SUPPORT_EMAIL` env var on the droplet

The server uses `SUPPORT_EMAIL` to route three internal notification streams to
your inbox:

- **In-app feedback** (`/api/feedback`) — every thumbs-up/down from users
- **Early access sign-ups** (`/api/early-access`) — new demo requests
- **AI budget alerts** (`server/lib/aiBudgetGuard.ts`) — daily/monthly spend warnings

Without it set, these notifications are silently discarded (they log a warning but
don't error).

```bash
# SSH into the droplet and append to .env:
echo "SUPPORT_EMAIL=support@servicecycle.app" >> /root/ServiceCycle/.env

# Rebuild the server container to pick up the new var:
docker compose -f /root/ServiceCycle/docker-compose.yml up -d --build server
```

---

## Step 3 — Verify (optional)

After routing is live, send a test email to `support@servicecycle.app` from any
external address. It should appear in your Gmail inbox within a few seconds.

To test the feedback pipeline end-to-end, log into the demo account and click the
thumbs-down on any response. You should receive a `[ServiceCycle Feedback]` email
at `support@servicecycle.app`.

---

## FAQ

**Do I need a paid Cloudflare plan?**
No. Email Routing is available on all Cloudflare plans, including free.

**Can multiple people receive these?**
Yes — add multiple forwarding destinations in the Cloudflare rule, or set up a
Gmail filter to auto-forward to team members.

**What about `sales@` on the server side?**
`sales@servicecycle.app` appears only in client-side copy (Register page). It does
not currently drive any server-side notification pipeline; Cloudflare forwarding is
sufficient. If you add a sales inquiry form later, wire it to a `SALES_EMAIL` env
var on the same pattern as `SUPPORT_EMAIL`.

**What about `security@servicecycle.app`?**
Referenced in the `/.well-known/security.txt` endpoint. Add a third Cloudflare
routing rule for it at the same time.

**Does this affect the report-ingest pipeline?**
No. The `reports-*@servicecycle.app` addresses use Resend inbound (a different MX,
typically on a subdomain). Cloudflare Email Routing and Resend inbound operate
independently. See `docs/EMAIL_IN_SETUP.md` for the report-ingest pipeline.
