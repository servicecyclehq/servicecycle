"""
extractor.py -- deterministic, format-agnostic field + measurement extraction
from machine-readable test-report PDFs using pdfplumber word geometry.

Ported from the ServiceCycle deterministic invoice extractor (same engine: word
boxes -> column-cells split on horizontal gaps -> label-at-start matching ->
value to the right / below; ruled-table extraction via pdfplumber). The invoice
field library is replaced by neta_field_library (NETA/PowerDB measurement
vocabulary). No AI. Returns per field/measurement a parsed value + confidence.

Geometry beats raw text: flattening the text layer scrambles multi-column /
tabular layouts; pdfplumber gives every word an (x0, top, x1, bottom) box, which
is what makes "the value to the right of / directly below this label" and proper
table-cell association work across report designs.
"""

from __future__ import annotations

import re
import time
from datetime import datetime
from decimal import Decimal, InvalidOperation

import pdfplumber

from neta_field_library import (
    DTYPE_PATTERNS, MEASUREMENT_VOCAB, HEADER_FIELDS, MEASUREMENT_COLUMNS,
    RESULT_TOKENS, HEADER_STOPWORDS, normalize_unit,
    MEASUREMENT_LIBRARY, CRITICAL_TYPES, classify_label,
)

Y_TOL = 3.0
BELOW_X_TOL = 60.0
COL_GAP = 38.0   # horizontal gap wider than this starts a new column-cell
TYPED_RIGHT = {"date", "number", "percent", "id", "result"}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def clean_tok(t: str) -> str:
    core = t.lower().strip(".,:;")
    if core == "#":
        return "number"
    return core


def has_text_layer(path: str, min_chars: int = 40) -> bool:
    try:
        with pdfplumber.open(path) as pdf:
            chars = 0
            for page in pdf.pages[:3]:
                chars += len((page.extract_text() or ""))
                if chars >= min_chars:
                    return True
    except Exception:
        return False
    return False


def _mk_line(ws):
    ws = sorted(ws, key=lambda w: w["x0"])
    return {
        "top": min(w["top"] for w in ws),
        "x0": min(w["x0"] for w in ws),
        "x1": max(w["x1"] for w in ws),
        "words": ws,
        "tokens": [w["text"] for w in ws],
        "text": " ".join(w["text"] for w in ws),
    }


def _page_cells(page):
    """Split each visual row into column-cells on large horizontal gaps."""
    words = page.extract_words(use_text_flow=False, keep_blank_chars=False) or []
    words.sort(key=lambda w: (round(w["top"]), w["x0"]))
    rows, cur, cur_top = [], [], None
    for w in words:
        if cur_top is None or abs(w["top"] - cur_top) <= Y_TOL:
            cur.append(w)
            cur_top = w["top"] if cur_top is None else cur_top
        else:
            rows.append(cur)
            cur, cur_top = [w], w["top"]
    if cur:
        rows.append(cur)
    cells = []
    for row in rows:
        row = sorted(row, key=lambda w: w["x0"])
        seg = [row[0]]
        for prev, w in zip(row, row[1:]):
            if w["x0"] - prev["x1"] > COL_GAP:
                cells.append(_mk_line(seg))
                seg = [w]
            else:
                seg.append(w)
        cells.append(_mk_line(seg))
    return cells


_DATE_FORMATS = [
    "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%m-%d-%Y",
    "%d.%m.%Y", "%Y.%m.%d", "%d %b %Y", "%d %B %Y", "%b %d %Y", "%B %d %Y",
    "%b %d, %Y", "%B %d, %Y",
]


def parse_value(dtype: str, text: str):
    if text is None:
        return None
    pat = DTYPE_PATTERNS.get(dtype)
    m = pat.search(text) if pat else None
    if not m and dtype not in ("string", "result"):
        return None
    span = (m.group(0) if m else text).strip()

    if dtype == "date":
        cleaned = re.sub(r"(\d)(st|nd|rd|th)", r"\1", span, flags=re.I)
        for fmt in _DATE_FORMATS:
            try:
                return datetime.strptime(cleaned, fmt).date().isoformat()
            except ValueError:
                continue
        return None
    if dtype in ("number", "percent"):
        try:
            return float(re.sub(r"[^0-9.\-]", "", span))
        except ValueError:
            return None
    if dtype == "result":
        up = span.upper()
        for tok, norm in RESULT_TOKENS.items():
            if tok in up:
                return norm
        return None
    return span


