# Research memo: work-order chat/comments + on-photo annotation

**Status:** exploratory only — no code changed, no decisions made. Written to give
Dustin a feel for the design space before picking a direction.
**Date:** 2026-07-05

---

## 1. What ServiceCycle already has

Source: `server/prisma/schema.prisma`, `server/routes/workOrders.ts`,
`server/routes/activity.ts`, `server/routes/documents.ts`, `server/routes/fieldRoutes.ts`.

### WorkOrder model (schema.prisma:1046)
One `WorkOrder` = one visit against one `Asset`, optionally born from a
`MaintenanceSchedule`. Relevant fields for this memo:

- `notes String?` — a single free-text field, no structure, no history of edits, no author-per-note. This is the closest thing to "comments" today — whoever edits it last overwrites it (server/routes/workOrders.ts PUT `/:id` writes `notes` straight through).
- `reportPdfUrl String?` — one attached PDF, separate from the `Document` relation.
- Related records: `measurements` (TestMeasurement[]), `deficiencies` (Deficiency[]), `labSamples` (LabSample[]), `documents` (Document[]), `partsUsed` (WorkOrderPartUsage[]).
- **No Comment, Thread, or Annotation model exists anywhere in the schema.** Grepping the whole schema for "Comment"/"Attachment"/"History" only turns up `ActivityLog` (audit trail, described below) and the generic `Document` model.

### Document model (schema.prisma:1706)
Generic attachment table already used for PDFs/images: `assetId?`, `workOrderId?`, `siteId?`, `filePath` (storage key), `fileType`, `docType` enum, `provenance` enum (`unverified` / `vendor` / `as_built` / `engineered` / `pe_sealed`), `version Int`. Photos/reports attached to a WO already flow through this table — there's no separate "photo" concept. This is the natural place a "photo used for annotation" would live (either directly or via a new join).

### ActivityLog / audit trail (schema.prisma:1855, `routes/activity.ts`)
Account-wide, **hash-chained** (`prevHash`/`rowHash`, settled ~30s after insert by a background job) audit log: `assetId?`, `userId?`, `accountId?`, `action` (free string, e.g. `work_order_completed`, `condition_changed`, `measurement_updated`), `details Json?`. This is ServiceCycle's single existing "timeline" concept, and it's tamper-evident by design (SOC 2 relevant — Dustin has invested real effort in the hash chain). **Any comment/chat feature needs to either feed this same log or be clearly scoped as a distinct, parallel stream** — see Section 3.

### Existing routes (server/routes/workOrders.ts, ~1490 lines)
- `GET/POST /api/work-orders`, `GET/PUT /:id` (full state-machine handling SCHEDULED→AWAITING_APPROVAL→IN_PROGRESS→COMPLETE→CANCELLED, with side effects: schedule roll-forward, condition recompute, deficiency gating).
- `PUT /:id/assignment` — assign/unassign a field_tech `User`.
- `POST/PUT/DELETE /:id/measurements`, `POST /:id/deficiencies`, `POST /:id/lab-samples`, `GET/POST/DELETE /:id/parts`.
- `POST /:id/approve`.
- No `/comments`, `/photos`, or `/annotations` sub-resource exists today.

### Field-tech surface (server/routes/fieldRoutes.ts)
A parallel, scoped API for `field_tech` role users (`requireFieldWriter` middleware): `GET /assignments` (their WOs only), `POST /work-orders/:id/measurements`, `POST /work-orders/:id/complete`, `POST /deficiencies`, `POST /voice/parse` (voice-to-structured-data). **This is the surface any WO chat/annotation feature must also expose** — field techs don't hit the manager-only `routes/workOrders.ts` endpoints directly, they get a mirrored, narrower set.

### Storage abstraction (server/lib/storage.ts)
Already environment-agnostic: `STORAGE_DEST=local|s3`, `uploadFile(accountId, assetId, filename, buffer, mimeType)` returns a `storageKey`; S3-compatible via `@aws-sdk/client-s3` with configurable endpoint (works with non-AWS S3-compatible providers). `routes/documents.ts` layers MIME allowlisting + magic-byte sniffing + optional AES-256-GCM encryption on top. **Any new photo/annotation feature should reuse this exact pipeline** rather than inventing a second upload path.

### Client UI (client/src/pages/WorkOrderDetail.jsx, WorkOrdersList.jsx)
Skimmed only. `notes` renders as a `<textarea>`-style single field bound to `detailForm.notes`, submitted whole on save (no per-comment granularity, no threading, no photo markup UI present).

