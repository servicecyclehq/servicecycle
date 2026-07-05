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
    are uppercase), so 'Ferranti Packard YEAR 1958 BUSHING' -> 'Ferranti Packard'.

    2026-07-05 fix: exempt tokens that contain a digit from the cutoff. Real
    PowerDB/NETA nameplate documents are themselves entirely upper-case, so
    the original heuristic couldn't tell a genuine section-header word (YEAR,
    BUSHING, PANEL -- always pure alphabetic) from the second+ word of a
    multi-word catalog/model number (PG800-LSI, AKR-30 -- almost always mixed
    alnum). Model/catalog identifiers routinely carry digits; section-header
    label words don't, so digit-presence is a cheap, reliable discriminator.
    Found via report_017 ("MODEL: POWERPACT PG800-LSI" was truncating to just
    "POWERPACT", missing the eval harness's field-accuracy check) -- verified
    the original 'Ferranti Packard YEAR 1958 BUSHING' example still cuts at
    YEAR exactly as before (no digit in that token)."""
    toks = raw.split()
    keep = []
    for i, t in enumerate(toks):
        core = re.sub(r"[^A-Za-z]", "", t)
        if i > 0 and len(core) >= 3 and core.isupper() and not any(ch.isdigit() for ch in t):
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
# Unit alternation expanded 2026-07-04 with OCR-noise-tolerant variants: the
# tesseract path routinely reads MΩ as "M?" (Ω becomes ?), µΩ as "u?"/"udhm",
# Mohm as "M0hm"/"Nchm". Adding these directly to _UNIT lets the deterministic
# regex passes recover values from clean-tesseract OCR without adding a
# preprocessing normalization step (which would risk mis-substituting real
# serial numbers). Verified on the golden set to move partial_ocr OCR-path
# recall 43% → 68% on reports 007 / 011 / 015 / 019 which have "A-B: 850 M?"
# bus-inline rows the pre-fix parser dropped as unclassifiable units.
_UNIT = (r"(?:M\s?Ω|MΩ|Mohm|megohm|M\?|M0hm|Nchm|kΩ|kohm|µΩ|uΩ|uohm|u\?|udhm|"
         r"mΩ|mohm|Ω|ohm|ppm|kVDC|VDC|kVAC|VAC|kV|kA|mA|sec|secs|ms|Hz|°C|°F|%|V|A)")
# NOTE: [ \t]* (not \s*) between value and unit — a unit must sit on the SAME
# LINE as its value. PowerDB flattened tables otherwise pair the last number of
# one row with a %/unit that starts the NEXT line ("…6 37 5 28\n% SATURATION").
# re.I 2026-07-04: PowerDB / NETA plates use all-caps units (SEC, HZ, V, A);
# the case-sensitive alternation was silently dropping "42.5 SEC" and every
# other uppercase-unit reading in reports 014 / 017 (trip time) — verified via
# _INLINE_RE.finditer on the actual golden-set line. Single-letter units (V, A)
# case-insensitive matches lowercase (v, a) too — fine on nameplate readings
# and post-nameplate-suppression the /i flag adds no known false-positive class.
_INLINE_RE = re.compile(r"([A-Za-z][\w .,/&()+#-]{0,28}?)[ \t]*[:=]?[ \t]*(" + _NUM + r")[ \t]*(" + _UNIT + r")(?![A-Za-z0-9])", re.I)
_EXPECT_RE = re.compile(r"(?:Expected|Limit|Min(?:imum)?|Spec|Acceptance|Nameplate)\.?\s*[:=]?\s*([<>]=?\s*[\d.]+\s*[A-Za-zΩµ%]*)", re.I)
_RESULT_RE = re.compile(r"\b(GREEN|YELLOW|RED|PASS(?:ED)?|FAIL(?:ED)?|MARGINAL|SAT|UNSAT|ACCEPTABLE|DEFICIENT)\b", re.I)

# Report-LEVEL overall verdict (feeds domainValidators.verdictCrossCheck).
# Matches phrasing conventions across NETA/PowerDB/Megger/Doble cover pages:
#   Overall Result: PASS
#   Final Verdict: FAIL
#   Report Status - SATISFACTORY
#   Test Result:  FAILED
#   Test Outcome  ACCEPTABLE
# Deliberately narrow: (a) requires an "overall / final / report / test" qualifier
# so per-measurement PASS/FAIL rows never accidentally hijack the report-level
# read; (b) allows an optional separator ([:.\-|—] / whitespace) between label
# and value; (c) captures the same token vocabulary as _RESULT_RE so downstream
# normalizeVerdict() (lib/domainValidators.ts:169) can canonicalize both paths.
_REPORT_VERDICT_RE = re.compile(
    r"(?:^|\n)\s*"
    r"(?:overall(?:\s+test)?\s+(?:result|verdict|outcome|status)"
    r"|final\s+(?:result|verdict|outcome|status|assessment)"
    r"|report\s+(?:result|verdict|outcome|status)"
    r"|test\s+(?:result|verdict|outcome|status))"
    r"\s*[:.\-|—]?\s*"
    r"(GREEN|YELLOW|RED|PASS(?:ED)?|FAIL(?:ED)?|MARGINAL|SAT|UNSAT|ACCEPTABLE|DEFICIENT|SATISFACTORY|UNSATISFACTORY)"
    r"\b",
    re.I,
)


# Reference/ambient temperature — powers domainValidators.tempCorrection.
# NETA/PowerDB/Doble/Megger cover pages report the reading temperature under
# any of "Ambient Temperature", "Test Temperature", "Winding Temperature",
# "Reference Temperature", "Oil Temperature". The IEEE-43 temperature-correction
# formula uses whichever the report says the readings were taken at; we surface
# the number without picking sides between them — the validator only uses it
# when the report also carries BOTH a raw and a corrected value on the same
# measurement type + phase (so a wrong temperature label degrades gracefully
# into "no pair to check" rather than a false-positive flag).
_TEMP_C_RE = re.compile(
    r"(?:ambient|test|reference|winding|oil|top[- ]oil|liquid)\s*(?:temp\.?|temperature)"
    r"\s*[:\-]?\s*"
    r"(-?\d{1,3}(?:\.\d+)?)\s*(?:°\s*)?"
    r"(C|F|Celsius|Fahrenheit)?\b",
    re.I,
)


def _extract_ambient_temp(text: str):
    """Recover the report's ambient/test temperature in °C, if present.

    Handles °C and °F (converted). Returns a float or None. Never raises.
    """
    if not text:
        return None
    m = _TEMP_C_RE.search(text)
    if not m:
        return None
    try:
        val = float(m.group(1))
    except (TypeError, ValueError):
        return None
    unit = (m.group(2) or "C").strip().upper()
    if unit.startswith("F"):
        val = (val - 32.0) * 5.0 / 9.0
    # Physically-plausible sanity guard: real electrical maintenance readings
    # sit in [-40, 120] °C. Anything else is almost certainly a false grab
    # (a serial-number fragment, a torque spec) — better to no-op than to
    # anchor the temp-correction validator on garbage.
    if val < -40.0 or val > 120.0:
        return None
    return round(val, 1)


def _extract_report_verdict(text: str):
    """Recover the report's own printed OVERALL result, if present.

    Returns a canonical string ("PASS" / "FAIL" / raw token like "MARGINAL") or
    None. The domain-consistency validator normalizes further; this function's
    job is only to surface the raw label so the cross-check can fire. Cheap
    (a single regex over the assembled text) and always safe — nothing here
    changes measurements, only enriches meta.
    """
    if not text:
        return None
    m = _REPORT_VERDICT_RE.search(text)
    if not m:
        return None
    return m.group(1).upper()

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


# Nameplate/context labels: these carry ratings not test readings, so an
# inline "<label> <value> <unit>" match is noise not signal (baseline eval
# flagged "PRIMARY: 13800 V", "IMPEDANCE: 5.75 %", "AMBIENT: 28 C / 45% RH",
# "BUS RATING: 1200 A" as false-positive voltage/current/percent readings).
# Match on any WORD in the label — labels can be "PRIMARY", "PRIMARY AMPS",
# "RATED VOLTAGE", etc. Case-insensitive substring check.
_NAMEPLATE_LABEL_TOKENS = {
    "primary", "secondary", "rated", "nameplate", "ampacity",
    "impedance", "bil", "kva", "kvar", "temp", "ambient",
    "rise", "bus", "frame", "voltage",  # "RATED VOLTAGE" / "BUS RATING"
}
# A subset of common inline labels that are ALWAYS nameplate context regardless
# of surrounding words (used for whole-label suffix match).
_NAMEPLATE_LABEL_SUFFIXES = (
    "primary", "secondary", "impedance", "ambient", "bil",
    "primary amps", "secondary amps", "rated voltage", "bus rating",
    "temp rise", "frame",
)


def _looks_like_nameplate_label(label):
    """True if this label is a NAMEPLATE / CONTEXT reading, not a test result.
    Suppressing these stops "PRIMARY: 13800 V" from becoming a voltage_reading
    measurement (baseline eval Section 'Findings')."""
    low = label.lower().strip()
    if not low:
        return False
    if any(low.endswith(sfx) or low == sfx for sfx in _NAMEPLATE_LABEL_SUFFIXES):
        return True
    # Any whole-word match of a nameplate token pins it as context.
    words = re.findall(r"[a-z]+", low)
    return any(w in _NAMEPLATE_LABEL_TOKENS for w in words)


def _inline_readings(text):
    """General pass: every <label> <value> <unit> in the text layer. Captures
    real PowerDB / prose / load-bank readings the ruled-table pass misses."""
    out = []
    for m in _INLINE_RE.finditer(text):
        label = m.group(1).strip(" :=.-,/#(")
        if not re.search(r"[A-Za-z]", label):
            continue
        # Nameplate suppression: PRIMARY:/IMPEDANCE:/BUS RATING: etc. carry
        # ratings not readings — surface them as nameplate data elsewhere,
        # never as fake voltage/current/percent measurements.
        if _looks_like_nameplate_label(label):
            continue
        # Reject 1-2 letter labels for ambiguous units (V/A/%). These are the
        # "AMBIENT: 28 C / 45% RH" → label='C' class: the greedy regex snags
        # a single trailing letter from the *previous* value's unit tail.
        # A real measurement label ("Voltage", "Current", "Impedance") has ≥3
        # alphabetic chars. Diagnostic units (MΩ/µΩ/mΩ/ppm) are safe as-is
        # because their tokens are already unambiguous.
        _label_alpha = re.sub(r"[^A-Za-z]", "", label)
        if len(_label_alpha) < 3 and m.group(3).strip() in {"V", "A", "%", "VDC", "VAC", "mA", "kA", "kV"}:
            continue
        # A label is words, not table data. In a flattened PowerDB row
        # ("X1 - X2 40 40.000 0.998 40.080 0.20 %") the tokens between the real
        # row label and the matched value are NUMBERS — strip trailing numeric
        # tokens, and if we stripped 2+ the "label" was row data: drop the match.
        toks = label.split()
        stripped = 0
        while toks and re.fullmatch(r"-?[\d,]+(?:\.\d+)?%?", toks[-1]):
            toks.pop()
            stripped += 1
        if not toks or stripped >= 2:
            continue
        label = " ".join(toks[-4:])  # keep the last few words, not a whole sentence
        try:
            val = float(m.group(2).replace(",", ""))
        except ValueError:
            continue
        unit = m.group(3).replace("Μ", "M")   # Greek capital Mu -> Latin M (PowerDB "Μ Ω")
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


# --- PowerDB grid pass -------------------------------------------------------
# PowerDB forms put the UNIT in the COLUMN HEADER ("READING Μ Ω 20ºC Μ Ω",
# "(minutes) (kVDC) (megohms)", "Hydrogen (ppm): 18 18 …") and the values in
# bare numeric rows, so the inline <label> <value> <unit> pass can never see
# them and the ruled-table pass never matches a value/result header. This pass
# walks the text layer line-by-line with a small state machine keyed on those
# header signatures. NOTE: PowerDB renders megohm as GREEK capital Mu + Ω
# ("Μ Ω" / "ΜΩ", U+039C), which no Latin-M regex matches.
_NUMTOK_RE = re.compile(r"-?[\d,]+(?:\.\d+)?")
# 2026-07-04: OCR-noise-tolerant variants added so scanned reports whose
# "(MΩ)" header rendered as "(M?)" or "(MQ)" still trigger the IR-grid mode.
# The Ω on tesseract's 4.x line commonly comes back as "?" or "Q"; without
# these aliases the WINDING/H-G/X-G IR blocks in reports 003 / 004 were
# silently dropped even when the numbers themselves read cleanly.
_MOHM_HDR_RE = re.compile(r"Μ\s?Ω|MΩ|M\?|MQ|M0hm|Mohm|Nchm", re.I)
_UNITCOL_RE = re.compile(r"\(([A-Za-zµ%]+)\)")
_DGA_ROW_RE = re.compile(
    r"^\*?\s*([A-Za-z][A-Za-z0-9 /.]*?)\s*\((ppm|ppb)\)\s*:?\s*"
    r"((?:-?[\d,]+(?:\.\d+)?[ \t]+)*-?[\d,]+(?:\.\d+)?)$")
_PF_ROW_RE = re.compile(r"^\d+\s+([HXhx]\d)\s+\S+\s+(?:GRD|GND|GST|UST)\b(.+)$")
_PHASEHDR_RE = re.compile(r"\bPHASE\s+\d", re.I)


def _is_numtok(t):
    return _NUMTOK_RE.fullmatch(t) is not None


def _tofloat(t):
    try:
        return float(t.replace(",", ""))
    except ValueError:
        return None


def _grid_rec(mt, label, val, unit, kind, crit, conf, off, phase=None):
    return {"measurementType": mt, "label": label, "phase": phase,
            "asFoundValue": val, "asFoundUnit": unit, "expectedRange": None,
            "passFail": None, "critical": crit, "kind": kind,
            "confidence": conf, "_off": off}


def _powerdb_grids(text):
    """Diagnostic readings from PowerDB unit-in-header grids: insulation
    resistance (Μ Ω / (megohms) headers), pole contact resistance (µΩ block
    beside the breaker IR grid), DGA ppm rows, bushing C2 power-factor rows."""
    out = []
    ir_rows = 0        # countdown: data rows left in a Μ Ω READING grid
    ir_micro = False   # grid also carries a POLE RESISTANCE - MICRO-OHMS block
    unit_cols = None   # units from a "(minutes) (kVDC) (megohms) …" header
    unit_rows = 0
    ctx = None         # nearest "WINDING n" context label
    off = 0
    for raw in text.split("\n"):
        loff = off
        off += len(raw) + 1
        line = raw.strip()
        if not line:
            ir_rows, unit_cols = 0, None
            continue
        toks = line.split()
        has_num = any(_is_numtok(t) for t in toks)
        wm = re.search(r"\bWINDING\s+(\d)\b", line, re.I)
        if wm:
            ctx = "Winding " + wm.group(1)

        # 1) DGA rows: "Hydrogen (ppm): 18 18 21 18 20" — newest sample FIRST.
        dm = _DGA_ROW_RE.match(line)
        if dm:
            v = _tofloat(dm.group(3).split()[0])
            if v is not None:
                name = dm.group(1).strip()
                mt, crit, u, kind = _classify(name, dm.group(2))
                out.append(_grid_rec(mt, name.title(), v, u or dm.group(2),
                                     kind, crit, 0.75, loff))
            continue

        # 2) unit-in-header column tables: "(minutes) (kVDC) (megohms) (microamps)"
        units = _UNITCOL_RE.findall(line)
        if len(units) >= 2 and any(u.lower().startswith("megohm") for u in units):
            unit_cols = [u.lower() for u in units]
            unit_rows = 10
            continue
        if unit_cols is not None and unit_rows > 0:
            run = []
            for t in toks:
                if _is_numtok(t):
                    run.append(t)
                else:
                    break
            if len(run) == len(unit_cols):
                mi = next(i for i, u in enumerate(unit_cols) if u.startswith("megohm"))
                v = _tofloat(run[mi])
                # 2026-07-05 (W8): `v >= 0` (was `v > 0`) -- same fix as the
                # MΩ-READING grid path below (2026-07-04): a zero IR reading is
                # a legitimate, safety-critical value (indicates a short
                # circuit), not something to silently drop. Skipping negatives
                # still keeps "--" and other unparseable tokens out.
                if v is not None and v >= 0:
                    out.append(_grid_rec("insulation_resistance",
                                         ctx or "Insulation Resistance", v, "MΩ",
                                         "D", False, 0.7, loff))
                unit_rows -= 1
                continue
            if run:                    # numeric row, missing cells: skip, stay in mode
                unit_rows -= 1
                continue
            unit_cols = None           # non-numeric line: table over

        # 3) Μ Ω READING grids: header "INSULATION POLE 1 ΜΩ (P1-P2) … POLE
        #    RESISTANCE - MICRO-OHMS", rows "POLE TO FRAME 2,000 1,548.00 … 10 12 13"
        if _MOHM_HDR_RE.search(raw):
            ir_rows = 8
            ir_micro = "MICRO-OHM" in raw.upper()
            continue
        if ir_rows > 0:
            ir_rows -= 1
            if len(_PHASEHDR_RE.findall(line)) >= 2:
                ir_rows = 0            # a NEW section header: grid over
                continue
            if not has_num:            # continuation header row ("RESISTANCE
                continue               # READING 20°C …"): skip, stay in grid
            i = 0
            while i < len(toks) and not _is_numtok(toks[i]):
                i += 1
            lbl, run, j = toks[:i], [], i
            while j < len(toks) and _is_numtok(toks[j]):
                run.append(toks[j])
                j += 1
            label = " ".join(lbl).strip("':")
            if re.search(r"READING|COUNTER|WIRING|COMMENT", label, re.I):
                continue               # counter/boilerplate rows, not readings
            # 2026-07-04: `len(run) >= 1` (was `>= 2`) — real PowerDB reports
            # commonly have per-winding rows with just the 1-min value when
            # the 10-min column is empty or shown as "--" (report_004:
            # "H-G 0 --", "H-X 14800"). We are inside the MΩ-READING grid
            # mode (triggered by an MΩ / M? / MQ header) so a single numeric
            # row is unambiguously an IR reading.
            if lbl and len(lbl) <= 4 and len(run) >= 1:
                for t in run[:6]:      # ≤3 phases × (reading, 20°C-corrected)
                    v = _tofloat(t)
                    # 2026-07-04: `v >= 0` (was `v > 0`). A zero IR reading is
                    # a legitimate — and safety-critical — value (indicates a
                    # short circuit); report_004's H-G row is exactly that
                    # case. Skipping negatives still keeps "--" and other
                    # unparseable tokens out.
                    if v is not None and v >= 0:
                        out.append(_grid_rec("insulation_resistance", label, v,
                                             "MΩ", "D", False, 0.75, loff))
                extra = run[6:]        # µΩ pole-resistance block beside the IR grid
                if ir_micro and len(extra) == 3:
                    for pi, t in enumerate(extra, 1):
                        v = _tofloat(t)
                        if v is not None and v > 0:
                            out.append(_grid_rec(
                                "contact_resistance", "Pole %d Resistance" % pi,
                                v, "µΩ", "D", True, 0.75, loff, phase="P%d" % pi))
            continue

        # 4) bushing C2 power-factor rows (under a "BUSHING … % POWER FACTOR"
        #    header): "29 H1 1 GRD 4,150.00 1.00 4,145.30 0.52 0.52 1.000 …"
        #    cols: npl-cap, npl-PF, meas-cap, %PF measured, %PF corrected 20°C.
        pm = _PF_ROW_RE.match(line)
        if pm and "POWER FACTOR" in text[max(0, loff - 900):loff].upper():
            nums = [_tofloat(t) for t in pm.group(2).split() if _is_numtok(t)]
            if len(nums) >= 5 and nums[4] is not None and 0 < nums[4] <= 20:
                out.append(_grid_rec(
                    "power_factor",
                    "Bushing %s Power Factor" % pm.group(1).upper(),
                    nums[4], "%", "D", False, 0.75, loff,
                    phase=pm.group(1).upper()))
    return out


# ── Explicit passes: DGA, PI, PF (2026-07-03 eval-gap fixes) ────────────────
# These three passes close the concrete recall gaps documented in
# docs/EVAL_BASELINE_2026-07.md (baseline: parser recall 19% / 12% / 5%). Each
# targets one measurement family the general inline pass cannot see: DGA
# tables (unit lives in a header, values sit in bare rows with <=LIMIT trails),
# polarization index (dimensionless ratio — the inline pass requires a unit),
# and the multi-line PF-block table (label on one line, header on next, values
# after that). Pure regex, no deps.

# DGA gas names → dissolved-gas identifier keeps the label human-readable.
_DGA_NAMES = {
    "hydrogen": "H2", "methane": "CH4",
    "ethane": "C2H6", "ethylene": "C2H4", "acetylene": "C2H2",
    "carbon monoxide": "CO", "carbon dioxide": "CO2",
    "oxygen": "O2", "nitrogen": "N2",
    "tdcg": "TDCG", "total dissolved combustible gas": "TDCG",
}
# DGA table rows: "HYDROGEN (H2)  1240  <=100  HIGH - RED"
# The gas symbol appears in parentheses OR the name alone leads the line;
# leading value = the reading (ppm), trailing `<=N` = expected limit, trailing
# token = result. `_DGA_ROW_RE` in the powerdb pass requires "(ppm)" INLINE,
# which this variant does not have — the "ppm" unit is in the section header.
_DGA_TABLE_ROW_RE = re.compile(
    r"^\s*"
    r"([A-Z][A-Z ]{2,30}?)"                        # gas name (uppercase)
    r"(?:\s*\(([A-Z][A-Z0-9]{0,5})\))?"            # optional (H2) style symbol
    r"\s+"
    r"(-?\d[\d,]*(?:\.\d+)?)"                      # value
    r"\s+"
    r"(?:<=?\s*[\d,.]+|>=?\s*[\d,.]+|N/?A)"        # expected limit (required — cheap header-vs-data disambiguator)
    r"(?:\s+([A-Z][A-Z\s\-]{1,30}))?"              # optional result token(s)
    r"\s*$",
    re.M,
)


def _dga_readings(text):
    """Match DGA table rows across report formats — the header-per-column
    variant (values with an inline <=LIMIT) that `_DGA_ROW_RE` in the powerdb
    pass cannot see. Emits one dissolved_gas record per gas."""
    out = []
    for m in _DGA_TABLE_ROW_RE.finditer(text or ""):
        name_raw = (m.group(1) or "").strip()
        sym = (m.group(2) or "").strip().upper() or None
        try:
            val = float(m.group(3).replace(",", ""))
        except ValueError:
            continue
        # Match against known gas name (fuzzy: whitespace-insensitive lowercase)
        key = re.sub(r"\s+", " ", name_raw.lower()).strip()
        canon = _DGA_NAMES.get(key)
        if not canon and sym in {"H2","CH4","C2H6","C2H4","C2H2","CO","CO2","O2","N2","TDCG"}:
            canon = sym
        if not canon:
            continue
        # Result token → PASS/FAIL normalization (parse_value tolerates "HIGH - RED")
        result_raw = (m.group(4) or "").strip()
        pf = parse_value("result", result_raw) if result_raw else None
        label = "%s (%s)" % (name_raw.title(), canon)
        out.append({
            "measurementType": "dissolved_gas",
            "label":           label,
            "phase":           None,
            "asFoundValue":    val,
            "asFoundUnit":     "ppm",
            "expectedRange":   None,
            "passFail":        pf,
            "critical":        canon == "C2H2",  # acetylene is diagnostic-critical for oil transformers
            "kind":            "D",
            "confidence":      0.85,
            "_off":            m.start(),
        })
    return out


# Polarization index: "POLARIZATION INDEX (H-G): 2.31" — dimensionless ratio,
# so the general inline pass (requires unit token) will never see it.
_PI_RE = re.compile(
    r"POLARIZATION\s+INDEX(?:\s*\(([HXG0-9\-]+)\))?\s*[:=]?\s*"
    r"(-?\d+(?:\.\d+)?)",
    re.I,
)


def _pi_readings(text):
    out = []
    for m in _PI_RE.finditer(text or ""):
        phase = (m.group(1) or "").strip() or None
        try:
            val = float(m.group(2))
        except ValueError:
            continue
        # Physical floor: NETA/IEEE-43 PI must be ≥ 1.0 (asymptote). A parse
        # yielding < 1 is misread. We record it anyway (confidence 0.75) so
        # domainValidators fires on it — hiding it here would let a real
        # < 1.0 misread never reach review.
        out.append({
            "measurementType": "polarization_index",
            "label":           "Polarization Index",
            "phase":           phase,
            "asFoundValue":    val,
            "asFoundUnit":     "ratio",
            "expectedRange":   None,
            "passFail":        None,
            "critical":        False,
            "kind":            "D",
            "confidence":      0.9,
            "_off":            m.start(),
        })
    return out


# Power Factor table (Doble): the LABEL sits on one line, the VALUE on another.
# Report 001:
#   POWER FACTOR - DOBLE M4100 @ 10 KV
#   TEST        MODE     %PF CORR 20C    EXPECTED     RESULT
#   CH+CHL      GST      0.34            <=0.5        PASS
# The value is the number after the mode token (GST/UST/GRD), constrained to a
# reasonable %PF range (0 < v <= 20).
_PF_HEADER_RE = re.compile(r"^\s*POWER\s+FACTOR\b.*$", re.I | re.M)
_PF_TABLE_ROW_RE = re.compile(
    r"^\s*"
    r"([A-Z0-9+\-/]{2,20})"                        # test label (CH+CHL, CL+CLH, HL, etc.)
    r"\s+"
    r"(GST|UST|GRD|GND)"                           # mode
    r"\s+"
    r"(-?\d+(?:\.\d+)?)"                           # %PF value
    r"(?:\s+(?:<=?\s*[\d,.]+|>=?\s*[\d,.]+|N/?A))?" # optional expected
    r"(?:\s+([A-Z][A-Z\s\-]{1,20}))?"              # optional result
    r"\s*$",
    re.M,
)


def _pf_readings(text):
    """PF table rows in a POWER FACTOR block. Confidence gate: header must
    appear within the preceding 600 chars so a stray GST/UST token elsewhere
    (rare) never becomes a PF reading."""
    if not text:
        return []
    out = []
    hdr_positions = [h.start() for h in _PF_HEADER_RE.finditer(text)]
    for m in _PF_TABLE_ROW_RE.finditer(text):
        # Require a POWER FACTOR header within 600 chars before this row.
        if not any(0 <= (m.start() - hp) <= 600 for hp in hdr_positions):
            continue
        try:
            val = float(m.group(3))
        except ValueError:
            continue
        if not (0 <= val <= 20):  # %PF plausibility envelope
            continue
        label = "%s %s" % (m.group(1).upper(), m.group(2).upper())
        result_raw = (m.group(4) or "").strip()
        pf = parse_value("result", result_raw) if result_raw else None
        out.append({
            "measurementType": "power_factor",
            "label":           label,
            "phase":           None,
            "asFoundValue":    val,
            "asFoundUnit":     "%",
            "expectedRange":   None,
            "passFail":        pf,
            "critical":        False,
            "kind":            "D",
            "confidence":      0.85,
            "_off":            m.start(),
        })
    return out


# ── Column-header inference passes (report 006/014/017/018 class) ───────────
# Two closely-related PowerDB layouts the earlier passes missed and the eval
# baseline (docs/EVAL_BASELINE_2026-07.md) flagged: (a) bus-to-ground insulation
# rows written inline as "A-G: 15200  B-G: 14100  C-G: 16800" under a "(MΩ)"
# unit header line; (b) contact-resistance / trip-time grids where the row
# labels are just phase letters (A / B / C) and the measurement label lives on
# a PRECEDING line ("CONTACT RESISTANCE - DLRO (µΩ)"). Both share the same
# gap: the parser needs to INFER the measurement type from a nearby line
# instead of from the row itself.
_BUS_INLINE_UNIT_HDR_RE = re.compile(
    # match a header line containing a measurement keyword AND a parenthesized
    # unit — e.g. "BUS INSULATION RESISTANCE @ 2500 VDC (MΩ)". Group(1) is the
    # sentence-context (what the parser will classify), group(2) is the unit.
    # Label class allows @, digits, and common punctuation because real PowerDB
    # headers are of the form "<measurement label> @ <test conditions> (<unit>)".
    # Unit set matches _UNIT (including OCR-noise-tolerant variants M?, u?,
    # M0hm, Nchm, udhm — common tesseract corruptions on scanned reports; see
    # comment on _UNIT above).
    r"([A-Z][A-Za-z0-9 .,/&+#@:'-]{4,80})\(\s*("
    r"M\s?Ω|MΩ|Mohm|megohm|M\?|M0hm|Nchm|kΩ|kohm|µΩ|uΩ|uohm|u\?|udhm|"
    r"mΩ|mohm|Ω|ohm|kVDC|VDC|kVAC|VAC|kV|kA|mA|sec|secs|ms|Hz|°C|°F|%|V|A|ppm"
    r")\s*\)",
    re.I,
)
_BUS_INLINE_ROW_RE = re.compile(
    # Match "A-G: 15200      B-G: 14100      C-G: 16800" on one line — three
    # phase-labeled values. The phase key is a single letter (A/B/C/N/H/X)
    # optionally followed by "-G" (to-ground) or "-<letter>" (line-to-line).
    # 2026-07-04: also tolerate an OPTIONAL unit token BETWEEN phase-value
    # pairs — a real report line often reads "A-B: 850 M? B-C: 720 M? C-A: 910"
    # where the unit repeats. Without this, the third phase (C-A) is dropped
    # because the M? isn't whitespace. Group names stay the same.
    r"^(?P<A>[ABCNHX](?:-[ABCGN])?)\s*[:=]?\s*"
    r"(?P<Av>-?\d[\d,]*(?:\.\d+)?)"
    r"(?:\s*(?:M\s?Ω|MΩ|Mohm|M\?|M0hm|Nchm|µΩ|uΩ|u\?|udhm|mΩ|Ω|kΩ|%|V|A|kV|VDC|VAC|sec|ms|Hz))?"
    r"[\s\t]+"
    r"(?P<B>[ABCNHX](?:-[ABCGN])?)\s*[:=]?\s*"
    r"(?P<Bv>-?\d[\d,]*(?:\.\d+)?)"
    r"(?:\s*(?:M\s?Ω|MΩ|Mohm|M\?|M0hm|Nchm|µΩ|uΩ|u\?|udhm|mΩ|Ω|kΩ|%|V|A|kV|VDC|VAC|sec|ms|Hz))?"
    r"[\s\t]+"
    r"(?P<C>[ABCNHX](?:-[ABCGN])?)\s*[:=]?\s*"
    r"(?P<Cv>-?\d[\d,]*(?:\.\d+)?)",
    re.MULTILINE | re.IGNORECASE,
)


def _bus_inline_readings(text):
    """Recover the "A-G: 15200  B-G: 14100  C-G: 16800" bus-inline layout
    (reports 006, 018 in the golden set). Requires a unit-in-parens header line
    within the preceding ~200 chars — a bare "A-G: 42 B-G: 51 C-G: 60" without
    the "(µΩ)" header stays UNparsed rather than being misclassified.

    Returns a list of measurement dicts in the same shape as _inline_readings.
    Confidence is 0.7 (slightly below the ruled-table 0.85) — the header-context
    inference is one hop of indirection so a wrong header degrades gracefully.
    """
    if not text:
        return []
    out = []
    # Precompile a fallback: capture the unit token if it appears BETWEEN
    # phase-value pairs in the row itself (report_007 pattern:
    # "A-B: 850 M? B-C: 720 M? C-A: 910" carries M? in-line but has no
    # "(MΩ)" header). Uses the first unit token found in the row.
    _ROW_UNIT_RE = re.compile(
        r"(?:M\s?Ω|MΩ|Mohm|M\?|M0hm|Nchm|µΩ|uΩ|u\?|udhm|mΩ|Ω|kΩ|%|V|A|kV|VDC|VAC|sec|ms|Hz)",
        re.I,
    )

    for row in _BUS_INLINE_ROW_RE.finditer(text):
        # Find the nearest unit-in-parens header line before this row (must be
        # within 200 chars; further away and the association is unsafe).
        window_start = max(0, row.start() - 200)
        header_win = text[window_start: row.start()]
        hdr_ms = list(_BUS_INLINE_UNIT_HDR_RE.finditer(header_win))
        label = None
        unit = None
        if hdr_ms:
            hdr = hdr_ms[-1]  # nearest to the row
            label = hdr.group(1).strip().rstrip(":-,.").strip()
            unit_raw = hdr.group(2)
            unit = normalize_unit(unit_raw)
        else:
            # Fallback (2026-07-04): no unit-in-parens header, but the ROW
            # itself carries a unit token (report_007: "A-B: 850 M? B-C: ..."
            # under a header of "BUS INSULATION RESISTANCE @ 1000 VDC" that
            # names the measurement but omits the parenthesised unit). Use
            # the first unit token found in the row and take the closest
            # non-blank preceding line as the label.
            #
            # 2026-07-05 fix: `_ROW_UNIT_RE` includes bare single-letter units
            # ("A", "V") in its alternation, which — searched from position 0
            # over the WHOLE row — matched the leading phase-pair letter
            # itself (e.g. the "A" in "A-G: 15200  B-G: 14100  C-G: 16800"),
            # mislabeling insulation-resistance readings as Amps. This is the
            # bug flagged in servicecycle-overnight-parser-2026-07-05.
            #
            # An earlier attempted fix anchored the search to start AFTER the
            # first numeric token (skipping "A-G: 15200" before searching),
            # which correctly stops the false "A" match -- but reports 006/018
            # normally take the `if hdr_ms:` branch above (their real headers
            # DO carry a parenthesised unit); they only fall into THIS branch
            # when real OCR noise garbles the header past
            # `_BUS_INLINE_UNIT_HDR_RE`'s recognition. In that degraded case
            # there is no genuine inline unit token in the row at all (unlike
            # report_007's true fallback shape), so the anchored search finds
            # nothing, `um` stays None, and the old `continue` dropped the
            # entire row -- regressing clean-tier OCR-path recall on exactly
            # those two reports (006: 50%->0%, 018: 100%->25%) instead of
            # fixing the mislabel.
            #
            # The actual fix: still anchor the search past the first numeric
            # token (kills the false "A"/"V" phase-letter match), but instead
            # of dropping the row when no inline unit is found, pass
            # unit=None through to `_classify()` below. `_classify()` already
            # prefers a full MEASUREMENT_LIBRARY label match's canonical unit
            # whenever no unit was supplied (`nu or e["unit"]` at line ~410) --
            # so "BUS INSULATION RESISTANCE" (even OCR-garbled but still
            # recognizable to `classify_label`) now correctly resolves to
            # MΩ via the label, rather than via a guessed/wrong row token.
            # If the label DOESN'T confidently classify either, the existing
            # downstream check (`mt in ("reading","resistance") or
            # mt.endswith("_reading")`) still safely rejects the row -- same
            # safety net as before, just reached via a different path.
            row_text = text[row.start(): row.end()]
            _first_num = _NUMTOK_RE.search(row_text)
            um = _ROW_UNIT_RE.search(row_text, _first_num.end() if _first_num else 0)
            unit = normalize_unit(um.group(0)) if um else None
            # Walk backwards to the most recent non-blank line for the label.
            hdr_lines = [ln for ln in header_win.split("\n") if ln.strip()]
            if not hdr_lines:
                continue
            candidate = hdr_lines[-1].strip()
            # Strip a trailing "@ <test conditions>" if any so the label
            # classifies cleanly (e.g. "BUS INSULATION RESISTANCE @ 1000 VDC"
            # -> "BUS INSULATION RESISTANCE").
            candidate = re.sub(r"\s*@.*$", "", candidate).strip()
            if len(candidate) < 4:
                continue
            label = candidate
            # Guard for the unit=None case above: don't let an unrecognized
            # label ride through on a null unit just because the row
            # structurally matched three phase-value pairs. Require a real
            # MEASUREMENT_LIBRARY match before trusting `_classify()` to fill
            # in the unit from the label alone -- otherwise this is exactly
            # as blind as the "not um: continue" case used to be, just
            # reached differently. (When a unit token WAS found, this check
            # is skipped -- that's the report_007 shape, unchanged.)
            if unit is None and classify_label(label) is None:
                continue
        # Reject if the label carries no known measurement token — a random
        # "(MΩ)" line without "insulation" / "resistance" / "megger" nearby
        # is not enough to blindly classify the row.
        mt, crit, u, kind = _classify(label, unit)
        if mt == "unknown" or mt.endswith("_reading") or mt in ("reading","resistance"):
            continue
        for key_ph, key_val in (("A", "Av"), ("B", "Bv"), ("C", "Cv")):
            ph_raw = row.group(key_ph)
            phase = _phase_of(ph_raw) or ph_raw[:1].upper()
            try:
                val = float(row.group(key_val).replace(",", ""))
            except (TypeError, ValueError):
                continue
            out.append({
                "measurementType": mt,
                "label":           label.title(),
                "phase":           phase,
                "asFoundValue":    val,
                "asFoundUnit":     u,
                "expectedRange":   None,
                "passFail":        None,
                "critical":        crit,
                "kind":            kind,
                "confidence":      0.7,
                "_off":            row.start(),
            })
    return out


# Single-phase-per-line readings under a "<label> (<unit>)" context header
# (report_018 VLF tan delta pattern). The line is
#     PHASE A: 0.12 %      EXPECTED: <=0.5 %      PASS
# where the label ("VLF TAN DELTA") lives on a preceding line and the row
# carries only the phase + value + unit. Neither `_inline_readings` (label is
# "PHASE A", classifies to percent_reading) nor `_bus_inline_readings` (needs
# three phases in one line) fires. This pass fills the gap by taking the
# type from the nearest preceding unit-in-parens header (within ~250 chars).
_PHASE_LINE_RE = re.compile(
    r"^\s*PHASE\s+(?P<ph>[ABCN])\s*[:=]?\s*"
    r"(?P<val>-?\d[\d,]*(?:\.\d+)?)\s*"
    r"(?P<unit>M\s?Ω|MΩ|Mohm|megohm|kΩ|kohm|µΩ|uΩ|uohm|mΩ|mohm|Ω|ohm|"
    r"ppm|kVDC|VDC|kVAC|VAC|kV|kA|mA|sec|secs|ms|Hz|°C|°F|%|V|A)"
    r"(?![A-Za-z0-9])",
    re.I | re.MULTILINE,
)


def _phase_context_readings(text):
    """Recover single-phase-per-line readings under a preceding header line
    (report_018 VLF tan delta case). The header may or may not carry a
    unit-in-parens — for VLF tan delta the parens hold the TEST FREQUENCY
    ("(0.1 HZ)"), not the reading's unit. So the classifier runs on the
    header label alone; a match against MEASUREMENT_LIBRARY / VOCAB is
    required, otherwise no measurements are emitted (never guess a type).

    Confidence 0.7 — the row's type was inferred from a preceding line so
    a wrong header degrades gracefully to no emission.
    """
    if not text:
        return []
    out = []
    for row in _PHASE_LINE_RE.finditer(text):
        # Walk backwards to the most recent non-blank line before the row.
        # Stop at the first non-empty preceding line — that's the label the
        # row inherits from (matches how PowerDB / NETA layout works: a
        # section header on its own line, then per-phase rows immediately
        # below).
        line_start = text.rfind("\n", 0, row.start())
        if line_start == -1: line_start = 0
        # Cap the lookback at ~250 chars so a distant unrelated header can't
        # hijack the row.
        window_start = max(0, line_start - 250)
        header_win = text[window_start: line_start]
        # Split the header window into lines, iterate bottom-up, use the
        # first non-blank one.
        header_label = None
        for line in reversed([ln for ln in header_win.split("\n") if ln.strip()]):
            # Strip any trailing "(...)" parenthetical — it's often test
            # conditions ("(0.1 HZ)" / "@ 2500 VDC") not the reading unit —
            # and normalize whitespace/casing. What's left should still be a
            # classifiable label.
            candidate = re.sub(r"\([^)]*\)", "", line).strip()
            # A candidate is only a header if it lacks a leading "PHASE X"
            # token (otherwise we'd inherit type from a previous phase row
            # and infinite-cascade into wrong classifications).
            if re.match(r"^\s*PHASE\s+[ABCN]\b", candidate, re.I):
                continue
            if len(candidate) >= 4:
                header_label = candidate
                break
        if not header_label:
            continue
        row_unit = normalize_unit(row.group("unit"))
        mt, crit, u, kind = _classify(header_label, row_unit)
        # Only emit when the LABEL classified to a known measurement type.
        # A generic *_reading fallback here would let this pass hijack rows
        # the general inline pass already handles better.
        if mt in ("unknown", "reading") or mt.endswith("_reading"):
            continue
        try:
            val = float(row.group("val").replace(",", ""))
        except (TypeError, ValueError):
            continue
        out.append({
            "measurementType": mt,
            "label":           header_label.title(),
            "phase":           row.group("ph").upper(),
            "asFoundValue":    val,
            "asFoundUnit":     u or row_unit,
            "expectedRange":   None,
            "passFail":        None,
            "critical":        crit,
            "kind":            kind,
            "confidence":      0.7,
            "_off":            row.start(),
        })
    return out


# Phase-column table under a "(µΩ)" / "(mΩ)" / "(sec)" context line — the
# PHASE / AS-FOUND / EXPECTED / RESULT grid with no description column. The
# row label ("A") is a phase; the measurementType comes from the line ABOVE
# the header.
_PHASE_GRID_HDR_RE = re.compile(
    # The value column may be labeled either descriptively ("AS-FOUND",
    # "MEASURED") or by unit ("µΩ", "uOhm", "udhm", "sec", "MΩ", "%").
    # 2026-07-04: value-column token is CAPTURED as group(1) so
    # _phase_grid_readings can use it as the row unit when no unit-in-parens
    # header exists on a preceding line (report_007: header is "MAIN BUS
    # JOINT RESISTANCE (DLRO)" which carries the LABEL but not the unit;
    # the unit is right here in "PHASE uOhm EXPECTED RESULT").
    r"^\s*PHASE\s+"
    r"(AS[- ]?FOUND|MEASURED|VALUE|READING|ACTUAL|"
    r"M\s?Ω|MΩ|Mohm|M\?|M0hm|Nchm|µΩ|µ\s?Ohm|uΩ|u\s?Ohm|uohm|u\?|udhm|"
    r"mΩ|m\s?Ohm|mohm|Ω|Ohm|kΩ|k\s?Ohm|kohm|%|V|A|kV|VDC|VAC|sec|ms|Hz)\s+"
    r"(?:EXPECTED|LIMIT|SPEC|ACCEPTANCE)?\s*(?:RESULT|OUTCOME|PASS/?FAIL)?\s*$",
    re.I | re.MULTILINE,
)
_PHASE_GRID_ROW_RE = re.compile(
    r"^\s*(?P<ph>[ABCN])\s+"
    r"(?P<val>-?\d[\d,]*(?:\.\d+)?)"
    r"(?:\s+(?P<expected>[<>]=?\s*[\d.]+\s*[A-Za-zΩµ%°]*))?"
    r"(?:\s+(?P<result>PASS(?:ED)?|FAIL(?:ED)?|GREEN|YELLOW|RED|MARGINAL|"
    r"INVESTIGATE(?:\s*-\s*(?:GREEN|YELLOW|RED))?|SAT|UNSAT|ACCEPTABLE|DEFICIENT))?"
    r"\s*$",
    re.I | re.MULTILINE,
)


def _phase_grid_readings(text):
    """Recover the PHASE / AS-FOUND / EXPECTED / RESULT grid where rows carry
    only a phase letter and the measurementType lives on the line above the
    header (reports 014, 017 in the golden set).

    Two anchors required — an inference-only pass without both would too
    easily hijack random tables:
      - the header line "PHASE  AS-FOUND  EXPECTED  RESULT"
      - a unit-in-parens context line within the ~150 chars before that header
        that classifies to a known measurementType
    Otherwise no measurements are emitted. Confidence 0.75 (mid-tier — the
    row values themselves are unambiguous, but the type inference is one hop).
    """
    if not text:
        return []
    out = []
    # Descriptive column labels are NOT units — the caller must then fall back
    # to a parens-unit header on a preceding line. Otherwise the captured
    # header token IS the row unit.
    _DESCRIPTIVE = {"as-found", "asfound", "measured", "value", "reading", "actual"}
    for hdr in _PHASE_GRID_HDR_RE.finditer(text):
        ctx_start = max(0, hdr.start() - 200)
        ctx = text[ctx_start: hdr.start()]
        hdr_token = (hdr.group(1) or "").strip()
        hdr_norm = re.sub(r"\s+", "", hdr_token).lower()
        # Case A: header value column is a UNIT (uOhm / µΩ / MΩ / sec / %).
        # Use it as the row unit; find the LABEL from the closest preceding
        # non-blank line (stripped of trailing parenthetical like "(DLRO)").
        if hdr_norm not in _DESCRIPTIVE:
            unit = normalize_unit(hdr_token)
            lines = [ln for ln in ctx.split("\n") if ln.strip()]
            if not lines:
                continue
            label = lines[-1].strip()
            label = re.sub(r"\s*\([^)]*\)\s*$", "", label).strip()
            label = re.sub(r"\s*@.*$", "", label).strip()
            if len(label) < 4:
                continue
        # Case B: header value column is descriptive — need a parens-unit
        # header on a preceding line (original behavior).
        else:
            ctx_hdr = list(_BUS_INLINE_UNIT_HDR_RE.finditer(ctx))
            if not ctx_hdr:
                continue
            ch = ctx_hdr[-1]
            label = ch.group(1).strip().rstrip(":-,.").strip()
            unit = normalize_unit(ch.group(2))
        mt, crit, u, kind = _classify(label, unit)
        # Only emit when the label classified to a specific type — a
        # generic *_reading fallback would let this pass hijack rows the
        # inline pass already handles.
        if mt == "unknown" or mt.endswith("_reading") or mt in ("reading","resistance"):
            continue
        # Collect rows starting from just after the header until a blank line
        # or a new heading. Stop after 6 rows (over-generous for A/B/C/N).
        after = text[hdr.end(): hdr.end() + 400]
        for row in _PHASE_GRID_ROW_RE.finditer(after):
            phase = row.group("ph").upper()
            try:
                val = float(row.group("val").replace(",", ""))
            except (TypeError, ValueError):
                continue
            expected = (row.group("expected") or "").strip() or None
            result_raw = (row.group("result") or "").strip()
            pf = parse_value("result", result_raw) if result_raw else None
            out.append({
                "measurementType": mt,
                "label":           label.title(),
                "phase":           phase,
                "asFoundValue":    val,
                "asFoundUnit":     u,
                "expectedRange":   expected,
                "passFail":        pf,
                "critical":        crit,
                "kind":            kind,
                "confidence":      0.75,
                "_off":            hdr.start() + row.start(),
            })
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


# ── Garbled-tier structural normalization (2026-07-05) ──────────────────────
# The golden-set garbled tier (reports 005/008/012/016/020, parser recall
# stuck at 10% since the 2026-07-04 morning session) was previously attacked
# with a digit-confusable fix (_ocr_noise_fix, since reverted -- see
# INGESTION_ARCHITECTURE.md / the 2026-07-05 overnight recap) that targeted
# 0<->O confusion WITHIN a numeric token. That fix produced zero eval
# movement because it targeted the wrong axis: reading the actual golden
# fixtures shows the real corruption is structural, not per-digit:
#
#   1. Whole-WORD letter-O -> digit-0 substitution in LABEL/header text
#      (P0WERDB, INSULATI0N, C0NTACT, 0VERALL, M0DEL, D0BLE, ...). The
#      numeric VALUES read fine (6800, 5210, 0.83) -- it's the label/header
#      words feeding classify_label()/MEASUREMENT_LIBRARY lookups that don't
#      match because they're not spelled correctly.
#   2. A value split across a hard line-wrap mid-digit-run: "H-G 68\n00
#      M0hm..." is the real value 6800 rendered as "68" then "00" on the
#      next line -- a rendering/line-break artifact, not a misread digit.
#
# Both are fixed here as a narrow, reversible TEXT normalization applied once
# before any label/measurement parsing runs, rather than patching every
# individual regex to tolerate the corruption piecemeal.
_OCR_ZERO_AS_O_RE = re.compile(
    r"(?<=[A-Za-z])0(?=[A-Za-z])"    # letter-0-letter, e.g. P0WERDB, M0DEL
    r"|(?<=[A-Za-z])0\b"             # letter-0-boundary, e.g. DLR0, C0NDITI0N's trailing case
    r"|\b0(?=[A-Za-z])"              # boundary-0-letter, e.g. 0VERALL, 0ILTEMP
)
# Deliberately excludes 0-flanked-by-digit (real numbers like "6800", "2018")
# and 0-flanked-by-boundary-on-both-sides (a bare "0" token) -- a 0 only gets
# rewritten when it's actually touching a letter, which never happens in a
# genuine number. Alphanumeric IDs where 0 sits between a letter and a DIGIT
# (e.g. serial "SW93-C0182-B") are also left untouched (only one side is a
# letter; the other is a digit, not a letter-or-boundary), since that shape
# is ambiguous and not what this fix targets.

# Narrow Ω (omega) -> plain "O" misread, seen ONLY inside a unit parenthetical
# ("DLR0 (uO)" for "(µΩ)"). Scoped tightly to u/µ/M immediately followed by a
# bare "O" inside parens -- nowhere near broad enough to touch prose "O"s.
_OCR_OMEGA_AS_O_RE = re.compile(r"\(([uµM])O\)")

# A value's digits split by a hard line-wrap: a short (1-3 digit) run ending
# a line with nothing else after it, immediately followed by another short
# digit run starting the next line. Capped at 3 digits/side so it can only
# ever rejoin what looks like a wrapped token, never swallow an unrelated
# multi-digit reading that legitimately opens the next line. The exact
# capture boundary doesn't affect correctness (see the fix's own dev notes):
# the substitution only deletes the newline/whitespace GAP between two
# digit runs, so any digits outside the match stay exactly where they were.
_OCR_WRAPPED_NUMBER_RE = re.compile(r"(\d{1,3})[ \t]*\n[ \t]*(\d{1,3})(?=\D|$)")


def _ocr_garbled_normalize(text):
    """Best-effort repair of the two garbled-tier corruption patterns above.
    Idempotent and safe to run on already-clean text -- both regexes require
    a specific corruption signature (a 0 touching a letter; a digit run
    ending one line and another starting the very next) that simply doesn't
    occur in correctly-OCR'd or digital-text-layer PDFs, so this is a no-op
    on the clean/partial tiers (verified via the eval harness, not assumed).
    """
    if not text:
        return text
    text = _OCR_OMEGA_AS_O_RE.sub(lambda m: "(%sΩ)" % ("µ" if m.group(1) in ("u", "µ") else "M"), text)
    text = _OCR_ZERO_AS_O_RE.sub("O", text)
    prev = None
    while prev != text:                    # a value can wrap more than once
        prev = text
        text = _OCR_WRAPPED_NUMBER_RE.sub(r"\1\2", text)
    return text


def extract_measurements(cells, page_tables, full_text=""):
    full_text = _ocr_garbled_normalize(full_text)
    table_out = _column_tables(page_tables)              # clean column tables
    grid_out = _powerdb_grids(full_text)                 # PowerDB unit-in-header grids
    dga_out = _dga_readings(full_text)                   # DGA <=LIMIT-anchored table rows (report_002 class)
    pi_out = _pi_readings(full_text)                     # polarization index (ratio — no unit)
    pf_out = _pf_readings(full_text)                     # PF-block table rows (Doble M4100)
    # Column-header inference for two more PowerDB layouts (docs/EVAL_BASELINE_
    # 2026-07.md flagged reports 006/014/017/018 as 0% recall): the "A-G: 15200
    # B-G: 14100 C-G: 16800" bus-inline row under a "(MΩ)" header, and the
    # PHASE / AS-FOUND / EXPECTED / RESULT grid whose measurementType lives on
    # the line above the header. Both require a unit-in-parens header nearby to
    # classify, so a random column table can't hijack them.
    bus_out = _bus_inline_readings(full_text)            # A-G/B-G/C-G bus-inline layout
    phase_grid_out = _phase_grid_readings(full_text)     # PHASE / AS-FOUND / EXPECTED grid
    phase_ctx_out = _phase_context_readings(full_text)   # single-phase-per-line under a context header (VLF tan delta)
    inline_out = _inline_readings(full_text)             # general value+unit pass (post-nameplate-suppression)
    combined = table_out + grid_out + dga_out + pi_out + pf_out + bus_out + phase_grid_out + phase_ctx_out + inline_out
    # Which (type, value, unit) triples already have a PHASED reading (from the
    # richer column-table pass) — used to drop the inline pass's phase-less
    # duplicate of the same value.
    phased = set()
    for m in combined:
        if m.get("phase"):
            phased.add((m.get("measurementType"), m.get("asFoundValue"), m.get("asFoundUnit")))

    # 2026-07-04: a specific-type reading (dissipation_factor, insulation_resistance,
    # trip_time, ...) at a given (phase, value, unit) SHOULD win over a generic
    # fallback (*_reading, or a slug from the unknown-label fallback) at the same
    # place. Prior to this suppression, report_018's `_phase_context_readings`
    # correctly classified "0.12 %" on PHASE A as dissipation_factor but the
    # inline pass ALSO emitted it as percent_reading; both rows survived because
    # their measurementTypes differed. Compute the "specific keys" set first,
    # then drop any generic-typed reading that duplicates them at (phase, val, unit).
    def _is_generic_type(t):
        # Fallback types from _classify: *_reading (voltage_reading, current_reading,
        # time_reading, percent_reading, temperature_reading, frequency_reading),
        # bare "resistance"/"reading", or a slug from the unknown-label branch
        # (short lowercase identifier). Specific NETA types (contact_resistance,
        # insulation_resistance, dissipation_factor, trip_time, dissolved_gas,
        # polarization_index, power_factor, etc.) never end with "_reading" and
        # aren't the bare "resistance"/"reading" strings.
        if not t: return True
        return t.endswith("_reading") or t in ("reading", "resistance")

    specific_phase_val_unit = set()
    for m in combined:
        if not _is_generic_type(m.get("measurementType")):
            specific_phase_val_unit.add((m.get("phase"), m.get("asFoundValue"), m.get("asFoundUnit")))

    combined.sort(key=lambda m: -m.get("confidence", 0))   # best first
    seen = set()
    out = []
    for m in combined:
        tvu = (m.get("measurementType"), m.get("asFoundValue"), m.get("asFoundUnit"))
        if not m.get("phase") and tvu in phased:
            continue   # inline duplicate of a phased column-table reading
        # Drop a generic-type reading when a specific-type reading exists at the
        # same (phase, value, unit). The specific one is a strictly better
        # classification of the same value.
        if _is_generic_type(m.get("measurementType")):
            if (m.get("phase"), m.get("asFoundValue"), m.get("asFoundUnit")) in specific_phase_val_unit:
                continue
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
    unavailable, so callers fail open exactly as before.

    2026-07-04 tuning: scale bumped 2.0 → 3.0 (~216 DPI, the sweet spot
    tesseract's own docs recommend for report-quality text) and PSM 6
    (assume a single uniform block of text) — improves subjective legibility
    on the golden set garbled tier without regressing clean/partial.
    """
    try:
        import pypdfium2 as pdfium
        import pytesseract
    except Exception:
        return ""
    out = []
    try:
        pdf = pdfium.PdfDocument(path)
        for i in range(min(len(pdf), max_pages)):
            pil = pdf[i].render(scale=3.0).to_pil()
            out.append(pytesseract.image_to_string(pil, config='--psm 6'))
        pdf.close()
    except Exception:
        return ""
    return "\n".join(out)


def extract_fields(path: str, mode: str = "all", resume_from: int = None):
    """
    A2 Half 2 (2026-07-05, Option A per Dustin): `resume_from` is threaded
    end-to-end from IngestJob.lastGoodPage (lib/ingestWorker.ts) but does NOT
    skip any pages -- every attempt re-reads the WHOLE document from page 1
    (no incremental merge across attempts; the pipeline's own extraction is
    cheap enough that skipping isn't worth the risk of a real partial-merge
    contract change to extract_measurements()). It is accepted purely for
    observability -- echoed back as `resumed_from` in the return dict so a
    retry is distinguishable from a first attempt in logs/telemetry.

    The actual resilience win is the try/except below: a single page that
    raises (corrupt page object, a pdfplumber bug on one specific page) no
    longer takes down the ENTIRE extraction. Previously any per-page
    exception propagated out of the `with pdfplumber.open()` block uncaught,
    so a job that got 140/150 pages in with zero problems lost ALL 140 pages
    of already-good work the instant page 141 threw -- run.py's outer
    try/except caught it but returned {"ok": false} with zero partial data,
    so a retry (however well the resume hint was plumbed) had nothing to
    build on. Now that failure is caught, `pages_scanned`/`truncated` (and
    the new `page_error`) honestly reflect where we stopped, and
    header/measurement extraction still runs on whatever text was already
    collected -- so a retry has a real floor to improve on instead of a
    total loss.
    """
    cells, line_tables, full_text = [], [], []
    table_settings = {"vertical_strategy": "lines", "horizontal_strategy": "lines"}
    page_count = 0
    pages_scanned = 0
    text_pages = 0
    truncated = False
    page_error = None
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
            try:
                _ptxt = page.extract_text() or ""
                # Per-page text-layer signal: count pages that carry real text so a
                # machine-readable cover sheet in front of a scanned body does not
                # make the whole document look text-based. Feeds the silent-empty
                # guard in ingestConfidenceGate (text_pages < page_count => scan).
                if len(_ptxt.strip()) >= 40:
                    text_pages += 1
                full_text.append(_ptxt)
                pages_scanned = i + 1
                if i < MAX_CELL_PAGES:
                    cells.extend(_page_cells(page))
                if i < MAX_TABLE_PAGES:
                    try:
                        line_tables.extend(page.extract_tables(table_settings) or [])
                    except Exception:
                        pass
            except Exception as e:
                # A2 Half 2: a single bad page stops the sweep (pdfplumber's
                # internal state past a raised page isn't trustworthy) but no
                # longer discards pages 1..i-1 -- record where we stopped so a
                # retry has an honest floor instead of a total loss.
                truncated = True
                page_error = "page %d: %s" % (i + 1, e)
                break
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

    # PowerDB embeds U+2126 OHM SIGN (Ω) and U+00B5 MICRO SIGN (µ); every regex
    # in this pipeline uses U+03A9 GREEK OMEGA / U+00B5 — normalize once here so
    # "Μ Ω" megohm headers and µΩ readings actually match.
    text = text.replace("Ω", "Ω").replace("μ", "µ")

    # A2-adjacent garbled-tier fix (2026-07-05): normalize the whole-word O<->0
    # OCR corruption + line-wrapped-value split (see _ocr_garbled_normalize's
    # docstring above extract_measurements) so extract_header()'s label
    # matching benefits too. Idempotent -- extract_measurements() re-applies
    # it to its own input regardless, so this is purely additive here.
    text = _ocr_garbled_normalize(text)

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

    # Report-level overall verdict — powers domainValidators.verdictCrossCheck.
    # Populated as `meta.reportResult` on the preview (lib/testReportPreview.ts)
    # so the ingestConfidenceGate cross-check (which was already wired but
    # inert because nothing populated the field) can fire on printed vs
    # computed disagreement.
    report_result = _extract_report_verdict(text)

    # Ambient / test temperature (°C) — feeds domainValidators.tempCorrection
    # when the report also carries paired raw + corrected IR readings. Only
    # advisory; a missing value silently no-ops the check.
    ambient_temp_c = _extract_ambient_temp(text)

    return {"fields": header, "measurements": measurements, "full_text": text,
            "ocr": ocr_used, "asset_sections": asset_sections,
            "sections": sections,
            "page_count": page_count, "pages_scanned": pages_scanned,
            "text_pages": text_pages,
            "report_result": report_result,
            "ambient_temp_c": ambient_temp_c,
            "truncated": truncated,
            "page_error": page_error,
            "resumed_from": resume_from}
