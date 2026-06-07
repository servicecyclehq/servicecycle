/**
 * QuoteUploadCard — v0.8.0 demo headliner.
 *
 * Drop a vendor quote PDF onto this card and Claude extracts the structured
 * fields (vendor / product / quoted price / valid-until / terms). The user
 * reviews a side-by-side "current vs quoted" diff and accepts -> the contract's
 * originalAsk is set, the savings tracker on the Renewal & Savings card
 * immediately reflects the new value.
 *
 * The card is the "wow" moment for prospect demos: paste a real quote PDF
 * into the drop zone, see the values fill in within a few seconds, see the
 * savings number appear.
 *
 * Server endpoint: POST /api/contracts/:id/quote-extract (manager+ only;
 * shared 'extract' AI-quota bucket with PDF ingest + signature reading).
 * The endpoint does NOT persist anything to the contract — apply is a
 * separate PUT below.
 */

import { useRef, useState } from 'react';
import { Upload, Sparkles, CheckCircle2, AlertTriangle, X as XIcon } from 'lucide-react';
import api from '../api/client';

function fmtMoney(v) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(v));
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Pick the right "total deal" number out of the extracted quote. Server
// returns computedTotalPrice when it could derive it; otherwise we use
// quotedPrice (which is then the headline number from the quote).
function totalFromProposed(p) {
  if (!p) return null;
  if (p.computedTotalPrice != null) return p.computedTotalPrice;
  return p.quotedPrice;
}

