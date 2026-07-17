#!/usr/bin/env python3
"""
server/scripts/afx_table_extract.py

Deterministic arc-flash RESULTS-TABLE extractor for text-based study reports.
Reads the per-bus IEEE-1584 summary table from SKM PowerTools exports WITHOUT
any AI, so a clean study report skips the paid/latency AI cascade entirely
(and still works when the AI provider is degraded).

Format-specific parsers (a "few super-common report" parsers), dispatched by
best confidence:
  - skm_dapper    : SKM Dapper "Arc Flash Analysis Summary Table" (12 fixed cols)
  - skm_ieee1584  : SKM "IEEE 1584 Bus Report" export (header-x-anchored cols)

Usage:  python3 afx_table_extract.py <report.pdf>
Output: JSON {ok, parser, confidence, count, buses:[...]} to stdout. Never AI.
Emits bus fields in the RAW shape lib/arcFlashExtract.normalizeExtraction() expects.
Confidence gating + fail-open handling live in the TS caller (lib/afxDeterministicTable.ts).
"""
import sys, json, re

NUMERIC = re.compile(r"^-?\d+(?:\.\d+)?$")
EQUIP = {"PNL":"PANELBOARD","SWG":"SWITCHGEAR","SWBD":"SWITCHBOARD","MCC":"MCC",
         "CBL":"CABLE_LV","CABLE":"CABLE_LV","OA":"BUSWAY","BUS":"SWITCHGEAR",
         "XFMR":"TRANSFORMER_DRY","PANEL":"PANELBOARD","OPEN":"BUSWAY"}

def _num(t):
    try: return float(str(t).replace(",",""))
    except Exception: return None

def _volt_str(kv):
    if kv is None: return None
    return f"{int(round(kv*1000))}V" if kv < 1 else (f"{kv:g}kV")

def _rows(words, ytol=3):
    d={}
    for w in words: d.setdefault(round(w["top"]/ytol),[]).append(w)
    return [sorted(d[k],key=lambda x:x["x0"]) for k in sorted(d)]

def _mk(busName, kv, ie, afb=None, wd=None, gap=None, equip=None, bolted=None, arcing=None, trip_s=None, dev=None):
    return {
        "busName": busName, "equipmentType": equip, "nominalVoltage": _volt_str(kv),
        "boltedFaultCurrentKA": bolted, "arcingCurrentKA": arcing,
        "conductorGapMm": gap, "workingDistanceIn": wd,
        "clearingTimeMs": (round(trip_s*1000,1) if trip_s is not None else None),
        "upstreamDevice": (dev or None), "incidentEnergyCalCm2": ie, "arcFlashBoundaryIn": afb,
    }

# ---- Parser 1: SKM Dapper "Arc Flash Analysis Summary Table" ----
def _skm_dapper(pdf):
    sig = any("Arc Flash Analysis Summary Table" in (p.extract_text() or "")
              or "Arc Flash Summary Table" in (p.extract_text() or "") for p in pdf.pages[:90])
    if not sig: return []
    out=[]
    for pg in pdf.pages:
        t=(pg.extract_text() or "")
        if "cal/cm" not in t.replace(" ",""): continue
        for ws in _rows(pg.extract_words(use_text_flow=True)):
            toks=[w["text"] for w in ws]
            if len(toks)<13: continue
            volt,bBus,bPD,aPD,trip,brk,gnd,equip,gap,afb,wd,ie = toks[-12:]
            prefix=ws[:-12]
            if not (all(_num(x) is not None for x in (volt,bBus,aPD,gap,afb,wd,ie)) and equip.upper() in EQUIP and prefix): continue
            if len(prefix)==1: bus,dev=prefix[0]["text"],""
            else:
                gi=max(range(len(prefix)-1), key=lambda i: prefix[i+1]["x0"]-prefix[i]["x1"])
                bus=" ".join(w["text"] for w in prefix[:gi+1]); dev=" ".join(w["text"] for w in prefix[gi+1:])
            out.append(_mk(bus,_num(volt),_num(ie),_num(afb),_num(wd),_num(gap),EQUIP.get(equip.upper()),_num(bBus),_num(aPD),_num(trip),dev))
    return out