# --- label-proximity + neighbour-cell matching (from the ServiceCycle engine) ---
def _matches_at_start(line, ltoks):
    toks = line["tokens"]
    if len(toks) < len(ltoks):
        return False
    for i, lt in enumerate(ltoks):
        if clean_tok(toks[i]) != lt:
            return False
    return True


def _value_after(line, start_idx):
    ws = line["words"][start_idx:]
    if not ws:
        return ""
    return " ".join(w["text"] for w in ws).strip(" :")


def _right_cell(cells, cell):
    cands = [c for c in cells if c is not cell
             and abs(c["top"] - cell["top"]) <= Y_TOL and c["x0"] >= cell["x1"] - 1]
    cands.sort(key=lambda c: c["x0"])
    return cands[0] if cands else None


def _below_cell(cells, cell, xtol=50):
    cands = [c for c in cells if c["top"] > cell["top"] + Y_TOL
             and abs(c["x0"] - cell["x0"]) <= xtol]
    cands.sort(key=lambda c: c["top"])
    return cands[0] if cands else None


# --- header / nameplate fields (serial, model, mfr, date, customer, …) -------
def _hdr_reject(raw):
    low = raw.lower().strip()
    if not low:
        return True
    toks = [t.strip(".,:;()") for t in re.split(r"[\s/]+", low) if t]
    if toks and all(t in HEADER_STOPWORDS or t == "" for t in toks):
        return True   # value is made entirely of label/boilerplate words
    return False


def _cut_allcaps(raw):
    """Stop a value at the next ALL-CAPS word (PowerDB labels/section headers
    are uppercase), so 'Ferranti Packard YEAR 1958 BUSHING' -> 'Ferranti Packard'."""
    toks = raw.split()
    keep = []
    for i, t in enumerate(toks):
        core = re.sub(r"[^A-Za-z]", "", t)
        if i > 0 and len(core) >= 3 and core.isupper():
            break
        keep.append(t)
    return " ".join(keep).strip(" ,.-:|")


def _hdr_valid(dtype, raw):
    raw = re.sub(r"\(cid:\d+\)", "", raw)
    raw = raw.strip(" :#-|.\t\r\n")
    if not raw or _hdr_reject(raw):
        return None
    if dtype == "date":
        return parse_value("date", raw)
    if dtype == "serial":
        # a real serial almost always carries a digit — rejects USED / Meter /
        # SHUNT / TYPE / "number" that the old regex grabbed off blank labels.
        tok = raw.split()[0].strip(",.;:")
        if not re.search(r"\d", tok) or not (3 <= len(tok) <= 40):
            return None
        return tok
    if dtype == "id":
        v = _cut_allcaps(raw.split("  ")[0].strip())
        return v if v and 1 <= len(v) <= 40 and not _hdr_reject(v) else None
    if dtype == "name":
        v = _cut_allcaps(raw)
        return v if v and 2 <= len(v) <= 60 and not _hdr_reject(v) else None
    return raw


def extract_header(cells, text):
    """Regex over the text layer with per-field validation. A value is captured
    after its label, STOPS at the next known label / 2-space gap / newline, and
    must pass a plausibility check for its type (serials need a digit; nothing
    made only of label/boilerplate words survives). Handles the
    several-pairs-per-line PowerDB nameplate layout."""
    stops = set()
    for f in HEADER_FIELDS:
        for lbl in f["labels"]:
            w = lbl.split()[0]
            if len(w) >= 2:
                stops.add(re.escape(w))
    stop_alt = "|".join(sorted(stops, key=len, reverse=True))
    out = {}
    for f in HEADER_FIELDS:
        if f["key"] in out:
            continue
        for lbl in f["labels"]:
            pat = re.compile(
                r"(?<![A-Za-z])" + re.escape(lbl) +
                r"\s*[:#]?\s*(.+?)(?=\s{2,}|\s+(?:" + stop_alt + r")\b\s*[:#]|[\r\n]|$)",
                re.I)
            m = pat.search(text)
            if not m:
                continue
            v = _hdr_valid(f["dtype"], m.group(1))
            if v:
                out[f["key"]] = {"value": v, "raw": m.group(1).strip(), "confidence": 0.85}
                break
    return out


