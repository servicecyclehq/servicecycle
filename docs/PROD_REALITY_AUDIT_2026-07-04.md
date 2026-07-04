# Prod-Reality Audit — 2026-07-04

**Motivating incident:** the pdfplumber PDF extractor was **inert in production for weeks**
(Alpine base image had no `pypdfium2` wheel; ingest silently fell back to the pdfjs parser
+ AI gap-fill — see `docs/PDF_INGESTION_SYNTHESIS_2026-07-03.md` §2). Two hours after that
was fixed, the 2026-07-04 nameplate regression showed the same *class* of bug — a live
capability that **green units + local dev could not have caught**. This audit is a
deliberate sweep for other features that could be "on in the code, off in prod."

**Method:** grep for env-gated code paths, `try { require } catch` lazy loads, native /
Python subprocess handoffs, `DEMO_MODE` branches, and any feature whose "on" state depends
on a runtime artifact not enforced at build time. Cross-check what the code assumes at
runtime against `docker-compose.yml` + `server/Dockerfile`.

**Verdict (short):** the extractor was the outlier. Every other opt-in feature in the
server either (a) actively warns at startup when unconfigured, (b) throws with a clear
tech-facing message at call-time, or (c) is documented as best-effort with a working
fallback. One code-and-comment mismatch (stale post-Debian-switch) fixed in this session;
one always-safe hardening applied to the vision paths (item 1 in the overnight prompt);
everything else flagged is either intentional or needs Dustin's decision.

---

## Findings

### F1 — `pyextract/requirements.txt` header referenced the old Alpine target. **FIXED this session.**

