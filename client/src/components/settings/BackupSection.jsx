import React, { useState, useEffect, useCallback } from 'react';
import { useConfirm } from '../../context/ConfirmContext';
import api from '../../api/client';

import { sectionHeading, sectionDesc, btnPrimary } from './sharedStyles';

// ── Backup Section ────────────────────────────────────────────────────────────

export default function BackupSection() {
  const confirm = useConfirm();
  const [status,    setStatus]    = useState(null);   // { configured, lastBackup, lastFailure }
  const [logs,      setLogs]      = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');     // API fetch failure — shown alone, never with empty-state
  const [running,   setRunning]   = useState(false);
  const [msg,       setMsg]       = useState(null);   // { ok, text } for manual-trigger feedback

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [statusRes, logsRes] = await Promise.all([
        api.get('/api/backup/status'),
        api.get('/api/backup/logs?limit=20'),
      ]);
      setStatus(statusRes.data.data);
      setLogs(logsRes.data.data?.logs || []);
    } catch {
      // Show only the load error — do NOT fall through to the empty-state below
      setLoadError('Failed to load backup information. Check your server connection and try refreshing.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function triggerManual() {
    if (!await confirm({
      title: 'Run manual backup',
      message: 'Run a manual backup now? This may take a minute for large databases.',
      confirmLabel: 'Run backup',
    })) return;
    setRunning(true);
    setMsg(null);
    try {
      await api.post('/api/backup/run');
      setMsg({ ok: true, text: 'Backup started. Refresh in a moment to see the result.' });
      // Reload logs after a short delay to catch fast completions
      setTimeout(() => load(), 5000);
    } catch (err) {
      const e = err.response?.data?.error || 'Failed to start backup.';
      setMsg({ ok: false, text: e });
    } finally {
      setRunning(false);
    }
  }

  function fmtBytes(b) {
    if (!b) return '—';
    if (b < 1024)        return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function timeSince(d) {
    if (!d) return null;
    const mins = Math.floor((Date.now() - new Date(d)) / 60000);
    if (mins < 60)  return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs  < 48)  return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)} days ago`;
  }

  const cfg = status?.config;
  const destLabel = { local: 'Local filesystem', s3: 'S3 / Cloud', both: 'Local + S3' };

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Automated Backups</h2>
      <p className={sectionDesc}>
        Daily pg_dump backups run at 2:00 AM (server time). By default backups write to a local
        directory on the server — no cloud account required. Set <code>BACKUP_DEST=s3</code> or{' '}
        <code>both</code> in your <code>.env</code> to also push to an S3-compatible bucket
        (AWS, Backblaze B2, Wasabi, MinIO, or any on-prem S3-compatible store).
      </p>

      {loading ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Loading…</div>
      ) : loadError ? (
        // API call failed — show ONLY the error, never alongside the empty-state
        <div style={{ padding: '0.75rem 1rem', borderRadius: 8, background: 'var(--color-danger-bg)', border: '1px solid #fecaca', color: 'var(--color-danger)', fontSize: '0.875rem' }}>
          {loadError}
        </div>
      ) : (
        <>
          {/* ── Status cards ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' }}>

            {/* Destination */}
            <div style={{ padding: '0.875rem 1rem', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Destination
              </div>
              <div style={{ fontSize: '0.875rem', color: 'var(--color-text)', fontWeight: 600 }}>
                {destLabel[cfg?.dest] || 'Local filesystem'}
              </div>
              {cfg?.localPath && (
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 3, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {cfg.localPath}
                </div>
              )}
              {cfg?.dest === 's3' || cfg?.dest === 'both' ? (
                <div style={{ fontSize: '0.75rem', marginTop: 4 }}>
                  S3:{' '}
                  <span style={{ color: cfg.s3Configured ? 'var(--color-success)' : 'var(--color-warning)', fontWeight: 600 }}>
                    {cfg.s3Configured ? '✓ configured' : '⚠ credentials missing'}
                  </span>
                </div>
              ) : null}
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 3 }}>
                Retention: {cfg?.retentionDays ?? 30} days · Set via <code>BACKUP_DEST</code> in .env
              </div>
            </div>

            {/* Last successful backup */}
            <div style={{ padding: '0.875rem 1rem', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Last Successful Backup
              </div>
              {status?.lastBackup ? (
                <>
                  <div style={{ fontSize: '0.875rem', color: 'var(--color-text)', fontWeight: 600 }}>
                    {timeSince(status.lastBackup.at)}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    {fmtDate(status.lastBackup.at)} · {fmtBytes(status.lastBackup.sizeBytes)}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>No backups yet</div>
              )}
            </div>
          </div>

          {/* Last failure warning */}
          {status?.lastFailure && (
            <div style={{ padding: '0.75rem 1rem', borderRadius: 8, background: 'var(--color-danger-bg)', border: '1px solid #fecaca', marginBottom: '1rem' }}>
              <div style={{ fontWeight: 600, color: 'var(--color-danger)', fontSize: '0.875rem', marginBottom: 2 }}>
                Last failure: {fmtDate(status.lastFailure.at)}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--color-danger-strong)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {status.lastFailure.error}
              </div>
            </div>
          )}

          {/* Manual trigger */}
          <div style={{ marginBottom: '1.25rem' }}>
            <button
              type="button"
              onClick={triggerManual}
              disabled={running || !status?.configured}
              className={btnPrimary} style={{ opacity: (!status?.configured) ? 0.5 : 1 }}
            >
              {running ? 'Starting…' : 'Run Backup Now'}
            </button>
            {!status?.configured && (
              <span style={{ marginLeft: 10, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                Configure storage first
              </span>
            )}
          </div>

          {msg && (
            <div style={{ padding: '0.625rem 0.875rem', borderRadius: 6, marginBottom: '1rem', background: msg.ok ? 'var(--color-success-soft)' : 'var(--color-danger-bg)', border: `1px solid ${msg.ok ? 'var(--color-success-bg-strong)' : 'var(--color-danger)'}`, color: msg.ok ? 'var(--color-success)' : 'var(--color-danger)', fontSize: '0.825rem' }}>
              {msg.text}
            </div>
          )}

          {/* Recent logs table */}
          {logs.length > 0 && (
            <div>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                Recent Backup Log
              </div>
              <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-secondary, #f9fafb)' }}>
                      {['Date', 'Status', 'Size', 'Trigger', 'File / Error'].map(h => (
                        <th scope="col" key={h} style={{ padding: '0.5rem 0.75rem', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', borderBottom: '1px solid var(--color-border)' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log, i) => {
                      // C2: tint failed rows red so an operator scanning the
                      // log immediately notices failures, and surface the
                      // truncated error message inline instead of only on hover.
                      const isFail = log.status !== 'success';
                      const rowBg  = isFail ? 'var(--color-danger-soft)' : 'transparent';
                      return (
                        <tr key={log.id} style={{ borderBottom: i < logs.length - 1 ? '1px solid var(--color-border)' : 'none', background: rowBg }}>
                          <td style={{ padding: '0.5rem 0.75rem', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                            {fmtDate(log.createdAt)}
                          </td>
                          <td style={{ padding: '0.5rem 0.75rem' }}>
                            {isFail ? (
                              <span style={{ color: 'var(--color-danger)', fontWeight: 600 }} title={log.error || ''}>✗ Failed</span>
                            ) : (
                              <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>✓ Success</span>
                            )}
                          </td>
                          <td style={{ padding: '0.5rem 0.75rem', color: 'var(--color-text-secondary)' }}>
                            {fmtBytes(log.sizeBytes)}
                          </td>
                          <td style={{ padding: '0.5rem 0.75rem', color: 'var(--color-text-secondary)', textTransform: 'capitalize' }}>
                            {log.triggeredBy}
                          </td>
                          {isFail ? (
                            <td
                              style={{ padding: '0.5rem 0.75rem', color: 'var(--color-danger-strong)', fontFamily: 'monospace', fontSize: '0.75rem', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={log.error || ''}
                            >
                              {log.error || 'Unknown error'}
                            </td>
                          ) : (
                            <td style={{ padding: '0.5rem 0.75rem', color: 'var(--color-text-secondary)', fontFamily: 'monospace', fontSize: '0.75rem', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {log.filename || '—'}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {logs.length === 0 && (
            <div style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
              No backup records yet. Backups run automatically at 2:00 AM daily once storage is configured.
            </div>
          )}
        </>
      )}
    </section>
  );
}
