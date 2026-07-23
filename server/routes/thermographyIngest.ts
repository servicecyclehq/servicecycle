/**
 * routes/thermographyIngest.ts — #29 IR thermography report ingest.
 *
 * POST /api/assets/:id/thermography/preview — parse + grade hot-spots (no write)
 * POST /api/assets/:id/thermography/commit  — persist a structured survey
 *
 * #29 §7.4 (2026-07-18): commit now writes the NFPA 70B:2023 §7.4 /
 * NETA MTS-2023 Table 100.18 documentation record — one ThermographySurvey
 * (conditions + thermographer + camera) plus one ThermographyFinding per hot
 * spot, INCLUDING below-threshold spots, which the old path graded and then
 * dropped (they are what makes a component trendable across surveys). Above
 * threshold it still creates the Deficiency with the exact same text as before
 * (backward compatible) and links it via ThermographyFinding.deficiencyId.
 * The source IR report PDF is stored as evidence through the Document store.
 *
 * Accepts structured hotspots [{ location, deltaT, note? }] and/or raw report
 * text (parsed by thermographyParse). Thermography is a 70B 12-month required
 * task, so every compliant facility generates these annually.
 *
 * Mounted at /api/assets (authenticateToken applied at the mount point).
 */

const router = require('express').Router();
import prisma from '../lib/prisma';
const multer = require('multer');
const { requireManager } = require('../middleware/roles');
const { severityForDeltaT } = require('../lib/thermographyEvaluate');
const { parseThermographyText } = require('../lib/thermographyParse');
const { resolveAccountFeatures } = require('../lib/accountFeatures');
const { uploadFile } = require('../lib/storage');
const { dec, shapeSurvey } = require('../lib/thermographyShape');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

async function ownAsset(req: any) {
  return prisma.asset.findFirst({ where: { id: req.params.id, accountId: req.user.accountId }, select: { id: true } });
}

// [#29 §7.4] Server-side feature gate. The client hides the card behind
// accountFeatures.thermography_import, but until now the endpoint itself was
// open to any authenticated manager — the flag was advisory, not enforced.
// Both preview and commit now resolve the same flag the client gates on.
async function requireThermographyFeature(req: any, res: any, next: any) {
  try {
    const features = await resolveAccountFeatures(req.user.accountId);
    if (!features || !features.thermography_import) {
      return res.status(403).json({ success: false, error: 'Feature not enabled' });
    }
    return next();
  } catch (err: any) {
    console.error('[thermography] feature resolution failed:', err?.message || err);
    return res.status(403).json({ success: false, error: 'Feature not enabled' });
  }
}

// Evidence upload: the vendor's IR report PDF (images live inside it). Images
// are accepted too so a phone photo of a report page is not rejected outright.
const EVIDENCE_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
]);
const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/png': 'png', 'image/webp': 'webp',
};

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024, files: 1 }, // 20 MB, mirrors routes/documents.ts
  fileFilter: (_req: any, file: any, cb: any) => {
    if (!EVIDENCE_MIME.has(String(file.mimetype || '').toLowerCase())) {
      const err: any = new Error(`File type '${file.mimetype}' is not allowed. Attach the IR report as PDF (or an image).`);
      err.status = 415;
      err.code = 'UNSUPPORTED_MEDIA_TYPE';
      return cb(err);
    }
    return cb(null, true);
  },
}).single('file');

// multer runs only for multipart/form-data; a JSON commit passes straight
// through. Its errors (size cap, fileFilter) become a precise status instead of
// multer's default 500 — same treatment as routes/documents.ts.
function evidenceUploadMw(req: any, res: any, next: any) {
  evidenceUpload(req, res, (err: any) => {
    if (!err) return next();
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'The IR report is larger than the 20 MB limit.'
      : (err.message || 'Upload failed');
    return res.status(status).json({ success: false, error: msg });
  });
}

/** A multipart commit carries the JSON body in a `payload` field; a JSON
 *  commit carries it directly. Keeps existing JSON-only callers working. */
function readPayload(req: any): any {
  if (req.file || (typeof req.body?.payload === 'string')) {
    try { return JSON.parse(req.body.payload || '{}'); } catch (_e) { return {}; }
  }
  return req.body || {};
}

