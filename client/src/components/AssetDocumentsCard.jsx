// ─────────────────────────────────────────────────────────────────────────────
// AssetDocumentsCard.jsx — Documents & Procedures panel on the asset detail page.
//
// Shows all documents attached to an asset, grouped by docType:
//   • OEM Manual / Wiring Diagram / Test Report / Inspection / Commissioning /
//     Warranty / LOTO PDF / Other
//
// Supports:
//   • Uploading a file (POST /api/documents/upload with docType)
//   • Adding an external URL link (POST /api/documents/link)
//   • Inline rename and docType re-classification (PATCH /api/documents/:id)
//   • Deleting a document (manager+)
//   • Download / open-in-new-tab via /api/documents/:id/url or externalUrl
//
// Takes { asset, canWrite }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api/client';
import { useConfirm } from '../context/ConfirmContext';
import Toast from './Toast';

const DOC_TYPE_META = {
  oem_manual:           { label: 'OEM Manual',           icon: '📖' },
  wiring_diagram:       { label: 'Wiring Diagram',        icon: '📐' },
  loto_pdf:             { label: 'LOTO Procedure (PDF)',  icon: '🔒' },
  test_report:          { label: 'Test Report',           icon: '🧪' },
  inspection_report:    { label: 'Inspection Report',     icon: '🔍' },
  commissioning_report: { label: 'Commissioning Report',  icon: '⚡' },
  warranty:             { label: 'Warranty / Contract',   icon: '📜' },
  other:                { label: 'Other',                 icon: '📄' },
};

const DOC_TYPE_OPTIONS = [
  { value: '',                    label: '— Select type —' },
  { value: 'oem_manual',          label: 'OEM Manual' },
  { value: 'wiring_diagram',      label: 'Wiring Diagram' },
  { value: 'loto_pdf',            label: 'LOTO Procedure (PDF backup)' },
  { value: 'test_report',         label: 'Test Report' },
  { value: 'inspection_report',   label: 'Inspection Report' },
  { value: 'commissioning_report',label: 'Commissioning Report' },
  { value: 'warranty',            label: 'Warranty / Contract' },
  { value: 'other',               label: 'Other' },
];

