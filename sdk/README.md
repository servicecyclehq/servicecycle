# servicecycle-sdk

Official TypeScript/JavaScript SDK for the ServiceCycle Public API.

## Install

```bash
npm install servicecycle-sdk
```

Requires Node.js 20+. No external runtime dependencies — uses Node's built-in `fetch`.

## Quick start

```typescript
import { ServiceCycleClient } from 'servicecycle-sdk';

const client = new ServiceCycleClient({ apiKey: 'sc_your_key_here' });

// Verify your key
const identity = await client.identity.me();
console.log(identity.accountId);

// List assets with upcoming maintenance due in the next 30 days
const due = new Date();
due.setDate(due.getDate() + 30);
const { data: assets } = await client.assets.list({
  dueBefore: due.toISOString().split('T')[0],
  limit: 100,
});
```

## Authentication

API keys start with `sc_` and are issued in **Settings → API Keys**. Every key carries a scope:

- `read` — list and retrieve resources (default)
- `write` — create and mutate resources (required for `workOrders.create`, `telemetry.ingestReadings`, etc.)

Pass the key to the constructor — that's it. The SDK attaches it as `Authorization: Bearer <apiKey>` on every request.

```typescript
const client = new ServiceCycleClient({ apiKey: process.env.SC_API_KEY! });
```

## Pagination

Every collection endpoint supports two patterns.

**Manual pagination** — `list()` returns `{ data, pagination }`:

```typescript
let page = 1;
while (true) {
  const { data, pagination } = await client.assets.list({ page, limit: 100 });
  for (const asset of data) {
    process(asset);
  }
  if (page >= pagination.pages) break;
  page++;
}
```

**Auto-paginating iterator** — `listAll()` fetches pages automatically:

```typescript
for await (const asset of client.assets.listAll({ limit: 100 })) {
  process(asset);
}
```

`listAll()` is available on `assets`, `workOrders`, `deficiencies`, `contractors`, `arcFlash.listAllLabels()`, and `telemetry.listAllReadings()`.

## Rate limiting

The API allows **60 requests per minute** per key. The SDK automatically retries `429` responses after the delay specified in the `Retry-After` header (default 60 seconds if the header is absent), up to `maxRetries` attempts (default: 3).

To disable automatic retries:

```typescript
const client = new ServiceCycleClient({ apiKey, maxRetries: 0 });
```

To increase the retry budget for long-running batch jobs:

```typescript
const client = new ServiceCycleClient({ apiKey, maxRetries: 10 });
```

## Error handling

All errors extend `ServiceCycleError`. Use `instanceof` to branch on specific conditions:

```typescript
import {
  ServiceCycleClient,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  ServiceCycleError,
} from 'servicecycle-sdk';

try {
  const wo = await client.workOrders.create({ assetId: 'bad-id' });
} catch (err) {
  if (err instanceof AuthenticationError) {
    // 401 — API key is invalid or has been revoked
    console.error('Check your API key');
  } else if (err instanceof AuthorizationError) {
    // 403 — key exists but lacks the required scope (e.g., write scope needed)
    console.error('Key lacks write scope');
  } else if (err instanceof NotFoundError) {
    // 404 — asset, work order, etc. does not exist
    console.error('Resource not found:', err.message);
  } else if (err instanceof ValidationError) {
    // 400 — request body failed server-side validation
    console.error('Bad request:', err.message);
  } else if (err instanceof RateLimitError) {
    // 429 — retries exhausted (only thrown after maxRetries attempts)
    console.error('Rate limit exhausted, retry after:', err.retryAfterMs, 'ms');
  } else if (err instanceof ServiceCycleError) {
    // Any other non-2xx response
    console.error(`API error ${err.statusCode}:`, err.message);
  } else {
    throw err; // network error, timeout, etc.
  }
}
```

## Idempotency

Methods that create resources accept an optional `idempotencyKey` string as their last argument. Pass the same key when retrying a failed request to guarantee the server only creates the resource once, even if your first request timed out before you received a response.

```typescript
// Safe to retry — server deduplicates on the key
const wo = await client.workOrders.create(
  { assetId: 'asset-uuid', status: 'COMPLETE', completedDate: '2026-06-25' },
  'wo-create-asset-uuid-2026-06-25'   // idempotencyKey
);

// Batch telemetry ingest — use a stable key tied to the batch identity
await client.telemetry.ingestReadings(readings, 'batch-gateway-01-2026-06-25T14:00:00Z');
```

Recommended for `workOrders.create()` and `telemetry.ingestReadings()` in unreliable network environments.

## Resources

### Identity

```typescript
const identity = await client.identity.me();
// { keyId, keyName, scopes, accountId, companyName }
```

Use this as a credential health check — it validates the key and returns the scopes it carries.

### Assets

```typescript
// List page 1
const { data, pagination } = await client.assets.list({ limit: 50 });

// Filter by site, condition, or upcoming due date
const { data: critical } = await client.assets.list({
  governingCondition: 'C3',
  siteId: 'site-uuid',
});

// Iterate all assets without managing pages
for await (const asset of client.assets.listAll()) {
  console.log(asset.id, asset.equipmentType, asset.governingCondition);
}

// Get one asset with full detail including maintenance schedules
const detail = await client.assets.get('asset-uuid');
console.log(detail.schedules[0].nextDueDate);
console.log(detail.nameplateData);
```

