# ServiceCycle — Personnel Security Policy

**Owner:** Engineering / Operations  
**Effective:** 2026-06-25  
**Review cadence:** Annually or when adding a new contributor with production access

---

## Scope

Applies to anyone granted production access: repository write access,
VPS/database credentials, or the ability to deploy to servicecycle.app.

---

## Pre-access requirements

Before granting production-level access to a new contributor or contractor:

1. **Identity verification** — Confirm the individual's legal identity via a government-issued ID (for contractors) or a signed services agreement referencing their legal name.
2. **Reference check** — Obtain at least one professional reference (prior employer, client, or project collaborator) before granting write access to the repository or any production credential.
3. **Scope agreement** — The individual must read and acknowledge `docs/CODE_OF_CONDUCT.md` and `docs/OFFBOARDING.md` before their first commit.
4. **Least-privilege access** — Grant only the minimum permissions required for the stated scope of work. Use role-based access in the application itself (see `server/middleware/roles.ts`).

**Background check waiver (solo-founder context):** As a single-founder company, the founding engineer is the only individual with unrestricted production access. Formal third-party background screening is not performed at this stage. Compensating controls include: full Git audit trail with signed commits, VPS activity logs, hash-chain activity log in the application, and immediate access revocation via SSH key removal.

When the team grows beyond the founding engineer, formal background checks (criminal record, prior employment verification) will be required before granting production access.

---

## Onboarding checklist

- [ ] Identity verified (ID seen or signed contract with legal name)
- [ ] Reference check completed (name and contact logged below)
- [ ] CODE_OF_CONDUCT.md acknowledged (date logged below)
- [ ] OFFBOARDING.md acknowledged
- [ ] GitHub repository access granted with minimum required role
- [ ] SSH key added to VPS with named comment (`ssh-keygen -C "name@email"`) — if applicable
- [ ] Role in the application assigned (only if they need app access)
- [ ] Entry added to the access log below

---

## Offboarding checklist

When a contributor's engagement ends, complete within 24 hours:

- [ ] GitHub organization access removed
- [ ] SSH public key removed from VPS `~/.ssh/authorized_keys`
- [ ] Application account disabled or deleted
- [ ] API keys issued to the contractor revoked in Settings → API Keys
- [ ] Shared secrets rotated per `docs/KEY_ROTATION.md` if the individual had access to `MASTER_KEY` or `JWT_SECRET`
- [ ] Access log entry updated with departure date

See `docs/OFFBOARDING.md` §4 for the complete access removal procedure.

---

## Competency validation

For engineers contributing to security-critical code paths (auth, encryption,
public API, arc-flash data integrity), a senior code review is required before
merge. In a solo-founder context, this means:

- Self-review documented in the PR description referencing `docs/CHANGE_REVIEW_CHECKLIST.md`
- Security-relevant changes are tested with integration tests before deploy
- Major feature sessions are documented in `docs/sessions/` as a durable competency record

---

## Access log

| Name | Role | Start | End | References on file | Notes |
|---|---|---|---|---|---|
| Dustin (founder) | Owner / Engineering | 2024-01-01 | Active | N/A (founder) | Full production access |

---

## Review history

| Date | Reviewer | Changes |
|---|---|---|
| 2026-06-25 | Engineering | Initial policy; solo-founder compensating controls documented |
