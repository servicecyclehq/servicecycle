# Role-on-assignment — scoping note (not implemented tonight)

Written 2026-07-08 overnight session. Re-verified against live code and found the two most
detailed source docs on this backlog item — `docs/PRODUCT_BETS_2026-07-03.md` (#10) and
`docs/ENGINEERING_HANDOFF.md` ("What's intentionally NOT built") — which agree with each
other and are more precise than the terse `servicecycle-ux-cluster-shipped` memory note that
originally flagged this ("role-on-assignment table"). No third source exists; this doc is
the fullest spec available.

## What it actually is (confirmed, not guessed)

> "Role-on-assignment — auto-apply a role change when a user is assigned to a work order.
> The WO assignment UI is live; the role side-effect is deferred." — ENGINEERING_HANDOFF.md

> "Contractors will not roll SC out to 30 technicians if assignment doesn't drive visibility
> and a push/email nudge. The field_tech default-deny scaffolding is shipped; this is the
> last mile that makes techs daily actives." — PRODUCT_BETS_2026-07-03.md #10

Concretely: when `WorkOrder.assignedUserId` is set to a user, that user's global `User.role`
should automatically become `field_tech` (if it isn't already) — which is what activates the
already-shipped clamped "your world = your assigned work orders" scope in
`lib/fieldScope.ts` / `routes/fieldRoutes.ts` (confirmed live and working tonight while
scoping this). Bundled with it: a push/email notification telling the newly-assigned tech
they have work. Both pieces are marked deferred; neither is built.

## Why this wasn't implemented tonight (real risk, not just caution)

**The dangerous edge case:** `assignedUserId` can be set to ANY user, not just techs — an
admin or manager could plausibly be tagged on a WorkOrder for visibility/oversight. A naive
"set role = field_tech whenever assignedUserId is set" would **silently downgrade an admin or
manager's own role**, which clamps their account-wide access down to just that one work
order — a real, harmful access regression, potentially locking someone out of their own
admin functions. This is not a hypothetical; nothing in the current schema or route code
prevents an admin from being the `assignedUserId` on a WO today.

There's no existing signal in the schema for "this WO assignment is meant to import someone
into the field_tech role" vs. "this is just a visibility tag on an existing privileged user."
Guessing at that distinction and shipping it wrong is worse than not shipping it — same
reasoning this session applied to BYO storage's OneDrive question and the EDMS deferrals.

**The notification half is a separate, bigger open question:** channel (email? SMS? in-app?
push requires a mobile app context this product may not have), copy/tone, whether it's
opt-out-able, and how it interacts with the existing digest/alert email infrastructure
(`lib/customerDigest.ts`, the configurable alert system) are all real product decisions with
no existing precedent to follow mechanically.

## Recommended design (for whenever this gets built)

1. **Only auto-apply the role change when it's safe.** The clearest safe rule: apply it only
   when the assignee's current role is `null`/unset (a freshly-invited user who hasn't logged
   in yet, or a placeholder created specifically to receive this WO) — never when the
   assignee already holds `admin`, `manager`, `oem_admin`, `group_admin`, or any role other
   than an unset/default one. If a real product need exists to convert an *existing*
   non-privileged user, gate it behind an explicit admin confirmation step in the assignment
   UI ("this will change {user}'s role to Field Tech — continue?"), never silently.
2. **Ship the role-side-effect and the notification as two separable pieces**, not one
   all-or-nothing feature — the role change alone is the smaller, more mechanical half and
   could ship first; notifications need Dustin's input on channel before any code is written.
3. Land it as a single well-tested function (e.g. `lib/workOrderAssignment.ts`'s
   `applyRoleOnAssignment(userId, currentRole)` → returns whether to update, never mutates
   silently) called from wherever `WorkOrder.assignedUserId` is set today — grep
   `assignedUserId.*=` across `routes/` before implementing to find every write path (likely
   more than one: WO creation, WO edit, and possibly a bulk-assign endpoint).

## Not done tonight

No code changes for this item. Captured here so a future session (or Dustin, if he wants to
just answer "should this ever downgrade an existing user, yes or no") can move straight to
implementation without re-deriving the edge case.
