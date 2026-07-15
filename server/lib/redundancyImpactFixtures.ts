/**
 * lib/redundancyImpactFixtures.ts -- the synthetic 2N data-center topology from the spec
 * (3g), as an in-code object literal so the redundancyImpact unit tests run with NO DB.
 *
 * SOURCES:   UTIL-A/B 13.8kV | GEN-A/B 2.5MW standby
 * MV:        MV-SWGR-A/B (UTIL normal, ATS-MV -> GEN emergency)
 * XFMR:      XFMR-A/B 2500kVA 13.8kV->480V
 * LV:        LV-SWGR-A/B 480V
 * UPS:       UPS-A/B 750kW N+1 5-min batt -> CRIT-BUS-A/B
 * FINAL:     RPP/BUSWAY-A/B -> PDU-A/B
 * LOADS:     RACK-01..12 dual-corded (A from PDU-A, B from PDU-B) = 2N at rack
 *            CRAH-1..4 mechanical N+1, fed from LV-SWGR-A & LV-SWGR-B (no UPS)
 */
import type { RINode, RIEdge } from './redundancyImpact';

function buildDatacenter2N(): { nodes: RINode[]; edges: RIEdge[] } {
  const nodes: RINode[] = [];
  const edges: RIEdge[] = [];
  const node = (id: string, extra: Partial<RINode> = {}) => {
    nodes.push({ id, label: id, ...extra });
  };
  const edge = (
    id: string,
    loadAssetId: string,
    sourceAssetId: string,
    role: RIEdge['role'],
    side: RIEdge['side'],
    sourceKind: RIEdge['sourceKind'],
    transferAssetId: string | null = null,
  ) => {
    edges.push({ id, loadAssetId, sourceAssetId, role, side, sourceKind, transferAssetId });
  };

  // --- one distribution train (A or B) ---
  const buildTrain = (s: 'A' | 'B') => {
    node(`UTIL-${s}`, { sourceKind: 'utility' });
    node(`GEN-${s}`, { sourceKind: 'generator' });
    node(`ATS-MV-${s}`); // transfer node (pass-through selector)
    node(`MV-SWGR-${s}`);
    node(`XFMR-${s}`);
    node(`LV-SWGR-${s}`);
    node(`UPS-${s}`, { sourceKind: 'ups' }); // ride-through source
    node(`CRIT-BUS-${s}`);
    node(`RPP-${s}`);
    node(`PDU-${s}`);
    // MV switchgear selects UTIL (normal) / GEN (emergency) via the ATS
    edge(`e-MV-${s}-util`, `MV-SWGR-${s}`, `UTIL-${s}`, 'normal', s, 'utility', `ATS-MV-${s}`);
    edge(`e-MV-${s}-gen`, `MV-SWGR-${s}`, `GEN-${s}`, 'emergency', s, 'generator', `ATS-MV-${s}`);
    edge(`e-XFMR-${s}`, `XFMR-${s}`, `MV-SWGR-${s}`, 'normal', s, 'derived');
    edge(`e-LV-${s}`, `LV-SWGR-${s}`, `XFMR-${s}`, 'normal', s, 'derived');
    edge(`e-UPS-${s}`, `UPS-${s}`, `LV-SWGR-${s}`, 'normal', s, 'derived');
    edge(`e-CRIT-${s}`, `CRIT-BUS-${s}`, `UPS-${s}`, 'normal', s, 'ups');
    edge(`e-RPP-${s}`, `RPP-${s}`, `CRIT-BUS-${s}`, 'normal', s, 'derived');
    edge(`e-PDU-${s}`, `PDU-${s}`, `RPP-${s}`, 'normal', s, 'derived');
  };
  buildTrain('A');
  buildTrain('B');

  // --- dual-corded IT racks (2N): A from PDU-A, B from PDU-B ---
  for (let i = 1; i <= 12; i++) {
    const id = `RACK-${String(i).padStart(2, '0')}`;
    node(id, { isLoad: true, redundancyClaim: '2N' });
    edge(`A-cord-${id}`, id, 'PDU-A', 'normal', 'A', 'derived');
    edge(`B-cord-${id}`, id, 'PDU-B', 'normal', 'B', 'derived');
  }

  // --- mechanical loads (N+1): fed from both LV switchgears, NO UPS ---
  for (let i = 1; i <= 4; i++) {
    const id = `CRAH-${i}`;
    node(id, { isLoad: true, redundancyClaim: 'N+1' });
    edge(`A-mech-${id}`, id, 'LV-SWGR-A', 'normal', 'A', 'derived');
    edge(`B-mech-${id}`, id, 'LV-SWGR-B', 'normal', 'B', 'derived');
  }

  return { nodes, edges };
}

export const datacenter2N = buildDatacenter2N();
export const rackIds = datacenter2N.nodes.filter((n) => /^RACK-/.test(n.id)).map((n) => n.id);
export const crahIds = datacenter2N.nodes.filter((n) => /^CRAH-/.test(n.id)).map((n) => n.id);
export default datacenter2N;
