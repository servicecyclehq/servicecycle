# ServiceCycle Public API — Changelog

All notable changes to the `/api/v1` public REST API are documented here.
Breaking changes are flagged with ⚠️.

---

## v1.4.0 — 2026-06-25

### Added
- **Audit logging for all API calls.** Every authenticated `/api/v1` request is
  now written to the tamper-evident activity log (`action = api_v1_call`) with
  method, path, HTTP status, latency, key name/ID, and client IP. Supports
  SOC 2 CC6.8 logical access monitoring.

---

## v1.3.0 — 2026-06-24

### Added
- **Parts & Spare Inventory** (`GET /api/export/account`) now includes three
  new resource types in the portable account snapshot:
  - `parts` — Part catalog (name, part number, manufacturer, unit cost)
  - `spareInventory` — Site-level stock levels and minimum thresholds
  - `assetPartRequirements` — Required-parts mapping per asset

---

## v1.2.0 — 2026-06-20

### Added
- **Arc Flash resources** (`GET /api/v1/arc-flash/*`):
  - `GET /api/v1/arc-flash/labels` — list label-ready devices (paginated)
  - `GET /api/v1/arc-flash/one-line` — one-line diagram summary
  - `GET /api/v1/arc-flash/precheck` — incident-energy precheck for a device
  - `POST /api/v1/arc-flash/devices` — create arc flash device record (write scope)
- **Telemetry resources** (`GET|POST /api/v1/telemetry/*`):
  - `GET /api/v1/telemetry/channels` — list monitoring channels
  - `POST /api/v1/telemetry/channels` — create/upsert channel
  - `GET /api/v1/telemetry/channels/:id/readings` — paginated readings
  - `POST /api/v1/telemetry/readings` — batch ingest readings (≤1000/call)
  - `GET /api/v1/telemetry/notifications` — list threshold breach events
  - `POST /api/v1/telemetry/notifications` — create/clear notification

---

## v1.1.0 — 2026-06-11

### Added
- **Work Orders write endpoint** (`POST /api/v1/work-orders`):
  - Creates a work order on any asset owned by the API key's account.
  - When `status=COMPLETE` and a `scheduleId` is supplied, the originating
    NFPA 70B maintenance schedule is automatically rolled forward — closing
    the CMMS loop without a second call.
  - Requires the `write` scope.
  - Supports `Idempotency-Key` header for safe retries.
- **API key scopes** (`read` | `write`) enforced per endpoint.
- **Idempotency layer** (`lib/apiIdempotency`): replayed requests return the
  original response verbatim with an `Idempotent-Replay: true` header.

### Changed
- API key prefix changed from `sc_` to `liq_` in all generated keys and
  documentation. Keys previously created under either prefix remain valid —
  the auth layer validates by SHA-256 hash, not prefix.

---

## v1.0.0 — 2026-05-15

### Added (initial release)
- **Assets** — `GET /api/v1/assets`, `GET /api/v1/assets/:id`
- **Contractors** — `GET /api/v1/contractors`, `GET /api/v1/contractors/:id`
- **Work Orders (read)** — `GET /api/v1/work-orders`, `GET /api/v1/work-orders/:id`
- **Deficiencies** — `GET /api/v1/deficiencies`, `GET /api/v1/deficiencies/:id`
- Authentication: `Authorization: Bearer liq_<key>` header.
- Rate limiting: 60 requests/minute per API key.
- Pagination: `page` + `limit` (max 100) on all list endpoints; response
  includes `pagination.{ page, limit, total, pages }`.
- OpenAPI 3.1 spec served at `/docs/api` (Swagger UI) and
  `/api/v1/openapi.yaml` (raw YAML).

---

## Versioning policy

The ServiceCycle API follows a **non-breaking additive** policy within v1:

- New endpoints and new optional response fields are added without a version bump.
- Removing fields, changing field types, or altering existing semantics is a
  **breaking change** and will be released as v2, with v1 maintained for a
  minimum of 12 months.
- Deprecations are announced in this changelog at least 90 days before removal.

For integration guidance, see [INTEGRATIONS.md](./INTEGRATIONS.md).
