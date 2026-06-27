#!/usr/bin/env python3
"""
audit_pdf.py - automated layout QA for generated PDFs.

Checks each page of every PDF for:
  - OVERLAP: two text spans whose bounding boxes physically intersect (text
             drawn on top of text). Tiered by intersection as a fraction of the
             smaller span: >=35% reads as a genuine collision (ERROR, fails the
             gate); 22-35% is usually tight label-above-value stacking (WARN).
  - BLANK:   a near-empty page (stray content, almost no text).
  - OOB:     text that extends past the page edges (clipped / bleeding).

Exit code is non-zero if any ERROR-level finding is present, so it can gate a
deploy / CI step. Renders a contact-sheet PNG per PDF for human review.

Requires: pymupdf (fitz). Pillow optional (for the tiled contact sheet).

Usage:
  python3 audit_pdf.py <file.pdf> [more.pdf ...] [--png-dir DIR]
"""
import sys, os
import fitz

OVERLAP_WARN_RATIO = 0.22
OVERLAP_ERR_RATIO  = 0.35
MIN_SPAN_CHARS     = 2
NEAR_BLANK_CHARS   = 40
EDGE_EPS           = 1.5


def _area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _intersection(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    return (x1 - x0) * (y1 - y0)


def _spans(page):
    out = []
    for blk in page.get_text("dict")["blocks"]:
        for line in blk.get("lines", []):
            for s in line["spans"]:
                t = s["text"].strip()
                if len(t) >= MIN_SPAN_CHARS:
                    out.append((tuple(s["bbox"]), t))
    return out


def audit_page(page):
    findings = []
    pw, ph = page.rect.width, page.rect.height
    spans = _spans(page)
    seen = set()
    for i in range(len(spans)):
        bi, ti = spans[i]
        ai = _area(bi)
        for j in range(i + 1, len(spans)):
            bj, tj = spans[j]
            inter = _intersection(bi, bj)
            if inter <= 0:
                continue
            ratio = inter / max(1.0, min(ai, _area(bj)))
            if ratio < OVERLAP_WARN_RATIO:
                continue
            key = tuple(sorted((ti[:24], tj[:24])))
            if key in seen:
                continue
            seen.add(key)
            level = "ERROR" if ratio >= OVERLAP_ERR_RATIO else "WARN"
            findings.append((level, 'text overlap (%d%%): "%s"  vs  "%s"' % (round(ratio * 100), ti[:32], tj[:32])))
    for b, t in spans:
        if b[0] < -EDGE_EPS or b[1] < -EDGE_EPS or b[2] > pw + EDGE_EPS or b[3] > ph + EDGE_EPS:
            findings.append(("WARN", 'text outside page bounds: "%s"' % t[:32]))
    txt = page.get_text().strip()
    if len(txt) < NEAR_BLANK_CHARS:
        findings.append(("WARN", 'near-blank page (only %d chars: "%s")' % (len(txt), txt[:30])))
    return findings


def contact_sheet(doc, path, cols=3, dpi=70):
    try:
        from PIL import Image
    except Exception:
        for i, pg in enumerate(doc):
            pg.get_pixmap(dpi=dpi).save(path.replace(".png", "_p%d.png" % (i + 1)))
        return path.replace(".png", "_p1.png")
    pix = [p.get_pixmap(dpi=dpi) for p in doc]
    imgs = [Image.frombytes("RGB", (p.width, p.height), p.samples) for p in pix]
    if not imgs:
        return None
    cw = max(i.width for i in imgs) + 10
    rh = max(i.height for i in imgs) + 10
    rows = (len(imgs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw + 10, rows * rh + 10), "white")
    for idx, im in enumerate(imgs):
        r, c = divmod(idx, cols)
        sheet.paste(im, (10 + c * cw, 10 + r * rh))
    sheet.save(path)
    return path


def main():
    args, png_dir, argv, i = [], None, sys.argv[1:], 0
    while i < len(argv):
        a = argv[i]
        if a == "--png-dir":
            png_dir = argv[i + 1] if i + 1 < len(argv) else None
            i += 2
            continue
        if a.startswith("--"):
            i += 1
            continue
        args.append(a)
        i += 1
    total_err = total_warn = 0
    for pdf in args:
        doc = fitz.open(pdf)
        name = os.path.basename(pdf)
        print("\n=== %s  (%d pages) ===" % (name, doc.page_count))
        errs = warns = 0
        for i, page in enumerate(doc):
            for level, msg in audit_page(page):
                if level == "ERROR":
                    errs += 1
                    print("  ERROR  p%d: %s" % (i + 1, msg))
                else:
                    warns += 1
                    print("  warn   p%d: %s" % (i + 1, msg))
        if errs == 0:
            print("  OK - no ERROR findings (%d warn)" % warns)
        total_err += errs
        total_warn += warns
        if png_dir:
            out = os.path.join(png_dir, name.replace(".pdf", "_sheet.png"))
            sheet = contact_sheet(doc, out)
            if sheet:
                print("  contact sheet: %s" % sheet)
    print("\nTOTAL: %d ERROR, %d warn" % (total_err, total_warn))
    sys.exit(1 if total_err else 0)


if __name__ == "__main__":
    main()
