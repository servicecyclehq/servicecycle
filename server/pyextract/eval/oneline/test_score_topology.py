"""Plain-script tests for score_topology (no pytest dep): `python test_score_topology.py`."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score_topology import score_one

def test_perfect():
    gt = [{'busName':'A','equipmentType':'MCC','fedFromBusName':None},
          {'busName':'B','equipmentType':'MOTOR','fedFromBusName':'A'}]
    ext = [{'busName':'A','equipmentTypeGuess':'MCC','fedFromBusName':None},
           {'busName':'B','equipmentTypeGuess':'MOTOR','fedFromBusName':'A'}]
    s = score_one(gt, ext)
    assert s['conn_acc'] == 1.0 and s['type_acc'] == 1.0 and s['node_recall'] == 1.0

def test_wrong_parent_and_missing():
    gt = [{'busName':'A','equipmentType':'MCC','fedFromBusName':None},
          {'busName':'B','equipmentType':'MOTOR','fedFromBusName':'A'},
          {'busName':'C','equipmentType':'PANELBOARD','fedFromBusName':'A'}]
    ext = [{'busName':'A','equipmentTypeGuess':'MCC','fedFromBusName':None},
           {'busName':'B','equipmentTypeGuess':'MOTOR','fedFromBusName':'WRONG'}]
    s = score_one(gt, ext)
    assert s['conn_ok'] == 1 and s['conn_total'] == 2 and s['conn_acc'] == 0.5
    assert len(s['conn_errors']) == 1 and s['missed_nodes'] == ['C']

if __name__ == '__main__':
    test_perfect(); test_wrong_parent_and_missing(); print('score_topology tests OK')