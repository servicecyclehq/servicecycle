"""
run_eval.py -- end-to-end accuracy harness. Runs the REAL extractor (../run.py)
over a synthetic corpus and reports accuracy per difficulty tier.

Usage:  python run_eval.py <corpus_dir>
"""
import collections, json, os, subprocess, sys
from score import score_one

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.join(HERE, "..", "run.py")


def run_extractor(pdf):
    try:
        out = subprocess.run([sys.executable, RUN, pdf], capture_output=True, text=True, timeout=180)
        lines = [l for l in (out.stdout or "").splitlines() if l.strip()]
        d = json.loads(lines[-1]) if lines else {}
        return d if d.get("ok") else {"fields": {}, "measurements": []}
    except Exception:
        return {"fields": {}, "measurements": []}


def main(corpus):
    manifest = json.load(open(os.path.join(corpus, "manifest.json"), encoding="utf-8"))
    agg = collections.defaultdict(collections.Counter)
    n = collections.Counter()
    for e in manifest:
        gt = json.load(open(e["gt"], encoding="utf-8"))
        s = score_one(gt, run_extractor(e["pdf"]))
        t = e["tier"]; n[t] += 1
        for k in ("field_total", "field_ok", "meas_total", "located", "phase_ok", "unit_ok", "pf_ok"):
            agg[t][k] += s[k]
    print("")
    print("tier    docs  field_acc  reading_found  phase_acc  unit_acc  passfail")
    print("-" * 70)
    for t in ("clean", "scan", "photo"):
        a = agg[t]
        if not n[t]:
            continue
        ft = a["field_total"] or 1
        mt = a["meas_total"] or 1
        lo = a["located"] or 1
        print("%-6s  %4d  %7.1f%%  %11.1f%%  %7.1f%%  %6.1f%%  %6.1f%%" % (
            t, n[t], 100 * a["field_ok"] / ft, 100 * a["located"] / mt,
            100 * a["phase_ok"] / lo, 100 * a["unit_ok"] / lo, 100 * a["pf_ok"] / lo))
    print("")
    print("reading_found = GT readings located by type+value; phase/unit/passfail")
    print("accuracies are computed over the located readings.")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "synthcorpus")