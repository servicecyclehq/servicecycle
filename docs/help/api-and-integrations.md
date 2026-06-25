# API & Integrations

ServiceCycle is built to fit into a stack, not to be a silo. There's a public REST
API for reading and writing your data programmatically, a telemetry push API for
continuous condition monitoring, outbound webhooks for pushing events to other
systems, and an email-in address for hands-off report ingestion. This module is
aimed at integrators and ops admins.

## Public REST API

The API exposes the core objects — assets, work orders, maintenance schedules —
over versioned `/api/v1` routes. Requests authenticate with an **API key** you
create under Settings; pass it as a bearer token in the `Authorization` header.
Keys are stored hashed (the secret is shown once at creation and never again), can
carry an expiry, and can be revoked. Every key carries the same tenant scoping as
a logged-in user, so a key only ever sees its own account's data.

## OpenAPI spec & docs

The full contract is published as an OpenAPI 3 spec (JSON and YAML) with a bundled
Swagger UI, so integrators can read the endpoints, parameters, and schemas before
they have a key. The spec endpoints are public; the data endpoints behind them are
not.

## Telemetry push API

Edge gateways and condition-monitoring platforms can push real-time readings —
winding temperature, vibration, partial discharge, online DGA, load current —
directly into ServiceCycle using the same API key authentication as the rest of
the v1 API. The typical path is:

```
PLCs / sensors → Edge gateway (HiveMQ, Ignition, Node-RED, etc.)
                     → HTTPS POST /api/v1/telemetry/readings → ServiceCycle
```

Readings are graded against per-channel warn/critical thresholds you configure.
When a reading breaches the critical threshold, ServiceCycle raises a notification
and escalates the asset to **NFPA 70B Condition 2** automatically — the condition
recovers once the reading returns to normal or a reviewer acknowledges it. If the
reading exceeds the C2 load-growth threshold (>10% from baseline), it also flags
the asset for arc-flash re-study review.

For the full channel-configuration and batched-ingestion reference, see
`docs/api/TELEMETRY.md`. API key scopes, idempotency, and the channel
auto-creation-on-first-reading behavior are documented there.

## Outbound webhooks

Register up to a handful of webhook endpoints to receive events — maintenance due,
overdue, escalation, regulatory breach — as they happen. Each delivery is **signed
with HMAC-SHA256**: a signature header lets your receiver verify the payload came
from ServiceCycle using the shared secret (stored encrypted on our side). Targets
must be HTTPS and are validated to keep deliveries from being pointed at internal
addresses. Failed deliveries retry with backoff and, if they still don't land,
drop into a dead-letter queue an admin can inspect and replay — so a brief outage
on your end never silently loses an event.

## Email-in

Forward a test report to your account's dedicated reports address and ServiceCycle
ingests it automatically: the assets and readings appear as cards, and the sender
gets an acknowledgement. It's the zero-click ingestion path — see *Imports* for how
matching and auto-commit behave. The address and inbound webhook are configured
here.

## Common workflows

**"Sync assets from our system nightly."** Create an API key, read the OpenAPI
spec, and write against `/api/v1` — the same validation and scoping as the app.

**"Notify our ticketing system when something goes overdue."** Register a webhook,
verify the HMAC signature on your side, and act on the event payload.

**"Make routine reports flow in automatically."** Use the email-in address; no API
work required.

**"Connect our condition monitoring platform."** Create a write-scoped API key and
point your edge gateway or cloud bridge at `POST /api/v1/telemetry/readings` with
batched readings. Configure warn/critical thresholds per channel via
`POST /api/v1/telemetry/channels` and ServiceCycle handles the rest — condition
escalation, dashboard alerts, and arc-flash re-study flags.

## When something looks wrong

**API calls return unauthorized.** Confirm you're sending the key as a bearer
token and that it hasn't expired or been revoked; you can issue a fresh key under
Settings.

**Webhook deliveries aren't arriving.** Check that the endpoint is HTTPS and
reachable, and look at the dead-letter queue — failed deliveries land there with
the last error so you can fix and replay them.

**The signature won't verify.** Make sure you're computing HMAC-SHA256 over the raw
request body with the endpoint's secret; verifying against a re-serialized body is
the usual culprit.
