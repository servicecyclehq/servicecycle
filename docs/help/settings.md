# Settings

Settings is the admin control plane: the AI provider, security and encryption,
custom fields, users and roles, rate cards, and the integration plumbing. Most of
it is admin-only — managers and below run the day-to-day surfaces, admins own the
configuration.

## AI provider (bring your own)

ServiceCycle reads nameplates and extracts reports without AI, but connecting a
provider makes those features sharper. You bring your own key — Anthropic, OpenAI,
Azure OpenAI, or Gemini — and ServiceCycle stores it **encrypted at rest** and
decrypts it only to make a call. Use the test button to confirm the connection
before you rely on it. You can cap AI usage per role so a busy account doesn't run
up surprise provider spend, and the deterministic parser keeps working regardless
of whether AI is on.

## Security & encryption

Secrets — AI keys, channel webhooks, signing keys — are encrypted with AES-256-GCM
using the master key from setup. Password policy (minimum length, required
character classes) is enforced everywhere a password is set: registration, reset,
and invite acceptance. The activity log keeps a tamper-evident, hash-chained
record of consequential actions, which is what the compliance snapshots anchor
against.

## Users & roles

Manage your team and their roles under Settings → Users & Roles. The roles are:

- **Admin** — full control, including settings, users, and account data.
- **Manager** — runs operations: create and edit assets, schedules, and work
  orders, and produce reports. Reads settings but doesn't change them.
- **Viewer** — read-only, and can be scoped to specific sites.
- **Consultant** — read-only for outside advisors; every action is attributed and
  logged, and the UI flags the access.

(Cross-account OEM/fleet and platform roles exist for partner deployments.)

## Custom fields

Define your own fields — text, checkbox, select, or date — to capture data
ServiceCycle doesn't model out of the box. They're validated on write like any
built-in field and become available on the records they apply to.

## Rate cards

Rate cards hold your labor, parts, and travel rates so the cost and remediation
estimates in reports reflect your actual numbers rather than generic ones. Keep
them current and the CFO report and remediation figures stay meaningful.

## Common workflows

**"Turn on AI features."** Settings → AI, pick a provider, paste your key, run the
test, and set per-role caps if you want a spend ceiling.

**"Add a teammate."** Settings → Users & Roles → invite, and choose the role that
matches what they should be able to do.

**"Capture a field we track that isn't here."** Settings → Custom Fields, define
it, and it appears on the relevant records.

## When something looks wrong

**The AI test fails.** Re-check the key and the selected model for that provider;
the test surfaces the provider's own error so you can tell a bad key from a model
mismatch.

**A user can't do something they should.** Check their role — managers can't
change settings, and viewers (especially scope-restricted ones) are read-only by
design.

**Cost estimates look generic.** Your rate cards are probably empty or stale; fill
them in and the figures recompute against your real rates.
