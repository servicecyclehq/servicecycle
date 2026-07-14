#!/usr/bin/env python3
"""
W1 native-PDF splitter via pypdfium2 (already in the image; NO AI tokens).

The native-PDF arc-flash path sends the whole PDF to the model in one call. When
a report is dense enough to risk the model's output-token ceiling, the Node
caller cuts it into OVERLAPPING page windows and sends each window's sub-PDF
natively, then merges the extractions by bus name. Overlap guarantees a table
that straddles a window seam is whole in at least one window, so no bus is lost
or split at a chunk boundary.

Best-effort: prints one JSON line; {"ok": false} on any failure so ingest can
always fall back to the deterministic text/vision path.

Usage:
  pdf_split.py <in.pdf> count
  pdf_split.py <in.pdf> split <out_prefix> <ranges>
      ranges = "1-2,2-3,3-4"  (1-based, inclusive page ranges)
      writes <out_prefix>-0.pdf, <out_prefix>-1.pdf, ... in range order
"""
import sys
import json


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False}))
        return 2
    pdf_path = sys.argv[1]
    mode = sys.argv[2]

    import pypdfium2 as pdfium  # imported here so an import error fails open below

    src = pdfium.PdfDocument(pdf_path)
    pages = len(src)

    if mode == "count":
        print(json.dumps({"ok": True, "pages": pages}))
        return 0

    if mode == "split":
        if len(sys.argv) < 5:
            print(json.dumps({"ok": False}))
            return 2
        out_prefix = sys.argv[3]
        ranges = sys.argv[4]
        files = []
        for idx, part in enumerate(r for r in ranges.split(",") if r.strip()):
            a_s, b_s = part.split("-")
            a = max(1, int(a_s))
            b = min(pages, int(b_s))
            if b < a:
                continue
            dst = pdfium.PdfDocument.new()
            dst.import_pages(src, pages=list(range(a - 1, b)))
            out = "%s-%d.pdf" % (out_prefix, idx)
            dst.save(out)
            dst.close()
            files.append(out)
        print(json.dumps({"ok": True, "pages": pages, "files": files}))
        return 0

    print(json.dumps({"ok": False}))
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure is a clean fail-open
        sys.stderr.write("pdf_split failed: %s\n" % exc)
        print(json.dumps({"ok": False}))
        sys.exit(1)
