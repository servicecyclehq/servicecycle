# servicecycle-sdk (Python)

Official Python SDK for the ServiceCycle Public API. Mirrors the
[TypeScript SDK](../README.md) 1:1 in behavior (same auth, same retry
behavior, same error taxonomy, same idempotency support) so the two clients
are interchangeable in documentation and support conversations.

## Install

```bash
pip install servicecycle-sdk
```

Or, until this is published to PyPI, install directly from the repo:

```bash
pip install ./sdk/python
```

Requires Python 3.9+. **Zero external dependencies** — uses only the
standard library (`urllib`), matching the TypeScript SDK's "no runtime
dependencies" design (it uses Node's built-in `fetch`).

## Quick start

```python
from servicecycle import ServiceCycleClient

client = ServiceCycleClient(api_key="sc_your_key_here")

# Verify your key
identity = client.identity.me()
print(identity["accountId"])

# List assets with upcoming maintenance due in the next 30 days
from datetime import date, timedelta
due_before = (date.today() + timedelta(days=30)).isoformat()
result = client.assets.list(due_before=due_before, limit=100)
for asset in result["data"]:
    print(asset["id"], asset["equipmentType"])
```

## Authentication

API keys start with `sc_` and are issued in **Settings → API Keys**. Every
key carries a scope:

- `read` — list and retrieve resources (default)
- `write` — create and mutate resources (required for `work_orders.create`,
  `telemetry.ingest_readings`, etc.)

Pass the key to the constructor — the SDK attaches it as
`Authorization: Bearer <api_key>` on every request.

```python
import os
from servicecycle import ServiceCycleClient

client = ServiceCycleClient(api_key=os.environ["SC_API_KEY"])
```

## Pagination

Every collection method (`list`) returns `{"data": [...], "pagination": {...}}`.
Kwargs are Pythonic `snake_case` — the client translates them to the
camelCase query params the API expects (e.g. `site_id` -> `siteId`).

**Manual pagination:**

```python
page = 1
while True:
    result = client.assets.list(page=page, limit=100)
    for asset in result["data"]:
        process(asset)
    if page >= result["pagination"]["pages"]:
        break
    page += 1
```

**Auto-paginating generator** — `list_all()` fetches subsequent pages lazily:

```python
for asset in client.assets.list_all(limit=100):
    process(asset)
```

`list_all()` is available on `assets`, `work_orders`, `deficiencies`,
`contractors`, `arc_flash.list_all_labels()`, and
`telemetry.list_all_readings()`.

## Rate limiting

The API allows **60 requests/minute per key** (and 300/minute per IP). The
SDK automatically retries HTTP 429 responses after the delay in the
`Retry-After` header (60s if absent), up to `max_retries` attempts (default
3), sleeping synchronously between attempts.

```python
# Disable automatic retries
client = ServiceCycleClient(api_key=api_key, max_retries=0)

# Bigger retry budget for a long-running batch job
client = ServiceCycleClient(api_key=api_key, max_retries=10)
```

## Error handling

Every error raised for a non-2xx response is a `ServiceCycleError` subclass:

```python
from servicecycle import (
    ServiceCycleClient,
    AuthenticationError,
    AuthorizationError,
    NotFoundError,
    RateLimitError,
    ValidationError,
    ServiceCycleError,
)

client = ServiceCycleClient(api_key="sc_...")

try:
    wo = client.work_orders.create(asset_id="bad-id")
except AuthenticationError:
    print("Check your API key")  # 401
except AuthorizationError:
    print("Key lacks write scope")  # 403
except NotFoundError as e:
    print("Resource not found:", e.message)  # 404
except ValidationError as e:
    print("Bad request:", e.message)  # 400
except RateLimitError as e:
    print("Rate limit exhausted, retry after:", e.retry_after_ms, "ms")  # 429, retries exhausted
except ServiceCycleError as e:
    print(f"API error {e.status_code}:", e.message)  # any other non-2xx
```

## Idempotency

Methods that create resources accept an optional `idempotency_key` string.
Pass the same key when retrying a request that may have already succeeded
(e.g. the first attempt timed out before you got a response) so the server
only creates the resource once.

```python
# Safe to retry -- server deduplicates on the key
wo = client.work_orders.create(
    asset_id="asset-uuid",
    status="COMPLETE",
    completed_date="2026-06-25",
    idempotency_key="wo-create-asset-uuid-2026-06-25",
)

# Batch telemetry ingest -- use a stable key tied to the batch identity
client.telemetry.ingest_readings(
    readings,
    idempotency_key="batch-gateway-01-2026-06-25T14:00:00Z",
)
```

Recommended for `work_orders.create()` and `telemetry.ingest_readings()` in
unreliable network environments (e.g. an edge gateway on a cellular link).

