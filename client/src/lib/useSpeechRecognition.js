// ─────────────────────────────────────────────────────────────────────────────
// useSpeechRecognition — thin React wrapper over the browser-native Web Speech
// API (window.SpeechRecognition / webkitSpeechRecognition). No cloud key, no
// external service: transcription happens on-device in Chrome/Edge/Safari.
//
// Returns { supported, listening, transcript, interimTranscript, error,
//           start, stop, reset }. When unsupported (e.g. Firefox today), callers
// fall back to a plain text input — the server-side parser is identical either
// way, so voice is a convenience layer, not a hard dependency.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

function getRecognition() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function useSpeechRecognition({ lang = 'en-US' } = {}) {
  const recognitionRef = useRef(null);
  const [supported] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  });
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterim] = useState('');
  const [error, setError] = useState(null);

  // Build the recognition object once.
  useEffect(() => {
    if (!supported) return undefined;
    const rec = getRecognition();
    if (!rec) return undefined;
    rec.lang = lang;
    rec.continuous = false;        // a single spoken reading per tap
    rec.interimResults = true;     // show words as they land (feedback on a phone)
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (finalText) setTranscript((prev) => (prev ? `${prev} ${finalText}` : finalText).trim());
      setInterim(interim);
    };
    rec.onerror = (e) => {
      // 'no-speech' / 'aborted' are benign — don't surface them as hard errors.
      if (e?.error && e.error !== 'no-speech' && e.error !== 'aborted') {
        setError(e.error === 'not-allowed' ? 'Microphone access was denied.' : `Speech error: ${e.error}`);
      }
      setListening(false);
    };
    rec.onend = () => { setListening(false); setInterim(''); };

    recognitionRef.current = rec;
    return () => {
      try { rec.onresult = null; rec.onerror = null; rec.onend = null; rec.abort(); } catch { /* noop */ }
      recognitionRef.current = null;
    };
  }, [supported, lang]);

  const start = useCallback(() => {
    setError(null);
    setInterim('');
    const rec = recognitionRef.current;
    if (!rec) return;
    try { rec.start(); setListening(true); }
    catch { /* already started — ignore the InvalidStateError */ }
  }, []);

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) { try { rec.stop(); } catch { /* noop */ } }
    setListening(false);
  }, []);

  const reset = useCallback(() => { setTranscript(''); setInterim(''); setError(null); }, []);

  return { supported, listening, transcript, interimTranscript, error, start, stop, reset };
}

export default useSpeechRecognition;
