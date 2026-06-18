# Onboarding

This is the path from a fresh install to a working compliance calendar. There are
two wizards: a one-time **setup wizard** that stands the system up, and an in-app
**new-user wizard** that walks a new admin through their first site, asset, and
schedule.

## First-run setup wizard

On a brand-new install, the `/setup` wizard runs before anyone can log in and
walks the operator through four steps:

1. **Account** — company name, the first admin's name, email and password, and
   acceptance of the Terms, EULA, and Privacy Policy.
2. **Email** — connect a mail provider so the app can send digests and alerts, or
   skip and run in mock mode for now.
3. **AI** — optionally bring your own AI provider key (Anthropic, OpenAI, Azure
   OpenAI, or Gemini) to enable nameplate reading and report extraction, or skip;
   the deterministic parser still works without it.
4. **Finish** — the app shows your master encryption key. **Save it before you
   continue** — it is required to decrypt stored secrets and the app makes you
   acknowledge it on purpose. Once setup is complete, `/setup` redirects to the
   login page.

## In-app new-user wizard

The first time a new admin logs in, a short guided wizard gets them to a working
calendar in four moves: create the **first site**, add the **first asset**, put a
**maintenance schedule** on it, and turn on **alerts**. The wizard remembers where
you left off, so you can close it and pick the same step back up later (and you
can re-open it any time from Resources & Feedback → Show welcome tour).

## Zero to a compliance calendar

The fastest route to value is to let your existing reports do the data entry:

1. Create a site and, if you like, its building/area/position structure.
2. Import a test report (or a zip of them) — assets, readings, and deficiencies
   land automatically and match to the right equipment. See *Imports*.
3. Apply the relevant maintenance tasks to those assets (bulk-apply makes this one
   action), and the calendar fills with real next-due dates.
4. Turn on alerts and digests so the system tells you what's coming.

That's the whole idea: the reports you already produce become a living equipment
record, and ServiceCycle turns it into a short list of what to do next.

## Trying it out

The public demo is pre-seeded with a sample facility — sites, assets, schedules
staged across overdue / due-soon / future, work orders, deficiencies, and arc-
flash studies — so you can explore every surface without entering data first. The
demo resets on its own each night.

## When something looks wrong

**`/setup` won't open — it sends me to login.** Setup is already complete on this
install; the wizard only runs once. Sign in instead.

**I skipped email or AI during setup.** Both are optional and configurable later
under Settings — nothing about setup locks those choices in.

**The welcome wizard disappeared.** Re-open it from the sidebar's Resources &
Feedback menu → Show welcome tour.
