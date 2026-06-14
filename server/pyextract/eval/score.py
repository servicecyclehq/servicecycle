"""
score.py -- field-level scoring of an extraction vs ground truth. Pure logic.

Measurements are matched PHASE-AGNOSTICALLY by (measurementType, value-within-
tolerance): this answers "did we locate the reading at all" without letting a
missed phase zero everything out. Among located readings we then report whether
phase, unit, and pass/fail were ALSO correct -- so the harness distinguishes
"found the number" from "got every attribute right."
"""
import unicodedata


def _norm(s):
    if s is None:
        return ""
    return unicodedata.normalize("NFKC", str(s)).strip().lower()


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def score_one(gt, ext):
    ext = ext or {}
    gf = gt.get("fields", {}) or {}
    ef = ext.get("fields", {}) or {}
    field_total = len(gf)
    field_ok = sum(1 for k, v in gf.items() if ef.get(k) is not None and _norm(ef.get(k)) == _norm(v))

    gm = gt.get("measurements", []) or []
    em = list(ext.get("measurements", []) or [])
    meas_total = len(gm)
    located = phase_ok = unit_ok = pf_ok = 0
    for g in gm:
        gt_type = g.get("measurementType")
        gv = _num(g.get("asFoundValue"))
        match = None
        for e in em:
            if e.get("measurementType") != gt_type:
                continue
            ev = _num(e.get("asFoundValue"))
            if gv is not None and ev is not None and abs(gv - ev) <= max(0.5, abs(gv) * 0.01):
                match = e
                break
        if match is None:
            continue
        em.remove(match)
        located += 1
        if _norm(match.get("phase")) == _norm(g.get("phase")):
            phase_ok += 1
        if _norm(match.get("asFoundUnit")) == _norm(g.get("asFoundUnit")):
            unit_ok += 1
        if (match.get("passFail") or "") == (g.get("passFail") or ""):
            pf_ok += 1
    return {
        "field_total": field_total, "field_ok": field_ok,
        "meas_total": meas_total, "located": located,
        "phase_ok": phase_ok, "unit_ok": unit_ok, "pf_ok": pf_ok,
    }