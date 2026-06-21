// ─────────────────────────────────────────────────────────────────────────────
// VoiceCaptureButton — frictionless voice field entry.
//
// Tap the mic, say "Breaker 42, IR normal, 68", and the spoken reading is
// transcribed on-device (Web Speech API), POSTed to /api/field/voice/parse, and
// handed back to the parent as a structured proposal { measurementType, value,
// unit, passFail } plus any scope-matched asset. The parent pre-fills the
// measurement form; the tech reviews and saves. Nothing is auto-committed.
//
// Where speech isn't supported (or a tech prefers it), a "type instead" input
// hits the identical server parser — voice is convenience, not a dependency.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import api from '../../api/client';
import { useSpeechRecognition } from '../../lib/useSpeechRecognition';

const wrap = {
  border: '1px solid var(--color-border)', borderRadius: 12,
  background: 'var(--color-bg)', padding: 12, marginBottom: 12,
};
const micBtn = (active) => ({
  boxSizing: 'border-box', width: '100%', minHeight: 56,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
  fontSize: 16, fontWeight: 800, borderRadius: 12, cursor: 'pointer', border: 'none',
  background: active ? '#dc2626' : 'var(--color-primary)', color: '#fff',
  WebkitTapHighlightColor: 'transparent',
});

export default function VoiceCaptureButton({ assetId = null, onParsed, disabled = false }) {
  const { supported, listening, transcript, interimTranscript, error, start, stop, reset } = useSpeechRecognition();
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [parseError, setParseError] = useState(null);
  const lastParsed = useRef('');

  async function parse(text) {
    const t = String(text || '').trim();
    if (!t || busy) return;
    setBusy(true);
    setParseError(null);
    try {
      const body = assetId ? { transcript: t, assetId } : { transcript: t };
      const res = await api.post('/api/field/voice/parse', body);
      onParsed?.({ ...(res.data?.data || {}), transcript: t });
      reset();
      setTyped('');
      setTyping(false);
    } catch (err) {
      setParseError(err.response?.data?.error || err.message || 'Could not parse that — try again.');
    } finally {
      setBusy(false);
    }
  }

  // Auto-parse once speech produces a final transcript and the mic has stopped.
  useEffect(() => {
    if (!listening && transcript && transcript !== lastParsed.current) {
      lastParsed.current = transcript;
      parse(transcript);
    }
  }, [listening, transcript]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!supported && !typing) {
    return (
      <div style={wrap}>
        <button type="button" onClick={() => setTyping(true)} disabled={disabled}
          style={{ ...micBtn(false), background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)' }}>
          ⌨️ Type a reading (voice unavailable here)
        </button>
      </div>
    );
  }

  return (
    <div style={wrap}>
      {!typing && (
        <button
          type="button"
          onClick={() => (listening ? stop() : start())}
          disabled={disabled || busy}
          aria-pressed={listening}
          style={micBtn(listening)}
        >
          <span aria-hidden="true" style={listening ? { animation: 'vcpulse 1s ease-in-out infinite' } : undefined}>🎤</span>
          <style>{'@keyframes vcpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }'}</style>
          {busy ? 'Reading…' : listening ? 'Listening… tap to stop' : 'Speak a reading'}
        </button>
      )}

      {listening && (
        <div style={{ marginTop: 8, fontSize: 14, color: 'var(--color-text-secondary)', minHeight: 20, textAlign: 'center' }}>
          {interimTranscript || 'e.g. "Breaker 42, IR normal, 68"'}
        </div>
      )}

      {/* Type-instead fallback (always available — some rooms are too loud). */}
      {!listening && (
        <div style={{ marginTop: 8 }}>
          {!typing ? (
            <button type="button" onClick={() => setTyping(true)}
              style={{ background: 'none', border: 'none', color: 'var(--color-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 4 }}>
              or type it
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') parse(typed); }}
                placeholder='e.g. "Breaker 42, IR normal, 68"'
                aria-label="Type a reading"
                style={{
                  flex: 1, minHeight: 48, padding: '0 12px', fontSize: 15, boxSizing: 'border-box',
                  color: 'var(--color-text)', background: 'var(--color-surface)',
                  border: '1px solid var(--color-border)', borderRadius: 10,
                }}
              />
              <button type="button" onClick={() => parse(typed)} disabled={busy || !typed.trim()}
                style={{ ...micBtn(false), width: 'auto', minWidth: 88, fontSize: 15 }}>
                {busy ? '…' : 'Parse'}
              </button>
            </div>
          )}
        </div>
      )}

      {(error || parseError) && (
        <div role="alert" style={{ marginTop: 8, fontSize: 13, color: '#991b1b', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px' }}>
          {error || parseError}
        </div>
      )}
    </div>
  );
}