# --- measurements ---
_PHASE_RE = re.compile(r"\bPh(?:ase)?\.?\s*([ABCN](?:-[ABCN])?)\b", re.I)
# connection / terminal tokens that encode a phase in NETA/PowerDB reports
_CONN_RE = re.compile(r"\b([HXLT]\d?-[A-Z0-9]{1,3}|[ABC]-[ABCGN])\b")
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
_NUM = r"-?\d[\d,]*(?:\.\d+)?"
_UNIT = (r"(?:M\s?Ω|MΩ|Mohm|megohm|kΩ|kohm|µΩ|uΩ|uohm|mΩ|mohm|Ω|ohm|ppm|kVDC|VDC|"
         r"kVAC|VAC|kV|kA|mA|sec|secs|ms|Hz|°C|°F|%|V|A)")
_INLINE_RE = re.compile(r"([A-Za-z][\w .,/&()+#-]{0,28}?)\s*[:=]?\s*(" + _NUM + r")\s*(" + _UNIT + r")(?![A-Za-z0-9])")
_EXPECT_RE = re.compile(r"(?:Expected|Limit|Min(?:imum)?|Spec|Acceptance|Nameplate)\.?\s*[:=]?\s*([<>]=?\s*[\d.]+\s*[A-Za-zΩµ%]*)", re.I)
_RESULT_RE = re.compile(r"\b(GREEN|YELLOW|RED|PASS(?:ED)?|FAIL(?:ED)?|MARGINAL|SAT|UNSAT|ACCEPTABLE|DEFICIENT)\b", re.I)

# Infer a measurementType from a unit when the label is unknown. Only the
# DIAGNOSTIC units (insulation/contact/winding resistance, DGA) get a semantic
# NETA type — those are unambiguous and safe to feed the trend/deficiency
# engine. Ambiguous units (V, A, %, Ω, Hz, °) get a GENERIC type so a stray
# voltage or ambient-temperature reading is never mistaken for a power-factor
# or insulation result. A real label (e.g. "Power Factor … %") still upgrades
# the type via MEASUREMENT_VOCAB before this fallback runs.
UNIT_TYPE = {
    "MΩ": ("insulation_resistance", False), "µΩ": ("contact_resistance", True),
    "mΩ": ("winding_resistance", False), "ppm": ("dissolved_gas", False),
    "kΩ": ("resistance", False), "Ω": ("resistance", False),
    "%": ("percent_reading", False),
    "V": ("voltage_reading", False), "VDC": ("voltage_reading", False),
    "kV": ("voltage_reading", False), "kVDC": ("voltage_reading", False),
    "A": ("current_reading", False), "mA": ("current_reading", False), "kA": ("current_reading", False),
    "sec": ("time_reading", False), "ms": ("time_reading", False), "Hz": ("frequency_reading", False),
    "°C": ("temperature_reading", False), "°F": ("temperature_reading", False),
}


def _label_in(text_low):
    for lbl in MEASUREMENT_VOCAB:
        if lbl in text_low:
            return lbl, MEASUREMENT_VOCAB[lbl]
    return None, None


def _phase_of(s):
    m = _PHASE_RE.search(s)
    if m:
        return m.group(1).upper()
    m = _CONN_RE.search(s)
    return m.group(1).upper() if m else None


def _classify(label, unit):
    """-> (measurementType, critical, unit, kind). The full MEASUREMENT_LIBRARY
    label match wins (correct NETA type + diagnostic/reference kind); else the
    clearly-diagnostic units get a semantic type; else ambiguous units become a
    generic *_reading marked REFERENCE so a stray voltage never reads as a test
    result; else a generic slug, reference."""
    nu = normalize_unit(unit) if unit else None
    e = classify_label(label)
    if e:
        crit = e["type"] in CRITICAL_TYPES
        return e["type"], crit, (nu or e["unit"]), e["kind"]
    # clearly-diagnostic units (unambiguous) → semantic type, diagnostic
    if nu == "MΩ":  return "insulation_resistance", False, nu, "D"
    if nu == "µΩ":  return "contact_resistance", True, nu, "D"
    if nu == "mΩ":  return "winding_resistance", False, nu, "D"
    if nu == "ppm": return "dissolved_gas", False, nu, "D"
    # ambiguous units → generic reading, REFERENCE (de-emphasized)
    if nu and nu in UNIT_TYPE:
        return UNIT_TYPE[nu][0], False, nu, "R"
    slug = re.sub(r"[^a-z0-9]+", "_", _norm(label)).strip("_")[:40] or "reading"
    return slug, False, nu, "R"


