import { useState, useCallback, useMemo } from 'react';
import api from '../api/client';
import { assetLabel, EQUIPMENT_TYPE_LABELS } from '../lib/equipment';

/**
 * RedundancyImpactPanel — read-only "what breaks if I drop a source/side" view for a
 * multi-source (2N / N+1) site. Mounted on SiteDetail inside the System Studies card,
 * behind the same per-account arc_flash_studies flag as ArcFlashIngestPanel.
 *
 * Backs onto the existing engine (no writes):
 *   GET /api/arc-flash-redundancy/site/:siteId/redundancy-impact?offline=<assetId|sideA|sideB>
 *
 * Response (see server/lib/redundancyImpact.ts RedundancyImpactResult, spread by the route):
 *   { siteId, nodeCount, edgeCount, edgeSource,
 *     offline: { nodeIds, edgeIds, side },
 *     loads: [{ loadId, label, status: 'RETAINED'|'AT_RISK'|'DROPPED',
 *               durablePaths, baselineDurablePaths, rideThroughOnly,
 *               redundancyDowngrade, redundancyContradiction? }],
 *     retained, atRisk, dropped,
 *     concurrentMaintainable, cleanConcurrentMaintenance,
 *     legend: { RETAINED, AT_RISK, DROPPED } }
 *
 * Counting is by INDEPENDENT durable source paths: >=2 = RETAINED (still redundant),
 * 1 = AT_RISK (redundancy lost / battery ride-through), 0 = DROPPED (dark).
 */

// Status → token color + human copy. Falls back to a literal hex so this renders
// even if the CSS var is absent (matches ArcFlashIngestPanel's BAND_COLOR pattern).
const STATUS_META = {
  RETAINED: { color: 'var(--color-success, #16a34a)', bg: 'var(--color-success-bg, rgba(34,197,94,0.12))', label: 'Retained' },
  AT_RISK: { color: 'var(--color-warning, #c2410c)', bg: 'rgba(194,65,12,0.10)', label: 'At risk' },
  DROPPED: { color: 'var(--color-danger, #b91c1c)', bg: 'var(--color-danger-bg, rgba(220,38,38,0.10))', label: 'Dropped' },
};
const STATUS_ORDER = { DROPPED: 0, AT_RISK: 1, RETAINED: 2 };

// Equipment types that make sense as a "drop this source" selection. Everything
// else the user drops via the Side A / Side B convenience buttons.
const SOURCE_EQUIP_TYPES = new Set([
  'UTILITY_SERVICE', 'GENERATOR', 'PARALLELING_SWITCHGEAR', 'UPS_BATTERY', 'BATTERY_SYSTEM',
  'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'SWITCHGEAR', 'SWITCHBOARD', 'TRANSFER_SWITCH',
]);

function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META.DROPPED;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
      background: m.bg, color: m.color,
    }}>
      {m.label}
    </span>
  );
}

function CountTile({ status, value }) {
  const m = STATUS_META[status];
  return (
    <div style={{
      flex: '1 1 0', minWidth: 96, textAlign: 'center',
      padding: '10px 8px', borderRadius: 8, background: m.bg,
      border: `1px solid ${m.color}`,
    }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 800, color: m.color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: m.color, marginTop: 4 }}>
        {m.label}
      </div>
    </div>
  );
}

