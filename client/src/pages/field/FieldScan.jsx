// ─────────────────────────────────────────────────────────────────────────────
// FieldScan.jsx — full-screen camera QR scanner for Field Mode.
//
// getUserMedia({video:{facingMode:'environment'}}) → <video> → rAF loop drawing
// downscaled frames to an offscreen canvas → jsQR(imageData). Accepts BOTH
// full label URLs containing '/field/asset/<uuid>' AND bare uuids, then
// navigates to /field/asset/:id.
//
// Extras:
//   • Torch toggle when the camera track supports it (getCapabilities().torch).
//   • Graceful permission-denied / no-camera state with a manual asset search
//     fallback (debounced GET /api/assets?search=) — also reachable via the
//     "Type it instead" button while the camera is live.
//   • All media tracks stopped on unmount. Big bottom cancel button.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import jsQR from 'jsqr';
import api from '../../api/client';
import { assetLabel } from '../../lib/equipment';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /\/field\/asset\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Pull an asset id out of whatever the QR code carried.
function extractAssetId(text) {
  const t = String(text || '').trim();
  const m = t.match(URL_RE);
  if (m) return m[1];
  if (UUID_RE.test(t)) return t;
  return null;
}

const bigBtn = {
  boxSizing: 'border-box', width: '100%', minHeight: 56,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  fontSize: 16, fontWeight: 700, borderRadius: 12, cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
};