// [NETA-8-1] Normalize a reference-frame token to the two scales the NETA Table
// 100.18 grader knows: 'ambient' (over-ambient-air) vs 'similar' (between similar
// components — also used for a baseline/prior comparison). Anything unrecognized
// falls back to the conservative similar-component scale.
const REF_LABEL: Record<string, string> = {
  ambient: 'over ambient', similar: 'vs. similar component', baseline: 'vs. baseline',
};
function normRef(r: any): 'ambient' | 'similar' {
  return r === 'ambient' ? 'ambient' : 'similar';
}
// The stored reference keeps 'baseline' distinct even though grading collapses
// it onto the similar-component scale — §7.4 wants the frame as measured.
const REF_ENUM: Record<string, 'AMBIENT' | 'SIMILAR' | 'BASELINE'> = {
  ambient: 'AMBIENT', similar: 'SIMILAR', baseline: 'BASELINE',
};
function refEnum(r: any): 'AMBIENT' | 'SIMILAR' | 'BASELINE' {
  return REF_ENUM[String(r || '').toLowerCase()] || 'SIMILAR';
}

function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Structured hotspots OR report text — never both (2026-07-23 fix, see
 *  DUPE-IR-1 below). Each hot-spot carries its own reference frame (NETA-8-1)
 *  so it is graded on the correct NETA Table 100.18 scale. Structured rows
 *  may set `reference`; a body-level `reference` is the default for rows
 *  that don't, then 'similar'. */
function resolveHotspots(body: any): { hotspots: any[]; surveyDate: string | null; parsedHeader: any; confidence: any } {
  const out: any[] = [];
  const bodyRef: string | undefined = typeof body?.reference === 'string' ? body.reference : undefined;
  if (Array.isArray(body?.hotspots)) {
    for (const h of body.hotspots) {
      const dt = Number(h?.deltaT);
      if (!Number.isFinite(dt)) continue;
      const ref = (typeof h?.reference === 'string' ? h.reference : bodyRef);
      out.push({
        location: String(h?.location || h?.component || 'Unspecified location').slice(0, 160),
        deltaT: dt,
        note: h?.note ? String(h.note).slice(0, 300) : undefined,
        reference: ref,
        referenceDeltaT: numOrNull(h?.referenceDeltaT),
        loadPercent: numOrNull(h?.loadPercent),
        emissivity: numOrNull(h?.emissivity),
      });
    }
  }
  let surveyDate: string | null = typeof body?.surveyDate === 'string' ? body.surveyDate : null;
  let parsedHeader: any = null;
  let confidence: any = {};
  // [DUPE-IR-1, 2026-07-23] This used to run unconditionally, so a commit
  // sent with BOTH the (already-parsed, tech-reviewed) `hotspots` rows AND
  // the still-populated `reportText` textarea — which is exactly what the
  // client sends on every normal paste -> Preview/parse -> Save flow, since
  // the textarea is never cleared after a preview — got every hot-spot
  // parsed and appended a SECOND time on top of the structured rows,
  // doubling findings/deficiencies on every survey saved this way. Only
  // fall back to parsing reportText when the caller didn't already supply
  // structured hotspots, so a commit sees ONE source of truth, not a union
  // of both. (The client also stopped sending reportText on commit as a
  // second, independent guard — see ThermographyImportCard.jsx save().)
  if (out.length === 0 && typeof body?.reportText === 'string' && body.reportText.trim()) {
    const parsed = parseThermographyText(body.reportText);
    // The parser already inferred a per-hot-spot reference from the line text;
    // keep it. Only fall back to the body-level reference when absent.
    for (const h of parsed.hotspots) {
      out.push({ ...h, reference: (h as any).reference ?? bodyRef, referenceDeltaT: (h as any).referenceDeltaT ?? null });
    }
    if (!surveyDate) surveyDate = parsed.surveyDate;
    parsedHeader = parsed.header;
    confidence = parsed.confidence || {};
  } else if (typeof body?.reportText === 'string' && body.reportText.trim()) {
    // Structured hotspots were supplied too — still parse the text for its
    // HEADER (camera/ambient/etc.) and surveyDate, just don't re-add hotspots.
    const parsed = parseThermographyText(body.reportText);
    if (!surveyDate) surveyDate = parsed.surveyDate;
    parsedHeader = parsed.header;
    confidence = parsed.confidence || {};
  }
  return { hotspots: out, surveyDate, parsedHeader, confidence };
}

function grade(hotspots: any[]) {
  return hotspots.map((h) => {
    const ref = normRef(h.reference);
    const s = severityForDeltaT(h.deltaT, ref);
    // `reference` stays normalized (existing preview contract); `refStored`
    // keeps the frame as measured for the ThermographyFinding row.
    return { ...h, reference: ref, refStored: refEnum(h.reference), priority: s.priority, severity: s.severity, label: s.label };
  });
}

