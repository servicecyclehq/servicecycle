# ServiceCycle Telemetry Ingestion (Phase 4 #8)

Continuous condition-monitoring for electrical assets. Edge gateways and
condition-monitoring platforms push periodic readings (winding/bushing
temperature, vibration RMS, partial discharge, online DGA, load) into the v1
public API. Each reading is graded against per-channel thresholds; a critical
breach raises a notification and escalates the asset to **NFPA 70B:2023
Condition 2** until the notification is addressed (value recovers or a reviewer
acknowledges it).

This is the forward-looking complement to the document-based imports
(`/api/test-reports/import`, DGA, thermography), which capture point-in-time
test results.

## Why HTTP push (and not a broker)

The 2026 OT transport standard for condition monitoring is **OPC-UA for the
information model + MQTT (Sparkplug B) for transport**. ServiceCycle does not
run an MQTT broker in-process; instead it exposes an API-key-scoped HTTP push
surface and expects an **edge gateway** (HiveMQ Edge, Ignition, Litmus,
Node-RED, a Sparkplug host application, or a cloud bridge such as AWS IoT /
Azure IoT Operations) to subscribe to the broker and forward batched readings
over HTTPS. This keeps the deployment a single stateless container, matches the
rest of the v1 API (keys, scopes, idempotency), and lets each site choose its
own broker.

```
PLCs / sensors --OPC-UA--> Edge gateway --MQTT/Sparkplug B--> Broker
                                  |
                                  +--HTTPS batch--> POST /api/v1/telemetry/readings
```

## Authentication

All endpoints use an API key: `Authorization: Bearer <key>`. Reads accept any
valid key; writes require the `write` scope (mint one in Settings -> API Keys).
Reuses the same per-key rate limit (60/min) and `Idempotency-Key` support as the
rest of v1.

## Endpoints

### Configure a channel (write)

`POST /api/v1/telemetry/channels`

Creates or updates a monitored channel by `(assetId, key)`. Thresholds are
optional and come in HIGH and LOW pairs, so the same channel handles
"higher is worse" (temperature, vibration, PD) and "lower is worse" (insulation
resistance, oil level). Send `null` for a threshold to clear it.

```json
{
  "assetId": "1f...uuid",
  "key": "winding_temp",
  "label": "Winding Temperature",
  "unit": "C",
  "warnHigh": 75,
  "critHigh": 90
}
```

Channels are also auto-created on first reading (with no thresholds, so readings
record as `OK` until you set bands).

### Ingest readings (write, idempotent)

`POST /api/v1/telemetry/readings` -- up to 1000 readings per batch.

```json
{
  "readings": [
    { "assetId": "1f...uuid", "channel": "winding_temp", "value": 95.2,
      "unit": "C", "recordedAt": "2026-06-20T14:00:00Z",
      "source": "edge-gateway-01", "externalId": "gw01-9931" }
  ]
}
```

- `recordedAt` defaults to now if omitted.
- `externalId` (optional) dedups at-least-once gateway delivery: a repeated
  `(channel, externalId)` is recognized and not stored twice.
- Pass `Idempotency-Key: <opaque>` to make a whole-batch retry safe.

Response summarizes per-reading grading:

```json
{ "success": true, "data": {
  "accepted": 1, "breaches": 1, "duplicates": 0, "total": 1,
  "results": [ { "assetId": "1f...", "channel": "winding_temp",
                 "accepted": true, "status": "CRIT", "duplicate": false,
                 "notificationOpened": true, "governingCondition": "C2" } ] } }
```

Readings for an asset the key's account does not own come back
`{ "accepted": false, "error": "asset_not_found" }` (the rest of the batch still
processes).

### Read time-series

`GET /api/v1/telemetry/readings?assetId=&channel=&since=&page=&limit=`
(paginated, newest first).

### Channels / notifications

`GET /api/v1/telemetry/channels?assetId=`

`GET /api/v1/telemetry/notifications?status=open|all&assetId=`

`POST /api/v1/telemetry/notifications/{id}/acknowledge` (write) -- manually
addresses a notification; when no open CRIT notification remains on the asset,
the Condition-2 escalation clears and the human governing condition is restored.

## The NFPA 70B condition loop

- Grading: `value >= critHigh` (or `<= critLow`) -> `CRIT`; `>= warnHigh`
  (or `<= warnLow`) -> `WARN`; otherwise `OK`. The worst band wins.
- An upward transition (OK->WARN, OK->CRIT, WARN->CRIT) opens a notification.
- An **open CRIT** notification is the standard's "unaddressed continuous-
  monitoring notification": it sets `asset.autoConditionMonitoring` and folds a
  **C2** driver into `governingCondition` (worst-of with the human axes and the
  missed-cycle C3 flag), tightening non-overridden maintenance intervals.
- A return-to-OK reading auto-resolves the channel's open notifications; a
  manual acknowledge does the same. When the last open CRIT clears, the asset
  drops back to its human-assessed condition. Every transition writes a cited
  `condition_changed` activity-log entry (`standardRef: NFPA 70B:2023`).

## Sparkplug B field mapping (reference)

| Sparkplug | ServiceCycle reading field |
|-----------|----------------------------|
| `groupId` / `edgeNodeId` / `deviceId` | resolve to your `assetId` in the gateway |
| metric name | `channel` (e.g. `winding_temp`) |
| metric value | `value` |
| metric timestamp | `recordedAt` |
| metric alias / seq | `externalId` (for dedup) |
| Sparkplug engineering unit | `unit` |

Map each device's metrics to a ServiceCycle `assetId` + `channel` in the gateway,
buffer on disconnect, and POST batched on reconnect with `Idempotency-Key`.
