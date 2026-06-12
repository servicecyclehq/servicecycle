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
        }, default=str))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))


if __name__ == "__main__":
    main()
