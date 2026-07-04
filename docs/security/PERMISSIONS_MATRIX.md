# Permissions Matrix

**Purpose:** flat lookup table — role × feature — for every capability in ServiceCycle. Auditors and enterprise reviewers ask "who can do X?" and want a table, not prose. Complements `server/middleware/roles.ts` (the authoritative implementation).

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin
**Source of truth:** `server/middleware/roles.ts` (implementation). This doc is a synchronized view. On any role change, update both in the same commit.
**Review cadence:** on any role change; quarterly regardless.

---

## Roles

| Role | Intended user | Cross-account? | Notes |
|---|---|---|---|
| `viewer` | Read-only stakeholder, auditor guest | No | Cannot write anything |
| `consultant` | External advisor with read access | No | Cannot write; can export |
| `field_tech` | Technician in the field | No | Writes only for jobs assigned to them |
| `group_admin` | Manager of a group of sites | No | Writes across their group only |
| `oem_admin` | OEM viewing installed base | No | Reads across their installed base; limited writes |
| `manager` | Standard account admin | No | Full read/write within account |
| `admin` | Account administrator | No | Manager + account-settings + user management |
| `super_admin` | ServiceCycle staff | **Yes** | Cross-account; used only by the founder; every action audit-logged |

## Feature × role matrix

Legend: ✅ = allowed, — = denied, 🔒 = allowed with extra guard (see notes).

### Assets & compliance records

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| Read assets in own account | ✅ | ✅ | 🔒 assigned only | ✅ (group scope) | ✅ (installed base) | ✅ | ✅ | ✅ |
| Create asset | — | — | 🔒 assigned scope | ✅ (group scope) | 🔒 limited | ✅ | ✅ | ✅ |
| Edit asset | — | — | 🔒 assigned scope | ✅ (group scope) | 🔒 limited | ✅ | ✅ | ✅ |
| Delete asset | — | — | — | 🔒 with confirmation | — | ✅ | ✅ | ✅ |
| Attach document to asset | — | — | 🔒 assigned scope | ✅ | 🔒 | ✅ | ✅ | ✅ |
| Read documents | ✅ | ✅ | 🔒 assigned | ✅ | ✅ | ✅ | ✅ | ✅ |

### Work orders & deficiencies

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| Read work orders | ✅ | ✅ | 🔒 assigned | ✅ (group) | ✅ (installed base) | ✅ | ✅ | ✅ |
| Create work order from deficiency | — | — | 🔒 assigned | ✅ | — | ✅ | ✅ | ✅ |
| Close work order | — | — | 🔒 assigned | ✅ | — | ✅ | ✅ | ✅ |
| Log deficiency | — | — | 🔒 assigned | ✅ | — | ✅ | ✅ | ✅ |

### Test reports & AI ingest

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| Upload test report | — | — | 🔒 assigned | ✅ | — | ✅ | ✅ | ✅ |
| Trigger AI extraction | — | — | 🔒 assigned | ✅ | — | ✅ | ✅ | ✅ |
| See AI usage panel | — | — | — | 🔒 read own | — | ✅ | ✅ | ✅ |

### Arc-flash

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| View arc-flash study | ✅ | ✅ | 🔒 assigned | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create/edit arc-flash study | — | — | — | ✅ (with QEMW gate) | — | ✅ | ✅ | ✅ |
| Generate label | — | — | 🔒 print-only | ✅ | — | ✅ | ✅ | ✅ |

### Parts & inventory

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| View parts catalog | ✅ | ✅ | ✅ | ✅ | 🔒 own OEM | ✅ | ✅ | ✅ |
| Edit parts catalog | — | — | — | ✅ | — | ✅ | ✅ | ✅ |
| Adjust spare inventory | — | — | 🔒 assigned site | ✅ | — | ✅ | ✅ | ✅ |

### Quote requests (sales)

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| Submit quote request | ✅ | — | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| View quote request status | ✅ | — | 🔒 own | ✅ | — | ✅ | ✅ | ✅ |
| Reassign sales rep | — | — | — | — | — | — | ✅ | ✅ |

### Users & access

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| Invite user | — | — | — | 🔒 group scope | — | — | ✅ | ✅ |
| Deactivate user | — | — | — | 🔒 group scope | — | — | ✅ | ✅ |
| Change user role | — | — | — | 🔒 group scope, no self-elevate | — | — | ✅ (no self-elevate) | ✅ |
| Force password reset | — | — | — | 🔒 group scope | — | — | ✅ | ✅ |
| Enforce MFA on admins | — | — | — | — | — | — | ✅ | ✅ |

### Account settings

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| Read account settings | ✅ | ✅ | 🔒 limited | ✅ | 🔒 limited | ✅ | ✅ | ✅ |
| Change account settings | — | — | — | 🔒 group | — | — | ✅ | ✅ |
| Enable/disable field-level encryption | — | — | — | — | — | — | ✅ (audit-logged CEF sev 7) | ✅ |
| Configure SSO / SCIM | — | — | — | — | — | — | ✅ | ✅ |
| Add / remove BYO AI provider key | — | — | — | — | — | — | ✅ | ✅ |

### Audit & security

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| View activity log | — | — | — | 🔒 group scope | — | ✅ | ✅ | ✅ |
| Export activity log (ndjson/CEF) | — | — | — | — | — | ✅ | ✅ | ✅ |
| View audit-chain verification result | — | — | — | — | — | ✅ | ✅ | ✅ |
| Trigger chain verification | — | — | — | — | — | 🔒 read-only trigger | ✅ | ✅ |
| Cross-account read | — | — | — | — | — | — | — | ✅ (audit-logged) |

### Data subject requests

| Feature | viewer | consultant | field_tech | group_admin | oem_admin | manager | admin | super_admin |
|---|---|---|---|---|---|---|---|---|
| Request account export | — | — | — | — | — | ✅ | ✅ | ✅ |
| Request account deletion | — | — | — | — | — | — | ✅ | ✅ |

## Middleware anchors

Match the matrix to code:

- `authenticateToken` — required on all `/api/*` routes.
- `requireRole('admin', 'super_admin', ...)` — role-list check.
- `requireManager` — shortcut for `manager | admin | super_admin`.
- `requireQuoteWriter` — quote-specific writer roles.
- Field-tech scope — enforced inside route handlers by filtering to the tech's assigned jobs before Prisma query.
- `super_admin` cross-account — enforced by omitting the `accountId` filter, but every such action is written to the tamper-evident activity chain with the invoking user's identity.

## Changes to this matrix

Any PR that adds or removes a role capability MUST update this matrix in the same commit. Change-review checklist (`CHANGE_REVIEW_CHECKLIST.md`) enforces this.

## When a second SC staff member exists

- Grant `super_admin` only when required for a specific customer issue; downgrade to `manager` otherwise.
- Log the grant + downgrade in the activity chain.
- Reflect the grant in `docs/PERSONNEL_SECURITY.md`.
