#!/usr/bin/env python3
"""oneline_follower.py -- deterministic topology-from-geometry reader for electrical
one-line / single-line (SLD) drawings.

This MERGES the prototype probes (orient + skeleton + link + schematic_topology) into one
module that mirrors the repo's `scripts/vector_topology.py` CLI contract: it prints ONE line
of JSON on stdout and FAILS SOFT on anything it cannot read, so the caller's already-live AI
extraction path is never disturbed. It is a deterministic GROUND-TRUTH reconciliation pass,
not a replacement for the AI extractor.

Pipeline:
  1. find_oneline_page(pdf)  -- pick the sheet that is the one-line among many (title score + bus count)
  2. orient_upright(page)    -- rotate a sideways sheet upright (glyph-matrix vote)
  3. skeleton(page)          -- H/V skeleton with a bus discriminator (>=2 interior drops),
                                curve-segment STITCHING for SKM/ETAP fragmented drops,
                                substation full-width / short-drop main-bus recovery,
                                schedule-table + sheet-border rejection
  4. link(page, buses)       -- name each bus, reconstruct bus->bus feeds + lateral ties
  5. classify + emit         -- ring-bus / breaker-and-a-half detection (label, fail-open)

CLI:  python3 oneline_follower.py <pdf> [--page N] [--debug]
"""
import sys, os, json, re, math, argparse
from collections import defaultdict, Counter

try:
    import pdfplumber
except Exception:
    print(json.dumps({"ok": False, "error": "pdfplumber unavailable"})); sys.exit(0)

# ---------------------------------------------------------------------------
# Density guards: a real CAD sheet can carry hundreds of thousands of primitives.
# Past these caps we fail-open (never hang the ingest -- mirrors vectorTopology's timeout).
MAX_LINES = 90000       # raised from 6000: the ETAP summary sheet (drc p4) has ~69k lines and IS readable
MAX_CURVES = 60000
MAX_WORDS = 12000

_TAGKW = ('SWITCHBOARD', 'SWBD', 'MSB', 'LDB', 'MDP', 'PANEL', 'PNL', 'MCC', 'DIST', 'BOARD',
          'SWGR', 'SWITCHGEAR', 'BUS', 'ATS', 'GEN', 'UPS', 'PDU', 'RPP', 'XFMR', 'XFR',
          'UTIL', 'SERVICE', 'MAIN', 'DP', 'LP', 'HP', 'EM', 'ATS')
VOLT = re.compile(r'(\d[\d.]*\s*k?V)(?!A)')            # (?!A) so "750 kVA" is not read as a voltage
_RATING = re.compile(r'^\(?\d+\)?[/A]?$|^\d+/\d+$|^\d+A$|^#\d|^\d+$|^KVA$|^V$|^\d+KVA$', re.I)

# one-line vs. other-sheet title scoring (for page-finding)
_TITLE_POS = ('ONE-LINE', 'ONE LINE', 'SINGLE-LINE', 'SINGLE LINE', 'SINGLE-LINE DIAGRAM',
              'ONE-LINE DIAGRAM', 'RISER', 'POWER RISER', 'DISTRIBUTION DIAGRAM')
_TITLE_NEG = ('FLOOR PLAN', 'LIGHTING PLAN', 'POWER PLAN', 'SCHEDULE', 'DETAIL', 'DETAILS',
              'SITE PLAN', 'ROOF PLAN', 'SPECIFICATION', 'NOTES', 'LEGEND', 'GROUNDING PLAN',
              'FIRE ALARM', 'MECHANICAL', 'PLUMBING', 'DEMOLITION')
# STRONG negatives: a sheet whose title says PLAN/SCHEDULE/DETAIL is a plan/schedule sheet whose
# orthogonal geometry (walls, grids, table rules) false-positives as buses. Hard-gate it unless a
# strong positive (ONE-LINE/SINGLE-LINE/RISER) is ALSO present.
_TITLE_NEG_STRONG = ('SYSTEMS PLAN', 'POWER PLAN', 'FLOOR PLAN', 'SITE PLAN', 'ROOF PLAN',
                     'LIGHTING PLAN', 'GROUNDING PLAN', 'PANEL SCHEDULE', 'PLAN -', 'PLAN-')


