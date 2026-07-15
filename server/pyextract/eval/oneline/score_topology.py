"""score_topology.py -- pure scoring of an extracted one-line topology vs hand-verified
ground truth. Node recall/precision + connectivity accuracy (correct fedFrom) + equipment-
type accuracy. Matching is by normalized bus name so a missed bus doesn't zero everything."""

def _norm(s):
    return '' if s is None else str(s).strip().lower()

def score_one(gt_buses, ext_buses):
    gt = {_norm(b['busName']): b for b in (gt_buses or [])}
    ex = {_norm(b['busName']): b for b in (ext_buses or [])}
    gt_names, ex_names = set(gt), set(ex)
    matched = gt_names & ex_names
    conn_ok = conn_total = type_ok = type_total = 0
    conn_errors, type_errors = [], []
    for k in matched:
        g, e = gt[k], ex[k]
        conn_total += 1
        e_fed = e.get('fedFromBusName')
        if _norm(g.get('fedFromBusName')) == _norm(e_fed):
            conn_ok += 1
        else:
            conn_errors.append({'busName': g['busName'], 'expected': g.get('fedFromBusName'), 'got': e_fed})
        if g.get('equipmentType'):
            type_total += 1
            e_type = e.get('equipmentTypeGuess') if e.get('equipmentTypeGuess') is not None else e.get('equipmentType')
            if _norm(g.get('equipmentType')) == _norm(e_type):
                type_ok += 1
            else:
                type_errors.append({'busName': g['busName'], 'expected': g.get('equipmentType'), 'got': e_type})
    return {
        'nodes_gt': len(gt_names), 'nodes_ext': len(ex_names), 'matched': len(matched),
        'node_recall': (len(matched) / len(gt_names)) if gt_names else 0.0,
        'node_precision': (len(matched) / len(ex_names)) if ex_names else 0.0,
        'conn_total': conn_total, 'conn_ok': conn_ok, 'conn_acc': (conn_ok / conn_total) if conn_total else 0.0,
        'type_total': type_total, 'type_ok': type_ok, 'type_acc': (type_ok / type_total) if type_total else 0.0,
        'missed_nodes': [gt[k]['busName'] for k in sorted(gt_names - ex_names)],
        'extra_nodes': [ex[k]['busName'] for k in sorted(ex_names - gt_names)],
        'conn_errors': conn_errors, 'type_errors': type_errors,
    }