export default function QuoteUploadCard({ contract, canEdit, onContractUpdated }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);    // { proposed, match, contract } from server
  const [applying, setApplying] = useState(false);

  if (!canEdit) return null;

  async function handleFile(file) {
    if (!file) return;
    if (!/\.(pdf|docx?|txt)$/i.test(file.name)) {
      setError('Quotes must be PDF, Word (.doc/.docx), or .txt');
      return;
    }
    setError(''); setResult(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post(`/api/contracts/${contract.id}/quote-extract`, fd);
      setResult(res.data.data);
    } catch (err) {
      // AI quota / consent paths surface specific shapes
      const data = err.response?.data;
      if (data?.error === 'ai_consent_required') {
        setError('AI consent required. Approve the AI features prompt and try again.');
      } else if (data?.error === 'ai_daily_cap_reached') {
        setError(`Daily AI cap hit (${data.data?.count}/${data.data?.cap}). Resets at ${data.data?.resetAt || 'midnight UTC'}.`);
      } else {
        setError(data?.error || 'Quote extraction failed — try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function applyToContract() {
    if (!result?.proposed) return;
    const newAsk = totalFromProposed(result.proposed);
    if (newAsk == null) {
      setError('No price could be applied — edit the quote and try again.');
      return;
    }
    setApplying(true); setError('');
    try {
      // Tight payload — just the savings-tracker field. Server's
      // ContractWritableFields accepts originalAsk as NumLike.
      const res = await api.put(`/api/contracts/${contract.id}`, { originalAsk: String(newAsk) });
      if (onContractUpdated) onContractUpdated(res.data.data.contract);
      setResult(null);  // collapse card back to drop-zone after apply
    } catch (err) {
      setError(err.response?.data?.error || 'Apply failed — try again.');
    } finally {
      setApplying(false);
    }
  }

  // ── Render branches ──────────────────────────────────────────────────────
  if (result) {
    const p = result.proposed;
    const newAsk = totalFromProposed(p);
    const currentTotal = contract.totalValue ?? (
      contract.costPerLicense && contract.quantity
        ? Number(contract.costPerLicense) * Number(contract.quantity)
        : null
    );
    const projectedSavings = currentTotal != null && newAsk != null
      ? Number(currentTotal) - Number(newAsk)
      : null;
    const projectedSavingsPct = projectedSavings != null && currentTotal > 0
      ? Math.round((projectedSavings / currentTotal) * 100)
      : null;

    return (
      <div id="cd-quote-upload" className="card mb-16">
        <div className="card-header">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} strokeWidth={1.75} color="var(--color-primary)" />
            Quote extracted
          </div>
          <button
            type="button"
            onClick={() => { setResult(null); setError(''); }}
            aria-label="Dismiss"
            title="Clear and start over"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', lineHeight: 0, padding: 4 }}
          >
            <XIcon size={18} strokeWidth={2} />
          </button>
        </div>
        <div className="card-body">
          {/* Match indicators */}
          {(result.match?.vendor === false || result.match?.product === false) && (
            <div className="alert alert-info" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 14 }}>
              <AlertTriangle size={16} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 'var(--font-size-ui)' }}>
                The extracted quote doesn't cleanly match this contract&apos;s {result.match.vendor === false ? <strong>vendor</strong> : null}
                {result.match.vendor === false && result.match.product === false ? ' and ' : null}
                {result.match.product === false ? <strong>product</strong> : null}.
                Double-check the values below before applying.
              </div>
            </div>
          )}

          {/* Side-by-side current vs quoted */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 8 }}>Current contract</div>
              <Row label="Vendor"   value={contract.vendor?.name || '—'} />
              <Row label="Product"  value={contract.product || '—'} />
              <Row label="Quantity" value={contract.quantity ?? '—'} />
              <Row label="Per-unit" value={contract.costPerLicense != null ? fmtMoney(contract.costPerLicense) : '—'} />
              <Row label="Total"    value={fmtMoney(currentTotal)} mono bold />
            </div>
            <div style={{ paddingLeft: 12, borderLeft: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-primary)', marginBottom: 8 }}>From the quote</div>
              <Row label="Vendor"   value={p.vendorName || '—'}    diff={result.match?.vendor === false} />
              <Row label="Product"  value={p.productName || '—'}   diff={result.match?.product === false} />
              <Row label="Quantity" value={p.quantity ?? '—'} />
              <Row label="Per-unit" value={p.priceType !== 'total' && p.quotedPrice != null ? `${fmtMoney(p.quotedPrice)} ${p.priceType?.replace(/_/g, '/') || ''}` : '—'} />
              <Row label="Total"    value={fmtMoney(newAsk)} mono bold highlight />
            </div>
          </div>

          {/* Quote metadata strip */}
          {(p.quoteNumber || p.quoteDate || p.validUntil || p.termLength) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 14, padding: '8px 12px', background: 'var(--color-bg)', borderRadius: 'var(--radius)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              {p.quoteNumber && <span>Quote #: <strong style={{ color: 'var(--color-text)' }}>{p.quoteNumber}</strong></span>}
              {p.quoteDate   && <span>Issued: <strong style={{ color: 'var(--color-text)' }}>{fmtDate(p.quoteDate)}</strong></span>}
              {p.validUntil  && <span>Valid until: <strong style={{ color: 'var(--color-text)' }}>{fmtDate(p.validUntil)}</strong></span>}
              {p.termLength  && <span>Term: <strong style={{ color: 'var(--color-text)' }}>{p.termLength}</strong></span>}
            </div>
          )}

          {p.termsAndConditions && (
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 14, padding: '8px 12px', background: 'var(--color-warning-bg)', borderRadius: 'var(--radius)' }}>
              <strong style={{ color: 'var(--color-warning)' }}>Worth knowing:</strong> {p.termsAndConditions}
            </div>
          )}

          {p.aiNotes && (
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 14, fontStyle: 'italic' }}>
              <strong style={{ fontStyle: 'normal' }}>Notes:</strong> {p.aiNotes}
            </div>
          )}

          {/* Projected savings */}
          {projectedSavings != null && projectedSavings > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--color-success-bg)', borderRadius: 'var(--radius)', marginBottom: 14 }}>
              <CheckCircle2 size={18} strokeWidth={1.75} color="var(--color-success)" />
              <div style={{ fontSize: 'var(--font-size-data)' }}>
                Applying this quote would save{' '}
                <strong style={{ color: 'var(--color-success)' }}>{fmtMoney(projectedSavings)}</strong>
                {projectedSavingsPct != null && ` (${projectedSavingsPct}% off the current contract)`}.
              </div>
            </div>
          )}

          {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => { setResult(null); setError(''); }} disabled={applying}>Discard</button>
            <button type="button" className="btn btn-primary" onClick={applyToContract} disabled={applying || newAsk == null}>
              {applying ? 'Applying…' : `Apply ${fmtMoney(newAsk)} as Original Ask`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Initial drop-zone state ────────────────────────────────────────────
  return (
    <div id="cd-quote-upload" className="card mb-16">
      <div className="card-header">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={16} strokeWidth={1.75} color="var(--color-primary)" />
          Upload vendor quote
          <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500, color: 'var(--color-text-secondary)', marginLeft: 4 }}>· AI auto-fills the savings tracker</span>
        </div>
      </div>
      <div className="card-body">
        <div
          onClick={() => !busy && fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (!busy) handleFile(e.dataTransfer.files[0]); }}
          style={{
            border: '2px dashed var(--color-border-strong)',
            borderRadius: 'var(--radius-lg)',
            padding: '28px 24px',
            textAlign: 'center',
            cursor: busy ? 'wait' : 'pointer',
            background: 'var(--color-bg)',
            opacity: busy ? 0.6 : 1,
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files[0])}
          />
          <Upload size={28} strokeWidth={1.5} color="var(--color-primary)" style={{ marginBottom: 8 }} />
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-data)', marginBottom: 4 }}>
            {busy ? 'Reading the quote…' : 'Drop a vendor quote PDF here'}
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
            {busy ? 'Claude is extracting the price + terms (5–10s)' : 'PDF, Word, or .txt up to 10 MB · pre-fills Original Ask + projects savings'}
          </div>
        </div>
        {error && <div role="alert" className="alert alert-error" style={{ marginTop: 14 }}>{error}</div>}
      </div>
    </div>
  );
}

function Row({ label, value, mono, bold, highlight, diff }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', minWidth: 64 }}>{label}</span>
      <span style={{
        fontSize: bold ? 15 : 13,
        fontWeight: bold ? 700 : 500,
        color: highlight ? 'var(--color-primary)' : (diff ? 'var(--color-warning)' : 'var(--color-text)'),
        fontFamily: mono ? 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)' : 'inherit',
      }}>
        {value}
      </span>
    </div>
  );
}