### Work Orders

```typescript
// List in-progress work orders
const { data } = await client.workOrders.list({ status: 'IN_PROGRESS' });

// Close a work order (write scope required)
const wo = await client.workOrders.create(
  {
    assetId: 'asset-uuid',
    scheduleId: 'schedule-uuid',
    status: 'COMPLETE',
    completedDate: '2026-06-25',
    asLeftCondition: 'C1',
    netaDecal: 'GREEN',
  },
  'my-idempotency-key'
);

// Retrieve a single work order
const detail = await client.workOrders.get(wo.id);
```

### Deficiencies

```typescript
// All open critical deficiencies across all assets
const { data } = await client.deficiencies.list({ status: 'OPEN', severity: 'CRITICAL' });

// Deficiencies for a specific asset
const { data: assetDeficiencies } = await client.deficiencies.list({
  assetId: 'asset-uuid',
  status: 'OPEN',
});

// Iterate all open deficiencies
for await (const d of client.deficiencies.listAll({ status: 'OPEN' })) {
  console.log(d.severity, d.description);
}
```

### Contractors

```typescript
// List all NETA-qualified contractors
const { data } = await client.contractors.list();

// Get a specific contractor
const contractor = await client.contractors.get('contractor-uuid');
console.log(contractor.neta70eQualified, contractor.nataLevel);
```

### Arc Flash

```typescript
// All labels with danger severity (expired or high incident energy)
const { data: labels } = await client.arcFlash.listLabels({ severity: 'danger' });

// Iterate all labels for a site
for await (const label of client.arcFlash.listAllLabels({ siteId: 'site-uuid' })) {
  console.log(label.busName, label.ppeCategory, label.incidentEnergyCalCm2);
}

// Pre-check before issuing energized work — ALWAYS do this before creating a work order
// on an energized asset (isEnergized: true)
const precheck = await client.arcFlash.workOrderPrecheck('asset-uuid');
if (!precheck.canIssue) {
  throw new Error(`Cannot issue work order: ${precheck.reason}`);
}
// precheck.label has PPE category, incident energy, arc-flash boundary, working distance
console.log(`PPE Category ${precheck.label?.ppeCategory}, ${precheck.label?.incidentEnergyCalCm2} cal/cm²`);

// Get the one-line diagram for a site
const oneLine = await client.arcFlash.getOneLine('site-uuid');
// oneLine.svg — embeddable SVG string
// oneLine.nodes / oneLine.edges — graph data for custom rendering
```

### Telemetry

```typescript
// List all channels for an asset
const channels = await client.telemetry.listChannels({ assetId: 'asset-uuid' });

// Create or update a channel (write scope required)
await client.telemetry.upsertChannel({
  assetId: 'asset-uuid',
  key: 'winding_temp',
  label: 'Winding Temperature',
  unit: 'C',
  warnHigh: 85,
  critHigh: 100,
});

// Push readings from an edge gateway (write scope required)
// CRIT breaches automatically escalate the asset's governing condition to C2
const result = await client.telemetry.ingestReadings(
  [
    { assetId: 'asset-uuid', channel: 'winding_temp', value: 82.3, unit: 'C', source: 'gateway-01' },
    { assetId: 'asset-uuid', channel: 'oil_level', value: 91.5, unit: '%', source: 'gateway-01' },
  ],
  'batch-2026-06-25-001'  // idempotency key
);
console.log(`${result.accepted} accepted, ${result.breaches} breaches`);

// Query historical readings
const { data: readings } = await client.telemetry.listReadings({
  assetId: 'asset-uuid',
  channel: 'winding_temp',
  since: '2026-06-01T00:00:00Z',
});

// Check for and acknowledge open CRIT alerts
const { data: notifications } = await client.telemetry.listNotifications({ status: 'open' });
for (const n of notifications.filter((n) => n.status === 'CRIT')) {
  console.log(`CRIT on channel ${n.channelId}: ${n.value} (threshold ${n.threshold})`);
  await client.telemetry.acknowledgeNotification(n.id);
}
```

## NFPA 70B condition ratings

ServiceCycle uses the NFPA 70B three-tier condition rating system on every asset:

| Rating | Meaning |
|--------|---------|
| `C1` | Good condition — asset is operating within acceptable parameters |
| `C2` | Moderate deterioration — requires attention; schedule maintenance |
| `C3` | Severe deterioration — prioritize for immediate maintenance or replacement |

Each asset tracks three independent ratings: `conditionPhysical`, `conditionCriticality`, and `conditionEnvironment`. The `governingCondition` field is the worst (highest severity) of the three and is the primary field to act on. A CRIT telemetry breach automatically escalates the governing condition to at least `C2`.

## TypeScript

The SDK is written in TypeScript and ships `.d.ts` declaration files alongside the compiled JavaScript. No `@types/servicecycle-sdk` package is needed. All types and interfaces are exported from the main entry point:

```typescript
import type {
  Asset,
  AssetDetail,
  WorkOrder,
  Deficiency,
  ArcFlashLabel,
  TelemetryChannel,
  TelemetryReading,
  ConditionRating,
  WorkOrderStatus,
  PaginatedResponse,
  SingleResponse,
} from 'servicecycle-sdk';
```
