#!/usr/bin/env python3
"""
Deterministic PDF text + table extraction via pdfplumber (NO AI tokens).

The arc-flash text path's first pass: pdfplumber is far stronger on the ruled
tables a study report is full of than the pdfjs fallback, and confirms there IS
a usable text layer so the expensive vision path only fires as a true last
resort. The extracted tables are handed to the AI as the high-value payload so
we send fewer, more focused tokens.

Best-effort: prints one line of JSON {ok, text, tables} on success, {ok:false}
on any failure (the Node caller then falls back to pdfjs, so a missing runtime
can never break ingest).

Usage: pdf_text.py <pdf_path> [max_pages=30]
"""
import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False}))
        return 2
    pdf_path = sys.argv[1]
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 30

    import pdfplumber  # imported here so an import error is caught below

    texts = []
    tables = []
    with pdfplumber.open(pdf_path) as pdf:
        n = min(len(pdf.pages), max_pages)
        for i in range(n):
            page = pdf.pages[i]
            t = page.extract_text() or ""
            if t:
                texts.append(t)
            for tbl in (page.extract_tables() or []):
                rows = []
                for row in tbl:
                    if not row:
                        continue
                    cells = [(c or "").strip() for c in row]
                    if any(cells):
                        rows.append(cells)
                if rows:
                    tables.append(rows)

    print(json.dumps({"ok": True, "text": "\n".join(texts), "tables": tables}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure is a clean fail-open
        sys.stderr.write("pdf_text failed: %s\n" % exc)
        print(json.dumps({"ok": False}))
        sys.exit(1)
