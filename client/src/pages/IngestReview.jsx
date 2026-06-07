import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import AiDisclaimer from '../components/AiDisclaimer';
import AiCapHelper from '../components/AiCapHelper'; // v0.32.4
import { useAiConsent } from '../context/AiConsentContext';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ConfidenceDot({ score }) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  const color = score >= 0.8 ? 'var(--color-success)' : score >= 0.5 ? 'var(--color-warning)' : 'var(--color-danger)';
  return (
    <span
      title={`AI confidence: ${pct}%`}
      aria-label={`AI confidence ${pct} percent`}
      role="img"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        marginLeft: 6,
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
    />
  );
}

const FLAG_LABELS = {
  auto_renewal: 'Auto-Renewal',
  price_escalation: 'Price Escalation',
  termination: 'Termination',
  notice_period: 'Notice Period',
  minimum_commit: 'Minimum Commit',
  other: 'Other',
};

const FLAG_COLORS = {
  auto_renewal: { bg: 'var(--color-danger-bg)', border: 'var(--color-danger)', text: 'var(--color-danger)' },
  price_escalation: { bg: 'var(--color-warning-bg)', border: 'var(--color-warning)', text: 'var(--color-warning)' },
  termination: { bg: 'var(--color-danger-bg)', border: 'var(--color-danger)', text: 'var(--color-danger)' },
  notice_period: { bg: 'var(--color-primary-light)', border: '#93c5fd', text: 'var(--color-primary-hover)' },
  minimum_commit: { bg: '#fdf4ff', border: '#d8b4fe', text: '#7e22ce' },
  other: { bg: 'var(--color-bg)', border: 'var(--color-border-strong)', text: 'var(--color-text-secondary)' },
};

// ── Upload step ───────────────────────────────────────────────────────────────

function UsageMeter({ count, limit }) {
  const pct = Math.min(100, Math.round((count / limit) * 100));
  const remaining = Math.max(0, limit - count);
  const nearLimit = remaining <= 2;
  const atLimit = remaining === 0;
  const barColor = atLimit ? '#b91c1c' : nearLimit ? '#b45309' : 'var(--color-primary)';

  return (
    <div style={{
      padding: '12px 16px',
      background: atLimit ? '#fef2f2' : nearLimit ? '#fffbeb' : 'var(--color-surface)',
      border: `1px solid ${atLimit ? '#fecaca' : nearLimit ? '#fde68a' : 'var(--color-border)'}`,
      borderRadius: 'var(--radius)',
      marginBottom: 24,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: atLimit ? '#b91c1c' : 'var(--color-text)' }}>
          {atLimit ? 'Free AI import limit reached' : `${count} of ${limit} free AI imports used`}
        </span>
        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          {atLimit ? '0 remaining' : `${remaining} remaining`}
        </span>
      </div>
      <div style={{ height: 6, background: 'var(--color-border-strong)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}

function UpgradePrompt({ count, limit }) {
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', paddingTop: 48, textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>🚀</div>
      {/* design-pass: brand-tinted page title to match the rest of the SPA */}
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-accent-strong)', letterSpacing: '-0.005em', marginBottom: 12 }}>You've used all {limit} free AI imports</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: 32, lineHeight: 1.6 }}>
        Your account has used all {limit} free AI contract extractions. Upgrade to continue importing
        contracts with Claude AI — or contact your administrator to increase the limit.
      </p>
      <div style={{
        padding: '24px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        marginBottom: 24,
      }}>
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, marginBottom: 8 }}>Cloud plan coming soon</div>
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          Unlimited AI imports, priority processing, and dedicated support.
          Join the waitlist to be notified when cloud billing is available.
        </div>
        <button
          className="btn btn-primary"
          style={{ marginTop: 16 }}
          onClick={() => alert('Waitlist feature coming soon — check back shortly!')}
        >
          Join the Waitlist
        </button>
      </div>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
        Self-hosted? Increase the limit in <strong>Settings → AI Ingestion Usage</strong>.
      </p>
    </div>
  );
}

