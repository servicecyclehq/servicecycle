#!/usr/bin/env python3
"""Deterministic vector-topology reader for "card tree" one-line PDFs.

Reads the PDF's vector text layer (NO AI): identifies equipment cards by their
type-header line (e.g. "SWITCHGEAR - 15KV"), takes the equipment name from the
line directly below, and reconstructs the feed tree from the drawn indent level
(parent = the nearest preceding card at a shallower indent). Emits one line of
JSON on stdout. FAILS SOFT: any error or a non-card-tree PDF returns
{"ok":true,"isCardTree":false,"buses":[]} so the caller's AI path is untouched.

Invoked exactly like scripts/pdf_text.py: `python3 vector_topology.py <pdf>`.
"""
import sys, json, re
try:
    import pdfplumber
except Exception:
    print(json.dumps({"ok": False, "error": "pdfplumber unavailable"})); sys.exit(0)

# Header type token -> ServiceCycle EquipmentType enum.
TYPE_MAP = {
 'SWITCHGEAR': 'SWITCHGEAR', 'SWITCHBOARD': 'SWITCHBOARD', 'BREAKER': 'CIRCUIT_BREAKER',
 'TRANSFORMER': 'TRANSFORMER_LIQUID', 'MCC': 'MCC', 'MOTOR': 'MOTOR', 'PANELBOARD': 'PANELBOARD',
 'DISCONNECT': 'DISCONNECT_SWITCH', 'GENERATOR': 'GENERATOR', 'ATS': 'TRANSFER_SWITCH',
 'STS': 'STATIC_TRANSFER_SWITCH', 'UPS': 'UPS_BATTERY', 'BUSWAY': 'BUSWAY',
 'RPP': 'REMOTE_POWER_PANEL', 'PDU': 'POWER_DISTRIBUTION_UNIT', 'UTILITY': 'UTILITY_SERVICE',
}

def group_lines(words, ytol=3.0):
    words = sorted(words, key=lambda w: (round(w['top'], 1), w['x0']))
    lines = []; cur = []; cy = None
    for w in words:
        if cy is None or abs(w['top'] - cy) <= ytol:
            cur.append(w); cy = w['top'] if cy is None else cy
        else:
            lines.append(cur); cur = [w]; cy = w['top']
    if cur:
        lines.append(cur)
    return lines

def extract(path):
    cards = []
    with pdfplumber.open(path) as pdf:
        for pi, pg in enumerate(pdf.pages):
            lines = group_lines(pg.extract_words(use_text_flow=False))
            for ln in lines:
                s = sorted(ln, key=lambda w: w['x0'])
                first = s[0]['text'].upper().strip('.:')
                typ = TYPE_MAP.get(first)
                if typ is None or len(s) > 6:
                    continue
                htop = s[0]['top']; hx0 = s[0]['x0']
                htext = ' '.join(w['text'] for w in s)
                name = None
                for ln2 in lines:
                    w2 = min(ln2, key=lambda w: w['x0'])
                    if 2 < (w2['top'] - htop) < 22 and abs(w2['x0'] - hx0) < 10:
                        name = ' '.join(w['text'] for w in sorted(ln2, key=lambda w: w['x0'])); break
                if not name:
                    continue
                vm = re.search(r'([\d.]+\s*[kK]?V(?:\s*-?>?\s*[\d.]+\s*V)?)', htext)
                cards.append({'page': pi + 1, 'top': round(htop, 1), 'x0': round(hx0, 1),
                              'name': name, 'type': typ,
                              'volt': (vm.group(1).replace(' ', '') if vm else None)})
    cards.sort(key=lambda c: (c['page'], c['top']))
    xs = sorted(set(c['x0'] for c in cards))
    if len(cards) < 3 or len(xs) < 2:
        return {'ok': True, 'isCardTree': False, 'buses': []}
    step = min(round(xs[i + 1] - xs[i], 1) for i in range(len(xs) - 1))
    if step < 5:
        return {'ok': True, 'isCardTree': False, 'buses': []}
    base = xs[0]
    for c in cards:
        c['lvl'] = round((c['x0'] - base) / step)
    for i, c in enumerate(cards):
        c['parent'] = next((cards[j]['name'] for j in range(i - 1, -1, -1)
                            if cards[j]['lvl'] < c['lvl']), None)
    buses = [{'busName': c['name'], 'equipmentTypeGuess': c['type'], 'fedFromBusName': c['parent'],
              'nominalVoltage': c['volt'], 'level': c['lvl']} for c in cards]
    return {'ok': True, 'isCardTree': True, 'buses': buses}

if __name__ == '__main__':
    try:
        print(json.dumps(extract(sys.argv[1])))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)[:200]}))