/** Survey-header fields off the request body, falling back to the parsed
 *  header. Explicit body values always win — the tech confirms the form. */
function resolveHeader(body: any, parsedHeader: any) {
  const h = body?.header && typeof body.header === 'object' ? body.header : body || {};
  const p = parsedHeader || {};
  const str = (a: any, b: any, max = 160) => {
    const v = (a !== undefined && a !== null && a !== '') ? a : b;
    return (v === undefined || v === null || v === '') ? null : String(v).slice(0, max);
  };
  const n = (a: any, b: any) => (numOrNull(a) !== null ? numOrNull(a) : numOrNull(b));
  return {
    thermographerName: str(h.thermographerName, p.thermographerName, 120),
    thermographerQual: str(h.thermographerQual, p.thermographerQual, 80),
    cameraMake:        str(h.cameraMake, p.cameraMake, 60),
    cameraModel:       str(h.cameraModel, p.cameraModel, 60),
    ambientTempC:      n(h.ambientTempC, p.ambientTempC),
    humidityPct:       n(h.humidityPct, p.humidityPct),
    emissivity:        n(h.emissivity, p.emissivity),
    reflectedTempC:    n(h.reflectedTempC, p.reflectedTempC),
    loadPercent:       n(h.loadPercent, p.loadPercent),
    notes:             str(h.notes, null, 2000),
  };
}

// ── POST /:id/thermography/preview ───────────────────────────────────────────
router.post('/:id/thermography/preview', requireThermographyFeature, async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const { hotspots, surveyDate, parsedHeader, confidence } = resolveHotspots(req.body || {});
    if (hotspots.length === 0) return res.status(400).json({ success: false, error: 'No hot-spots found. Provide rows or report text.' });
    const graded = grade(hotspots);
    const deficient = graded.filter((g) => g.severity).length;
    // Response is ADDITIVE: surveyDate/hotspots/deficienciesToCreate are the
    // pre-§7.4 contract; header + confidence are new so the capture form can
    // pre-fill and flag what the parser could not read.
    return res.json({
      success: true,
      data: {
        surveyDate,
        hotspots: graded,
        deficienciesToCreate: deficient,
        header: resolveHeader(req.body || {}, parsedHeader),
        confidence,
      },
    });
  } catch (err: any) {
    console.error('[thermography/preview]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to read the IR report' });
  }
});

