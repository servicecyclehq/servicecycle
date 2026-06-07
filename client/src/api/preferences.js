// ─────────────────────────────────────────────────────────────────────────────
// api/preferences.js — v0.42 thin wrapper around /api/preferences
//
// Used by the useUserPreference() hook. Kept as a separate module so any
// consumer that wants to read a preference directly (without subscribing
// via the hook) can do so — e.g. ad-hoc reads during page initialization.
// ─────────────────────────────────────────────────────────────────────────────

import api from './client';

export async function getPreference(key) {
  try {
    const res = await api.get(`/api/preferences/${encodeURIComponent(key)}`);
    return { ok: true, value: res.data.value, updatedAt: res.data.updatedAt };
  } catch (err) {
    if (err.response?.status === 404) return { ok: true, value: undefined };
    return { ok: false, error: err.response?.data?.error || err.message };
  }
}

export async function setPreference(key, value) {
  try {
    const res = await api.put(`/api/preferences/${encodeURIComponent(key)}`, { value });
    return { ok: true, value: res.data.value, updatedAt: res.data.updatedAt };
  } catch (err) {
    return { ok: false, error: err.response?.data?.error || err.message };
  }
}

export async function deletePreference(key) {
  try {
    await api.delete(`/api/preferences/${encodeURIComponent(key)}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.response?.data?.error || err.message };
  }
}

export async function listPreferences() {
  try {
    const res = await api.get('/api/preferences');
    return { ok: true, items: res.data.items || [] };
  } catch (err) {
    return { ok: false, error: err.response?.data?.error || err.message };
  }
}