// Manual search fallback — debounced asset search, fat result rows.
function ManualSearch({ onPick }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef();

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!query.trim() || query.trim().length < 2) { setResults([]); return; }
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.get('/api/assets', { params: { search: query.trim(), limit: 8 } });
        setResults(res.data?.data?.assets || []);
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  return (
    <div>
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Serial, model, manufacturer…"
        aria-label="Search assets"
        style={{
          boxSizing: 'border-box', width: '100%', minHeight: 52, padding: '0 14px',
          fontSize: 16, color: 'var(--color-text)', background: 'var(--color-surface)',
          border: '1px solid var(--color-border)', borderRadius: 12,
        }}
      />
      <div style={{ marginTop: 10 }}>
        {searching && (
          <div style={{ padding: 12, fontSize: 14, color: 'var(--color-text-secondary)' }}>Searching…</div>
        )}
        {!searching && query.trim().length >= 2 && results.length === 0 && (
          <div style={{ padding: 12, fontSize: 14, color: 'var(--color-text-secondary)' }}>No matches.</div>
        )}
        {results.map(a => (
          <button
            key={a.id}
            type="button"
            onClick={() => onPick(a.id)}
            style={{
              all: 'unset', boxSizing: 'border-box', cursor: 'pointer',
              display: 'block', width: '100%', minHeight: 56, padding: '10px 14px',
              background: 'var(--color-surface)', border: '1px solid var(--color-border)',
              borderRadius: 12, marginBottom: 8,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text)' }}>{assetLabel(a)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginTop: 2 }}>{a.site?.name || ''}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function FieldScan() {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const foundRef = useRef(false);

  const [camError, setCamError] = useState(null);     // 'denied' | 'unavailable' | null
  const [manualMode, setManualMode] = useState(false); // "Type it instead"
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // Camera + decode loop. Restarts when the user leaves manual mode.
  useEffect(() => {
    if (manualMode) return undefined;
    let cancelled = false;
    let raf = 0;
    let stream = null;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function tick() {
      if (cancelled || foundRef.current) return;
      if (video && video.readyState >= 2 && video.videoWidth) {
        // Downscale to ≤480px wide before decode — jsQR is O(pixels) and a
        // 4K camera frame would burn the phone's battery for no extra range.
        const scale = Math.min(1, 480 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
        if (code?.data) {
          const id = extractAssetId(code.data);
          if (id) {
            foundRef.current = true;
            try { navigator.vibrate?.(100); } catch { /* not supported */ }
            navigate(`/field/asset/${id}`, { replace: true });
            return;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        try {
          const caps = track.getCapabilities?.();
          if (caps && 'torch' in caps && caps.torch) setTorchSupported(true);
        } catch { /* capabilities unsupported */ }
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        tick();
      } catch (err) {
        if (cancelled) return;
        setCamError(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'unavailable');
      }
    }

    start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(t => t.stop());
      streamRef.current = null;
      setTorchOn(false);
      setTorchSupported(false);
    };
  }, [manualMode, navigate]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      setTorchOn(v => !v);
    } catch { /* torch flaked — leave state as-is */ }
  }

  const showFallback = camError || manualMode;

  // ── Fallback: permission denied / manual entry ─────────────────────────────
  if (showFallback) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '70vh' }}>
        {camError === 'denied' && (
          <div role="alert" style={{
            padding: '12px 14px', marginBottom: 14, borderRadius: 12,
            background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
            fontSize: 14, lineHeight: 1.5,
          }}>
            <strong>Camera access was denied.</strong><br />
            Allow camera access in your browser settings to scan QR labels — or find the equipment by search below.
          </div>
        )}
        {camError === 'unavailable' && (
          <div role="alert" style={{
            padding: '12px 14px', marginBottom: 14, borderRadius: 12,
            background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)', color: 'var(--chip-red-fg)',
            fontSize: 14, lineHeight: 1.5,
          }}>
            <strong>No camera available.</strong> Find the equipment by search instead.
          </div>
        )}
        <div style={{ fontWeight: 800, fontSize: 16, color: 'var(--color-text)', marginBottom: 10 }}>
          Find equipment
        </div>
        <ManualSearch onPick={(id) => navigate(`/field/asset/${id}`, { replace: true })} />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
          {!camError && (
            <button
              type="button"
              onClick={() => setManualMode(false)}
              style={{ ...bigBtn, background: 'var(--color-primary)', color: '#fff', border: 'none' }}
            >
              Back to camera
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate('/field')}
            style={{
              ...bigBtn, background: 'var(--color-surface)', color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Full-screen camera scanner ─────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#000' }}>
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label="Live camera feed for QR code scanning"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />

      {/* Scan frame overlay */}
      <div aria-hidden="true" style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -56%)',
        width: 'min(68vw, 300px)', height: 'min(68vw, 300px)',
        border: '3px solid rgba(255,255,255,0.92)', borderRadius: 18,
        boxShadow: '0 0 0 100vmax rgba(0,0,0,0.42)',
      }} />

      <div style={{
        position: 'absolute', top: 'calc(14px + env(safe-area-inset-top, 0px))', left: 0, right: 0,
        textAlign: 'center', color: '#fff', fontWeight: 700, fontSize: 15,
        textShadow: '0 1px 4px rgba(0,0,0,0.7)', padding: '0 20px',
      }}>
        Point at the equipment QR label
      </div>

      {/* Bottom action stack */}
      <div style={{
        position: 'absolute', left: 0, right: 0,
        bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
        padding: '0 16px', display: 'grid', gap: 10,
        maxWidth: 560, margin: '0 auto', boxSizing: 'border-box',
      }}>
        <div style={{ display: 'flex', gap: 10 }}>
          {torchSupported && (
            <button
              type="button"
              onClick={toggleTorch}
              aria-pressed={torchOn}
              style={{
                ...bigBtn, flex: 1, border: 'none',
                background: torchOn ? '#fbbf24' : 'rgba(255,255,255,0.18)',
                color: torchOn ? '#111' : '#fff',
                backdropFilter: 'blur(4px)',
              }}
            >
              {torchOn ? 'Light on' : 'Light'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setManualMode(true)}
            style={{
              ...bigBtn, flex: 1, border: 'none',
              background: 'rgba(255,255,255,0.18)', color: '#fff',
              backdropFilter: 'blur(4px)',
            }}
          >
            Type it instead
          </button>
        </div>
        <button
          type="button"
          onClick={() => navigate('/field')}
          style={{ ...bigBtn, minHeight: 60, background: '#fff', color: '#111', border: 'none' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
