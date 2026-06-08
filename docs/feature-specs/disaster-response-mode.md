# Feature Spec: Disaster Response Mode
Status: Roadmap — Phase 1
Priority: High

---

## Problem

When a natural disaster, major grid event, or regional emergency strikes, customers with damaged or destroyed electrical equipment need to get replacement parts, generators, and service techs immediately — but so does every other facility in the affected area. Today there's no mechanism to:

1. Know which ServiceCycle customers are in the affected area
2. Know what equipment they have at risk
3. Surface that information to the OEM service rep instantly
4. Let customers jump to the front of the parts/service queue

The result: customers call in cold, reps waste time asking for asset lists, and customers without established relationships get served first.

---

## Opportunity

ServiceCycle already has the infrastructure. This feature is largely connecting dots:

| Existing capability | How it plugs in |
|---|---|
| News + grid outage monitoring | Detects the event |
| Asset inventory per account | Knows exactly what each customer has |
| Deficiency + condition tracking | Knows what's already at risk |
| EMERGENCY quote request mode | Escalation channel to rep already exists |
| Outage Consolidation Planner | Asset criticality and power path already modeled |
| Per-account service rep | Rep notification already wired |

---

## Feature Overview

### 1. Event Detection (Automated)
The existing news scanner monitors grid events and breaking news. Extend it to:
- Recognize disaster declarations (FEMA, NOAA, NWS severe weather alerts) by region
- Map affected region against customer facility locations (lat/lng on Site records)
- Auto-flag accounts in the impact zone

### 2. OEM Alert Dashboard
When an event is detected affecting one or more customer sites:
- OEM rep receives immediate notification: "Event detected: [Storm/Outage/Disaster] affecting N customer facilities"
- Dashboard shows affected accounts ranked by asset criticality (energized equipment, Condition 3 assets, open deficiencies)
- One-click view of each customer's full asset list, condition status, and open issues

### 3. Customer Emergency Declaration
Customer-facing "Declare Emergency" button surfaced when:
- Their site is in a detected event area, OR
- They manually trigger it

On declaration:
- System auto-generates a **Priority Asset Report** — critical equipment, condition status, flagged deficiencies, and last maintenance date for each
- EMERGENCY quote request pre-filled with that asset list and "disaster/emergency" as the driver
- Service rep notified instantly with the full context
- Customer sees: "Your rep [Name] has been notified. You are in the emergency service queue."

### 4. Queue Prioritization Signal
The Emergency Declaration creates a flag on the account visible to OEM reps. Reps can sort their service queue by declared emergencies. Customers who declared get visibility — "You are #3 in the emergency queue for your region."

---

## What This Is NOT

- Not a dispatch system (OEM handles their own scheduling)
- Not FEMA integration or government reporting
- Not insurance claims management
- Not a real-time SCADA/sensor feed

---

## Infrastructure Already Built

- `lib/newsScanner.ts` — news/grid event monitoring, extend to FEMA/NWS feeds
- `routes/quoteRequests.ts` — EMERGENCY mode, extend with disaster driver type
- `server/routes/fieldRoutes.ts` and `prisma/schema.prisma` — Site has location data
- `lib/alertEngine.ts` — notification delivery to reps and customers
- `lib/email.ts` + Slack/Teams integrations — rep alert channels

## New Schema Needed

```prisma
model DisasterEvent {
  id          String   @id @default(cuid())
  accountId   String   // null = regional event detected by system
  eventType   String   // 'hurricane' | 'tornado' | 'ice_storm' | 'grid_failure' | 'manual'
  severity    String   // 'watch' | 'warning' | 'emergency'
  region      String   // affected region description
  declaredAt  DateTime
  declaredBy  String?  // userId if manual
  resolvedAt  DateTime?
  affectedSiteIds String[] // Site IDs in impact zone
}
```

---

## OEM Sales Pitch

> "When the next storm hits, your ServiceCycle customers get to the front of the line. We already know exactly what equipment they have, what's at risk, and what they need — before they even pick up the phone."

This is a retention and acquisition feature as much as a disaster response feature. Customers who know they'll be prioritized in an emergency don't leave.

---

## Estimated Effort

- Backend: 3-4 days (event detection extension, declaration flow, queue flag)
- Frontend: 2-3 days (OEM alert dashboard, customer declaration UI, queue position)
- Total: ~1 sprint

## Dependencies

- FEMA/NWS API research (free public APIs available)
- Brother input: how does the OEM currently handle disaster/emergency service triage?
- Confirm Site records have lat/lng for geo-matching