def _inline_readings(text):
    """General pass: every <label> <value> <unit> in the text layer. Captures
    real PowerDB / prose / load-bank readings the ruled-table pass misses."""
    out = []
    for m in _INLINE_RE.finditer(text):
        label = m.group(1).strip(" :=.-,/#")
        if not re.search(r"[A-Za-z]", label):
            continue
        label = " ".join(label.split()[-4:])  # keep the last few words, not a whole sentence
        try:
            val = float(m.group(2).replace(",", ""))
        except ValueError:
            continue
        unit = m.group(3)
        mt, crit, u, kind = _classify(label, unit)
        # Capture a trailing PASS/FAIL/GREEN-RED token on the SAME line. Borderless
        # reports (reportlab drawString, PowerDB prose) have no ruled cells, so the
        # _column_tables pass never sees the Result column — recover it here.
        _nl = text.find("\n", m.end())
        _tail = text[m.end(): _nl if _nl != -1 else len(text)]
        _rm = _RESULT_RE.search(_tail)
        pf = parse_value("result", _rm.group(0)) if _rm else None
        out.append({
            "measurementType": mt, "label": label.title(),
            "phase": _phase_of(label) or _phase_of(m.group(0)),
            "asFoundValue": val, "asFoundUnit": u,
            "expectedRange": None, "passFail": pf, "critical": crit,
            "kind": kind, "confidence": 0.6,
            # Character offset of this reading in the full text — used by the
            # multi-asset split (#1) to attribute the reading to the
            # SUBSTATION/POSITION section it physically sits under. Stripped
            # before the result leaves extract_measurements.
            "_off": m.start(),
        })
    return out


def _column_tables(page_tables):
    """Clean header->column tables (synthetic samples, EICR-style schedules)."""
    out = []
    for tbl in page_tables:
        if not tbl or len(tbl) < 2:
            continue
        header = [_norm(c or "") for c in tbl[0]]
        roles = {}
        for ci, htext in enumerate(header):
            for col in MEASUREMENT_COLUMNS:
                if any(lbl in htext for lbl in col["labels"]):
                    roles[ci] = col["role"]
                    break
        if "value" not in roles.values() and "result" not in roles.values():
            continue
        for row in tbl[1:]:
            rec = {"phase": None, "asFoundValue": None, "asFoundUnit": None,
                   "expectedRange": None, "passFail": None, "label": None}
            for ci, cell in enumerate(row):
                role = roles.get(ci)
                if not role or cell is None:
                    continue
                cv = str(cell).strip()
                if role == "description":
                    rec["label"] = cv
                elif role == "phase":
                    rec["phase"] = _phase_of(cv) or (cv[:1].upper() if cv[:1].upper() in "ABCN" else None)
                elif role == "value":
                    nm = _NUM_RE.search(cv)
                    rec["asFoundValue"] = float(nm.group(0)) if nm else None
                elif role == "unit":
                    rec["asFoundUnit"] = normalize_unit(cv)
                elif role == "expected":
                    rec["expectedRange"] = cv or None
                elif role == "result":
                    rec["passFail"] = parse_value("result", cv)
            if rec["label"] and (rec["asFoundValue"] is not None or rec["passFail"]):
                mt, crit, u, kind = _classify(rec["label"], rec["asFoundUnit"])
                rec["measurementType"] = mt
                rec["critical"] = crit
                rec["asFoundUnit"] = rec["asFoundUnit"] or u
                rec["phase"] = rec["phase"] or _phase_of(rec["label"])
                rec["kind"] = kind
                rec["confidence"] = 0.9
                out.append(rec)
    return out


