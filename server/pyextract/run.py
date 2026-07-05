"""
run.py -- stdin/argv entrypoint the Node test-report ingest shells out to.

    python3 run.py <pdf_path>

Prints a single JSON line: {"ok": true, "fields": {...}, "measurements": [...],
"has_text_layer": bool}. On any failure prints {"ok": false, "error": "..."} and
exits 0 so the caller falls open to the existing pdfjs parser.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: run.py <pdf>"})); return
    path = sys.argv[1]
    try:
        from extractor import extract_fields, has_text_layer
    except Exception as e:
        print(json.dumps({"ok": False, "error": "import: %s" % e})); return
    try:
        has_text = has_text_layer(path)
        r = extract_fields(path)
        fields = {k: v["value"] for k, v in r["fields"].items()}
        print(json.dumps({
            "ok": True,
            "fields": fields,
            "measurements": r["measurements"],
            "has_text_layer": has_text,
            "ocr": bool(r.get("ocr")),
            "asset_sections": r.get("asset_sections", 1),
            "sections": r.get("sections", []),
            "page_count": r.get("page_count"),
            "pages_scanned": r.get("pages_scanned"),
            "text_pages": r.get("text_pages"),
            "truncated": bool(r.get("truncated")),
            # 2026-07-05 fix: extract_fields() has returned these two keys
            # since commit 83cb831 ("report-verdict + temp-correction
            # validators activated"), but this CLI entrypoint never forwarded
            # them -- testReportPreview.ts:178/182 read py.report_result /
            # py.ambient_temp_c directly off this JSON, so both were always
            # undefined -> reportResult/ambientTempC always null in
            # production, silently disabling domainValidators.verdictCrossCheck
            # and .tempCorrection for every report that goes through the
            # deterministic (non-AI) path. No jest suite caught this because
            # testReportPreview's own tests mock runDeterministic() entirely
            # (so they exercise the merge logic against an already-correct
            # fixture, never the real run.py subprocess).
            "report_result": r.get("report_result"),
            "ambient_temp_c": r.get("ambient_temp_c"),
        }, default=str))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))


if __name__ == "__main__":
    main()
