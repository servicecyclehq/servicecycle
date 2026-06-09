// useBranding.js — fetches per-account white-label settings and injects CSS vars.
//
// On mount, hits GET /api/settings/branding and:
//   - Sets --color-primary and derived hover/light variants on :root
//   - Updates document.title prefix if displayName is set
//   - Exposes { logoUrl, primaryColor, displayName } to callers
//
// Safe to call multiple times — only fires once per session (memoised in
// module-level cache so remounts don't re-fetch).

import { useState, useEffect } from 'react';
import api from '../api/client';

// Module-level cache: survives re-renders, cleared on page reload.
let _cache = null;
let _promise = null;

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function applyBrandColors(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const [h, s, l] = hexToHsl(hex);
  const root = document.documentElement;
  root.style.setProperty('--color-primary',       hex);
  root.style.setProperty('--color-primary-hover',  hslToHex(h, s, Math.min(l + 10, 80)));
  root.style.setProperty('--color-primary-light',  hslToHex(h, Math.max(s - 30, 10), Math.min(l + 40, 95)));
  root.style.setProperty('--color-sidebar-active', hslToHex(h, s, Math.min(l + 8, 75)));
}

function clearBrandColors() {
  const root = document.documentElement;
  ['--color-primary', '--color-primary-hover', '--color-primary-light', '--color-sidebar-active']
    .forEach((v) => root.style.removeProperty(v));
}

export function useBranding() {
  const [branding, setBranding] = useState(_cache ?? { logoUrl: null, primaryColor: null, displayName: null });

  useEffect(() => {
    if (_cache) {
      if (_cache.primaryColor) applyBrandColors(_cache.primaryColor);
      setBranding(_cache);
      return;
    }
    if (!_promise) {
      _promise = api.get('/api/settings/branding')
        .then((r) => {
          _cache = r.data.data;
          return _cache;
        })
        .catch(() => {
          _cache = { logoUrl: null, primaryColor: null, displayName: null };
          return _cache;
        });
    }
    _promise.then((data) => {
      if (data.primaryColor) applyBrandColors(data.primaryColor);
      setBranding(data);
    });
  }, []);

  return branding;
}

// Call this on logout to reset CSS vars and cache
export function clearBrandingCache() {
  _cache = null;
  _promise = null;
  clearBrandColors();
}