---

## 2. How comparable tools handle this

### MaintainX (CMMS work orders)
- Work orders support **comments with @-mentions**: "Features like @mentions in work order comments and messages help technicians quickly ask questions, flag issues, or get input from teammates without moving critical context into texts, calls, or side conversations." ([MaintainX use-cases](https://www.getmaintainx.com/use-cases/work-order-management))
- Mobile app: "Technicians can change the status, add comments and upload photos with just a few taps" and recently added **comment translation** + AI summaries of past work orders. ([MaintainX mobile overview](https://help.getmaintainx.com/getting-started-new-users/mobile-app-overview))
- **Offline mode is a first-class, explicit mode** (not silent best-effort): a local cache of work orders is built while online, techs work against the cache offline, and on reconnect they either auto-sync or manually trigger sync; cached WOs survive reboot/battery-death. Offline mode also auto-activates if connectivity drops. ([MaintainX Help Center – Working Offline](https://help.getmaintainx.com/offline-mode))
- Takeaway: comments are flat-ish (not deep Slack-style threads) but support mentions; offline is treated as a deliberate mode the user toggles/is dropped into, not a silent queue.

### SafetyCulture / iAuditor (inspection photo annotation)
- Annotation is inline on the **photo itself**, invoked per-image: "Simply snap your photo and click annotate" — arrows, text, shapes drawn directly onto the image to flag specific areas (e.g., "snap a photo of broken equipment and add an arrow to the area that needs to be fixed"). ([SafetyCulture blog](https://blog.safetyculture.com/tips-tricks/iauditor-tips/the-iauditor-feature-youre-not-using-enough-but-should))
- UX is the same on web and mobile: select image → tap/click "Annotate" → mark up → "Done". ([SafetyCulture Help Center](https://help.safetyculture.com/003414))
- Takeaway: this is the "coordinates+text / vector-shapes" pattern in production at scale — annotation is a lightweight per-photo popup editor, not a persistent multi-user session. No evidence in these sources of real-time multi-user collaborative markup (that's Bluebeam's niche, below).

### Slack (threaded comments + reactions)
- Threading is done via a **self-referencing timestamp**: every message has its own `ts`; a reply carries `thread_ts` pointing at the parent's `ts`. If `thread_ts === ts` the message IS the parent; if different, it's a reply. Parent messages carry a denormalized `reply_count`. ([Slack docs – conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/), [Retrieving messages](https://docs.slack.dev/messaging/retrieving-messages/))
- Reactions are a separate concept from replies: an "item" (message/file) has a `type` plus a `reactions` array; each reaction entry has an emoji `name`, a `count`, and a `users` array (the API doc explicitly warns `users` may be truncated while `count` stays accurate — i.e., reactions are stored as aggregates, not exhaustively enumerated in every response). ([Slack docs – reactions.get](https://docs.slack.dev/reference/methods/reactions.get/), [reactions.add](https://docs.slack.dev/reference/methods/reactions.add/))
- Takeaway: one flat parent/child pointer (`thread_ts`) is enough to get "threading" without a recursive tree; reactions are a bolt-on aggregate table, not baked into the message row.

### Bluebeam Studio Sessions (real-time document markup)
- Multiple people open the **same PDF** in a live "Session"; every markup placed is pushed to all attendees immediately, no check-in/check-out. ([Bluebeam support](https://support.bluebeam.com/studio/how-to/tips-and-tricks/five-things-you-may-not-know-about-sessions.html))
- Markups remain **individually attributable and editable only by their author** even though everyone sees them live — authorship integrity is preserved inside a shared canvas. A "Follow Attendee" mode syncs your viewport to theirs. A separate built-in chat panel runs alongside the markup layer. ([Bluebeam Real-Time Collaboration](https://university.bluebeam.com/real-time-collaboration-studio-sessions))
- On the storage side (from Bluebeam's own markup docs, not session-specific): markups normally live in a separate **annotations layer** on top of the PDF content; "Flatten" is an explicit, separate operation that merges markups into the page content layer, after which they're no longer editable/removable as objects. ([Flatten Markups](https://support.bluebeam.com/user-manual/menus/document/flatten-markups.html))
- Takeaway: (a) real-time multi-user sync is a substantial engineering lift or a legal/config example ServiceCycle almost certainly doesn't need on day one — this is a two-person-small-team product, not a multi-firm design-review tool; (b) the layer-vs-flatten distinction maps directly onto this memo's "SVG overlay vs baked-in-image" tradeoff below, and Bluebeam's own default is "keep it a layer, flatten only as an explicit export step" — worth copying that default.

---

## 3. Proposed data-model options for ServiceCycle

Three areas to decide, then bundled into 2-3 concrete options below.

### 3a. Comment structure: threaded vs flat vs mixed
- **Flat** (one list per WorkOrder, ordered by `createdAt`, no parent pointer) — simplest, matches how `notes` already reads today, matches MaintainX's WO-level comment stream. Good enough for a small crew where a WO's whole comment feed IS the thread.
- **Threaded** (Slack-style `parentId` self-reference on the same table, i.e. ServiceCycle's own `thread_ts` equivalent) — needed only if replies-to-replies become common. For a 1-2 person contractor team completing one WO, deep threading is unlikely to earn its complexity.
- **Mixed / recommended**: flat list + optional single-level `parentId` (reply-to-one-comment, no deeper nesting) — this is exactly Slack's model minus the recursion: a nullable self-FK is cheap to add now and cheap to ignore if nobody replies-to-replies.

### 3b. Reactions / @-mentions / notifications — now or later?
- **Reactions**: skip for v1. No evidence any of the researched *work-order* tools (MaintainX) lean on reactions as a differentiator; it's a Slack-specific social pattern. Low value for a compliance-driven trade tool, real (if small) build cost (aggregate table + UI).
- **@-mentions**: MaintainX ships this specifically because it routes questions to the right person without a side-channel text/call — this is the one social feature with a genuine field-ops justification (a tech tags the office manager on a question mid-job). Recommend deferring to v2 but designing the comment `body` as plain text now so a `@username` regex-parse + `CommentMention` join table can be layered in later without a schema rewrite.
- **Notifications**: ServiceCycle already has a configurable alert system (condition degradation, deficiency, arc-flash expiry, decommission, overdue — see `assetAlertNotifier`). A comment/mention notification would slot into that existing pipe rather than requiring new infra — but still a v2, not v1, decision.

### 3c. Offline queueing for field techs
Spotty signal at electrical sites (switchgear rooms, basements, industrial sites) is real and MaintainX explicitly designed for it: a pre-fetched local cache + explicit online/offline mode + manual-or-auto sync on reconnect, with survivability across reboot/battery death. **ServiceCycle does not currently have this for anything** — `fieldRoutes.ts` assumes a live connection for every POST (measurements, deficiencies, complete). Comments and photo annotations, being small JSON/text payloads (unlike a full test-report PDF), are actually the *easiest* place to bolt on an offline queue: a client-side outbox (IndexedDB/localStorage) that POSTs on reconnect, with idempotency keys so a retried POST after a flaky connection doesn't double-insert. This is a client-side PWA concern more than a schema concern — flag it as a UI/service-worker task, not a Prisma migration, but it's the single biggest field-usability risk if skipped (a tech scribbles a note in a dead zone and it silently vanishes on app close).

### 3d. On-photo annotation storage — three concrete options

| Approach | What's stored | Pros for ServiceCycle's stack | Cons |
|---|---|---|---|
| **A. SVG overlay JSON** (vector shapes as JSON, rendered on top of the original `Document` image reference) | `{ shapes: [{type:'arrow', x1,y1,x2,y2, color}, {type:'text', x,y,text}, ...] }` in a `Json` column, FK to the base `Document.id` | Original photo never mutated (evidence integrity — same "never truly delete" instinct already in `TestMeasurement.deletedAt` soft-delete and the ActivityLog hash chain); trivially editable/re-editable; cheap to store (KBs not MBs); renders natively in React with an SVG/canvas overlay component; matches Bluebeam's own default (keep markups a layer, flatten only on export) | Requires a render pass (React component) everywhere the photo is shown — PDF export (leave-behind reports) needs a server-side flatten step to bake it into a static image/PDF |
| **B. Baked-in-image** (flatten annotations into a brand-new image file at save time, stored as a new `Document` version) | New raster file (`version: 2` of the same logical photo, or a new `Document` row referencing the original as `sourceDocumentId`) | Zero rendering complexity everywhere the photo is displayed or exported — it's just an image; trivially fits the existing `Document.version` field already in the schema | **Destroys editability** (can't move that arrow later without re-annotating from scratch); doubles storage (original + annotated); the original evidence photo and the "marked up" one need careful provenance labeling so a manager doesn't confuse an annotated photo for the raw as-found evidence (NETA/liability-adjacent — ServiceCycle already treats evidence integrity seriously, e.g. `provenance` enum, soft-deletes) |
| **C. Coordinates + text triple** (simple pin markers: `{x, y, text}` array, no shapes/arrows, just labeled dots on the image) | `Json` array of `{x, y, note}` — a strict subset of option A | Simplest possible v1 — a tech taps a spot on the photo, types "cracked bushing here"; trivial mobile UX (tap-to-pin beats draw-an-arrow on a small touchscreen with gloves on); still non-destructive like A | Can't circle an area or draw a directional arrow (SafetyCulture's actual example — "add an arrow to the area that needs to be fixed" — needs at least a line/arrow primitive, which pins alone can't express) |

**Recommendation on 3d: start with C, structure it so it's a strict subset of A.** Define the JSON shape as `{ type: 'pin'|'arrow'|'text', x, y, x2?, y2?, text? }[]` from day one — ship only the `pin` renderer in v1 (cheapest mobile UX, matches "tap and type" field ergonomics better than freehand drawing on a phone in gloves), but the storage format already accommodates `arrow`/shape types for v2 without a migration. Never flatten by default (avoid B as the primary path) — only generate a baked-in flattened image as an on-demand export step for PDF leave-behind reports, mirroring Bluebeout's "flatten is a separate explicit action" default.

### 3e. Avoiding two competing timelines
ServiceCycle already has one hash-chained, tamper-evident timeline (`ActivityLog`) used for compliance/SOC2 purposes (condition changes, completions, measurement edits). A chat/comment feed is a **different kind of data** — informal, conversational, editable/deletable by the author — and should NOT be forced into the same hash-chained table (that chain's whole value proposition is immutability of compliance-relevant facts; letting users free-form edit/delete rows in it would undermine the SOC 2 story Dustin has spent multiple sessions hardening). Recommended pattern:
- New `WorkOrderComment` table is its **own** timeline, rendered in its own panel/tab on the WO detail page (not merged into the Activity Log UI).
- On **creation** of a comment (and optionally on deletion), fire a *summary* `writeActivityLog({action: 'work_order_comment_added', details: {commentId, workOrderId}})` — same pattern already used for `work_order_created`/`work_order_completed`. This gives auditors a tamper-evident breadcrumb ("a comment existed, added by X at T") without putting the mutable comment body itself inside the hash chain.
- This mirrors how `TestMeasurement` edits already work today: the actual mutable row lives in its own table, and the audit chain only gets a *before/after snapshot event*, not live ownership of the data.

---

## 4. Scope estimates per option

### Option 1 — Flat comments only, no photo annotation (smallest slice)
- **Data model**: one new table.
  ```prisma
  model WorkOrderComment {
    id          String   @id @default(uuid())
    accountId   String
    workOrderId String
    authorId    String
    body        String   @db.VarChar(4000)
    createdAt   DateTime @default(now())
    editedAt    DateTime?
    deletedAt   DateTime? // soft delete, mirrors TestMeasurement pattern

    account   Account   @relation(fields: [accountId], references: [id])
    workOrder WorkOrder @relation(fields: [workOrderId], references: [id], onDelete: Cascade)
    author    User      @relation(fields: [authorId], references: [id])

    @@index([accountId])
    @@index([workOrderId, createdAt])
    @@map("work_order_comments")
  }
  ```
- **API surface**: `GET /api/work-orders/:id/comments`, `POST /api/work-orders/:id/comments`, `PUT /api/work-orders/comments/:cid`, `DELETE /api/work-orders/comments/:cid` (soft delete) — mirrored into `fieldRoutes.ts` as `GET/POST /api/field/work-orders/:id/comments` behind `requireFieldWriter`.
- **UI complexity: Low.** One new panel on `WorkOrderDetail.jsx` (list + textarea + submit), reusing existing list-render patterns already in that file for measurements/deficiencies.
- **Mobile/offline**: comment POSTs are small text payloads — straightforward client-side outbox candidate (see 3c) but can ship v1 without offline queueing and add it after.

### Option 2 — Comments + simple photo pin-annotation (Option C from 3d)
- **Data model**: `WorkOrderComment` (as above) **plus**:
  ```prisma
  model DocumentAnnotation {
    id          String   @id @default(uuid())
    accountId   String
    documentId  String        // FK to existing Document (the photo)
    authorId    String
    // Forward-compatible shape: v1 UI only creates {type:'pin'}, but the
    // column already accepts 'arrow'/'text' so v2 needs zero migration.
    // Example row: [{ type:"pin", x:0.42, y:0.61, text:"cracked bushing" }]
    shapes      Json
    createdAt   DateTime @default(now())
    deletedAt   DateTime?

    account  Account  @relation(fields: [accountId], references: [id])
    document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
    author   User     @relation(fields: [authorId], references: [id])

    @@index([accountId])
    @@index([documentId])
    @@map("document_annotations")
  }
  ```
  (`x`/`y` stored as 0–1 fractions of image width/height, not pixels — so annotations survive any client-side resize/thumbnail rendering.)
- **API surface**: everything from Option 1, plus `GET/POST /api/documents/:id/annotations`, `PUT/DELETE /api/documents/annotations/:aid`. No new upload path — photo upload keeps using the existing `documents.ts` multer + `lib/storage.ts` pipeline unchanged; annotations are a pure metadata layer on top.
- **UI complexity: Medium.** Needs a tap-to-pin overlay component (an absolutely-positioned `<div>`/SVG layer atop the `<img>`, translating tap coordinates to the 0-1 fraction space) plus a small popover for entering pin text. No canvas/drawing library needed for pins-only.
- **Mobile/offline**: same outbox pattern as Option 1; pin creation is also small JSON, easy to queue offline.

### Option 3 — Comments + full vector annotation (arrows/shapes, Option A from 3d) + @-mentions
- **Data model**: same `DocumentAnnotation` table as Option 2 (the `shapes` JSON already supports `arrow`/`text`/`freehand` types — no schema change, only new shape types accepted by validation) plus a mentions join table:
  ```prisma
  model CommentMention {
    id         String   @id @default(uuid())
    commentId  String
    mentionedUserId String
    createdAt  DateTime @default(now())

    comment WorkOrderComment @relation(fields: [commentId], references: [id], onDelete: Cascade)
    user    User             @relation(fields: [mentionedUserId], references: [id], onDelete: Cascade)

    @@index([mentionedUserId])
    @@map("comment_mentions")
  }
  ```
- **API surface**: everything from Option 2, plus mention-parsing on comment create (regex `@username` → resolve to `User.id` within the account → insert `CommentMention` rows → feed into the existing alert-notification pipeline).
- **UI complexity: High.** Needs a real drawing/markup component (freehand line, arrow, shape tools — likely a small canvas library, e.g. `react-konva` or hand-rolled SVG path drawing), an @-mention autocomplete input, and a notification-badge surface. This is the "build a mini Bluebeam" tier of effort, not a weekend feature.
- **Mobile/offline**: drawing gestures are harder to queue/replay offline than a pin-tap or a text comment (a half-drawn freehand path on a flaky connection is a worse failure mode); this option should be considered **online-only for v1 of vector shapes** even if comments/pins elsewhere are offline-queued.

---

## 5. Recommendation

**Build Option 2 first** (flat WorkOrderComment feed + simple photo pin-annotation), explicitly designing both JSON/schema shapes to be strict subsets of Option 3 so nothing gets rebuilt later.

Why:
- It directly answers the two real, evidenced field-ops needs found in this research — a comment stream (MaintainX's core WO-collaboration feature) and lightweight photo markup (SafetyCulture's core inspection-photo feature) — without taking on Slack-tier social features (reactions, deep threads) or Bluebeam-tier real-time multi-user drawing sessions, neither of which has a clear justification for a small-crew NETA contractor tool.
- It reuses everything ServiceCycle already has: the `Document`/`storage.ts` upload pipeline (no new upload path), the `writeActivityLog` summary-event pattern (keeps the SOC2 hash chain clean per Section 3e), the soft-delete convention already established on `TestMeasurement`, and the `fieldRoutes.ts` mirrored-endpoint pattern for field techs.
- It's genuinely small: one new table + one new metadata table, a handful of REST endpoints mirroring patterns that already exist four times over in this codebase, and UI work that's "medium" rather than "needs a drawing library" — appropriate for a small team shipping incrementally, matching how every other module in this codebase (Parts/Spares, arc-flash, incident register) shipped as an additive slice rather than a rewrite.
- @-mentions, reactions, deep threading, and full vector markup are all cheap to bolt on later *if* the JSON shapes and table structure are designed with them in mind now (which this memo's schemas already do) — so choosing the small option today isn't a bet against ever building the bigger one, it's sequencing.