def _is_rating(t):
    return bool(_RATING.match(t)) or t in {'A', '/', '(E)', '(N)', '(X)', '3PH', '4W', '3P4W'}


# ---------------------------------------------------------------------------
# GEOMETRY EXTRACTION
def _curve_vruns(pts):
    """Stitch a curve's point list into maximal near-vertical polyline runs.

    SKM/ETAP export drops as many tiny collinear curve segments; treating each pair
    independently (old code) drops them under the length threshold and the drop vanishes.
    Here we accumulate a monotonic near-constant-x walk into ONE (x, top, bottom) run.
    Same for horizontals. pdfplumber curve pts are ALREADY top-down (do NOT flip)."""
    vruns, hruns = [], []
    if len(pts) < 2:
        return vruns, hruns
    # vertical accumulation
    cx = pts[0][0]; ytop = ybot = pts[0][1]
    for (x, y) in pts[1:]:
        if abs(x - cx) < 1.4:                       # still vertical-ish, same column
            ytop = min(ytop, y); ybot = max(ybot, y); cx = (cx + x) / 2
        else:
            if ybot - ytop > 3:
                vruns.append((cx, ytop, ybot))
            cx = x; ytop = ybot = y
    if ybot - ytop > 3:
        vruns.append((cx, ytop, ybot))
    # horizontal accumulation
    cy = pts[0][1]; xl = xr = pts[0][0]
    for (x, y) in pts[1:]:
        if abs(y - cy) < 1.4:
            xl = min(xl, x); xr = max(xr, x); cy = (cy + y) / 2
        else:
            if xr - xl > 3:
                hruns.append((cy, xl, xr))
            cy = y; xl = xr = x
    if xr - xl > 3:
        hruns.append((cy, xl, xr))
    return vruns, hruns


def segments(pg):
    """Return (H, V): H=[(y,x0,x1)], V=[(x,top,bottom)] from lines + thin rects + curves."""
    H, V = [], []
    for l in pg.lines:
        if abs(l['y0'] - l['y1']) < 1.0:
            H.append((l['top'], l['x0'], l['x1']))
        elif abs(l['x0'] - l['x1']) < 1.0:
            V.append((l['x0'], l['top'], l['bottom']))
    for r in pg.rects:                      # thin filled rects = bars/conductors in some CAD
        w, h = r['x1'] - r['x0'], r['bottom'] - r['top']
        if h < 3 and w > 20:
            H.append(((r['top'] + r['bottom']) / 2, r['x0'], r['x1']))
        elif w < 3 and h > 20:
            V.append(((r['x0'] + r['x1']) / 2, r['top'], r['bottom']))
    for c in pg.curves:                     # polyline paths (SKM/NRC/ETAP draw drops+buses this way)
        pts = c.get('pts') or []
        vr, hr = _curve_vruns(pts)
        V.extend(vr); H.extend(hr)
    return H, V


def merge(vals, gap):
    """Collapse near-collinear runs sharing a rounded position, bridging gaps <= gap."""
    g = defaultdict(list)
    for pos, a, b in vals:
        g[round(pos)].append((min(a, b), max(a, b)))
    out = []
    for pos, ivs in g.items():
        ivs.sort(); cur = None
        for a, b in ivs:
            if cur and a <= cur[1] + gap:
                cur = (cur[0], max(cur[1], b))
            else:
                if cur:
                    out.append((pos, cur[0], cur[1]))
                cur = (a, b)
        if cur:
            out.append((pos, cur[0], cur[1]))
    return out


def _merge_x(vruns, xtol=3, gap=26):
    """Merge vertical runs whose x are within xtol (handles doubled/parallel stroke), then bridge."""
    g = defaultdict(list)
    for x, t, b in vruns:
        g[round(x / xtol) * xtol].append((t, b))
    out = []
    for xk, ivs in g.items():
        ivs.sort(); cur = None
        for t, b in ivs:
            if cur and t <= cur[1] + gap:
                cur = (cur[0], max(cur[1], b))
            else:
                if cur:
                    out.append((xk, cur[0], cur[1]))
                cur = (t, b)
        if cur:
            out.append((xk, cur[0], cur[1]))
    return out


