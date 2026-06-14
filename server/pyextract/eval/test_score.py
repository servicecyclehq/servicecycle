"""Pure-logic tests for the scorer (python -m pytest test_score.py)."""
from score import score_one


def test_perfect_match():
    gt = {"fields": {"serialNumber": "ABC-1"}, "measurements": [
        {"measurementType": "insulation_resistance", "phase": "A", "asFoundValue": 1450.0, "asFoundUnit": "M" + chr(0x3a9), "passFail": "GREEN"}]}
    s = score_one(gt, gt)
    assert s["field_ok"] == 1 and s["located"] == 1
    assert s["phase_ok"] == 1 and s["unit_ok"] == 1 and s["pf_ok"] == 1


def test_located_but_wrong_attributes():
    gt = {"fields": {"serialNumber": "ABC-1", "vendor": "ACME"}, "measurements": [
        {"measurementType": "winding_resistance", "phase": "A", "asFoundValue": 21.1, "asFoundUnit": "m" + chr(0x3a9), "passFail": "GREEN"}]}
    ext = {"fields": {"serialNumber": "ABC-1"}, "measurements": [
        {"measurementType": "winding_resistance", "phase": None, "asFoundValue": 21.1, "asFoundUnit": "M" + chr(0x3a9), "passFail": None}]}
    s = score_one(gt, ext)
    assert s["field_ok"] == 1 and s["field_total"] == 2     # vendor missed
    assert s["located"] == 1                                # value matched
    assert s["phase_ok"] == 0 and s["unit_ok"] == 0 and s["pf_ok"] == 0  # milli vs mega, phase, pf all wrong


def test_not_located():
    gt = {"fields": {}, "measurements": [{"measurementType": "x", "phase": "A", "asFoundValue": 99, "asFoundUnit": "u", "passFail": "GREEN"}]}
    s = score_one(gt, {"fields": {}, "measurements": []})
    assert s["meas_total"] == 1 and s["located"] == 0