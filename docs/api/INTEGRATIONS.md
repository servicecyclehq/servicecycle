# CMMS / CRM Integration Guide

ServiceCycle exposes a documented, versioned, bi-directional REST API (`/api/v1`)
plus outbound webhooks. This guide maps that surface to two common targets --
**MaintainX** (CMMS) and **Salesforce** (CRM) -- and describes the closed loop:
a ServiceCycle signal becomes work in the external system, and completed work
flows back to advance the NFPA 70B schedule.

## The API in brief

- **Base URL:** `https://<host>/api/v1`
- **Auth:** `Authorization: Bearer <api-key>`. Mint keys in Settings -> API Keys.
  Keys carry **scopes**: `read` (always) and `write` (must be granted). Reads work
  with any valid key; write endpoints require a `write`-scoped key.
- **Versioning:** URL path (`/api/v1`). Every response carries `API-Version: 1`.
- **Pagination:** `?page=&limit=` (max 100); responses include a `pagination` block.
- **Rate limits:** 60 req/min per key (HTTP 429 with standard headers on excess).
- **Idempotency (writes):** send `Idempotency-Key: <opaque>`; a retried POST with
  the same key replays the original response (`Idempotent-Replay: true`) and never
  double-creates.
- **Spec:** machine-readable OpenAPI 3.1 at `/api/openapi.yaml` + Swagger UI at `/api/docs`.

### Resources

| Resource | Read | Write |
| --- | --- | --- |
| `GET /assets`, `/assets/{id}` | yes | -- |
| `GET /contractors` | yes | -- |
| `GET /work-orders`, `/work-orders/{id}` | yes | -- |
| `POST /work-orders` (create / complete) | -- | **yes (write scope)** |
| `GET /deficiencies`, `/deficiencies/{id}` | yes | -- |

### The closed loop

1. **Pull due work:** `GET /assets?dueBefore=YYYY-MM-DD` returns assets with a
   maintenance task coming due (the asset detail includes its active schedules
   with `scheduleId`, `taskName`, `nextDueDate`).
2. **Create work in the CMMS/CRM** from those rows.
3. **Write the completion back:** when the external system marks the job done,
   `POST /work-orders` with `{ assetId, scheduleId, status: "COMPLETE", completedDate }`.
   ServiceCycle records the work order and rolls the schedule's `nextDueDate`
   forward -- the compliance gap closes automatically.
4. (Optional) Subscribe to outbound **webhooks** (Settings -> Webhooks) for
   `maintenance.due` / `maintenance.overdue` events to push step 1 in real time
   instead of polling.

---

## MaintainX (CMMS)

MaintainX exposes a bearer-token REST API (`https://api.getmaintainx.com/v1`) for
work orders, assets, and PM schedules, and emits an event when a work order is
completed.

**Suggested mapping**

| ServiceCycle | MaintainX |
| --- | --- |
| Asset (`id`, `equipmentType`, `serialNumber`, site) | Asset |
| Active schedule due (`scheduleId`, `taskName`, `nextDueDate`) | Work Order (PM) |
| `POST /work-orders` completion | "work order completed" webhook -> our write-back |

**Flow**

1. Nightly (or on our `maintenance.due` webhook), call
   `GET /api/v1/assets?dueBefore=<today+leadTime>`; for each returned asset create
   a MaintainX work order, storing our `assetId` + `scheduleId` in a MaintainX
   custom field so the round-trip can be correlated.
2. Subscribe to MaintainX's work-order-completed event. On completion, read back
   the stored `assetId`/`scheduleId` and call our
   `POST /api/v1/work-orders` (write-scoped key, `Idempotency-Key` = the MaintainX
   work-order id) with `status: COMPLETE` and the completion date.

This keeps MaintainX as the technician's system of record while ServiceCycle stays
the authoritative NFPA 70B compliance timeline.

---

## Salesforce (CRM)

Salesforce exposes a REST API (`/services/data/vXX.0/`) with OAuth2; model
ServiceCycle assets/work as custom objects (e.g. `SC_Asset__c`, `SC_WorkOrder__c`)
or map to Work Orders if Field Service is enabled.

**Suggested mapping**

| ServiceCycle | Salesforce |
| --- | --- |
| Asset | `Asset` (standard) or `SC_Asset__c` |
| Due schedule | `WorkOrder` / Task / opportunity trigger |
| Open deficiency (`GET /deficiencies?status=open`) | Case / follow-up Task |
| `POST /work-orders` completion | Apex callout when the WorkOrder is closed |

**Flow**

1. A scheduled Apex job (or platform event from our `maintenance.due` webhook)
   pulls `GET /api/v1/assets?dueBefore=` and upserts the corresponding records,
   keyed by our `assetId`.
2. Pull `GET /api/v1/deficiencies?status=open` to raise Cases for unresolved
   findings -- useful for an account/CSM "risk" view in the CRM.
3. When a Salesforce WorkOrder/Task is closed, an Apex callout posts back to
   `POST /api/v1/work-orders` (write-scoped key + `Idempotency-Key` = the
   Salesforce record id) to advance the schedule here.

---

## Notes

- Use **separate keys per integration** with the least scope needed (read-only for
  a pure CRM mirror; write only where completions flow back), and rotate via
  Settings -> API Keys (revocation is immediate).
- All endpoints are strictly account-scoped to the key's account.
- The write-back is the only mutation the public API performs today; assets,
  deficiencies, sites, and schedules are managed in ServiceCycle and surfaced
  read-only here. More write endpoints will land in later `/api/v1` increments
  (the version contract will not break within v1).
