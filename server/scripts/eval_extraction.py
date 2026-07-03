#!/usr/bin/env python3
"""
eval_extraction.py -- golden-set accuracy harness for the test-report extractor.

Renders each synthetic report in neta_synthetic_test_reports.json to a REAL PDF
at its quality tier, runs it through the deterministic extractor (extractor.py),
and scores field-level + measurement-level accuracy against groundTruth. This is
the regression gate the ingestion review calls for: no OCR/table tooling swap
should ship without moving these numbers on a labelled corpus.

Quality tiers (from each record's "textQuality"):
  clean    -> digital text-layer PDF in a PowerDB-like monospace layout
  degraded -> rendered to image, ~150 DPI, slight skew + JPEG artefacts,
              rebuilt as an image-only PDF (a light scan simulation)
  garbled  -> harsher: ~100 DPI, more skew, gaussian noise, heavy JPEG

Deterministic extraction only (no AI / no network), so results are reproducible.
The AI gap-fill and the TS confidence gate / domain validators are exercised by
their own jest suites; this harness measures the extractor those layers sit on.

Usage:
  eval_extraction.py --reports <json> --extractor-dir <dir> --workdir <dir> \
                     --out <baseline.md> [--tiers clean,degraded,garbled]
"""
import argparse
import io
import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random

try:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.lib.utils import ImageReader
except Exception as e:  # pragma: no cover
    sys.stderr.write("reportlab required: %s\n" % e)
    sys.exit(2)


# ---- rendering -------------------------------------------------------------

def _font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def render_clean_pdf(text, path):
    """Digital text-layer PDF: real, selectable text the extractor reads directly."""
    c = rl_canvas.Canvas(path, pagesize=letter)
    width, height = letter
    c.setFont("Courier", 8)
    x, y = 40, height - 40
    for line in text.split("\n"):
        if y < 40:
            c.showPage(); c.setFont("Courier", 8); y = height - 40
        c.drawString(x, y, line[:120])
        y -= 10
    c.showPage()
    c.save()


def _text_to_image(text, dpi, jitter):
    """Rasterize report text to a page image (no text layer)."""
    scale = dpi / 72.0
    W, H = int(8.5 * dpi), int(11 * dpi)
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    fnt = _font(int(9 * scale))
    x, y = int(40 * scale / 72 * 72), int(30 * scale)
    lh = int(13 * scale)
    for line in text.split("\n"):
        d.text((int(30 * scale), y), line[:120], fill=(15, 15, 15), font=fnt)
        y += lh
        if y > H - lh:
            break
    return img


def render_image_pdf(text, path, dpi=150, rotate=1.0, noise=0, jpeg_q=55):
    """Image-only PDF: forces the OCR path. Applies skew, JPEG artefacts, noise."""
    img = _text_to_image(text, dpi, jitter=rotate)
    if rotate:
        img = img.rotate(rotate, expand=False, fillcolor=(255, 255, 255), resample=Image.BICUBIC)
    if noise:
        px = img.load()
        rnd = random.Random(1234)
        W, H = img.size
        for _ in range(int(W * H * noise / 100)):
            xx, yy = rnd.randrange(W), rnd.randrange(H)
            v = rnd.randrange(256)
            px[xx, yy] = (v, v, v)
    # JPEG round-trip to bake in compression artefacts
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=jpeg_q)
    buf.seek(0)
    img = Image.open(buf).convert("RGB")

    c = rl_canvas.Canvas(path, pagesize=letter)
    width, height = letter
    c.drawImage(ImageReader(img), 0, 0, width=width, height=height)
    c.showPage()
    c.save()


def render(report, path):
    tier = report.get("textQuality", "clean")
    text = report.get("extractedText", "")
    if tier == "clean":
        render_clean_pdf(text, path)
    elif tier == "partial_ocr":
        render_image_pdf(text, path, dpi=150, rotate=1.0, noise=0, jpeg_q=55)
    else:  # garbled_ocr / anything else
        render_image_pdf(text, path, dpi=100, rotate=2.0, noise=3, jpeg_q=30)
    return tier


