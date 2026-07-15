"""run_oneline_eval.py -- run the deterministic vector extractor over every golden case
and score it. Repeatable, no AI, no cost. Run: `python run_oneline_eval.py [pdf_base_dir]`.
Add a case by dropping a ground-truth JSON in golden/ (see README)."""
import sys, os, json, subprocess, glob
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from score_topology import score_one  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
VEC = os.path.join(REPO, 'server', 'scripts', 'vector_topology.py')
PY = os.environ.get('PYEXTRACT_PYTHON', sys.executable)

def run_vector(pdf_path):
    out = subprocess.run([PY, VEC, pdf_path], capture_output=True, text=True, timeout=60)
    lines = [l for l in (out.stdout or '').strip().splitlines() if l.strip()]
    if not lines:
        return []
    d = json.loads(lines[-1])
    return d.get('buses', []) if d.get('isCardTree') else []

def main():
    base = sys.argv[1] if len(sys.argv) > 1 else REPO
    cases = sorted(glob.glob(os.path.join(HERE, 'golden', '*.json')))
    if not cases:
        print('no golden cases in', os.path.join(HERE, 'golden')); return
    print(f"{'case':<30} {'nodes gt/ext':<13} {'conn%':>6} {'type%':>6}  notes")
    agg = {'conn_ok': 0, 'conn_total': 0, 'type_ok': 0, 'type_total': 0}
    for cp in cases:
        gt = json.load(open(cp, encoding='utf-8'))
        pdf = os.path.join(base, gt['pdf'])
        if not os.path.exists(pdf):
            print(f"{gt['name']:<30} MISSING PDF -> {pdf}"); continue
        ext = run_vector(pdf)
        s = score_one(gt['buses'], ext)
        for k in agg:
            agg[k] += s[k]
        note = f"{len(s['conn_errors'])} conn err, {len(s['missed_nodes'])} missed, {len(s['extra_nodes'])} extra"
        print(f"{gt['name']:<30} {str(s['nodes_gt'])+'/'+str(s['nodes_ext']):<13} {s['conn_acc']*100:6.1f} {s['type_acc']*100:6.1f}  {note}")
        for e in s['conn_errors']:
            print(f"    conn: {e['busName']}  expected={e['expected']}  got={e['got']}")
        for e in s['type_errors']:
            print(f"    type: {e['busName']}  expected={e['expected']}  got={e['got']}")
    if agg['conn_total']:
        print(f"\nTOTAL  connectivity {agg['conn_ok']}/{agg['conn_total']} = {agg['conn_ok']/agg['conn_total']*100:.1f}%"
              f"   |   type {agg['type_ok']}/{agg['type_total']} = {agg['type_ok']/agg['type_total']*100:.1f}%")

if __name__ == '__main__':
    main()