// ── POST /:id/thermography/commit ────────────────────────────────────────────
// Accepts JSON, or multipart/form-data with `file` (the IR report PDF) and
// `payload` (the JSON body as a string).
router.post('/:id/thermography/commit', requireThermographyFeature, requireManager, evidenceUploadMw, async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const body = readPayload(req);
    const { hotspots, surveyDate, parsedHeader } = resolveHotspots(body);
    if (hotspots.length === 0) return res.status(400).json({ success: false, error: 'No hot-spots to record.' });
    const graded = grade(hotspots);
    const header = resolveHeader(body, parsedHeader);
    const accountId = req.user.accountId;

    const parsedDate = surveyDate ? new Date(surveyDate) : new Date();
    const surveyAt = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
    const stamp = ` (${surveyAt.toISOString().slice(0, 10)})`;

    // A service-account principal (D2, req.user.id = 'svc_<keyId>') is not a
    // real User row, so it cannot own an FK. createdById is nullable — leave it
    // null rather than violating the constraint.
    const actorId: string | null = String(req.user.id || '').startsWith('svc_') ? null : req.user.id;

    // ── Evidence upload happens BEFORE the transaction (external call) ───────
    // Non-fatal, matching routes/assetPhotoInspect.ts:278-288: a storage hiccup
    // must not cost the tech the survey they just captured.
    let evidence: { filename: string; storageKey: string; fileType: string } | null = null;
    if (req.file && actorId) {
      try {
        const ext = MIME_EXT[String(req.file.mimetype || '').toLowerCase()] || 'pdf';
        const filename = `ir-survey-${surveyAt.toISOString().slice(0, 10)}-${Date.now()}.${ext}`;
        const { storageKey } = await uploadFile(accountId, asset.id, filename, req.file.buffer, req.file.mimetype);
        evidence = { filename, storageKey, fileType: req.file.mimetype };
      } catch (persistErr: any) {
        console.error('[thermography/commit] evidence upload failed (non-fatal):', persistErr?.message || persistErr);
      }
    } else if (req.file && !actorId) {
      // Document.uploadedBy is a required FK to users; a service key has no row.
      console.error('[thermography/commit] evidence skipped: service-account principal cannot own a Document');
    }

    const bySeverity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
    const toCreate = graded.filter((g) => g.severity);

    const result = await prisma.$transaction(async (tx: any) => {
      let sourceDocumentId: string | null = null;
      if (evidence) {
        const doc = await tx.document.create({
          data: {
            accountId,
            assetId:    asset.id,
            filename:   evidence.filename,
            filePath:   evidence.storageKey,
            fileType:   evidence.fileType,
            docType:    'ir_survey',
            uploadedBy: actorId as string,
          },
          select: { id: true },
        });
        sourceDocumentId = doc.id;
      }

      const survey = await tx.thermographySurvey.create({
        data: {
          accountId,
          assetId:           asset.id,
          surveyDate:        surveyAt,
          thermographerName: header.thermographerName,
          thermographerQual: header.thermographerQual,
          cameraMake:        header.cameraMake,
          cameraModel:       header.cameraModel,
          ambientTempC:      header.ambientTempC,
          humidityPct:       header.humidityPct,
          emissivity:        header.emissivity,
          reflectedTempC:    header.reflectedTempC,
          loadPercent:       header.loadPercent,
          notes:             header.notes,
          sourceDocumentId,
          createdById:       actorId,
        },
        select: { id: true },
      });

      let deficienciesCreated = 0;
      for (const g of graded) {
        let deficiencyId: string | null = null;
        if (g.severity) {
          bySeverity[g.severity] += 1;
          const correctiveAction = g.priority === 1
            ? 'Repair immediately — investigate the connection/component and re-scan after correction.'
            : 'Plan corrective work and re-scan to confirm the rise has cleared.';
          const def = await tx.deficiency.create({
            data: {
              accountId, assetId: asset.id, severity: g.severity,
              // [NETA-8-15] Carry the reference frame so a bare ΔT is interpretable
              // (over-ambient vs. similar-component graded on different NETA scales).
              description: `IR hot-spot${stamp}: ${g.location} — ΔT ${g.deltaT}°C ${REF_LABEL[g.reference] || REF_LABEL.similar} (${g.label})${g.note ? `. ${g.note}` : ''}`,
              correctiveAction,
            },
            select: { id: true },
          });
          deficiencyId = def.id;
          deficienciesCreated += 1;
        }
        // Every hot spot becomes a finding — including below-threshold ones
        // (severity null), which is the whole point of the structured record.
        await tx.thermographyFinding.create({
          data: {
            accountId,
            assetId:          asset.id,
            surveyId:         survey.id,
            component:        String(g.location || 'Unspecified location').slice(0, 160),
            deltaT:           g.deltaT,
            referenceType:    g.refStored,
            referenceDeltaT:  g.referenceDeltaT ?? null,
            loadPercent:      g.loadPercent ?? header.loadPercent,
            emissivity:       g.emissivity ?? header.emissivity,
            severity:         g.severity,
            severityLabel:    g.label || null,
            correctiveAction: g.severity
              ? (g.priority === 1
                  ? 'Repair immediately — investigate the connection/component and re-scan after correction.'
                  : 'Plan corrective work and re-scan to confirm the rise has cleared.')
              : null,
            deficiencyId,
          },
        });
      }
      return { surveyId: survey.id, sourceDocumentId, deficienciesCreated };
    }, {
      // A large survey writes 2 rows per hot spot sequentially (the finding has
      // to carry the deficiency id), which can outrun Prisma's 5 s interactive
      // default on a big report.
      timeout: 30_000,
      maxWait: 10_000,
    });

    return res.status(201).json({
      success: true,
      data: {
        surveyId:            result.surveyId,
        hotspotsLogged:      hotspots.length,
        findingsCreated:     graded.length,
        deficienciesCreated: result.deficienciesCreated,
        belowThreshold:      graded.length - toCreate.length,
        evidenceAttached:    Boolean(result.sourceDocumentId),
        evidenceDocumentId:  result.sourceDocumentId,
        bySeverity,
        hotspots: graded,
      },
    });
  } catch (err: any) {
    console.error('[thermography/commit]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to record the IR survey' });
  }
});

