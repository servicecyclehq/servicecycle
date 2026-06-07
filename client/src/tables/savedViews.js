// ─────────────────────────────────────────────────────────────────────────────
// savedViews.js — v0.40 Phase 3 generic localStorage helpers for named views.
//
// A "saved view" is a named snapshot of a list page's state (column
// visibility + filter state + sort + whatever the page wants to capture).
// The helpers are agnostic about the state shape — the page passes in
// whatever object it wants, the helpers store/load/list/delete by id.
//
// Storage shape under a given key:
//   [
//     { id: 'view_<uuid>', name: 'Overdue - My Sites',
//       createdAt: '2026-05-20T03:00:00Z',
//       state: { ... }            // opaque to these helpers
//     },
//     ...
//   ]
//
// Why localStorage and not server-side?
//   The roadmap (roadmap: table-control-export) calls out saved views
//   as a "pricing-tier candidate" and gates server-side persistence on a
//   schema decision (UserPreference table vs JSON column on Account).
//   v0.40 ships localStorage to deliver the user-facing value; v0.41 can
//   migrate to server-side by porting the localStorage JSON to whichever
//   schema lands. The state shape stays the same.
// ─────────────────────────────────────────────────────────────────────────────

// Best-effort UUID — crypto.randomUUID is available on every browser we
// support (Chrome 92+, Firefox 95+, Safari 15.4+), but the fallback keeps
// the code defensive in case it's ever called from a test/JSDOM env.
function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function loadSavedViews(storageKey) {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop anything malformed — defensive against partial writes / hand-
    // edited localStorage / schema drift.
    return parsed.filter(v =>
      v && typeof v === 'object'
      && typeof v.id === 'string'
      && typeof v.name === 'string'
      && v.state !== undefined
    );
  } catch {
    return [];
  }
}

export function saveSavedViews(storageKey, views) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(views));
  } catch {
    /* ignore — quota exceeded, private window, etc. */
  }
}

// Add a new view. If a view with the same name already exists, overwrite
// its state instead of creating a duplicate. Returns the updated list.
export function addSavedView(storageKey, name, state) {
  const trimmed = (name || '').trim();
  if (!trimmed) return loadSavedViews(storageKey);
  const views = loadSavedViews(storageKey);
  const existing = views.find(v => v.name.toLowerCase() === trimmed.toLowerCase());
  let next;
  if (existing) {
    next = views.map(v => v.id === existing.id
      ? { ...v, state, updatedAt: new Date().toISOString() }
      : v);
  } else {
    next = [
      ...views,
      { id: `view_${uuid()}`, name: trimmed, createdAt: new Date().toISOString(), state },
    ];
  }
  saveSavedViews(storageKey, next);
  return next;
}

export function deleteSavedView(storageKey, id) {
  const views = loadSavedViews(storageKey).filter(v => v.id !== id);
  saveSavedViews(storageKey, views);
  return views;
}

export function renameSavedView(storageKey, id, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) return loadSavedViews(storageKey);
  const views = loadSavedViews(storageKey).map(v =>
    v.id === id ? { ...v, name: trimmed, updatedAt: new Date().toISOString() } : v
  );
  saveSavedViews(storageKey, views);
  return views;
}