# ---- scoring ---------------------------------------------------------------

def _num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except Exception:
        return None


def _norm_str(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def score_fields(extracted, gt):
    """serialNumber / manufacturer / model exact-ish match. Returns (hits, total)."""
    keys = ["serialNumber", "manufacturer", "model"]
    hits = 0
    total = 0
    detail = {}
    for k in keys:
        want = gt.get(k)
        if not want:
            continue
        total += 1
        got = extracted.get("fields", {}).get(k)
        ok = _norm_str(got) == _norm_str(want) and _norm_str(want) != ""
        detail[k] = ok
        if ok:
            hits += 1
    return hits, total, detail


def score_measurements(extracted, gt, tol=0.001):
    """
    Match extracted measurements to groundTruth by measurementType, then value.
    Value-exact = within tol (relative). Returns recall/precision/value-exact.
    """
    gt_ms = gt.get("measurements", [])
    ex_ms = extracted.get("measurements", [])
    ex_pool = list(ex_ms)
    matched = 0
    value_exact = 0
    for g in gt_ms:
        gt_type = g.get("measurementType")
        gv = _num(g.get("asFoundValue"))
        best = None
        for i, e in enumerate(ex_pool):
            if e.get("measurementType") != gt_type:
                continue
            ev = _num(e.get("asFoundValue"))
            if gv is None or ev is None:
                best = i
                break
            if abs(ev - gv) <= max(tol * abs(gv), 0.01):
                best = i
                break
        if best is not None:
            matched += 1
            e = ex_pool.pop(best)
            ev = _num(e.get("asFoundValue"))
            if gv is not None and ev is not None and abs(ev - gv) <= max(tol * abs(gv), 0.01):
                value_exact += 1
    recall = matched / len(gt_ms) if gt_ms else 1.0
    precision = matched / len(ex_ms) if ex_ms else (1.0 if not gt_ms else 0.0)
    vex = value_exact / len(gt_ms) if gt_ms else 1.0
    return dict(gt=len(gt_ms), ex=len(ex_ms), matched=matched,
                recall=recall, precision=precision, value_exact=vex)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reports", required=True)
    ap.add_argument("--extractor-dir", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tiers", default="clean,partial_ocr,garbled_ocr")
    args = ap.parse_args()

    sys.path.insert(0, os.path.abspath(args.extractor_dir))
    from extractor import extract_fields  # noqa: E402

    with open(args.reports, "r", encoding="utf-8") as f:
        reports = json.load(f)
    tiers = set(args.tiers.split(","))
    os.makedirs(args.workdir, exist_ok=True)

    rows = []
    for r in reports:
        tier = r.get("textQuality", "clean")
        if tier not in tiers:
            continue
        pdf_path = os.path.join(args.workdir, "%s.pdf" % r["id"])
        try:
            render(r, pdf_path)
        except Exception as e:
            rows.append(dict(id=r["id"], tier=tier, error="render: %s" % e))
            continue
        try:
            res = extract_fields(pdf_path)
            fields = {k: v.get("value") if isinstance(v, dict) else v
                      for k, v in (res.get("fields") or {}).items()}
            extracted = dict(fields=fields, measurements=res.get("measurements", []),
                             ocr=res.get("ocr"), page_count=res.get("page_count"),
                             text_pages=res.get("text_pages"))
        except Exception as e:
            rows.append(dict(id=r["id"], tier=tier, error="extract: %s" % e))
            continue
        gt = r.get("groundTruth", {})
        fh, ft, fdetail = score_fields(extracted, gt)
        ocr_ms = score_measurements(extracted, gt)
        # Parser baseline on the golden text (a perfect-OCR proxy), so the number
        # reflects the TEXT PARSER rather than synthetic-PDF render fidelity. The
        # deterministic grid parser leans on real PowerDB word geometry that a
        # simple reportlab render does not reproduce, so the PDF path understates
        # it; the text path isolates parser recall.
        try:
            import extractor as _ex
            ptext = (r.get("extractedText") or "").replace("Ω", "Ω").replace("μ", "µ")
            pmeas = _ex.extract_measurements([], [], ptext)
            parser = score_measurements({"measurements": pmeas}, gt)
        except Exception:
            parser = dict(gt=ocr_ms["gt"], ex=0, matched=0, recall=0.0, precision=0.0, value_exact=0.0)
        rows.append(dict(id=r["id"], tier=tier, ocr=bool(extracted.get("ocr")),
                         field_hits=fh, field_total=ft, gt=ocr_ms["gt"],
                         parser_recall=parser["recall"], parser_vex=parser["value_exact"],
                         parser_matched=parser["matched"], parser_ex=parser["ex"],
                         ocr_recall=ocr_ms["recall"]))

    write_report(rows, tiers, args.out, args.reports)
    # console summary
    for t in ["clean", "partial_ocr", "garbled_ocr"]:
        tr = [x for x in rows if x.get("tier") == t and "parser_recall" in x]
        if tr:
            prec = sum(x["parser_recall"] for x in tr) / len(tr)
            orec = sum(x["ocr_recall"] for x in tr) / len(tr)
            print("%-9s n=%d  parser_recall=%.0f%%  ocr_path_recall=%.0f%%" % (
                t, len(tr), prec * 100, orec * 100))
    errs = [x for x in rows if x.get("error")]
    if errs:
        print("errors:", len(errs))


def pct(x):
    return "%.0f%%" % (x * 100)


def write_report(rows, tiers, out, reports_path):
    lines = []
    lines.append("# Extraction Accuracy Baseline — golden set")
    lines.append("")
    lines.append("Generated by `server/scripts/eval_extraction.py` against "
                 "`%s`." % os.path.basename(reports_path))
    lines.append("Deterministic extractor only (no AI, no network). Reproducible.")
    lines.append("")
    lines.append("Two measurement numbers are reported. **Parser recall** feeds the")
    lines.append("golden text straight into the extractor's text passes (a perfect-OCR")
    lines.append("proxy) and is the real signal for the deterministic parser. **OCR-path")
    lines.append("recall** renders each report to a PDF and runs the full pipeline; the")
    lines.append("deterministic grid parser depends on real PowerDB word geometry that a")
    lines.append("synthetic reportlab render does not reproduce, so OCR-path recall")
    lines.append("understates real-PDF performance and is a floor, not a true measure.")
    lines.append("")
    lines.append("## Per-tier summary")
    lines.append("")
    lines.append("| Tier | Reports | Parser recall | Parser value-exact | Field acc | OCR-path recall |")
    lines.append("|---|---|---|---|---|---|")
    for t in ["clean", "partial_ocr", "garbled_ocr"]:
        tr = [x for x in rows if x.get("tier") == t and "parser_recall" in x]
        if not tr:
            continue
        prec = sum(x["parser_recall"] for x in tr) / len(tr)
        pvex = sum(x["parser_vex"] for x in tr) / len(tr)
        orec = sum(x["ocr_recall"] for x in tr) / len(tr)
        fa_num = sum(x["field_hits"] for x in tr)
        fa_den = sum(x["field_total"] for x in tr) or 1
        lines.append("| %s | %d | %s | %s | %s | %s |" % (
            t, len(tr), pct(prec), pct(pvex), pct(fa_num / fa_den), pct(orec)))
    lines.append("")
    lines.append("## Per-report detail")
    lines.append("")
    lines.append("| Report | Tier | GT | Parser matched | Parser recall | Value-exact | Fields | OCR-path recall |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for x in rows:
        if x.get("error"):
            lines.append("| %s | %s | - | - | - | - | - | ERR: %s |" % (
                x["id"], x["tier"], x["error"][:60]))
            continue
        lines.append("| %s | %s | %d | %d | %s | %s | %d/%d | %s |" % (
            x["id"], x["tier"], x["gt"], x["parser_matched"],
            pct(x["parser_recall"]), pct(x["parser_vex"]), x["field_hits"], x["field_total"],
            pct(x["ocr_recall"])))
    lines.append("")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("wrote", out)


if __name__ == "__main__":
    main()