## Resources

### Identity

```python
identity = client.identity.me()
# {keyId, keyName, scopes, accountId, companyName}
```

### Assets

```python
result = client.assets.list(limit=50)
critical = client.assets.list(governing_condition="C3", site_id="site-uuid")

for asset in client.assets.list_all():
    print(asset["id"], asset["equipmentType"], asset["governingCondition"])

detail = client.assets.get("asset-uuid")
print(detail["schedules"][0]["nextDueDate"])
print(detail["nameplateData"])
```

### Work Orders

```python
in_progress = client.work_orders.list(status="IN_PROGRESS")

wo = client.work_orders.create(
    asset_id="asset-uuid",
    schedule_id="schedule-uuid",
    status="COMPLETE",
    completed_date="2026-06-25",
    as_left_condition="C1",
    neta_decal="GREEN",
    idempotency_key="my-idempotency-key",
)

detail = client.work_orders.get(wo["id"])
```

### Deficiencies

```python
open_critical = client.deficiencies.list(status="OPEN", severity="IMMEDIATE")

for d in client.deficiencies.list_all(status="OPEN"):
    print(d["severity"], d["description"])
```

### Contractors

```python
contractors = client.contractors.list()
c = client.contractors.get("contractor-uuid")
```

### Arc Flash

```python
danger_labels = client.arc_flash.list_labels(severity="danger")

for label in client.arc_flash.list_all_labels(site_id="site-uuid"):
    print(label["busName"], label["ppeCategory"], label["incidentEnergyCalCm2"])

# ALWAYS pre-check before issuing energized work
precheck = client.arc_flash.work_order_precheck("asset-uuid")
if not precheck["canIssue"]:
    raise RuntimeError(f"Cannot issue work order: {precheck['reasons']}")
print(f"PPE Category {precheck['hazard']['ppeCategory']}")

one_line = client.arc_flash.get_one_line("site-uuid")
# one_line["svg"] -- embeddable SVG string
# one_line["nodes"] / one_line["edges"] -- graph data for custom rendering
```

### Telemetry

```python
channels = client.telemetry.list_channels(asset_id="asset-uuid")

client.telemetry.upsert_channel(
    asset_id="asset-uuid", key="winding_temp", label="Winding Temperature",
    unit="C", warn_high=85, crit_high=100,
)

# CRIT breaches automatically escalate the asset's governing condition to C2
result = client.telemetry.ingest_readings(
    [
        {"asset_id": "asset-uuid", "channel": "winding_temp", "value": 82.3, "unit": "C", "source": "gateway-01"},
        {"asset_id": "asset-uuid", "channel": "oil_level", "value": 91.5, "unit": "%", "source": "gateway-01"},
    ],
    idempotency_key="batch-2026-06-25-001",
)
print(f"{result['accepted']} accepted, {result['breaches']} breaches")

readings = client.telemetry.list_readings(asset_id="asset-uuid", channel="winding_temp", since="2026-06-01T00:00:00Z")

notifications = client.telemetry.list_notifications(status="open")
for n in notifications["data"]:
    if n["status"] == "CRIT":
        print(f"CRIT on channel {n['channelId']}: {n['value']} (threshold {n['threshold']})")
        client.telemetry.acknowledge_notification(n["id"])
```

## NFPA 70B condition ratings

ServiceCycle uses the NFPA 70B three-tier condition rating system on every asset:

| Rating | Meaning |
|--------|---------|
| `C1` | Good condition — operating within acceptable parameters |
| `C2` | Moderate deterioration — schedule maintenance |
| `C3` | Severe deterioration — prioritize immediate maintenance or replacement |

Each asset tracks three independent ratings — `conditionPhysical`,
`conditionCriticality`, `conditionEnvironment` — plus `governingCondition`,
the worst (highest severity) of the three and the primary field to act on. A
CRIT telemetry breach auto-escalates the governing condition to at least
`C2`.

## Known API response-shape quirks (handled by this client, documented for
transparency)

Most endpoints return `{"success": true, "data": ..., "pagination"?: {...}}`.
Two do not, and this client returns their bare shape rather than forcing a
fake envelope on you:

- `arc_flash.work_order_precheck()` returns
  `{assetId, canIssue, reasons, hazard, study, disclaimer}` directly.
- `arc_flash.create_device()` returns the created device object directly
  (no wrapping `data` key beyond what `.post()` already unwraps).
- `telemetry.list_notifications()` returns `{"data": [...], "count": N}` with
  no `pagination` object — the endpoint is hard-capped at 200 results
  server-side rather than paginated.

## Examples

See `examples/` for a runnable script (`basic_usage.py`) and a Jupyter
notebook (`quickstart.ipynb`) covering the same flows interactively.