function groupByType(docs) {
  const order = Object.keys(DOC_TYPE_META);
  const grouped = {};
  for (const doc of docs) {
    const key = doc.docType || 'other';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(doc);
  }
  // Sort groups by canonical order
  return Object.entries(grouped).sort(([a], [b]) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

function fmtDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Add Document form ─────────────────────────────────────────────────────────
function AddDocForm({ assetId, onAdded, onCancel }) {
  const [mode,     setMode]     = useState('file'); // 'file' | 'url'
  const [docType,  setDocType]  = useState('');
  const [url,      setUrl]      = useState('');
  const [filename, setFilename] = useState('');
  const [file,     setFile]     = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [err,      setErr]      = useState(null);
  const fileRef = useRef();

  async function handleSubmit(e) {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    try {
      if (mode === 'url') {
        if (!url.trim() || !filename.trim()) { setErr('URL and filename are required'); setSaving(false); return; }
        await api.post('/api/documents/link', { url, filename, docType: docType || null, assetId });
      } else {
        if (!file) { setErr('Select a file to upload'); setSaving(false); return; }
        const form = new FormData();
        form.append('file', file);
        form.append('assetId', assetId);
        if (docType) form.append('docType', docType);
        await api.post('/api/documents/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      onAdded();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to save document');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{
      background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)',
      borderRadius: 8, padding: 16, marginTop: 12,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 'var(--font-size-sm)' }}>Add Document</div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {['file','url'].map(m => (
          <button key={m} type="button"
            className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMode(m)}>
            {m === 'file' ? '📎 Upload file' : '🔗 Add URL link'}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {/* Doc type */}
        <div style={{ flex: '0 0 auto' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>Document type</label>
          <select className="input" value={docType} onChange={e => setDocType(e.target.value)} style={{ width: 200 }}>
            {DOC_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {mode === 'file' ? (
          <div style={{ flex: '1 1 200px' }}>
            <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>File *</label>
            <input ref={fileRef} type="file" className="input" style={{ padding: '5px 8px' }}
              onChange={e => setFile(e.target.files[0] || null)} />
          </div>
        ) : (
          <>
            <div style={{ flex: '1 1 220px' }}>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>URL *</label>
              <input className="input" type="url" placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} />
            </div>
            <div style={{ flex: '1 1 180px' }}>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>Display name *</label>
              <input className="input" type="text" placeholder="e.g. Eaton Cutler-Hammer Manual" value={filename} onChange={e => setFilename(e.target.value)} />
            </div>
          </>
        )}

        <button type="submit" className="btn btn-primary btn-sm" disabled={saving} style={{ alignSelf: 'flex-end' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} style={{ alignSelf: 'flex-end' }}>
          Cancel
        </button>
      </div>
      {err && <div style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-xs)', marginTop: 8 }}>{err}</div>}
    </form>
  );
}

// ── Document row ──────────────────────────────────────────────────────────────
function DocRow({ doc, canWrite, onDeleted, onUpdated }) {
  const confirm = useConfirm();
  const [opening,  setOpening]  = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing,  setEditing]  = useState(false);
  const [newType,  setNewType]  = useState(doc.docType || '');
  const isExternal = doc.filePath === '__external__';

  async function handleOpen() {
    if (isExternal) { window.open(doc.externalUrl, '_blank', 'noopener'); return; }
    setOpening(true);
    try {
      const { data } = await api.get(`/api/documents/${doc.id}/url`);
      const href = data.data?.url || data.data?.apiPath;
      if (href) window.open(href, '_blank', 'noopener');
    } catch { /* ignore */ }
    finally { setOpening(false); }
  }

  async function handleDelete() {
    if (!await confirm({
      title: 'Delete document?',
      message: `Delete "${doc.filename}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    setDeleting(true);
    try {
      await api.delete(`/api/documents/${doc.id}`);
      onDeleted(doc.id);
    } catch { setDeleting(false); }
  }

  async function handleTypeChange(val) {
    setNewType(val);
    try {
      await api.patch(`/api/documents/${doc.id}`, { docType: val || null });
      onUpdated({ ...doc, docType: val || null });
    } catch { /* revert */ setNewType(doc.docType || ''); }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px',
      borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 18, flexShrink: 0 }}>
        {isExternal ? '🔗' : '📄'}
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {doc.filename}
        </div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          {fmtDate(doc.uploadedAt)}
          {doc.uploader?.name && ` · ${doc.uploader.name}`}
          {isExternal && <span style={{ marginLeft: 6, color: 'var(--color-accent)' }}>external link</span>}
        </div>
      </div>

      {/* Inline type reclassification (manager+) */}
      {editing ? (
        <select className="input" value={newType} onChange={e => { handleTypeChange(e.target.value); setEditing(false); }}
          style={{ fontSize: 'var(--font-size-xs)', padding: '3px 6px', width: 170 }}>
          {DOC_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        canWrite && (
          <button type="button" onClick={() => setEditing(true)}
            style={{ fontSize: 11, color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
            title="Change type">
            {(DOC_TYPE_META[doc.docType]?.icon || '📄')} {DOC_TYPE_META[doc.docType]?.label || 'Unclassified'} ✎
          </button>
        )
      )}

      <button type="button" className="btn btn-secondary btn-sm" onClick={handleOpen} disabled={opening}
        style={{ flexShrink: 0 }}>
        {opening ? '…' : isExternal ? 'Open ↗' : 'Download'}
      </button>

      {canWrite && (
        <button type="button" onClick={handleDelete} disabled={deleting}
          style={{ color: 'var(--color-danger)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, flexShrink: 0 }}
          title="Delete">
          {deleting ? '…' : '×'}
        </button>
      )}
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────
export default function AssetDocumentsCard({ asset, canWrite }) {
  const [docs,     setDocs]     = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [showAdd,  setShowAdd]  = useState(false);
  const [toast,    setToast]    = useState(null);

  const fetchDocs = useCallback(async () => {
    if (!asset?.id) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/api/documents/asset/${asset.id}`);
      setDocs(data.data || []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [asset?.id]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  function handleDeleted(id) {
    setDocs(d => d.filter(doc => doc.id !== id));
    setToast({ message: 'Document removed', type: 'success' });
  }

  function handleUpdated(updated) {
    setDocs(d => d.map(doc => doc.id === updated.id ? updated : doc));
  }

  const groups = groupByType(docs);

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="card-title">Documents & Procedures {docs.length > 0 && `(${docs.length})`}</div>
        {canWrite && !showAdd && (
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAdd(true)}>+ Add document</button>
        )}
      </div>

      <div className="card-body">
        {showAdd && (
          <AddDocForm
            assetId={asset.id}
            onAdded={() => { setShowAdd(false); fetchDocs(); setToast({ message: 'Document added', type: 'success' }); }}
            onCancel={() => setShowAdd(false)}
          />
        )}

        {loading && docs.length === 0 && (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>Loading…</div>
        )}

        {!loading && docs.length === 0 && !showAdd && (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            No documents attached.
            {canWrite && ' Upload OEM manuals, wiring diagrams, test reports, or add URL links to manufacturer portals.'}
          </div>
        )}

        {groups.map(([type, typeDocs]) => (
          <div key={type} style={{ marginBottom: 16 }}>
            <div style={{
              fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
              textTransform: 'uppercase', color: 'var(--color-text-secondary)', margin: '12px 0 4px',
            }}>
              {DOC_TYPE_META[type]?.icon || '📄'} {DOC_TYPE_META[type]?.label || 'Other'} ({typeDocs.length})
            </div>
            {typeDocs.map(doc => (
              <DocRow key={doc.id} doc={doc} canWrite={canWrite}
                onDeleted={handleDeleted} onUpdated={handleUpdated} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
