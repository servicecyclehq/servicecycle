"""Synthetic A/B (redundant-train) one-line diagrams for regression-testing the
arc-flash extractor's side (A/B train) normalization -- specifically the
LEFT/RIGHT recognition added 2026-07-23 (see server/lib/arcFlashExtract.ts's
normSide()). Reuses the existing sld.py one-line generator so these look like
the same "realistic SKM/CAPTOR-style" diagrams already used for the demo data.

Three diagrams, three different real-world side-label vocabularies:
  1. northfield_dc_train_ab.pdf      -- "TRAIN A" / "TRAIN B"     (pre-existing supported form -- regression baseline)
  2. meridian_health_left_right.pdf  -- "LEFT" / "RIGHT"          (the exact gap the fix closes, bare form)
  3. riverside_industrial_leftside.pdf -- "LEFT SIDE" / "RIGHT SIDE" (fix variant + an N+1 callout)

Each diagram deliberately leaves the deepest leaf nodes (racks/pumps) WITHOUT a
side label, to also confirm normSide() still returns null rather than guessing
when nothing is actually labeled.

Run: python gen_test_onelines.py
"""
import sys, os
sys.path.insert(0, r'C:\Users\ddeni\Desktop\ServiceCycle\Cowork Deliverables 2026-07-17\code')
from sld import build_sld

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

NORTHFIELD = {
    'site': 'Northfield Data Center - Hall 2',
    'dwg_no': 'SC-TEST-001',
    'date': 'JULY 2026',
    'revision': '0',
    'sheet_tag': 'ONE-LINE DIAGRAM - 2N DISTRIBUTION',
    'metering': {'ct': '4000:5A'},
    'notes': [
        'System configured 2N: Train A and Train B are each independently capable of carrying full IT load.',
        'Fabricated data for ServiceCycle extractor regression testing -- not a real facility.',
    ],
    'nodes': [
        {'id': 'UTIL', 'kind': 'utility', 'name': 'UTILITY SERVICE', 'lines': ['13.8kV, 3-PH']},
        {'id': 'MTX', 'kind': 'xfmr', 'fedFrom': 'UTIL', 'name': 'MAIN-XFMR', 'lines': ['2000 kVA', '13.8kV-480Y/277V', 'Z=5.75%'], 'device': 'UTIL FUSE', 'devSpec': '200E'},
        {'id': 'SWGR-MAIN', 'kind': 'bus', 'fedFrom': 'MTX', 'name': 'SWGR-MAIN', 'lines': ['480Y/277V, 4000A'], 'device': 'MAIN-CB', 'devFunc': '52', 'devSpec': '4000AF/4000AT'},
        {'id': 'SWGR-A', 'kind': 'bus', 'fedFrom': 'SWGR-MAIN', 'name': 'SWGR-A', 'lines': ['TRAIN A', '480V, 3000A'], 'device': 'CB-A'},
        {'id': 'PDU-A1', 'kind': 'panel', 'fedFrom': 'SWGR-A', 'name': 'PDU-A1', 'lines': ['TRAIN A', '480-208Y/120V']},
        {'id': 'RACK-A1', 'kind': 'load', 'fedFrom': 'PDU-A1', 'name': 'RACK ROW A1', 'lines': ['IT LOAD, 208V']},
        {'id': 'SWGR-B', 'kind': 'bus', 'fedFrom': 'SWGR-MAIN', 'name': 'SWGR-B', 'lines': ['TRAIN B', '480V, 3000A'], 'device': 'CB-B'},
        {'id': 'PDU-B1', 'kind': 'panel', 'fedFrom': 'SWGR-B', 'name': 'PDU-B1', 'lines': ['TRAIN B', '480-208Y/120V']},
        {'id': 'RACK-B1', 'kind': 'load', 'fedFrom': 'PDU-B1', 'name': 'RACK ROW B1', 'lines': ['IT LOAD, 208V']},
    ],
}