# ---------------------------------------------------------------------------
# SKELETON + BUS DISCRIMINATOR
def skeleton(pg, min_bus=70, min_drop=10, drop_reach=14):
    """Return (buses, Hr, Vr). A horizontal run is a BUS iff >=2 vertical runs terminate on
    it from an INTERIOR point (hang down OR rise up). Rejects sheet frame, right-margin title
    strips, and schedule-table grids. Recovers substation main buses (short drops, full width)
    via the compensating interior-drop count."""
    H, V = segments(pg)
    Hr = merge(H, 4)
    Vr = _merge_x(V, xtol=3, gap=26)                    # bridge breaker/symbol gaps in drops
    Vr = [v for v in Vr if v[2] - v[1] >= min_drop]
    pw, ph = pg.width, pg.height

    def in_table(y, x0, x1):
        cnt = 0
        for (yy, a, b) in Hr:
            if yy != y and abs(yy - y) < 75 and (min(b, x1) - max(a, x0)) > 0.4 * (x1 - x0):
                cnt += 1
        return cnt >= 3

    buses = []
    for (y, x0, x1) in Hr:
        L = x1 - x0
        if L < min_bus:
            continue
        if y < 0.02 * ph or y > 0.98 * ph:              # sheet top/bottom frame rule
            continue
        if L > 0.95 * pw:                               # full-width frame rule
            continue
        if x0 > 0.86 * pw:                              # right-margin title-block / revision strip
            continue
        drops = [v for v in Vr                          # verticals terminating on the bus (either side)
                 if x0 + 6 < v[0] < x1 - 6 and (
                     (abs(v[1] - y) < 6 and v[2] > y + drop_reach) or     # hangs down
                     (abs(v[2] - y) < 6 and v[1] < y - drop_reach))]      # rises up
        nd = len(drops)
        if nd < 2 or in_table(y, x0, x1):
            continue
        # a long line (0.80-0.95 pw) is only a bus if it carries several interior drops
        if L > 0.80 * pw and nd < 3:
            continue
        if L > 1200 and nd < 4:                         # long rail w/ few taps = feeder/border
            continue
        buses.append((y, x0, x1, drops))
    # dedupe near-identical buses (a bar drawn as line AND curve appears twice ~2px apart)
    buses.sort(key=lambda b: -(b[2] - b[1]))
    deduped = []
    for (y, x0, x1, drops) in buses:
        dup = None
        for k, db in enumerate(deduped):
            if abs(db[0] - y) < 6 and (min(db[2], x1) - max(db[1], x0)) > 0.6 * min(x1 - x0, db[2] - db[1]):
                dup = k; break
        if dup is None:
            deduped.append((y, x0, x1, drops))
        elif len(drops) > len(deduped[dup][3]):
            deduped[dup] = (y, x0, x1, drops)
    return deduped, Hr, Vr