function UploadStep({ onUploaded }) {
  const fileRef = useRef();
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState(null);
  const { requestConsent } = useAiConsent(); // Phase 4: gate AI ingest
  const { demoMode } = useAuth(); // v0.92.x: hide the self-host 'free imports' meter in demo (AiCapHelper shows the demo cap)

  const ACCEPTED_EXTS = ['pdf', 'doc', 'docx', 'txt', 'lic', 'eml', 'tiff', 'tif', 'jpg', 'jpeg', 'png'];

  useEffect(() => {
    api.get('/api/ingest/usage')
      .then(r => setUsage(r.data.data))
      .catch(() => {}); // non-fatal — meter just won't show
  }, []);

  function pickFile(f) {
    if (!f) return;
    const ext = f.name.toLowerCase().split('.').pop();
    if (!ACCEPTED_EXTS.includes(ext)) {
      setError('Accepted types: PDF, Word (.doc/.docx), plain text (.txt), license files (.lic), email files (.eml), images (.tiff, .jpg, .png)');
      return;
    }
    setError('');
    setFile(f);
  }

  async function handleUpload() {
    if (!file) return;
    // Phase 4: gate AI ingest behind the per-session consent modal.
    requestConsent(() => doUpload());
  }

  async function doUpload() {
    setUploading(true);
    setError('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/ingest/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
        },
        body: formData,
      });
      const data = await res.json();
      if (!data.success) {
        // Refresh usage meter so it updates immediately if limit was just hit
        api.get('/api/ingest/usage').then(r => setUsage(r.data.data)).catch(() => {});
        // L1: AI daily-cap (per user, per action, per UTC day). Surfaces in
        // demo mode where the cap is forced to 2; on self-hosted the cap is
        // unlimited by default so this branch effectively never fires.
        if (data.error === 'ai_daily_cap_reached') {
          throw new Error('ai_daily_cap_reached');
        }
        throw new Error(data.error === 'free_limit_reached' ? 'free_limit_reached' : (data.error || 'Upload failed'));
      }
      // Refresh usage after a successful upload
      api.get('/api/ingest/usage').then(r => setUsage(r.data.data)).catch(() => {});
      onUploaded(data.data);
    } catch (err) {
      if (err.message === 'ai_daily_cap_reached') {
        setError('You’ve hit today’s AI extraction limit on this demo. Resets at midnight UTC.');
      } else if (err.message !== 'free_limit_reached') {
        setError(err.message);
      }
    } finally {
      setUploading(false);
    }
  }

  // Show upgrade wall if at limit
  if (usage && usage.count >= usage.limit) {
    return <UpgradePrompt count={usage.count} limit={usage.limit} />;
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', paddingTop: 48 }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-accent-strong)', letterSpacing: '-0.005em', marginBottom: 8 }}>Upload Contract Document</h1>
      <p style={{ color: 'var(--color-text-secondary)', marginBottom: 16 }}>
        Upload a contract file — Claude will extract all fields for your review.
      </p>

      {/* Usage meter */}
      {usage && !demoMode && <UsageMeter count={usage.count} limit={usage.limit} />}

      {/* v0.32.4: per-user, per-day AI cap helper line (demo only). */}
      <AiCapHelper action="extract" label="AI extractions" scope="all uploads" />

      {/* Drop zone */}
      <div
        onClick={() => !uploading && fileRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          pickFile(e.dataTransfer.files[0]);
        }}
        style={{
          border: `2px dashed ${dragging ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
          borderRadius: 'var(--radius-lg)',
          padding: '48px 24px',
          textAlign: 'center',
          cursor: uploading ? 'default' : 'pointer',
          background: dragging ? 'var(--color-primary-light)' : 'var(--color-surface)',
          transition: 'all 0.15s',
          marginBottom: 20,
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,.lic,.eml,.tiff,.tif,.jpg,.jpeg,.png"
          style={{ display: 'none' }}
          onChange={e => pickFile(e.target.files[0])}
        />
        <div style={{ fontSize: 'var(--font-size-hero)', marginBottom: 12 }}>📄</div>
        {file ? (
          <>
            <div style={{ fontWeight: 600, fontSize: 'var(--font-size-base)' }}>{file.name}</div>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)', marginTop: 4 }}>
              {(file.size / 1024 / 1024).toFixed(2)} MB — click to change
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, fontSize: 'var(--font-size-base)' }}>Drop your file here or click to browse</div>
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)', marginTop: 4 }}>
              PDF, DOC, DOCX, TXT, LIC, EML, TIFF, JPG, PNG — up to 50 MB
            </div>
          </>
        )}
      </div>

      {error && (
        <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      <button
        className="btn btn-primary"
        onClick={handleUpload}
        disabled={!file || uploading}
        style={{ width: '100%', padding: '12px', fontSize: 'var(--font-size-base)' }}
      >
        {uploading ? '⏳ Uploading & extracting with Claude AI…' : 'Upload & Extract'}
      </button>

      {uploading && (
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)', textAlign: 'center', marginTop: 12 }}>
          Claude is reading the document and extracting contract fields. This usually takes 10–30 seconds.
        </p>
      )}
    </div>
  );
}

// ── Review step ───────────────────────────────────────────────────────────────

function ReviewField({ label, fieldKey, value, onChange, type = 'text', confidenceScores }) {
  const confidence = confidenceScores?.[fieldKey];
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
        <ConfidenceDot score={confidence} />
      </label>
      {type === 'checkbox' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={e => onChange(fieldKey, e.target.checked)}
          />
          <span style={{ fontSize: 'var(--font-size-data)' }}>{value ? 'Yes — contract auto-renews' : 'No auto-renewal'}</span>
        </label>
      ) : type === 'textarea' ? (
        <textarea
          value={value || ''}
          onChange={e => onChange(fieldKey, e.target.value)}
          rows={3}
          className="form-input"
          style={{ width: '100%', resize: 'vertical' }}
        />
      ) : (
        <input
          type={type}
          value={value || ''}
          onChange={e => onChange(fieldKey, e.target.value)}
          className="form-input"
          style={{ width: '100%' }}
        />
      )}
    </div>
  );
}

function ReviewStep({ session, onApproved, onRejected }) {
  const { extractedFields: extracted = {}, confidenceScores = {}, aiNotes } = session;
  const flags = session.aiNotes?.flags || [];
  const aiNote = session.aiNotes?.notes;
  const confirm = useConfirm();

  const [fields, setFields] = useState({ ...extracted });
  const [vendors, setVendors] = useState([]);
  const [vendorId, setVendorId] = useState('');
  const [newVendorName, setNewVendorName] = useState(extracted.vendorName || '');
  // Default to 'new' if Claude detected a vendor name — switches to 'existing' if a match is found
  const [vendorMode, setVendorMode] = useState(extracted.vendorName ? 'new' : 'existing');
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/vendors').then(r => {
      const list = r.data.data?.vendors || [];
      setVendors(list);
      // If Claude detected a vendor name, try to match an existing vendor
      if (extracted.vendorName && list.length > 0) {
        const match = list.find(v =>
          v.name.toLowerCase().includes(extracted.vendorName.toLowerCase()) ||
          extracted.vendorName.toLowerCase().includes(v.name.toLowerCase())
        );
        if (match) {
          setVendorId(match.id);
          setVendorMode('existing');
        }
        // No match → stays 'new' with name pre-filled, auto-creates on approve
      }
    }).catch(() => {});
  }, []);

  function setField(key, val) {
    setFields(prev => ({ ...prev, [key]: val }));
  }

  async function handleApprove() {
    if (vendorMode === 'existing' && !vendorId) {
      setError('Please select a vendor.');
      return;
    }
    if (vendorMode === 'new' && !newVendorName.trim()) {
      setError('Please enter a vendor name.');
      return;
    }
    setApproving(true);
    setError('');
    try {
      const res = await api.post(`/api/ingest/${session.id}/approve`, {
        fields,
        vendorId: vendorMode === 'existing' ? vendorId : null,
        createVendor: vendorMode === 'new' ? newVendorName.trim() : null,
      });
      onApproved(res.data.data.contractId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setApproving(false);
    }
  }

  // v0.10.0: attach-as-PO branch. Used when the user picks one of the
  // matchCandidates instead of creating a new contract. Skips the vendor
  // resolution UI entirely — the server creates a PurchaseOrder row under
  // the target contract and marks the ingest session imported.
  async function handleApproveAsPo(targetContractId) {
    if (!targetContractId) return;
    setApproving(true);
    setError('');
    try {
      const res = await api.post(`/api/ingest/${session.id}/approve`, {
        mode: 'attach',
        attachToContractId: targetContractId,
        fields,
      });
      onApproved(res.data.data.contractId);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setApproving(false);
    }
  }

  async function handleReject() {
    if (!await confirm({
      title: 'Discard extraction',
      message: 'Discard this extraction? No contract will be created.',
      confirmLabel: 'Discard',
      danger: true,
    })) return;
    try {
      await api.post(`/api/ingest/${session.id}/reject`);
      onRejected();
    } catch {}
  }

  const confidencePairs = Object.entries(confidenceScores);
  const lowConfidence = confidencePairs.filter(([, v]) => v < 0.7);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-accent-strong)', letterSpacing: '-0.005em', marginBottom: 4 }}>Review Extracted Data</h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>{session.originalFilename}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
          <button className="btn btn-secondary" onClick={handleReject} disabled={approving}>
            Discard
          </button>
          <button className="btn btn-primary" onClick={handleApprove} disabled={approving}>
            {approving ? 'Importing…' : '✓ Approve & Import'}
          </button>
        </div>
      </div>

      {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Persistent AI disclaimer for the extracted-fields review surface. */}
      <AiDisclaimer variant="extract" style={{ marginBottom: 16 }} />

      {/* v0.10.0: match-candidate banner. When the upload response surfaced
          one or more existing contracts that look like the master agreement
          for this extraction (matching vendor + contractNumber), show them
          here with an "Add as PO" CTA so the operator doesn't end up with
          duplicate Contract rows for the same MPSA / VIP master. */}
      {Array.isArray(session.matchCandidates) && session.matchCandidates.length > 0 && (
        <div className="card mb-16" style={{ borderColor: 'var(--color-info)' }}>
          <div className="card-header" style={{ background: 'var(--color-info-bg)', borderBottom: '1px solid var(--color-info)' }}>
            <div>
              <div className="card-title" style={{ color: 'var(--color-info)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>↪ Looks like this belongs under an existing contract</span>
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                We matched the extracted vendor + contract number against your active contracts. Adding as a PO keeps everything under one master agreement (Microsoft MPSA / Adobe VIP pattern). You can still create a separate new contract below if this is genuinely a different agreement.
              </div>
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Vendor</th>
                  <th scope="col">Contract #</th>
                  <th scope="col">Product</th>
                  <th scope="col">Existing POs</th>
                  <th scope="col" style={{ width: 180 }}></th>
                </tr>
              </thead>
              <tbody>
                {session.matchCandidates.map((m) => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 600 }}>{m.vendor?.name || '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-sm)' }}>{m.contractNumber || '—'}</td>
                    <td>{m.product || '—'}</td>
                    <td>
                      {(m.purchaseOrders && m.purchaseOrders.length > 0)
                        ? <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-sm)' }}>
                            {m.purchaseOrders.map(p => p.poNumber).join(', ')}
                          </span>
                        : <span className="text-muted">none yet</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => handleApproveAsPo(m.id)}
                        disabled={approving}
                      >
                        {approving ? 'Importing…' : 'Add as PO →'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--color-border)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              Not what you expected? Scroll down and use the regular <strong>Approve &amp; Import</strong> button to create a new contract instead.
            </div>
          </div>
        </div>
      )}

      {/* Low confidence warning */}
      {lowConfidence.length > 0 && (
        <div className="alert alert-info" style={{ marginBottom: 20 }}>
          <strong>Review carefully:</strong> {lowConfidence.length} field{lowConfidence.length > 1 ? 's' : ''} had low AI confidence ({lowConfidence.map(([k]) => k).join(', ')}). Dots are colored by confidence: <span style={{ color: 'var(--color-success)' }}>●</span> high &nbsp;<span style={{ color: 'var(--color-warning)' }}>●</span> medium &nbsp;<span style={{ color: 'var(--color-danger)' }}>●</span> low
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24, alignItems: 'start' }}>

        {/* ── Left: fields ── */}
        <div>

          {/* Vendor */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header"><h2 className="card-title">Vendor</h2></div>
            <div className="card-body">
              <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                <button
                  className={`btn ${vendorMode === 'existing' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ fontSize: 'var(--font-size-ui)' }}
                  onClick={() => setVendorMode('existing')}
                >
                  Match existing
                </button>
                <button
                  className={`btn ${vendorMode === 'new' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ fontSize: 'var(--font-size-ui)' }}
                  onClick={() => setVendorMode('new')}
                >
                  Create new
                </button>
              </div>

              {vendorMode === 'existing' ? (
                <div>
                  <label className="form-label">Select Vendor</label>
                  <select
                    aria-label="Select vendor"
                    className="form-input"
                    value={vendorId}
                    onChange={e => setVendorId(e.target.value)}
                    style={{ width: '100%' }}
                  >
                    <option value="">— choose vendor —</option>
                    {vendors.map(v => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                  {extracted.vendorName && (
                    <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 6 }}>
                      Claude detected vendor: <strong>{extracted.vendorName}</strong>
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="form-label">New Vendor Name</label>
                  <input
                    className="form-input"
                    value={newVendorName}
                    onChange={e => setNewVendorName(e.target.value)}
                    placeholder="e.g. Microsoft, Salesforce…"
                    style={{ width: '100%' }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Core fields */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header"><h2 className="card-title">Contract Details</h2></div>
            <div className="card-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
                <ReviewField label="Product / Service" fieldKey="product" value={fields.product} onChange={setField} confidenceScores={confidenceScores} />
                <ReviewField label="Contract Number" fieldKey="contractNumber" value={fields.contractNumber} onChange={setField} confidenceScores={confidenceScores} />
                <ReviewField label="Customer Number" fieldKey="customerNumber" value={fields.customerNumber} onChange={setField} confidenceScores={confidenceScores} />
                <ReviewField label="PO Number" fieldKey="poNumber" value={fields.poNumber} onChange={setField} confidenceScores={confidenceScores} />
                <ReviewField label="Invoice Number" fieldKey="invoiceNumber" value={fields.invoiceNumber} onChange={setField} confidenceScores={confidenceScores} />
                <ReviewField label="Quantity (licenses/seats)" fieldKey="quantity" value={fields.quantity} onChange={setField} type="number" confidenceScores={confidenceScores} />
                <ReviewField label="Cost Per License ($)" fieldKey="costPerLicense" value={fields.costPerLicense} onChange={setField} type="number" confidenceScores={confidenceScores} />
                <ReviewField label="Department" fieldKey="department" value={fields.department} onChange={setField} confidenceScores={confidenceScores} />
              </div>
            </div>
          </div>

          {/* Dates */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header"><h2 className="card-title">Dates & Renewal</h2></div>
            <div className="card-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
                <ReviewField label="Start Date" fieldKey="startDate" value={fields.startDate} onChange={setField} type="date" confidenceScores={confidenceScores} />
                <ReviewField label="End Date" fieldKey="endDate" value={fields.endDate} onChange={setField} type="date" confidenceScores={confidenceScores} />
              </div>
              <div style={{ marginBottom: 16 }}>
                <ReviewField label="Auto-Renewal" fieldKey="autoRenewal" value={fields.autoRenewal} onChange={setField} type="checkbox" confidenceScores={confidenceScores} />
              </div>
              {fields.autoRenewal && (
                <ReviewField label="Auto-Renewal Notice Period (days)" fieldKey="autoRenewalNoticeDays" value={fields.autoRenewalNoticeDays} onChange={setField} type="number" confidenceScores={confidenceScores} />
              )}
            </div>
          </div>

          {/* Notes */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header"><h2 className="card-title">Notes</h2></div>
            <div className="card-body">
              <ReviewField label="Notes" fieldKey="notes" value={fields.notes} onChange={setField} type="textarea" confidenceScores={confidenceScores} />
            </div>
          </div>

        </div>

        {/* ── Right: flags + AI notes ── */}
        <div style={{ position: 'sticky', top: 20 }}>

          {/* Flags */}
          {flags.length > 0 && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <h2 className="card-title">⚑ Contract Flags</h2>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{flags.length} found</span>
              </div>
              <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {flags.map((flag, i) => {
                  const colors = FLAG_COLORS[flag.flagType] || FLAG_COLORS.other;
                  return (
                    <div
                      key={i}
                      style={{
                        background: colors.bg,
                        border: `1px solid ${colors.border}`,
                        borderRadius: 'var(--radius)',
                        padding: '10px 12px',
                      }}
                    >
                      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: colors.text, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                        {FLAG_LABELS[flag.flagType] || flag.flagType}
                      </div>
                      <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', lineHeight: 1.4 }}>
                        {flag.description}
                      </div>
                      {flag.sourceText && (
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 6, fontStyle: 'italic', borderTop: `1px solid ${colors.border}`, paddingTop: 6 }}>
                          "{flag.sourceText}"
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* AI Notes */}
          {aiNote && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header"><h2 className="card-title">🤖 AI Notes</h2></div>
              <div style={{ padding: '12px 16px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', lineHeight: 1.6 }}>
                {aiNote}
              </div>
            </div>
          )}

          {/* No flags */}
          {flags.length === 0 && !aiNote && (
            <div className="card">
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
                <div style={{ fontSize: 'var(--font-size-3xl)', marginBottom: 8 }}>✓</div>
                <div style={{ fontSize: 'var(--font-size-ui)' }}>No flags or special clauses detected by Claude.</div>
              </div>
            </div>
          )}

          {/* Vendor Support */}
          {extracted.vendorSupport && (extracted.vendorSupport.supportEmail || extracted.vendorSupport.supportPhone || extracted.vendorSupport.supportPortalUrl) && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header"><h2 className="card-title">🛟 Vendor Support</h2></div>
              <div style={{ padding: '10px 16px', fontSize: 'var(--font-size-ui)' }}>
                {extracted.vendorSupport.supportEmail && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 2 }}>Support Email</div>
                    <div>{extracted.vendorSupport.supportEmail}</div>
                  </div>
                )}
                {extracted.vendorSupport.supportPhone && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 2 }}>Support Phone</div>
                    <div>{extracted.vendorSupport.supportPhone}</div>
                  </div>
                )}
                {extracted.vendorSupport.supportPortalUrl && (
                  <div>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 2 }}>Support Portal</div>
                    <div style={{ wordBreak: 'break-all' }}>{extracted.vendorSupport.supportPortalUrl}</div>
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
                  Will be saved to the vendor record on approve.
                </div>
              </div>
            </div>
          )}

          {/* Reseller */}
          {extracted.reseller && (extracted.reseller.resellerName || extracted.reseller.resellerContactName) && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header"><h2 className="card-title">🏪 Reseller / Distributor</h2></div>
              <div style={{ padding: '10px 16px', fontSize: 'var(--font-size-ui)' }}>
                {extracted.reseller.resellerName && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 2 }}>Reseller</div>
                    <div>{extracted.reseller.resellerName}</div>
                  </div>
                )}
                {extracted.reseller.resellerAccountNumber && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 2 }}>Account #</div>
                    <div style={{ fontFamily: 'monospace' }}>{extracted.reseller.resellerAccountNumber}</div>
                  </div>
                )}
                {extracted.reseller.resellerContactName && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 2 }}>Contact</div>
                    <div>{extracted.reseller.resellerContactName}</div>
                  </div>
                )}
                {extracted.reseller.resellerContactEmail && (
                  <div>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', marginBottom: 2 }}>Contact Email</div>
                    <div>{extracted.reseller.resellerContactEmail}</div>
                  </div>
                )}
                <div style={{ marginTop: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
                  Will be saved to the contract on approve.
                </div>
              </div>
            </div>
          )}

          {/* Extracted Vendor Contacts */}
          {extracted.vendorContacts?.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header">
                <h2 className="card-title">👤 Vendor Contacts</h2>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{extracted.vendorContacts.length} found</span>
              </div>
              <div style={{ padding: '10px 16px' }}>
                {extracted.vendorContacts.map((c, i) => (
                  <div key={i} style={{ fontSize: 'var(--font-size-ui)', paddingBottom: 8, marginBottom: 8, borderBottom: i < extracted.vendorContacts.length - 1 ? '1px solid var(--color-border)' : 'none' }}>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    {c.title && <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>{c.title}</div>}
                    {c.email && <div style={{ fontSize: 'var(--font-size-sm)' }}>{c.email}</div>}
                    {c.phone && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{c.phone}</div>}
                  </div>
                ))}
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                  Will be added to vendor contacts on approve.
                </div>
              </div>
            </div>
          )}

          {/* Document info */}
          <div className="card" style={{ marginTop: 4 }}>
            <div style={{ padding: '12px 16px' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Source Document</div>
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', wordBreak: 'break-word' }}>{session.originalFilename}</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 4 }}>Stored on this server</div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IngestReview() {
  useDocumentTitle('Document ingest');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [step, setStep] = useState('upload'); // 'upload' | 'review'
  const [session, setSession] = useState(null);

  // If a sessionId was passed in (e.g. from a re-link), load it
  const sessionId = searchParams.get('session');
  useEffect(() => {
    if (!sessionId) return;
    api.get(`/api/ingest/${sessionId}`)
      .then(r => {
        setSession(r.data.data);
        setStep('review');
      })
      .catch(() => navigate('/ingest'));
  }, [sessionId]);

  function handleUploaded(data) {
    // Build a session-like object from the upload response. v0.10.0:
    // matchCandidates (existing contracts that look like the master agreement
    // this extraction belongs under) survive the GET refetch so the review
    // screen can keep showing the "Found a match — add as PO?" branch even
    // after the page reloads.
    const candidates = data.matchCandidates || [];
    setSession({
      id: data.sessionId,
      originalFilename: data.sessionId, // will be overwritten below
      extractedFields: data.extractedFields,
      confidenceScores: data.confidenceScores,
      aiNotes: { notes: data.aiNotes, flags: data.flags },
      status: data.status,
      matchCandidates: candidates,
    });
    // Fetch the full session to get originalFilename etc. Merge in the
    // matchCandidates we already have — the GET endpoint doesn't return them.
    api.get(`/api/ingest/${data.sessionId}`).then(r => {
      setSession({ ...r.data.data, matchCandidates: candidates });
    });
    setStep('review');
  }

  function handleApproved(contractId) {
    navigate(`/contracts/${contractId}?imported=1`);
  }

  function handleRejected() {
    navigate('/contracts');
  }

  return (
    <div className="page-container">
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          <a href="/contracts" onClick={e => { e.preventDefault(); navigate('/contracts'); }}>Contracts</a>
          <span>›</span>
          <span>{step === 'upload' ? 'Upload Document' : 'Review Extraction'}</span>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 4 }}>
          {['Upload', 'Review', 'Import'].map((s, i) => {
            const stepMap = ['upload', 'review', 'done'];
            const active = stepMap[i] === step;
            const done = (step === 'review' && i === 0) || (step === 'done' && i <= 1);
            return (
              <div key={s} style={{ display: 'flex', alignItems: 'center' }}>
                {i > 0 && <div style={{ width: 32, height: 1, background: done || active ? 'var(--color-primary)' : 'var(--color-border)' }} />}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                  borderRadius: 20,
                  background: active ? 'var(--color-primary)' : done ? 'var(--color-success-bg)' : 'transparent',
                  color: active ? '#fff' : done ? 'var(--color-success)' : 'var(--color-text-muted)',
                  fontSize: 'var(--font-size-sm)', fontWeight: 600,
                }}>
                  <span>{done ? '✓' : i + 1}</span>
                  <span>{s}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {step === 'upload' && <UploadStep onUploaded={handleUploaded} />}
      {step === 'review' && session && (
        <ReviewStep session={session} onApproved={handleApproved} onRejected={handleRejected} />
      )}
    </div>
  );
}
