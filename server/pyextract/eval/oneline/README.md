# One-line topology eval harness

Repeatable, AI-free accuracy measurement for one-line -> topology extraction. It runs the
deterministic vector reader (`server/scripts/vector_topology.py`) over a golden set of
one-lines with hand-verified ground truth and reports connectivity + equipment-type accuracy.
This is the "can''t safely improve what you can''t measure" backstop for a life-safety tool.

## Run
```
cd server/pyextract/eval/oneline
python run_oneline_eval.py                # PDFs resolved relative to the repo root
python run_oneline_eval.py "C:\some\pdf\base"   # or pass a base dir
python test_score_topology.py             # unit-test the scorer
```
On Windows dev, if the runner can''t find the extractor''s Python deps, set
`PYEXTRACT_PYTHON=python`.

## Add a golden case
Drop a JSON in `golden/`:
```json
{
  "name": "My_One_Line",
  "pdf": "One Lines DC Chat/My_One_Line.pdf",
  "note": "where it came from / how ground truth was verified",
  "buses": [
    {"busName": "MAIN", "equipmentType": "SWITCHGEAR", "fedFromBusName": null},
    {"busName": "XFMR-1", "equipmentType": "TRANSFORMER_LIQUID", "fedFromBusName": "MAIN"}
  ]
}
```
`pdf` is relative to the base dir. `equipmentType` uses the ServiceCycle enum. Ground truth
must be verified against the drawing by a person, not copied from the tool''s own output.

## Metrics
- **connectivity %** = matched buses whose fedFrom equals ground truth (the key metric).
- **type %** = matched buses whose equipment type equals ground truth.
- plus node recall/precision and lists of missed/extra buses and every connectivity error.

## Scope
Today the extractor + these golden cases cover the vector "card tree" one-line format. As the
symbol+line and raster extractors land, add golden cases for those formats here so every
extraction change is measured across all of them before it ships.