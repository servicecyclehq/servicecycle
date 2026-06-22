#!/usr/bin/env python3
"""
Rasterize the first N pages of a PDF to PNG images for arc-flash vision ingest.

Used when an uploaded one-line PDF has no text layer (scanned or vector CAD) so
the BYO-AI vision path can read it without the user converting anything by hand.

Uses pypdfium2 (PDFium — the same renderer Chrome uses; already in the server
image) + Pillow. Best-effort: prints the number of pages written on success,
exits non-zero on any failure so the Node caller degrades gracefully.

Usage: rasterize_pdf.py <pdf_path> <out_prefix> [max_pages=4] [scale_to_px=2000]
Writes <out_prefix>-1.png, <out_prefix>-2.png, ...
"""
import sys


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: rasterize_pdf.py <pdf> <prefix> [max_pages] [scale_to]\n")
        return 2
    pdf_path = sys.argv[1]
    out_prefix = sys.argv[2]
    max_pages = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    scale_to = int(sys.argv[4]) if len(sys.argv) > 4 else 2000

    import pypdfium2 as pdfium  # imported here so import errors are caught below

    pdf = pdfium.PdfDocument(pdf_path)
    n = min(len(pdf), max_pages)
    written = 0
    for i in range(n):
        page = pdf[i]
        size = page.get_size()  # (width, height) in points
        longest = max(size[0], size[1]) or 1.0
        scale = float(scale_to) / longest
        # Clamp so a tiny page isn't blown up absurdly and a huge one isn't tiny.
        scale = max(0.5, min(scale, 6.0))
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
        image.save("%s-%d.png" % (out_prefix, i + 1))
        written += 1
    print(written)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure must be a clean non-zero exit
        sys.stderr.write("rasterize_pdf failed: %s\n" % exc)
        sys.exit(1)