// ── DELETE /:id/thermography/surveys/:surveyId ───────────────────────────────
// Undo a survey import — the ThermographySurvey, all of its
// ThermographyFinding rows, and every Deficiency those findings created.
// Added 2026-07-23 alongside the DUPE-IR-1 fix above, since a bad/duplicate
// import previously had no way back except manually resolving each spawned
// deficiency one at a time and living with the orphaned duplicate finding
// rows in the survey history forever (no DELETE endpoint existed at all).
// requireManager-gated like commit; this is a real evidence deletion, so it
// writes a tamper-evident-adjacent activity-log entry the same way
// documents.ts DELETE and workOrders.ts measurement DELETE do — deleting
// compliance evidence must leave a trail, never happen silently.
router.delete('/:id/thermography/surveys/:surveyId', requireThermographyFeature, requireManager, async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const accountId = req.user.accountId;

    const survey = await prisma.thermographySurvey.findFirst({
      where: { id: req.params.surveyId, accountId, assetId: asset.id },
      include: { findings: { select: { id: true, component: true, deltaT: true, severity: true, deficiencyId: true } } },
    });
    if (!survey) return res.status(404).json({ success: false, error: 'Survey not found' });

    const deficiencyIds: string[] = survey.findings.map((f: any) => f.deficiencyId).filter(Boolean);

    await prisma.$transaction(async (tx: any) => {
      // ThermographyFinding.survey has onDelete: Cascade, so this also
      // removes every finding row. It does NOT touch the Deficiency rows
      // those findings pointed to (Finding -> Deficiency is not cascading in
      // either direction), so those are deleted explicitly next, once the
      // findings that referenced them are already gone.
      await tx.thermographySurvey.delete({ where: { id: survey.id } });
      if (deficiencyIds.length) {
        await tx.deficiency.deleteMany({ where: { id: { in: deficiencyIds }, accountId } });
      }
    });

    // sourceDocumentId (the attached IR report PDF, if any) is deliberately
    // left in place — it's a Document row like any other upload, and hard-
    // deleting it would additionally need to reason about storage cleanup
    // this route doesn't otherwise touch. Worst case it's an orphaned
    // evidence file in the Documents list, not a dangling reference.
    writeActivityLog({
      userId: req.user.id, accountId, assetId: asset.id,
      action: 'thermography_survey_deleted',
      details: {
        surveyId: survey.id,
        surveyDate: survey.surveyDate,
        findingsRemoved: survey.findings.map((f: any) => ({
          component: f.component, deltaT: dec(f.deltaT), severity: f.severity,
        })),
        deficienciesRemoved: deficiencyIds.length,
      },
    });

    return res.json({
      success: true,
      data: { findingsRemoved: survey.findings.length, deficienciesRemoved: deficiencyIds.length },
    });
  } catch (err: any) {
    console.error('[thermography/surveys DELETE]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to delete the IR survey' });
  }
});

// ── GET /:id/thermography/history ────────────────────────────────────────────
// Surveys for one asset, newest first, each with its findings, plus a
// per-component trend series so the asset panel can draw an arrow/sparkline
// showing whether a given lug/joint is getting hotter survey over survey.
router.get('/:id/thermography/history', requireThermographyFeature, async (req: any, res: any) => {
  try {
    const asset = await ownAsset(req);
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const surveys = await prisma.thermographySurvey.findMany({
      where:   { accountId: req.user.accountId, assetId: asset.id },
      orderBy: { surveyDate: 'desc' },
      include: {
        findings:       { orderBy: { deltaT: 'desc' } },
        createdBy:      { select: { id: true, name: true } },
        sourceDocument: { select: { id: true, filename: true } },
      },
    });

    // component → readings sorted oldest-first, so the client can compare the
    // last two points without re-sorting.
    const trendMap = new Map<string, Array<{ surveyId: string; surveyDate: Date; deltaT: number | null; severity: any }>>();
    for (const s of surveys) {
      for (const f of s.findings) {
        const key = f.component;
        if (!trendMap.has(key)) trendMap.set(key, []);
        trendMap.get(key)!.push({ surveyId: s.id, surveyDate: s.surveyDate, deltaT: dec(f.deltaT), severity: f.severity });
      }
    }
    const trends = [...trendMap.entries()]
      .map(([component, points]) => ({
        component,
        points: points.slice().sort((a, b) => a.surveyDate.getTime() - b.surveyDate.getTime()),
      }))
      .sort((a, b) => a.component.localeCompare(b.component));

    return res.json({
      success: true,
      data: { surveys: surveys.map(shapeSurvey), trends },
    });
  } catch (err: any) {
    console.error('[thermography/history]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to load IR history' });
  }
});

module.exports = router;
