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


# ─────────────────────────────────────────────────────────────────────────────
# MEASUREMENT_LIBRARY — full per-form field vocabulary (NETA/PowerDB/Doble/
# Megger + NFPA 70B), flattened for label matching. From
# docs/research/2026-06-12-neta-field-library.md. Each entry: canonical type,
# lowercase label fragments as printed on real forms (substring match), default
# unit, kind (D=diagnostic → pass/fail+trend, R=reference/nameplate), and bad
# direction. A label match here upgrades a generic *_reading to the correct NETA
# type; the kind drives where the UI shows it (diagnostic up top, reference
# tucked below).
# ─────────────────────────────────────────────────────────────────────────────

# Safety / protective-function types — a RED on these is IMMEDIATE.
CRITICAL_TYPES = {
    "contact_resistance", "long_time_trip_time", "short_time_pickup_measured",
    "instantaneous_pickup_measured", "ground_fault_pickup_measured", "gf_pickup_measured",
    "gf_trip_time", "gf_reduced_voltage_trip", "trip_circuit_test", "vacuum_integrity",
    "open_close_timing", "overload_trip_time", "breaker_mcp_pickup", "shutdown_alarm_tests",
    "ground_resistance", "point_to_point_resistance", "pickup_current", "timing_test",
    "min_trip_test", "transfer_time_measured", "pickup_voltage_measured", "trip_time",
    "trip_pickup", "primary_injection", "secondary_injection", "ground_fault_pickup",
}

