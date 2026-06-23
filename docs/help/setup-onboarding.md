# Setup & Onboarding (for admins)

This is the admin's manual for standing up an account and getting a team working
in ServiceCycle: adding people, giving them the right level of access, setting who
owns each customer, and the first-week checklist. If you are looking for the
fresh-install `/setup` wizard or the new-user walkthrough, see the **Onboarding**
module - this guide picks up after the system is running and focuses on people and
access.

Most of what follows lives under **Settings** (admin only). Open it from the
pinned link at the bottom of the sidebar.

## Who can do this

Account setup is an admin task. Roles fall into tiers:

- **Admin** - full control, including Settings, users, roles, and billing-level
  configuration.
- **Manager** - day-to-day operations: assets, work orders, reports, imports, and
  the review queue. No access to Settings.
- **Viewer** - read-only. Sees equipment and reports but cannot make changes.
- **Consultant** - read-only with attribution; an outside party (for example a
  testing contractor) who needs to look but not edit. Their access is logged.
- **Field tech** - a phone-first, field-only login scoped to the work in front of
  them. Default-deny: they see what they are assigned, nothing more.

Pick the lowest tier that lets a person do their job. You can always raise it
later, and individual capabilities can be tuned on top of the role (below).

## Adding a user

1. Go to **Settings -> Users & Roles**.
2. Choose **Invite user** and enter their name, email, and role.
3. They receive an email invitation with a link to set their own password. Until
   they accept, the account shows as pending.

To remove someone, deactivate their account from the same screen. Deactivation
keeps their history intact (work orders, edits, and the activity log still show
what they did) while ending their access.

## Roles vs. capabilities

A **role** sets the broad tier. On top of that, each user has a small set of
**capabilities** (feature toggles) an admin can grant or revoke individually:

- **Edit assets** - create and edit assets, sites, and schedules.
- **Manage contractors** - add and manage contractors and their technicians.
- **Maintenance brief** - generate the AI compliance/maintenance summary.
- **Communications** - log and view communications.
- **Export** - export data to CSV / spreadsheet.
- **Alerts** - receive maintenance-due and overdue alerts.

Set these under **Settings -> Users & Roles** on the permissions matrix. The
effective rule is simple: a feature is visible to a user only when the admin has
granted it **and** the user has not hidden it from their own view. Users hide or
re-show their own granted features under **Profile -> My View** - that never grants
access they were not given, it only declutters their sidebar.

## Who owns each customer (the account contact)

Every site and account has a point of contact - the person your team treats as the
account owner for that customer. This contact is what drives the monthly digest:
the rep is set as the CC and Reply-To on the customer-facing email, so replies land
with the right person.

Set the contact on the **site** record (and at the account level) so each customer
maps to a clear owner. Keeping these current is what keeps the digests, and the
"who is my rep" answer, correct. A dedicated screen for moving a whole book of
customers from one rep to another is planned; today you set ownership per site.

## Info tips

New users do not have to memorize the product's vocabulary. Small circled-**i**
markers next to scores and labels (maturity score, maintenance debt, condition
ratings, and so on) open a one-line plain-language explanation on click. They are
on by default; anyone can switch them off under **Profile -> My View**.

## First-week checklist

1. Stand up the account with the `/setup` wizard (see **Onboarding**).
2. Add your team under **Settings -> Users & Roles** and set each person's role.
3. Tune capabilities for anyone who needs more or less than their role's default.
4. Create your sites and set the point of contact on each one.
5. Add or import assets (see **Imports** for the fast data-in paths).
6. Confirm schedules and the compliance calendar look right (see **Maintenance
   Schedules**).
7. Turn on alerts and the monthly digest so the team and customers stay informed.

Once these are done the dashboard, reports, and digests have real data to work
with, and the rest of the product follows the same pattern: data in, compliance
out.