# A NETA/PowerDB job report covers many devices, each opening with a
# "SUBSTATION <id> POSITION <id>" block. This is the boundary the one-upload =
# one-facility split (#1) keys on.
_SECTION_RE = re.compile(r"SUBSTATION\s+([\w.-]+)\s+POSITION\s+([\w.-]+)", re.I)


def _build_sections(text):
    """Parse the SUBSTATION/POSITION section structure of a report.

    A section header can repeat across continuation pages, so sections are
    CANONICALIZED by (substation, position) label in first-appearance order —
    every occurrence maps to one canonical section, never a duplicate. Returns
    (raw_spans, sections):
      raw_spans  ordered [{start, canon}] — each header occurrence + its
                 canonical section index, for offset → section attribution
      sections   deduped [{idx, substation, position, label}]
    Both empty for a single-asset report (no headers), leaving the legacy flat
    path completely unaffected."""
    raw_spans = []
    sections = []
    canon = {}
    for m in _SECTION_RE.finditer(text or ""):
        label = "%s / %s" % (m.group(1), m.group(2))
        if label not in canon:
            canon[label] = len(sections)
            sections.append({
                "idx": len(sections), "substation": m.group(1),
                "position": m.group(2), "label": label,
            })
        raw_spans.append({"start": m.start(), "canon": canon[label]})
    return raw_spans, sections


def _section_for_offset(off, raw_spans):
    """Canonical section index for a reading at char-offset `off`: the last
    header starting at or before it. Readings before the first header (report
    cover / global nameplate) attach to the first section; the human confirms
    in the split UI."""
    idx = 0
    for s in raw_spans:
        if s["start"] <= off:
            idx = s["canon"]
        else:
            break
    return idx


def extract_measurements(cells, page_tables, full_text=""):
    table_out = _column_tables(page_tables)              # clean column tables
    inline_out = _inline_readings(full_text)             # general value+unit pass
    combined = table_out + inline_out
    # Which (type, value, unit) triples already have a PHASED reading (from the
    # richer column-table pass) — used to drop the inline pass's phase-less
    # duplicate of the same value.
    phased = set()
    for m in combined:
        if m.get("phase"):
            phased.add((m.get("measurementType"), m.get("asFoundValue"), m.get("asFoundUnit")))
    combined.sort(key=lambda m: -m.get("confidence", 0))   # best first
    seen = set()
    out = []
    for m in combined:
        tvu = (m.get("measurementType"), m.get("asFoundValue"), m.get("asFoundUnit"))
        if not m.get("phase") and tvu in phased:
            continue   # inline duplicate of a phased column-table reading
        k = (m.get("measurementType"), m.get("phase"), m.get("asFoundValue"), m.get("asFoundUnit"))
        if k in seen:
            continue
        seen.add(k)
        out.append(m)

    # ── Multi-asset section attribution (#1) ──────────────────────────────────
    # Tag each surviving reading with the SUBSTATION/POSITION section it sits
    # under so the preview can split one upload into per-asset blocks. Only
    # happens when the report actually has section headers; a single-asset
    # report leaves `section` = None and the flat path is unchanged. Column-table
    # readings (no offset) attribute to the first section.
    raw_spans, _sections = _build_sections(full_text)
    for m in out:
        off = m.pop("_off", None)
        if raw_spans:
            m["section"] = _section_for_offset(off, raw_spans) if off is not None else 0
        else:
            m["section"] = None
    return out