MEASUREMENT_LIBRARY = [
    # common / test conditions (reference)
    {"type": "test_voltage", "labels": ["test voltage", "test kv", "kvdc", "megger test voltage"], "unit": "kV", "kind": "R", "bad": None},
    {"type": "ambient_temp", "labels": ["ambient temp"], "unit": "°F", "kind": "R", "bad": None},
    {"type": "humidity", "labels": ["humidity"], "unit": "%", "kind": "R", "bad": None},
    {"type": "equipment_temp", "labels": ["equipment temperature", "oil temp", "tank temp", "winding temp", "core/coil temp", "cable temp"], "unit": "°C", "kind": "R", "bad": None},
    {"type": "temp_correction_factor", "labels": ["temperature correction factor", "corr factor"], "unit": None, "kind": "R", "bad": None},
    # transformer (liquid + dry)
    {"type": "insulation_resistance", "labels": ["insulation resistance", "megohms", "megger", "high to low", "low to high", "high+low to gnd", "primary to ground", "primary to secondary", "secondary to ground"], "unit": "MΩ", "kind": "D", "bad": "down"},
    {"type": "polarization_index", "labels": ["polarization index", "p.i."], "unit": "ratio", "kind": "D", "bad": "down"},
    {"type": "dielectric_absorption_ratio", "labels": ["dielectric absorption", "d.a.r.", "dar"], "unit": "ratio", "kind": "D", "bad": "down"},
    {"type": "turns_ratio", "labels": ["turns ratio", "actual ttr", "actual ratio", "measured ratio", "calc ratio", "ttr"], "unit": "ratio", "kind": "D", "bad": "delta"},
    {"type": "turns_ratio_error", "labels": ["% error", "percent error", "% deviation"], "unit": "%", "kind": "D", "bad": "up"},
    {"type": "excitation_current", "labels": ["excitation current", "exciting current", "i exc", "iexc"], "unit": "mA", "kind": "D", "bad": "delta"},
    {"type": "winding_resistance", "labels": ["winding resistance", "measured resistance", "corrected to 85"], "unit": "mΩ", "kind": "D", "bad": "delta"},
    {"type": "power_factor", "labels": ["power factor", "% power factor", "dissipation factor", "tan delta", "chl", "chg", "clg"], "unit": "%", "kind": "D", "bad": "up"},
    {"type": "capacitance", "labels": ["capacitance"], "unit": "pF", "kind": "D", "bad": "delta"},
    {"type": "bushing_c1_power_factor", "labels": ["c1 power factor", "bushing c1"], "unit": "%", "kind": "D", "bad": "up"},
    {"type": "hot_collar_watts", "labels": ["hot collar"], "unit": "W", "kind": "D", "bad": "up"},
    {"type": "leakage_reactance_pct", "labels": ["leakage reactance", "% impedance"], "unit": "%", "kind": "D", "bad": "delta"},
    {"type": "hipot_leakage_current", "labels": ["high potential", "leakage current", "micro/milliamperes"], "unit": "µA", "kind": "D", "bad": "up"},
    {"type": "dielectric_breakdown", "labels": ["dielectric strength", "d-877", "d-1816", "breakdown voltage"], "unit": "kV", "kind": "D", "bad": "down"},
    {"type": "interfacial_tension", "labels": ["interfacial tension", "ift", "d-971"], "unit": "dyn/cm", "kind": "D", "bad": "down"},
    {"type": "acid_number", "labels": ["acid number", "acidity", "d-974", "mg koh/g"], "unit": "mgKOH/g", "kind": "D", "bad": "up"},
    {"type": "water_content", "labels": ["water content", "moisture", "d-1533", "k.f."], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "oil_power_factor", "labels": ["power factor-25", "pf at 25", "d-924"], "unit": "%", "kind": "D", "bad": "up"},
    {"type": "dga_hydrogen", "labels": ["hydrogen", "(h2)"], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "dga_methane", "labels": ["methane", "(ch4)"], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "dga_ethane", "labels": ["ethane", "(c2h6)"], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "dga_ethylene", "labels": ["ethylene", "(c2h4)"], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "dga_acetylene", "labels": ["acetylene", "(c2h2)"], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "dga_carbon_monoxide", "labels": ["carbon monoxide", "(co)"], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "dga_carbon_dioxide", "labels": ["carbon dioxide", "(co2)"], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "dga_tdcg", "labels": ["total combustible gas", "tdcg"], "unit": "ppm", "kind": "D", "bad": "up"},
    {"type": "furan_2fal", "labels": ["2fal", "furan"], "unit": "ppb", "kind": "D", "bad": "up"},
    {"type": "kva_rating", "labels": ["kva", "capacity"], "unit": "kVA", "kind": "R", "bad": None},
    {"type": "tap_setting", "labels": ["tap setting", "tap position", "detc", "ltc"], "unit": None, "kind": "R", "bad": None},
    # circuit breaker (LV + MV)
    {"type": "contact_resistance", "labels": ["contact resistance", "pole resistance", "micro-ohms", "microhms", "interrupter resistance", "dlro", "micro ohm"], "unit": "µΩ", "kind": "D", "bad": "delta"},
    {"type": "long_time_trip_time", "labels": ["long time", "time at 300%", "ltpu"], "unit": "sec", "kind": "D", "bad": "delta"},
    {"type": "short_time_pickup_measured", "labels": ["short time", "stpu"], "unit": "A", "kind": "D", "bad": "delta"},
    {"type": "instantaneous_pickup_measured", "labels": ["instantaneous", "ipu", "inst. pu", "trip / no trip"], "unit": "A", "kind": "D", "bad": "delta"},
    {"type": "ground_fault_pickup_measured", "labels": ["ground fault", "gfpu", "grd. flt."], "unit": "A", "kind": "D", "bad": "delta"},
    {"type": "tank_loss_index", "labels": ["tank loss index", "tli"], "unit": "W", "kind": "D", "bad": "up"},
    {"type": "open_close_timing", "labels": ["open / close times", "trip time", "timing"], "unit": "ms", "kind": "D", "bad": "delta"},
    {"type": "contact_travel", "labels": ["contact travel", "wipe", "gap"], "unit": "in", "kind": "D", "bad": "delta"},
    {"type": "vacuum_integrity", "labels": ["vacuum integrity", "vacuum bottle"], "unit": "pass/fail", "kind": "D", "bad": "cat"},
    {"type": "oil_dielectric", "labels": ["oil dielectric"], "unit": "kV", "kind": "D", "bad": "down"},
    {"type": "sf6_moisture", "labels": ["sf6 moisture", "dew point"], "unit": "°C", "kind": "D", "bad": "up"},
    {"type": "counter_reading", "labels": ["counter reading", "operations counter"], "unit": "count", "kind": "R", "bad": None},
    # protective relay
    {"type": "pickup_current", "labels": ["pickup tests", "time overcurrent pickup", "as found (amps)"], "unit": "A", "kind": "D", "bad": "delta"},
    {"type": "timing_test", "labels": ["timing tests", "as found (seconds)"], "unit": "sec", "kind": "D", "bad": "delta"},
    {"type": "voltage_pickup", "labels": ["pickup voltage", "under voltage", "over voltage"], "unit": "V", "kind": "D", "bad": "delta"},
    {"type": "reach_measured", "labels": ["reach tests", "mta", "characteristic"], "unit": "Ω", "kind": "D", "bad": "delta"},
    {"type": "trip_circuit_test", "labels": ["trip circuit tested", "trip test"], "unit": "pass/fail", "kind": "D", "bad": "cat"},
    {"type": "ct_ratio", "labels": ["ct ratio", "ctr"], "unit": "ratio", "kind": "R", "bad": None},
    {"type": "setting_time_dial", "labels": ["time dial"], "unit": None, "kind": "R", "bad": None},
    # cable
    {"type": "vlf_withstand_result", "labels": ["vlf", "breakdown yes no", "time to failure", "withstand"], "unit": "pass/fail", "kind": "D", "bad": "cat"},
    {"type": "tan_delta", "labels": ["tan delta"], "unit": "1e-3", "kind": "D", "bad": "up"},
    {"type": "tan_delta_tip_up", "labels": ["tip up", "delta td"], "unit": "1e-3", "kind": "D", "bad": "up"},
    {"type": "dc_hipot_leakage", "labels": ["microamps"], "unit": "µA", "kind": "D", "bad": "up"},
    {"type": "shield_resistance", "labels": ["shield resistance", "concentric neutral"], "unit": "Ω", "kind": "D", "bad": "up"},
    {"type": "partial_discharge", "labels": ["pdiv", "pdev"], "unit": "pC", "kind": "D", "bad": "up"},
    # battery / UPS
    {"type": "cell_float_voltage", "labels": ["cell voltage", "float voltage", "voltage (volts)"], "unit": "V", "kind": "D", "bad": "delta"},
    {"type": "string_float_voltage", "labels": ["overall voltage", "total string voltage"], "unit": "V", "kind": "D", "bad": "delta"},
    {"type": "cell_internal_ohmic", "labels": ["resistance (micro-ohms)", "impedance (milli-ohms)", "% variation"], "unit": "µΩ", "kind": "D", "bad": "up"},
    {"type": "intercell_resistance", "labels": ["intercell resistance", "strap"], "unit": "µΩ", "kind": "D", "bad": "up"},
    {"type": "specific_gravity", "labels": ["specific gravity", "spec. gravity", "hydrometer"], "unit": "sg", "kind": "D", "bad": "down"},
    {"type": "capacity_percent", "labels": ["percent capacity", "battery capacity - percent"], "unit": "%", "kind": "D", "bad": "down"},
    {"type": "discharge_duration", "labels": ["actual discharge time", "actual discharge - minutes"], "unit": "min", "kind": "D", "bad": "down"},
    {"type": "ripple_current", "labels": ["ripple current", "total ac current"], "unit": "A", "kind": "D", "bad": "up"},
    # grounding
    {"type": "ground_resistance", "labels": ["fall of potential", "ground resistance", "ground impedance", "clamp-on", "3-point"], "unit": "Ω", "kind": "D", "bad": "up"},
    {"type": "point_to_point_resistance", "labels": ["point to point", "continuity", "bonding"], "unit": "Ω", "kind": "D", "bad": "up"},
    {"type": "soil_resistivity", "labels": ["soil resistivity", "wenner", "ohm-meter"], "unit": "Ω·m", "kind": "R", "bad": None},
    {"type": "touch_voltage", "labels": ["touch voltage"], "unit": "V", "kind": "D", "bad": "up"},
    {"type": "step_voltage", "labels": ["step voltage"], "unit": "V", "kind": "D", "bad": "up"},
    # switchgear / bus
    {"type": "bus_joint_resistance", "labels": ["resistance in micro-ohms", "bus connection", "connection resistance"], "unit": "µΩ", "kind": "D", "bad": "delta"},
    # transfer switch
    {"type": "pickup_voltage_measured", "labels": ["source pickup"], "unit": "V", "kind": "D", "bad": "delta"},
    {"type": "dropout_voltage_measured", "labels": ["dropout voltage"], "unit": "V", "kind": "D", "bad": "delta"},
    {"type": "transfer_time_measured", "labels": ["transfer to emergency", "re-transfer to normal", "engine cool down", "time delays"], "unit": "sec", "kind": "D", "bad": "delta"},
    # disconnect / fuse
    {"type": "fuse_resistance", "labels": ["fuse holder", "fuse resistance"], "unit": "µΩ", "kind": "D", "bad": "delta"},
    # instrument transformer
    {"type": "ratio_measured", "labels": ["actual ratio", "measured ratio"], "unit": "ratio", "kind": "D", "bad": "delta"},
    {"type": "polarity", "labels": ["polarity", "subtractive"], "unit": "pass/fail", "kind": "D", "bad": "cat"},
    {"type": "knee_point", "labels": ["knee point", "knee voltage", "saturation"], "unit": "V", "kind": "D", "bad": "down"},
    {"type": "burden_measured", "labels": ["burden"], "unit": "VA", "kind": "D", "bad": "up"},
    # generator / motor
    {"type": "tip_up_power_factor", "labels": ["tip up"], "unit": "%", "kind": "D", "bad": "up"},
    {"type": "load_test_kw", "labels": ["measured kilowatt", "target kilowatt"], "unit": "kW", "kind": "D", "bad": "down"},
    {"type": "engine_oil_pressure", "labels": ["engine oil pressure"], "unit": "psi", "kind": "D", "bad": "down"},
    {"type": "shutdown_alarm_tests", "labels": ["overspeed shutdown", "low oil pressure shutdown", "emergency stop", "alarm initiated"], "unit": "pass/fail", "kind": "D", "bad": "cat"},
    # MCC / overload
    {"type": "overload_trip_time", "labels": ["o/l test", "delay @ 300%"], "unit": "sec", "kind": "D", "bad": "delta"},
    # VFD
    {"type": "dc_bus_voltage", "labels": ["dc bus voltage"], "unit": "VDC", "kind": "D", "bad": "delta"},
    {"type": "dc_bus_ripple", "labels": ["dc bus ac ripple"], "unit": "VAC", "kind": "D", "bad": "up"},
    # surge arrester
    {"type": "arrester_watts_loss", "labels": ["gst-gnd"], "unit": "W", "kind": "D", "bad": "up"},
    # ground-fault protection
    {"type": "gf_pickup_measured", "labels": ["ground fault pickup", "gf pickup"], "unit": "A", "kind": "D", "bad": "delta"},
    {"type": "gf_trip_time", "labels": ["ground fault timing", "gf timing"], "unit": "sec", "kind": "D", "bad": "up"},
]

# Pre-sort label fragments longest-first so the most specific match wins.
_LIB_SORTED = sorted(
    ((lbl, e) for e in MEASUREMENT_LIBRARY for lbl in e["labels"]),
    key=lambda p: -len(p[0]),
)


def classify_label(label):
    """Match a reading's label text against MEASUREMENT_LIBRARY; return the
    matching entry dict (or None). Most-specific (longest) fragment wins."""
    low = " " + (label or "").lower() + " "
    for lbl, e in _LIB_SORTED:
        if lbl in low:
            return e
    return None