MERIDIAN = {
    'site': 'Meridian Health Data Hall',
    'dwg_no': 'SC-TEST-002',
    'date': 'JULY 2026',
    'revision': '0',
    'sheet_tag': 'ONE-LINE DIAGRAM - N+1 DISTRIBUTION',
    'metering': {'ct': '3000:5A'},
    'notes': [
        'N+1 distribution: Left and Right paths share the common main switchgear bus upstream.',
        'Fabricated data for ServiceCycle extractor regression testing -- not a real facility.',
    ],
    'nodes': [
        {'id': 'UTIL', 'kind': 'utility', 'name': 'UTILITY SERVICE', 'lines': ['13.8kV, 3-PH']},
        {'id': 'MTX', 'kind': 'xfmr', 'fedFrom': 'UTIL', 'name': 'MAIN-XFMR', 'lines': ['1500 kVA', '13.8kV-480Y/277V', 'Z=5.5%'], 'device': 'UTIL FUSE', 'devSpec': '150E'},
        {'id': 'SWGR-MAIN', 'kind': 'bus', 'fedFrom': 'MTX', 'name': 'SWGR-MAIN', 'lines': ['480Y/277V, 3000A'], 'device': 'MAIN-CB', 'devFunc': '52', 'devSpec': '3000AF/3000AT'},
        {'id': 'SWGR-L', 'kind': 'bus', 'fedFrom': 'SWGR-MAIN', 'name': 'SWGR-L', 'lines': ['LEFT', '480V, 2000A'], 'device': 'CB-L'},
        {'id': 'PDU-L1', 'kind': 'panel', 'fedFrom': 'SWGR-L', 'name': 'PDU-L1', 'lines': ['LEFT', '480-208Y/120V']},
        {'id': 'RACK-L1', 'kind': 'load', 'fedFrom': 'PDU-L1', 'name': 'RACK ROW L1', 'lines': ['IT LOAD, 208V']},
        {'id': 'SWGR-R', 'kind': 'bus', 'fedFrom': 'SWGR-MAIN', 'name': 'SWGR-R', 'lines': ['RIGHT', '480V, 2000A'], 'device': 'CB-R'},
        {'id': 'PDU-R1', 'kind': 'panel', 'fedFrom': 'SWGR-R', 'name': 'PDU-R1', 'lines': ['RIGHT', '480-208Y/120V']},
        {'id': 'RACK-R1', 'kind': 'load', 'fedFrom': 'PDU-R1', 'name': 'RACK ROW R1', 'lines': ['IT LOAD, 208V']},
    ],
}

RIVERSIDE = {
    'site': 'Riverside Industrial Plant - Pump House 1',
    'dwg_no': 'SC-TEST-003',
    'date': 'JULY 2026',
    'revision': '0',
    'sheet_tag': 'ONE-LINE DIAGRAM - REDUNDANT PUMP FEED',
    'notes': [
        'Redundant N+1 pump feed: Left Side and Right Side MCCs each sized for full duty load.',
        'Fabricated data for ServiceCycle extractor regression testing -- not a real facility.',
    ],
    'nodes': [
        {'id': 'UTIL', 'kind': 'utility', 'name': 'UTILITY SERVICE', 'lines': ['12.47kV, 3-PH']},
        {'id': 'MTX', 'kind': 'xfmr', 'fedFrom': 'UTIL', 'name': 'MAIN-XFMR', 'lines': ['1500 kVA', '12.47kV-480V', 'Z=5.75%'], 'device': 'UTIL FUSE', 'devSpec': '150E'},
        {'id': 'SWGR-MAIN', 'kind': 'bus', 'fedFrom': 'MTX', 'name': 'SWGR-MAIN', 'lines': ['480V, 2500A'], 'device': 'MAIN-CB', 'devFunc': '52', 'devSpec': '2500AF/2500AT'},
        {'id': 'MCC-1', 'kind': 'bus', 'fedFrom': 'SWGR-MAIN', 'name': 'MCC-1', 'lines': ['LEFT SIDE', '480V, 800A'], 'device': 'CB-MCC1'},
        {'id': 'VFD-L1', 'kind': 'vfd', 'fedFrom': 'MCC-1', 'name': 'VFD-PUMP-L1', 'lines': ['75 HP']},
        {'id': 'PUMP-L1', 'kind': 'load', 'fedFrom': 'VFD-L1', 'name': 'PUMP-1A', 'lines': ['75 HP MOTOR']},
        {'id': 'MCC-2', 'kind': 'bus', 'fedFrom': 'SWGR-MAIN', 'name': 'MCC-2', 'lines': ['RIGHT SIDE', '480V, 800A'], 'device': 'CB-MCC2'},
        {'id': 'VFD-R1', 'kind': 'vfd', 'fedFrom': 'MCC-2', 'name': 'VFD-PUMP-R1', 'lines': ['75 HP']},
        {'id': 'PUMP-R1', 'kind': 'load', 'fedFrom': 'VFD-R1', 'name': 'PUMP-1B', 'lines': ['75 HP MOTOR']},
    ],
}

if __name__ == '__main__':
    jobs = [
        (NORTHFIELD, '01_northfield_dc_train_ab.pdf'),
        (MERIDIAN, '02_meridian_health_left_right.pdf'),
        (RIVERSIDE, '03_riverside_industrial_leftside.pdf'),
    ]
    for diagram, fname in jobs:
        out = os.path.join(OUT_DIR, fname)
        build_sld(diagram, out, demo=True, generated_stamp='THU 23 JUL 2026, 20:00 UTC')
        print('wrote', out)