**File:** `server/pyextract/requirements.txt`
**Was:** header said "alpine linux/amd64 target" and body claimed `pypdfium2 is intentionally
omitted: it ships only manylinux (glibc) wheels and cannot be imported on Alpine musl."
**Actual runtime:** `node:20-slim` (Debian) since commit `c652578` — manylinux wheels
resolve, `pypdfium2` is loaded transitively via pdfplumber, and the pdfplumber PowerDB
grid parser + Tesseract OCR both run.
**Risk if left stale:** any future maintainer following that comment would (a) believe
they still need to guard against a missing extractor in prod (dead code proliferates), or
(b) assume the Alpine constraint applies and reject a legitimate `pypdfium2==<pinned>`
addition. It's diligence noise more than functional risk, but it's exactly the kind of
mismatch that made the original incident hard to spot.
**Fix:** rewritten header + inline comment now correctly reflect the Debian reality and
name the incident + the referenced doc so the history stays discoverable.

### F2 — Every vision-model caller could truncate on Gemini 2.5-flash thinking tokens. **FIXED this session** (item 1 of the overnight prompt).

**Files:** `server/lib/aiTestReportExtract.ts`, `server/lib/arcFlashDevice.ts`,
`server/lib/arcFlashExtract.ts`, `server/lib/photoInspect.ts`.
**Risk class:** identical to the 2026-07-04 nameplate incident (`919d389`). Gemini
2.5-flash is a THINKING model whose reasoning tokens bill against `maxOutputTokens`; the
test-report vision path was on `3072`, the arc-flash device photo on `1500`, and the
photo-inspection path on `2000`. All parse the response as JSON; all would silently
truncate on a busy plate / dense report and 500 (or, in `aiTestReportExtract`, silently
return `null` → the pipeline runs deterministic-only with no AI gap-fill).
**Fix (always safe):** every call bumped to `maxTokens: 8192` (the value proven correct
by the nameplate route); `responseMimeType: 'application/json'` added to opt into Gemini
JSON mode where the response is parsed as JSON. Anthropic / OpenAI / Groq paths in
`completeWithImage` ignore `responseMimeType` (Groq already forces `json_object`). Fully
backward-compatible; `maxTokens` cannot break a shorter response, and JSON mode only
tightens what Gemini emits.
**Live-verify:** shipped conservatively because the cap-5/day nameplate live path is not
available to Claude for scan testing. Item 1 of the overnight prompt lists every path for
Dustin to spot-check when the quota resets.

### F3 — 12 background crons run without an external heartbeat. **Intentional; documented; loud.**

**Where:** `server/index.ts:430`, `:1591-1611`.
**State:** `HEALTHCHECKS_PING_KEY` and every `HEALTHCHECKS_URL_*` override are unset on
the demo droplet. Twelve schedulers (alertEngine, backup, nightlySync, activityLogChain
settle, and the others enumerated in `lib/heartbeat.js`) run without any external monitor
noticing if they stop.
**Why intentional:** the code loudly warns at boot (`[startup][POP-8-3] WARNING: cron
heartbeat monitoring is NOT configured …`) unless `HEARTBEAT_MONITORING_ACK=true` is set.
It is on the deferred SOC2 A1.2 backlog per `MEMORY.md` → *"Better Stack heartbeat
monitor — closes last SOC2 gap A1.2; needs HEALTHCHECKS_URL env var + restart; do when
convenient."*
**Not silent in the way F1 was:** every restart says so out loud. Do not chase.

### F4 — Backup destination defaults to on-host filesystem. **Intentional; startup-warned.**

**Where:** `server/lib/backup.ts:65-69` (`warnIfLocalDest()`).
**State:** on the demo droplet `BACKUP_DEST=s3` (R2 vendor stack — v0.38.3). On self-host
default, `BACKUP_DEST=local` and a droplet-destroy loses every backup with the DB.
**Why intentional:** documented in `.env.example`, warned every boot, off-host destination
requires operator credentials the code cannot invent.
**Not silent:** covered.

### F5 — Slack / Stripe / Tavily / news scanner / AI itself are all opt-in with no default. **Intentional.**

**State:** all default OFF; `AI_ENABLED=false` even routes through a documented kill-switch.
`.env.example` documents each; every consumer degrades gracefully or throws a clear
call-time error.
**Not silent:** each is either warned at startup (mock-mode banner, budget guard boot),
returns a documented 503 with a `_disabled` / `_not_configured` code, or is opt-in-by-flag
(news scanner). No silent-inert risk of the extractor's class.

### F6 — Native / subprocess handoffs (`sharp`, `spawn(python3, ...)`) all fail open.

**Where:** `lib/imageNormalize.ts` (sharp), `lib/rasterizePdf.ts` (python3
`scripts/rasterize_pdf.py`), `lib/pdfText.ts` (python3 `scripts/pdf_text.py`),
`lib/testReportExtract.js` (python3 `pyextract/run.py`).
**State:** all three scripts are present in the repo tree; `COPY --chown=node:node . .`
in `Dockerfile` ships them; python3 + pip deps installed in the runtime stage. sharp is
in `dependencies` (survives `npm prune --omit=dev`) and installs against Debian glibc.
**Risk class this audit checked:** would any of these paths silently do nothing if the
runtime artifact went missing? Answer: yes — `imageNormalize.ts:23` explicitly passes
the buffer through unmodified if `sharp` fails to load, which would silently drop the
EXIF-rotate on every mobile upload. But sharp is a hard dependency and the deps stage
would fail loudly if it didn't install, so the fail-open path is a floor, not a
production reality. Left as-is: adding a startup probe would be premature over-engineering
for a hypothetical the container build already prevents.
**Not silent in prod** given the current Dockerfile guarantees.

### F7 — Two `try { require('@anthropic-ai/sdk') } catch` / `try { require('@google/generative-ai') } catch` blocks in `lib/ai.ts` throw a clear tech-facing message at call time.

**Where:** `lib/ai.ts:427-429` (Anthropic complete), `:459-461` (Anthropic image),
`:629-631` (Gemini complete), `:663-665` (Gemini image).
**Behavior on missing package:** each throws
`"[ai] <package> not installed. Run: npm install <package>"`. Not silent — the first
call surfaces it immediately.
**State:** both packages are in `dependencies` in `package.json`; both are present in the
runtime `node_modules`. Not a silent-inert risk.

---

## Flagged for Dustin (not fixed — need his call)

### D1 — `AI_ENABLED=false` on the demo droplet is documented, but every acquisition-demo path that "shows the AI" is a fixture.

**Not a bug, a demo posture.** The Gemini free tier is capped, `AI_ENABLED=false` means a
lot of AI-labelled surfaces (nameplate scan is a documented exception; brief generation,
ask, extract are gated) do NOT actually call an LLM in the demo. This is *correct
diligence hygiene* per the AI budget guard fuse, but the story a PE/OEM reviewer will
tell themselves — "the demo I saw runs AI" — is not the same story the code tells. If
this ever becomes a diligence question, the answer needs to be precise: "the nameplate
scan runs live Gemini; other AI surfaces are budget-fused on the shared demo droplet
because the free tier is small; a paying tenant flips those on via their own key."
**Suggested action:** none tonight — this is a strategy call, not a bug.

### D2 — `HEALTHCHECKS_PING_KEY` unset on the demo droplet. **Backlog item; per SOC2 A1.2.**

Already tracked in MEMORY as "do when convenient." Flagging here so this audit is
complete, not to double-count.

---

## What this audit does NOT do

- Not a full pen-test or license scan (those are separate artifacts under
  `docs/security/scans/`).
- Not a client-side (browser bundle) audit — that would need visual review.
- Not a database-migration reality check (`prisma migrate deploy` runs as the migration
  init container; failure blocks the API from starting, so this class is loud not silent).
- Not a re-verification of the 919d389 fix — that has its own regression-lock test
  (`server/tests/nameplateOcrContract.test.js`, shipped this session).

---

*Generated 2026-07-04. Fixes shipped this session: F1 (comment), F2 (four vision paths).
Everything else is either intentional (F3-F5), covered by build guarantees (F6-F7), or
flagged for Dustin (D1-D2).*