export default function RedundancyImpactPanel({ siteId, assets = [] }) {
  const [selection, setSelection] = useState({ kind: 'side', value: 'B' }); // default demo: drop side B
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ran, setRan] = useState(false);

  // Source-type assets, sorted, for the "specific source" dropdown. Reuses the
  // asset list SiteDetail already fetched — no extra network call.
  const sourceAssets = useMemo(
    () => assets
      .filter((a) => SOURCE_EQUIP_TYPES.has(a.equipmentType))
      .sort((a, b) => assetLabel(a).localeCompare(assetLabel(b))),
    [assets],
  );

  const run = useCallback(async () => {
    // Translate the selection into the endpoint's `offline` selector.
    const offline = selection.kind === 'side' ? `side${selection.value}` : selection.value;
    if (!offline) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(
        `/api/arc-flash-redundancy/site/${siteId}/redundancy-impact`,
        { params: { offline } },
      );
      setResult(r.data);
      setRan(true);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not compute redundancy impact.');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [siteId, selection]);

  const loadsSorted = useMemo(() => {
    if (!result?.loads) return [];
    return [...result.loads].sort((a, b) => {
      const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
      return s !== 0 ? s : (a.label || a.loadId).localeCompare(b.label || b.loadId);
    });
  }, [result]);

  const droppedSelectedAsset = selection.kind === 'asset'
    ? sourceAssets.find((a) => a.id === selection.value)
    : null;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>
        Redundancy impact — "what breaks if I drop this?"
      </div>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
        Take a distribution side or a single source offline and see which downstream loads stay
        powered, which lose redundancy, and which go dark — counting independent durable source
        paths. Read-only; nothing is changed.
      </div>

      {/* Selector row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
        <button
          type="button"
          className={selection.kind === 'side' && selection.value === 'A' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
          onClick={() => setSelection({ kind: 'side', value: 'A' })}
        >
          Drop side A
        </button>
        <button
          type="button"
          className={selection.kind === 'side' && selection.value === 'B' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
          onClick={() => setSelection({ kind: 'side', value: 'B' })}
        >
          Drop side B
        </button>

        {sourceAssets.length > 0 && (
          <select
            value={selection.kind === 'asset' ? selection.value : ''}
            onChange={(e) => setSelection(e.target.value ? { kind: 'asset', value: e.target.value } : { kind: 'side', value: 'B' })}
            style={{
              fontSize: 'var(--font-size-sm)', padding: '5px 8px', borderRadius: 6,
              border: '1px solid var(--color-border)', background: 'var(--color-surface, #fff)',
              color: 'var(--color-text)', maxWidth: 320,
            }}
          >
            <option value="">…or drop a specific source</option>
            {sourceAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {assetLabel(a)} ({EQUIPMENT_TYPE_LABELS?.[a.equipmentType] || a.equipmentType})
              </option>
            ))}
          </select>
        )}

        <button type="button" className="btn btn-primary btn-sm" onClick={run} disabled={loading}>
          {loading ? 'Computing…' : 'Show impact'}
        </button>
      </div>

      {error && (
        <div style={{
          padding: '10px 12px', borderRadius: 6, marginBottom: 12,
          background: 'var(--color-danger-bg, rgba(220,38,38,0.10))',
          color: 'var(--color-danger, #b91c1c)', fontSize: 'var(--font-size-sm)',
        }}>
          {error}
        </div>
      )}

      {ran && result && !error && (
        <>
          {/* What was dropped + overall verdict */}
          <div style={{ fontSize: 'var(--font-size-sm)', marginBottom: 10 }}>
            Dropped:{' '}
            <strong>
              {selection.kind === 'side'
                ? `entire side ${selection.value}`
                : (droppedSelectedAsset ? assetLabel(droppedSelectedAsset) : 'selected source')}
            </strong>
            {'. '}
            {result.dropped === 0 ? (
              <span style={{ color: 'var(--color-success, #16a34a)', fontWeight: 600 }}>
                Concurrent-maintainable — no load goes dark.
              </span>
            ) : (
              <span style={{ color: 'var(--color-danger, #b91c1c)', fontWeight: 600 }}>
                Not concurrent-maintainable — {result.dropped} load{result.dropped === 1 ? '' : 's'} would go dark.
              </span>
            )}
          </div>

          {/* Count tiles */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <CountTile status="RETAINED" value={result.retained} />
            <CountTile status="AT_RISK" value={result.atRisk} />
            <CountTile status="DROPPED" value={result.dropped} />
          </div>

          {/* Affected-loads list */}
          {loadsSorted.length === 0 ? (
            <div style={{
              padding: '18px 16px', textAlign: 'center',
              color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)',
            }}>
              No loads are modeled for this site yet. Tag IT racks / mechanical loads and their
              feeds (AssetFeed topology) to populate this.
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Load</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Durable paths</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {loadsSorted.map((l) => (
                    <tr key={l.loadId}>
                      <td style={{ fontWeight: 600 }}>{l.label || l.loadId}</td>
                      <td><StatusPill status={l.status} /></td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {l.durablePaths}
                        {l.baselineDurablePaths !== l.durablePaths && (
                          <span style={{ color: 'var(--color-text-secondary)' }}> / {l.baselineDurablePaths}</span>
                        )}
                      </td>
                      <td className="td-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                        {l.status === 'DROPPED' && 'No source path remains'}
                        {l.status === 'AT_RISK' && l.rideThroughOnly && 'Battery ride-through only (no durable source)'}
                        {l.status === 'AT_RISK' && !l.rideThroughOnly && l.redundancyDowngrade && 'Redundancy lost — single source'}
                        {l.status === 'AT_RISK' && !l.rideThroughOnly && !l.redundancyDowngrade && 'Down to a single source'}
                        {l.status === 'RETAINED' && 'Still redundant'}
                        {l.redundancyContradiction && (
                          <div style={{ color: 'var(--color-warning, #c2410c)', marginTop: 2 }}>
                            ⚠ {l.redundancyContradiction}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{
            fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)',
            marginTop: 8, lineHeight: 1.5,
          }}>
            Durable paths = independent utility/generator source paths remaining (baseline shown after the slash when it changed).
            {result.edgeSource === 'fed_from_tree_fallback' && (
              <> Topology derived from the primary feed tree — tag AssetFeed edges (A/B sides, source kinds) for full multi-source accuracy.</>
            )}
          </div>
        </>
      )}
    </div>
  );
}
