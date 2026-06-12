"""
neta_field_library.py -- field/measurement vocabulary for NETA / PowerDB /
Megger electrical test reports. The ServiceCycle analog of LapseIQ's
invoice_field_library: you don't template per vendor, you describe each FIELD
(label synonyms + datatype) and each measurement TYPE once, and it generalizes.

Sources: docs/research/powerdb-templates/ (15 per-equipment-type PowerDB form
templates) + NETA MTS measurement vocabulary.
"""

import re

DTYPE_PATTERNS = {
    "date": re.compile(
        r"(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}"
        r"|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}"
        r"|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{2,4}"
        r"|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{2,4})"
    ),
    "number": re.compile(r"-?\d+(?:\.\d+)?"),
    "percent": re.compile(r"\d{1,3}(?:\.\d+)?\s*%"),
    "id": re.compile(r"[A-Za-z0-9][A-Za-z0-9\-_/\.]{1,}"),
    "string": re.compile(r".+"),
    "result": re.compile(r".+"),
}

# Header / nameplate fields on a test report. dtype drives validation.
HEADER_FIELDS = [
    {"key": "serialNumber", "dtype": "serial", "labels": ["serial number", "serial no", "serial #", "serial", "s/n", "sn"]},
    {"key": "model",        "dtype": "id",     "labels": ["model number", "model no", "model", "catalog number", "catalog no", "cat no", "type/model", "part/style no"]},
    {"key": "manufacturer", "dtype": "name",   "labels": ["manufacturer", "mfr"]},
    {"key": "testDate",     "dtype": "date",   "labels": ["test date", "date of test", "date tested", "date"]},
    {"key": "vendor",       "dtype": "name",   "labels": ["vendor", "test company", "tested by company", "service provider", "company"]},
    {"key": "techName",     "dtype": "name",   "labels": ["technician", "tested by", "test technician", "test engineer", "inspector", "tech"]},
    {"key": "customer",     "dtype": "name",   "labels": ["customer", "client"]},
    {"key": "owner",        "dtype": "name",   "labels": ["owner representative", "owner"]},
    {"key": "substation",   "dtype": "id",     "labels": ["substation", "s/s"]},
    {"key": "position",     "dtype": "id",     "labels": ["position", "feeder", "circuit designation", "bay"]},
    {"key": "location",     "dtype": "name",   "labels": ["eqpt. location", "equipment location", "location"]},
    {"key": "equipmentType","dtype": "name",   "labels": ["equipment type", "apparatus type", "device type", "apparatus"]},
]

# Words/fragments that are NEVER a real header value (they are labels, table
# headers, or boilerplate the old regex grabbed by mistake).
HEADER_STOPWORDS = {
    "as", "found", "left", "label", "used", "forms", "meter", "grade", "no",
    "number", "type", "test", "model", "serial", "date", "page", "of", "the",
    "and", "n/a", "na", "none", "tbd", "see", "below", "above", "yes", "rating",
    "class", "data", "nameplate", "description", "condition", "inspected",
    "manufacturer", "customer", "owner", "address", "telephone", "temperature",
    "humidity", "weather", "voltage", "frequency", "max", "available", "ratio",
    "year", "bushing", "equipment", "wps", "std", "ieee", "system", "switchyard",
    "compliant", "grade", "class", "series", "m&te", "cal", "due", "customer",
    "copyright", "function", "signature", "name", "reference", "position",
}

