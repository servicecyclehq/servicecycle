"""
extractor.py -- deterministic, format-agnostic field + measurement extraction
from machine-readable test-report PDFs using pdfplumber word geometry.

Ported from the LapseIQ deterministic invoice extractor (same engine: word
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
from datetime import datetime
from decimal import Decimal, InvalidOperation

import pdfplumber

from neta_field_library import (
    DTYPE_PATTERNS, MEASUREMENT_VOCAB, HEADER_FIELDS, MEASUREMENT_COLUMNS,
    RESULT_TOKENS, normalize_unit,
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


# --- label-proximity + neighbour-cell matching (from the LapseIQ engine) ---
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


# --- header / nameplate fields (serial, model, mfr, date, vendor, tech) ---
def extract_header(cells, text):
    """Regex over the text layer. A value is captured after its label and
    STOPS at the next known label keyword (or a 2+ space gap / newline), so on
    a line packing several 'Label: value' pairs ('Manufacturer: ABB  Model: X
    Serial: Y') each value keeps to itself instead of swallowing the rest."""
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
            raw = m.group(1).strip(" :#-|")
            if not raw:
                continue
            val = raw if f["dtype"] == "string" else parse_value(f["dtype"], raw)
            if val:
                out[f["key"]] = {"value": val, "raw": raw, "confidence": 0.85}
                break
    return out


# --- measurements: label-row pass + ruled-table pass ---
_PHASE_RE = re.compile(r"\bPh(?:ase)?\.?\s*([ABCN](?:-[ABCN])?)\b", re.I)
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
_UNIT_RE = re.compile(r"\d[\d.,]*\s*(M\s?ohm|Mohm|MΩ|kΩ|kohm|µΩ|uΩ|uohm|mΩ|mohm|Ω|ohm|ppm|%|VDC|kV|sec|A)\b", re.I)
_EXPECT_RE = re.compile(r"(?:Expected|Limit|Min(?:imum)?|Spec)\.?\s*[:=]?\s*([<>]=?\s*[\d.]+\s*[A-Za-zΩµ%]*)", re.I)
_RESULT_RE = re.compile(r"\b(GREEN|YELLOW|RED|PASS|FAIL|MARGINAL|SAT|UNSAT)\b", re.I)


def _label_in(text_low):
    """Return (label, vocab) if a measurement label appears at/near the start."""
    for lbl in MEASUREMENT_VOCAB:
        if text_low.startswith(lbl) or (" " + lbl) in text_low[:len(lbl) + 6]:
            return lbl, MEASUREMENT_VOCAB[lbl]
    # also allow label anywhere in a short cell
    for lbl in MEASUREMENT_VOCAB:
        if lbl in text_low:
            return lbl, MEASUREMENT_VOCAB[lbl]
    return None, None


def extract_measurements(cells, page_tables):
    label_out = []

    # Pass 1: labeled rows (cell whose text contains a known measurement label)
    for cell in cells:
        low = _norm(cell["text"])
        lbl, vocab = _label_in(low)
        if not lbl:
            continue
        rest = cell["text"]
        phase_m = _PHASE_RE.search(rest)
        unit_m = _UNIT_RE.search(rest)
        # first number that isn't part of the phase token
        after = rest
        nums = _NUM_RE.findall(after.split(lbl, 1)[-1] if lbl in after.lower() else after)
        value = float(nums[0]) if nums else None
        expect_m = _EXPECT_RE.search(rest)
        res_m = _RESULT_RE.search(rest)
        result = parse_value("result", res_m.group(1)) if res_m else None
        if value is None and result is None:
            continue
        label_out.append({
            "measurementType": vocab["type"],
            "label": lbl.title(),
            "phase": phase_m.group(1).upper() if phase_m else None,
            "asFoundValue": value,
            "asFoundUnit": normalize_unit(unit_m.group(1)) if unit_m else vocab["unit"],
            "expectedRange": expect_m.group(1).strip() if expect_m else None,
            "passFail": result,
            "critical": vocab["critical"],
            "confidence": 0.9 if (value is not None and result) else 0.75,
        })

    # Pass 2: ruled tables (PowerDB forms are ruled). Map header columns to the
    # measurement column roles; emit one measurement per data row. Tables are
    # higher fidelity than the labeled-row pass (they carry phase + expected +
    # result per row), so when present they WIN — pass 1 is the fallback for
    # prose-style reports with no ruled measurement table.
    table_out = []
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
                    pm = _PHASE_RE.search(cv) or re.match(r"\s*([ABCN])\b", cv)
                    rec["phase"] = (pm.group(1).upper() if pm else (cv[:1].upper() if cv[:1].upper() in "ABCN" else None))
                elif role == "value":
                    nm = _NUM_RE.search(cv)
                    rec["asFoundValue"] = float(nm.group(0)) if nm else None
                elif role == "unit":
                    rec["asFoundUnit"] = normalize_unit(cv)
                elif role == "expected":
                    rec["expectedRange"] = cv or None
                elif role == "result":
                    rec["passFail"] = parse_value("result", cv)
            if rec["label"]:
                lbl, vocab = _label_in(_norm(rec["label"]))
                if vocab:
                    rec["measurementType"] = vocab["type"]
                    rec["critical"] = vocab["critical"]
                    rec["asFoundUnit"] = rec["asFoundUnit"] or vocab["unit"]
                else:
                    rec["measurementType"] = re.sub(r"[^a-z0-9]+", "_", _norm(rec["label"]))[:40] or "measurement"
                    rec["critical"] = False
                if rec["asFoundValue"] is not None or rec["passFail"]:
                    rec["confidence"] = 0.9
                    table_out.append(rec)
    return table_out if table_out else label_out


def extract_fields(path: str, mode: str = "all"):
    cells, line_tables, full_text = [], [], []
    table_settings = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            full_text.append(page.extract_text() or "")
            cells.extend(_page_cells(page))
            try:
                line_tables.extend(page.extract_tables(table_settings) or [])
            except Exception:
                pass
    text = "\n".join(full_text)
    header = extract_header(cells, text)
    measurements = extract_measurements(cells, line_tables)

    # de-dupe (label, phase, value) keeping highest confidence
    seen = {}
    for m in measurements:
        k = (m.get("measurementType"), m.get("phase"), m.get("asFoundValue"))
        if k not in seen or m.get("confidence", 0) > seen[k].get("confidence", 0):
            seen[k] = m
    measurements = list(seen.values())

    return {"fields": header, "measurements": measurements, "full_text": text}