# ---- Parser 2: SKM "IEEE 1584 Bus Report" export ----
def _skm_ieee1584(pdf):
    if not any("IEEE 1584 Bus Report" in (p.extract_text() or "") for p in pdf.pages[:120]): return []
    out=[]
    for pg in pdf.pages:
        t=(pg.extract_text() or "")
        if "Incident" not in t or ("Boundary" not in t and "cal/cm2" not in t): continue
        hdr=[w for r in _rows(pg.extract_words(use_text_flow=True))[:12] for w in r]
        def ax(pred):
            xs=[(w["x0"]+w["x1"])/2 for w in hdr if pred(w["text"].lower())]
            return xs[0] if xs else None
        A={"kv":ax(lambda s:s=="kv"),"gap":ax(lambda s:s in("(mm)","gap")),"equip":ax(lambda s:s in("type","equip")),
           "afb":ax(lambda s:"boundary" in s),"wd":ax(lambda s:"distance" in s),"ie":ax(lambda s:"cal/cm2" in s)}
        if A["ie"] is None or A["kv"] is None: continue
        for ws in _rows(pg.extract_words(use_text_flow=True)):
            eqs=[w for w in ws if w["text"].upper() in EQUIP]
            nums=[w for w in ws if NUMERIC.match(w["text"])]
            if not eqs or len(nums)<5: continue
            eq=min(eqs,key=lambda w:abs((w["x0"]+w["x1"])/2-A["equip"]) if A["equip"] else 0)
            def near(xa,tol=16):
                if xa is None: return None
                c=[w for w in nums if abs((w["x0"]+w["x1"])/2-xa)<=tol]
                return _num(min(c,key=lambda w:abs((w["x0"]+w["x1"])/2-xa))["text"]) if c else None
            kvx=A["kv"]
            name=[w for w in ws if 52<(w["x0"]+w["x1"])/2<kvx-8 and w["text"] not in("Level","#") and not w["text"].startswith("(*")]
            bus=" ".join(w["text"] for w in name if (w["x0"]+w["x1"])/2<140).strip()
            dev=" ".join(w["text"] for w in name if (w["x0"]+w["x1"])/2>=140).strip()
            ie=near(A["ie"]); kv=near(kvx)
            if not bus or ie is None or kv is None: continue
            out.append(_mk(bus,kv,ie,near(A["afb"]),near(A["wd"]),near(A["gap"]),EQUIP.get(eq["text"].upper()),None,None,None,dev))
    return out

PARSERS=[("skm_dapper",_skm_dapper),("skm_ieee1584",_skm_ieee1584)]

def _dedup(buses):
    by={}
    for b in buses:
        k=(b["busName"] or "").lower()
        if not k: continue
        if k not in by or (b["incidentEnergyCalCm2"] or 0)>(by[k]["incidentEnergyCalCm2"] or 0): by[k]=b
    return list(by.values())

def extract(path):
    import pdfplumber
    best={"ok":True,"parser":None,"confidence":0.0,"count":0,"buses":[]}
    with pdfplumber.open(path) as pdf:
        for name,fn in PARSERS:
            try: buses=_dedup(fn(pdf))
            except Exception: buses=[]
            if not buses: continue
            good=[b for b in buses if b["incidentEnergyCalCm2"] is not None and b["nominalVoltage"] is not None]
            conf=round(len(good)/max(len(buses),1),3)
            if conf>best["confidence"] or (conf==best["confidence"] and len(buses)>best["count"]):
                best={"ok":True,"parser":name,"confidence":conf,"count":len(buses),"buses":buses}
    return best

if __name__=="__main__":
    try:
        print(json.dumps(extract(sys.argv[1])))
    except Exception as e:
        print(json.dumps({"ok":False,"error":str(e),"parser":None,"confidence":0.0,"count":0,"buses":[]}))