# Measurement vocabulary: label -> canonical type, default unit, bad direction,
# whether RED is safety-critical (drives IMMEDIATE vs RECOMMENDED deficiency).
MEASUREMENT_VOCAB = {
    "insulation resistance":      {"type": "insulation_resistance",      "unit": "MΩ",   "bad": "down", "critical": False},
    "polarization index":         {"type": "polarization_index",         "unit": "ratio","bad": "down", "critical": False},
    "dielectric absorption":      {"type": "dielectric_absorption_ratio","unit": "ratio","bad": "down", "critical": False},
    "contact resistance":         {"type": "contact_resistance",         "unit": "µΩ",   "bad": "up",   "critical": True},
    "micro-ohm":                  {"type": "contact_resistance",         "unit": "µΩ",   "bad": "up",   "critical": True},
    "winding resistance":         {"type": "winding_resistance",         "unit": "mΩ",   "bad": "up",   "critical": False},
    "power factor":               {"type": "power_factor",               "unit": "%",    "bad": "up",   "critical": False},
    "dissipation factor":         {"type": "dissipation_factor",         "unit": "%",    "bad": "up",   "critical": False},
    "dissolved gas":              {"type": "dissolved_gas",              "unit": "ppm",  "bad": "up",   "critical": False},
    "turns ratio":                {"type": "turns_ratio_measured",       "unit": "ratio","bad": "up",   "critical": False},
    "ttr":                        {"type": "turns_ratio_measured",       "unit": "ratio","bad": "up",   "critical": False},
    "excitation current":         {"type": "excitation_current",         "unit": "mA",   "bad": "up",   "critical": False},
    "ground resistance":          {"type": "ground_resistance",          "unit": "Ω",    "bad": "up",   "critical": True},
    "ground fault":               {"type": "ground_fault_pickup",        "unit": "A",    "bad": "up",   "critical": True},
    "trip time":                  {"type": "trip_time",                  "unit": "sec",  "bad": "up",   "critical": True},
    "trip test":                  {"type": "trip_time",                  "unit": "sec",  "bad": "up",   "critical": True},
    "pickup":                     {"type": "trip_pickup",                "unit": "A",    "bad": "up",   "critical": True},
    "primary injection":          {"type": "primary_injection",          "unit": "A",    "bad": "up",   "critical": True},
    "secondary injection":        {"type": "secondary_injection",        "unit": "A",    "bad": "up",   "critical": True},
}

# Ruled-table column header -> role. role 'description' carries the measurement
# name (matched against MEASUREMENT_VOCAB); the rest fill the measurement record.
MEASUREMENT_COLUMNS = [
    {"role": "description", "labels": ["test", "description", "measurement", "parameter", "reading"]},
    {"role": "phase",       "labels": ["phase", "ph", "pole", "winding", "connection"]},
    {"role": "value",       "labels": ["value", "result value", "as found", "as-found", "measured", "reading value", "actual"]},
    {"role": "unit",        "labels": ["unit", "units"]},
    {"role": "expected",    "labels": ["expected", "limit", "minimum", "min", "spec", "nameplate", "acceptance"]},
    {"role": "result",      "labels": ["result", "pass/fail", "status", "verdict", "assessment", "condition"]},
]

# Verdict-token normalization -> ResultRating (GREEN/YELLOW/RED).
RESULT_TOKENS = {
    "GREEN": "GREEN", "PASS": "GREEN", "SAT": "GREEN", "OK": "GREEN",
    "YELLOW": "YELLOW", "MARGINAL": "YELLOW", "CAUTION": "YELLOW", "MONITOR": "YELLOW",
    "RED": "RED", "FAIL": "RED", "UNSAT": "RED", "DEFICIENT": "RED",
}

_UNIT_NORM = [
    (re.compile(r"^(m\s?ohm|mohm|megohm|mΩ|meg)", re.I), "MΩ"),
    (re.compile(r"^(u\s?ohm|uohm|µΩ|micro)", re.I), "µΩ"),
    (re.compile(r"^(milliohm|mΩ)$", re.I), "mΩ"),
    (re.compile(r"^(k\s?ohm|kohm|kΩ)", re.I), "kΩ"),
    (re.compile(r"^(ohm|Ω)$", re.I), "Ω"),
    (re.compile(r"ppm", re.I), "ppm"),
    (re.compile(r"vdc", re.I), "VDC"),
    (re.compile(r"kv", re.I), "kV"),
    (re.compile(r"sec|second", re.I), "sec"),
    (re.compile(r"^%$"), "%"),
]


def normalize_unit(u: str) -> str:
    if not u:
        return None
    u = u.strip()
    for pat, norm in _UNIT_NORM:
        if pat.search(u):
            return norm
    return u