# Per-stage page budgets, tuned so the WHOLE extraction stays well under the
# bridge timeout even on a CPU-limited container under load.
#
# The contradiction this fixes: a NETA/PowerDB job report covers many devices,
# each opening with a SUBSTATION…POSITION block. The old 18-page TEXT cap meant
# the multi-asset detector could see (and the UI warn about) only sections in
# the first 18 pages, AND every reading for a later device was silently dropped
# — the warning claimed "3 assets" while the extraction had quietly truncated
# two of them. The cheap text/inline pass is what feeds both section detection
# AND multi-asset readings, so it must cover the WHOLE document.
#
# So the cheap, high-value text pass now runs broadly (up to MAX_TEXT_PAGES,
# governed by a wall-clock budget so a pathological 400-page scan still bails
# before the bridge timeout). The EXPENSIVE passes — ruled-table line-detection
# (which barely helps real PowerDB key-value grids) and word-geometry cell
# splitting — stay capped to the early pages where the header/nameplate live.
# When the time budget forces us to stop early we report pages_scanned <
# page_count + truncated=True so the warning is always honest about coverage.
MAX_TEXT_PAGES = 200   # extract_text → inline value+unit pass (cheap) — covers full multi-asset jobs
MAX_CELL_PAGES = 4     # _page_cells → header extraction (nameplate is page 1-2)
MAX_TABLE_PAGES = 4    # extract_tables → column-table pass (expensive)
TEXT_TIME_BUDGET_S = 30.0  # stop the text sweep past this; leaves headroom under the 45s bridge timeout


OCR_PAGES = 3   # OCR is slow (render + tesseract); cap hard to stay under timeout


def _ocr_text(path, max_pages=OCR_PAGES):
    """Rasterize + OCR the first pages of a SCANNED (no text layer) PDF — gem
    W1. Deterministic (tesseract, no AI). Returns '' if the OCR toolchain is
    unavailable, so callers fail open exactly as before."""
    try:
        import pypdfium2 as pdfium
        import pytesseract
    except Exception:
        return ""
    out = []
    try:
        pdf = pdfium.PdfDocument(path)
        for i in range(min(len(pdf), max_pages)):
            pil = pdf[i].render(scale=2.0).to_pil()
            out.append(pytesseract.image_to_string(pil))
        pdf.close()
    except Exception:
        return ""
    return "\n".join(out)


def extract_fields(path: str, mode: str = "all"):
    cells, line_tables, full_text = [], [], []
    table_settings = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}
    page_count = 0
    pages_scanned = 0
    truncated = False
    started = time.monotonic()
    with pdfplumber.open(path) as pdf:
        page_count = len(pdf.pages)
        for i, page in enumerate(pdf.pages[:MAX_TEXT_PAGES]):
            # Cheap text sweep runs across the whole document so multi-asset
            # sections and their inline readings are never silently dropped —
            # but bail if the wall-clock budget is exhausted, recording that we
            # stopped short (truncated) rather than lying about coverage.
            if i > 0 and (time.monotonic() - started) > TEXT_TIME_BUDGET_S:
                truncated = True
                break
            full_text.append(page.extract_text() or "")
            pages_scanned = i + 1
            if i < MAX_CELL_PAGES:
                cells.extend(_page_cells(page))
            if i < MAX_TABLE_PAGES:
                try:
                    line_tables.extend(page.extract_tables(table_settings) or [])
                except Exception:
                    pass
    # If MAX_TEXT_PAGES itself (not the clock) capped a longer document, that's
    # also truncation — flag it so the UI/telemetry know coverage is partial.
    if pages_scanned < page_count:
        truncated = True
    text = "\n".join(full_text)

    # W1 OCR fallback: a scanned report has little/no text layer. Render + OCR
    # the first pages and run the header + inline passes on that instead.
    ocr_used = False
    if len(text.strip()) < 100:
        ocr = _ocr_text(path)
        if len(ocr.strip()) >= 40:
            text, cells, line_tables, ocr_used = ocr, [], [], True

    header = extract_header(cells, text)
    measurements = extract_measurements(cells, line_tables, text)  # already deduped
    if ocr_used:                       # OCR readings are lower-confidence
        for m in measurements:
            m["confidence"] = min(m.get("confidence", 0.6), 0.5)

    # Multi-asset detection (gem W5 safety valve): a NETA/PowerDB job report
    # covers many devices, each opening with a SUBSTATION…POSITION… block. Count
    # distinct sections so the UI can warn that these readings span >1 asset
    # (full per-asset split is roadmap). Default 1 for a single-asset report.
    _raw_spans, sections = _build_sections(text)
    asset_sections = max(1, len(sections))

    return {"fields": header, "measurements": measurements, "full_text": text,
            "ocr": ocr_used, "asset_sections": asset_sections,
            "sections": sections,
            "page_count": page_count, "pages_scanned": pages_scanned,
            "truncated": truncated}
