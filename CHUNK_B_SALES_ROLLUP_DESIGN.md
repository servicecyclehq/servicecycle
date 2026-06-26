# Chunk B (Sales roll-up + rep assignment) — design memo & decisions needed

**Status:** NOT built. I stopped before building because the locked plan assumed a data
model that differs from what's actually in the code, and the dashboard is inherently
cross-account (tenant-isolation sensitive) — exactly the "build together" call the plan
flagged. Here's what I found and the specific decisions I need from you before building.

## What's already in the code (the plan didn't know this)

- **`Account.assignedRepId`** (FK → User, "primary rep") and **`Account.fallbackRepId`**
  already exist — labeled "Partner flywheel: assigned service rep + fallback rep routing."
  So there IS already a rep↔account link, and it's a hard column (the plan wanted to
  *avoid* a hard `accountManagerId` and use a role-on-assignment relationship instead).
- **`Account.serviceRepName / serviceRepEmail / serviceRepPhone`** — a SEPARATE free-text
  contact. This is what the **customer-facing monthly digest** uses for CC / Reply-To
  (`customerDigest.ts` reads `serviceRepEmail`). It is NOT a User.
- So "the rep" is currently TWO things: an internal User (`assignedRepId`) and a free-text
  customer-facing contact (`serviceRepEmail`). The plan treated them as one.
- **Cross-account roll-ups already exist and scope by a parent id:** the OEM fleet
  dashboard scopes accounts by `partnerOrgId`; the HoldCo group roll-up scopes by
  `enterpriseGroupId`. Neither is obviously "a services company and its customer accounts
  with internal sales reps." There's also a `super_admin` role and a demo/all-accounts
  fallback.

## The core unknown: tenancy scope of the sales book

The plan says "one card per Account Manager, body = their **accounts** sorted worst-
compliance-first." That's **cross-account**. But which set of accounts, and who owns the
rep Users?

- In SC, a `User` belongs to ONE `Account` (has `accountId`). `assignedRepId` is an
  unconstrained string FK — it *could* point to a User in a different account (e.g., the
  services company's account) but nothing enforces that.
- So "a services-company rep owns customer Account X" needs a clear operator↔customer
  structure. Candidates: reuse `partnerOrgId` (conflates the OEM channel with a sales
  book — probably wrong), reuse `enterpriseGroupId` (HoldCo, also wrong), or a NEW
  operator/services-company scope.
- Getting this wrong = either a tenant-isolation bug (a rep sees accounts they shouldn't)
  or building the wrong model you'd reject. Not a safe autonomous guess.

## Decisions I need from you

1. **Deployment shape.** Is SC, for the sales-roll-up use case, ONE services-company
   instance whose CUSTOMERS are separate `Account`s? Or are customers **Sites** under a
   single Account, and reps own *sites*? (This flips the whole model: group by account vs.
   group by site.) The plan says "accounts," but your real deployment decides this.

2. **Rep model.** Given `assignedRepId` already exists — do we (a) build v1 on
   `assignedRepId` as the Account Manager (no migration, ships fast, hard column), or
   (b) introduce the role-on-assignment relationship table now (future-proofs to "sales
   team," but a migration + we must reconcile with the existing `assignedRepId` so there
   aren't two sources of truth)? My lean: **(a) for v1**, with the relationship table as a
   later migration when the sales-team need is real — but your call.

3. **Reassignment ↔ customer-facing contact.** When we move an account from rep A to rep
   B, should that ALSO update `serviceRepName/Email/Phone` (so the customer-facing digest
   CC/Reply-To follows)? Or are the internal owner (`assignedRepId`) and the customer
   contact (`serviceRepEmail`) deliberately independent (e.g., a shared support inbox)?
   This determines whether reassignment keeps "who's my rep" correct end-to-end.

4. **Who can view `/sales`.** Confirm the capability-grant approach: a per-user
   `canViewSalesRollup` flag (default on for admin/manager, grantable to a non-admin sales
   VP). I'd add it as a small additive column + a toggle in Users & Roles. OK?

5. **Scope of accounts in the roll-up.** Once (1) is answered: scope by the same parent id
   the caller belongs to (mirroring the fleet pattern), or an explicit operator scope?

## Once decided, the build is ~3 green slices (as planned)

- B-1: capability grant + the AM resolution helper (book-of-business + Unassigned bucket),
  on whatever rep model (2) lands on.
- B-2: read-only `/sales` — one card per AM (name + aggregate compliance % across the
  book), accounts worst-compliance-first, auto counts (open quotes, booked work, open
  deficiencies), Unassigned bucket, drill-down. ZERO manual entry.
- B-3: one-screen reassignment (pick departing rep → see book → move selected/all),
  keeping the customer-facing contact correct per decision (3).

Compliance %, open quotes (QuoteRequest requested/quoted), booked work (won quote → WO
scheduled/in-progress), and open deficiencies are all already computed elsewhere and can
be reused — no new manual data.

**Bottom line:** the build itself is straightforward and low-risk *once the tenancy +
rep-model decisions are made*. Those four/five answers are a 10-minute conversation;
then it's a clean ~3-slice build. I didn't want to guess at tenant isolation while you
were asleep.