# ---------------------------------------------------------------------------
# LINKING: name buses + reconstruct feeds + ties
def link(pg, buses, Hr, Vr):
    words = pg.extract_words(extra_attrs=['fontname', 'size'])
    # median annotation font size -> penalize rows dominated by large TITLE text when naming a bus
    _sizes = sorted(w.get('size') or 0 for w in words if (w.get('size') or 0) > 0)
    _med = _sizes[len(_sizes) // 2] if _sizes else 8.0

    def name_bus(y, x0, x1):
        span = x1 - x0
        band = [w for w in words if (y - 95) < w['top'] < (y + 55) and (x0 - 15) < w['x0'] < x0 + 0.9 * span]
        if not band:
            return None
        band.sort(key=lambda w: (round(w['top']), w['x0']))
        rows, cur = [], []
        for w in band:
            if cur and abs(w['top'] - cur[-1]['top']) < 6:
                cur.append(w)
            else:
                if cur:
                    rows.append(cur)
                cur = [w]
        if cur:
            rows.append(cur)

        def score(row):
            toks = [w['text'] for w in row]
            alpha = sum(len(t) for t in toks if any(c.isalpha() for c in t) and not _is_rating(t))
            rat = sum(1 for t in toks if _is_rating(t))
            joined = ' '.join(toks).upper()
            kw = sum(k in joined for k in _TAGKW)
            prox = 1.0 / (1 + abs(min(w['top'] for w in row) - y) / 20)
            # title penalty: rows in large (title) font are drawing titles, not bus tags
            rowsz = max((w.get('size') or 0) for w in row)
            title_pen = 8 if rowsz > 1.6 * _med else 0
            return kw * 15 + alpha - rat * 2 + prox * 3 - title_pen

        best = max(rows, key=score)
        return ' '.join(w['text'] for w in sorted(best, key=lambda w: w['x0']))[:70]

    named = []
    for (y, x0, x1, drops) in buses:
        nm = name_bus(y, x0, x1)
        vm = None
        if nm:
            vm = VOLT.search(nm)
        named.append({'y': y, 'x0': x0, 'x1': x1, 'n': len(drops),
                      'name': nm, 'volt': (vm.group(1).replace(' ', '') if vm else None)})

    def bus_at(x, yy, tol=65):
        for b in named:
            if b['x0'] - tol < x < b['x1'] + tol and abs(b['y'] - yy) < 7:
                return b
        return None

    # through-runs: chain collinear verticals across gaps <=70px (feeder through a xfmr/symbol)
    byx = defaultdict(list)
    for (x, t, b) in Vr:
        byx[round(x / 3) * 3].append((t, b))
    throughs = []
    for xk, segs in byx.items():
        segs.sort(); cur = None
        for t, b in segs:
            if cur and t - cur[1] <= 70:
                cur = (cur[0], max(cur[1], b))
            else:
                if cur:
                    throughs.append((xk, cur[0], cur[1]))
                cur = (t, b)
        if cur:
            throughs.append((xk, cur[0], cur[1]))
    # split each through-run at any bus it crosses (can't bridge OVER an intermediate bus)
    split = []
    for (x, t, b) in throughs:
        cuts = sorted(bb['y'] for bb in named if t + 5 < bb['y'] < b - 5 and bb['x0'] - 8 < x < bb['x1'] + 8)
        pts = [t] + cuts + [b]
        for i in range(len(pts) - 1):
            split.append((x, pts[i], pts[i + 1]))
    throughs = split

    links = []
    for (x, t, b) in throughs:
        a, c = bus_at(x, t, 65), bus_at(x, b, 65)
        if a and c and a is not c:
            links.append((a, c))
    seen = set(); uniq = []
    for a, c in links:
        k = tuple(sorted([id(a), id(c)]))
        if k not in seen:
            seen.add(k); uniq.append((a, c))

    # lateral TIES: two buses at ~same y, small gap, bridged by a connector (main-tie-main etc.)
    def connector_in_gap(a, b):
        y = (a['y'] + b['y']) / 2
        gx0, gx1 = a['x1'], b['x0']
        for (hy, hx0, hx1) in Hr:
            if abs(hy - y) < 14 and hx0 < gx1 + 6 and hx1 > gx0 - 6:
                return True
        for (vx, vt, vb) in Vr:
            if gx0 - 6 < vx < gx1 + 6 and vt < y + 35 and vb > y - 35:
                return True
        return False

    ties = []
    bl = sorted(named, key=lambda b: b['x0'])
    for i in range(len(bl)):
        for j in range(i + 1, len(bl)):
            a, b = bl[i], bl[j]
            if abs(a['y'] - b['y']) < 10:
                gap = b['x0'] - a['x1']
                if 4 < gap < 95 and connector_in_gap(a, b):
                    ties.append((a, b))
    return named, uniq, ties


# ---------------------------------------------------------------------------
# PAGE-FINDING
def _title_score(pg):
    """Score a page's chance of being the one-line from its text (title keywords)."""
    try:
        txt = (pg.extract_text() or '').upper()
    except Exception:
        txt = ''
    s = 0
    strong_pos = any(kw in txt for kw in _TITLE_POS)
    for kw in _TITLE_POS:
        if kw in txt:
            s += 6
    for kw in _TITLE_NEG:
        if kw in txt:
            s -= 4
    # STRONG plan/schedule gate: a plan sheet's walls/grids false-positive as buses; demote hard
    # unless the sheet ALSO carries a real one-line title.
    if not strong_pos:
        for kw in _TITLE_NEG_STRONG:
            if kw in txt:
                s -= 60
                break
    # equipment tag density is a weak positive signal
    tags = sum(txt.count(k) for k in ('SWITCHBOARD', 'SWITCHGEAR', 'PANEL', 'MCC', 'XFMR', 'UPS', 'ATS'))
    s += min(tags, 8) * 0.5
    return s


def find_oneline_page(pdf, max_pages=40):
    """Return (best_page_index, per_page_debug). Combines title score with a cheap skeleton
    bus-count probe. A single-page PDF short-circuits to page 0."""
    n = len(pdf.pages)
    if n == 1:
        return 0, [{'page': 0, 'reason': 'single-page'}]
    dbg = []
    best_i, best_score = 0, -1e9
    for i in range(min(n, max_pages)):
        pg = pdf.pages[i]
        # density pre-filter -- skip the skeleton probe on hopeless sheets but keep title score
        nlines, ncurves = len(pg.lines), len(pg.curves)
        ts = _title_score(pg)
        nb = 0
        if nlines <= MAX_LINES and ncurves <= MAX_CURVES and (nlines + ncurves) > 20:
            try:
                buses, _, _ = skeleton(pg)
                nb = len(buses)
            except Exception:
                nb = 0
        # combined score: buses dominate, title breaks ties / rescues dense readable sheets
        score = nb * 10 + ts
        dbg.append({'page': i, 'lines': nlines, 'curves': ncurves, 'titleScore': round(ts, 1), 'buses': nb, 'score': round(score, 1)})
        if score > best_score:
            best_score, best_i = score, i
    return best_i, dbg


# ---------------------------------------------------------------------------
# ORIENT (upright)
def _upright_score(pg):
    s = 0
    for ch in pg.chars[:5000]:
        m = ch.get('matrix')
        if not m:
            continue
        ang = int(round(math.degrees(math.atan2(m[1], m[0])) / 90.0)) * 90 % 360
        if ang == 0:
            s += len(ch.get('text', '') or ' ')
    return s


def dominant_angle(pg):
    c = Counter()
    for ch in pg.chars[:5000]:
        m = ch.get('matrix')
        if not m:
            continue
        ang = int(round(math.degrees(math.atan2(m[1], m[0])) / 90.0)) * 90 % 360
        c[ang] += len(ch.get('text', '') or ' ')
    return (c.most_common(1)[0][0] if c else 0)


def orient_upright(in_path, page, out_path):
    """Write an upright single-page PDF to out_path; return applied rotation degrees."""
    import pypdf
    from pypdf.generic import NameObject, NumberObject
    base = pypdf.PdfReader(in_path).pages[page].rotation or 0
    best_k, best_score = 0, -1
    for k in (0, 1, 2, 3):
        w = pypdf.PdfWriter()
        w.add_page(pypdf.PdfReader(in_path).pages[page])
        w.pages[0][NameObject('/Rotate')] = NumberObject((base + 90 * k) % 360)
        tmp = f'{out_path}.try{k}.pdf'
        with open(tmp, 'wb') as f:
            w.write(f)
        try:
            score = _upright_score(pdfplumber.open(tmp).pages[0])
        except Exception:
            score = -1
        if score > best_score:
            best_score, best_k = score, k
    w = pypdf.PdfWriter()
    w.add_page(pypdf.PdfReader(in_path).pages[page])
    w.pages[0][NameObject('/Rotate')] = NumberObject((base + 90 * best_k) % 360)
    with open(out_path, 'wb') as f:
        w.write(f)
    return (90 * best_k) % 360


# ---------------------------------------------------------------------------
# CLASSIFY: ring bus / breaker-and-a-half (detect + label, do NOT force a tree)
def classify_notes(named, links, ties):
    notes = []
    if len(ties) >= 2 and len(named) >= 3:
        # several peer buses at the same level with tie connectors: double-ended / secondary-selective
        notes.append('multi-section-bus')
    # ring bus / breaker-and-a-half: >=3 buses at ~same y forming a chain of ties
    ys = [b['y'] for b in named]
    if ys:
        row = Counter(round(y / 25) for y in ys)
        if row and row.most_common(1)[0][1] >= 3 and len(ties) >= 2:
            notes.append('possible-ring-or-breaker-and-half')
    return notes


# ---------------------------------------------------------------------------
def analyze(path, page_index=None, debug=False):
    """Full pipeline. Returns the contract dict. Fails soft."""
    out = {"ok": True, "isSchematic": False, "buses": [], "feeds": [], "ties": [], "notes": []}
    try:
        pdf = pdfplumber.open(path)
    except Exception as e:
        return {"ok": False, "error": f"open: {str(e)[:150]}"}
    try:
        # 1. page-finding (unless caller pinned a page)
        if page_index is None:
            page_index, page_dbg = find_oneline_page(pdf)
        else:
            page_dbg = [{'page': page_index, 'reason': 'pinned'}]
        out['page'] = page_index
        if debug:
            out['pageScan'] = page_dbg

        pg = pdf.pages[page_index]
        # 2. density guard
        if len(pg.lines) > MAX_LINES or len(pg.curves) > MAX_CURVES:
            out['reason'] = 'too_dense'
            return out
        try:
            nwords = len(pg.extract_words())
        except Exception:
            nwords = 0
        if nwords > MAX_WORDS:
            out['reason'] = 'too_dense'
            return out

        # 3. orient upright if the sheet is rotated
        applied = 0
        if dominant_angle(pg) != 0:
            up = f'/tmp/_upright_{os.getpid()}.pdf'
            try:
                applied = orient_upright(path, page_index, up)
                if applied:
                    pg = pdfplumber.open(up).pages[0]
            except Exception:
                applied = 0
        out['appliedRotation'] = applied

        # 4. skeleton + link
        buses, Hr, Vr = skeleton(pg)
        if len(buses) < 1:
            out['reason'] = 'no_buses'
            return out
        named, links, ties = link(pg, buses, Hr, Vr)

        # 5. build the feed tree (fedFromBusName from bus->bus feeds, higher bus = parent)
        idx = {id(b): i for i, b in enumerate(named)}
        parent = {}
        for a, c in links:
            hi, lo = (a, c) if a['y'] < c['y'] else (c, a)
            parent[idx[id(lo)]] = idx[id(hi)]

        def level(i, seen=None):
            seen = seen or set()
            p = parent.get(i)
            return 0 if (p is None or p in seen) else 1 + level(p, seen | {i})

        buses_out = []
        for i, b in enumerate(named):
            p = parent.get(i)
            v = b['volt']
            eq = 'SWITCHGEAR' if (v and 'kV' in v) else 'SWITCHBOARD'
            buses_out.append({
                'busName': b['name'] or f'BUS@{round(b["y"])}',
                'equipmentTypeGuess': eq,
                'fedFromBusName': (named[p]['name'] if p is not None else None),
                'nominalVoltage': v,
                'level': level(i),
                'drops': b['n'],
            })
        out['isSchematic'] = True
        out['buses'] = buses_out
        out['feeds'] = [{'from': (a if a['y'] < c['y'] else c)['name'],
                         'to': (c if a['y'] < c['y'] else a)['name']} for a, c in links]
        out['ties'] = [{'a': a['name'], 'b': c['name']} for a, c in ties]
        notes = classify_notes(named, links, ties)
        # confidence: on a real one-line most buses carry a tag-keyword or voltage in their name.
        # Floor/power-plan sheets that slip past the title gate produce unnamed grid "buses" -> flag.
        def _named_like_bus(bo):
            nm = (bo['busName'] or '').upper()
            return bool(bo['nominalVoltage']) or any(k in nm for k in _TAGKW)
        good = sum(1 for bo in buses_out if _named_like_bus(bo))
        conf = good / max(1, len(buses_out))
        out['nameConfidence'] = round(conf, 2)
        if len(buses_out) >= 4 and conf < 0.25:
            notes.append('low-confidence-maybe-not-oneline')
        out['notes'] = notes
        return out
    except Exception as e:
        return {"ok": False, "error": f"analyze: {str(e)[:150]}"}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--page', type=int, default=None)
    ap.add_argument('--debug', action='store_true')
    a = ap.parse_args()
    try:
        print(json.dumps(analyze(a.pdf, a.page, a.debug)))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:200]}))
